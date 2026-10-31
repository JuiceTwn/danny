import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { auditLog, workspaces } from "../db/schema.js";
import { costToday, spentToday, todayUtc } from "../lib/spend.js";

const usd = (micros: number) => micros / 1_000_000;

export const settingsRoutes: FastifyPluginAsync<Deps> = async (app, { db, config, transcriber, keys, call }) => {
  // Everyone sees how much of today's allowance is used, as a percentage, like a chat app's usage meter. Only the owner sees dollars.
  async function read(workspaceId: string, isOwner: boolean) {
    return withTenant(db, workspaceId, async (tx) => {
      const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
      const spent = await spentToday(tx, workspaceId);
      const cost = isOwner ? await costToday(tx, workspaceId) : 0;
      const usedPercent = ws!.dailyCapMicros > 0 ? Math.min(100, Math.round((spent / ws!.dailyCapMicros) * 100)) : 100;
      const resetsAt = new Date(Date.parse(`${todayUtc()}T00:00:00Z`) + 86_400_000).toISOString();
      return {
        usedPercent,
        resetsAt,
        killSwitch: ws!.killSwitch,
        demo: !keys!.has("anthropic"),
        voiceTyping: Boolean(transcriber) || keys!.has("elevenlabs"),
        callMode: Boolean(call) || keys!.has("elevenlabs"),
        model: config.model,
        canSetCap: isOwner,
        ...(isOwner
          ? { dailyCapUsd: usd(ws!.dailyCapMicros), spentTodayUsd: usd(spent), costTodayUsd: usd(cost), priceInputPerMtokUsd: config.price.inputPerMtokUsd, priceOutputPerMtokUsd: config.price.outputPerMtokUsd }
          : {}),
      };
    });
  }

  app.get("/v1/settings", async (req) => read(req.auth!.workspaceId, req.auth!.isOwner));

  app.patch("/v1/settings", async (req, reply) => {
    const { workspaceId, userId, role, isOwner } = req.auth!;
    if (role !== "admin") return reply.code(403).send({ error: "admins_only" });
    const body = z
      .object({ dailyCapUsd: z.number().min(0).max(usd(config.maxDailyCapMicros)).optional(), killSwitch: z.boolean().optional() })
      .parse(req.body);
    // The daily allowance is the server owner's to set, and only for their own workspace. The stop switch stays everyone's.
    if (body.dailyCapUsd !== undefined && !isOwner) return reply.code(403).send({ error: "owner_only", message: "Only the owner can change the daily limit." });
    await withTenant(db, workspaceId, async (tx) => {
      const set: Partial<typeof workspaces.$inferInsert> = {};
      if (body.dailyCapUsd !== undefined) set.dailyCapMicros = Math.round(body.dailyCapUsd * 1_000_000);
      if (body.killSwitch !== undefined) set.killSwitch = body.killSwitch;
      if (Object.keys(set).length) {
        await tx.update(workspaces).set(set).where(eq(workspaces.id, workspaceId));
        await tx.insert(auditLog).values({ workspaceId, userId, action: "settings.update", detail: body });
      }
    });
    return read(workspaceId, isOwner);
  });
};
