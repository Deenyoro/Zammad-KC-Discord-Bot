// kc-ops: the bot never sends a direct message to anyone but the owner. Staff see everything in the access channel
// in messages only they can see; the owner asks for access by DM and nothing is announced.
Object.assign(process.env, {
  KCOPS_GATE_URL: "http://kc-gate.kc-ops.svc:8081",
  KCOPS_GATE_TOKEN: "x".repeat(40),
  KCOPS_OWNER_USER_ID: "100000",
  KCOPS_ACCESS_CHANNEL_ID: "300000",
});
await import("./helpers.js");
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MessageFlags } from "discord.js";

const k = await import("../src/kcops/discord.js");
const { setFetchForTests } = await import("../src/kcops/gate.js");

const OWNER = "100000";
const STAFF = "2001";
const LINK = "https://ops.example.test/l#SECRETTOKEN";

/** A Discord client that records every DM (by recipient) and every channel post. */
function fakeClient(opts: { channelFails?: boolean } = {}) {
  const dms: any[] = [];
  const posts: any[] = [];
  const client: any = {
    users: { fetch: async (id: string) => ({ send: async (m: any) => dms.push({ id, m }) }) },
    channels: {
      fetch: async (id: string) => ({
        isSendable: () => true,
        send: async (m: any) => {
          if (opts.channelFails) throw new Error("missing access");
          posts.push({ id, m });
        },
      }),
    },
    guilds: { fetch: async () => ({ members: { fetch: async (id: string) => ({ id }) } }) },
  };
  return { client, dms, posts };
}

function gateStub(routes: Record<string, (body: any) => any>) {
  const seen: { path: string; body: any }[] = [];
  setFetchForTests((async (url: any, init: any) => {
    const path = new URL(String(url)).pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    seen.push({ path, body });
    const fn = routes[path];
    if (!fn) throw new Error(`unexpected gate call ${path}`);
    return new Response(JSON.stringify(fn(body)));
  }) as any);
  return seen;
}

function fakeInteraction(client: any, userId: string, extra: any = {}) {
  const calls: any = { deferReply: [], deferUpdate: 0, edits: [], followUps: [], deleted: 0 };
  const interaction: any = {
    client,
    user: { id: userId },
    channelId: "300000",
    guildId: "1",
    inGuild: () => true,
    message: { content: "prompt", delete: async () => { calls.deleted++; } },
    options: { getInteger: () => null, getSubcommandGroup: () => null, getSubcommand: () => "panel", getUser: () => null, getString: () => null },
    deferReply: async (m: any) => calls.deferReply.push(m),
    deferUpdate: async () => { calls.deferUpdate++; },
    editReply: async (m: any) => calls.edits.push(m),
    followUp: async (m: any) => calls.followUps.push(m),
    ...extra,
  };
  return { interaction, calls };
}

const text = (m: any) => (typeof m === "string" ? m : m.content);
const buttonIds = (m: any) => (m.components ?? []).flatMap((r: any) => r.toJSON().components.map((c: any) => c.custom_id));
const noStaffDm = (dms: any[]) => assert.deepEqual(dms.filter((d) => d.id !== OWNER), [], "a DM was sent to a non-owner");

beforeEach(() => k.forgetInteractionsForTests());

test("/access: the link is an ephemeral reply to the requester; nothing is DMed or posted", async () => {
  const { client, dms, posts } = fakeClient();
  const seen = gateStub({ "/internal/access": () => ({ kind: "link", url: LINK, minutes: 60 }) });
  const { interaction, calls } = fakeInteraction(client, STAFF);
  await k.handleAccess(interaction);
  assert.deepEqual(calls.deferReply, [{ flags: MessageFlags.Ephemeral }]);
  assert.ok(text(calls.edits[0]).includes(`<${LINK}>`) && text(calls.edits[0]).includes("Only you can see"));
  assert.equal(seen[0].body.owner_dm, undefined);
  assert.equal(dms.length + posts.length, 0);
});

test("Request access button behaves like /access", async () => {
  const { client, dms, posts } = fakeClient();
  const seen = gateStub({ "/internal/access": () => ({ kind: "link", url: LINK, minutes: 60 }) });
  const { interaction, calls } = fakeInteraction(client, STAFF, { customId: "kcops:request" });
  await k.handleKcopsButton(interaction);
  assert.deepEqual(seen[0].body, { discord_id: STAFF, channel_id: "300000", is_member: true, minutes: null });
  assert.deepEqual(calls.deferReply, [{ flags: MessageFlags.Ephemeral }]);
  assert.ok(text(calls.edits[0]).includes(LINK));
  assert.equal(dms.length + posts.length, 0);
});

