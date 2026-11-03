import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { auditLog, goalMilestones, goals, tasks, users } from "../db/schema.js";
import { localIso } from "./time.js";
import type { Actor } from "./tasks.js";
import type { Vault } from "./vault.js";

export const MAX_OPEN_GOALS = 10;
export const MAX_MONITORED = 5;
export const MIN_CHECK_HOURS = 6;
export const MAX_CHECK_HOURS = 168;
export const MAX_MILESTONES = 12;

export type MilestoneView = { id: string; title: string; position: number; dueOn: string | null; status: "open" | "done" };

export type GoalView = {
  id: string;
  title: string;
  notes: string | null;
  /** "By when", a calendar date, or null. */
  targetDate: string | null;
  /** The steps, in order. Filled in by `withPlans`; empty until then. */
  milestones: MilestoneView[];
  /** Open tasks linked to this goal. Filled in by `withPlans`. */
  openTasks: number;
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
  targetDate: r.targetDate ?? null,
  milestones: [],
  openTasks: 0,
  watchQuery: r.watchQueryEnc ? a.vault.open(workspaceId, r.watchQueryEnc) : null,
  checkEveryHours: r.checkEveryHours,
  status: r.status,
  lastCheckedAt: r.lastCheckedAt ? r.lastCheckedAt.toISOString() : null,
  lastFinding: r.lastFindingEnc ? a.vault.open(workspaceId, r.lastFindingEnc) : null,
});

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A calendar date in YYYY-MM-DD that exists, or an error the user can fix. */
export function checkDate(d: string, what: string) {
  if (!DATE.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`)) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) throw new GoalError(`${what} has to be a real date like 2027-03-01.`);
  return d;
}

export type MilestoneInput = { title: string; dueOn?: string | null };
export type GoalInput = { title: string; notes?: string | null; watchQuery?: string | null; checkEveryHours?: number | null; targetDate?: string | null; milestones?: MilestoneInput[] };

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
        targetDate: i.targetDate ? checkDate(i.targetDate, "The target date") : null,
      })
      .returning();
    if (i.milestones?.length) await insertMilestones(tx, a, row!.id, i.milestones, 0);
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "goal.add", detail: { id: row!.id, milestones: i.milestones?.length ?? 0 } });
    return (await withPlans(tx, a, [goalView(a, a.workspaceId, row!)]))[0]!;
  });
}

export async function listGoals(a: Actor, status?: "open" | "paused" | "done") {
  return a.tenant(async (tx) => {
    const rows = await tx
      .select()
      .from(goals)
      .where(and(eq(goals.userId, a.userId), status ? eq(goals.status, status) : ne(goals.status, "done")))
      .orderBy(asc(goals.createdAt));
    return withPlans(tx, a, rows.map((r) => goalView(a, a.workspaceId, r)));
  });
}

export type GoalPatch = Partial<GoalInput> & { status?: "open" | "paused" | "done" };

export async function updateGoal(a: Actor, id: string, p: GoalPatch) {
  return a.tenant(async (tx) => {
    const [cur] = await tx.select().from(goals).where(and(eq(goals.id, id), eq(goals.userId, a.userId)));
    if (!cur) return null;
    const set: Partial<typeof goals.$inferInsert> = {};
    const seal = (v: string | null) => (v ? a.vault.seal(a.workspaceId, v) : null);
    set.touchedAt = new Date(); // any change counts as the user working on it
    if (p.title !== undefined) set.titleEnc = a.vault.seal(a.workspaceId, p.title);
    if (p.notes !== undefined) set.notesEnc = seal(p.notes);
    if (p.watchQuery !== undefined) set.watchQueryEnc = seal(p.watchQuery);
    if (p.status !== undefined) set.status = p.status;
    if (p.targetDate !== undefined) set.targetDate = p.targetDate ? checkDate(p.targetDate, "The target date") : null;
    if (p.checkEveryHours !== undefined) {
      if (p.checkEveryHours) {
        const monitored = await tx.select({ id: goals.id, hours: goals.checkEveryHours }).from(goals).where(and(eq(goals.userId, a.userId), eq(goals.status, "open")));
        if (!cur.checkEveryHours && monitored.filter((g) => g.hours && g.id !== id).length >= MAX_MONITORED) throw new GoalError(`Only ${MAX_MONITORED} goals can be watched at once. Stop watching one first.`);
      }
      set.checkEveryHours = p.checkEveryHours;
    }
    const [row] = await tx.update(goals).set(set).where(eq(goals.id, id)).returning();
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "goal.update", detail: { id, fields: Object.keys(p) } });
    return (await withPlans(tx, a, [goalView(a, a.workspaceId, row!)]))[0]!;
  });
}

/** Record that the user did something on a goal. Keeps the last few notes, newest last, so the plan stays readable. */
export async function logProgress(a: Actor, id: string, note: string, now = new Date()) {
  return a.tenant(async (tx) => {
    const [cur] = await tx.select().from(goals).where(and(eq(goals.id, id), eq(goals.userId, a.userId)));
    if (!cur) return null;
    const old = cur.notesEnc ? a.vault.open(a.workspaceId, cur.notesEnc) : "";
    const next = `${old}${old ? "\n" : ""}${now.toISOString().slice(0, 10)}: ${note}`;
    const kept = next.length > 1500 ? next.slice(next.length - 1500).replace(/^[^\n]*\n/, "") : next;
    const [row] = await tx.update(goals).set({ notesEnc: a.vault.seal(a.workspaceId, kept), touchedAt: now, stallNudgedAt: null }).where(eq(goals.id, id)).returning();
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "goal.progress", detail: { id } });
    return (await withPlans(tx, a, [goalView(a, a.workspaceId, row!)]))[0]!;
  });
}

// ---- Plans: milestones, a target date, and the tasks that serve a goal ----

type Opener = { vault: Vault; workspaceId: string };

/** Fill in the milestones and the open-task count for goals read in this transaction. */
export async function withPlans(tx: Tx, a: Opener, views: GoalView[]): Promise<GoalView[]> {
  if (!views.length) return views;
  const ids = views.map((g) => g.id);
  const ms = await tx.select().from(goalMilestones).where(inArray(goalMilestones.goalId, ids)).orderBy(asc(goalMilestones.position), asc(goalMilestones.createdAt));
  const counts = await tx
    .select({ goalId: tasks.goalId, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(inArray(tasks.goalId, ids), eq(tasks.status, "open")))
    .groupBy(tasks.goalId);
  return views.map((g) => ({
    ...g,
    milestones: ms.filter((m) => m.goalId === g.id).map((m) => ({ id: m.id, title: a.vault.open(a.workspaceId, m.titleEnc), position: m.position, dueOn: m.dueOn, status: m.status === "done" ? ("done" as const) : ("open" as const) })),
    openTasks: counts.find((c) => c.goalId === g.id)?.n ?? 0,
  }));
}

/** Today's date where this person is, for "3 days left" and "overdue". */
export async function todayFor(a: Pick<Actor, "tenant" | "userId">, now = new Date()) {
  const [u] = await a.tenant((tx) => tx.select({ tz: users.timezone }).from(users).where(eq(users.id, a.userId)));
  return localIso(now, u?.tz ?? "UTC").slice(0, 10);
}

const dayNumber = (d: string) => Math.round(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
export const daysUntil = (date: string, today: string) => dayNumber(date) - dayNumber(today);
const inDays = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : n > 0 ? `in ${n} days` : `${-n} day${n === -1 ? "" : "s"} ago`);

export type Progress = { done: number; total: number; next: MilestoneView | null; overdue: MilestoneView[] };
export function progressOf(g: Pick<GoalView, "milestones">, today: string): Progress {
  const open = g.milestones.filter((m) => m.status === "open");
  return {
    done: g.milestones.length - open.length,
    total: g.milestones.length,
    next: open[0] ?? null,
    overdue: open.filter((m) => m.dueOn && m.dueOn < today),
  };
}

/** Plain facts about a goal's plan, one per line, for Danny to read (chat, briefing, review). Nothing here is judgement. */
export function planFacts(g: GoalView, today: string): string[] {
  const p = progressOf(g, today);
  const out: string[] = [];
  if (g.targetDate) out.push(`target date ${g.targetDate} (${inDays(daysUntil(g.targetDate, today))}${g.targetDate < today && g.status === "open" ? ", PASSED" : ""})`);
  if (p.total) out.push(`${p.done} of ${p.total} milestones done`);
  if (p.next) out.push(`next milestone: ${p.next.title}${p.next.dueOn ? ` (due ${p.next.dueOn}, ${inDays(daysUntil(p.next.dueOn, today))})` : ""}`);
  if (p.overdue.length) out.push(`OVERDUE: ${p.overdue.map((m) => `${m.title} (was due ${m.dueOn})`).join("; ")}`);
  if (p.total && p.done === p.total) out.push("every milestone is done");
  if (g.openTasks) out.push(`${g.openTasks} open task${g.openTasks === 1 ? "" : "s"} linked`);
  else if (g.status === "open" && p.next) out.push("no open tasks linked to it");
  return out;
}

async function insertMilestones(tx: Tx, a: Actor, goalId: string, items: MilestoneInput[], startAt: number) {
  await tx.insert(goalMilestones).values(
    items.map((m, i) => ({
      workspaceId: a.workspaceId,
      userId: a.userId,
      goalId,
      titleEnc: a.vault.seal(a.workspaceId, m.title),
      position: startAt + i,
      dueOn: m.dueOn ? checkDate(m.dueOn, `The date for "${m.title}"`) : null,
    })),
  );
}

/** Add steps to the end of a goal's plan. Returns the goal with its plan, or null when there is no such goal. */
export async function addMilestones(a: Actor, goalId: string, items: MilestoneInput[]) {
  return a.tenant(async (tx) => {
    const [g] = await tx.select().from(goals).where(and(eq(goals.id, goalId), eq(goals.userId, a.userId)));
    if (!g) return null;
    const have = await tx.select({ n: sql<number>`coalesce(max(${goalMilestones.position}) + 1, 0)::int`, c: sql<number>`count(*)::int` }).from(goalMilestones).where(eq(goalMilestones.goalId, goalId));
    if ((have[0]?.c ?? 0) + items.length > MAX_MILESTONES) throw new GoalError(`A goal can have ${MAX_MILESTONES} milestones at most. If it needs more, it may be two goals.`);
    await insertMilestones(tx, a, goalId, items, have[0]?.n ?? 0);
    await tx.update(goals).set({ touchedAt: new Date(), stallNudgedAt: null }).where(eq(goals.id, goalId));
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "goal.milestones_add", detail: { id: goalId, count: items.length } });
    return (await withPlans(tx, a, [goalView(a, a.workspaceId, g)]))[0]!;
  });
}

export type MilestonePatch = { title?: string; dueOn?: string | null; status?: "open" | "done" };
export type MilestoneResult = { goal: GoalView; milestone: MilestoneView };

/** Change, tick off or reopen one milestone. Finishing one counts as progress on the goal, which is what keeps Danny from asking "what's in the way". */
export async function updateMilestone(a: Actor, id: string, p: MilestonePatch, now = new Date()): Promise<MilestoneResult | null> {
  return a.tenant(async (tx) => {
    const [m] = await tx.select().from(goalMilestones).where(and(eq(goalMilestones.id, id), eq(goalMilestones.userId, a.userId)));
    if (!m) return null;
    const set: Partial<typeof goalMilestones.$inferInsert> = {};
    if (p.title !== undefined) set.titleEnc = a.vault.seal(a.workspaceId, p.title);
    if (p.dueOn !== undefined) set.dueOn = p.dueOn ? checkDate(p.dueOn, "The date") : null;
    if (p.status !== undefined) {
      set.status = p.status;
      set.doneAt = p.status === "done" ? now : null;
    }
    await tx.update(goalMilestones).set(set).where(eq(goalMilestones.id, id));
    if (p.status === "done" && m.status !== "done") await tx.update(goals).set({ touchedAt: now, stallNudgedAt: null }).where(eq(goals.id, m.goalId));
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "goal.milestone", detail: { id, fields: Object.keys(p) } });
    const [g] = await tx.select().from(goals).where(eq(goals.id, m.goalId));
    const goal = (await withPlans(tx, a, [goalView(a, a.workspaceId, g!)]))[0]!;
    return { goal, milestone: goal.milestones.find((x) => x.id === id)! };
  });
}

export async function removeMilestone(a: Actor, id: string) {
  return a.tenant(async (tx) => {
    const gone = await tx.delete(goalMilestones).where(and(eq(goalMilestones.id, id), eq(goalMilestones.userId, a.userId))).returning({ id: goalMilestones.id });
    if (gone.length) await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "goal.milestone_remove", detail: { id } });
    return gone.length > 0;
  });
}
