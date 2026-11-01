import { and, asc, eq } from "drizzle-orm";
import { waitingOn } from "../db/schema.js";
import { auditLog } from "../db/schema.js";
import { google } from "./gmail.js";
import { MAIL_ID, senderName } from "./inbox.js";
import type { Actor } from "./tasks.js";
import type { ToolCtx } from "../tools/registry.js";

type ThreadMessage = { id: string; labelIds?: string[]; payload?: { headers?: { name: string; value: string }[] } };
type Thread = { id: string; messages?: ThreadMessage[] };

const header = (m: ThreadMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const one = (s: string) => s.replace(/\s+/g, " ").trim();

/** The thread a message belongs to, for Gmail calls. Read-only: metadata only. */
export async function fetchThread(ctx: ToolCtx, threadId: string): Promise<ThreadMessage[]> {
  const t = await google<Thread>(ctx, `/threads/${threadId}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject`);
  return t.messages ?? [];
}

/** Has anyone other than the user written into this thread since `baseline` messages? Their own sent mail does not count. */
export const hasReply = (messages: ThreadMessage[], baseline: number) => messages.slice(baseline).some((m) => !(m.labelIds ?? []).includes("SENT"));

/** Who the reply is expected from: whoever the user last wrote to, else whoever wrote first. */
export function expectedFrom(messages: ThreadMessage[]) {
  const sent = [...messages].reverse().find((m) => (m.labelIds ?? []).includes("SENT"));
  if (sent) return senderName(header(sent, "to").split(",")[0] ?? "");
  const first = messages[0];
  return first ? senderName(header(first, "from")) : "them";
}

export class WaitingError extends Error {}

/** Start waiting for a reply on the thread that this message is in. */
export async function startWaiting(ctx: ToolCtx, a: Actor, messageId: string, by: Date, now = new Date()) {
  if (!MAIL_ID.test(messageId)) throw new WaitingError("That isn't a message id from search_email.");
  if (by.getTime() <= now.getTime()) throw new WaitingError("Pick a time in the future to check.");
  const m = await google<{ id: string; threadId: string }>(ctx, `/messages/${messageId}?format=metadata&metadataHeaders=Subject`);
  if (!MAIL_ID.test(m.threadId)) throw new WaitingError("Couldn't find that conversation.");
  const messages = await fetchThread(ctx, m.threadId);
  if (!messages.length) throw new WaitingError("Couldn't find that conversation.");
  const subject = clip(one(header(messages[0]!, "subject")) || "(no subject)", 150);
  const who = expectedFrom(messages);
  return a.tenant(async (tx) => {
    // One watch per thread: asking again moves the date.
    const [existing] = await tx.select().from(waitingOn).where(and(eq(waitingOn.userId, a.userId), eq(waitingOn.threadId, m.threadId), eq(waitingOn.status, "open")));
    if (existing) {
      await tx.update(waitingOn).set({ checkAt: by, attempts: 0, baselineCount: messages.length }).where(eq(waitingOn.id, existing.id));
      return { id: existing.id, subject, who, moved: true };
    }
    const [row] = await tx
      .insert(waitingOn)
      .values({ workspaceId: a.workspaceId, userId: a.userId, threadId: m.threadId, subjectEnc: a.vault.seal(a.workspaceId, subject), whoEnc: a.vault.seal(a.workspaceId, who), baselineCount: messages.length, checkAt: by })
      .returning();
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "waiting.start", detail: { id: row!.id } });
    return { id: row!.id, subject, who, moved: false };
  });
}

export async function listWaiting(a: Actor) {
  const rows = await a.tenant((tx) =>
    tx.select().from(waitingOn).where(and(eq(waitingOn.userId, a.userId))).orderBy(asc(waitingOn.checkAt)),
  );
  return rows
    .filter((r) => r.status === "open" || r.status === "nudged")
    .map((r) => ({ id: r.id, subject: a.vault.open(a.workspaceId, r.subjectEnc), who: a.vault.open(a.workspaceId, r.whoEnc), checkAt: r.checkAt.toISOString(), status: r.status }));
}

export async function stopWaiting(a: Actor, id: string) {
  return a.tenant(async (tx) => {
    const rows = await tx.update(waitingOn).set({ status: "cancelled" }).where(and(eq(waitingOn.id, id), eq(waitingOn.userId, a.userId))).returning({ id: waitingOn.id });
    if (rows.length) await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "waiting.stop", detail: { id } });
    return rows.length > 0;
  });
}
