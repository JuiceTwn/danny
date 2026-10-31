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
  // What everyone but the server owner gets each day. Only the owner can change their own cap, so this is the free allowance.
  DEFAULT_DAILY_CAP_USD: z.coerce.number().default(1),
  // Where the server owner's own cap starts. They can change it in Settings.
  OWNER_DAILY_CAP_USD: z.coerce.number().default(5),
  MAX_DAILY_CAP_USD: z.coerce.number().default(50),
  // Master encryption key(s). Required. Generate one: openssl rand -base64 32  ->  "1:<that>"
  DATA_KEYS: z.string().min(1, "DATA_KEYS is required"),
  // Built web app (apps/web/dist). If the folder is missing, only the API is served.
  WEB_DIR: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  MODEL: z.string().default("claude-haiku-5-5"),
  // Placeholders. Check against Anthropic's current pricing before real traffic.
  PRICE_INPUT_PER_MTOK_USD: z.coerce.number().default(1),
  PRICE_OUTPUT_PER_MTOK_USD: z.coerce.number().default(5),
  // Voice typing (speech to text). Without a key the mic button stays hidden. Get one at elevenlabs.io and put it in .env, never in chat.
  ELEVENLABS_API_KEY: z.string().optional(),
  STT_MODEL: z.string().default("scribe_v2"),
  // Placeholder: check ElevenLabs' current price for speech to text before real traffic.
  PRICE_STT_PER_HOUR_USD: z.coerce.number().default(0.22),
  // Anthropic bills each web search separately, on top of tokens.
  PRICE_SEARCH_USD: z.coerce.number().default(0.01),
  // Where the Owner tab drops update and backup requests, and reads the results. A root-owned script on the server does the work (deploy/ops.sh).
  OPS_DIR: z.string().default("/ops"),
  // Web push. Generate once: npx web-push generate-vapid-keys. Without them reminders still land in the chat.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default("mailto:admin@localhost"),
  // Gmail. Create an OAuth client in Google Cloud (type: Web) with redirect URI <APP_URL>/v1/connections/google/callback. See docs/GMAIL_SETUP.md.
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  // Checks for due reminders every 30 seconds. Turn off only for tests or a second, read-only process.
  SCHEDULER: z.enum(["true", "false"]).default("true"),
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
    ownerDailyCapMicros: Math.round(c.OWNER_DAILY_CAP_USD * 1_000_000),
    maxDailyCapMicros: Math.round(c.MAX_DAILY_CAP_USD * 1_000_000),
    dataKeys: c.DATA_KEYS,
    webDir: c.WEB_DIR,
    anthropicApiKey: c.ANTHROPIC_API_KEY || undefined,
    model: c.MODEL,
    elevenlabsApiKey: c.ELEVENLABS_API_KEY || undefined,
    voice: { model: c.STT_MODEL, pricePerHourUsd: c.PRICE_STT_PER_HOUR_USD },
    opsDir: c.OPS_DIR,
    vapid: c.VAPID_PUBLIC_KEY && c.VAPID_PRIVATE_KEY ? { publicKey: c.VAPID_PUBLIC_KEY, privateKey: c.VAPID_PRIVATE_KEY, subject: c.VAPID_SUBJECT } : null,
    google: c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET ? { clientId: c.GOOGLE_CLIENT_ID, clientSecret: c.GOOGLE_CLIENT_SECRET, redirectUri: `${c.APP_URL.replace(/\/$/, "")}/v1/connections/google/callback` } : null,
    scheduler: c.SCHEDULER === "true" && c.NODE_ENV !== "test",
    price: { inputPerMtokUsd: c.PRICE_INPUT_PER_MTOK_USD, outputPerMtokUsd: c.PRICE_OUTPUT_PER_MTOK_USD, searchUsd: c.PRICE_SEARCH_USD },
  };
}
