// /remind-me: validation, SQLite persistence and delivery (fake Discord client).
import { db } from "./helpers.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { checkReminderTime, renderReminder, runDueReminders } = await import("../src/services/reminders.js");
const { parseTime } = await import("../src/util/parseTime.js");

const NOW = new Date("2026-09-30T14:00:00Z");

test("checkReminderTime accepts future times and rejects past, too-soon, absurd and unparseable", () => {
  const ok = checkReminderTime(parseTime("2h", NOW), "2h", NOW);
  assert.equal(ok.ok, true);
  const past = checkReminderTime(parseTime("2020-01-01 10:00", NOW), "2020-01-01 10:00", NOW);
  assert.equal(past.ok, false);
  assert.match((past as any).error, /in the past/);
  const soon = checkReminderTime(new Date(NOW.getTime() + 5_000).toISOString(), "5s", NOW);
  assert.match((soon as any).error, /less than 30 seconds/);
  const far = checkReminderTime(parseTime("400d", NOW), "400d", NOW);
  assert.match((far as any).error, /more than a year/);
  const bad = checkReminderTime(parseTime("whenever", NOW), "whenever", NOW);
  assert.match((bad as any).error, /Could not understand `whenever`/);
});

test("reminders persist in SQLite: create, list, cancel only by owner", () => {
  const id = db.createReminder({ user_id: "u1", guild_id: "g", channel_id: "c1", message: "call back", due_at: "2026-10-01T13:00:00.000Z" });
  db.setReminderSourceUrl(id, "https://discord.com/channels/g/c1/m1");
  assert.equal(db.countPendingRemindersForUser("u1"), 1);
  assert.equal(db.getPendingRemindersForUser("u1")[0].source_url, "https://discord.com/channels/g/c1/m1");
  assert.equal(db.cancelReminder(id, "someone-else"), false);
  assert.equal(db.cancelReminder(id, "u1"), true);
  assert.equal(db.cancelReminder(id, "u1"), false);
  assert.equal(db.countPendingRemindersForUser("u1"), 0);
  // A cancelled reminder is never delivered.
  assert.deepEqual(db.getDueReminders("2030-01-01T00:00:00.000Z").filter((r) => r.id === id), []);
});

test("renderReminder mentions the user, links back and flags late delivery", () => {
  const r = {
    id: 1, user_id: "123", guild_id: "g", channel_id: "c", message: "check backups",
    source_url: "https://discord.com/channels/g/c/m", due_at: "2026-09-30T14:00:00.000Z",
    created_at: "2026-09-30 12:00:00", delivered_at: null, attempts: 0, next_attempt_at: null, last_error: null,
  };
  const onTime = renderReminder(r, new Date("2026-09-30T14:00:20Z"));
  assert.match(onTime, /^⏰ <@123> reminder: check backups\n/);
  assert.match(onTime, /\[jump to where it was set\]\(https:\/\/discord\.com\/channels\/g\/c\/m\)/);
  assert.match(onTime, /<t:1790769600:R>/); // created_at as UTC
  assert.doesNotMatch(onTime, /late/);
  assert.match(renderReminder(r, new Date("2026-09-30T16:00:00Z")), /delivered late/);
  assert.match(renderReminder({ ...r, message: null }), /^⏰ <@123> reminder\./);
});

function fakeClient(opts: { channelFails?: boolean; dmFails?: boolean }) {
  const sent: { where: string; content: string; allowedMentions: unknown }[] = [];
  const edits: unknown[] = [];
  const thread = {
    id: "t1",
    archived: true,
    locked: true,
    isTextBased: () => true,
    isThread: () => true,
    send: async (m: any) => { sent.push({ where: "t1", ...m }); return { id: "msg1" }; },
    edit: async (e: any) => { edits.push(e); },
  };
  return {
    sent,
    edits,
    client: {
      channels: { fetch: async (id: string) => { if (opts.channelFails) throw new Error("Unknown Channel"); return id === "t1" ? thread : null; } },
      users: { fetch: async (id: string) => ({ send: async (m: any) => { if (opts.dmFails) throw new Error("Cannot DM"); sent.push({ where: `dm:${id}`, ...m }); } }) },
    } as any,
  };
}

