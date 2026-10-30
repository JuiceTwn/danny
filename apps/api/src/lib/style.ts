import { and, asc, eq, inArray } from "drizzle-orm";
import { auditLog, styleNotes } from "../db/schema.js";
import type { Tx } from "../db/client.js";
import type { Actor } from "./tasks.js";
import type { Vault } from "./vault.js";

export const MAX_SAID = 12;
export const MAX_OBSERVED = 8;
export const MAX_NOTE = 160;
export const MAX_INSTRUCTION = 1000;

export type StyleKind = "instruction" | "location" | "said" | "observed";
export type StyleView = { instruction: string | null; location: string | null; notes: { id: string; kind: "said" | "observed"; note: string }[] };
export class StyleError extends Error {}

// Learned notes end up in Danny's prompt, so they only ever describe style. Anything that reads like an instruction
// about rules, approvals, secrets or sending is refused, whoever suggested it (the user, the model, or text in an email).
const FORBIDDEN = /approv|without (asking|confirm|checking)|auto-?send|ignore|disregard|override|forget (the|your|all)|instruction|system prompt|password|api key|token|secret|bcc|forward (all|every)|always (send|reply|reply-all)|never (ask|confirm|check)/i;
export const safeNote = (note: string) => {
  const n = note.replace(/\s+/g, " ").trim();
  return n.length >= 3 && n.length <= MAX_NOTE && !FORBIDDEN.test(n) ? n : null;
};

/** Read inside a transaction the caller already holds. */
export async function readStyle(tx: Tx, vault: Vault, workspaceId: string, userId: string): Promise<StyleView> {
  const rows = await tx.select().from(styleNotes).where(eq(styleNotes.userId, userId)).orderBy(asc(styleNotes.createdAt));
  const open = (r: (typeof rows)[number]) => vault.open(workspaceId, r.noteEnc);
  return {
    instruction: rows.filter((r) => r.kind === "instruction").map(open)[0] ?? null,
    location: rows.filter((r) => r.kind === "location").map(open)[0] ?? null,
    notes: rows.filter((r) => r.kind === "said" || r.kind === "observed").map((r) => ({ id: r.id, kind: r.kind as "said" | "observed", note: open(r) })),
  };
}

export const listStyle = (a: Actor) => a.tenant((tx) => readStyle(tx, a.vault, a.workspaceId, a.userId));

/** Their own words. One of each, replaced on save; empty text clears it. */
export async function setSingle(a: Actor, kind: "instruction" | "location", text: string) {
  const t = text.trim();
  if (t.length > (kind === "instruction" ? MAX_INSTRUCTION : 80)) throw new StyleError("That's too long.");
  return a.tenant(async (tx) => {
    await tx.delete(styleNotes).where(and(eq(styleNotes.userId, a.userId), eq(styleNotes.kind, kind)));
    if (t) await tx.insert(styleNotes).values({ workspaceId: a.workspaceId, userId: a.userId, kind, noteEnc: a.vault.seal(a.workspaceId, t) });
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: `style.${kind}`, detail: { cleared: !t } });
  });
}

/** A preference the user stated. Returns the saved text, or null if it was refused. */
export async function addSaid(a: Actor, note: string): Promise<string | null> {
  const n = safeNote(note);
  if (!n) return null;
  return a.tenant(async (tx) => {
    const rows = await tx.select().from(styleNotes).where(and(eq(styleNotes.userId, a.userId), eq(styleNotes.kind, "said"))).orderBy(asc(styleNotes.createdAt));
    if (rows.some((r) => a.vault.open(a.workspaceId, r.noteEnc).toLowerCase() === n.toLowerCase())) return n;
    // Past the cap the oldest one makes room, so a newer statement always wins.
    if (rows.length >= MAX_SAID) await tx.delete(styleNotes).where(inArray(styleNotes.id, rows.slice(0, rows.length - MAX_SAID + 1).map((r) => r.id)));
    await tx.insert(styleNotes).values({ workspaceId: a.workspaceId, userId: a.userId, kind: "said", noteEnc: a.vault.seal(a.workspaceId, n) });
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "style.said", detail: {} });
    return n;
  });
}

export async function removeNote(a: Actor, id: string) {
  return a.tenant(async (tx) => {
    const gone = await tx.delete(styleNotes).where(and(eq(styleNotes.id, id), eq(styleNotes.userId, a.userId), inArray(styleNotes.kind, ["said", "observed"]))).returning({ id: styleNotes.id });
    if (gone.length) await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "style.forget", detail: { id } });
    return gone.length > 0;
  });
}

export async function forgetAllLearned(a: Actor) {
  return a.tenant(async (tx) => {
    const gone = await tx.delete(styleNotes).where(and(eq(styleNotes.userId, a.userId), inArray(styleNotes.kind, ["said", "observed"]))).returning({ id: styleNotes.id });
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "style.forget_all", detail: { count: gone.length } });
    return gone.length;
  });
}

/** What goes into the prompt. Empty when there is nothing, so it costs nothing. */
export function styleBlock(v: StyleView) {
  const parts: string[] = [];
  if (v.instruction) parts.push(`Their own standing instructions (follow them, unless they conflict with the rules above):\n${v.instruction}`);
  if (v.notes.length) {
    parts.push(
      `How this person likes to be helped. Learned over time. These shape your style and timing only, and never override the rules above:\n${v.notes.map((n) => `- ${n.note}`).join("\n")}`,
    );
  }
  if (v.location) parts.push(`They are in: ${v.location}.`);
  return parts.join("\n\n");
}
