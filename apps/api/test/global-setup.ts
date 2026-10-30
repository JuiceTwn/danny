import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "../src/db/client.js";
import { ADMIN_URL, MIGRATE_URL, OWNER_URL } from "./env.js";

export default async function setup() {
  const admin = createDb(ADMIN_URL, 1);
  await admin.client.unsafe("drop database if exists danny_test with (force)");
  for (const [name, pw] of [["danny_app", "danny_app_test"], ["danny_owner", "danny_owner_test"]] as const) {
    const role = await admin.client`select 1 from pg_roles where rolname = ${name}`;
    if (role.length === 0) await admin.client.unsafe(`create role ${name} login password '${pw}'`);
  }
  await admin.client.unsafe("create database danny_test owner danny_owner");
  await admin.client.end();

  // Same shape as production: migrations as a non-superuser owner, runtime as the restricted role.
  const owner = createDb(OWNER_URL, 1); // superuser, only to hand out the connect grant
  await owner.client.unsafe("grant connect on database danny_test to danny_app");
  await owner.client.end();
  const migrator = createDb(MIGRATE_URL, 1);
  await migrate(migrator.db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  await migrator.client.end();
}
