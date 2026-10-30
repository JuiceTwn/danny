import { and, eq, gte, sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { requestLog, workspaces } from "../db/schema.js";
import { checkBudget, levelOf, monthStartUtc } from "../lib/spend.js";

const usd = (micros: number) => micros / 1_000_000;

// The user's own month: what they spent against their cap, and which models answered. Same data the owner sees, for one person.
export const usageRoutes: FastifyPluginAsync<Deps> = async (app, { db }) => {
  app.get("/v1/usage", async (req) => {
    const { workspaceId } = req.auth!;
    return withTenant(db, workspaceId, async (tx) => {
      const since = new Date(`${monthStartUtc()}T00:00:00Z`);
      const rows = await tx
        .select({
          tier: requestLog.tier,
          requests: sql<number>`count(*)::int`,
          costMicros: sql<string>`coalesce(sum(${requestLog.costMicros}), 0)`,
          answerBetter: sql<number>`count(*) filter (where ${requestLog.retryOf} is not null)::int`,
          downshifted: sql<number>`count(*) filter (where ${requestLog.downshifted})::int`,
          escalated: sql<number>`count(*) filter (where ${requestLog.escalated})::int`,
        })
        .from(requestLog)
        .where(and(gte(requestLog.at, since), eq(requestLog.workspaceId, workspaceId), sql`${requestLog.status} <> 'blocked'`))
        .groupBy(requestLog.tier);
      const b = await checkBudget(tx, workspaceId);
      const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
      const level = b.ok ? b.level : levelOf(b.spentMicros, b.capMicros, b.monthMicros, b.monthCapMicros);
      return {
        month: { spentUsd: usd(b.monthMicros), capUsd: usd(ws!.monthlyCapMicros) },
        today: { spentUsd: usd(b.spentMicros), capUsd: usd(ws!.dailyCapMicros) },
        // near: requests drop one tier. critical: Haiku only. At 100% Danny stops until the cap resets or is raised.
        budgetLevel: level,
        byTier: rows.map((r) => ({ tier: r.tier, requests: r.requests, costUsd: usd(Number(r.costMicros)), answerBetter: r.answerBetter, downshifted: r.downshifted, escalated: r.escalated })),
      };
    });
  });
};
