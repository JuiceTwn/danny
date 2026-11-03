import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { auditLog, goalMilestones, goals, tasks, users } from "../db/schema.js";
import { checkRepeat, describeRepeatFull, firstSlot, nextRepeat, REPEAT_UNITS, RepeatError, type Repeat, type RepeatUnit } from "./recur.js";
import { snoozeTarget, type SnoozePreset } from "./time.js";
import type { Vault } from "./vault.js";

/** What task code needs to know about who is acting. A tool context fits this shape. */
export type Actor = { workspaceId: string; userId: string; vault: Vault; tenant: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> };

export type TaskView = { id: string; title: string; status: string; dueAt: string | null; remindAt: string | null; repeat: Repeat | null; repeatText: string | null; firstStep: string | null; snoozeCount: number; createdAt: string; goalId: string | null; goalTitle: string | null; milestoneId: string | null };

/** A message the user can fix and retry, as opposed to a bug. */
export class TaskError extends Error {}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const view = (vault: Vault, workspaceId: string, r: typeof tasks.$inferSelect): TaskView => ({
  id: r.id,
  title: vault.open(workspaceId, r.titleEnc),
  status: r.status,
  dueAt: iso(r.dueAt),
  remindAt: iso(r.remindAt),
  repeat: taskRepeat(r),
  repeatText: describeRepeatFull(taskRepeat(r)),
  firstStep: r.firstStepEnc ? vault.open(workspaceId, r.firstStepEnc) : null,
  snoozeCount: r.snoozeCount,
  createdAt: r.createdAt.toISOString(),
  goalId: r.goalId ?? null,
  goalTitle: null, // filled in by the callers that read the goal
  milestoneId: r.milestoneId ?? null,
});

type TenantTx = Parameters<Parameters<Actor["tenant"]>[0]>[0];

/** Check that a goal (and a milestone of it) belong to this person and are still being worked on, before a task is tied to them. */
export async function checkLink(tx: TenantTx, a: Pick<Actor, "userId">, goalId: string | null | undefined, milestoneId: string | null | undefined) {
  if (!goalId) {
    if (milestoneId) throw new TaskError("A milestone belongs to a goal: give the goal as well.");
    return;
  }
  const [g] = await tx.select({ id: goals.id, status: goals.status }).from(goals).where(and(eq(goals.id, goalId), eq(goals.userId, a.userId)));
  if (!g) throw new TaskError("No goal with that id.");
  if (g.status === "done") throw new TaskError("That goal is already done.");
  if (milestoneId) {
    const [m] = await tx.select({ id: goalMilestones.id }).from(goalMilestones).where(and(eq(goalMilestones.id, milestoneId), eq(goalMilestones.goalId, goalId), eq(goalMilestones.userId, a.userId)));
    if (!m) throw new TaskError("That milestone isn't part of that goal.");
  }
}

/** Fill in the goal title on tasks that serve a goal. */
async function withGoalTitles(a: Actor, tx: TenantTx, views: TaskView[]) {
  const ids = [...new Set(views.map((v) => v.goalId).filter((x): x is string => Boolean(x)))];
  if (!ids.length) return views;
  const rows = await tx.select({ id: goals.id, t: goals.titleEnc }).from(goals).where(inArray(goals.id, ids));
  const titles = new Map(rows.map((r) => [r.id, a.vault.open(a.workspaceId, r.t)]));
  return views.map((v) => (v.goalId ? { ...v, goalTitle: titles.get(v.goalId) ?? null } : v));
}

