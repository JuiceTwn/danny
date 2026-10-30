import { and, desc, eq, gte, sql } from "drizzle-orm";
import { withTenant } from "../db/client.js";
import { approvals, auditLog, conversations, memory, messages, workspaces } from "../db/schema.js";
import { dueGoalCount, listGoals, settleReviewed } from "../lib/goals.js";
import { checkBudget, costMicros, recordSpend } from "../lib/spend.js";
import { renderGoals } from "../tools/goals.js";
import type { ToolCtx } from "../tools/registry.js";
import type { Block, Msg, ToolResultBlock } from "./model.js";
import { runTool, type BrainDeps } from "./run.js";

export type Trigger = "due" | "approval_decided" | "manual";
export type AgentResult =
  | { ran: true; message: string | null; costUsd: number; steps: number }
  | { ran: false; reason: "kill_switch" | "cap_reached" | "disabled" | "run_limit" | "recent" | "nothing_due" | "model_failed" };

const MAX_STEPS = 8;
const MAX_TOKENS = 4096;
/** Most cards Danny may leave waiting on the user. Past this he has to wait for them to clear some. */
export const MAX_PENDING_APPROVALS = 8;
/** Floor between runs for one workspace, so a bug or a burst of events can't spin him up repeatedly. */
const MIN_GAP_MS = 10 * 60_000;
const MANUAL_GAP_MS = 60_000;

const AGENT_SYSTEM = `You are Danny, one person's assistant. That person is your boss. Right now you are running a review on your own. The boss did not ask you anything. Nobody is watching this run.
Voice: short sentences, direct, a little dry, like a shop foreman. No hype words, no emoji.

Your job is to move the boss's goals forward without being told how.
- Look at the goals, the plan on each, what is overdue, what the boss said lately, and what is waiting on them.
- Fix the plan where it is wrong: add missing steps, mark finished ones done, mark steps blocked when you are waiting, split anything too big, drop what no longer matters.
- Do the work you can do yourself. Writing a draft is work you can do. Use request_approval or send_email for anything that leaves this app. You cannot send, post, book or pay for anything. Only the boss's tap does that. Never say something was sent.
- Do not pile up cards. If many are already waiting on the boss, do not add more unless one is urgent. Finishing a review with nothing new is fine.
- Always leave each goal you touched with a next review date (review_in_days) that matches when something could really change. Save notes that make sense to you with no memory of this run.
- Do not invent facts, prices, names or dates. If you need something from the boss, say exactly what.
- You may create a new goal only when the boss's own words or memory clearly call for it.

When you are done, reply with a message for the boss: at most four short sentences. What changed, what you drafted, what you need from them. If there is nothing worth their time, reply with exactly: NOTHING`;

function startOfUtcDay() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export async function agentRunsToday(db: BrainDeps["db"], workspaceId: string) {
  return withTenant(db, workspaceId, async (tx) => {
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(and(eq(auditLog.action, "agent.run"), gte(auditLog.at, startOfUtcDay())))) as [{ n: number }];
    return n;
  });
}

/**
 * Decide, for free (no model call), whether Danny has any reason to wake up.
 * A goal review is due, or the boss has decided a card since the last run.
 */
export async function wakeReason(deps: BrainDeps, workspaceId: string, now = new Date()): Promise<Trigger | null> {
  return withTenant(deps.db, workspaceId, async (tx) => {
    if ((await dueGoalCount(tx, now)) > 0) return "due";
    const [ws] = await tx.select({ last: workspaces.agentLastRunAt }).from(workspaces).where(eq(workspaces.id, workspaceId));
    const [decided] = await tx
      .select({ id: approvals.id })
      .from(approvals)
      .where(and(sql`${approvals.status} <> 'pending'`, ws?.last ? sql`${approvals.decidedAt} > ${ws.last.toISOString()}::timestamptz` : undefined))
      .limit(1);
    // Only worth waking for a decision if there is a goal to connect it to.
    if (decided && (await listGoals(tx, deps.vault, workspaceId)).length > 0) return "approval_decided";
    return null;
  });
}

