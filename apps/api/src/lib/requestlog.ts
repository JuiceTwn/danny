import { and, desc, eq } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { requestLog } from "../db/schema.js";
import type { CallState } from "../brain/call.js";
import type { Route } from "../brain/router.js";

/** Running totals for one request, summed over every model call it made. */
export type Meter = { calls: number; inputTokens: number; outputTokens: number; costMicros: number };
export const newMeter = (): Meter => ({ calls: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 });

export type LogEntry = {
  id: string;
  workspaceId: string;
  userId: string;
  source: "chat" | "agent";
  route: Pick<Route, "feature" | "reason" | "downshifted" | "tier">;
  /** The model that ended up answering. */
  tier: string;
  model: string;
  state: Pick<CallState, "failures" | "escalated">;
  meter: Meter;
  status: "ok" | "failed" | "blocked" | "aborted";
  retryOf?: string | null;
};

export async function logRequest(tx: Tx, e: LogEntry) {
  await tx.insert(requestLog).values({
    id: e.id,
    workspaceId: e.workspaceId,
    userId: e.userId,
    source: e.source,
    feature: e.route.feature,
    tier: e.tier,
    model: e.model,
    reason: e.route.reason,
    downshifted: e.route.downshifted,
    escalated: e.state.escalated,
    retryOf: e.retryOf ?? null,
    status: e.status,
    failures: e.state.failures,
    calls: e.meter.calls,
    inputTokens: e.meter.inputTokens,
    outputTokens: e.meter.outputTokens,
    costMicros: e.meter.costMicros,
  });
}

/** The newest chat request in the workspace that actually produced an answer. "Answer better" only applies to this one. */
export async function latestChatRequest(tx: Tx) {
  const [row] = await tx
    .select()
    .from(requestLog)
    .where(and(eq(requestLog.source, "chat"), eq(requestLog.status, "ok")))
    .orderBy(desc(requestLog.at))
    .limit(1);
  return row ?? null;
}
