import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../util/logger.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ticket_threads (
  ticket_id           INTEGER PRIMARY KEY,
  ticket_number       TEXT    NOT NULL,
  thread_id           TEXT    NOT NULL UNIQUE,
  header_message_id   TEXT    NOT NULL,
  channel_id          TEXT    NOT NULL,
  title               TEXT,
  state               TEXT    NOT NULL DEFAULT 'open',
  created_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_map (
  discord_id    TEXT PRIMARY KEY,
  zammad_email  TEXT NOT NULL,
  zammad_id     INTEGER
);

CREATE TABLE IF NOT EXISTS synced_articles (
  article_id      INTEGER PRIMARY KEY,
  ticket_id       INTEGER NOT NULL,
  thread_id       TEXT    NOT NULL,
  discord_msg_id  TEXT,
  direction       TEXT    NOT NULL DEFAULT 'zammad_to_discord',
  synced_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS webhook_dedup (
  delivery_id  TEXT PRIMARY KEY,
  received_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS templates (
  name        TEXT PRIMARY KEY,
  body        TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_synced_articles_ticket ON synced_articles(ticket_id);
CREATE INDEX IF NOT EXISTS idx_ticket_threads_thread  ON ticket_threads(thread_id);
`;

let _db: Database.Database | null = null;

export function initDb(dbPath: string): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.exec(SCHEMA);
  logger.info({ dbPath }, "Database initialized");
  return _db;
}

export function db(): Database.Database {
  if (!_db) throw new Error("db() called before initDb()");
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ---------------------------------------------------------------
// ticket_threads
// ---------------------------------------------------------------

export interface TicketThread {
  ticket_id: number;
  ticket_number: string;
  thread_id: string;
  header_message_id: string;
  channel_id: string;
  title: string | null;
  state: string;
  created_at: string;
  updated_at: string;
}

export function upsertTicketThread(row: Omit<TicketThread, "created_at" | "updated_at">): void {
  db()
    .prepare(
      `INSERT INTO ticket_threads (ticket_id, ticket_number, thread_id, header_message_id, channel_id, title, state)
       VALUES (@ticket_id, @ticket_number, @thread_id, @header_message_id, @channel_id, @title, @state)
       ON CONFLICT(ticket_id) DO UPDATE SET
         thread_id = @thread_id,
         header_message_id = @header_message_id,
         title = @title,
         state = @state,
         updated_at = datetime('now')`
    )
    .run(row);
}

export function getThreadByTicketId(ticketId: number): TicketThread | undefined {
  return db()
    .prepare("SELECT * FROM ticket_threads WHERE ticket_id = ?")
    .get(ticketId) as TicketThread | undefined;
}

export function getThreadByThreadId(threadId: string): TicketThread | undefined {
  return db()
    .prepare("SELECT * FROM ticket_threads WHERE thread_id = ?")
    .get(threadId) as TicketThread | undefined;
}

export function updateThreadState(ticketId: number, state: string): void {
  db()
    .prepare("UPDATE ticket_threads SET state = ?, updated_at = datetime('now') WHERE ticket_id = ?")
    .run(state, ticketId);
}

export function updateThreadTitle(ticketId: number, title: string): void {
  db()
    .prepare("UPDATE ticket_threads SET title = ?, updated_at = datetime('now') WHERE ticket_id = ?")
    .run(title, ticketId);
}

export function getAllTicketThreads(): TicketThread[] {
  return db().prepare("SELECT * FROM ticket_threads").all() as TicketThread[];
}

// ---------------------------------------------------------------
// synced_articles
// ---------------------------------------------------------------

export function isArticleSynced(articleId: number): boolean {
  const row = db()
    .prepare("SELECT 1 FROM synced_articles WHERE article_id = ?")
    .get(articleId);
  return !!row;
}

export function markArticleSynced(
  articleId: number,
  ticketId: number,
  threadId: string,
  discordMsgId: string | null,
  direction: "zammad_to_discord" | "discord_to_zammad"
): void {
  db()
    .prepare(
      `INSERT OR IGNORE INTO synced_articles (article_id, ticket_id, thread_id, discord_msg_id, direction)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(articleId, ticketId, threadId, discordMsgId, direction);
}

// ---------------------------------------------------------------
// user_map
// ---------------------------------------------------------------

export interface UserMapEntry {
  discord_id: string;
  zammad_email: string;
  zammad_id: number | null;
}

export function getUserMap(discordId: string): UserMapEntry | undefined {
  return db()
    .prepare("SELECT * FROM user_map WHERE discord_id = ?")
    .get(discordId) as UserMapEntry | undefined;
}

export function setUserMap(discordId: string, zammadEmail: string, zammadId?: number): void {
  db()
    .prepare(
      `INSERT INTO user_map (discord_id, zammad_email, zammad_id)
       VALUES (?, ?, ?)
       ON CONFLICT(discord_id) DO UPDATE SET zammad_email = ?, zammad_id = ?`
    )
    .run(discordId, zammadEmail, zammadId ?? null, zammadEmail, zammadId ?? null);
}

export function getDiscordIdByZammadId(zammadId: number): string | undefined {
  const row = db()
    .prepare("SELECT discord_id FROM user_map WHERE zammad_id = ?")
    .get(zammadId) as { discord_id: string } | undefined;
  return row?.discord_id;
}

export function getAllUserMaps(): UserMapEntry[] {
  return db().prepare("SELECT * FROM user_map").all() as UserMapEntry[];
}

// ---------------------------------------------------------------
// webhook_dedup
// ---------------------------------------------------------------

export function isDeliveryProcessed(deliveryId: string): boolean {
  return !!db().prepare("SELECT 1 FROM webhook_dedup WHERE delivery_id = ?").get(deliveryId);
}

export function markDeliveryProcessed(deliveryId: string): void {
  db().prepare("INSERT OR IGNORE INTO webhook_dedup (delivery_id) VALUES (?)").run(deliveryId);
}

export function unmarkDeliveryProcessed(deliveryId: string): void {
  db().prepare("DELETE FROM webhook_dedup WHERE delivery_id = ?").run(deliveryId);
}

/** Clean up dedup entries older than 24 hours. */
export function pruneDedup(): void {
  const result = db()
    .prepare("DELETE FROM webhook_dedup WHERE received_at < datetime('now', '-1 day')")
    .run();
  if (result.changes > 0) {
    logger.debug({ pruned: result.changes }, "Pruned webhook dedup entries");
  }
}

/** Clean up synced_articles entries older than 30 days. */
export function pruneSyncedArticles(): void {
  const result = db()
    .prepare("DELETE FROM synced_articles WHERE synced_at < datetime('now', '-30 days')")
    .run();
  if (result.changes > 0) {
    logger.debug({ pruned: result.changes }, "Pruned synced articles entries");
  }
}

// ---------------------------------------------------------------
// templates
// ---------------------------------------------------------------

export interface Template {
  name: string;
  body: string;
  created_by: string;
  created_at: string;
}

export function getTemplate(name: string): Template | undefined {
  return db()
    .prepare("SELECT * FROM templates WHERE name = ?")
    .get(name) as Template | undefined;
}

export function getAllTemplates(): Template[] {
  return db().prepare("SELECT * FROM templates ORDER BY name").all() as Template[];
}

export function upsertTemplate(name: string, body: string, createdBy: string): void {
  db()
    .prepare(
      `INSERT INTO templates (name, body, created_by)
       VALUES (?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET body = ?, created_by = ?, created_at = datetime('now')`
    )
    .run(name, body, createdBy, body, createdBy);
}

export function deleteTemplate(name: string): boolean {
  const result = db().prepare("DELETE FROM templates WHERE name = ?").run(name);
  return result.changes > 0;
}

// ---------------------------------------------------------------
// settings (runtime config — overrides env vars)
// ---------------------------------------------------------------

export function getSetting(key: string): string | undefined {
  const row = db()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`
    )
    .run(key, value, value);
}

export function deleteSetting(key: string): boolean {
  const result = db().prepare("DELETE FROM settings WHERE key = ?").run(key);
  return result.changes > 0;
}

/**
 * Get a configuration value: check SQLite settings first, fall back to env var.
 * This allows runtime configuration via /setup commands to override .env values.
 */
export function getSettingOrEnv(key: string): string | undefined {
  const dbVal = getSetting(key);
  if (dbVal !== undefined) return dbVal;
  return process.env[key] || undefined;
}
