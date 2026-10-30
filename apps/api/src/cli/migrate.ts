import { migrate } from "drizzle-orm/postgres-js/migrator";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";

// Runs as the table owner (MIGRATE_DATABASE_URL). The runtime role cannot change the schema.
const config = loadConfig();
const { db, client } = createDb(config.migrateUrl, 1);
await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
await client.end();
console.log("migrations applied");
