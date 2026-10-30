// Tests need a Postgres server they can create databases on. scripts/test-db.sh starts one.
const base = process.env.TEST_PG_ADMIN_URL ?? "postgres://postgres@localhost:54329";
export const ADMIN_URL = `${base}/postgres`;
export const OWNER_URL = `${base}/danny_test`;
export const APP_URL = (() => {
  const u = new URL(OWNER_URL);
  u.username = "danny_app";
  u.password = "danny_app_test";
  return u.toString();
})();
// Migrations run as this role, like production: it owns the tables but is NOT a superuser, so row-level
// security applies to it. (OWNER_URL, a superuser, is only for seeding and for inspecting the database.)
export const MIGRATOR_URL = (() => {
  const u = new URL(OWNER_URL);
  u.username = "danny_owner";
  u.password = "danny_owner_test";
  return u.toString();
})();
