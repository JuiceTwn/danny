import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "../src/db/client.js";
import { ADMIN_URL, MIGRATOR_URL, OWNER_URL } from "./env.js";

export default async function setup() {
  const admin = createDb(ADMIN_URL, 1);
  await admin.client.unsafe("drop database if exists danny_test with (force)");
  const ownerRole = await admin.client`select 1 from pg_roles where rolname = 'danny_owner'`;
  if (ownerRole.length === 0) await admin.client.unsafe("create role danny_owner login password 'danny_owner_test'");
  await admin.client.unsafe("create database danny_test owner danny_owner");
  const role = await admin.client`select 1 from pg_roles where rolname = 'danny_app'`;
  if (role.length === 0) await admin.client.unsafe("create role danny_app login password 'danny_app_test'");
  await admin.client.end();

  // Same shape as production: migrations as a non-superuser owner, runtime as the restricted role.
  const owner = createDb(OWNER_URL, 1);
  await owner.client.unsafe("grant connect on database danny_test to danny_app");
  await owner.client.end();
  const migrator = createDb(MIGRATOR_URL, 1);
  await migrate(migrator.db, { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  await migrator.client.end();
}
