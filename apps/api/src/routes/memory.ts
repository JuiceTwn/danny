import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { auditLog, memory } from "../db/schema.js";

export const memoryRoutes: FastifyPluginAsync<Deps> = async (app, { db, vault }) => {
  app.get("/v1/memory", async (req) => {
    const { workspaceId } = req.auth!;
    const rows = await withTenant(db, workspaceId, (tx) =>
      tx.select({ id: memory.id, contentEnc: memory.contentEnc, createdAt: memory.createdAt }).from(memory).orderBy(desc(memory.createdAt)),
    );
    return { items: rows.map((r) => ({ id: r.id, content: vault.open(workspaceId, r.contentEnc), createdAt: r.createdAt })) };
  });

  app.post("/v1/memory", async (req, reply) => {
    const { workspaceId, userId } = req.auth!;
    const { content } = z.object({ content: z.string().trim().min(1).max(1000) }).parse(req.body);
    const item = await withTenant(db, workspaceId, async (tx) => {
      const [row] = await tx.insert(memory).values({ workspaceId, userId, contentEnc: vault.seal(workspaceId, content) }).returning({ id: memory.id, createdAt: memory.createdAt });
      await tx.insert(auditLog).values({ workspaceId, userId, action: "memory.add", detail: { id: row!.id } });
      return { id: row!.id, content, createdAt: row!.createdAt };
    });
    return reply.code(201).send({ item });
  });

  // "Forget" deletes the row for real. It does not hide it.
  app.delete("/v1/memory/:id", async (req, reply) => {
    const { workspaceId, userId } = req.auth!;
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const gone = await withTenant(db, workspaceId, async (tx) => {
      const rows = await tx.delete(memory).where(and(eq(memory.id, id), eq(memory.workspaceId, workspaceId))).returning({ id: memory.id });
      if (rows.length) await tx.insert(auditLog).values({ workspaceId, userId, action: "memory.forget", detail: { id } });
      return rows.length > 0;
    });
    return gone ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });
};
