import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AnthropicModel, DemoModel } from "./brain/model.js";
import { createDb } from "./db/client.js";
import { Health } from "./lib/health.js";
import { GoogleService } from "./lib/google.js";
import { loadGoogleCredentials } from "./lib/server-secrets.js";
import { NoPush, WebPushSender } from "./lib/push.js";
import { startScheduler } from "./lib/reminders.js";
import { ElevenLabsTranscriber } from "./lib/transcribe.js";
import { Vault } from "./lib/vault.js";
import { createRegistry } from "./tools/builtin.js";

const config = loadConfig();
const { db, client } = createDb(config.databaseUrl);
const model = config.anthropicApiKey ? new AnthropicModel(config.anthropicApiKey) : new DemoModel();
const vault = new Vault(config.dataKeys);
const push = config.vapid ? new WebPushSender(config.vapid.publicKey, config.vapid.privateKey, config.vapid.subject) : new NoPush();
const health = new Health(config.scheduler);
const google = new GoogleService(config.google);
const transcriber = config.voice ? new ElevenLabsTranscriber(config.voice.apiKey, config.voice.model) : null;
const app = await buildApp({ config, db, model, tools: createRegistry(), vault, push, google, health, transcriber });
if (!config.anthropicApiKey) app.log.warn("ANTHROPIC_API_KEY not set: running in demo mode");
if (!google.configured) {
  // Not set in the environment: use what the owner entered in the app, if anything.
  const saved = await loadGoogleCredentials(db, vault, config);
  if (saved) google.configure(saved, "app");
  else app.log.info("Google is not set up yet. The owner can do it in the app, under Settings > Connections.");
}
if (!transcriber) app.log.info("ELEVENLABS_API_KEY not set: voice typing is off");
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
