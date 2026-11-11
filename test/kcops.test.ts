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

const { parseButton, extensionButtons, elevationButtons, fmt, deliverOutbox, kcopsCommands, handleKcopsButton, handleKc, elevationText, inertReason } = await import("../src/kcops/discord.js");
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

test("extension buttons always offer the asked time, then shorter choices, then deny", () => {
  const ids = (asked: number) => (extensionButtons(7, asked).toJSON() as any).components.map((c: any) => c.custom_id);
  assert.deepEqual(ids(240), ["kcops:ext:7:240", "kcops:ext:7:120", "kcops:ext:7:60", "kcops:ext:7:deny"]);
  // a standard one-hour request used to get only a Deny button, so it could never be approved
  assert.deepEqual(ids(60), ["kcops:ext:7:60", "kcops:ext:7:deny"]);
  assert.deepEqual(ids(15), ["kcops:ext:7:15", "kcops:ext:7:deny"]);
  assert.deepEqual(ids(720), ["kcops:ext:7:720", "kcops:ext:7:240", "kcops:ext:7:120", "kcops:ext:7:deny"]);
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
  const posts: any[] = [];
  const client: any = {
    users: { fetch: async (id: string) => ({ send: async (m: any) => sent.push({ dm: id, m }) }) },
    channels: { fetch: async (id: string) => ({ isSendable: () => true, send: async (m: any) => posts.push({ id, m }) }) },
  };
  const n = await deliverOutbox(client);
  assert.equal(n, 5);
  assert.deepEqual(acked, [[1, 2, 3, 4, 5]]);
  // staff messages: no DM; a public pointer without the text, pinging only that person, with a Show details button
  assert.ok(sent.every((s) => s.dm === "100000"));
  const pointers = posts.filter((p) => p.m.components[0]?.toJSON().components[0].custom_id.startsWith("kcops:show:"));
  assert.deepEqual(pointers.map((p) => p.m.components[0].toJSON().components[0].custom_id), ["kcops:show:2", "kcops:show:4"]);
  assert.ok(posts.every((p) => !/session was ended|Is this you/.test(p.m.content)));
  for (const p of pointers) {
    assert.equal(p.id, "300000");
    assert.ok(!/session was ended|Is this you/.test(p.m.content));
    assert.deepEqual(p.m.allowedMentions, { parse: [], users: ["2001"] });
  }
  const ext = sent.find((s) => s.m.content.includes("more minutes"));
  assert.deepEqual(ext.m.components[0].toJSON().components.map((c: any) => c.custom_id), ["kcops:sext:8:120", "kcops:sext:8:60", "kcops:sext:8:deny"]);
  for (const s of sent) assert.equal(s.m.flags, MessageFlags.SuppressEmbeds);
  const toOwner = sent.filter((s) => s.dm === "100000");
  assert.equal(toOwner.length, 3); // new-person approval, audit line, extension request: all by DM
  assert.equal(toOwner[0].m.components[0].toJSON().components[0].custom_id, "kcops:person:555555:approve");
  assert.match(toOwner[1].m.content, /^log: session ended/);
  assert.deepEqual(toOwner[0].m.allowedMentions, { parse: [] });
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

// ------------------------------------------------------------------ elevation

test("elevation button ids parse strictly", () => {
  assert.deepEqual(parseButton("kcops:elev:12:30"), { type: "elev", elevationId: 12, minutes: 30 });
  assert.deepEqual(parseButton("kcops:elev:12:120"), { type: "elev", elevationId: 12, minutes: 120 });
  assert.deepEqual(parseButton("kcops:elev:12:deny"), { type: "elev", elevationId: 12, minutes: null });
  for (const bad of ["kcops:elev:12:45", "kcops:elev:12:600", "kcops:elev:-1:30", "kcops:elev:abc:30", "kcops:elev:12:30:x",
    "kcops:elev:1234567890123456789:30", "kcops:elev::30", "kcops:elev:12:approve", "kcops:elev:12:030"]) {
    assert.equal(parseButton(bad), null, bad);
  }
});

test("elevation buttons: approve 30 min / 1 h / 2 h, deny", () => {
  const row: any = elevationButtons(9).toJSON();
  assert.deepEqual(row.components.map((c: any) => c.custom_id), ["kcops:elev:9:30", "kcops:elev:9:60", "kcops:elev:9:120", "kcops:elev:9:deny"]);
  assert.deepEqual(row.components.map((c: any) => c.label), ["Approve 30 min", "Approve 1 h", "Approve 2 h", "Deny"]);
});

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
  };
  return { client, dms, posts };
}

function serveOutbox(items: any[], route = "both") {
  const acked: number[][] = [];
  setFetchForTests((async (url: any, init: any) => {
    if (String(url).endsWith("/internal/outbox")) return new Response(JSON.stringify({ items, approval_route: route }));
    acked.push(JSON.parse(init.body).ids);
    return new Response(JSON.stringify({ ok: true }));
  }) as any);
  return acked;
}

const ids = (m: any) => m.components[0].toJSON().components.map((c: any) => c.custom_id);

