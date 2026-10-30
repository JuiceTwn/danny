import { and, desc, eq, or } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import type { Vault } from "../lib/vault.js";
import { approvals, auditLog } from "../db/schema.js";
import { ExecError, type ToolCtx, type ToolRegistry } from "../tools/registry.js";

const STATUS = { approve: "approved", changes: "changes_requested", drop: "dropped" } as const;

// Approving runs the tool's executor, if it has one (send_email does). Cards for tools with no executor are
// recorded only. Either way the response says exactly what happened, so no client can imply that something was sent.
const view = (vault: Vault, tools: ToolRegistry, a: typeof approvals.$inferSelect) => ({
  id: a.id,
  kind: a.kind,
  title: vault.open(a.workspaceId, a.titleEnc),
  payload: vault.openJson(a.workspaceId, a.payloadEnc),
  status: a.status,
  createdAt: a.createdAt,
  decidedAt: a.decidedAt,
  executed: a.executedAt !== null,
  // Will approving actually do something outside the app?
  canExecute: tools.get(a.kind)?.execute !== undefined,
  execution: a.execution, // null | running | done | failed | unknown
  executionNote: a.executionNote,
});

export const approvalRoutes: FastifyPluginAsync<Deps> = async (app, { db, vault, tools, google }) => {
  app.get("/v1/approvals", async (req) => {
    const { workspaceId } = req.auth!;
    const { status } = z.object({ status: z.enum(["pending", "approved", "changes_requested", "dropped"]).optional() }).parse(req.query);
    const rows = await withTenant(db, workspaceId, (tx) =>
      tx.select().from(approvals).where(status ? eq(approvals.status, status) : undefined).orderBy(desc(approvals.createdAt)).limit(200),
    );
    return { items: rows.map((r) => view(vault, tools, r)) };
  });

  app.post("/v1/approvals", async (req, reply) => {
    const { workspaceId, userId } = req.auth!;
    const body = z
      .object({ kind: z.string().trim().min(1).max(40), title: z.string().trim().min(1).max(200), payload: z.record(z.string(), z.unknown()).default({}) })
      .parse(req.body);
    // Cards that do something when approved come only from the tool itself, through the chat loop, never from a hand-made request.
    if (tools.get(body.kind)?.execute) return reply.code(400).send({ error: "invalid_request", message: "That kind of card can only be created by Danny." });
    const row = await withTenant(db, workspaceId, async (tx) => {
      const [a] = await tx.insert(approvals).values({ workspaceId, userId, kind: body.kind, titleEnc: vault.seal(workspaceId, body.title), payloadEnc: vault.sealJson(workspaceId, body.payload) }).returning();
      await tx.insert(auditLog).values({ workspaceId, userId, action: "approval.request", detail: { id: a!.id, kind: body.kind } });
      return a!;
    });
    return reply.code(201).send({ item: view(vault, tools, row) });
  });

  app.post("/v1/approvals/:id/decision", async (req, reply) => {
    const { workspaceId, userId } = req.auth!;
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { decision } = z.object({ decision: z.enum(["approve", "changes", "drop"]) }).parse(req.body);

    const [current] = await withTenant(db, workspaceId, (tx) => tx.select().from(approvals).where(eq(approvals.id, id)));
    if (!current) return reply.code(409).send({ error: "not_pending_or_not_found" });
    const exec = decision === "approve" ? tools.get(current.kind)?.execute : undefined;

    // Claim it in one atomic step. Two taps, or two devices, can never both win, so nothing runs twice.
    // The only way back in is approving again after a failure that is known to have done nothing.
    const claimed = await withTenant(db, workspaceId, async (tx) => {
      const [a] = await tx
        .update(approvals)
        .set({ status: STATUS[decision], decidedAt: new Date(), ...(exec ? { execution: "running", executionNote: null } : {}) })
        .where(
          and(
            eq(approvals.id, id),
            decision === "approve" && exec
              ? or(eq(approvals.status, "pending"), and(eq(approvals.status, "approved"), eq(approvals.execution, "failed")))
              : eq(approvals.status, "pending"),
          ),
        )
        .returning();
      if (a) await tx.insert(auditLog).values({ workspaceId, userId, action: `approval.${decision}`, detail: { id } });
      return a;
    });
    if (!claimed) return reply.code(409).send({ error: "not_pending_or_not_found" });
    if (!exec) return { item: view(vault, tools, claimed), note: "Recorded. Nothing has been sent." };

    const ctx: ToolCtx = { workspaceId, userId, db, vault, google, tenant: (fn) => withTenant(db, workspaceId, fn) };
    let outcome: { execution: "done" | "failed" | "unknown"; note: string };
    try {
      // The tool's own input rules apply again here, whatever is stored on the card.
      const input = tools.get(claimed.kind)!.input.safeParse(vault.openJson(workspaceId, claimed.payloadEnc));
      if (!input.success) throw new ExecError("This card's content isn't valid, so nothing was sent.", "failed");
      outcome = { execution: "done", note: await exec(ctx, input.data) };
    } catch (e) {
      if (e instanceof ExecError) outcome = { execution: e.kind, note: e.message };
      else {
        req.log.error(e);
        outcome = { execution: "unknown", note: "Something went wrong. It may have gone through, so check before trying again." };
      }
    }
    const row = await withTenant(db, workspaceId, async (tx) => {
      const [a] = await tx
        .update(approvals)
        .set({ execution: outcome.execution, executionNote: outcome.execution === "done" ? null : outcome.note, executedAt: outcome.execution === "done" ? new Date() : null })
        .where(eq(approvals.id, id))
        .returning();
      await tx.insert(auditLog).values({ workspaceId, userId, action: "approval.execute", detail: { id, kind: claimed.kind, result: outcome.execution } });
      return a!;
    });
    const note = outcome.execution === "done" ? outcome.note : outcome.execution === "failed" ? `Didn't send. ${outcome.note}` : `Not confirmed. ${outcome.note}`;
    return { item: view(vault, tools, row), note };
  });
};
