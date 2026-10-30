import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { auditLog, workspaces } from "../db/schema.js";
import { agentRunsToday } from "../brain/agent.js";
import { spentToday } from "../lib/spend.js";

const usd = (micros: number) => micros / 1_000_000;

export const settingsRoutes: FastifyPluginAsync<Deps> = async (app, { db, config }) => {
  async function read(workspaceId: string) {
    const runsToday = await agentRunsToday(db, workspaceId);
    return withTenant(db, workspaceId, async (tx) => {
      const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
      const spent = await spentToday(tx, workspaceId);
      return {
        dailyCapUsd: usd(ws!.dailyCapMicros),
        killSwitch: ws!.killSwitch,
        spentTodayUsd: usd(spent),
        // Whether Danny may review goals and draft on his own, and how often.
        agentEnabled: ws!.agentEnabled,
        agentRunsPerDay: ws!.agentRunsPerDay,
        agentRunsToday: runsToday,
        agentLastRunAt: ws!.agentLastRunAt,
        // Honest about the scheduler: it only runs if the server was started with a model key and a tick interval.
        schedulerOn: config.agentTickMs > 0 && !!config.anthropicApiKey,
      };
    });
  }

  app.get("/v1/settings", async (req) => read(req.auth!.workspaceId));

  app.patch("/v1/settings", async (req, reply) => {
    const { workspaceId, userId, role } = req.auth!;
    if (role !== "admin") return reply.code(403).send({ error: "admins_only" });
    const body = z
      .object({
        dailyCapUsd: z.number().min(0).max(usd(config.maxDailyCapMicros)).optional(),
        killSwitch: z.boolean().optional(),
        agentEnabled: z.boolean().optional(),
        agentRunsPerDay: z.number().int().min(1).max(24).optional(),
      })
      .parse(req.body);
    await withTenant(db, workspaceId, async (tx) => {
      const set: Partial<typeof workspaces.$inferInsert> = {};
      if (body.dailyCapUsd !== undefined) set.dailyCapMicros = Math.round(body.dailyCapUsd * 1_000_000);
      if (body.killSwitch !== undefined) set.killSwitch = body.killSwitch;
      if (body.agentEnabled !== undefined) set.agentEnabled = body.agentEnabled;
      if (body.agentRunsPerDay !== undefined) set.agentRunsPerDay = body.agentRunsPerDay;
      if (Object.keys(set).length) {
        await tx.update(workspaces).set(set).where(eq(workspaces.id, workspaceId));
        await tx.insert(auditLog).values({ workspaceId, userId, action: "settings.update", detail: body });
      }
    });
    return read(workspaceId);
  });
};
