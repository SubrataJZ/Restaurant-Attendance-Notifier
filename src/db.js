// db.js — SQLite storage for employees, rates, and raw punches.
// SQLite is enough here: one restaurant, one or two devices, low write volume.
// If you outgrow this later, swap better-sqlite3 for a Postgres client without
// changing anything else — the queries are simple enough to port directly.

const Database = require("better-sqlite3");
const path = require("path");

// DB_PATH lets the test suite run against an in-memory database so that
// `npm test` doesn't create or touch the real attendance.db.
const db = new Database(process.env.DB_PATH || path.join(__dirname, "..", "attendance.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS employees (
  device_user_id TEXT PRIMARY KEY,   -- the User ID you set on the F09 itself
  name           TEXT NOT NULL,
  rate_type      TEXT NOT NULL CHECK (rate_type IN ('hourly','daily')) DEFAULT 'daily',
  hourly_rate    REAL DEFAULT 0,
  daily_rate     REAL DEFAULT 0,
  daily_min_hours REAL DEFAULT 6,     -- hours needed to qualify for the flat daily rate
  email          TEXT,                -- optional, for individual payslip mail later
  active         INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS punches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_sn   TEXT NOT NULL,
  device_user_id TEXT NOT NULL,
  punch_time  TEXT NOT NULL,          -- ISO string
  status      TEXT,                   -- raw status code from device (0=in,1=out, etc — device-specific)
  verify_mode TEXT,                   -- raw verify code (face/fingerprint/card)
  raw_line    TEXT,                   -- original line, kept for debugging/re-parsing
  received_at TEXT DEFAULT (datetime('now')),
  UNIQUE(device_sn, device_user_id, punch_time)
);

-- Every raw request the device makes, stored verbatim before any parsing.
-- This exists so that a firmware whose ATTLOG field order differs from what
-- parseAttLogLine() expects fails *loudly and recoverably*: the bytes are on
-- disk, so punches can be re-parsed after fixing the parser instead of lost.
CREATE TABLE IF NOT EXISTS raw_uploads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_sn   TEXT,
  method      TEXT,                   -- GET / POST
  path        TEXT,                   -- e.g. /iclock/cdata
  query       TEXT,                   -- full query string as received
  body        TEXT,                   -- raw body, untouched
  line_count  INTEGER,                -- lines found in body
  parsed_count INTEGER,               -- lines parseAttLogLine() understood
  received_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_summary (
  device_user_id TEXT NOT NULL,
  work_date      TEXT NOT NULL,       -- YYYY-MM-DD
  first_in       TEXT,
  last_out       TEXT,
  hours_worked   REAL,
  amount_due     REAL,
  flagged        INTEGER DEFAULT 0,   -- 1 if this record needs manual review
  flag_reason    TEXT,
  PRIMARY KEY (device_user_id, work_date)
);
`);

module.exports = db;
