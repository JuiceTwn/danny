import { and, asc, eq } from "drizzle-orm";
import { memberships, workspaces } from "../db/schema.js";
import { runAgent, wakeReason } from "./agent.js";
import type { BrainDeps } from "./run.js";

export type TickResult = { checked: number; ran: number; failed: number };

/**
 * One pass over every workspace that has Danny's autonomy turned on.
 * The check for "is there any reason to wake him" costs nothing. A model is called only when there is one.
 */
export async function tick(deps: BrainDeps, now = new Date(), log: { error: (e: unknown) => void } = { error: console.error }): Promise<TickResult> {
  const rows = await deps.db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(and(eq(workspaces.agentEnabled, true), eq(workspaces.killSwitch, false)));
  const out: TickResult = { checked: 0, ran: 0, failed: 0 };
  for (const { id } of rows) {
    out.checked++;
    try {
      const [boss] = await deps.db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(eq(memberships.workspaceId, id))
        .orderBy(asc(memberships.role), asc(memberships.createdAt))
        .limit(1);
      if (!boss) continue;
      const reason = await wakeReason(deps, id, now);
      if (!reason) continue;
      const r = await runAgent(deps, { workspaceId: id, userId: boss.userId }, reason, now);
      if (r.ran) out.ran++;
    } catch (e) {
      out.failed++;
      log.error(e); // one workspace failing must not stop the rest
    }
  }
  return out;
}

/** Runs tick on a timer inside the API process. Passes never overlap. */
export function startScheduler(deps: BrainDeps, everyMs: number, log: { error: (e: unknown) => void; info: (m: string) => void }) {
  if (everyMs <= 0) {
    log.info("scheduler off (AGENT_TICK_SECONDS=0)");
    return () => {};
  }
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await tick(deps, new Date(), log);
    } catch (e) {
      log.error(e);
    } finally {
      running = false;
    }
  }, everyMs);
  timer.unref();
  log.info(`scheduler on, every ${Math.round(everyMs / 1000)}s`);
  return () => clearInterval(timer);
}
