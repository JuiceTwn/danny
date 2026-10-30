import { and, eq, gte, sql } from "drizzle-orm";
import type { Price } from "../config.js";
import type { Tx } from "../db/client.js";
import { spendLedger, workspaces } from "../db/schema.js";

export const todayUtc = () => new Date().toISOString().slice(0, 10);
export const monthStartUtc = () => `${new Date().toISOString().slice(0, 7)}-01`;

/** A request with a prompt over a model's long-prompt size is billed at the higher rate, all of it. */
export function costMicros(usage: { inputTokens: number; outputTokens: number }, price: Price) {
  const p = price.longPrompt && usage.inputTokens > price.longPrompt.aboveTokens ? price.longPrompt : price;
  return Math.ceil(usage.inputTokens * p.inputPerMtokUsd + usage.outputTokens * p.outputPerMtokUsd);
}

export async function spentToday(tx: Tx, workspaceId: string) {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${spendLedger.costMicros}), 0)` })
    .from(spendLedger)
    .where(and(eq(spendLedger.workspaceId, workspaceId), eq(spendLedger.day, todayUtc())));
  return Number(row?.total ?? 0);
}

export async function spentThisMonth(tx: Tx, workspaceId: string) {
  const [row] = await tx
    .select({ total: sql<string>`coalesce(sum(${spendLedger.costMicros}), 0)` })
    .from(spendLedger)
    .where(and(eq(spendLedger.workspaceId, workspaceId), gte(spendLedger.day, monthStartUtc())));
  return Number(row?.total ?? 0);
}

/** How close the user is to either cap. The router turns this into a cheaper model before it ever turns it into a refusal. */
export type BudgetLevel = "ok" | "near" | "critical";
export const NEAR_FRACTION = 0.8;
export const CRITICAL_FRACTION = 0.95;

export function levelOf(spentMicros: number, capMicros: number, monthMicros: number, monthCapMicros: number): BudgetLevel {
  const f = Math.max(capMicros > 0 ? spentMicros / capMicros : 1, monthCapMicros > 0 ? monthMicros / monthCapMicros : 1);
  return f >= CRITICAL_FRACTION ? "critical" : f >= NEAR_FRACTION ? "near" : "ok";
}

export type Budget =
  | { ok: true; spentMicros: number; capMicros: number; monthMicros: number; monthCapMicros: number; level: BudgetLevel }
  | { ok: false; reason: "kill_switch" | "cap_reached" | "month_cap_reached"; spentMicros: number; capMicros: number; monthMicros: number; monthCapMicros: number };

/** Call before every model request. The kill switch and both caps are checked here, in one place. */
export async function checkBudget(tx: Tx, workspaceId: string): Promise<Budget> {
  const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws) throw new Error("workspace not found");
  const spentMicros = await spentToday(tx, workspaceId);
  const monthMicros = await spentThisMonth(tx, workspaceId);
  const capMicros = ws.dailyCapMicros;
  const monthCapMicros = ws.monthlyCapMicros;
  const base = { spentMicros, capMicros, monthMicros, monthCapMicros };
  if (ws.killSwitch) return { ok: false, reason: "kill_switch", ...base };
  if (spentMicros >= capMicros) return { ok: false, reason: "cap_reached", ...base };
  if (monthMicros >= monthCapMicros) return { ok: false, reason: "month_cap_reached", ...base };
  return { ok: true, ...base, level: levelOf(spentMicros, capMicros, monthMicros, monthCapMicros) };
}

export async function recordSpend(
  tx: Tx,
  e: { workspaceId: string; userId: string; model: string; inputTokens: number; outputTokens: number; costMicros: number },
) {
  await tx.insert(spendLedger).values({ ...e, day: todayUtc() });
}