test("a refused /access is not remembered, so later messages use the pointer", async () => {
  const { client, dms, posts } = fakeClient();
  gateStub({
    "/internal/access": () => ({ kind: "refused", code: "wrong_channel", reason: "Use /access in the access channel." }),
    "/internal/outbox": () => ({ items: [{ id: 9, target: "user", discord_id: STAFF, kind: "notice", text: "secret notice", payload: {}, age: 1 }] }),
    "/internal/outbox/ack": () => ({ ok: true }),
  });
  const { interaction, calls } = fakeInteraction(client, STAFF);
  await k.handleAccess(interaction);
  assert.equal(text(calls.edits[0]), "Use /access in the access channel.");
  await k.deliverOutbox(client);
  assert.equal(calls.followUps.length, 0);
  assert.equal(posts.length, 1);
  noStaffDm(dms);
});

test("owner approves while the requester's interaction is open: the link is a private follow-up", async () => {
  const { client, dms, posts } = fakeClient();
  gateStub({
    "/internal/access": () => ({ kind: "pending_owner", request_id: 42, minutes: 60, asked: null }),
    "/internal/decision": () => ({ kind: "link", discord_id: STAFF, url: LINK, minutes: 60, request_id: 42 }),
  });
  const staff = fakeInteraction(client, STAFF);
  await k.handleAccess(staff.interaction);
  assert.match(text(staff.calls.edits[0]), /Asked Dean to approve 1 h/);
  // the owner prompt: the owner's DM only (default route "dm" since 2026-11-13), with a button for the asked hour
  assert.equal(posts.length, 0);
  const prompt = dms.find((d) => d.id === OWNER)!.m;
  assert.deepEqual(buttonIds(prompt), ["kcops:ext:42:60", "kcops:ext:42:deny"]);
  assert.ok(dms.every((d) => d.id === OWNER));
  const before = posts.length;
  const owner = fakeInteraction(client, OWNER, { customId: "kcops:ext:42:60" });
  await k.handleKcopsButton(owner.interaction);
  assert.equal(staff.calls.followUps.length, 1);
  assert.equal(staff.calls.followUps[0].flags, MessageFlags.Ephemeral);
  assert.ok(staff.calls.followUps[0].content.includes(LINK));
  assert.equal(posts.length, before); // nothing public
  // Dean is silent: the channel prompt is removed and the result is shown to him alone
  assert.equal(owner.calls.edits.length, 0);
  assert.equal(owner.calls.deleted, 1);
  assert.equal(owner.calls.followUps[0].flags, MessageFlags.Ephemeral);
  assert.match(text(owner.calls.followUps[0]), /Granted 1 h\.$/);
  for (const x of [...posts, ...dms]) assert.ok(!text(x.m).includes("SECRETTOKEN"));
  noStaffDm(dms);
});

test("owner approves later: a public pointer without the link, then Show my link gives it privately to the requester only", async () => {
  const { client, dms, posts } = fakeClient();
  const seen = gateStub({
    "/internal/decision": () => ({ kind: "link", discord_id: STAFF, url: LINK, minutes: 480, request_id: 42 }),
    "/internal/link": (b) => (b.discord_id === STAFF
      ? { kind: "link", url: "https://ops.example.test/l#FRESH", minutes: 480 }
      : { kind: "refused", code: "not_yours", reason: "That sign-in link is for someone else. Run /access to request your own." }),
  });
  const owner = fakeInteraction(client, OWNER, { customId: "kcops:ext:42:480" });
  await k.handleKcopsButton(owner.interaction);
  assert.equal(posts.length, 1);
  const pointer = posts[0].m;
  assert.ok(pointer.content.startsWith(`<@${STAFF}> Dean approved your kc-ops access (8 h).`));
  assert.ok(!pointer.content.includes("ops.example.test") && !pointer.content.includes("SECRETTOKEN"));
  assert.deepEqual(buttonIds(pointer), ["kcops:link:42"]);
  assert.deepEqual(pointer.allowedMentions, { parse: [], users: [STAFF] });
  noStaffDm(dms);
  // someone else presses it
  const nosy = fakeInteraction(client, "3003", { customId: "kcops:link:42" });
  await k.handleKcopsButton(nosy.interaction);
  assert.deepEqual(nosy.calls.deferReply, [{ flags: MessageFlags.Ephemeral }]);
  assert.match(text(nosy.calls.edits[0]), /for someone else/);
  // the requester presses it
  const staff = fakeInteraction(client, STAFF, { customId: "kcops:link:42" });
  await k.handleKcopsButton(staff.interaction);
  assert.deepEqual(staff.calls.deferReply, [{ flags: MessageFlags.Ephemeral }]);
  assert.ok(text(staff.calls.edits[0]).includes("#FRESH"));
  assert.deepEqual(seen.filter((s) => s.path === "/internal/link").map((s) => s.body), [
    { request_id: 42, discord_id: "3003" }, { request_id: 42, discord_id: STAFF }]);
  assert.equal(posts.length, 1);
  noStaffDm(dms);
});

