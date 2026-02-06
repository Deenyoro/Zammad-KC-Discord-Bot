import { z } from "zod";

const envSchema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_CLIENT_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_TICKETS_CHANNEL_ID: z.string().min(1),
  DISCORD_TICKET_ROLE_ID: z.string().min(1).optional(),
  ZAMMAD_BASE_URL: z.string().url(),
  ZAMMAD_PUBLIC_URL: z.string().url().optional(),
  ZAMMAD_API_TOKEN: z.string().min(1),
  ZAMMAD_WEBHOOK_SECRET: z.string().min(1),
  ADMIN_USER_IDS: z
    .string()
    .default("")
    .transform((v) => v.split(",").map((s) => s.trim()).filter(Boolean)),
  PORT: z.coerce.number().default(3100),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).default("info"),

  // AI provider configuration (all optional — features degrade gracefully)
  AI_API_KEY: z.string().min(1).optional(),
  AI_PROVIDER: z.enum(["openrouter", "openai", "anthropic"]).default("openrouter"),
  AI_MODEL: z.string().min(1).optional(),
  AI_BASE_URL: z.string().url().optional(),
  AI_FALLBACK_API_KEY: z.string().min(1).optional(),
  AI_FALLBACK_PROVIDER: z.enum(["openrouter", "openai", "anthropic"]).optional(),
  AI_FALLBACK_MODEL: z.string().min(1).optional(),

  // Web search configuration (all optional)
  SEARCH_API_KEY: z.string().min(1).optional(),
  SEARCH_PROVIDER: z.enum(["tavily", "brave"]).default("tavily"),
  SEARCH_FALLBACK_API_KEY: z.string().min(1).optional(),
  SEARCH_FALLBACK_PROVIDER: z.enum(["tavily", "brave"]).optional(),

  // Daily summary (disabled if unset)
  DAILY_SUMMARY_HOUR: z.coerce.number().min(0).max(23).optional(),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function loadEnv(): Env {
  if (_env) return _env;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const missing = result.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    console.error("Missing or invalid environment variables:\n" + missing.join("\n"));
    process.exit(1);
  }
  _env = result.data;
  return _env;
}

export function env(): Env {
  if (!_env) throw new Error("env() called before loadEnv()");
  return _env;
}
