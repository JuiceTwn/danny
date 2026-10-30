import { briefingView } from "./tasks.js";
import { and, eq, gt, isNull } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { emailSchema } from "../lib/validation.js";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { auditLog, inviteRequests, invites, memberships, sessions, users, workspaces } from "../db/schema.js";
import { dummyHash, hashPassword, newToken, sha256, verifyPassword } from "../lib/crypto.js";

export const COOKIE = "danny_session";
export type AuthCtx = { sessionId: string; userId: string; workspaceId: string; isOwner: boolean; role: string };

const password = z.string().min(10, "Use at least 10 characters").max(200);
const email = emailSchema;

export async function loadSession({ db }: Deps, req: FastifyRequest): Promise<AuthCtx | null> {
  const token = req.cookies[COOKIE];
  if (!token) return null;
  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      workspaceId: sessions.workspaceId,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      isOwner: users.isOwner,
      disabledAt: users.disabledAt,
      role: memberships.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(memberships, and(eq(memberships.userId, sessions.userId), eq(memberships.workspaceId, sessions.workspaceId)))
    .where(eq(sessions.tokenHash, sha256(token)));
  if (!row || row.disabledAt || row.expiresAt < new Date()) return null;
  if (Date.now() - row.lastSeenAt.getTime() > 5 * 60_000) {
    await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.id, row.sessionId));
  }
  return { sessionId: row.sessionId, userId: row.userId, workspaceId: row.workspaceId, isOwner: row.isOwner, role: row.role };
}

async function startSession({ db, config }: Deps, reply: FastifyReply, userId: string, workspaceId: string) {
  const token = newToken();
  const expiresAt = new Date(Date.now() + config.sessionDays * 86_400_000);
  await db.insert(sessions).values({ userId, workspaceId, tokenHash: sha256(token), expiresAt });
  reply.setCookie(COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

export const authRoutes: FastifyPluginAsync<Deps> = async (app, deps) => {
  const { db } = deps;

  app.post("/v1/auth/accept-invite", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({ token: z.string().min(10).max(200), password, name: z.string().trim().max(100).default("") }).parse(req.body);
    const [invite] = await db
      .select()
      .from(invites)
      .where(and(eq(invites.tokenHash, sha256(body.token)), isNull(invites.acceptedAt), gt(invites.expiresAt, new Date())));
    if (!invite) return reply.code(400).send({ error: "invite_invalid_or_expired" });

    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, invite.email));
    if (taken) return reply.code(409).send({ error: "account_exists" });

    const passwordHash = await hashPassword(body.password);
    const { userId, workspaceId } = await db.transaction(async (tx) => {
      // Claim the invite first so two simultaneous requests cannot both use it.
      const claimed = await tx
        .update(invites)
        .set({ acceptedAt: new Date() })
        .where(and(eq(invites.id, invite.id), isNull(invites.acceptedAt)))
        .returning({ id: invites.id });
      if (claimed.length === 0) throw Object.assign(new Error("invite_invalid_or_expired"), { statusCode: 400 });
      const [u] = await tx.insert(users).values({ email: invite.email, name: body.name, passwordHash }).returning({ id: users.id });
      const [w] = await tx
        .insert(workspaces)
        .values({ name: body.name ? `${body.name}'s Danny` : "My Danny", dailyCapMicros: deps.config.defaultDailyCapMicros })
        .returning({ id: workspaces.id });
      await tx.insert(memberships).values({ workspaceId: w!.id, userId: u!.id, role: "admin" });
      await tx.update(inviteRequests).set({ status: "approved" }).where(eq(inviteRequests.email, invite.email));
      return { userId: u!.id, workspaceId: w!.id };
    });
    await withTenant(db, workspaceId, (tx) => tx.insert(auditLog).values({ workspaceId, userId, action: "account.created" }));
    await startSession(deps, reply, userId, workspaceId);
    return reply.code(201).send({ ok: true });
  });

  app.post("/v1/auth/login", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = z.object({ email, password: z.string().min(1).max(200) }).parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.email, body.email));
    const ok = await verifyPassword(user?.passwordHash ?? (await dummyHash()), body.password);
    if (!user || !ok || user.disabledAt) return reply.code(401).send({ error: "wrong_email_or_password" });
    const [m] = await db.select().from(memberships).where(eq(memberships.userId, user.id)).limit(1);
    if (!m) return reply.code(403).send({ error: "no_workspace" });
    await startSession(deps, reply, user.id, m.workspaceId);
    await withTenant(db, m.workspaceId, (tx) => tx.insert(auditLog).values({ workspaceId: m.workspaceId, userId: user.id, action: "login" }));
    return { ok: true };
  });

  app.post("/v1/auth/logout", async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
    reply.clearCookie(COOKIE, { path: "/" });
    return { ok: true };
  });

  app.get("/v1/me", async (req, reply) => {
    const auth = await loadSession(deps, req);
    if (!auth) return reply.code(401).send({ error: "unauthorized" });
    const [u] = await db.select({ id: users.id, email: users.email, name: users.name, timezone: users.timezone, briefingEnabled: users.briefingEnabled, briefingMinute: users.briefingMinute }).from(users).where(eq(users.id, auth.userId));
    const { briefingMinute, ...rest } = u!;
    return { user: { ...rest, ...briefingView({ briefingEnabled: rest.briefingEnabled, briefingMinute }) }, workspaceId: auth.workspaceId, role: auth.role, isOwner: auth.isOwner };
  });
};