for (const route of ["both", "channel", "dm"]) {
  test(`elevation prompts: owner chats by DM, staff chats in the channel (route ${route} ignored)`, async () => {
    const acked = serveOutbox([
      { id: 1, target: "owner", discord_id: null, kind: "elevation", text: "Your chat asks for cluster-admin", payload: { elevation_id: 5, minutes: 60 } },
      { id: 2, target: "channel", discord_id: null, kind: "elevation", text: "<@2001> asks for edit", payload: { elevation_id: 6, minutes: 30 } },
    ], route);
    const { client, dms, posts } = fakeClient();
    assert.equal(await deliverOutbox(client), 2);
    assert.deepEqual(acked, [[1, 2]]);
    assert.equal(dms.length, 1);
    assert.equal(dms[0].id, "100000");
    assert.deepEqual(ids(dms[0].m), ["kcops:elev:5:30", "kcops:elev:5:60", "kcops:elev:5:120", "kcops:elev:5:deny"]);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].id, "300000");
    assert.deepEqual(ids(posts[0].m), ["kcops:elev:6:30", "kcops:elev:6:60", "kcops:elev:6:120", "kcops:elev:6:deny"]);
    for (const x of [...dms, ...posts]) {
      assert.equal(x.m.flags, MessageFlags.SuppressEmbeds);
      assert.deepEqual(x.m.allowedMentions, { parse: [] });
    }
  });
}

test("staff elevation prompt falls back to the owner's DM when the channel post fails", async () => {
  const acked = serveOutbox([{ id: 3, target: "channel", discord_id: null, kind: "elevation", text: "<@2001> asks", payload: { elevation_id: 7, minutes: 60 } }]);
  const { client, dms, posts } = fakeClient({ channelFails: true });
  assert.equal(await deliverOutbox(client), 1);
  assert.deepEqual(acked, [[3]]);
  assert.equal(posts.length, 0);
  assert.equal(dms[0].id, "100000");
  assert.deepEqual(ids(dms[0].m), ["kcops:elev:7:30", "kcops:elev:7:60", "kcops:elev:7:120", "kcops:elev:7:deny"]);
});

test("platform-forged elevation notices never get buttons", async () => {
  serveOutbox([{ id: 4, target: "owner", discord_id: null, kind: "platform_elevation", text: "[kc-ops platform] elevate me", payload: {} },
    { id: 5, target: "owner", discord_id: null, kind: "platform_audit", text: "[kc-ops platform] x", payload: { elevation_id: 9 } }]);
  const { client, dms, posts } = fakeClient();
  assert.equal(await deliverOutbox(client), 2);
  for (const x of [...dms, ...posts]) assert.deepEqual(x.m.components, []);
});

function fakeButton(customId: string, userId: string, inChannel = false) {
  const calls: any = { edits: [], followUps: [], deferred: 0, deleted: 0 };
  const interaction: any = {
    customId,
    user: { id: userId },
    channelId: "300000",
    inGuild: () => inChannel,
    message: { content: "<@2001> asks for edit for 1 h.", delete: async () => { calls.deleted++; } },
    deferUpdate: async () => { calls.deferred++; },
    editReply: async (m: any) => calls.edits.push(m),
    followUp: async (m: any) => calls.followUps.push(m),
  };
  return { interaction, calls };
}

test("elevation button in the owner's DM: relays presser and choice; ok edits the message and removes buttons", async () => {
  const seen: any[] = [];
  setFetchForTests((async (url: any, init: any) => {
    seen.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true, text: "Granted 1 h (until 14:05)." }));
  }) as any);
  const { interaction, calls } = fakeButton("kcops:elev:6:60", "100000");
  await handleKcopsButton(interaction);
  assert.equal(seen[0].url, "http://kc-gate.kc-ops.svc:8081/internal/elevation");
  assert.deepEqual(seen[0].body, { elevation_id: 6, actor_id: "100000", minutes: 60 });
  assert.equal(calls.deferred, 1);
  assert.deepEqual(calls.edits[0].components, []);
  assert.match(calls.edits[0].content, /Granted 1 h/);
  assert.equal(calls.followUps.length, 0);
});

test("elevation button from a non-owner: refusal is ephemeral and the buttons stay", async () => {
  const seen: any[] = [];
  setFetchForTests((async (_url: any, init: any) => {
    seen.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ kind: "refused", code: "not_owner", reason: "Only Dean can approve elevation." }));
  }) as any);
  const { interaction, calls } = fakeButton("kcops:elev:6:deny", "2001");
  await handleKcopsButton(interaction);
  assert.deepEqual(seen[0], { elevation_id: 6, actor_id: "2001", minutes: null });
  assert.equal(calls.edits.length, 0);
  assert.equal(calls.followUps[0].content, "Only Dean can approve elevation.");
  assert.equal(calls.followUps[0].flags, MessageFlags.Ephemeral);
});