test("sign-in confirmation for staff: private follow-up with It's me / Not me when an interaction is open", async () => {
  const { client, dms, posts } = fakeClient();
  gateStub({
    "/internal/access": () => ({ kind: "link", url: LINK, minutes: 60 }),
    "/internal/outbox": () => ({ items: [{ id: 4, target: "user", discord_id: STAFF, kind: "login_confirm", text: "Is this you signing in to kc-ops?", payload: { login_id: 77 }, age: 2, deliver: "private" }] }),
    "/internal/outbox/ack": () => ({ ok: true }),
  });
  const staff = fakeInteraction(client, STAFF);
  await k.handleAccess(staff.interaction);
  assert.equal(await k.deliverOutbox(client), 1);
  const f = staff.calls.followUps[0];
  assert.equal(f.flags, MessageFlags.Ephemeral);
  assert.equal(f.content, "Is this you signing in to kc-ops?");
  assert.deepEqual(buttonIds(f), ["kcops:login:77:yes", "kcops:login:77:no"]);
  assert.equal(dms.length + posts.length, 0);
});

test("no open interaction: pointer, then Show details shows the confirmation or notice only to its person", async () => {
  const { client, dms, posts } = fakeClient();
  const acked: any[] = [];
  gateStub({
    "/internal/outbox": () => ({ items: [
      { id: 4, target: "user", discord_id: STAFF, kind: "login_confirm", text: "Is this you? From 198.51.100.23", payload: { login_id: 77 }, age: 2 },
      { id: 5, target: "user", discord_id: STAFF, kind: "notice", text: "Dean extended your kc-ops session.", payload: {}, age: 2 },
    ] }),
    "/internal/outbox/ack": (b) => { acked.push(b.ids); return { ok: true }; },
    "/internal/notice": (b) => (b.discord_id !== STAFF
      ? { kind: "refused", code: "not_yours", reason: "That message is for someone else, or it is no longer available." }
      : b.id === 4 ? { kind: "notice", item_kind: "login_confirm", text: "Is this you? From 198.51.100.23", payload: { login_id: 77 } }
        : { kind: "notice", item_kind: "notice", text: "Dean extended your kc-ops session.", payload: {} }),
  });
  assert.equal(await k.deliverOutbox(client), 2);
  assert.deepEqual(acked, [[4, 5]]);
  assert.deepEqual(posts.map((p) => buttonIds(p.m)), [["kcops:show:4"], ["kcops:show:5"]]);
  for (const p of posts) assert.ok(!/198\.51|extended/.test(p.m.content) && p.m.content.startsWith(`<@${STAFF}>`));
  noStaffDm(dms);
  const nosy = fakeInteraction(client, "3003", { customId: "kcops:show:4" });
  await k.handleKcopsButton(nosy.interaction);
  assert.match(text(nosy.calls.edits[0]), /for someone else/);
  assert.equal(nosy.calls.deleted, 0);
  const confirm = fakeInteraction(client, STAFF, { customId: "kcops:show:4" });
  await k.handleKcopsButton(confirm.interaction);
  assert.deepEqual(confirm.calls.deferReply, [{ flags: MessageFlags.Ephemeral }]);
  assert.equal(confirm.calls.edits[0].content, "Is this you? From 198.51.100.23");
  assert.deepEqual(buttonIds(confirm.calls.edits[0]), ["kcops:login:77:yes", "kcops:login:77:no"]);
  assert.equal(confirm.calls.deleted, 0); // stays until answered
  const notice = fakeInteraction(client, STAFF, { customId: "kcops:show:5" });
  await k.handleKcopsButton(notice.interaction);
  assert.equal(notice.calls.edits[0].content, "Dean extended your kc-ops session.");
  assert.equal(notice.calls.deleted, 1); // read: the pointer is removed
  noStaffDm(dms);
});