test("due reminders are delivered once, in their thread, pinging only the user (survives restart: read from db)", async () => {
  const id = db.createReminder({ user_id: "u2", guild_id: "g", channel_id: "t1", message: "ping @everyone", due_at: "2026-09-30T13:59:00.000Z" });
  db.createReminder({ user_id: "u2", guild_id: "g", channel_id: "t1", message: "later", due_at: "2026-10-30T13:59:00.000Z" });
  const f = fakeClient({});
  assert.equal(await runDueReminders(f.client, NOW), 1);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].where, "t1");
  // A literal "@everyone" in the text never pings: only the creator is allowed.
  assert.deepEqual(f.sent[0].allowedMentions, { users: ["u2"], roles: [], parse: [] });
  // Archived + locked ticket thread: unarchived to send, then restored.
  assert.deepEqual(f.edits[0], { archived: false, reason: "Delivering a reminder" });
  assert.deepEqual(f.edits[1], { archived: true, locked: true, reason: "Re-archiving after reminder" });
  assert.equal(await runDueReminders(f.client, NOW), 0);
  assert.ok(!db.getPendingRemindersForUser("u2").some((r) => r.id === id));
});

test("falls back to a DM when the channel is gone; retries later when both fail", async () => {
  const a = db.createReminder({ user_id: "u3", guild_id: "g", channel_id: "gone", message: null, due_at: "2026-09-30T13:00:00.000Z" });
  const f = fakeClient({ channelFails: true });
  await runDueReminders(f.client, NOW);
  assert.equal(f.sent[0].where, "dm:u3");
  assert.ok(!db.getPendingRemindersForUser("u3").some((r) => r.id === a));

  const b = db.createReminder({ user_id: "u4", guild_id: "g", channel_id: "gone", message: null, due_at: "2026-09-30T13:00:00.000Z" });
  const g = fakeClient({ channelFails: true, dmFails: true });
  await runDueReminders(g.client, NOW);
  const pending = db.getPendingRemindersForUser("u4").find((r) => r.id === b)!;
  assert.equal(pending.attempts, 1);
  assert.match(pending.last_error!, /Unknown Channel.*Cannot DM/);
  assert.ok(pending.next_attempt_at);
});

test("@everyone / @here and extra people or roles are pinged only when asked for", async () => {
  const base = { user_id: "u9", guild_id: "g", channel_id: "t1", message: "post the notice", due_at: "2026-09-30T13:59:00.000Z" };
  const id = db.createReminder({ ...base, mention_everyone: "everyone", mention_ids: ["r:123456", "u:654321", "u:u9"] });
  const r = db.getReminder(id)!;
  const text = renderReminder(r, NOW);
  assert.match(text, /^⏰ @everyone <@&123456> <@654321> <@u9> reminder: post the notice/);
  const f = fakeClient({});
  await runDueReminders(f.client, NOW);
  const sent = f.sent.find((x: any) => x.where === "t1")!;
  assert.deepEqual(sent.allowedMentions, { users: ["u9", "654321"], roles: ["123456"], parse: ["everyone"] });

  const here = db.getReminder(db.createReminder({ ...base, mention_everyone: "here" }))!;
  assert.match(renderReminder(here, NOW), /^⏰ @here <@u9> reminder/);
});

test("garbage mention ids are ignored", () => {
  const id = db.createReminder({ user_id: "u8", guild_id: "g", channel_id: "c", message: null, due_at: "2026-10-30T13:59:00.000Z" });
  db.db().prepare("UPDATE reminders SET mention_ids = ? WHERE id = ?").run('["x:1","u:<@everyone>",5,"r:999999"]', id);
  const r = db.getReminder(id)!;
  assert.match(renderReminder(r, NOW), /^⏰ <@&999999> <@u8> reminder\./);
});

test("a reminder set in a ticket thread writes an internal ticket note when it fires", async () => {
  const calls: { url: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ id: 777, ticket_id: 42 }), { status: 201, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    db.createReminder({ user_id: "u7", guild_id: "g", channel_id: "t1", message: "post closing notice", due_at: "2026-09-30T13:59:00.000Z", ticket_id: 42 });
    const f = fakeClient({});
    await runDueReminders(f.client, NOW);
    const note = calls.find((c) => c.url.endsWith("/api/v1/ticket_articles"));
    assert.ok(note, "a ticket article was created");
    assert.equal(note!.body.ticket_id, 42);
    assert.equal(note!.body.type, "note");
    assert.equal(note!.body.internal, true);
    assert.match(note!.body.body, /went off.*\n?post closing notice/s);
    // Already visible in the thread: recorded as synced so it is not echoed back.
    assert.equal(db.isArticleSynced(777), true);
  } finally {
    globalThis.fetch = realFetch;
  }
});
