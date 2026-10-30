import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AnthropicModel, DemoModel } from "./brain/model.js";
import { createDb } from "./db/client.js";
import { NoPush, WebPushSender } from "./lib/push.js";
import { startScheduler } from "./lib/reminders.js";
import { Vault } from "./lib/vault.js";
import { createRegistry } from "./tools/builtin.js";

const config = loadConfig();
const { db, client } = createDb(config.databaseUrl);
const model = config.anthropicApiKey ? new AnthropicModel(config.anthropicApiKey) : new DemoModel();
const vault = new Vault(config.dataKeys);
const push = config.vapid ? new WebPushSender(config.vapid.publicKey, config.vapid.privateKey, config.vapid.subject) : new NoPush();
const app = await buildApp({ config, db, model, tools: createRegistry(), vault, push });
if (!config.anthropicApiKey) app.log.warn("ANTHROPIC_API_KEY not set: running in demo mode");
if (!config.vapid) app.log.warn("VAPID keys not set: reminders show in the chat but are not pushed");
const stopScheduler = config.scheduler ? startScheduler({ db, vault, push, log: app.log }) : () => {};

const close = async () => {
  stopScheduler();
  await app.close();
  await client.end();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);

await app.listen({ port: config.port, host: config.host });