export async function createTask(a: Actor, input: { title: string; dueAt?: Date | null; remindAt?: Date | null; repeat?: Repeat | null; firstStep?: string | null; goalId?: string | null; milestoneId?: string | null }, now = new Date()) {
  let due = input.dueAt ?? null;
  let remind = input.remindAt ?? null;
  // A deadline with no explicit reminder reminds at the deadline.
  if (!remind && due && due.getTime() > now.getTime()) remind = due;
  if (remind && remind.getTime() < now.getTime() - 60_000) throw new TaskError("That reminder time has already passed. Pick a time in the future.");
  let repeat = input.repeat ?? null;
  if (repeat) {
    try {
      repeat = checkRepeat(repeat);
    } catch (e) {
      if (e instanceof RepeatError) throw new TaskError(e.message);
      throw e;
    }
  }
  // "Every day at 8, 2 and 8" needs no start: the first one is the next of those times.
  if (repeat?.times?.length && !due && !remind) {
    const [u] = await a.tenant((tx) => tx.select({ tz: users.timezone }).from(users).where(eq(users.id, a.userId)));
    const first = firstSlot(repeat, u?.tz ?? "UTC", now);
    if (first) due = remind = first;
  }
  if (repeat && !due && !remind) throw new TaskError("A repeating task needs a date or a reminder time to repeat from.");
  if (repeat?.until && (due ?? remind) && (due ?? remind)!.toISOString().slice(0, 10) > repeat.until) throw new TaskError("The end date is before the first one.");
  // Repeats step from the due date, because nudges and snoozes keep moving the reminder. With only a reminder time, that is the due date.
  const anchor = repeat ? (due ?? remind) : due;
  const leadMin = repeat && anchor && remind && remind < anchor ? Math.round((anchor.getTime() - remind.getTime()) / 60_000) : 0;
  return a.tenant(async (tx) => {
    await checkLink(tx, a, input.goalId, input.milestoneId);
    const [row] = await tx
      .insert(tasks)
      .values({
        goalId: input.goalId ?? null,
        milestoneId: input.goalId ? (input.milestoneId ?? null) : null,
        workspaceId: a.workspaceId,
        userId: a.userId,
        titleEnc: a.vault.seal(a.workspaceId, input.title),
        firstStepEnc: input.firstStep ? a.vault.seal(a.workspaceId, input.firstStep) : null,
        dueAt: anchor,
        remindAt: remind,
        repeatEvery: repeat?.every ?? null,
        repeatUnit: repeat?.unit ?? null,
        repeatTimes: repeat?.times?.join(",") ?? null,
        repeatDays: repeat?.days?.join(",") ?? null,
        repeatUntil: repeat?.until ?? null,
        repeatLeadMin: repeat ? leadMin : null,
      })
      .returning();
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "task.add", detail: { id: row!.id, ...(input.goalId ? { goal: input.goalId } : {}) } });
    return (await withGoalTitles(a, tx, [view(a.vault, a.workspaceId, row!)]))[0]!;
  });
}

export async function listTasks(a: Actor, status: "open" | "done" = "open") {
  const out = await a.tenant(async (tx) => {
    const rows = await tx.select().from(tasks).where(and(eq(tasks.userId, a.userId), eq(tasks.status, status)));
    return withGoalTitles(a, tx, rows.map((r) => view(a.vault, a.workspaceId, r)));
  });
  if (status === "done") return out.sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, 50);
  // Things with a deadline first, soonest first. Then the rest, oldest first.
  return out.sort((x, y) => {
    if (x.dueAt && y.dueAt) return x.dueAt.localeCompare(y.dueAt);
    if (x.dueAt) return -1;
    if (y.dueAt) return 1;
    return x.createdAt.localeCompare(y.createdAt);
  });
}

/** One task to do now. Overdue first, then soonest deadline, then oldest. List order already gives that. */
export function pickNext(open: TaskView[]) {
  return open[0] ?? null;
}

/**
 * Mark a task done. A repeating one stays open and moves to its next occurrence, so a chore finished late
 * does not leave a pile of missed days behind it. Returns null when there is no such open task.
 */
export type DoneGoal = { id: string; title: string; milestone: { id: string; title: string; status: string; otherOpenTasks: number } | null };

export async function completeTask(a: Actor, id: string, now = new Date()): Promise<{ next: string | null; ended: boolean; goal: DoneGoal | null } | null> {
  return a.tenant(async (tx) => {
    const [t] = await tx.select().from(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, a.userId), eq(tasks.status, "open"))).for("update");
    if (!t) return null;
    const repeat = taskRepeat(t);
    let next: string | null = null;
    let ended = false;
    if (repeat) {
      const [u] = await tx.select({ tz: users.timezone }).from(users).where(eq(users.id, a.userId));
      const tz = u?.tz ?? "UTC";
      // Step from the due date and keep the same lead ("a week before"). The next reminder must also be in the future.
      const lead = (t.repeatLeadMin ?? 0) * 60_000;
      let dueAt = nextRepeat(t.dueAt ?? t.remindAt ?? now, repeat, tz, now);
      while (dueAt && dueAt.getTime() - lead <= now.getTime()) dueAt = nextRepeat(dueAt, repeat, tz, now);
      if (dueAt) {
        await tx.update(tasks).set({ dueAt, remindAt: new Date(dueAt.getTime() - lead), nudgeCount: 0, snoozeCount: 0 }).where(eq(tasks.id, id));
        next = dueAt.toISOString();
      } else {
        // It has reached its end date: this was the last one.
        await tx.update(tasks).set({ status: "done", remindAt: null, completedAt: now }).where(eq(tasks.id, id));
        ended = true;
      }
    } else {
      await tx.update(tasks).set({ status: "done", remindAt: null, completedAt: now }).where(eq(tasks.id, id));
    }
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "task.done", detail: { id, ...(next ? { next } : {}), ...(ended ? { ended: true } : {}) } });

    // A step toward a goal is progress on the goal, so the goal is not "quiet" and Danny doesn't ask what's in the way.
    let goal: DoneGoal | null = null;
    if (t.goalId) {
      const [g] = await tx.update(goals).set({ touchedAt: now, stallNudgedAt: null }).where(eq(goals.id, t.goalId)).returning({ id: goals.id, t: goals.titleEnc });
      if (g) {
        let milestone: DoneGoal["milestone"] = null;
        if (t.milestoneId) {
          const [m] = await tx.select({ id: goalMilestones.id, t: goalMilestones.titleEnc, status: goalMilestones.status }).from(goalMilestones).where(eq(goalMilestones.id, t.milestoneId));
          if (m) {
            const left = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.milestoneId, m.id), eq(tasks.status, "open")));
            milestone = { id: m.id, title: a.vault.open(a.workspaceId, m.t), status: m.status, otherOpenTasks: left.filter((x) => x.id !== id).length };
          }
        }
        goal = { id: g.id, title: a.vault.open(a.workspaceId, g.t), milestone };
      }
    }
    return { next, ended, goal };
  });
}

