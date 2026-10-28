// Covers the /debug/* gate: the routes exist only when DEBUG_TOKEN is set and
// then answer 401 without the right bearer token. Only /debug/summary is hit
// with a valid token; it reads the local DB and never reaches Zammad or Discord.
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

const { loadEnv } = await import("../src/util/env.js");
loadEnv();

const Fastify = (await import("fastify")).default;
const { registerDebugRoutes } = await import("../src/web/routes/debug.js");

const TOKEN = "test-debug-token";

async function build(token: string | undefined) {
  const app = Fastify({ logger: false });
  // The client is only used by /debug/threads, which no test calls.
  registerDebugRoutes(app, {} as any, token);
  await app.ready();
  return app;
}

const off = await build(undefined);
const blank = await build("   ");
const on = await build(TOKEN);
after(() => Promise.all([off.close(), blank.close(), on.close()]));

test("debug routes are not registered without DEBUG_TOKEN", async () => {
  for (const app of [off, blank]) {
    assert.equal((await app.inject({ method: "GET", url: "/debug/summary" })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/debug/threads" })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/debug/settings/keepalive", payload: { hour: 3 } })).statusCode, 404);
  }
});

test("debug routes reject a missing or wrong bearer token", async () => {
  const cases: Record<string, string>[] = [
    {},
    { authorization: "Bearer wrong" },
    { authorization: `Basic ${TOKEN}` },
    { authorization: "Bearer " },
  ];
  for (const headers of cases) {
    for (const [method, url] of [["GET", "/debug/summary"], ["GET", "/debug/threads"], ["POST", "/debug/keepalive"], ["POST", "/debug/settings/keepalive"]] as const) {
      const res = await on.inject({ method, url, headers });
      assert.equal(res.statusCode, 401, `${method} ${url} with ${JSON.stringify(headers)}`);
    }
  }
});

test("debug routes answer with the right bearer token", async () => {
  const { initDb } = await import("../src/db/index.js");
  initDb(":memory:");
  const res = await on.inject({ method: "GET", url: "/debug/summary", headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().total, 0);
});
