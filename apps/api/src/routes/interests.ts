import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { addInterest, InterestError, listInterests, removeInterest } from "../lib/interests.js";
import type { Actor } from "../lib/tasks.js";

export const interestRoutes: FastifyPluginAsync<Deps> = async (app, { db, vault }) => {
  const actor = (req: { auth?: { workspaceId: string; userId: string } }): Actor => {
    const { workspaceId, userId } = req.auth!;
    return { workspaceId, userId, vault, tenant: (fn) => withTenant(db, workspaceId, fn) };
  };

  app.get("/v1/interests", async (req) => ({ items: await listInterests(actor(req)) }));

  app.post("/v1/interests", async (req, reply) => {
    const { topic } = z.object({ topic: z.string().trim().min(2).max(80) }).parse(req.body);
    try {
      return reply.code(201).send({ item: await addInterest(actor(req), topic) });
    } catch (e) {
      if (e instanceof InterestError) return reply.code(400).send({ error: "invalid_request", message: e.message });
      throw e;
    }
  });

  app.delete("/v1/interests/:id", async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return (await removeInterest(actor(req), id)) ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });
};
