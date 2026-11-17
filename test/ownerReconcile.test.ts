import { test } from "node:test";
import assert from "node:assert/strict";

// sync.ts (and its imports) read env at load time, set a minimal valid env first.
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

const { reconcileOwnerId } = await import("../src/services/sync.ts");

test("assignment: fresh read stale-unassigned, webhook shows owner -> trust webhook (keep name)", () => {
  assert.equal(reconcileOwnerId(0, 42), 42);
  assert.equal(reconcileOwnerId(1, 42), 42);
  assert.equal(reconcileOwnerId(undefined, 42), 42);
});
test("both agree assigned -> keep that owner", () => {
  assert.equal(reconcileOwnerId(42, 42), 42);
  assert.equal(reconcileOwnerId(7, 42), 7);
});
test("genuine unassignment -> treated as unassigned (<=1), name stripped correctly", () => {
  assert.equal(reconcileOwnerId(0, 0), 0);
  assert.ok(reconcileOwnerId(1, 0) <= 1);          // 1 = system; downstream treats <=1 as no owner
  assert.equal(reconcileOwnerId(undefined, undefined), 0);
});
test("unrelated update while assigned (fresh shows owner, webhook 0) -> keep fresh owner", () => {
  assert.equal(reconcileOwnerId(42, 0), 42);
});
