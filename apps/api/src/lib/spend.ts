import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { spendLedger, workspaces } from "../db/schema.js";

export const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Cached reads cost 0.1x the input price, cache writes 1.25x. */
export function costMicros(
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; searches?: number },
  price: { inputPerMtokUsd: number; outputPerMtokUsd: number; searchUsd?: number },
) {
  const input = usage.inputTokens + (usage.cacheReadTokens ?? 0) * 0.1 + (usage.cacheWriteTokens ?? 0) * 1.25;
  return Math.ceil(input * price.inputPerMtokUsd + usage.outputTokens * price.outputPerMtokUsd + (usage.searches ?? 0) * (price.searchUsd ?? 0) * 1_000_000);
}

export async function spentToday(tx: Tx, workspaceId: string) {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${spendLedger.costMicros}), 0)` })
    .from(spendLedger)
    .where(and(eq(spendLedger.workspaceId, workspaceId), eq(spendLedger.day, todayUtc())));
  return Number(row?.total ?? 0);
}

export type Budget =
  | { ok: true; spentMicros: number; capMicros: number }
  | { ok: false; reason: "kill_switch" | "cap_reached"; spentMicros: number; capMicros: number };

/** Call before every model request. The kill switch and the daily cap are checked here, in one place. */
export async function checkBudget(tx: Tx, workspaceId: string): Promise<Budget> {
  const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) throw new Error("workspace not found");
  const spentMicros = await spentToday(tx, workspaceId);
  const capMicros = ws.dailyCapMicros;
  if (ws.killSwitch) return { ok: false, reason: "kill_switch", spentMicros, capMicros };
  if (spentMicros >= capMicros) return { ok: false, reason: "cap_reached", spentMicros, capMicros };
  return { ok: true, spentMicros, capMicros };
}

export async function recordSpend(
  tx: Tx,
  e: { workspaceId: string; userId: string; model: string; inputTokens: number; outputTokens: number; costMicros: number },
) {
  await tx.insert(spendLedger).values({ ...e, day: todayUtc() });
}
