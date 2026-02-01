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
