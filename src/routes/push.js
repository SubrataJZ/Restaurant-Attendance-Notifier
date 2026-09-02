// push.js — receives punches pushed by easyTimePro's Api Settings feature.
//
// Verified against a real payload captured 2026-09-02:
//   {"EMP_CODE":"EMP0023","PUNCH_DATETIME":"02-09-2026 19:02:50",
//    "PUNCH_STATE":"Check In","TERMINAL_SN":"NYU7254100059",
//    "UPLOAD_TIME":"2026-09-02 19:03:01.172876"}
//
// Three things that payload taught us, each of which fails SILENTLY if ignored:
//   1. Keys arrive UPPERCASE even though the template tokens are lowercase.
//   2. PUNCH_DATETIME is DAY-first (DD-MM-YYYY) while UPLOAD_TIME in the same
//      object is YEAR-first. new Date("02-09-2026") reads that as 9 February.
//   3. The sender uses HTTP Basic auth, not a header key like our other routes.

const express = require("express");
const router = express.Router();
const dayjs = require("dayjs");
const customParseFormat = require("dayjs/plugin/customParseFormat");
dayjs.extend(customParseFormat);
const db = require("../db");

const PUSH_USER = process.env.PUSH_USER || "attendance";
const PUSH_PASS = process.env.PUSH_PASS || "";

// Constant-time-ish compare so a wrong password can't be probed by timing.
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

router.use(express.json({ limit: "5mb", type: () => true }));

router.use((req, res, next) => {
  if (!PUSH_PASS) {
    console.error("[push] PUSH_PASS is not set — refusing all pushes");
    return res.status(500).json({ error: "receiver_not_configured" });
  }
  const header = req.get("authorization") || "";
  if (!header.startsWith("Basic ")) {
    res.set("WWW-Authenticate", 'Basic realm="attendance"');
    return res.status(401).json({ error: "unauthorized" });
  }
  const [user, ...rest] = Buffer.from(header.slice(6), "base64")
    .toString("utf8")
    .split(":");
  const pass = rest.join(":");
  if (!safeEqual(user || "", PUSH_USER) || !safeEqual(pass || "", PUSH_PASS)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// Accepted punch-time formats, most likely first. Day-first is what easyTimePro
// actually sends; the others are defensive in case a version or locale differs.
const PUNCH_FORMATS = [
  "DD-MM-YYYY HH:mm:ss",
  "DD-MM-YYYY H:m:s",
  "YYYY-MM-DD HH:mm:ss",
  "DD/MM/YYYY HH:mm:ss",
];

function parsePunchTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  for (const fmt of PUNCH_FORMATS) {
    const d = dayjs(raw, fmt, true); // strict — no silent fallback guessing
    if (d.isValid()) return d;
  }
  return null;
}

// Keys arrive uppercase; tolerate either so a template change can't break us.
function field(row, name) {
  return row[name.toUpperCase()] ?? row[name.toLowerCase()] ?? null;
}

const insertPunch = db.prepare(`
  INSERT OR IGNORE INTO punches (device_sn, device_user_id, punch_time, status, verify_mode, raw_line)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const recordUpload = db.prepare(`
  INSERT INTO raw_uploads (device_sn, method, path, query, body, line_count, parsed_count)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

router.post("/push/easytimepro", (req, res) => {
  const body = req.body;
  const rows = Array.isArray(body) ? body : body && typeof body === "object" ? [body] : [];

  const results = { received: rows.length, stored: 0, duplicates: 0, rejected: [] };

  const tx = db.transaction(() => {
    for (const row of rows) {
      const empCode = field(row, "emp_code");
      const punchRaw = field(row, "punch_datetime");
      const sn = field(row, "terminal_sn");

      if (!empCode || !punchRaw) {
        results.rejected.push({ row, reason: "missing EMP_CODE or PUNCH_DATETIME" });
        continue;
      }

      const parsed = parsePunchTime(punchRaw);
      if (!parsed) {
        // Never guess at an unparseable timestamp — a wrong date is a wrong wage.
        results.rejected.push({ row, reason: `unparseable PUNCH_DATETIME: ${punchRaw}` });
        continue;
      }

      const info = insertPunch.run(
        sn || "easytimepro",
        String(empCode).trim(),
        parsed.toISOString(),
        field(row, "punch_state"),
        field(row, "verify_type"),
        JSON.stringify(row)
      );

      if (info.changes > 0) results.stored++;
      else results.duplicates++;
    }

    // Keep the same forensic trail the ADMS path has: the exact bytes, always.
    try {
      recordUpload.run(
        rows.length ? field(rows[0], "terminal_sn") : null,
        "POST",
        "/api/push/easytimepro",
        "",
        JSON.stringify(body),
        rows.length,
        results.stored + results.duplicates
      );
    } catch (err) {
      console.error("[push] failed to record raw upload:", err.message);
    }
  });

  try {
    tx();
  } catch (err) {
    console.error("[push] transaction failed:", err.message);
    return res.status(500).json({ error: "store_failed", detail: err.message });
  }

  if (results.rejected.length) {
    console.warn(`[push] ${results.rejected.length} row(s) rejected:`, results.rejected);
  }
  console.log(
    `[push] received ${results.received}, stored ${results.stored}, ` +
      `duplicate ${results.duplicates}, rejected ${results.rejected.length}`
  );

  // Always 200 so easyTimePro advances its Last Api Time cursor. A non-200 makes
  // it retry the same batch forever; rejected rows are in raw_uploads either way.
  res.json(results);
});

module.exports = router;
module.exports.parsePunchTime = parsePunchTime;
