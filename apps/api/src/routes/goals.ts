import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { GoalError, listGoals, MAX_CHECK_HOURS, MIN_CHECK_HOURS, updateGoal } from "../lib/goals.js";
import type { Actor } from "../lib/tasks.js";

export const goalRoutes: FastifyPluginAsync<Deps> = async (app, { db, vault }) => {
  const actor = (req: { auth?: { workspaceId: string; userId: string } }): Actor => {
    const { workspaceId, userId } = req.auth!;
    return { workspaceId, userId, vault, tenant: (fn) => withTenant(db, workspaceId, fn) };
  };

  app.get("/v1/goals", async (req) => ({ items: await listGoals(actor(req)) }));

  // The user can pause, finish or stop watching a goal from the app. Making goals happens in chat.
  app.patch("/v1/goals/:id", async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z
      .object({ status: z.enum(["open", "paused", "done"]).optional(), checkEveryHours: z.number().int().min(MIN_CHECK_HOURS).max(MAX_CHECK_HOURS).nullable().optional() })
      .parse(req.body);
    try {
      const g = await updateGoal(actor(req), id, body);
      return g ? { item: g } : reply.code(404).send({ error: "not_found" });
    } catch (e) {
      if (e instanceof GoalError) return reply.code(400).send({ error: "invalid_request", message: e.message });
      throw e;
    }
  });
};
