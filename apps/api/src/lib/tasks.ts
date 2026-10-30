import { and, eq } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { auditLog, tasks } from "../db/schema.js";
import type { Vault } from "./vault.js";

/** What task code needs to know about who is acting. A tool context fits this shape. */
export type Actor = { workspaceId: string; userId: string; vault: Vault; tenant: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> };

export type TaskView = { id: string; title: string; status: string; dueAt: string | null; remindAt: string | null; createdAt: string };

/** A message the user can fix and retry, as opposed to a bug. */
export class TaskError extends Error {}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const view = (vault: Vault, workspaceId: string, r: typeof tasks.$inferSelect): TaskView => ({
  id: r.id,
  title: vault.open(workspaceId, r.titleEnc),
  status: r.status,
  dueAt: iso(r.dueAt),
  remindAt: iso(r.remindAt),
  createdAt: r.createdAt.toISOString(),
});

export async function createTask(a: Actor, input: { title: string; dueAt?: Date | null; remindAt?: Date | null }, now = new Date()) {
  const due = input.dueAt ?? null;
  let remind = input.remindAt ?? null;
  // A deadline with no explicit reminder reminds at the deadline.
  if (!remind && due && due.getTime() > now.getTime()) remind = due;
  if (remind && remind.getTime() < now.getTime() - 60_000) throw new TaskError("That reminder time has already passed. Pick a time in the future.");
  return a.tenant(async (tx) => {
    const [row] = await tx
      .insert(tasks)
      .values({ workspaceId: a.workspaceId, userId: a.userId, titleEnc: a.vault.seal(a.workspaceId, input.title), dueAt: due, remindAt: remind })
      .returning();
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "task.add", detail: { id: row!.id } });
    return view(a.vault, a.workspaceId, row!);
  });
}

export async function listTasks(a: Actor, status: "open" | "done" = "open") {
  const rows = await a.tenant((tx) => tx.select().from(tasks).where(and(eq(tasks.userId, a.userId), eq(tasks.status, status))));
  const out = rows.map((r) => view(a.vault, a.workspaceId, r));
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

export async function completeTask(a: Actor, id: string) {
  return a.tenant(async (tx) => {
    const rows = await tx
      .update(tasks)
      .set({ status: "done", remindAt: null, completedAt: new Date() })
      .where(and(eq(tasks.id, id), eq(tasks.userId, a.userId), eq(tasks.status, "open")))
      .returning({ id: tasks.id });
    if (rows.length) await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "task.done", detail: { id } });
    return rows.length > 0;
  });
}

/** Push the next nudge to `until` and start the escalation over. */
export async function snoozeTask(a: Actor, id: string, until: Date, now = new Date()) {
  if (until.getTime() <= now.getTime()) throw new TaskError("Snooze has to end in the future.");
  return a.tenant(async (tx) => {
    const rows = await tx
      .update(tasks)
      .set({ remindAt: until, nudgeCount: 0 })
      .where(and(eq(tasks.id, id), eq(tasks.userId, a.userId), eq(tasks.status, "open")))
      .returning({ id: tasks.id });
    if (rows.length) await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "task.snooze", detail: { id, until: until.toISOString() } });
    return rows.length > 0;
  });
}

export async function deleteTask(a: Actor, id: string) {
  return a.tenant(async (tx) => {
    const rows = await tx.delete(tasks).where(and(eq(tasks.id, id), eq(tasks.userId, a.userId))).returning({ id: tasks.id });
    if (rows.length) await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "task.delete", detail: { id } });
    return rows.length > 0;
  });
}
