/**
 * At-rest encryption for the API keys an admin can store with `/setup ai` and
 * `/setup search`.
 *
 * Same scheme as the Uptime Discord bot: when SETTINGS_ENCRYPTION_KEY is set,
 * secret settings are stored in data/bot.db as
 * "enc:v1:<iv>:<tag>:<ciphertext>" (AES-256-GCM, key = SHA-256 of the env
 * value, base64url parts). Plaintext values saved before the key was set keep
 * working and are re-written encrypted at startup and on the next read.
 * Without the env var, values are stored in plaintext as before and a warning
 * is logged at startup.
 *
 * If the key is later removed or changed, encrypted values cannot be read:
 * they count as unset and the admin is told to run /setup again. Keep the key
 * with the other bot secrets, never in the database.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Settings written by /setup that hold credentials. */
export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set(["AI_API_KEY", "SEARCH_API_KEY"]);

/**
 * Credentials for which a non-blank environment variable wins over the
 * database, so a deployment can inject them (e.g. from 1Password) and store
 * nothing in data/bot.db.
 */
export const ENV_FIRST_KEYS: ReadonlySet<string> = new Set([
  "AI_API_KEY",
  "AI_FALLBACK_API_KEY",
  "SEARCH_API_KEY",
  "SEARCH_FALLBACK_API_KEY",
]);

const PREFIX = "enc:v1:";

let key: Buffer | null | undefined;

/** Set (or clear) the encryption key. Defaults to process.env.SETTINGS_ENCRYPTION_KEY. */
export function configureSettingsKey(raw: string | undefined): void {
  const trimmed = raw?.trim();
  key = trimmed ? createHash("sha256").update(trimmed, "utf8").digest() : null;
}

export function settingsKey(): Buffer | null {
  if (key === undefined) configureSettingsKey(process.env.SETTINGS_ENCRYPTION_KEY);
  return key ?? null;
}

export function isEncryptedValue(value: string): boolean {
  return value.startsWith(PREFIX);
}

export function encryptValue(plain: string, k: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64url")}:${tag.toString("base64url")}:${ct.toString("base64url")}`;
}

/** Throws when the value is malformed or was encrypted with another key. */
export function decryptValue(stored: string, k: Buffer): string {
  const parts = stored.slice(PREFIX.length).split(":");
  if (parts.length !== 3) throw new Error("malformed encrypted setting");
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", k, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** The /setup subcommand that stores a secret setting, for messages to the admin. */
export function setupCommandFor(settingKey: string): string {
  return settingKey.startsWith("SEARCH_") ? "/setup search" : "/setup ai";
}
