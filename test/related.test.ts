// Related tickets and merge bookkeeping. Shapes follow real Zammad responses:
// a merge writes "merged_into" on the merged-away ticket and "received_merge"
// on the target, both with id_from = merged-away ticket, id_to = target, and
// links list the OTHER ticket's role ("parent" on the child, "child" on the target).
import "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { db } = await import("./helpers.js");
const { mergeEventsFromHistory, buildRelatedList, formatRelatedLines, discordThreadUrl } = await import(
  "../src/services/related.js"
);

const hist = (o_id: number, type: string, id_from: number, id_to: number, created_at = "2026-11-03T21:08:51.657Z") => ({
  id: Math.floor(Math.random() * 1e6),
  object: "Ticket",
  o_id,
  type,
  id_from,
  id_to,
  created_at,
  created_by_id: 217,
});

test("merge events are read from both sides of a merge", () => {
  const child = mergeEventsFromHistory(9619, [hist(9619, "merged_into", 9619, 6651)] as any);
  assert.deepEqual(child.map((m) => [m.childId, m.parentId]), [[9619, 6651]]);

  const parent = mergeEventsFromHistory(6651, [
    hist(6651, "received_merge", 5549, 6651),
    hist(6651, "received_merge", 9619, 6651),
    { ...hist(6651, "updated", 0, 0), attribute: "state" },
    { ...hist(77, "received_merge", 1, 77) }, // another ticket's entry
  ] as any);
  assert.deepEqual(parent.map((m) => m.childId), [5549, 9619]);
});

const tickets = new Map([
  [6651, { id: 6651, number: "185565", title: "ReadyHaul Launch", state_id: 2 }],
  [9619, { id: 9619, number: "188246", title: "Re: launch", state_id: 4 }],
  [5629, { id: 5629, number: "182000", title: "Linked child", state_id: 2 }],
  [700, { id: 700, number: "181000", title: "Same customer", state_id: 2 }],
]);
const states = (id: number) => (id === 4 ? "closed" : "open");

test("on the target: merges say 'merged in', a plain child link stays a child", () => {
  const list = buildRelatedList(
    6651,
    [
      { link_type: "child", link_object: "Ticket", link_object_value: 5629 },
      { link_type: "child", link_object: "Ticket", link_object_value: 9619 },
      { link_type: "normal", link_object: "Ticket", link_object_value: 700 },
    ],
    tickets,
    mergeEventsFromHistory(6651, [hist(6651, "received_merge", 9619, 6651)] as any),
    states,
    (id) => (id === 217 ? "Pat Agent" : undefined),
  );
  assert.deepEqual(
    list.map((r) => [r.id, r.relation, r.state]),
    [
      [9619, "merged_from", "closed"],
      [5629, "child", "open"],
      [700, "related", "open"],
    ]
  );
  assert.equal(list[0].mergedBy, "Pat Agent");
});

test("on the merged-away ticket: the target is 'merged into', not 'parent'", () => {
  const list = buildRelatedList(
    9619,
    [{ link_type: "parent", link_object: "Ticket", link_object_value: 6651 }],
    tickets,
    mergeEventsFromHistory(9619, [hist(9619, "merged_into", 9619, 6651)] as any),
    states,
  );
  assert.deepEqual(list.map((r) => [r.id, r.relation]), [[6651, "merged_into"]]);
});

test("Discord lines link to Zammad and to the thread when the bot tracks it", () => {
  db.upsertTicketThread({
    ticket_id: 9619,
    ticket_number: "188246",
    thread_id: "555",
    header_message_id: "1",
    channel_id: "1",
    title: "Re: launch",
    state: "closed",
  });
  const lines = formatRelatedLines([
    { id: 9619, number: "188246", title: "Re: [launch]", state: "closed", relation: "merged_from" },
    { id: 700, number: "181000", title: "Same customer", state: "open", relation: "related" },
  ]);
  assert.match(lines[0], /\[#188246\]\(https:\/\/helpdesk\.example\.com\/#ticket\/zoom\/9619\)/);
  assert.ok(lines[0].includes(`[Discord thread](${discordThreadUrl("555")})`));
  assert.ok(!lines[0].includes("[launch]"), "brackets in titles would break the Markdown link");
  assert.ok(!lines[1].includes("Discord thread"));
});

test("long lists are capped with a pointer to /related", () => {
  const many = Array.from({ length: 13 }, (_, i) => ({
    id: 1000 + i, number: String(1000 + i), title: "t", state: "open", relation: "related" as const,
  }));
  const lines = formatRelatedLines(many);
  assert.equal(lines.length, 11);
  assert.match(lines[10], /\+3 more/);
});

test("each merge is claimed once; a failed announcement can be retried", () => {
  assert.equal(db.claimMergeNote(9619, 6651), true);
  assert.equal(db.claimMergeNote(9619, 6651), false);
  db.releaseMergeNote(9619, 6651);
  assert.equal(db.claimMergeNote(9619, 6651), true);
});
