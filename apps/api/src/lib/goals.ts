import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { auditLog, goalSteps, goals } from "../db/schema.js";
import type { Vault } from "./vault.js";

export const MAX_ACTIVE_GOALS = 12;
export const MAX_STEPS_PER_GOAL = 15;
const DAY = 86_400_000;

export const GOAL_STATUS = ["active", "done", "dropped"] as const;
export const STEP_STATUS = ["todo", "doing", "done", "blocked"] as const;
export type GoalStatus = (typeof GOAL_STATUS)[number];
export type StepStatus = (typeof STEP_STATUS)[number];

export type Who = { workspaceId: string; userId: string };
export type StepView = { id: string; text: string; status: StepStatus; dueAt: Date | null };
export type GoalView = {
  id: string;
  title: string;
  notes: string;
  status: GoalStatus;
  createdBy: string;
  dueAt: Date | null;
  nextReviewAt: Date;
  lastReviewedAt: Date | null;
  steps: StepView[];
};

/** Thrown for problems the caller (a person or the model) should hear about in plain words. */
export class GoalError extends Error {}

const inDays = (days: number, now = Date.now()) => new Date(now + days * DAY);

export async function listGoals(tx: Tx, vault: Vault, workspaceId: string, opts: { closed?: boolean } = {}): Promise<GoalView[]> {
  const rows = await tx
    .select()
    .from(goals)
    .where(opts.closed ? undefined : eq(goals.status, "active"))
    .orderBy(asc(goals.nextReviewAt))
    .limit(100);
  if (!rows.length) return [];
  const steps = await tx
    .select()
    .from(goalSteps)
    .where(inArray(goalSteps.goalId, rows.map((g) => g.id)))
    .orderBy(asc(goalSteps.position), asc(goalSteps.createdAt));
  return rows.map((g) => ({
    id: g.id,
    title: vault.open(workspaceId, g.titleEnc),
    notes: vault.open(workspaceId, g.notesEnc),
    status: g.status as GoalStatus,
    createdBy: g.createdBy,
    dueAt: g.dueAt,
    nextReviewAt: g.nextReviewAt,
    lastReviewedAt: g.lastReviewedAt,
    steps: steps
      .filter((s) => s.goalId === g.id)
      .map((s) => ({ id: s.id, text: vault.open(workspaceId, s.textEnc), status: s.status as StepStatus, dueAt: s.dueAt })),
  }));
}

export async function createGoal(
  tx: Tx,
  vault: Vault,
  who: Who,
  g: { title: string; notes?: string; dueAt?: Date | null; reviewInDays?: number; steps?: { text: string; dueAt?: Date | null }[]; createdBy: "user" | "danny" },
) {
  const [{ n }] = (await tx.select({ n: sql<number>`count(*)::int` }).from(goals).where(eq(goals.status, "active"))) as [{ n: number }];
  if (n >= MAX_ACTIVE_GOALS) throw new GoalError(`Already tracking ${MAX_ACTIVE_GOALS} active goals. Finish or drop one first.`);
  const steps = (g.steps ?? []).slice(0, MAX_STEPS_PER_GOAL);
  const soonest = [g.dueAt, ...steps.map((s) => s.dueAt)].filter((d): d is Date => !!d).sort((a, b) => a.getTime() - b.getTime())[0];
  // First look: tomorrow, or sooner if something is due before then.
  const planned = inDays(g.reviewInDays ?? 1);
  const nextReviewAt = soonest && soonest < planned ? soonest : planned;
  const [row] = await tx
    .insert(goals)
    .values({
      workspaceId: who.workspaceId,
      userId: who.userId,
      titleEnc: vault.seal(who.workspaceId, g.title),
      notesEnc: vault.seal(who.workspaceId, g.notes ?? ""),
      createdBy: g.createdBy,
      dueAt: g.dueAt ?? null,
      nextReviewAt,
    })
    .returning({ id: goals.id });
  if (steps.length) {
    await tx.insert(goalSteps).values(
      steps.map((s, i) => ({ workspaceId: who.workspaceId, goalId: row!.id, textEnc: vault.seal(who.workspaceId, s.text), dueAt: s.dueAt ?? null, position: i })),
    );
  }
  await tx.insert(auditLog).values({ workspaceId: who.workspaceId, userId: who.userId, action: "goal.create", detail: { id: row!.id, by: g.createdBy } });
  return row!.id;
}

