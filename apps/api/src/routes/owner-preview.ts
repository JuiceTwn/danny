import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { auditLog, memberships, sessions, users, workspaces } from "../db/schema.js";
import { hashPassword, newToken, sha256 } from "../lib/crypto.js";
import { NEW_ACCOUNT_DEFAULTS, welcome } from "../lib/onboarding.js";
import { COOKIE, OWNER_RETURN_COOKIE, startSession } from "./auth.js";

/** A preview lasts at most this long if the owner forgets to go back. */
const PREVIEW_MS = 12 * 3_600_000;

/**
 * "See Danny as a new person". The owner gets a throwaway account made exactly the way a new signup is made (same defaults, same welcome, an empty
 * workspace), signed in on this device. Their own session is kept aside in a second httpOnly cookie, so going back is one click and needs no password.
 * The throwaway account can't log in with a password, can't reach the owner tools, and is deleted, with everything in it, when they go back.
 */
export const ownerPreviewRoutes: FastifyPluginAsync<Deps> = async (app, deps) => {
  const { db, vault, config } = deps;

  /** Remove a preview account for good: its workspace (and so everything in it, sessions included), then the account. */
  const erase = async (previewUserId: string) => {
    const ws = (await db.select({ id: memberships.workspaceId }).from(memberships).where(eq(memberships.userId, previewUserId))).map((m) => m.id);
    if (ws.length) await db.delete(workspaces).where(inArray(workspaces.id, ws));
    await db.delete(users).where(and(eq(users.id, previewUserId), isNotNull(users.previewOf)));
  };

  const cookieOpts = (expires: Date) => ({ httpOnly: true, secure: config.cookieSecure, sameSite: "lax" as const, path: "/", expires });

  app.post("/v1/preview/start", async (req, reply) => {
    const auth = req.auth!;
    if (!auth.isOwner) return reply.code(403).send({ error: "owner_only" });
    const ownerToken = req.cookies[COOKIE];
    if (!ownerToken) return reply.code(401).send({ error: "unauthorized" });
    const [owner] = await db.select({ name: users.name, timezone: users.timezone }).from(users).where(eq(users.id, auth.userId));

    // One preview at a time, and always from scratch.
    for (const old of await db.select({ id: users.id }).from(users).where(eq(users.previewOf, auth.userId))) await erase(old.id);

    const first = (owner?.name ?? "").split(" ")[0] ?? "";
    const { userId, workspaceId } = await db.transaction(async (tx) => {
      const [u] = await tx
        .insert(users)
        .values({ email: `preview-${newToken().slice(0, 12).toLowerCase().replace(/[^a-z0-9]/g, "x")}@preview.invalid`, name: first, passwordHash: await hashPassword(newToken()), timezone: owner?.timezone, previewOf: auth.userId, ...NEW_ACCOUNT_DEFAULTS })
        .returning({ id: users.id });
      const [w] = await tx.insert(workspaces).values({ name: "Preview", dailyCapMicros: config.defaultDailyCapMicros }).returning({ id: workspaces.id });
      await tx.insert(memberships).values({ workspaceId: w!.id, userId: u!.id, role: "admin" });
      return { userId: u!.id, workspaceId: w!.id };
    });
    await withTenant(db, workspaceId, (tx) => tx.insert(auditLog).values({ workspaceId, userId, action: "account.created", detail: { preview: true } }));
    await welcome(db, vault, workspaceId, userId, first);
    await withTenant(db, auth.workspaceId, (tx) => tx.insert(auditLog).values({ workspaceId: auth.workspaceId, userId: auth.userId, action: "preview.start", detail: {} }));

    // Keep the owner's own session aside, then sign in as the preview account.
    const [mine] = await db.select({ expiresAt: sessions.expiresAt }).from(sessions).where(eq(sessions.tokenHash, sha256(ownerToken)));
    reply.setCookie(OWNER_RETURN_COOKIE, ownerToken, cookieOpts(mine?.expiresAt ?? new Date(Date.now() + PREVIEW_MS)));
    await startSession(deps, reply, userId, workspaceId, PREVIEW_MS);
    return { ok: true };
  });

  // Back to the owner's own account. Works from the preview account only, and only with the owner's kept-aside session still valid.
  app.post("/v1/preview/stop", async (req, reply) => {
    const auth = req.auth!;
    const [me] = await db.select({ previewOf: users.previewOf }).from(users).where(eq(users.id, auth.userId));
    if (!me?.previewOf) return reply.code(400).send({ error: "not_previewing" });
    const kept = req.cookies[OWNER_RETURN_COOKIE];

    let back: Date | null = null;
    if (kept) {
      const [row] = await db
        .select({ expiresAt: sessions.expiresAt, userId: sessions.userId, isOwner: users.isOwner, disabledAt: users.disabledAt })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.tokenHash, sha256(kept)));
      if (row && row.userId === me.previewOf && row.isOwner && !row.disabledAt && row.expiresAt > new Date()) back = row.expiresAt;
    }

    const token = req.cookies[COOKIE];
    if (token) await db.delete(sessions).where(eq(sessions.tokenHash, sha256(token)));
    reply.clearCookie(OWNER_RETURN_COOKIE, { path: "/" });
    if (back && kept) {
      reply.setCookie(COOKIE, kept, cookieOpts(back));
    } else {
      reply.clearCookie(COOKIE, { path: "/" });
    }
    await erase(auth.userId);
    if (back) {
      const [m] = await db.select({ workspaceId: memberships.workspaceId }).from(memberships).where(eq(memberships.userId, me.previewOf)).limit(1);
      if (m) await withTenant(db, m.workspaceId, (tx) => tx.insert(auditLog).values({ workspaceId: m.workspaceId, userId: me.previewOf!, action: "preview.stop", detail: {} }));
    }
    return { ok: true, signedOut: !back };
  });
};