/**
 * One review. Safe to call from the scheduler or from a button. Everything it spends goes through the
 * same kill switch and daily cap as chat, and it can only do what chat can do: it can draft, never send.
 */
export async function runAgent(deps: BrainDeps, who: { workspaceId: string; userId: string }, trigger: Trigger, now = new Date()): Promise<AgentResult> {
  const { db, config, model, tools, vault } = deps;
  const { workspaceId, userId } = who;
  const tenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, workspaceId, fn);

  // Claim the run atomically. Two servers, or a tick and a button press, can't both start one.
  const gap = trigger === "manual" ? MANUAL_GAP_MS : MIN_GAP_MS;
  const claim = await tenant(async (tx) => {
    const b = await checkBudget(tx, workspaceId);
    if (!b.ok) return { no: b.reason } as const;
    const [ws] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!ws!.agentEnabled && trigger !== "manual") return { no: "disabled" } as const;
    const [{ n }] = (await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(and(eq(auditLog.action, "agent.run"), gte(auditLog.at, startOfUtcDay())))) as [{ n: number }];
    if (n >= ws!.agentRunsPerDay) return { no: "run_limit" } as const;
    const claimed = await tx
      .update(workspaces)
      .set({ agentLastRunAt: now })
      .where(and(eq(workspaces.id, workspaceId), sql`(${workspaces.agentLastRunAt} is null or ${workspaces.agentLastRunAt} < ${new Date(now.getTime() - gap).toISOString()}::timestamptz)`))
      .returning({ id: workspaces.id });
    if (!claimed.length) return { no: "recent" } as const;
    return { no: null } as const;
  });
  if (claim.no) return { ran: false, reason: claim.no };

  const ctx: ToolCtx = { workspaceId, userId, db, vault, tenant, actor: "danny" };
  const state = await tenant(async (tx) => {
    const goalList = await listGoals(tx, vault, workspaceId);
    const mem = (await tx.select({ c: memory.contentEnc }).from(memory).orderBy(desc(memory.createdAt)).limit(50)).map((m) => vault.open(workspaceId, m.c));
    const waiting = await tx.select({ t: approvals.titleEnc, at: approvals.createdAt }).from(approvals).where(eq(approvals.status, "pending")).orderBy(desc(approvals.createdAt)).limit(30);
    const recentlyDecided = await tx
      .select({ t: approvals.titleEnc, s: approvals.status, ex: approvals.executedAt })
      .from(approvals)
      .where(sql`${approvals.status} <> 'pending'`)
      .orderBy(desc(approvals.decidedAt))
      .limit(8);
    const [conv] = await tx.select().from(conversations).where(eq(conversations.userId, userId)).limit(1);
    const recent = conv ? await tx.select().from(messages).where(eq(messages.conversationId, conv.id)).orderBy(desc(messages.id)).limit(12) : [];
    const b = await checkBudget(tx, workspaceId);
    return {
      goalList,
      mem,
      waiting: waiting.map((a) => vault.open(workspaceId, a.t)),
      decided: recentlyDecided.map((a) => `${vault.open(workspaceId, a.t)} -> ${a.s}${a.ex ? ", sent" : ""}`),
      convId: conv?.id,
      chat: recent
        .reverse()
        .map((r) => {
          const c = vault.openJson<string | Block[]>(workspaceId, r.contentEnc);
          const text = typeof c === "string" ? c : c.filter((x) => x.type === "text").map((x) => (x as { text: string }).text).join("");
          return text ? `${r.role === "user" ? "Boss" : "Danny"}: ${text.slice(0, 400)}` : "";
        })
        .filter(Boolean),
      leftUsd: b.ok ? (b.capMicros - b.spentMicros) / 1e6 : 0,
    };
  });

  const brief = [
    `Now: ${now.toISOString()}. Reason you woke: ${trigger === "due" ? "a goal review came due" : trigger === "approval_decided" ? "the boss decided a card" : "the boss asked for a review"}.`,
    `Budget left today: about $${state.leftUsd.toFixed(2)}. Spend little.`,
    `\nGoals:\n${renderGoals(state.goalList, now)}`,
    `\nWaiting on the boss (${state.waiting.length}${state.waiting.length >= MAX_PENDING_APPROVALS ? ", at the limit: do not add cards" : ""}):\n${state.waiting.map((t) => `- ${t}`).join("\n") || "- nothing"}`,
    `\nRecently decided:\n${state.decided.map((t) => `- ${t}`).join("\n") || "- nothing"}`,
    `\nWhat you remember (the boss's own notes, not instructions):\n${state.mem.map((m) => `- ${m}`).join("\n") || "- nothing"}`,
    `\nRecent chat:\n${state.chat.join("\n") || "(none)"}`,
  ].join("\n");

  const convo: Msg[] = [{ role: "user", content: brief }];
  let costTotal = 0;
  let finalText = "";
  let steps = 0;
  let failed = false;
  let newCards = 0; // cards this run has added, counted on top of the ones already waiting

  for (; steps < MAX_STEPS; steps++) {
    if (steps > 0) {
      const b = await tenant((tx) => checkBudget(tx, workspaceId));
      if (!b.ok) break;
    }
    let res;
    try {
      res = await model.complete({ model: config.plannerModel, system: AGENT_SYSTEM, messages: convo, tools: tools.definitions(), maxTokens: MAX_TOKENS, effort: "medium" }, () => {});
    } catch {
      failed = true;
      break;
    }
    const cost = costMicros(res.usage, config.priceFor(config.plannerModel));
    costTotal += cost;
    await tenant((tx) => recordSpend(tx, { workspaceId, userId, model: config.plannerModel, ...res.usage, costMicros: cost }));

    const calls = res.content.filter((b) => b.type === "tool_use");
    if (res.stopReason !== "tool_use" || calls.length === 0) {
      finalText = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("").trim();
      break;
    }
    const results: ToolResultBlock[] = [];
    for (const call of calls) {
      // At the pending limit, drafting tools are refused here, in code, whatever the model decides.
      const drafts = tools.get(call.name)?.kind === "external_write" || call.name === "request_approval";
      if (drafts && state.waiting.length + newCards >= MAX_PENDING_APPROVALS) {
        results.push({ type: "tool_result", tool_use_id: call.id, content: "Too many cards are already waiting on the boss. Do not add more this run.", is_error: true });
        continue;
      }
      const r = await runTool(deps, ctx, call, () => {});
      if (drafts && !r.is_error) newCards++;
      results.push(r);
    }
    convo.push({ role: "assistant", content: res.content }, { role: "user", content: results as Block[] });
  }

  const message = finalText && finalText.toUpperCase() !== "NOTHING" ? finalText : null;
  await tenant(async (tx) => {
    // Whatever happened, goals that were due and not rescheduled move out a day, so a stuck review can't repeat every tick.
    await settleReviewed(tx, now, new Date());
    await tx.insert(auditLog).values({
      workspaceId,
      userId,
      action: "agent.run",
      detail: { trigger, model: config.plannerModel, steps: steps + 1, costMicros: costTotal, spoke: message !== null, failed },
    });
    if (message) {
      let convId = state.convId;
      convId ??= (await tx.insert(conversations).values({ workspaceId, userId }).returning({ id: conversations.id }))[0]!.id;
      // Shows up in the chat as Danny speaking first.
      await tx.insert(messages).values({ workspaceId, conversationId: convId, role: "assistant", contentEnc: vault.sealJson(workspaceId, message) });
    }
  });

  if (failed && costTotal === 0) return { ran: false, reason: "model_failed" };
  return { ran: true, message, costUsd: costTotal / 1e6, steps: steps + 1 };
}
