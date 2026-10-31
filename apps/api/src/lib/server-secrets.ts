import { eq } from "drizzle-orm";
import type { Config } from "../config.js";
import type { Db } from "../db/client.js";
import { serverSecrets } from "../db/schema.js";
import type { GoogleConfig } from "./google.js";
import type { Vault } from "./vault.js";

// Server-wide settings are sealed under a fixed scope of their own, not any one person's workspace.
const SCOPE = "00000000-0000-0000-0000-000000000000";
type SavedGoogle = { clientId: string; clientSecret: string };

export const googleRedirectUri = (config: Config) => `${config.appUrl}/v1/connections/google/callback`;

export async function loadGoogleCredentials(db: Db, vault: Vault, config: Config): Promise<GoogleConfig | null> {
  const [row] = await db.select().from(serverSecrets).where(eq(serverSecrets.name, "google"));
  if (!row) return null;
  try {
    const v = vault.openJson<SavedGoogle>(SCOPE, row.secretEnc);
    return { clientId: v.clientId, clientSecret: v.clientSecret, redirectUri: googleRedirectUri(config) };
  } catch {
    return null; // sealed with a key this server no longer has: treat as not set up rather than crash
  }
}

export async function saveGoogleCredentials(db: Db, vault: Vault, v: SavedGoogle) {
  const secretEnc = vault.sealJson(SCOPE, v);
  await db.insert(serverSecrets).values({ name: "google", secretEnc }).onConflictDoUpdate({ target: serverSecrets.name, set: { secretEnc, updatedAt: new Date() } });
}

export const clearGoogleCredentials = (db: Db) => db.delete(serverSecrets).where(eq(serverSecrets.name, "google"));

// API keys typed into the app. Sealed like the Google credentials, one row each, named "key:<id>".
export async function loadApiKeys(db: Db, vault: Vault): Promise<Record<string, string>> {
  const rows = await db.select().from(serverSecrets);
  const out: Record<string, string> = {};
  for (const r of rows) {
    if (!r.name.startsWith("key:")) continue;
    try {
      out[r.name.slice(4)] = vault.openJson<{ value: string }>(SCOPE, r.secretEnc).value;
    } catch {
      /* sealed with a key this server no longer has: treat as not set */
    }
  }
  return out;
}

export async function saveApiKey(db: Db, vault: Vault, id: string, value: string) {
  const secretEnc = vault.sealJson(SCOPE, { value });
  await db.insert(serverSecrets).values({ name: `key:${id}`, secretEnc }).onConflictDoUpdate({ target: serverSecrets.name, set: { secretEnc, updatedAt: new Date() } });
}

export const clearApiKey = (db: Db, id: string) => db.delete(serverSecrets).where(eq(serverSecrets.name, `key:${id}`));
