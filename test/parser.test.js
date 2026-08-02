// Regression tests for parseAttLogLine() — the one piece of this system that
// had to be written against ZKTeco's published protocol rather than against the
// physical F09, and therefore the piece most likely to need adjusting.
//
// The parser deliberately does NOT read fixed column indexes. It locates the
// timestamp and reads the PIN and status codes relative to it, which is what
// lets it absorb the separator and field-order differences seen across
// firmware builds. These cases pin that behaviour down: if someone later
// "simplifies" it back to split("\t")[1], the variants below start failing.
//
// If the real device turns out to use a format not covered here, add the raw
// line from `GET /api/debug/raw?unparsed=1` as a new case, make it pass, then
// POST /api/debug/reparse to recover the punches that were dropped.

process.env.DB_PATH = ":memory:"; // must be set before src/db.js is required

const test = require("node:test");
const assert = require("node:assert/strict");
const dayjs = require("dayjs");
const { parseAttLogLine } = require("../src/routes/adms.js");

// Each case: [description, raw line, expected PIN, expected local time]
const ACCEPTED = [
  ["documented tab format", "1\t2026-08-03 09:02:15\t0\t1\t0", "1", "2026-08-03 09:02:15"],
  ["extra trailing columns", "7\t2026-08-03 18:15:00\t1\t15\t0\t0\t0\t0", "7", "2026-08-03 18:15:00"],
  ["space separated", "1 2026-08-03 09:02:15 0 1 0", "1", "2026-08-03 09:02:15"],
  ["multi-space padded", "12   2026-08-03 09:02:15   0   1", "12", "2026-08-03 09:02:15"],
  ["seconds omitted", "3\t2026-08-03 09:02\t0\t1", "3", "2026-08-03 09:02:00"],
  ["ISO-style T separator", "4\t2026-08-03T09:02:15\t0\t1", "4", "2026-08-03 09:02:15"],
  ["slash date separator", "5\t2026/08/03 09:02:15\t0\t1", "5", "2026-08-03 09:02:15"],
  ["single-digit month/day/hour", "6\t2026-8-3 9:02:15\t0\t1", "6", "2026-08-03 09:02:15"],
  ["alphanumeric PIN", "EMP01\t2026-08-03 09:02:15\t0\t1", "EMP01", "2026-08-03 09:02:15"],
  ["extra column before the PIN", "0\t9\t2026-08-03 09:02:15\t0\t1", "9", "2026-08-03 09:02:15"],
  ["no trailing codes at all", "8\t2026-08-03 09:02:15", "8", "2026-08-03 09:02:15"],
];

// Lines that must NOT produce a punch. A false positive here is worse than a
// miss: it would invent attendance data that someone gets paid for.
const REJECTED = [
  ["free text", "this is not a punch"],
  ["column header row", "PIN\tDateTime\tStatus\tVerify"],
  ["timestamp with no PIN in front", "2026-08-03 09:02:15\t0\t1"],
  ["calendar-impossible date", "1\t2026-02-30 09:02:15\t0\t1"],
  ["empty line", ""],
  ["no timestamp at all", "1\t\t0\t1"],
];

test("accepts known ATTLOG format variants", async (t) => {
  for (const [desc, line, pin, time] of ACCEPTED) {
    await t.test(desc, () => {
      const got = parseAttLogLine(line);
      assert.ok(got, `expected a punch, got null for ${JSON.stringify(line)}`);
      assert.equal(got.pin, pin, "PIN");
      assert.equal(dayjs(got.time).format("YYYY-MM-DD HH:mm:ss"), time, "timestamp");
    });
  }
});

test("rejects lines that are not punches", async (t) => {
  for (const [desc, line] of REJECTED) {
    await t.test(desc, () => {
      assert.equal(
        parseAttLogLine(line),
        null,
        `expected null for ${JSON.stringify(line)} — a false punch becomes a payout`
      );
    });
  }
});

test("reads status and verify codes following the timestamp", () => {
  const got = parseAttLogLine("1\t2026-08-03 18:15:00\t1\t15\t0");
  assert.equal(got.status, "1");
  assert.equal(got.verify, "15");
});

test("defaults status and verify when the device omits them", () => {
  const got = parseAttLogLine("1\t2026-08-03 09:02:15");
  assert.equal(got.status, "0");
  assert.equal(got.verify, "0");
});
