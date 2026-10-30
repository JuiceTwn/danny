import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AnthropicModel, DemoModel } from "./brain/model.js";
import { startScheduler } from "./brain/heartbeat.js";
import { createDb } from "./db/client.js";
import { Vault } from "./lib/vault.js";
import { createRegistry } from "./tools/builtin.js";

const config = loadConfig();
const { db, client } = createDb(config.databaseUrl);
const model = config.anthropicApiKey ? new AnthropicModel(config.anthropicApiKey) : new DemoModel();
const deps = { config, db, model, tools: createRegistry(), vault: new Vault(config.dataKeys) };
const app = await buildApp(deps);
if (!config.anthropicApiKey) app.log.warn("ANTHROPIC_API_KEY not set: running in demo mode");
// Demo mode has no model to wake up, so the scheduler stays off there.
const stopScheduler = config.anthropicApiKey
  ? startScheduler(deps, config.agentTickMs, { error: (e) => app.log.error(e), info: (m) => app.log.info(m) })
  : () => {};

const close = async () => {
  stopScheduler();
  await app.close();
  await client.end();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);

await app.listen({ port: config.port, host: config.host });
