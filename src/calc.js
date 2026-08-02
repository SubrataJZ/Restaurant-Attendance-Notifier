// calc.js — turns raw punches into hours worked and DA amount per employee per day.
//
// Approach: for each employee, for each calendar date, take the EARLIEST punch
// as "in" and the LATEST punch as "out". This is deliberately simple and
// forgiving of duplicate/extra punches (a common real-world quirk — someone
// taps twice, or the face scan and a backup fingerprint both register).
//
// Edge cases are FLAGGED for manual review rather than silently trusted:
//   - Only one punch all day (no clear out) -> flagged, hours = 0
//   - Shift longer than 14 hours -> flagged (likely a missed punch-out)
//   - Shift shorter than 1 hour -> flagged (likely accidental double-tap)
// Flagged records still get computed hours where possible, but you should
// review them before they hit the auto-pay step.

const dayjs = require("dayjs");
const db = require("../src/db");

const MAX_REASONABLE_HOURS = 14;
const MIN_REASONABLE_HOURS = 1;

function computeDailySummaryForDate(dateStr) {
  // dateStr: 'YYYY-MM-DD'
  const start = dayjs(dateStr).startOf("day").toISOString();
  const end = dayjs(dateStr).endOf("day").toISOString();

  const employees = db.prepare(`SELECT * FROM employees WHERE active = 1`).all();
  const upsert = db.prepare(`
    INSERT INTO daily_summary (device_user_id, work_date, first_in, last_out, hours_worked, amount_due, flagged, flag_reason)
    VALUES (@device_user_id, @work_date, @first_in, @last_out, @hours_worked, @amount_due, @flagged, @flag_reason)
    ON CONFLICT(device_user_id, work_date) DO UPDATE SET
      first_in=excluded.first_in, last_out=excluded.last_out, hours_worked=excluded.hours_worked,
      amount_due=excluded.amount_due, flagged=excluded.flagged, flag_reason=excluded.flag_reason
  `);

  const results = [];

  for (const emp of employees) {
    const punches = db
      .prepare(
        `SELECT punch_time FROM punches WHERE device_user_id = ? AND punch_time BETWEEN ? AND ? ORDER BY punch_time ASC`
      )
      .all(emp.device_user_id, start, end);

    if (punches.length === 0) continue; // no punches at all -> not scheduled/absent, skip silently

    const firstIn = punches[0].punch_time;
    const lastOut = punches[punches.length - 1].punch_time;
    let hours = dayjs(lastOut).diff(dayjs(firstIn), "minute") / 60;

    let flagged = 0;
    let flagReason = null;

    if (punches.length === 1) {
      flagged = 1;
      flagReason = "Only one punch recorded — missing punch-in or punch-out";
      hours = 0;
    } else if (hours > MAX_REASONABLE_HOURS) {
      flagged = 1;
      flagReason = `Shift of ${hours.toFixed(1)}h exceeds ${MAX_REASONABLE_HOURS}h — likely a missed punch-out`;
    } else if (hours < MIN_REASONABLE_HOURS) {
      flagged = 1;
      flagReason = `Shift of ${hours.toFixed(1)}h is under ${MIN_REASONABLE_HOURS}h — check for accidental double punch`;
    }

    const amountDue = calculateAmount(emp, hours);

    upsert.run({
      device_user_id: emp.device_user_id,
      work_date: dateStr,
      first_in: firstIn,
      last_out: lastOut,
      hours_worked: Number(hours.toFixed(2)),
      amount_due: Number(amountDue.toFixed(2)),
      flagged,
      flag_reason: flagReason,
    });

    results.push({
      employee: emp.name,
      device_user_id: emp.device_user_id,
      hours: Number(hours.toFixed(2)),
      amount_due: Number(amountDue.toFixed(2)),
      flagged: !!flagged,
      flag_reason: flagReason,
    });
  }

  return results;
}

function calculateAmount(emp, hours) {
  if (emp.rate_type === "hourly") {
    return hours * emp.hourly_rate;
  }
  // daily rate: pay the flat daily rate only if minimum hours were met,
  // otherwise prorate hourly using daily_rate / daily_min_hours as an implied rate.
  if (hours >= emp.daily_min_hours) {
    return emp.daily_rate;
  }
  const impliedHourly = emp.daily_rate / (emp.daily_min_hours || 8);
  return hours * impliedHourly;
}

module.exports = { computeDailySummaryForDate };
