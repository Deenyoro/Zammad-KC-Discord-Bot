import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../util/logger.js";
import {
  ENV_FIRST_KEYS,
  SECRET_SETTING_KEYS,
  decryptValue,
  encryptValue,
  isEncryptedValue,
  settingsKey,
  setupCommandFor,
} from "./secrets.js";

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

-- Content hashes of inline images already posted to a ticket's thread, so an
-- image re-embedded in a later reply (quoted chain) is not posted again.
CREATE TABLE IF NOT EXISTS posted_media (
  ticket_id   INTEGER NOT NULL,
  sha256      TEXT    NOT NULL,
  article_id  INTEGER NOT NULL,
  posted_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ticket_id, sha256)
);

-- /remind-me reminders. Stored here (the bot's persistent volume) so they
-- survive restarts and redeploys. due_at is an ISO 8601 UTC timestamp.
CREATE TABLE IF NOT EXISTS reminders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,
  guild_id      TEXT,
  channel_id    TEXT    NOT NULL,
  message       TEXT,
  source_url    TEXT,
  due_at        TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  delivered_at  TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error    TEXT
);
-- Merges already announced (Zammad notes + Discord message), one row per
-- merged-away ticket and the ticket it went into.
CREATE TABLE IF NOT EXISTS merge_notes (
  child_id   INTEGER NOT NULL,
  parent_id  INTEGER NOT NULL,
  noted_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (child_id, parent_id)
);

CREATE INDEX IF NOT EXISTS idx_reminders_pending ON reminders(delivered_at, due_at);

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
  migrate(_db);
  logger.info({ dbPath }, "Database initialized");
  migrateSecretSettings();
  return _db;
}