test("an expired interaction token falls back to the pointer; a failed post is retried, then dropped when too old", async () => {
  const { client, dms, posts } = fakeClient();
  let age = 5;
  const acked: any[] = [];
  gateStub({
    "/internal/outbox": () => ({ items: [{ id: 6, target: "user", discord_id: STAFF, kind: "notice", text: "n", payload: {}, age }] }),
    "/internal/outbox/ack": (b) => { acked.push(b.ids); return { ok: true }; },
  });
  k.rememberInteraction(STAFF, { followUp: async () => { throw new Error("Unknown Webhook"); } });
  assert.equal(await k.deliverOutbox(client), 1);
  assert.deepEqual(buttonIds(posts[0].m), ["kcops:show:6"]);
  k.rememberInteraction(STAFF, { followUp: async () => { throw new Error("never used"); } }, Date.now() - k.FOLLOWUP_MS - 1000);
  assert.equal(await k.deliverOutbox(client), 1); // too old to follow up: pointer again, no attempt
  const down = fakeClient({ channelFails: true });
  assert.equal(await k.deliverOutbox(down.client), 0); // Discord refused: left for the next poll
  age = 901;
  assert.equal(await k.deliverOutbox(down.client), 1); // too old: dropped rather than retried forever
  noStaffDm([...dms, ...down.dms]);
});

test("messages for the owner as a person still go to his DM", async () => {
  const { client, dms, posts } = fakeClient();
  gateStub({
    "/internal/outbox": () => ({ items: [{ id: 7, target: "user", discord_id: OWNER, kind: "login_confirm", text: "Is this you?", payload: { login_id: 5 }, age: 1, deliver: "dm" }] }),
    "/internal/outbox/ack": () => ({ ok: true }),
  });
  assert.equal(await k.deliverOutbox(client), 1);
  assert.equal(dms[0].id, OWNER);
  assert.deepEqual(buttonIds(dms[0].m), ["kcops:login:5:yes", "kcops:login:5:no"]);
  assert.equal(posts.length, 0);
});

test("a gate that asks for a DM to a non-owner is not obeyed", async () => {
  const { client, dms, posts } = fakeClient();
  gateStub({
    "/internal/outbox": () => ({ items: [{ id: 8, target: "user", discord_id: STAFF, kind: "notice", text: "x", payload: {}, age: 1, deliver: "dm" }] }),
    "/internal/outbox/ack": () => ({ ok: true }),
  });
  await k.deliverOutbox(client);
  noStaffDm(dms);
  assert.equal(posts.length, 1);
});

function fakeMessage(client: any, o: { author: string; content: string; guildId?: string | null; channelId?: string; bot?: boolean }) {
  const replies: any[] = [];
  const message: any = {
    client,
    author: { id: o.author, bot: o.bot ?? false },
    content: o.content,
    guildId: o.guildId === undefined ? "1" : o.guildId,
    channelId: o.channelId ?? "300000",
    reply: async (m: any) => replies.push(m),
  };
  return { message, replies };
}

test("owner DMs the bot 'access': the link comes back in the DM and nothing is posted or announced", async () => {
  const { client, dms, posts } = fakeClient();
  const seen = gateStub({ "/internal/access": () => ({ kind: "link", url: LINK, minutes: 480 }) });
  const { message, replies } = fakeMessage(client, { author: OWNER, content: "access 480", guildId: null, channelId: "dm-1" });
  await k.handleKcopsMessage(message);
  assert.deepEqual(seen[0].body, { discord_id: OWNER, channel_id: "dm-1", is_member: true, minutes: 480, owner_dm: true });
  assert.ok(replies[0].content.includes(LINK));
  assert.equal(posts.length + dms.length, 0);
});

