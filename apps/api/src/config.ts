import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(8787),
  HOST: z.string().default("0.0.0.0"),
  // Runtime connection: the restricted role that row-level security applies to.
  DATABASE_URL: z.string().min(1),
  // Used only by migrations and admin scripts: the table owner.
  MIGRATE_DATABASE_URL: z.string().optional(),
  // The app origin that serves the web app (cookies are set for it). Comma separated.
  APP_ORIGINS: z.string().default("http://localhost:8787"),
  // Marketing site origins allowed to POST the invite-request form.
  MARKETING_ORIGINS: z.string().default(""),
  APP_URL: z.string().default("http://localhost:8787"),
  COOKIE_SECURE: z.enum(["true", "false"]).default("false"),
  TRUST_PROXY: z.enum(["true", "false"]).default("false"),
  SESSION_DAYS: z.coerce.number().int().default(30),
  DEFAULT_DAILY_CAP_USD: z.coerce.number().default(2),
  MAX_DAILY_CAP_USD: z.coerce.number().default(50),
  ANTHROPIC_API_KEY: z.string().optional(),
  MODEL: z.string().default("claude-haiku-5-5"),
  // Placeholders. Check against Anthropic's current pricing before real traffic.
  PRICE_INPUT_PER_MTOK_USD: z.coerce.number().default(1),
  PRICE_OUTPUT_PER_MTOK_USD: z.coerce.number().default(5),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = schema.parse(env);
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  if (c.NODE_ENV === "production" && c.COOKIE_SECURE !== "true") {
    throw new Error("COOKIE_SECURE must be true in production");
  }
  return {
    env: c.NODE_ENV,
    port: c.PORT,
    host: c.HOST,
    databaseUrl: c.DATABASE_URL,
    migrateUrl: c.MIGRATE_DATABASE_URL ?? c.DATABASE_URL,
    appOrigins: new Set(list(c.APP_ORIGINS)),
    marketingOrigins: new Set(list(c.MARKETING_ORIGINS)),
    appUrl: c.APP_URL.replace(/\/$/, ""),
    cookieSecure: c.COOKIE_SECURE === "true",
    trustProxy: c.TRUST_PROXY === "true",
    sessionDays: c.SESSION_DAYS,
    defaultDailyCapMicros: Math.round(c.DEFAULT_DAILY_CAP_USD * 1_000_000),
    maxDailyCapMicros: Math.round(c.MAX_DAILY_CAP_USD * 1_000_000),
    anthropicApiKey: c.ANTHROPIC_API_KEY || undefined,
    model: c.MODEL,
    price: { inputPerMtokUsd: c.PRICE_INPUT_PER_MTOK_USD, outputPerMtokUsd: c.PRICE_OUTPUT_PER_MTOK_USD },
  };
}