/** Additive column migrations for databases created by older versions. */
function migrate(d: Database.Database): void {
  const cols = new Set((d.prepare("PRAGMA table_info(reminders)").all() as { name: string }[]).map((c) => c.name));
  // Who a reminder pings besides its creator: "everyone" / "here", and user or role ids ("u:<id>", "r:<id>").
  if (!cols.has("mention_everyone")) d.exec("ALTER TABLE reminders ADD COLUMN mention_everyone TEXT");
  if (!cols.has("mention_ids")) d.exec("ALTER TABLE reminders ADD COLUMN mention_ids TEXT");
  // The Zammad ticket a reminder was set in (ticket thread), for its ticket notes.
  if (!cols.has("ticket_id")) d.exec("ALTER TABLE reminders ADD COLUMN ticket_id INTEGER");
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

/**
 * Check if an article is synced AND attributed to the correct ticket.
 * Returns true only if the article is synced for the specified ticket.
 * This prevents a race condition where concurrent webhook processing
 * can cause an article to be attributed to the wrong ticket.
 */
export function isArticleSyncedForTicket(articleId: number, ticketId: number): boolean {
  const row = db()
    .prepare("SELECT 1 FROM synced_articles WHERE article_id = ? AND ticket_id = ?")
    .get(articleId, ticketId);
  return !!row;
}

export interface SyncedArticleRow {
  ticket_id: number;
  thread_id: string;
  discord_msg_id: string | null;
}

/** Full synced-record lookup, lets callers distinguish "never synced" from
 *  "synced under a different ticket" (which happens when a merge moves
 *  articles to the target ticket). */
export function getSyncedArticle(articleId: number): SyncedArticleRow | undefined {
  return db()
    .prepare("SELECT ticket_id, thread_id, discord_msg_id FROM synced_articles WHERE article_id = ?")
    .get(articleId) as SyncedArticleRow | undefined;
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
      `INSERT OR REPLACE INTO synced_articles (article_id, ticket_id, thread_id, discord_msg_id, direction)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(articleId, ticketId, threadId, discordMsgId, direction);
}

// ---------------------------------------------------------------
// merge_notes
// ---------------------------------------------------------------

/** Claim a merge for announcing. True only for the first caller. */
export function claimMergeNote(childId: number, parentId: number): boolean {
  const r = db()
    .prepare("INSERT OR IGNORE INTO merge_notes (child_id, parent_id) VALUES (?, ?)")
    .run(childId, parentId);
  return r.changes > 0;
}

/** Give a claim back (announcing failed) so the next check retries. */
export function releaseMergeNote(childId: number, parentId: number): void {
  db().prepare("DELETE FROM merge_notes WHERE child_id = ? AND parent_id = ?").run(childId, parentId);
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
// posted_media (inline-image dedup per ticket)
// ---------------------------------------------------------------

export function isMediaPosted(ticketId: number, sha256: string): boolean {
  return !!db()
    .prepare("SELECT 1 FROM posted_media WHERE ticket_id = ? AND sha256 = ?")
    .get(ticketId, sha256);
}

export function recordPostedMedia(ticketId: number, articleId: number, hashes: string[]): void {
  const stmt = db().prepare(
    "INSERT OR IGNORE INTO posted_media (ticket_id, sha256, article_id) VALUES (?, ?, ?)"
  );
  for (const h of hashes) stmt.run(ticketId, h, articleId);
}

/** Clean up posted_media entries older than 180 days. */
export function prunePostedMedia(): void {
  db().prepare("DELETE FROM posted_media WHERE posted_at < datetime('now', '-180 days')").run();
}

// ---------------------------------------------------------------
// reminders
// ---------------------------------------------------------------

export interface Reminder {
  id: number;
  user_id: string;
  guild_id: string | null;
  channel_id: string;
  message: string | null;
  source_url: string | null;
  due_at: string;
  created_at: string;
  delivered_at: string | null;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  mention_everyone?: "everyone" | "here" | null;
  /** JSON array of "u:<id>" / "r:<id>". */
  mention_ids?: string | null;
  ticket_id?: number | null;
}

export function createReminder(row: {
  user_id: string;
  guild_id: string | null;
  channel_id: string;
  message: string | null;
  due_at: string;
  mention_everyone?: "everyone" | "here" | null;
  mention_ids?: string[] | null;
  ticket_id?: number | null;
}): number {
  const res = db()
    .prepare(
      `INSERT INTO reminders (user_id, guild_id, channel_id, message, due_at, mention_everyone, mention_ids, ticket_id)
       VALUES (@user_id, @guild_id, @channel_id, @message, @due_at, @mention_everyone, @mention_ids, @ticket_id)`
    )
    .run({
      ...row,
      mention_everyone: row.mention_everyone ?? null,
      mention_ids: row.mention_ids && row.mention_ids.length ? JSON.stringify(row.mention_ids) : null,
      ticket_id: row.ticket_id ?? null,
    });
  return Number(res.lastInsertRowid);
}

export function setReminderSourceUrl(id: number, url: string): void {
  db().prepare("UPDATE reminders SET source_url = ? WHERE id = ?").run(url, id);
}

/** Undelivered reminders due at or before `nowIso`, oldest first. */
export function getDueReminders(nowIso: string, limit = 25): Reminder[] {
  return db()
    .prepare(
      `SELECT * FROM reminders
       WHERE delivered_at IS NULL AND due_at <= ?
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY due_at ASC, id ASC LIMIT ?`
    )
    .all(nowIso, nowIso, limit) as Reminder[];
}

export function getPendingRemindersForUser(userId: string): Reminder[] {
  return db()
    .prepare(
      "SELECT * FROM reminders WHERE user_id = ? AND delivered_at IS NULL ORDER BY due_at ASC, id ASC"
    )
    .all(userId) as Reminder[];
}

export function countPendingRemindersForUser(userId: string): number {
  const row = db()
    .prepare("SELECT COUNT(*) AS n FROM reminders WHERE user_id = ? AND delivered_at IS NULL")
    .get(userId) as { n: number };
  return row.n;
}

export function markReminderDelivered(id: number, note?: string): void {
  db()
    .prepare("UPDATE reminders SET delivered_at = ?, last_error = ? WHERE id = ?")
    .run(new Date().toISOString(), note ?? null, id);
}

/** Record a failed delivery; the next attempt waits `retryAfterMs`. Returns the attempt count. */
export function markReminderFailed(id: number, error: string, retryAfterMs = 60_000): number {
  db()
    .prepare("UPDATE reminders SET attempts = attempts + 1, last_error = ?, next_attempt_at = ? WHERE id = ?")
    .run(error.slice(0, 500), new Date(Date.now() + retryAfterMs).toISOString(), id);
  const row = db().prepare("SELECT attempts FROM reminders WHERE id = ?").get(id) as
    | { attempts: number }
    | undefined;
  return row?.attempts ?? 0;
}

/** Cancel a pending reminder. Only the owner can cancel; returns true if one was cancelled. */
export function getReminder(id: number): Reminder | undefined {
  return db().prepare("SELECT * FROM reminders WHERE id = ?").get(id) as Reminder | undefined;
}

export function cancelReminder(id: number, userId: string): boolean {
  const res = db()
    .prepare(
      "UPDATE reminders SET delivered_at = ?, last_error = 'cancelled' WHERE id = ? AND user_id = ? AND delivered_at IS NULL"
    )
    .run(new Date().toISOString(), id, userId);
  return res.changes > 0;
}

/** Remove delivered/cancelled reminders older than 30 days. */
export function pruneReminders(): void {
  db()
    .prepare("DELETE FROM reminders WHERE delivered_at IS NOT NULL AND delivered_at < ?")
    .run(new Date(Date.now() - 30 * 24 * 3600_000).toISOString());
}

// ---------------------------------------------------------------
// templates (DEPRECATED, replaced by Zammad text modules)
// ---------------------------------------------------------------

// export interface Template {
//   name: string;
//   body: string;
//   created_by: string;
//   created_at: string;
// }
//
// export function getTemplate(name: string): Template | undefined {
//   return db()
//     .prepare("SELECT * FROM templates WHERE name = ?")
//     .get(name) as Template | undefined;
// }
//
// export function getAllTemplates(): Template[] {
//   return db().prepare("SELECT * FROM templates ORDER BY name").all() as Template[];
// }
//
// export function upsertTemplate(name: string, body: string, createdBy: string): void {
//   db()
//     .prepare(
//       `INSERT INTO templates (name, body, created_by)
//        VALUES (?, ?, ?)
//        ON CONFLICT(name) DO UPDATE SET body = ?, created_by = ?, created_at = datetime('now')`
//     )
//     .run(name, body, createdBy, body, createdBy);
// }
//
// export function deleteTemplate(name: string): boolean {
//   const result = db().prepare("DELETE FROM templates WHERE name = ?").run(name);
//   return result.changes > 0;
// }

// ---------------------------------------------------------------
// settings (runtime config, overrides env vars)
// ---------------------------------------------------------------

function readRaw(key: string): string | undefined {
  const row = db()
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

function writeRaw(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?`
    )
    .run(key, value, value);
}

// Secret settings that exist but cannot be decrypted, so the error is logged
// once per key and commands can tell the admin what to do.
const undecryptable = new Set<string>();

function markUndecryptable(key: string, keySet: boolean): void {
  if (undecryptable.has(key)) return;
  undecryptable.add(key);
  const reason = keySet
    ? "cannot be decrypted with the current SETTINGS_ENCRYPTION_KEY (was the key changed?)"
    : "is encrypted but SETTINGS_ENCRYPTION_KEY is not set";
  logger.error(
    { key },
    `Stored ${key} ${reason}; treating it as unset. Restore the old key, or re-run ${setupCommandFor(key)} to save it again.`
  );
}

/**
 * Message for the admin when a stored secret cannot be read, or undefined
 * when it is fine (or not stored at all).
 */
export function secretSettingProblem(key: string): string | undefined {
  if (!undecryptable.has(key)) return undefined;
  return (
    `The stored ${key} cannot be decrypted (SETTINGS_ENCRYPTION_KEY is missing or was changed). ` +
    `An admin needs to re-run \`${setupCommandFor(key)}\` to save it again, or restore the previous key.`
  );
}

/**
 * Encrypt secret settings still stored in plaintext (when a key is set),
 * otherwise warn once that they are kept in plaintext. Also reports stored
 * values that cannot be decrypted.
 */
function migrateSecretSettings(): void {
  const k = settingsKey();
  const plain: string[] = [];
  for (const name of SECRET_SETTING_KEYS) {
    const raw = readRaw(name);
    if (raw === undefined) continue;
    if (isEncryptedValue(raw)) {
      if (!k) {
        markUndecryptable(name, false);
        continue;
      }
      try {
        decryptValue(raw, k);
      } catch {
        markUndecryptable(name, true);
      }
      continue;
    }
    if (k) {
      writeRaw(name, encryptValue(raw, k));
      logger.info({ key: name }, "Encrypted plaintext secret setting");
    } else {
      plain.push(name);
    }
  }
  if (!k) {
    logger.warn(
      { plaintextKeys: plain },
      plain.length > 0
        ? "SETTINGS_ENCRYPTION_KEY is not set: API keys saved with /setup are stored in plaintext in data/bot.db. Set it to encrypt them."
        : "SETTINGS_ENCRYPTION_KEY is not set: API keys saved with /setup will be stored in plaintext in data/bot.db."
    );
  }
}

export function getSetting(key: string): string | undefined {
  const raw = readRaw(key);
  if (raw === undefined || !SECRET_SETTING_KEYS.has(key)) return raw;
  const k = settingsKey();
  if (isEncryptedValue(raw)) {
    if (!k) {
      markUndecryptable(key, false);
      return undefined;
    }
    try {
      const value = decryptValue(raw, k);
      undecryptable.delete(key);
      return value;
    } catch {
      markUndecryptable(key, true);
      return undefined;
    }
  }
  // Plaintext secret from before encryption was enabled: migrate on read.
  if (k) writeRaw(key, encryptValue(raw, k));
  undecryptable.delete(key);
  return raw;
}

export function setSetting(key: string, value: string): void {
  const k = SECRET_SETTING_KEYS.has(key) ? settingsKey() : null;
  writeRaw(key, k ? encryptValue(value, k) : value);
  undecryptable.delete(key);
}

export function deleteSetting(key: string): boolean {
  const result = db().prepare("DELETE FROM settings WHERE key = ?").run(key);
  undecryptable.delete(key);
  return result.changes > 0;
}

/** A non-blank environment variable, or undefined. */
export function envValue(key: string): string | undefined {
  const v = process.env[key];
  return v !== undefined && v.trim() !== "" ? v : undefined;
}

/**
 * Get a configuration value. Settings saved with /setup win over .env values,
 * except for the API keys (ENV_FIRST_KEYS): for those a non-blank environment
 * variable wins, so a deployment can inject them and store nothing.
 */
export function getSettingOrEnv(key: string): string | undefined {
  if (ENV_FIRST_KEYS.has(key)) {
    const fromEnv = envValue(key);
    if (fromEnv !== undefined) return fromEnv;
  }
  const dbVal = getSetting(key);
  if (dbVal !== undefined) return dbVal;
  return envValue(key);
}
