import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { addMemory, forgetMemory, KINDS, patchMemory, readAll, recentlyTidied, restoreMemory, MAX_FACT, type MemoryView } from "../lib/memory.js";
import type { Actor } from "../lib/tasks.js";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2027-03-31");
const api = (m: MemoryView) => ({ id: m.id, content: m.fact, kind: m.kind, subject: m.subject, pinned: m.pinned, source: m.source, expiresOn: m.expiresAt?.slice(0, 10) ?? null, expired: m.expired, createdAt: m.createdAt, updatedAt: m.updatedAt });

export const memoryRoutes: FastifyPluginAsync<Deps> = async (app, { db, vault }) => {
  const actor = (req: { auth?: { workspaceId: string; userId: string } }): Actor => {
    const { workspaceId, userId } = req.auth!;
    return { workspaceId, userId, vault, tenant: (fn) => withTenant(db, workspaceId, fn) };
  };

  // Live notes, plus anything tidied in the last two weeks so it can be put back.
  app.get("/v1/memory", async (req) => {
    const a = actor(req);
    const [items, tidied] = await Promise.all([a.tenant((tx) => readAll(tx, vault, a.workspaceId, a.userId)), recentlyTidied(a)]);
    return {
      items: items.map(api),
      tidied: tidied.map((m) => ({ ...api(m), archived: !!m.archivedAt, reason: m.archivedReason, previous: m.previous })),
    };
  });

  app.post("/v1/memory", async (req, reply) => {
    const body = z
      .object({ content: z.string().trim().min(1).max(MAX_FACT), kind: z.enum(KINDS).optional(), subject: z.string().trim().max(80).optional(), pinned: z.boolean().optional(), expiresOn: day.optional() })
      .parse(req.body);
    const r = await addMemory(actor(req), { fact: body.content, kind: body.kind, subject: body.subject, pinned: body.pinned, expiresOn: body.expiresOn }, { source: "app" });
    if (r.status === "full") return reply.code(400).send({ error: "invalid_request", message: "Memory is full. Forget something first." });
    if (r.status === "missing") return reply.code(404).send({ error: "not_found" });
    return reply.code(r.status === "added" ? 201 : 200).send({ item: api(r.item) });
  });

  app.patch("/v1/memory/:id", async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const body = z
      .object({ content: z.string().trim().min(1).max(MAX_FACT).optional(), kind: z.enum(KINDS).optional(), subject: z.string().trim().max(80).nullable().optional(), pinned: z.boolean().optional(), expiresOn: day.nullable().optional() })
      .parse(req.body);
    const m = await patchMemory(actor(req), id, { fact: body.content, kind: body.kind, subject: body.subject, pinned: body.pinned, expiresOn: body.expiresOn });
    return m ? { item: api(m) } : reply.code(404).send({ error: "not_found" });
  });

  // "Forget" deletes the row for real. It does not hide it.
  app.delete("/v1/memory/:id", async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return (await forgetMemory(actor(req), id)) ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });

  app.post("/v1/memory/:id/restore", async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const m = await restoreMemory(actor(req), id);
    return m ? { item: api(m) } : reply.code(404).send({ error: "not_found" });
  });
};
