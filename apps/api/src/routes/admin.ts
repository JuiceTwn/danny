import { access, constants, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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

const usd = (micros: number) => micros / 1_000_000;

// Server-owner tools. Invite-only signup: nobody gets in until the owner approves them here.
export const adminRoutes: FastifyPluginAsync<Deps> = async (app, { db, config, vault, google, keys, fetchFn }) => {
  app.addHook("preHandler", async (req, reply) => {
    if (!req.auth?.isOwner) return reply.code(403).send({ error: "owner_only" });
  });

  async function createInvite(email: string, createdBy: string) {
    const token = newToken();
    await db.insert(invites).values({ email, tokenHash: sha256(token), createdBy, expiresAt: new Date(Date.now() + 7 * 86_400_000) });
    // Email sending is not built yet, so the owner gets the link and passes it on.
    return { inviteUrl: `${config.appUrl}/accept?token=${token}`, expiresInDays: 7 };
  }

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

  // ---- Update and backup without SSH. The app never runs anything: it drops an empty file named check, backup or update
  // in a folder, and a root-owned script on the server (deploy/ops.sh, started by a systemd path unit) does the work.
  // It writes the results to a folder the app can only read. See docs/DEPLOY.md.
  const ACTIONS = ["check", "backup", "update"] as const;
  const requests = join(config.opsDir, "requests");
  const status = join(config.opsDir, "status");
  const read = async <T>(name: string, fallback: T): Promise<T> => {
    try {
      return JSON.parse(await readFile(join(status, name), "utf8")) as T;
    } catch {
      return fallback;
    }
  };
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : null);
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

  async function opsView() {
    const writable = await access(requests, constants.W_OK).then(() => true, () => false);
    const readable = await access(join(status, "repo.json"), constants.R_OK).then(() => true, () => false);
    const last = await read<Record<string, unknown> | null>("last.json", null);
    const repo = await read<Record<string, unknown>>("repo.json", {});
    const backups = await read<unknown[]>("backups.json", []);
    const pending = writable ? (await readdir(requests).catch(() => [])).filter((f) => (ACTIONS as readonly string[]).includes(f)) : [];
    const started = typeof last?.startedAt === "string" ? Date.parse(last.startedAt) : NaN;
    // A request that never finished (the server rebooted mid-update) should not lock the buttons forever.
    const running = last?.state === "running" && Number.isFinite(started) && Date.now() - started < 45 * 60_000;
    return {
      available: writable && readable,
      busy: running || pending.length > 0,
      pending,
      last: last && { action: s(last.action, 20), state: s(last.state, 20), startedAt: s(last.startedAt, 40), finishedAt: s(last.finishedAt, 40), summary: s(last.summary, 4000) },
      version: s(repo.version, 40),
      branch: s(repo.branch, 80),
      behind: n(repo.behind),
      changes: Array.isArray(repo.changes) ? repo.changes.slice(0, 10).map((c) => s(c, 140) ?? "") : [],
      checkedAt: s(repo.checkedAt, 40),
      backups: (Array.isArray(backups) ? backups : []).slice(0, 5).map((b: any) => ({ name: s(b?.name, 80), bytes: n(b?.bytes), at: s(b?.at, 40) })),
    };
  }

  app.get("/v1/admin/ops", async () => opsView());

  app.post("/v1/admin/ops", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { action } = z.object({ action: z.enum(ACTIONS) }).parse(req.body);
    const view = await opsView();
    if (!view.available) return reply.code(503).send({ error: "ops_not_set_up", message: "The Update and Backup buttons aren't turned on yet. Run danny ops-install once on the server." });
    if (view.busy) return reply.code(409).send({ error: "busy", message: "Something is already running. Wait for it to finish." });
    try {
      await writeFile(join(requests, action), "", { flag: "wx" });
    } catch {
      return reply.code(409).send({ error: "busy", message: "That was already asked for." });
    }
    const { workspaceId, userId } = req.auth!;
    await withTenant(db, workspaceId, (tx) => tx.insert(auditLog).values({ workspaceId, userId, action: `ops.${action}`, detail: {} }));
    return reply.code(202).send({ ok: true });
  });

  // Spend per user across all workspaces, via a read-only database function (see migration 0002).
  app.get("/v1/admin/usage", async () => {
    const rows = await db.execute<{ user_id: string; email: string; today_micros: string; month_micros: string; month_exact_micros: string }>(sql`select * from admin_usage()`);
    // todayUsd and last30DaysUsd are what was billed (every request rounded up to the cent). last30DaysCostUsd is what the requests really cost us.
    return {
      users: rows.map((r) => ({
        userId: r.user_id,
        email: r.email,
        todayUsd: usd(Number(r.today_micros)),
        last30DaysUsd: usd(Number(r.month_micros)),
        last30DaysCostUsd: usd(Number(r.month_exact_micros)),
      })),
    };
  });
};
