import { eq } from "drizzle-orm";
import { withTenant } from "../db/client.js";
import { approvals, auditLog } from "../db/schema.js";
import { ToolUnavailable, type ToolCtx } from "../tools/registry.js";
import type { BrainDeps } from "./run.js";

/**
 * Called once, right after the user taps Approve. This is the only place an outside action can run.
 * Nothing here is reachable from chat or from a review: they can only create the card.
 * If a tool has no executor, or it fails, the approval stays recorded and executedAt stays empty, and the note says so.
 */
export async function executeApproved(
  deps: Pick<BrainDeps, "db" | "tools" | "vault">,
  who: { workspaceId: string; userId: string },
  a: typeof approvals.$inferSelect,
  log: { error: (e: unknown) => void } = { error: console.error },
): Promise<{ executed: boolean; note: string }> {
  const { db, tools, vault } = deps;
  const { workspaceId, userId } = who;
  const tool = tools.get(a.kind);
  if (tool?.kind !== "external_write" || !tool.execute) return { executed: false, note: "Recorded. Nothing has been sent." };

  const parsed = tool.input.safeParse(vault.openJson(workspaceId, a.payloadEnc));
  const audit = (action: string, detail: Record<string, unknown>) =>
    withTenant(db, workspaceId, (tx) => tx.insert(auditLog).values({ workspaceId, userId, action, detail: { id: a.id, tool: tool.name, ...detail } }));
  if (!parsed.success) {
    await audit("approval.execute_failed", { why: "bad_draft" });
    return { executed: false, note: "Approved, but the draft was malformed. Nothing was sent." };
  }

  const ctx: ToolCtx = { workspaceId, userId, db, vault, tenant: (fn) => withTenant(db, workspaceId, fn), actor: "user" };
  try {
    const result = await tool.execute(ctx, parsed.data);
    await withTenant(db, workspaceId, async (tx) => {
      await tx.update(approvals).set({ executedAt: new Date() }).where(eq(approvals.id, a.id));
      await tx.insert(auditLog).values({ workspaceId, userId, action: "approval.executed", detail: { id: a.id, tool: tool.name } });
    });
    return { executed: true, note: result };
  } catch (e) {
    if (e instanceof ToolUnavailable) {
      await audit("approval.execute_failed", { why: e.message });
      return { executed: false, note: `Approved. Nothing was sent: ${e.message}` };
    }
    log.error(e);
    await audit("approval.execute_failed", { why: "error" });
    return { executed: false, note: "Approved, but sending failed. Nothing was sent." };
  }
}
