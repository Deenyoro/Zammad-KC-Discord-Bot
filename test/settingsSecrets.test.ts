import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "./helpers.js";

const secrets = await import("../src/db/secrets.js");
const ai = await import("../src/services/ai.js");

function raw(key: string): string | undefined {
  const row = db.db().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

function writeRaw(key: string, value: string): void {
  db.db().prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

/** Reopen the database file, which runs the startup migration again. */
function reopen(path: string): void {
  db.closeDb();
  db.initDb(path);
}

function withTempDb(fn: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "zkdb-"));
  const path = join(dir, "bot.db");
  try {
    db.closeDb();
    db.initDb(path);
    fn(path);
  } finally {
    db.closeDb();
    db.initDb(":memory:");
    secrets.configureSettingsKey(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a secret setting round-trips encrypted when the key is set", () => {
  withTempDb(() => {
    secrets.configureSettingsKey("test-key-one");
    db.setSetting("AI_API_KEY", "sk-secret-123");
    const stored = raw("AI_API_KEY")!;
    assert.ok(stored.startsWith("enc:v1:"), "stored value is encrypted");
    assert.ok(!stored.includes("sk-secret-123"));
    assert.equal(db.getSetting("AI_API_KEY"), "sk-secret-123");
    // Non-secret settings are untouched.
    db.setSetting("AI_PROVIDER", "openai");
    assert.equal(raw("AI_PROVIDER"), "openai");
  });
});

test("format matches the Uptime bot: enc:v1:<iv>:<tag>:<ct>, AES-256-GCM over SHA-256 of the key", () => {
  const k = (secrets.configureSettingsKey("abc"), secrets.settingsKey()!);
  const v = secrets.encryptValue("hello", k);
  const parts = v.slice("enc:v1:".length).split(":");
  assert.equal(parts.length, 3);
  assert.equal(Buffer.from(parts[0], "base64url").length, 12);
  assert.equal(Buffer.from(parts[1], "base64url").length, 16);
  assert.equal(secrets.decryptValue(v, k), "hello");
  secrets.configureSettingsKey(undefined);
});

test("plaintext keys from older versions keep working and are encrypted at startup", () => {
  withTempDb((path) => {
    secrets.configureSettingsKey(undefined);
    writeRaw("AI_API_KEY", "sk-plain");
    writeRaw("SEARCH_API_KEY", "tvly-plain");
    secrets.configureSettingsKey("migrate-key");
    reopen(path);
    assert.ok(raw("AI_API_KEY")!.startsWith("enc:v1:"));
    assert.ok(raw("SEARCH_API_KEY")!.startsWith("enc:v1:"));
    assert.equal(db.getSetting("AI_API_KEY"), "sk-plain");
    assert.equal(db.getSetting("SEARCH_API_KEY"), "tvly-plain");
  });
});

test("a plaintext key is encrypted on read when the key appears after startup", () => {
  withTempDb(() => {
    secrets.configureSettingsKey(undefined);
    writeRaw("AI_API_KEY", "sk-late");
    secrets.configureSettingsKey("late-key");
    assert.equal(db.getSetting("AI_API_KEY"), "sk-late");
    assert.ok(raw("AI_API_KEY")!.startsWith("enc:v1:"));
  });
});

test("without SETTINGS_ENCRYPTION_KEY values are stored and read in plaintext as before", () => {
  withTempDb((path) => {
    secrets.configureSettingsKey(undefined);
    db.setSetting("AI_API_KEY", "sk-nokey");
    assert.equal(raw("AI_API_KEY"), "sk-nokey");
    reopen(path);
    assert.equal(db.getSetting("AI_API_KEY"), "sk-nokey");
    assert.equal(db.secretSettingProblem("AI_API_KEY"), undefined);
  });
});

test("a wrong or missing key makes the setting unset with a message to re-run /setup", () => {
  withTempDb((path) => {
    secrets.configureSettingsKey("original-key");
    db.setSetting("AI_API_KEY", "sk-enc");
    db.setSetting("SEARCH_API_KEY", "tvly-enc");

    secrets.configureSettingsKey("other-key");
    reopen(path); // must not throw
    assert.equal(db.getSetting("AI_API_KEY"), undefined);
    assert.equal(ai.isAIConfigured(), false);
    assert.match(db.secretSettingProblem("AI_API_KEY")!, /re-run `\/setup ai`/);
    assert.match(ai.aiNotConfiguredMessage(), /re-run `\/setup ai`/);
    assert.equal(db.getSetting("SEARCH_API_KEY"), undefined);
    assert.match(db.secretSettingProblem("SEARCH_API_KEY")!, /re-run `\/setup search`/);
    assert.ok(raw("AI_API_KEY")!.startsWith("enc:v1:"), "the undecryptable value is left as it was");

    secrets.configureSettingsKey(undefined);
    reopen(path);
    assert.equal(db.getSetting("AI_API_KEY"), undefined);
    assert.match(db.secretSettingProblem("AI_API_KEY")!, /SETTINGS_ENCRYPTION_KEY/);

    // Saving again clears the problem.
    secrets.configureSettingsKey("other-key");
    db.setSetting("AI_API_KEY", "sk-new");
    assert.equal(db.secretSettingProblem("AI_API_KEY"), undefined);
    assert.equal(db.getSetting("AI_API_KEY"), "sk-new");
  });
});

test("API keys from the environment take precedence over the database", () => {
  withTempDb(() => {
    secrets.configureSettingsKey("env-test");
    db.setSetting("AI_API_KEY", "sk-from-db");
    db.setSetting("AI_PROVIDER", "anthropic");
    db.setSetting("AI_MODEL", "db-model");
    const saved = { ...process.env };
    try {
      assert.equal(db.getSettingOrEnv("AI_API_KEY"), "sk-from-db");
      process.env.AI_API_KEY = "sk-from-env";
      process.env.SEARCH_API_KEY = "tvly-from-env";
      assert.equal(db.getSettingOrEnv("AI_API_KEY"), "sk-from-env");
      assert.equal(db.getSettingOrEnv("SEARCH_API_KEY"), "tvly-from-env");
      // Other settings keep the old order: /setup wins over .env.
      process.env.AI_MODEL = "env-model";
      assert.equal(db.getSettingOrEnv("AI_MODEL"), "db-model");
      // A blank variable counts as unset.
      process.env.AI_API_KEY = " ";
      assert.equal(db.getSettingOrEnv("AI_API_KEY"), "sk-from-db");
    } finally {
      for (const k of ["AI_API_KEY", "SEARCH_API_KEY", "AI_MODEL"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
