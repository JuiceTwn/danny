import { desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { emailSchema } from "../lib/validation.js";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { auditLog, inviteRequests, invites } from "../db/schema.js";
import { newToken, sha256 } from "../lib/crypto.js";
import { SCOPES } from "../lib/google.js";
import { clearApiKey, clearGoogleCredentials, googleRedirectUri, saveApiKey, saveGoogleCredentials } from "../lib/server-secrets.js";
import { KEY_DEFS } from "../lib/api-keys.js";
import { ACTIONS, Ops } from "../lib/ops.js";
import { createInvite as makeInvite } from "../lib/invites.js";

const usd = (micros: number) => micros / 1_000_000;

// Server-owner tools. Invite-only signup: nobody gets in until the owner approves them here.
export const adminRoutes: FastifyPluginAsync<Deps> = async (app, { db, config, vault, google, keys, fetchFn }) => {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.auth?.isOwner) return reply.code(403).send({ error: "owner_only" });
  });

  const createInvite = (email: string, createdBy: string) => makeInvite(db, config.appUrl, email, createdBy);

  app.get("/v1/admin/invite-requests", async () => {
    const items = await db.select().from(inviteRequests).orderBy(desc(inviteRequests.createdAt)).limit(200);
    const [count] = await db.select({ total: sql<number>`count(*)::int` }).from(inviteRequests);
    return { items, total: count?.total ?? 0 };
  });

  // The whole list as a spreadsheet file. A cell starting with = + - or @ is prefixed so a spreadsheet never runs it as a formula.
  app.get("/v1/admin/invite-requests.csv", async (_req, reply) => {
    const rows = await db.select().from(inviteRequests).orderBy(desc(inviteRequests.createdAt)).limit(50_000);
    const cell = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replaceAll('"', '""')}"`;
    const csv = ["email,signed_up_at,status", ...rows.map((r) => [cell(r.email), r.createdAt.toISOString(), r.status].join(","))].join("\r\n") + "\r\n";
    return reply
      .header("content-type", "text/csv; charset=utf-8")
      .header("content-disposition", 'attachment; filename="danny-waitlist.csv"')
      .header("cache-control", "no-store")
      .send(csv);
  });

  app.post("/v1/admin/invite-requests/:id/approve", async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const [r] = await db.select().from(inviteRequests).where(eq(inviteRequests.id, id));
    if (!r) return reply.code(404).send({ error: "not_found" });
    return createInvite(r.email, req.auth!.userId);
  });

  app.post("/v1/admin/invites", async (req) => {
    const { email } = z.object({ email: emailSchema }).parse(req.body);
    return createInvite(email, req.auth!.userId);
  });

  // ---- Google client ID and secret, entered in the app instead of editing .env. The secret goes in and never comes back out.
  const googleView = () => ({
    configured: google!.configured,
    source: google!.source,
    redirectUri: googleRedirectUri(config),
    scopes: SCOPES,
    appName: "Danny",
  });
  app.get("/v1/admin/google", async () => googleView());

  app.put("/v1/admin/google", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (google!.source === "env") return reply.code(409).send({ error: "set_by_environment", message: "Google is set in the server's .env file, so it can't be changed here." });
    const body = z
      .object({
        clientId: z.string().trim().regex(/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i, "That doesn't look like a Google client ID. It ends in .apps.googleusercontent.com."),
        clientSecret: z.string().trim().min(10).max(200),
      })
      .parse(req.body);
    const cfg = { ...body, redirectUri: googleRedirectUri(config) };
    const verdict = await google!.checkCredentials(cfg);
    if (verdict === "bad") return reply.code(400).send({ error: "invalid_credentials", message: "Google didn't accept that ID and secret. Check you copied all of both, with no spaces." });
    if (verdict === "unreachable") return reply.code(502).send({ error: "google_unreachable", message: "Couldn't reach Google to check them. Try again in a minute." });
    await saveGoogleCredentials(db, vault, body);
    google!.configure(cfg, "app");
    const { workspaceId, userId } = req.auth!;
    await withTenant(db, workspaceId, (tx) => tx.insert(auditLog).values({ workspaceId, userId, action: "google.setup", detail: {} }));
    return googleView();
  });

  app.delete("/v1/admin/google", async (req, reply) => {
    if (google!.source === "env") return reply.code(409).send({ error: "set_by_environment", message: "Google is set in the server's .env file, so it can't be changed here." });
    await clearGoogleCredentials(db);
    google!.configure(null, "none");
    const { workspaceId, userId } = req.auth!;
    await withTenant(db, workspaceId, (tx) => tx.insert(auditLog).values({ workspaceId, userId, action: "google.clear", detail: {} }));
    return googleView();
  });

  // ---- API keys, typed into the app instead of editing .env. One box per entry in KEY_DEFS. A key goes in and never comes back out.
  const keysView = () => ({
    keys: KEY_DEFS.map((d) => ({ id: d.id, label: d.label, needed: d.needed, why: d.why, steps: d.steps, url: d.url, source: keys!.source(d.id) })),
  });
  app.get("/v1/admin/keys", async () => keysView());

  app.put("/v1/admin/keys/:id", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const def = KEY_DEFS.find((d) => d.id === id);
    if (!def) return reply.code(404).send({ error: "unknown_key" });
    if (keys!.source(id) === "env") return reply.code(409).send({ error: "set_by_environment", message: `${def.label} is set in the server's .env file, so it can't be changed here.` });
    const { value } = z.object({ value: z.string().trim().min(8).max(400).regex(/^\S+$/, "A key has no spaces. Check you copied just the key.") }).parse(req.body);
    const verdict = await def.check(value, fetchFn ?? fetch);
    if (verdict === "bad") return reply.code(400).send({ error: "invalid_key", message: `${def.label} didn't accept that key. Check you copied all of it.` });
    if (verdict === "unreachable") return reply.code(502).send({ error: "key_unreachable", message: `Couldn't reach ${def.label} to check it. Try again in a minute.` });
    await saveApiKey(db, vault, id, value);
    keys!.setSaved(id, value);
    const { workspaceId, userId } = req.auth!;
    await withTenant(db, workspaceId, (tx) => tx.insert(auditLog).values({ workspaceId, userId, action: "key.set", detail: { id } }));
    return keysView();
  });

  app.delete("/v1/admin/keys/:id", async (req, reply) => {
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const def = KEY_DEFS.find((d) => d.id === id);
    if (!def) return reply.code(404).send({ error: "unknown_key" });
    if (keys!.source(id) === "env") return reply.code(409).send({ error: "set_by_environment", message: `${def.label} is set in the server's .env file, so it can't be changed here.` });
    await clearApiKey(db, id);
    keys!.setSaved(id, null);
    const { workspaceId, userId } = req.auth!;
    await withTenant(db, workspaceId, (tx) => tx.insert(auditLog).values({ workspaceId, userId, action: "key.clear", detail: { id } }));
    return keysView();
  });

  // ---- Update, backup, checks and logs without SSH (see lib/ops.ts).
  const ops = new Ops(config.opsDir);

  app.get("/v1/admin/ops", async () => ops.view());

  app.post("/v1/admin/ops", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { action } = z.object({ action: z.enum(ACTIONS) }).parse(req.body);
    const r = await ops.request(action);
    if (r === "not_set_up") return reply.code(503).send({ error: "ops_not_set_up", message: "The Update and Backup buttons aren't turned on yet. Run danny ops-install once on the server." });
    if (r === "busy") return reply.code(409).send({ error: "busy", message: "Something is already running. Wait for it to finish." });
    const { workspaceId, userId } = req.auth!;
    await withTenant(db, workspaceId, (tx) => tx.insert(auditLog).values({ workspaceId, userId, action: `ops.${action}`, detail: {} }));
    return reply.code(202).send({ ok: true });
  });

  // Spend per user across all workspaces, via a read-only database function (see migration 0002).
  app.get("/v1/admin/usage", async () => {
    const rows = await db.execute<{ user_id: string; email: string; today_cost_micros: string; month_cost_micros: string }>(sql`select * from admin_usage()`);
    // What each person's requests really cost us (tokens, searches, speech), unrounded. Not what they were billed: that is rounded up to the cent.
    return {
      users: rows.map((r) => ({ userId: r.user_id, email: r.email, todayCostUsd: usd(Number(r.today_cost_micros)), last30DaysCostUsd: usd(Number(r.month_cost_micros)) })),
    };
  });
};
