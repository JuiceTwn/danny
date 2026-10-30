import { desc, eq, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { emailSchema } from "../lib/validation.js";
import type { Deps } from "../app.js";
import { inviteRequests, invites } from "../db/schema.js";
import { newToken, sha256 } from "../lib/crypto.js";

const usd = (micros: number) => micros / 1_000_000;

// Server-owner tools. Invite-only signup: nobody gets in until the owner approves them here.
export const adminRoutes: FastifyPluginAsync<Deps> = async (app, { db, config }) => {
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
    return { items };
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

  // Spend per user across all workspaces, via a read-only database function (see migration 0002).
  app.get("/v1/admin/usage", async () => {
    const rows = await db.execute<{ user_id: string; email: string; today_micros: string; month_micros: string }>(sql`select * from admin_usage()`);
    return { users: rows.map((r) => ({ userId: r.user_id, email: r.email, todayUsd: usd(Number(r.today_micros)), last30DaysUsd: usd(Number(r.month_micros)) })) };
  });
};
