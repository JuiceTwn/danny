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
  // Master encryption key(s). Required. Generate one: openssl rand -base64 32  ->  "1:<that>"
  DATA_KEYS: z.string().min(1, "DATA_KEYS is required"),
  // Built web app (apps/web/dist). If the folder is missing, only the API is served.
  WEB_DIR: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  // The three tiers the router chooses between. See brain/router.ts for the rules.
  HAIKU_MODEL: z.string().default("claude-haiku-5-5"),
  SONNET_MODEL: z.string().default("claude-sonnet-5-5"),
  OPUS_MODEL: z.string().default("claude-opus-5-5"),
  DEFAULT_MONTHLY_CAP_USD: z.coerce.number().default(30),
  MAX_MONTHLY_CAP_USD: z.coerce.number().default(500),
  // How often the scheduler looks for due work. 0 turns the scheduler off.
  AGENT_TICK_SECONDS: z.coerce.number().int().min(0).default(300),
  // Optional override for a model not in the price table below, or if prices change.
  // Format: "model=inputUsdPerMtok/outputUsdPerMtok,model2=..."
  MODEL_PRICES: z.string().default(""),
});

/** US$ per million tokens, from Anthropic's published prices. Anything not listed falls back to the most expensive known price, so the cap errs on the safe side. */
export type Price = {
  inputPerMtokUsd: number;
  outputPerMtokUsd: number;
  /** Some models cost more once a single prompt passes a size. The higher rate then applies to that whole request. */
  longPrompt?: { aboveTokens: number; inputPerMtokUsd: number; outputPerMtokUsd: number };
};
export const DEFAULT_PRICES: Record<string, Price> = {
  "claude-haiku-5-5": { inputPerMtokUsd: 0.1, outputPerMtokUsd: 0.5, longPrompt: { aboveTokens: 100_000, inputPerMtokUsd: 0.5, outputPerMtokUsd: 2.5 } },
  "claude-sonnet-5-5": { inputPerMtokUsd: 2, outputPerMtokUsd: 10 },
  "claude-sonnet-5": { inputPerMtokUsd: 2, outputPerMtokUsd: 10 },
  "claude-opus-5-5": { inputPerMtokUsd: 4, outputPerMtokUsd: 20 },
  "claude-opus-5": { inputPerMtokUsd: 5, outputPerMtokUsd: 25 },
  "claude-fable-5-1": { inputPerMtokUsd: 10, outputPerMtokUsd: 50 },
  "claude-fable-5": { inputPerMtokUsd: 10, outputPerMtokUsd: 50 },
};
const FALLBACK_PRICE = { inputPerMtokUsd: 10, outputPerMtokUsd: 50 };

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const c = schema.parse(env);
  const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  // Plain-HTTP cookies are fine for one computer talking to itself (setup.sh with no domain), and nowhere else.
  const onThisComputer = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(c.APP_URL);
  if (c.NODE_ENV === "production" && c.COOKIE_SECURE !== "true" && !onThisComputer) {
    throw new Error("COOKIE_SECURE must be true in production, unless APP_URL is http://localhost");
  }
  const prices = { ...DEFAULT_PRICES };
  for (const part of list(c.MODEL_PRICES)) {
    const m = /^([^=]+)=([\d.]+)\/([\d.]+)$/.exec(part);
    if (!m) throw new Error(`MODEL_PRICES entry not understood: ${part}`);
    prices[m[1]!] = { inputPerMtokUsd: Number(m[2]), outputPerMtokUsd: Number(m[3]) };
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
    defaultMonthlyCapMicros: Math.round(c.DEFAULT_MONTHLY_CAP_USD * 1_000_000),
    maxMonthlyCapMicros: Math.round(c.MAX_MONTHLY_CAP_USD * 1_000_000),
    maxDailyCapMicros: Math.round(c.MAX_DAILY_CAP_USD * 1_000_000),
    dataKeys: c.DATA_KEYS,
    webDir: c.WEB_DIR,
    anthropicApiKey: c.ANTHROPIC_API_KEY || undefined,
    models: { haiku: c.HAIKU_MODEL, sonnet: c.SONNET_MODEL, opus: c.OPUS_MODEL },
    agentTickMs: c.AGENT_TICK_SECONDS * 1000,
    priceFor: (model: string) => prices[model] ?? FALLBACK_PRICE,
  };
}
