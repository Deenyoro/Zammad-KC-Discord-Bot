// Covers the Zammad webhook authentication gate (HMAC-SHA1 over the raw body).
// Only paths that are rejected before any work is enqueued are exercised, so
// nothing here reaches Zammad or Discord.
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "fatal";
Object.assign(process.env, {
  DISCORD_TOKEN: "test-token",
  DISCORD_CLIENT_ID: "1",
  DISCORD_GUILD_ID: "1",
  DISCORD_TICKETS_CHANNEL_ID: "1",
  ZAMMAD_BASE_URL: "http://127.0.0.1:9",
  ZAMMAD_API_TOKEN: "test-api-token",
  ZAMMAD_WEBHOOK_SECRET: "test-webhook-secret",
});

import { test, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

const { loadEnv } = await import("../src/util/env.js");
loadEnv();

const Fastify = (await import("fastify")).default;
const rawBody = (await import("fastify-raw-body")).default;
const { registerZammadRoutes } = await import("../src/web/routes/zammad.js");

const SECRET = "test-webhook-secret";
const sign = (body: string, secret = SECRET) =>
  crypto.createHmac("sha1", secret).update(body, "utf8").digest("hex");

// Same raw-body setup as src/web/server.ts
const app = Fastify({ logger: false });
await app.register(rawBody, { field: "rawBody", global: true, encoding: "utf8", runFirst: true });
// The client is only used after a request is accepted and enqueued, which no test does.
registerZammadRoutes(app, {} as any);
await app.ready();
after(() => app.close());

const post = (body: string, headers: Record<string, string> = {}) =>
  app.inject({
    method: "POST",
    url: "/webhooks/zammad",
    payload: body,
    headers: { "content-type": "application/json", ...headers },
  });

// Valid signature, but no ticket id: passes auth and is rejected before enqueue.
const noTicket = JSON.stringify({ article: { id: 1 } });

test("rejects requests without a signature header", async () => {
  const res = await post(noTicket);
  assert.equal(res.statusCode, 401);
});

test("rejects requests with a wrong signature", async () => {
  const res = await post(noTicket, { "x-hub-signature": `sha1=${sign(noTicket, "other-secret")}` });
  assert.equal(res.statusCode, 401);
});

test("rejects a signature computed over a different body", async () => {
  const res = await post(noTicket, { "x-hub-signature": `sha1=${sign(noTicket + " ")}` });
  assert.equal(res.statusCode, 401);
});

test("rejects a truncated signature without throwing", async () => {
  const res = await post(noTicket, { "x-hub-signature": `sha1=${sign(noTicket).slice(0, 10)}` });
  assert.equal(res.statusCode, 401);
});

test("accepts a valid sha1= prefixed signature (then 400 for missing ticket)", async () => {
  const res = await post(noTicket, { "x-hub-signature": `sha1=${sign(noTicket)}` });
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.json(), { ok: false, error: "Missing ticket data" });
});

test("accepts a valid bare-hex signature (then 400 for missing ticket)", async () => {
  const res = await post(noTicket, { "x-hub-signature": sign(noTicket) });
  assert.equal(res.statusCode, 400);
});