export const taskRepeat = (r: typeof tasks.$inferSelect): Repeat | null =>
  r.repeatEvery && REPEAT_UNITS.includes(r.repeatUnit as RepeatUnit)
    ? {
        every: r.repeatEvery,
        unit: r.repeatUnit as RepeatUnit,
        ...(r.repeatTimes ? { times: r.repeatTimes.split(",") } : {}),
        ...(r.repeatDays ? { days: r.repeatDays.split(",").map(Number) } : {}),
        ...(r.repeatUntil ? { until: r.repeatUntil } : {}),
      }
    : null;

/** Push the next nudge to `until` and start the escalation over. */
export async function snoozeTask(a: Actor, id: string, until: Date, now = new Date()) {
  if (until.getTime() <= now.getTime()) throw new TaskError("Snooze has to end in the future.");
  return a.tenant(async (tx) => {
    const rows = await tx
      .update(tasks)
      .set({ remindAt: until, nudgeCount: 0, snoozeCount: sql`${tasks.snoozeCount} + 1` })
      .where(and(eq(tasks.id, id), eq(tasks.userId, a.userId), eq(tasks.status, "open")))
      .returning({ id: tasks.id });
    if (rows.length) await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "task.snooze", detail: { id, until: until.toISOString() } });
    return rows.length > 0;
  });
}

/** Give a task its smallest first move, or clear it with null. Returns false when there is no such open task. */
export async function setFirstStep(a: Actor, id: string, step: string | null) {
  return a.tenant(async (tx) => {
    const rows = await tx
      .update(tasks)
      .set({ firstStepEnc: step ? a.vault.seal(a.workspaceId, step) : null })
      .where(and(eq(tasks.id, id), eq(tasks.userId, a.userId), eq(tasks.status, "open")))
      .returning({ id: tasks.id });
    if (rows.length) await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "task.first_step", detail: { id } });
    return rows.length > 0;
  });
}

/** Where a snooze preset lands for this person, or null when it makes no sense right now. */
export async function presetTime(a: Actor, preset: SnoozePreset, now = new Date()) {
  const [u] = await a.tenant((tx) => tx.select({ tz: users.timezone, qs: users.quietStart, qe: users.quietEnd }).from(users).where(eq(users.id, a.userId)));
  return snoozeTarget(preset, now, u?.tz ?? "UTC", { start: u?.qs ?? 22, end: u?.qe ?? 7 });
}

export async function deleteTask(a: Actor, id: string) {
  return a.tenant(async (tx) => {
    const rows = await tx.delete(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, a.userId))).returning({ id: tasks.id });
    if (rows.length) await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "task.delete", detail: { id } });
    return rows.length > 0;
  });
}

/** Tie an open task to a goal (and optionally one of its milestones), or untie it with goalId null. Returns false when there is no such open task. */
export async function linkTask(a: Actor, id: string, goalId: string | null, milestoneId: string | null = null) {
  return a.tenant(async (tx) => {
    await checkLink(tx, a, goalId, milestoneId);
    const rows = await tx
      .update(tasks)
      .set({ goalId, milestoneId: goalId ? milestoneId : null })
      .where(and(eq(tasks.id, id), eq(tasks.userId, a.userId), eq(tasks.status, "open")))
      .returning({ id: tasks.id });
    if (rows.length) await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "task.link", detail: { id, goal: goalId, milestone: milestoneId } });
    return rows.length > 0;
  });
}
