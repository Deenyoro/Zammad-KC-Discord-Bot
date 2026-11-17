// The time parser shared by /schedule and /remind-me, in the bot timezone.
import { db } from "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { parseTime } = await import("../src/util/parseTime.js");

db.setSetting("TIMEZONE", "America/New_York");
// Wednesday 2026-09-30 10:00 EDT (UTC-4)
const NOW = new Date("2026-09-30T14:00:00Z");
const p = (s: string) => parseTime(s, NOW);

test("relative durations", () => {
  assert.equal(p("30m"), "2026-09-30T14:30:00.000Z");
  assert.equal(p("2h"), "2026-09-30T16:00:00.000Z");
  assert.equal(p("3d"), "2026-10-03T14:00:00.000Z");
  assert.equal(p("1w"), "2026-10-07T14:00:00.000Z");
  assert.equal(p("2 hours"), "2026-09-30T16:00:00.000Z");
  assert.equal(p("in 45 mins"), "2026-09-30T14:45:00.000Z");
});

test("combined durations", () => {
  assert.equal(p("1h30m"), "2026-09-30T15:30:00.000Z");
  assert.equal(p("1d 2h"), "2026-10-01T16:00:00.000Z");
});

test("months", () => {
  assert.equal(p("1mo"), "2026-10-30T14:00:00.000Z");
});

test("tomorrow / today in the bot timezone", () => {
  assert.equal(p("tomorrow"), "2026-10-01T13:00:00.000Z"); // 09:00 EDT
  assert.equal(p("tomorrow 9am"), "2026-10-01T13:00:00.000Z");
  assert.equal(p("tomorrow 2:30pm"), "2026-10-01T18:30:00.000Z");
  assert.equal(p("tomorrow at 14:00"), "2026-10-01T18:00:00.000Z");
  assert.equal(p("today 5pm"), "2026-09-30T21:00:00.000Z");
});

test("date and date-time without offset use the bot timezone", () => {
  assert.equal(p("2026-10-05 14:00"), "2026-10-05T18:00:00.000Z");
  assert.equal(p("2026-10-05T14:00"), "2026-10-05T18:00:00.000Z");
  assert.equal(p("2026-10-05 2pm"), "2026-10-05T18:00:00.000Z");
  assert.equal(p("2026-10-05"), "2026-10-05T13:00:00.000Z"); // 09:00
  // After the DST change (EST, UTC-5)
  assert.equal(p("2026-12-01 09:00"), "2026-12-01T14:00:00.000Z");
});

test("explicit offsets are used as given", () => {
  assert.equal(p("2026-10-05T14:00:00Z"), "2026-10-05T14:00:00.000Z");
  assert.equal(p("2026-10-05T14:00:00-07:00"), "2026-10-05T21:00:00.000Z");
});

test("weekday names pick the next occurrence", () => {
  assert.equal(p("friday 3pm"), "2026-10-02T19:00:00.000Z");
  assert.equal(p("monday"), "2026-10-05T13:00:00.000Z");
  // Today is Wednesday: 9am already passed, so next week; 3pm is still ahead.
  assert.equal(p("wednesday 9am"), "2026-10-07T13:00:00.000Z");
  assert.equal(p("wed 3pm"), "2026-09-30T19:00:00.000Z");
});

test("bare time of day: today if ahead, else tomorrow", () => {
  assert.equal(p("17:30"), "2026-09-30T21:30:00.000Z");
  assert.equal(p("9am"), "2026-10-01T13:00:00.000Z");
});

test("rejects garbage and impossible dates", () => {
  for (const bad of ["", "soon", "2026-02-31", "2026-13-01", "25:00", "13pm", "5 parsecs", "tomorrow 99", "x".repeat(200)]) {
    assert.equal(p(bad), null, bad);
  }
});

test("returns past times unchanged (callers validate)", () => {
  assert.equal(p("2020-01-01 10:00"), "2020-01-01T15:00:00.000Z");
});

test("calendar dates without a year (next occurrence, 9:00 default)", () => {
  // NOW is Wed 2026-09-30 10:00 EDT. November is EST (UTC-5).
  assert.equal(p("nov 24"), "2026-11-24T14:00:00.000Z");
  assert.equal(p("Nov 24 9am"), "2026-11-24T14:00:00.000Z");
  assert.equal(p("november 24th at 2:30pm"), "2026-11-24T19:30:00.000Z");
  assert.equal(p("Nov. 24, 9am"), "2026-11-24T14:00:00.000Z");
  assert.equal(p("on dec 22"), "2026-12-22T14:00:00.000Z");
  assert.equal(p("24 nov"), "2026-11-24T14:00:00.000Z");
  assert.equal(p("the 22nd of december 8am"), "2026-12-22T13:00:00.000Z");
  assert.equal(p("sept 30 11am"), "2026-09-30T15:00:00.000Z"); // later today
  assert.equal(p("sep 30"), "2027-09-30T13:00:00.000Z"); // 9:00 today already passed
  assert.equal(p("jan 5"), "2027-01-05T14:00:00.000Z"); // rolls into next year
});

test("calendar dates with a year", () => {
  assert.equal(p("dec 22, 2026"), "2026-12-22T14:00:00.000Z");
  assert.equal(p("dec 22 2026 3pm"), "2026-12-22T20:00:00.000Z");
  assert.equal(p("11/24/2026"), "2026-11-24T14:00:00.000Z");
  assert.equal(p("11/24/26 9am"), "2026-11-24T14:00:00.000Z");
});

test("US month/day", () => {
  assert.equal(p("11/24"), "2026-11-24T14:00:00.000Z");
  assert.equal(p("12/22 9:30am"), "2026-12-22T14:30:00.000Z");
  assert.equal(p("1/2"), "2027-01-02T14:00:00.000Z");
});

test("bare ordinal day of the month", () => {
  assert.equal(p("24th"), "2026-10-24T13:00:00.000Z"); // next 24th is in October (EDT)
  assert.equal(p("the 1st 8am"), "2026-10-01T12:00:00.000Z");
  assert.equal(p("31st"), "2026-10-31T13:00:00.000Z");
});

test("invalid calendar dates are rejected", () => {
  assert.equal(p("feb 30"), null);
  assert.equal(p("13/5"), null);
  assert.equal(p("nov 31"), null);
  assert.equal(p("smarch 3"), null);
  assert.equal(p("24"), null);
  assert.equal(p("nov 24 25pm"), null);
});

test("weekday parsing is unchanged by month names", () => {
  assert.equal(p("monday"), "2026-10-05T13:00:00.000Z");
  assert.equal(p("fri 3pm"), "2026-10-02T19:00:00.000Z");
});
