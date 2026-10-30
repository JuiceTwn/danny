import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { forgetAllLearned, listStyle, MAX_INSTRUCTION, removeNote, setSingle } from "../lib/style.js";
import type { Actor } from "../lib/tasks.js";

export const styleRoutes: FastifyPluginAsync<Deps> = async (app, { db, vault }) => {
  const actor = (req: { auth?: { workspaceId: string; userId: string } }): Actor => {
    const { workspaceId, userId } = req.auth!;
    return { workspaceId, userId, vault, tenant: (fn) => withTenant(db, workspaceId, fn) };
  };

  // Everything Danny knows about how this person likes to be helped. Nothing here is hidden from them.
  app.get("/v1/style", async (req) => listStyle(actor(req)));

  app.put("/v1/style/instruction", async (req) => {
    const { text } = z.object({ text: z.string().max(MAX_INSTRUCTION) }).parse(req.body);
    await setSingle(actor(req), "instruction", text);
    return listStyle(actor(req));
  });

  app.put("/v1/style/location", async (req) => {
    const { text } = z.object({ text: z.string().max(80) }).parse(req.body);
    await setSingle(actor(req), "location", text);
    return listStyle(actor(req));
  });

  app.delete("/v1/style/notes/:id", async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return (await removeNote(actor(req), id)) ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });

  app.delete("/v1/style/notes", async (req) => ({ removed: await forgetAllLearned(actor(req)) }));
};
