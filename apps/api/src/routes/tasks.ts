import { and, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { auditLog, pushSubscriptions, users } from "../db/schema.js";
import { isAllowedPushEndpoint } from "../lib/push.js";
import { completeTask, createTask, deleteTask, listTasks, snoozeTask, TaskError, type Actor } from "../lib/tasks.js";
import { isValidTimezone } from "../lib/time.js";
import { VOICES, type Voice } from "../lib/voice.js";

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const minutesOf = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24 hour");

type PrefRow = { briefingEnabled: boolean; briefingMinute: number; wrapupEnabled: boolean; wrapupMinute: number; voice: string };
export const prefsView = (u: PrefRow) => ({
  briefingEnabled: u.briefingEnabled,
  briefingTime: hhmm(u.briefingMinute),
  wrapupEnabled: u.wrapupEnabled,
  wrapupTime: hhmm(u.wrapupMinute),
  voice: u.voice,
});
export const prefColumns = { briefingEnabled: users.briefingEnabled, briefingMinute: users.briefingMinute, wrapupEnabled: users.wrapupEnabled, wrapupMinute: users.wrapupMinute, voice: users.voice };

const when = z.iso.datetime({ offset: true });

export const taskRoutes: FastifyPluginAsync<Deps> = async (app, { db, vault, push }) => {
  const actor = (req: { auth?: { workspaceId: string; userId: string } }): Actor => {
    const { workspaceId, userId } = req.auth!;
    return { workspaceId, userId, vault, tenant: (fn) => withTenant(db, workspaceId, fn) };
  };
  const id = (req: { params: unknown }) => z.object({ id: z.uuid() }).parse(req.params).id;

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof TaskError) return reply.code(400).send({ error: "invalid_request", message: err.message });
    throw err;
  });

  app.get("/v1/tasks", async (req) => {
    const { status } = z.object({ status: z.enum(["open", "done"]).default("open") }).parse(req.query);
    return { items: await listTasks(actor(req), status) };
  });

  app.post("/v1/tasks", async (req, reply) => {
    const b = z.object({ title: z.string().trim().min(1).max(300), dueAt: when.nullish(), remindAt: when.nullish() }).parse(req.body);
    const item = await createTask(actor(req), { title: b.title, dueAt: b.dueAt ? new Date(b.dueAt) : null, remindAt: b.remindAt ? new Date(b.remindAt) : null });
    return reply.code(201).send({ item });
  });

  app.post("/v1/tasks/:id/done", async (req, reply) => ((await completeTask(actor(req), id(req))) ? { ok: true } : reply.code(404).send({ error: "not_found" })));

  app.post("/v1/tasks/:id/snooze", async (req, reply) => {
    const b = z
      .union([z.object({ minutes: z.number().int().min(1).max(60 * 24 * 14) }), z.object({ until: when })])
      .parse(req.body);
    const until = "minutes" in b ? new Date(Date.now() + b.minutes * 60_000) : new Date(b.until);
    return (await snoozeTask(actor(req), id(req), until)) ? { ok: true, remindAt: until.toISOString() } : reply.code(404).send({ error: "not_found" });
  });

  app.delete("/v1/tasks/:id", async (req, reply) => ((await deleteTask(actor(req), id(req))) ? { ok: true } : reply.code(404).send({ error: "not_found" })));

  // ---- Push ----

  app.get("/v1/push/key", async () => ({ publicKey: push.publicKey }));

  app.post("/v1/push/subscribe", async (req, reply) => {
    const { workspaceId, userId } = req.auth!;
    if (!push.publicKey) return reply.code(503).send({ error: "push_not_configured" });
    const sub = z
      .object({ endpoint: z.url().max(1000), keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }) })
      .parse(req.body);
    if (!isAllowedPushEndpoint(sub.endpoint)) return reply.code(400).send({ error: "invalid_request", message: "That isn't a push service address." });
    await withTenant(db, workspaceId, async (tx) => {
      // Re-subscribing from the same browser replaces the old row.
      await tx.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, sub.endpoint)));
      await tx.insert(pushSubscriptions).values({ workspaceId, userId, endpoint: sub.endpoint, subEnc: vault.sealJson(workspaceId, sub) });
      await tx.insert(auditLog).values({ workspaceId, userId, action: "push.subscribe", detail: {} });
    });
    return reply.code(201).send({ ok: true });
  });

  app.post("/v1/push/unsubscribe", async (req) => {
    const { workspaceId, userId } = req.auth!;
    const { endpoint } = z.object({ endpoint: z.string().max(1000) }).parse(req.body);
    await withTenant(db, workspaceId, async (tx) => {
      const rows = await tx.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId))).returning({ id: pushSubscriptions.id });
      if (rows.length) await tx.insert(auditLog).values({ workspaceId, userId, action: "push.unsubscribe", detail: {} });
    });
    return { ok: true };
  });

  // ---- The user's own timezone: reminders, quiet hours and "tomorrow" all follow it ----

  app.patch("/v1/profile", async (req, reply) => {
    const { userId, workspaceId } = req.auth!;
    const body = z
      .object({
        timezone: z.string().max(64).optional(),
        briefingEnabled: z.boolean().optional(),
        briefingTime: clock.optional(),
        wrapupEnabled: z.boolean().optional(),
        wrapupTime: clock.optional(),
        voice: z.enum(Object.keys(VOICES) as [Voice, ...Voice[]]).optional(),
      })
      .parse(req.body);
    if (body.timezone !== undefined && !isValidTimezone(body.timezone)) return reply.code(400).send({ error: "invalid_request", message: "Unknown timezone." });
    const set: Partial<typeof users.$inferInsert> = {};
    if (body.timezone !== undefined) set.timezone = body.timezone;
    if (body.briefingEnabled !== undefined) set.briefingEnabled = body.briefingEnabled;
    if (body.briefingTime !== undefined) set.briefingMinute = minutesOf(body.briefingTime);
    if (body.wrapupEnabled !== undefined) set.wrapupEnabled = body.wrapupEnabled;
    if (body.wrapupTime !== undefined) set.wrapupMinute = minutesOf(body.wrapupTime);
    if (body.voice !== undefined) set.voice = body.voice;
    if (Object.keys(set).length) {
      await db.update(users).set(set).where(eq(users.id, userId));
      const { timezone: _tz, ...prefs } = body;
      if (Object.keys(prefs).length) await withTenant(db, workspaceId, (tx) => tx.insert(auditLog).values({ workspaceId, userId, action: "profile.preferences", detail: prefs }));
    }
    const [u] = await db.select({ timezone: users.timezone, ...prefColumns }).from(users).where(eq(users.id, userId));
    return { timezone: u!.timezone, ...prefsView(u!) };
  });
};
