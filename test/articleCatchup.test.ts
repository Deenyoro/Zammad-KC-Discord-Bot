import { test } from "node:test";
import assert from "node:assert/strict";
import "./helpers.js";
import { ticketsNeedingCatchup, recentlyUpdated } from "../src/services/backfill.js";
import { stateIdQuery } from "../src/services/zammad.js";

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

test("open-ticket query lists the ids of every state that is not closed", () => {
  const states = [
    { id: 1, name: "new", active: true }, { id: 2, name: "open", active: true }, { id: 3, name: "pending reminder", active: true },
    { id: 4, name: "closed", active: true }, { id: 5, name: "merged", active: true }, { id: 7, name: "waiting for reply", active: true },
    { id: 8, name: "closed (locked)", active: true }, { id: 12, name: "old state", active: false },
  ];
  const q = stateIdQuery(states);
  assert.ok(q);
  const ids = q!.replace(/^state_id:\(|\)$/g, "").split(" OR ").map(Number);
  assert.ok(ids.includes(1) && ids.includes(2) && ids.includes(3) && ids.includes(7));
  assert.ok(!ids.includes(4) && !ids.includes(12));
  assert.equal(stateIdQuery([{ id: 4, name: "closed" }]), null);
});
