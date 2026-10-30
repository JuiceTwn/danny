import { eq } from "drizzle-orm";
import { loadConfig } from "../config.js";
import { createDb } from "../db/client.js";
import { memberships, users, workspaces } from "../db/schema.js";
import { hashPassword } from "../lib/crypto.js";

// First account on a fresh server. Usage: npm run create-owner -- you@example.com 'a long password' 'Your Name'
const [email, password, name = ""] = process.argv.slice(2);
if (!email || !password || password.length < 10) {
  console.error("usage: create-owner <email> <password of 10+ characters> [name]");
  process.exit(1);
}
const config = loadConfig();
const { db, client } = createDb(config.migrateUrl, 1);
const lower = email.trim().toLowerCase();
const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, lower));
if (existing) {
  console.error("that email already has an account");
  process.exit(1);
}
await db.transaction(async (tx) => {
  const [u] = await tx.insert(users).values({ email: lower, name, passwordHash: await hashPassword(password), isOwner: true }).returning({ id: users.id });
  const [w] = await tx.insert(workspaces).values({ name: name ? `${name}'s Danny` : "My Danny", dailyCapMicros: config.ownerDailyCapMicros }).returning({ id: workspaces.id });
  await tx.insert(memberships).values({ workspaceId: w!.id, userId: u!.id, role: "admin" });
});
await client.end();
console.log(`owner created: ${lower}`);
