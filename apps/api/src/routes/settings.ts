import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { auditLog, workspaces } from "../db/schema.js";
import { spentToday } from "../lib/spend.js";

const usd = (micros: number) => micros / 1_000_000;

export const settingsRoutes: FastifyPluginAsync<Deps> = async (app, { db, config }) => {
  async function read(workspaceId: string) {
    return withTenant(db, workspaceId, async (tx) => {
      const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
      const spent = await spentToday(tx, workspaceId);
      return { dailyCapUsd: usd(ws!.dailyCapMicros), killSwitch: ws!.killSwitch, spentTodayUsd: usd(spent), model: config.model, demo: !config.anthropicApiKey, priceInputPerMtokUsd: config.price.inputPerMtokUsd, priceOutputPerMtokUsd: config.price.outputPerMtokUsd };
    });
  }

  app.get("/v1/settings", async (req) => read(req.auth!.workspaceId));

  app.patch("/v1/settings", async (req, reply) => {
    const { workspaceId, userId, role } = req.auth!;
    if (role !== "admin") return reply.code(403).send({ error: "admins_only" });
    const body = z
      .object({ dailyCapUsd: z.number().min(0).max(usd(config.maxDailyCapMicros)).optional(), killSwitch: z.boolean().optional() })
      .parse(req.body);
    await withTenant(db, workspaceId, async (tx) => {
      const set: Partial<typeof workspaces.$inferInsert> = {};
      if (body.dailyCapUsd !== undefined) set.dailyCapMicros = Math.round(body.dailyCapUsd * 1_000_000);
      if (body.killSwitch !== undefined) set.killSwitch = body.killSwitch;
      if (Object.keys(set).length) {
        await tx.update(workspaces).set(set).where(eq(workspaces.id, workspaceId));
        await tx.insert(auditLog).values({ workspaceId, userId, action: "settings.update", detail: body });
      }
    });
    return read(workspaceId);
  });
};
