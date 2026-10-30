import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { auditLog, connections } from "../db/schema.js";

// Linked accounts. The secret (an API key or token) goes in encrypted and never comes back out:
// no endpoint returns it. Only server-side tool code can read it, through readConnectionSecret.
export const connectionRoutes: FastifyPluginAsync<Deps> = async (app, { db, vault }) => {
  app.get("/v1/connections", async (req) => {
    const { workspaceId } = req.auth!;
    const items = await withTenant(db, workspaceId, (tx) =>
      tx
        .select({ id: connections.id, provider: connections.provider, label: connections.label, status: connections.status, createdAt: connections.createdAt })
        .from(connections)
        .orderBy(desc(connections.createdAt)),
    );
    return { items };
  });

  app.post("/v1/connections", async (req, reply) => {
    const { workspaceId, userId, role } = req.auth!;
    if (role !== "admin") return reply.code(403).send({ error: "admins_only" });
    const body = z
      .object({ provider: z.string().trim().min(1).max(40), label: z.string().trim().max(100).default(""), secret: z.string().min(1).max(8000) })
      .parse(req.body);
    const item = await withTenant(db, workspaceId, async (tx) => {
      const [c] = await tx
        .insert(connections)
        .values({ workspaceId, provider: body.provider, label: body.label, secretEnc: vault.seal(workspaceId, body.secret) })
        .returning({ id: connections.id, provider: connections.provider, label: connections.label, status: connections.status, createdAt: connections.createdAt });
      await tx.insert(auditLog).values({ workspaceId, userId, action: "connection.add", detail: { id: c!.id, provider: body.provider } });
      return c!;
    });
    return reply.code(201).send({ item });
  });

  app.delete("/v1/connections/:id", async (req, reply) => {
    const { workspaceId, userId, role } = req.auth!;
    if (role !== "admin") return reply.code(403).send({ error: "admins_only" });
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const gone = await withTenant(db, workspaceId, async (tx) => {
      const rows = await tx.delete(connections).where(and(eq(connections.id, id), eq(connections.workspaceId, workspaceId))).returning({ id: connections.id });
      if (rows.length) await tx.insert(auditLog).values({ workspaceId, userId, action: "connection.remove", detail: { id } });
      return rows.length > 0;
    });
    return gone ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });
};
