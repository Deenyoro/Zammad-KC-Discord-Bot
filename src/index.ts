import "dotenv/config";
import { join } from "node:path";
import { Client, REST, Routes } from "discord.js";
import { loadEnv, env } from "./util/env.js";
import { logger } from "./util/logger.js";
import { initDb, closeDb, pruneDedup, pruneSyncedArticles, prunePostedMedia, pruneReminders } from "./db/index.js";
import { createClient } from "./client.js";
import { startWebServer } from "./web/server.js";
import { syncAllTickets, catchUpArticles } from "./services/backfill.js";
import { startHealthCheck, stopHealthCheck } from "./services/health.js";
import { startDailySummary, stopDailySummary } from "./services/dailySummary.js";
import { startKeepalive, stopKeepalive } from "./services/keepalive.js";
import { initMergeAnnouncements } from "./services/related.js";
import { allCommands } from "./commands/all.js";
import { startReminders, stopReminders } from "./services/reminders.js";

let discordClient: Client | null = null;
let server: Awaited<ReturnType<typeof startWebServer>> | null = null;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let catchupTimer: ReturnType<typeof setInterval> | null = null;

/** Deploy slash commands to Discord on startup */
async function deployCommands() {
  const config = env();
  const commands = allCommands();

  const rest = new REST().setToken(config.DISCORD_TOKEN);

  try {
    await rest.put(
      Routes.applicationGuildCommands(config.DISCORD_CLIENT_ID, config.DISCORD_GUILD_ID),
      { body: commands }
    );
    logger.info({ guildId: config.DISCORD_GUILD_ID, count: commands.length }, "Slash commands deployed to guild");
  } catch (err) {
    logger.error({ err }, "Failed to deploy slash commands");
  }
}

async function main() {
  // 1. Validate environment
  loadEnv();
  logger.info("Environment validated");

  // 2. Initialize SQLite (initDb creates the data/ dir if missing)
  const dbPath = join(process.cwd(), "data", "bot.db");
  initDb(dbPath);
  // Merges made before this release are listed, never announced.
  initMergeAnnouncements();

  // 3. Create Discord client and login
  const client = createClient();
  discordClient = client;
  await client.login(env().DISCORD_TOKEN);

  // 4. Deploy slash commands (ensures new commands/options are always registered)
  await deployCommands();

  // 5. Start webhook HTTP server
  server = await startWebServer(client);

  // 5b. Fast article catch-up every 10 seconds, independent of the full sync. Started before the initial sync
  // so a restart does not hold messages back until that sync (about 2 minutes) is over.
  let catchingUp = false;
  catchupTimer = setInterval(async () => {
    if (catchingUp) return;
    catchingUp = true;
    try {
      await catchUpArticles(client);
    } catch (err) {
      logger.error({ err }, "Article catch-up failed");
    } finally {
      catchingUp = false;
    }
  }, 10 * 1000);

  // 6. Initial sync, pull all open tickets from Zammad and create threads
  await syncAllTickets(client);

  // 7. Periodic ticket sync every 30 seconds, catches title changes and anything webhooks missed
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
  }, 30 * 1000);

  // 8. Periodic maintenance (hourly), prune old dedup/sync entries
  cleanupTimer = setInterval(() => {
    pruneDedup();
    pruneSyncedArticles();
    prunePostedMedia();
    pruneReminders();
  }, 60 * 60 * 1000);

  // 9. Zammad health monitoring, alerts @everyone if Zammad goes down
  startHealthCheck(client);

  // 10. Daily summary posting (checks every 60s if configured hour matches)
  startDailySummary(client);

  // 11. Daily keepalive sweep, silent status updates to prevent Discord from hiding threads
  startKeepalive(client);

  // 12. /remind-me delivery (stored in SQLite; due ones are sent on startup too)
  startReminders(client);

  logger.info("Bot fully started");
}

// ---------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------

async function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down");

  if (syncTimer) clearInterval(syncTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (catchupTimer) clearInterval(catchupTimer);
  stopHealthCheck();
  stopDailySummary();
  stopKeepalive();
  stopReminders();

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
