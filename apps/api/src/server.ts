import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { AnthropicModel, DemoModel } from "./brain/model.js";
import { createDb } from "./db/client.js";
import { Vault } from "./lib/vault.js";
import { createRegistry } from "./tools/builtin.js";

const config = loadConfig();
const { db, client } = createDb(config.databaseUrl);
const model = config.anthropicApiKey ? new AnthropicModel(config.anthropicApiKey) : new DemoModel();
const app = await buildApp({ config, db, model, tools: createRegistry(), vault: new Vault(config.dataKeys) });
if (!config.anthropicApiKey) app.log.warn("ANTHROPIC_API_KEY not set: running in demo mode");

const close = async () => {
  await app.close();
  await client.end();
  process.exit(0);
};
process.on("SIGTERM", close);
process.on("SIGINT", close);

await app.listen({ port: config.port, host: config.host });
