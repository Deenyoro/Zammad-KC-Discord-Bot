// kc-ops access module: button parsing, gate client, outbox delivery (fake Discord client, stubbed gate).
Object.assign(process.env, {
  KCOPS_GATE_URL: "http://kc-gate.kc-ops.svc:8081",
  KCOPS_GATE_TOKEN: "x".repeat(40),
  KCOPS_OWNER_USER_ID: "100000",
  KCOPS_ACCESS_CHANNEL_ID: "300000",
});
await import("./helpers.js");
import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageFlags } from "discord.js";

const { parseButton, extensionButtons, fmt, deliverOutbox, kcopsCommands } = await import("../src/kcops/discord.js");
const { gate, setFetchForTests, kcopsEnabled } = await import("../src/kcops/gate.js");

test("module is enabled and registers /access and /kc", () => {
  assert.equal(kcopsEnabled(), true);
  assert.deepEqual(kcopsCommands().map((c: any) => c.name), ["access", "kc"]);
});

test("button ids parse strictly", () => {
  assert.deepEqual(parseButton("kcops:login:9:yes"), { type: "login", loginId: 9, answer: "yes" });
  assert.deepEqual(parseButton("kcops:sext:5:deny"), { type: "sext", extensionId: 5, minutes: null });
  assert.equal(parseButton("kcops:login:9:maybe"), null);
  assert.deepEqual(parseButton("kcops:ext:42:60"), { type: "ext", requestId: 42, minutes: 60 });
  assert.deepEqual(parseButton("kcops:ext:42:deny"), { type: "ext", requestId: 42, minutes: null });
  assert.deepEqual(parseButton("kcops:person:123456789012:approve"), { type: "person", discordId: "123456789012", action: "approve" });
  for (const bad of ["kcops:ext:42:60:x", "kcops:ext:abc:60", "kcops:person:1:approve", "kcops:person:123456789012:delete", "other"]) {
    assert.equal(parseButton(bad), null, bad);
  }
});

test("extension buttons offer asked time, 2 h, deny", () => {
  const row: any = extensionButtons(7, 240).toJSON();
  assert.deepEqual(row.components.map((c: any) => c.custom_id), ["kcops:ext:7:240", "kcops:ext:7:120", "kcops:ext:7:deny"]);
  assert.equal(fmt(90), "90 min");
  assert.equal(fmt(240), "4 h");
});

test("gate client sends bearer token, JSON, no redirects", async () => {
  const seen: any[] = [];
  setFetchForTests((async (url: any, init: any) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({ kind: "refused", code: "wrong_channel", reason: "Use /access in the access channel." }), { status: 200 });
  }) as any);
  const r = await gate.access({ discord_id: "2001", channel_id: "99", is_member: true, minutes: null });
  assert.equal(r.kind, "refused");
  assert.equal(seen[0].url, "http://kc-gate.kc-ops.svc:8081/internal/access");
  assert.equal(seen[0].init.headers.authorization, `Bearer ${"x".repeat(40)}`);
  assert.equal(seen[0].init.redirect, "error");
});

test("gate errors throw without echoing bodies", async () => {
  setFetchForTests((async () => new Response("secret stuff", { status: 401 })) as any);
  await assert.rejects(gate.outbox(), (e: any) => /returned 401/.test(e.message) && !/secret/.test(e.message));
});

