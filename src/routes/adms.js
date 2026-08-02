// adms.js — implements the device-facing side of ZKTeco's ADMS/Push protocol.
//
// On field order: rather than assuming the ATTLOG columns sit at fixed indexes,
// parseAttLogLine() *locates* the timestamp with a regex and reads the PIN and
// trailing codes relative to it. That survives the field-order and separator
// differences that vary between ZKTeco firmware builds, which is the one part
// of this protocol that couldn't be verified without the physical device.
//
// Every request the device makes is also written verbatim to `raw_uploads`
// before parsing, so if a line still isn't understood, the exact bytes are on
// disk and the punch can be recovered with POST /api/debug/reparse rather than
// being silently dropped.

const express = require("express");
const router = express.Router();
const db = require("../db");
const dayjs = require("dayjs");
const customParseFormat = require("dayjs/plugin/customParseFormat");
dayjs.extend(customParseFormat);

// Capture the body as raw bytes regardless of what Content-Type the device
// claims (some firmwares send none at all, which would make express.text()
// skip the body entirely and hand us an empty string).
const rawBody = express.raw({ type: () => true, limit: "5mb" });

// Tables the device routinely uploads that legitimately aren't attendance
// data. Anything outside this set carrying rows is worth flagging — see the
// AC-push warning in the POST handler.
const BENIGN_TABLES = new Set([
  "OPERLOG",    // admin operations on the device
  "ATTPHOTO",   // verification photos
  "USERINFO",   // user records synced up from the device
  "FINGERTMP",  // fingerprint templates
  "BIODATA",    // face/biometric templates
  "USERPIC",
  "ERRORLOG",
  "OPTIONS",
]);

