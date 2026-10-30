import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { withTenant, type Db } from "../db/client.js";
import { auditLog, conversations, messages, pushSubscriptions, tasks } from "../db/schema.js";
import { inQuietHours, nextQuietEnd } from "./time.js";
import { isAllowedPushEndpoint, type PushSender, type PushSub } from "./push.js";
import type { Health } from "./health.js";
import { runDueBriefings, runDueGoalChecks, runDueWrapups, runStalledGoalCheckins, type BackgroundDeps } from "./background.js";
import type { Vault } from "./vault.js";

/**
 * How a reminder escalates. The first nudge goes at the time the user asked for.
 * If they do nothing it comes back after 10 minutes, 30 minutes and 2 hours, then stops.
 * The task stays on their list; it just stops buzzing. Repeat nudges wait out quiet hours.
 */
export const NUDGE_DELAYS_MIN = [10, 30, 120];

export function nextNudgeAt(nudgesSent: number, now: Date) {
  const delay = NUDGE_DELAYS_MIN[nudgesSent - 1];
  return delay === undefined ? null : new Date(now.getTime() + delay * 60_000);
}

export function nudgeText(title: string, nudgesSent: number) {
  if (nudgesSent === 0) return `Reminder: ${title}`;
  if (nudgesSent === 1) return `Still open: ${title}`;
  if (nudgesSent === 2) return `Still on the board: ${title}. Do it, snooze it, or drop it.`;
  return `Last nudge on this one: ${title}. It stays on your list.`;
}

/** Short status line for the notification. The task title is the headline, so this never repeats it. */
export function nudgeLabel(nudgesSent: number) {
  if (nudgesSent === 0) return "Reminder";
  if (nudgesSent === 1) return "Still open";
  if (nudgesSent === 2) return "Still on the board";
  return "Last nudge · stays on your list";
}

type Due = { workspace_id: string; user_id: string; task_id: string; timezone: string };
type Fired = { taskId: string; text: string; title: string; label: string; subs: { id: string; sub: PushSub }[] };

export type ReminderDeps = { db: Db; vault: Vault; push: PushSender; log?: FastifyBaseLogger; health?: Health };
/** The scheduler also does Danny's own work (goal checks, briefings) when it is given a model and config. */
export type SchedulerDeps = ReminderDeps & Partial<Pick<BackgroundDeps, "config" | "model" | "google">>;

/** Fire every reminder that is due as of `now`. Returns how many fired. Safe to run from more than one process. */
export async function runDueReminders({ db, vault, push, log }: ReminderDeps, now = new Date()) {
  const due = (await db.execute<Due>(sql`select * from due_reminders(${now.toISOString()}::timestamptz)`)) as unknown as Due[];
  let fired = 0;
  for (const d of due) {
    try {
      const f = await withTenant(db, d.workspace_id, async (tx): Promise<Fired | null> => {
        // Claim the task. SKIP LOCKED means two schedulers never both fire the same one.
        const [t] = await tx
          .select()
          .from(tasks)
          .where(and(eq(tasks.id, d.task_id), eq(tasks.status, "open"), lte(tasks.remindAt, now)))
          .for("update", { skipLocked: true });
        if (!t) return null;

        // Repeat nudges never wake anyone up. The first one is exactly when they asked for.
        if (t.nudgeCount > 0 && inQuietHours(now, d.timezone)) {
          await tx.update(tasks).set({ remindAt: nextQuietEnd(now, d.timezone) }).where(eq(tasks.id, t.id));
          return null;
        }

        const title = vault.open(d.workspace_id, t.titleEnc);
        const text = nudgeText(title, t.nudgeCount);
        await tx.update(tasks).set({ nudgeCount: t.nudgeCount + 1, remindAt: nextNudgeAt(t.nudgeCount + 1, now) }).where(eq(tasks.id, t.id));

        // It also lands in the chat, so it is there even if push is off or the phone was asleep.
        let [conv] = await tx.select().from(conversations).where(eq(conversations.userId, d.user_id)).limit(1);
        conv ??= (await tx.insert(conversations).values({ workspaceId: d.workspace_id, userId: d.user_id }).returning())[0]!;
        await tx.insert(messages).values({ workspaceId: d.workspace_id, conversationId: conv.id, role: "assistant", contentEnc: vault.sealJson(d.workspace_id, text) });
        await tx.insert(auditLog).values({ workspaceId: d.workspace_id, userId: d.user_id, action: "reminder.fire", detail: { id: t.id, nudge: t.nudgeCount + 1 } });

        const subs = await tx.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, d.user_id));
        return { taskId: t.id, text, title, label: nudgeLabel(t.nudgeCount), subs: subs.map((s) => ({ id: s.id, sub: vault.openJson<PushSub>(d.workspace_id, s.subEnc) })) };
      });
      if (!f) continue;
      fired++;

      const dead: string[] = [];
      for (const { id, sub } of f.subs) {
        if (!isAllowedPushEndpoint(sub.endpoint)) continue;
        if ((await push.send(sub, { title: f.title, body: f.label, taskId: f.taskId })) === "gone") dead.push(id);
      }
      if (dead.length) {
        await withTenant(db, d.workspace_id, (tx) => tx.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, dead)));
      }
    } catch (err) {
      log?.error({ err, task: d.task_id }, "reminder failed");
    }
  }
  return fired;
}

/** Check for due reminders on a timer. Returns a function that stops it. */
export function startScheduler(deps: SchedulerDeps, everyMs = 30_000) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runDueReminders(deps);
      if (deps.config && deps.model) {
        const bg = { db: deps.db, vault: deps.vault, push: deps.push, log: deps.log, config: deps.config, model: deps.model, google: deps.google };
        await runDueBriefings(bg);
        await runDueWrapups(bg);
        await runDueGoalChecks(bg);
        await runStalledGoalCheckins(bg);
      }
      deps.health?.tick();
    } catch (err) {
      deps.log?.error({ err }, "scheduler tick failed");
    } finally {
      running = false;
    }
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
