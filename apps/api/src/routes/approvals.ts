import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import type { Vault } from "../lib/vault.js";
import { executeApproved } from "../brain/execute.js";
import { approvals, auditLog } from "../db/schema.js";

const STATUS = { approve: "approved", changes: "changes_requested", drop: "dropped" } as const;

// Approving records the decision. Only a tool with a real executor (like send_email, with an account linked) does anything
// outside the app, and only then is executedAt set. Every response says which happened, so no client can imply something was sent.
const view = (vault: Vault, a: typeof approvals.$inferSelect) => ({
  id: a.id,
  kind: a.kind,
  title: vault.open(a.workspaceId, a.titleEnc),
  payload: vault.openJson(a.workspaceId, a.payloadEnc),
  status: a.status,
  createdAt: a.createdAt,
  decidedAt: a.decidedAt,
  executed: a.executedAt !== null,
});

export const approvalRoutes: FastifyPluginAsync<Deps> = async (app, deps) => {
  const { db, vault } = deps;
  app.get("/v1/approvals", async (req) => {
    const { workspaceId } = req.auth!;
    const { status } = z.object({ status: z.enum(["pending", "approved", "changes_requested", "dropped"]).optional() }).parse(req.query);
    const rows = await withTenant(db, workspaceId, (tx) =>
      tx.select().from(approvals).where(status ? eq(approvals.status, status) : undefined).orderBy(desc(approvals.createdAt)).limit(200),
    );
    return { items: rows.map((r) => view(vault, r)) };
  });

  app.post("/v1/approvals", async (req, reply) => {
    const { workspaceId, userId } = req.auth!;
    const body = z
      .object({ kind: z.string().trim().min(1).max(40), title: z.string().trim().min(1).max(200), payload: z.record(z.string(), z.unknown()).default({}) })
      .parse(req.body);
    const row = await withTenant(db, workspaceId, async (tx) => {
      const [a] = await tx.insert(approvals).values({ workspaceId, userId, kind: body.kind, titleEnc: vault.seal(workspaceId, body.title), payloadEnc: vault.sealJson(workspaceId, body.payload) }).returning();
      await tx.insert(auditLog).values({ workspaceId, userId, action: "approval.request", detail: { id: a!.id, kind: body.kind } });
      return a!;
    });
    return reply.code(201).send({ item: view(vault, row) });
  });

  app.post("/v1/approvals/:id/decision", async (req, reply) => {
    const { workspaceId, userId } = req.auth!;
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { decision } = z.object({ decision: z.enum(["approve", "changes", "drop"]) }).parse(req.body);
    const row = await withTenant(db, workspaceId, async (tx) => {
      const [a] = await tx
        .update(approvals)
        .set({ status: STATUS[decision], decidedAt: new Date() })
        .where(and(eq(approvals.id, id), eq(approvals.status, "pending")))
        .returning();
      if (a) await tx.insert(auditLog).values({ workspaceId, userId, action: `approval.${decision}`, detail: { id } });
      return a;
    });
    if (!row) return reply.code(409).send({ error: "not_pending_or_not_found" });
    // The update above only matches a pending card, so a card can be released once and only once.
    if (decision !== "approve") return { item: view(vault, row), note: "Recorded. Nothing has been sent." };
    const out = await executeApproved(deps, { workspaceId, userId }, row, req.log);
    const [fresh] = await withTenant(db, workspaceId, (tx) => tx.select().from(approvals).where(eq(approvals.id, id)));
    return { item: view(vault, fresh ?? row), note: out.note };
  });
};
