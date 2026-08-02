// api.js — the "app" side of things: manage employee rates, and expose a
// report endpoint that n8n calls on a schedule to build the email/Drive report.
// This is a small internal API, not meant to be public — put it behind the
// simple API-key check below at minimum, and behind your VPS firewall/HTTPS.

const express = require("express");
const router = express.Router();
const db = require("../db");
const { computeDailySummaryForDate } = require("../calc");
const dayjs = require("dayjs");

const API_KEY = process.env.API_KEY || "change-me";

router.use((req, res, next) => {
  if (req.get("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// ---- Employee / rate management -------------------------------------------

// List all employees + rates
router.get("/employees", (req, res) => {
  res.json(db.prepare(`SELECT * FROM employees ORDER BY name`).all());
});

// Create or update an employee's rate info.
// device_user_id MUST match the User ID you set on the F09 device itself.
//
// Input is validated here rather than left to SQLite's constraints, because
// these values decide what people get paid — a typo that lands a blank rate or
// a bad rate_type should come back as a clear 400 to the admin form, not a 500
// or a silently-zero payout.
router.put("/employees/:device_user_id", (req, res) => {
  const device_user_id = String(req.params.device_user_id || "").trim();
  const { email } = req.body;

  const errors = [];
  if (!device_user_id) errors.push("device_user_id is required");

  const name = String(req.body.name ?? "").trim();
  if (!name) errors.push("name is required");

  const rate_type = String(req.body.rate_type ?? "daily").trim();
  if (rate_type !== "hourly" && rate_type !== "daily") {
    errors.push(`rate_type must be "hourly" or "daily"`);
  }

  const num = (value, field, { required }) => {
    if (value === undefined || value === null || value === "") {
      if (required) errors.push(`${field} is required for ${rate_type} rate`);
      return 0;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      errors.push(`${field} must be a number of 0 or more`);
      return 0;
    }
    return n;
  };

  const hourly_rate = num(req.body.hourly_rate, "hourly_rate", { required: rate_type === "hourly" });
  const daily_rate = num(req.body.daily_rate, "daily_rate", { required: rate_type === "daily" });
  const daily_min_hours = num(req.body.daily_min_hours ?? 6, "daily_min_hours", { required: false });

  // A zero here would make calc.js divide by daily_min_hours || 8 on short
  // shifts, quietly prorating against 8h instead of the intended minimum.
  if (rate_type === "daily" && daily_min_hours <= 0) {
    errors.push("daily_min_hours must be greater than 0 for a daily rate");
  }
  if (rate_type === "hourly" && hourly_rate === 0) errors.push("hourly_rate must be greater than 0");
  if (rate_type === "daily" && daily_rate === 0) errors.push("daily_rate must be greater than 0");

  const active = req.body.active === undefined ? 1 : Number(req.body.active) ? 1 : 0;

  if (errors.length) return res.status(400).json({ error: "validation_failed", details: errors });

  db.prepare(`
    INSERT INTO employees (device_user_id, name, rate_type, hourly_rate, daily_rate, daily_min_hours, email, active)
    VALUES (@device_user_id, @name, @rate_type, @hourly_rate, @daily_rate, @daily_min_hours, @email, @active)
    ON CONFLICT(device_user_id) DO UPDATE SET
      name=excluded.name, rate_type=excluded.rate_type, hourly_rate=excluded.hourly_rate,
      daily_rate=excluded.daily_rate, daily_min_hours=excluded.daily_min_hours,
      email=excluded.email, active=excluded.active
  `).run({
    device_user_id,
    name,
    rate_type,
    hourly_rate,
    daily_rate,
    daily_min_hours,
    email: email ? String(email).trim() : null,
    active,
  });

  res.json({ ok: true, employee: db.prepare(`SELECT * FROM employees WHERE device_user_id = ?`).get(device_user_id) });
});

// ---- Reporting (this is what n8n calls) ------------------------------------

// Compute + fetch the summary for a given date (defaults to yesterday, since
// the report usually runs the morning after).
router.get("/report/daily", (req, res) => {
  const date = req.query.date || dayjs().subtract(1, "day").format("YYYY-MM-DD");
  const results = computeDailySummaryForDate(date);

  const totalAmount = results.reduce((sum, r) => sum + r.amount_due, 0);
  const flaggedCount = results.filter((r) => r.flagged).length;

  res.json({
    date,
    employees: results,
    total_amount_due: Number(totalAmount.toFixed(2)),
    flagged_count: flaggedCount,
  });
});

// Same thing but as CSV, ready to attach to an email or drop in Drive.
router.get("/report/daily.csv", (req, res) => {
  const date = req.query.date || dayjs().subtract(1, "day").format("YYYY-MM-DD");
  const results = computeDailySummaryForDate(date);

  const header = "Employee,DeviceUserID,HoursWorked,AmountDue,Flagged,FlagReason\n";
  const rows = results
    .map((r) =>
      [r.employee, r.device_user_id, r.hours, r.amount_due, r.flagged ? "YES" : "", r.flag_reason || ""]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");

  res.type("text/csv").attachment(`attendance_${date}.csv`).send(header + rows);
});

// ---- Debug / first-connection diagnostics ----------------------------------
// These exist for bringing a new device online: they let you see exactly what
// the F09 sent without SSHing in to tail a log, and re-parse stored uploads
// after correcting the parser.

// The most recent raw requests from the device, newest first.
// ?unparsed=1 shows only uploads where at least one line wasn't understood.
router.get("/debug/raw", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 200);
  const where = req.query.unparsed ? `WHERE line_count > parsed_count` : ``;
  res.json(
    db.prepare(`SELECT * FROM raw_uploads ${where} ORDER BY id DESC LIMIT ?`).all(limit)
  );
});

// The most recent parsed punches, newest first — confirms the join key
// (device_user_id) matches the User IDs you set in the employees table.
router.get("/debug/punches", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 200);
  res.json(db.prepare(`SELECT * FROM punches ORDER BY id DESC LIMIT ?`).all(limit));
});

// Punches whose device_user_id has no matching employee row. If a real punch
// produces nothing in the report, this is almost always why.
router.get("/debug/unknown-users", (req, res) => {
  res.json(
    db.prepare(`
      SELECT p.device_user_id, COUNT(*) AS punch_count, MAX(p.punch_time) AS last_punch
      FROM punches p
      LEFT JOIN employees e ON e.device_user_id = p.device_user_id
      WHERE e.device_user_id IS NULL
      GROUP BY p.device_user_id
      ORDER BY last_punch DESC
    `).all()
  );
});

// Re-run the parser over stored uploads. Recovers punches dropped either by a
// parser that didn't understand the firmware's format, or by the device having
// been in the wrong push mode when they arrived.
// Safe to run repeatedly — punches has a UNIQUE constraint and inserts IGNORE.
router.post("/debug/reparse", (req, res) => {
  const { parseAttLogLine, BENIGN_TABLES } = require("./adms");
  const uploads = db
    .prepare(`SELECT * FROM raw_uploads WHERE body != '' ORDER BY id ASC`)
    .all();

  const insert = db.prepare(`
    INSERT OR IGNORE INTO punches (device_sn, device_user_id, punch_time, status, verify_mode, raw_line)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let recovered = 0;
  let stillUnparsed = 0;
  const samples = [];
  const byTable = {};

  const tx = db.transaction(() => {
    for (const up of uploads) {
      // Attempt any table that could plausibly carry attendance records — not
      // just ATTLOG. Records captured while the device was still in AC push
      // mode arrive under a different table name (RTLOG and similar), and
      // those are exactly the punches this endpoint exists to recover. Tables
      // known to be something else (photos, templates, operation logs) are
      // skipped so their timestamps can't be mistaken for punches.
      const table = (/table=([A-Za-z_]+)/i.exec(up.query || "") || [, ""])[1].toUpperCase();
      if (BENIGN_TABLES.has(table)) continue;

      for (const line of up.body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        const parsed = parseAttLogLine(line);
        if (!parsed) {
          stillUnparsed++;
          if (samples.length < 5) samples.push(line);
          continue;
        }
        const info = insert.run(
          up.device_sn,
          parsed.pin,
          parsed.time,
          parsed.status,
          parsed.verify,
          line
        );
        if (info.changes > 0) {
          recovered++;
          byTable[table || "(none)"] = (byTable[table || "(none)"] || 0) + 1;
        }
      }
    }
  });
  tx();

  res.json({
    uploads_scanned: uploads.length,
    new_punches_recovered: recovered,
    // Which table the recovered punches came from — anything other than
    // ATTLOG means they were captured while the device was on the wrong
    // push protocol, and it's worth confirming the times look right.
    recovered_by_table: byTable,
    still_unparsed: stillUnparsed,
    unparsed_samples: samples,
  });
});

module.exports = router;
