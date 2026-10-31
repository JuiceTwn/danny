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

/** What today's requests really cost, unrounded. The allowance counts the rounded-up amount instead (spentToday). */
export async function costToday(tx: Tx, workspaceId: string) {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${spendLedger.exactMicros}), 0)` })
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

/** One cent, in the micro-dollars the ledger counts in. */
export const CENT_MICROS = 10_000;

/** Usage is always rounded UP to the next whole cent, never down: 0.1 cents of real cost is billed as 1 cent. Zero stays zero. */
export const ceilToCent = (micros: number) => Math.ceil(micros / CENT_MICROS) * CENT_MICROS;

/**
 * Groups several costs that make up one request, so they round up together instead of one cent each.
 * A chat turn is a few model calls; a phone call is many bursts of speech. Each is billed as one request.
 * Each cost is billed the moment it happens, as the new rounded total minus what was already billed.
 */
export class Bill {
  exact = 0;
  billed = 0;
  add(exactMicros: number) {
    this.exact += exactMicros;
    const total = ceilToCent(this.exact);
    const now = total - this.billed;
    this.billed = total;
    return now;
  }
}

/**
 * `costMicros` is what the request really cost. The ledger stores that as `exactMicros` and stores the billed
 * amount (rounded up to the cent, as part of `bill` when one is given) as `costMicros`, which is what the daily allowance counts.
 */
export async function recordSpend(
  tx: Tx,
  e: { workspaceId: string; userId: string; model: string; inputTokens: number; outputTokens: number; costMicros: number },
  bill?: Bill,
) {
  const billed = bill ? bill.add(e.costMicros) : ceilToCent(e.costMicros);
  await tx.insert(spendLedger).values({ ...e, costMicros: billed, exactMicros: e.costMicros, day: todayUtc() });
}