test("outbox delivery: embeds suppressed, buttons for new people, only delivered items acked", async () => {
  const acked: number[][] = [];
  const items = [
    { id: 1, target: "owner", discord_id: null, kind: "approve_person", text: "New person <@555555>", payload: { discord_id: "555555" } },
    { id: 2, target: "user", discord_id: "2001", kind: "notice", text: "Your session was ended", payload: {} },
    { id: 3, target: "audit", discord_id: null, kind: "audit", text: "session ended", payload: {} },
    { id: 4, target: "user", discord_id: "2001", kind: "login_confirm", text: "Is this you signing in to kc-ops?", payload: { login_id: 77 } },
    { id: 5, target: "owner", discord_id: null, kind: "session_extension", text: "<@2001> asks for 120 more minutes", payload: { extension_id: 8, minutes: 120 } },
  ];
  setFetchForTests((async (url: any, init: any) => {
    if (String(url).endsWith("/internal/outbox")) return new Response(JSON.stringify({ items }));
    acked.push(JSON.parse(init.body).ids);
    return new Response(JSON.stringify({ ok: true }));
  }) as any);
  const sent: any[] = [];
  const client: any = { users: { fetch: async (id: string) => ({ send: async (m: any) => sent.push({ dm: id, m }) }) } };
  const n = await deliverOutbox(client);
  assert.equal(n, 5);
  assert.deepEqual(acked, [[1, 2, 3, 4, 5]]);
  const confirm = sent.find((s) => s.m.content.startsWith("Is this you"));
  assert.deepEqual(confirm.m.components[0].toJSON().components.map((c: any) => c.custom_id), ["kcops:login:77:yes", "kcops:login:77:no"]);
  const ext = sent.find((s) => s.m.content.includes("more minutes"));
  assert.deepEqual(ext.m.components[0].toJSON().components.map((c: any) => c.custom_id), ["kcops:sext:8:120", "kcops:sext:8:60", "kcops:sext:8:deny"]);
  for (const s of sent) assert.equal(s.m.flags, MessageFlags.SuppressEmbeds);
  const toOwner = sent.filter((s) => s.dm === "100000");
  assert.equal(toOwner.length, 3); // new-person approval, audit line, extension request: all by DM
  assert.equal(toOwner[0].m.components[0].toJSON().components[0].custom_id, "kcops:person:555555:approve");
  assert.match(toOwner[1].m.content, /^log: session ended/);
  assert.deepEqual(toOwner[0].m.allowedMentions, { parse: [] });
  assert.equal(sent.find((s) => s.dm === "2001").m.content, "Your session was ended");
});

for (const route of ["both", "channel", "dm"] as const) {
  test(`approval route ${route}: approvals follow it, sign-in announcements go to the channel, alerts stay in DMs`, async () => {
    const items = [
      { id: 1, target: "owner", discord_id: null, kind: "approve_person", text: "New person <@555555>", payload: { discord_id: "555555" } },
      { id: 2, target: "owner", discord_id: null, kind: "security", text: "Someone pressed Not me", payload: {} },
      { id: 3, target: "channel", discord_id: null, kind: "announce", text: "<@2001> signed in to kc-ops until <t:1:t>.", payload: {} },
      { id: 4, target: "owner", discord_id: null, kind: "platform_approval", text: "[kc-ops platform] approve k8s change", payload: {} },
    ];
    setFetchForTests((async (url: any) => {
      if (String(url).endsWith("/internal/outbox")) return new Response(JSON.stringify({ items, approval_route: route }));
      return new Response(JSON.stringify({ ok: true }));
    }) as any);
    const dms: any[] = [];
    const posts: any[] = [];
    const client: any = {
      users: { fetch: async (id: string) => ({ send: async (m: any) => dms.push({ id, m }) }) },
      channels: { fetch: async (id: string) => ({ isSendable: () => true, send: async (m: any) => posts.push({ id, m }) }) },
    };
    assert.equal(await deliverOutbox(client), 4);
    const inChannel = posts.map((p) => p.m.content);
    const inDm = dms.map((d) => d.m.content);
    assert.ok(posts.every((p) => p.id === "300000"));
    assert.ok(inChannel.includes("<@2001> signed in to kc-ops until <t:1:t>."));
    assert.ok(inDm.includes("Someone pressed Not me") && !inChannel.includes("Someone pressed Not me"));
    for (const t of ["New person <@555555>", "[kc-ops platform] approve k8s change"]) {
      assert.equal(inChannel.includes(t), route !== "dm", `${t} in channel`);
      assert.equal(inDm.includes(t), route !== "channel", `${t} in DM`);
    }
    const person = [...posts, ...dms].find((x) => x.m.content.startsWith("New person"));
    assert.equal(person.m.components[0].toJSON().components[0].custom_id, "kcops:person:555555:approve");
    for (const x of [...posts, ...dms]) assert.deepEqual(x.m.allowedMentions, { parse: [] }); // mentions shown, never pinged
  });
}
