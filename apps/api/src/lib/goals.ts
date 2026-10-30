import { and, asc, eq, ne } from "drizzle-orm";
import { auditLog, goals } from "../db/schema.js";
import type { Actor } from "./tasks.js";

export const MAX_OPEN_GOALS = 10;
export const MAX_MONITORED = 5;
export const MIN_CHECK_HOURS = 6;
export const MAX_CHECK_HOURS = 168;

export type GoalView = {
  id: string;
  title: string;
  notes: string | null;
  watchQuery: string | null;
  checkEveryHours: number | null;
  status: string;
  lastCheckedAt: string | null;
  lastFinding: string | null;
};

/** A message the user can fix and retry, as opposed to a bug. */
export class GoalError extends Error {}

export const goalView = (a: Pick<Actor, "vault">, workspaceId: string, r: typeof goals.$inferSelect): GoalView => ({
  id: r.id,
  title: a.vault.open(workspaceId, r.titleEnc),
  notes: r.notesEnc ? a.vault.open(workspaceId, r.notesEnc) : null,
  watchQuery: r.watchQueryEnc ? a.vault.open(workspaceId, r.watchQueryEnc) : null,
  checkEveryHours: r.checkEveryHours,
  status: r.status,
  lastCheckedAt: r.lastCheckedAt ? r.lastCheckedAt.toISOString() : null,
  lastFinding: r.lastFindingEnc ? a.vault.open(workspaceId, r.lastFindingEnc) : null,
});

export type GoalInput = { title: string; notes?: string | null; watchQuery?: string | null; checkEveryHours?: number | null };

export async function createGoal(a: Actor, i: GoalInput) {
  return a.tenant(async (tx) => {
    const open = await tx.select({ id: goals.id, hours: goals.checkEveryHours }).from(goals).where(and(eq(goals.userId, a.userId), eq(goals.status, "open")));
    if (open.length >= MAX_OPEN_GOALS) throw new GoalError(`There are already ${MAX_OPEN_GOALS} open goals. Finish or pause one first.`);
    if (i.checkEveryHours && open.filter((g) => g.hours).length >= MAX_MONITORED) throw new GoalError(`Only ${MAX_MONITORED} goals can be watched at once. Stop watching one first.`);
    const [row] = await tx
      .insert(goals)
      .values({
        workspaceId: a.workspaceId,
        userId: a.userId,
        titleEnc: a.vault.seal(a.workspaceId, i.title),
        notesEnc: i.notes ? a.vault.seal(a.workspaceId, i.notes) : null,
        watchQueryEnc: i.watchQuery ? a.vault.seal(a.workspaceId, i.watchQuery) : null,
        checkEveryHours: i.checkEveryHours ?? null,
      })
      .returning();
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "goal.add", detail: { id: row!.id } });
    return goalView(a, a.workspaceId, row!);
  });
}

export async function listGoals(a: Actor, status?: "open" | "paused" | "done") {
  return a.tenant(async (tx) => {
    const rows = await tx
      .select()
      .from(goals)
      .where(and(eq(goals.userId, a.userId), status ? eq(goals.status, status) : ne(goals.status, "done")))
      .orderBy(asc(goals.createdAt));
    return rows.map((r) => goalView(a, a.workspaceId, r));
  });
}

export type GoalPatch = Partial<GoalInput> & { status?: "open" | "paused" | "done" };

export async function updateGoal(a: Actor, id: string, p: GoalPatch) {
  return a.tenant(async (tx) => {
    const [cur] = await tx.select().from(goals).where(and(eq(goals.id, id), eq(goals.userId, a.userId)));
    if (!cur) return null;
    const set: Partial<typeof goals.$inferInsert> = {};
    const seal = (v: string | null) => (v ? a.vault.seal(a.workspaceId, v) : null);
    if (p.title !== undefined) set.titleEnc = a.vault.seal(a.workspaceId, p.title);
    if (p.notes !== undefined) set.notesEnc = seal(p.notes);
    if (p.watchQuery !== undefined) set.watchQueryEnc = seal(p.watchQuery);
    if (p.status !== undefined) set.status = p.status;
    if (p.checkEveryHours !== undefined) {
      if (p.checkEveryHours) {
        const monitored = await tx.select({ id: goals.id, hours: goals.checkEveryHours }).from(goals).where(and(eq(goals.userId, a.userId), eq(goals.status, "open")));
        if (!cur.checkEveryHours && monitored.filter((g) => g.hours && g.id !== id).length >= MAX_MONITORED) throw new GoalError(`Only ${MAX_MONITORED} goals can be watched at once. Stop watching one first.`);
      }
      set.checkEveryHours = p.checkEveryHours;
    }
    if (!Object.keys(set).length) return goalView(a, a.workspaceId, cur);
    const [row] = await tx.update(goals).set(set).where(eq(goals.id, id)).returning();
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "goal.update", detail: { id, fields: Object.keys(p) } });
    return goalView(a, a.workspaceId, row!);
  });
}
