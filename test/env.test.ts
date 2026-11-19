import test from "node:test";
import assert from "node:assert/strict";
import { parseEnv, withoutBlanks } from "../src/util/env.js";

const required = {
  DISCORD_TOKEN: "t",
  DISCORD_CLIENT_ID: "1",
  DISCORD_GUILD_ID: "2",
  DISCORD_TICKETS_CHANNEL_ID: "3",
  ZAMMAD_BASE_URL: "http://zammad:8080",
  ZAMMAD_API_TOKEN: "z",
  ZAMMAD_WEBHOOK_SECRET: "s",
};

test("blank optional variables count as unset", () => {
  const r = parseEnv({
    ...required,
    DISCORD_TICKET_ROLE_ID: "",
    AI_API_KEY: "",
    AI_BASE_URL: " ",
    AI_FALLBACK_PROVIDER: "",
    SEARCH_FALLBACK_PROVIDER: "",
    DAILY_SUMMARY_HOUR: "",
    ADMIN_USER_IDS: "",
  });
  assert.equal(r.success, true);
  if (!r.success) return;
  assert.equal(r.data.DAILY_SUMMARY_HOUR, undefined, "a blank hour must not become hour 0");
  assert.equal(r.data.AI_API_KEY, undefined);
  assert.equal(r.data.AI_PROVIDER, "openrouter");
  assert.deepEqual(r.data.ADMIN_USER_IDS, []);
});

test("a blank required variable is still an error", () => {
  const r = parseEnv({ ...required, ZAMMAD_WEBHOOK_SECRET: "" });
  assert.equal(r.success, false);
});

test("withoutBlanks keeps real values", () => {
  assert.deepEqual(withoutBlanks({ A: "x", B: "", C: undefined, D: "0" }), { A: "x", D: "0" });
});