export async function updateGoal(
  tx: Tx,
  vault: Vault,
  who: Who,
  id: string,
  patch: { title?: string; notes?: string; status?: GoalStatus; dueAt?: Date | null; reviewInDays?: number },
  by: "user" | "danny",
) {
  const set: Partial<typeof goals.$inferInsert> = { updatedAt: new Date() };
  if (patch.title !== undefined) set.titleEnc = vault.seal(who.workspaceId, patch.title);
  if (patch.notes !== undefined) set.notesEnc = vault.seal(who.workspaceId, patch.notes);
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;
  if (patch.reviewInDays !== undefined) set.nextReviewAt = inDays(patch.reviewInDays);
  // The boss reopening a goal means "look at this now".
  if (patch.status === "active" && by === "user") set.nextReviewAt = new Date();
  const rows = await tx.update(goals).set(set).where(eq(goals.id, id)).returning({ id: goals.id });
  if (!rows.length) return false;
  await tx.insert(auditLog).values({ workspaceId: who.workspaceId, userId: who.userId, action: "goal.update", detail: { id, by, status: patch.status } });
  return true;
}

export async function addSteps(tx: Tx, vault: Vault, who: Who, goalId: string, steps: { text: string; dueAt?: Date | null }[]) {
  const [goal] = await tx.select({ id: goals.id }).from(goals).where(eq(goals.id, goalId));
  if (!goal) return false;
  const [{ n, max }] = (await tx
    .select({ n: sql<number>`count(*)::int`, max: sql<number>`coalesce(max(${goalSteps.position}), -1)::int` })
    .from(goalSteps)
    .where(eq(goalSteps.goalId, goalId))) as [{ n: number; max: number }];
  if (n + steps.length > MAX_STEPS_PER_GOAL) throw new GoalError(`A goal holds at most ${MAX_STEPS_PER_GOAL} steps. Mark some done, or split this into a second goal.`);
  await tx.insert(goalSteps).values(
    steps.map((s, i) => ({ workspaceId: who.workspaceId, goalId, textEnc: vault.seal(who.workspaceId, s.text), dueAt: s.dueAt ?? null, position: max + 1 + i })),
  );
  await tx.update(goals).set({ updatedAt: new Date() }).where(eq(goals.id, goalId));
  return true;
}

export async function updateStep(
  tx: Tx,
  vault: Vault,
  who: Who,
  stepId: string,
  patch: { status?: StepStatus; text?: string; dueAt?: Date | null },
  goalId?: string,
) {
  const set: Partial<typeof goalSteps.$inferInsert> = { updatedAt: new Date() };
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.text !== undefined) set.textEnc = vault.seal(who.workspaceId, patch.text);
  if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;
  const rows = await tx
    .update(goalSteps)
    .set(set)
    .where(and(eq(goalSteps.id, stepId), goalId ? eq(goalSteps.goalId, goalId) : undefined))
    .returning({ id: goalSteps.id, goalId: goalSteps.goalId });
  return rows[0] ?? null;
}

/** Goals whose review time has come. This is the free check that decides whether Danny wakes up at all. */
export async function dueGoalCount(tx: Tx, now = new Date()) {
  const [{ n }] = (await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(goals)
    .where(and(eq(goals.status, "active"), sql`${goals.nextReviewAt} <= ${now.toISOString()}::timestamptz`))) as [{ n: number }];
  return n;
}

/** After a review, push back any goal that was due and that Danny did not reschedule himself, so one stale goal can't wake him every tick. */
export async function settleReviewed(tx: Tx, startedAt: Date, now = new Date()) {
  await tx
    .update(goals)
    .set({ lastReviewedAt: now, nextReviewAt: inDays(1, now.getTime()) })
    .where(and(eq(goals.status, "active"), sql`${goals.nextReviewAt} <= ${startedAt.toISOString()}::timestamptz`));
}

