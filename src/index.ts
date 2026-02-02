import "dotenv/config";
import { join } from "node:path";
import { Client } from "discord.js";
import { loadEnv, env } from "./util/env.js";
import { logger } from "./util/logger.js";
import { initDb, closeDb, pruneDedup, pruneSyncedArticles } from "./db/index.js";
import { createClient } from "./client.js";
import { startWebServer } from "./web/server.js";
import { syncAllTickets } from "./services/backfill.js";
import { startHealthCheck, stopHealthCheck } from "./services/health.js";

let discordClient: Client | null = null;
let server: Awaited<ReturnType<typeof startWebServer>> | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

async function main() {
  // 1. Validate environment
  loadEnv();
  logger.info("Environment validated");

  // 2. Initialize SQLite (initDb creates the data/ dir if missing)
  const dbPath = join(process.cwd(), "data", "bot.db");
  initDb(dbPath);

  // 3. Create Discord client and login
  const client = createClient();
  discordClient = client;
  await client.login(env().DISCORD_TOKEN);

  // 4. Start webhook HTTP server
  server = await startWebServer(client);

  // 5. Initial sync — pull all open tickets from Zammad and create threads
  await syncAllTickets(client);

  // 6. Periodic ticket sync every 10 seconds — catches title changes and anything webhooks missed
  let syncing = false;
  syncTimer = setInterval(async () => {
    if (syncing) return; // skip if previous sync still running
    syncing = true;
    try {
      await syncAllTickets(client);
    } catch (err) {
      logger.error({ err }, "Periodic ticket sync failed");
    } finally {
      syncing = false;
    }
  }, 10 * 1000);

  // 7. Periodic maintenance (hourly) — prune old dedup/sync entries
  cleanupTimer = setInterval(() => {
    pruneDedup();
    pruneSyncedArticles();
  }, 60 * 60 * 1000);

  // 8. Zammad health monitoring — alerts @everyone if Zammad goes down
  startHealthCheck(client);

  logger.info("Bot fully started");
}

// ---------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");

  if (syncTimer) clearInterval(syncTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  stopHealthCheck();

  // Stop accepting new webhooks
  if (server) {
    try {
      await server.close();
    } catch {
      // ignore
    }
  }

  // Close Discord gateway connection
  if (discordClient) {
    try {
      await discordClient.destroy();
    } catch {
      // ignore
    }
  }

  // Close SQLite cleanly (flushes WAL)
  closeDb();

  // Flush pino
  logger.flush();

  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("unhandledRejection", (err) => {
  logger.fatal({ err }, "Unhandled rejection");
  process.exit(1);
});

main().catch((err) => {
  logger.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