test("a DM from anyone else is never answered and never reaches the gate", async () => {
  const { client, dms, posts } = fakeClient();
  const seen = gateStub({});
  for (const content of ["access", "/access 60", "hello", "give me the link"]) {
    const { message, replies } = fakeMessage(client, { author: STAFF, content, guildId: null, channelId: "dm-2" });
    await k.handleKcopsMessage(message);
    assert.equal(replies.length, 0);
  }
  assert.equal(seen.length + dms.length + posts.length, 0);
});

test("typing a request in the access channel gets a public hint without a link, once a minute; other channels and bots are ignored", async () => {
  const { client } = fakeClient();
  const seen = gateStub({});
  const first = fakeMessage(client, { author: STAFF, content: "can I get access please?" });
  await k.handleKcopsMessage(first.message);
  assert.match(first.replies[0].content, /run `\/access` here/);
  assert.ok(!/https?:\/\//.test(first.replies[0].content));
  const again = fakeMessage(client, { author: STAFF, content: "link?" });
  await k.handleKcopsMessage(again.message);
  assert.equal(again.replies.length, 0);
  for (const m of [
    fakeMessage(client, { author: "3003", content: "need access", channelId: "999" }),
    fakeMessage(client, { author: "3003", content: "good morning" }),
    fakeMessage(client, { author: "3003", content: "need access", bot: true }),
  ]) {
    await k.handleKcopsMessage(m.message);
    assert.equal(m.replies.length, 0);
  }
  assert.equal(seen.length, 0);
});

test("/kc panel posts the Request access button (owner only)", async () => {
  const { client, posts } = fakeClient();
  gateStub({});
  const owner = fakeInteraction(client, OWNER);
  await k.handleKc(owner.interaction);
  assert.deepEqual(buttonIds(posts[0].m), ["kcops:request"]);
  assert.equal(text(owner.calls.edits[0]), "Posted the Request access button.");
  const staff = fakeInteraction(client, STAFF);
  await k.handleKc(staff.interaction);
  assert.equal(posts.length, 1);
  assert.equal(text(staff.calls.edits[0]), "Only Dean can do that.");
});

test("new button ids parse strictly", () => {
  assert.deepEqual(k.parseButton("kcops:request"), { type: "request" });
  assert.deepEqual(k.parseButton("kcops:link:42"), { type: "link", requestId: 42 });
  assert.deepEqual(k.parseButton("kcops:show:7"), { type: "show", outboxId: 7 });
  for (const bad of ["kcops:request:1", "kcops:link:", "kcops:link:x", "kcops:show:1:2", "kcops:link:1234567890123456789"]) {
    assert.equal(k.parseButton(bad), null, bad);
  }
});

test("every kind of outbox item, every route: no DM ever goes to a non-owner", async () => {
  const kinds = ["notice", "login_confirm", "info", "security", "audit", "approve_person", "session_extension", "elevation",
    "announce", "platform_approval", "platform_audit", "something_new"];
  const targets = ["user", "owner", "audit", "channel"];
  const items: any[] = [];
  let id = 100;
  for (const target of targets) for (const kind of kinds) for (const discord_id of [STAFF, OWNER, null]) {
    items.push({ id: id++, target, discord_id, kind, text: `t${id}`, age: 1,
      payload: { login_id: 1, extension_id: 2, elevation_id: 3, minutes: 60, discord_id: STAFF } });
  }
  for (const route of ["both", "channel", "dm"]) for (const channelFails of [false, true]) for (const remembered of [false, true]) {
    k.forgetInteractionsForTests();
    const { client, dms } = fakeClient({ channelFails });
    if (remembered) k.rememberInteraction(STAFF, { followUp: async () => {} });
    gateStub({ "/internal/outbox": () => ({ items, approval_route: route }), "/internal/outbox/ack": () => ({ ok: true }) });
    await k.deliverOutbox(client);
    noStaffDm(dms);
  }
});

test("the module has exactly one place that sends a direct message, and it names the owner", () => {
  const src = readFileSync(new URL("../src/kcops/discord.ts", import.meta.url), "utf8");
  const fetches = src.match(/users\.fetch\(.*\);/g) ?? [];
  assert.deepEqual(fetches, ["users.fetch(env().KCOPS_OWNER_USER_ID!);"]);
  assert.ok(!/createDM|\.dmChannel|user\.send\(/.test(src));
});
