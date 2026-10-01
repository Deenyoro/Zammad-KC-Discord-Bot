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