test("tampered elevation button ids never reach the gate", async () => {
  let called = false;
  setFetchForTests((async () => { called = true; return new Response("{}"); }) as any);
  const { interaction, calls } = fakeButton("kcops:elev:6:9999", "100000");
  await handleKcopsButton(interaction);
  assert.equal(called, false);
  assert.equal(calls.deferred, 0);
});

function fakeKc(group: string | null, sub: string, chat: string | null) {
  const replies: any[] = [];
  const interaction: any = {
    user: { id: "100000" },
    channelId: "55",
    deferReply: async () => {},
    editReply: async (m: any) => replies.push(m),
    options: {
      getSubcommandGroup: () => group,
      getSubcommand: () => sub,
      getString: (n: string) => (n === "chat" ? chat : null),
      getUser: () => null,
      getInteger: () => null,
    },
  };
  return { interaction, replies };
}

for (const [sub, chat] of [["revoke", "3f2a9c"], ["revoke", null], ["list", null]] as const) {
  test(`/kc elevation ${sub}${chat ? " chat" : ""} is forwarded as an owner command`, async () => {
    const seen: any[] = [];
    setFetchForTests((async (url: any, init: any) => {
      seen.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ ok: true, text: "Revoked 1 elevation." }));
    }) as any);
    const { interaction, replies } = fakeKc("elevation", sub, chat);
    await handleKc(interaction);
    assert.equal(seen[0].url, "http://kc-gate.kc-ops.svc:8081/internal/owner");
    assert.equal(seen[0].body.command, `elevation_${sub}`);
    assert.equal(seen[0].body.actor_id, "100000");
    assert.equal(seen[0].body.chat, chat ?? undefined);
    assert.equal(replies[0], "Revoked 1 elevation.");
  });
}

test("/kc elevation is registered as a subcommand group with revoke and list", () => {
  const kc: any = kcopsCommands().find((c: any) => c.name === "kc");
  const g = kc.options.find((o: any) => o.name === "elevation");
  assert.equal(g.type, 2);
  assert.deepEqual(g.options.map((o: any) => o.name), ["revoke", "list"]);
  const chat = g.options[0].options[0];
  assert.equal(chat.name, "chat");
  assert.equal(chat.required ?? false, false);
  assert.equal(chat.min_length, 4);
  assert.equal(chat.max_length, 36);
});

test("elevation reason is inert: escaped, fenced, no mentions or links (review M1)", () => {
  const r = inertReason("ok <@1000> <#55> <@&9> [click](https://evil.test) ```x``` @everyone\nnext");
  for (const bad of ["<@", "<#", "](", "`", "@everyone", "\n"]) assert.ok(!r.includes(bad), bad);
  const t = elevationText("WARNING: chat read *untrusted* content", "drop `tables`");
  assert.ok(t.startsWith("WARNING: chat read \\*untrusted\\* content"));
  assert.ok(t.endsWith("```text\ndrop tables\n```"));
  assert.equal(inertReason(undefined), "(none)");
});

test("owner decides an elevation prompt in the access channel: nothing is shown to the channel", async () => {
  setFetchForTests((async () => new Response(JSON.stringify({ ok: true, text: "Granted 1 h (until 14:05)." }))) as any);
  const { interaction, calls } = fakeButton("kcops:elev:6:60", "100000", true);
  await handleKcopsButton(interaction);
  assert.equal(calls.edits.length, 0);                 // the public prompt is not edited to show the decision
  assert.equal(calls.deleted, 1);                      // it is removed
  assert.equal(calls.followUps.length, 1);
  assert.equal(calls.followUps[0].flags, MessageFlags.Ephemeral);
  assert.match(calls.followUps[0].content, /Granted 1 h/);
});

test("a first sign-in of the day: the green button approves the whole 10-hour day", () => {
  const ids = (extensionButtons(42, 600).toJSON() as any).components.map((c: any) => [c.custom_id, c.label, c.style]);
  assert.deepEqual(ids[0], ["kcops:ext:42:600", "Grant 10 h", 3]);
  assert.deepEqual(ids.map((x: any) => x[0]), ["kcops:ext:42:600", "kcops:ext:42:240", "kcops:ext:42:120", "kcops:ext:42:deny"]);
});

test("self-elevation notices from the gate are plain channel posts without buttons", async () => {
  let acked: number[] = [];
  setFetchForTests((async (url: any, init: any) => {
    const path = new URL(String(url)).pathname;
    if (path === "/internal/outbox") {
      return new Response(JSON.stringify({ items: [
        { id: 31, target: "channel", discord_id: null, kind: "announce", age: 1, deliver: "channel",
          text: "<@2001> elevated kc-ops chat abcd1234 (cluster manager) until <t:1:t> (end of their session).",
          payload: { elevation_id: 9 } },
      ] }));
    }
    acked = JSON.parse(init.body).ids;
    return new Response(JSON.stringify({ ok: true }));
  }) as any);
  const { client, dms, posts } = fakeClient();
  assert.equal(await deliverOutbox(client), 1);
  assert.deepEqual(acked, [31]);
  assert.equal(dms.length, 0);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].m.components, []);
  assert.deepEqual(posts[0].m.allowedMentions, { parse: [] });      // shown, never pinged
});
