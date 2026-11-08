// kc-ops access module: button parsing, gate client, outbox delivery (fake Discord client, stubbed gate).
Object.assign(process.env, {
  KCOPS_GATE_URL: "http://kc-gate.kc-ops.svc:8081",
  KCOPS_GATE_TOKEN: "x".repeat(40),
  KCOPS_OWNER_USER_ID: "100000",
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
  assert.deepEqual(parseButton("kcops:ext:42:60"), { type: "ext", requestId: 42, minutes: 60 });
  assert.deepEqual(parseButton("kcops:ext:42:deny"), { type: "ext", requestId: 42, minutes: null });
  assert.deepEqual(parseButton("kcops:person:123456789012:approve"), { type: "person", discordId: "123456789012", action: "approve" });
  for (const bad of ["kcops:ext:42:60:x", "kcops:ext:abc:60", "kcops:person:1:approve", "kcops:person:123456789012:delete", "other"]) {
    assert.equal(parseButton(bad), null, bad);
  }
});

test("extension buttons offer asked time, 1 h, deny", () => {
  const row: any = extensionButtons(7, 120).toJSON();
  assert.deepEqual(row.components.map((c: any) => c.custom_id), ["kcops:ext:7:120", "kcops:ext:7:60", "kcops:ext:7:deny"]);
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
  ];
  setFetchForTests((async (url: any, init: any) => {
    if (String(url).endsWith("/internal/outbox")) return new Response(JSON.stringify({ items }));
    acked.push(JSON.parse(init.body).ids);
    return new Response(JSON.stringify({ ok: true }));
  }) as any);
  const sent: any[] = [];
  const client: any = { users: { fetch: async (id: string) => ({ send: async (m: any) => sent.push({ dm: id, m }) }) } };
  const n = await deliverOutbox(client);
  assert.equal(n, 3);
  assert.deepEqual(acked, [[1, 2, 3]]);
  for (const s of sent) assert.equal(s.m.flags, MessageFlags.SuppressEmbeds);
  const toOwner = sent.filter((s) => s.dm === "100000");
  assert.equal(toOwner.length, 2); // approval + audit log line, both by DM
  assert.equal(toOwner[0].m.components[0].toJSON().components[0].custom_id, "kcops:person:555555:approve");
  assert.match(toOwner[1].m.content, /^log: session ended/);
  assert.deepEqual(toOwner[0].m.allowedMentions, { parse: [] });
  assert.equal(sent.find((s) => s.dm === "2001").m.content, "Your session was ended");
});
