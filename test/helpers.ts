// Shared setup for tests that load modules needing env() or the SQLite db.
// Nothing here reaches Zammad or Discord.
process.env.NODE_ENV = "production";
process.env.LOG_LEVEL = "fatal";
Object.assign(process.env, {
  DISCORD_TOKEN: "test-token",
  DISCORD_CLIENT_ID: "1",
  DISCORD_GUILD_ID: "1",
  DISCORD_TICKETS_CHANNEL_ID: "1",
  ZAMMAD_BASE_URL: "http://127.0.0.1:9",
  ZAMMAD_PUBLIC_URL: "https://helpdesk.example.com",
  ZAMMAD_API_TOKEN: "test-api-token",
  ZAMMAD_WEBHOOK_SECRET: "test-webhook-secret",
});

const { loadEnv } = await import("../src/util/env.js");
loadEnv();
const dbMod = await import("../src/db/index.js");
dbMod.initDb(":memory:");

export const db = dbMod;
