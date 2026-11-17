import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.js";
import { ticketsNeedingCatchup, recentlyUpdated } from "../src/services/backfill.js";

const tickets = [
  { id: 1, updated_at: "2026-11-17T15:00:00Z" },
  { id: 2, updated_at: "2026-11-17T15:49:40Z" },
  { id: 3, updated_at: "2026-11-17T15:10:00Z" },
];

test("only tickets whose updated_at moved are checked", () => {
  const seen = new Map([[1, "2026-11-17T15:00:00Z"], [2, "2026-11-17T15:43:49Z"], [3, "2026-11-17T15:10:00Z"]]);
  assert.deepEqual(ticketsNeedingCatchup(tickets, seen, false), [2]);
});

test("a ticket never seen before is checked", () => {
  const seen = new Map([[1, "2026-11-17T15:00:00Z"], [2, "2026-11-17T15:49:40Z"]]);
  assert.deepEqual(ticketsNeedingCatchup(tickets, seen, false), [3]);
});

test("a full pass checks every ticket even when nothing moved", () => {
  const seen = new Map(tickets.map((t) => [t.id, t.updated_at] as [number, string]));
  assert.deepEqual(ticketsNeedingCatchup(tickets, seen, false), []);
  assert.deepEqual(ticketsNeedingCatchup(tickets, seen, true), [1, 2, 3]);
});

test("after a restart only recently changed tickets are checked at once", () => {
  const now = new Date("2026-11-17T16:25:00Z").getTime();
  assert.equal(recentlyUpdated("2026-11-17T16:21:58Z", now), true);   // reply created while the bot restarted
  assert.equal(recentlyUpdated("2026-11-17T12:00:00Z", now), false);
  assert.equal(recentlyUpdated("not a date", now), true);
});
