import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { LiveModel } from "./brain/model.js";
import { ApiKeys } from "./lib/api-keys.js";
import { createDb } from "./db/client.js";
import { Health } from "./lib/health.js";
import { GoogleService } from "./lib/google.js";
import { loadApiKeys, loadGoogleCredentials } from "./lib/server-secrets.js";
import { NoPush, WebPushSender } from "./lib/push.js";
import { startScheduler } from "./lib/reminders.js";
import { Vault } from "./lib/vault.js";
import { createRegistry } from "./tools/builtin.js";

const config = loadConfig();
const { db, client } = createDb(config.databaseUrl);
const vault = new Vault(config.dataKeys);
// Keys from .env win. Keys the owner typed into the app are loaded from the database and take effect without a restart.
const keys = new ApiKeys({ anthropic: config.anthropicApiKey, elevenlabs: config.elevenlabsApiKey });
keys.loadSaved(await loadApiKeys(db, vault));
const model = new LiveModel(keys);
const push = config.vapid ? new WebPushSender(config.vapid.publicKey, config.vapid.privateKey, config.vapid.subject) : new NoPush();
const health = new Health(config.scheduler);
const google = new GoogleService(config.google);
const app = await buildApp({ config, db, model, tools: createRegistry(), vault, push, google, health, keys });
if (!keys.has("anthropic")) app.log.warn("No Anthropic key yet: running in demo mode. The owner can add one in the app, under Owner > API keys.");
if (!google.configured) {
  // Not set in the environment: use what the owner entered in the app, if anything.
  const saved = await loadGoogleCredentials(db, vault, config);
  if (saved) google.configure(saved, "app");
  else app.log.info("Google is not set up yet. The owner can do it in the app, under Settings > Connections.");
}
if (!config.vapid) app.log.warn("VAPID keys not set: reminders show in the chat but are not pushed");
const stopScheduler = config.scheduler ? startScheduler({ db, vault, push, log: app.log, health, config, model, google }) : () => {};

const close = async () => {
  stopScheduler();
  await app.close();
  await client.end();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);

await app.listen({ port: config.port, host: config.host });