const recordUpload = db.prepare(`
  INSERT INTO raw_uploads (device_sn, method, path, query, body, line_count, parsed_count)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

function logUpload(req, body, lineCount, parsedCount) {
  try {
    recordUpload.run(
      req.query.SN || null,
      req.method,
      req.path,
      req.originalUrl.split("?")[1] || "",
      body,
      lineCount,
      parsedCount
    );
  } catch (err) {
    // Never let debug logging break the device conversation — the device will
    // retry endlessly on a non-200 and flood the log.
    console.error("[ADMS] failed to record raw upload:", err.message);
  }
}

function bodyToString(req) {
  if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
  if (typeof req.body === "string") return req.body;
  return "";
}

// ---------------------------------------------------------------------------
// 1) Device handshake / initial config pull
//    GET /iclock/cdata?SN=<serial>&options=all&pushver=...
//    The device calls this first to learn how often to talk to us.
// ---------------------------------------------------------------------------
router.get("/iclock/cdata", (req, res) => {
  const sn = req.query.SN || "unknown";
  console.log(`[ADMS] Handshake from device SN=${sn} query=${req.originalUrl.split("?")[1] || ""}`);
  logUpload(req, "", 0, 0);

  // Plain-text config response the device expects.
  res.type("text/plain").send(
    [
      "GET OPTION FROM: SN=" + sn,
      "Stamp=9999",
      "OpStamp=9999",
      "ErrorDelay=60",
      "Delay=10",
      "TransFlag=TransData AttLog\tOpLog\t",
      "Realtime=1",
      "Encrypt=None",
    ].join("\n")
  );
});

// ---------------------------------------------------------------------------
// 2) Device polls for pending commands
//    GET /iclock/getrequest?SN=<serial>
//    We have nothing to push down to the device right now, so just say OK.
// ---------------------------------------------------------------------------
router.get("/iclock/getrequest", (req, res) => {
  res.type("text/plain").send("OK");
});

// ---------------------------------------------------------------------------
// 3) The actual punch data upload
//    POST /iclock/cdata?SN=<serial>&table=ATTLOG&Stamp=...
//    Body: one punch per line. Field order varies by firmware — see parser.
// ---------------------------------------------------------------------------
router.post("/iclock/cdata", rawBody, (req, res) => {
  const sn = req.query.SN || "unknown";
  const table = (req.query.table || "").toUpperCase();
  const body = bodyToString(req);
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  if (table !== "ATTLOG") {
    // Device may also push OPERLOG (admin operation log), user photos, etc.
    // We only care about attendance — record it for reference and acknowledge.
    logUpload(req, body, lines.length, 0);
    console.log(`[ADMS] Non-attendance upload table=${table || "(none)"} SN=${sn}, ${lines.length} line(s) — stored, not parsed`);

    // An unfamiliar table carrying actual rows is the signature of the device
    // still being in AC (access control) push mode rather than TA (attendance)
    // push — it connects and uploads happily, just not the records we want.
    // That's a device menu setting, so say so rather than let it look like a
    // parser bug. See README §4 step 2.
    if (lines.length > 0 && !BENIGN_TABLES.has(table)) {
      console.warn(
        `[ADMS] ?? Table "${table}" is not ATTLOG but contains ${lines.length} record(s). ` +
          `The F09 is probably still on AC push — switch it to TA push under ` +
          `System > Device Type Settings > Communication Protocol (manual §11.5), ` +
          `then POST /api/debug/reparse.`
      );
    }
    return res.type("text/plain").send("OK:0");
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO punches (device_sn, device_user_id, punch_time, status, verify_mode, raw_line)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const unparsed = [];
  const tx = db.transaction((rows) => {
    for (const line of rows) {
      const parsed = parseAttLogLine(line);
      if (!parsed) {
        unparsed.push(line);
        continue;
      }
      insert.run(sn, parsed.pin, parsed.time, parsed.status, parsed.verify, line);
      count++;
    }
  });
  tx(lines);

  logUpload(req, body, lines.length, count);
  console.log(`[ADMS] Received ${lines.length} line(s) from SN=${sn}, parsed ${count} punch(es)`);

  // A line we couldn't read is the failure mode this whole design exists to
  // catch — make it impossible to miss in the log, and show the actual bytes.
  for (const line of unparsed) {
    console.error(`[ADMS] !! UNPARSED ATTLOG LINE — fix parseAttLogLine(), then POST /api/debug/reparse`);
    console.error(`[ADMS] !! raw: ${JSON.stringify(line)}`);
  }

  // ADMS expects "OK:<number of records accepted>"
  res.type("text/plain").send(`OK:${count}`);
});

// ---------------------------------------------------------------------------
// 4) Command results and anything else under /iclock/*
//    Devices post results of pushed commands to /iclock/devicecmd, and some
//    firmwares use endpoints not covered above. Answer 200 to everything (a
//    404 makes the device retry in a tight loop) and keep the body for review.
// ---------------------------------------------------------------------------
router.all("/iclock/*", rawBody, (req, res) => {
  const body = bodyToString(req);
  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  logUpload(req, body, lines.length, 0);
  console.log(`[ADMS] ${req.method} ${req.path} SN=${req.query.SN || "unknown"} — ${lines.length} line(s) stored, unhandled endpoint`);
  res.type("text/plain").send("OK");
});

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

// Matches the datetime anywhere in the line: 2026-08-01 09:02:15, with
// tolerance for / or . separators, single-digit month/day/hour, a T separator,
// and a missing seconds component.
const TIMESTAMP_RE = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/;

function parseAttLogLine(line) {
  const match = line.match(TIMESTAMP_RE);
  if (!match) return null;

  const [, year, month, day, hour, minute, second = "0"] = match;
  const time = dayjs(
    `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")} ` +
      `${hour.padStart(2, "0")}:${minute}:${String(second).padStart(2, "0")}`,
    "YYYY-MM-DD HH:mm:ss",
    true
  );
  if (!time.isValid()) return null;

  // The PIN is the field immediately preceding the timestamp in every ADMS
  // variant documented — reading it relative to the timestamp rather than by
  // index tolerates both `PIN <sep> TIME ...` and a firmware that prefixes an
  // extra column.
  const before = line.slice(0, match.index).trim().split(/[\t\s]+/).filter(Boolean);
  const pin = before.length ? before[before.length - 1] : null;
  if (!pin) return null;

  // Trailing codes, in the documented order: Status, VerifyMode, WorkCode.
  const after = line
    .slice(match.index + match[0].length)
    .trim()
    .split(/[\t\s]+/)
    .filter(Boolean);

  return {
    pin,
    time: time.toISOString(),
    status: (after[0] || "0").trim(),
    verify: (after[1] || "0").trim(),
  };
}

module.exports = router;
module.exports.parseAttLogLine = parseAttLogLine;
module.exports.BENIGN_TABLES = BENIGN_TABLES;
