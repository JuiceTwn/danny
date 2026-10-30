import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Tx } from "../db/client.js";
import { auditLog, memory } from "../db/schema.js";
import type { Actor } from "./tasks.js";
import type { Vault } from "./vault.js";

export const KINDS = ["fact", "preference", "person", "plan", "place"] as const;
export type Kind = (typeof KINDS)[number];
export type Source = "chat" | "auto" | "app";
export const MAX_MEMORIES = 300;
export const MAX_FACT = 300;
const CORE_MAX = 8; // pinned notes always in the prompt
const RELEVANT_MAX = 5; // other notes that match what the user just said
const SMALL = 10; // with this few, the whole lot goes in: it costs less than being clever
const TIDY_UNDO_DAYS = 14;

export type MemoryView = {
  id: string;
  fact: string;
  kind: Kind;
  subject: string | null;
  pinned: boolean;
  source: Source;
  expiresAt: string | null;
  expired: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  archivedReason: string | null;
  previous: string | null;
};

type Row = typeof memory.$inferSelect;
const view = (vault: Vault, ws: string, r: Row, now = new Date()): MemoryView => ({
  id: r.id,
  fact: vault.open(ws, r.contentEnc),
  kind: (KINDS as readonly string[]).includes(r.kind) ? (r.kind as Kind) : "fact",
  subject: r.subjectEnc ? vault.open(ws, r.subjectEnc) : null,
  pinned: r.pinned,
  source: r.source === "auto" || r.source === "app" ? r.source : "chat",
  expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
  expired: !!r.expiresAt && r.expiresAt <= now,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  archivedAt: r.archivedAt ? r.archivedAt.toISOString() : null,
  archivedReason: r.archivedReason,
  previous: r.previousEnc ? vault.open(ws, r.previousEnc) : null,
});

// ---- Matching. Plain word overlap: nothing leaves the server, nothing is billed, and it is plenty for a few hundred short notes.

const STOP = new Set("the and for are but not you your with that this from have has had was were will would can could should about they them their then than into out one all any our his her she him its who what when where which while also just very more most some such only over under after before been being does did doing there here these those how why".split(" "));
export const words = (s: string) => [...new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !STOP.has(w)))];
const inter = (a: string[], b: string[]) => a.filter((w) => b.includes(w)).length;
/** Share of the smaller set found in the other: 1 means one note is contained in the other. */
export const containment = (a: string[], b: string[]) => (a.length && b.length ? inter(a, b) / Math.min(a.length, b.length) : 0);
export const jaccard = (a: string[], b: string[]) => (a.length || b.length ? inter(a, b) / (a.length + b.length - inter(a, b)) : 0);

const text = (m: MemoryView) => `${m.subject ?? ""} ${m.fact}`;
const NEAR_DUPLICATE = 0.8;
const SIMILAR = 0.5;

// ---- Reading

export async function readAll(tx: Tx, vault: Vault, ws: string, userId: string, opts: { archived?: boolean } = {}): Promise<MemoryView[]> {
  const rows = await tx
    .select()
    .from(memory)
    .where(and(eq(memory.userId, userId), opts.archived ? isNotNull(memory.archivedAt) : isNull(memory.archivedAt)))
    .orderBy(desc(memory.updatedAt));
  return rows.map((r) => view(vault, ws, r));
}

/** What is live: not archived, not past its expiry. */
const live = (all: MemoryView[]) => all.filter((m) => !m.expired);

export const lineOf = (m: MemoryView) => {
  const t = (m.subject ? `${m.subject}: ${m.fact}` : m.fact).slice(0, 200);
  return m.expiresAt ? `${t} (until ${m.expiresAt.slice(0, 10)})` : t;
};

/**
 * What goes in the prompt for this message: the pinned core, plus the few notes that match what was just said. Everything else
 * is one `recall` away. With only a handful of notes, all of them go in. Marks what it used.
 */
export async function forPrompt(tx: Tx, vault: Vault, ws: string, userId: string, message: string) {
  const all = live(await readAll(tx, vault, ws, userId));
  let chosen: MemoryView[];
  if (all.length <= SMALL) chosen = all;
  else {
    const q = words(message);
    const pinned = all.filter((m) => m.pinned).slice(0, CORE_MAX);
    const scored = all
      .filter((m) => !m.pinned)
      .map((m) => ({ m, s: inter(q, words(text(m))) + (m.subject && q.includes(words(m.subject)[0] ?? "~") ? 2 : 0) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, RELEVANT_MAX)
      .map((x) => x.m);
    chosen = [...pinned, ...scored];
  }
  if (chosen.length) await tx.update(memory).set({ lastUsedAt: new Date() }).where(inArray(memory.id, chosen.map((m) => m.id)));
  return { lines: chosen.map(lineOf), shown: chosen.length, total: all.length };
}

/** For the morning briefing: the pinned notes and the most recently touched ones. */
export async function forBriefing(tx: Tx, vault: Vault, ws: string, userId: string) {
  const all = live(await readAll(tx, vault, ws, userId));
  return [...all.filter((m) => m.pinned), ...all.filter((m) => !m.pinned).slice(0, 15)].slice(0, 20).map(lineOf);
}

export async function recall(a: Actor, query: string, limit = 8): Promise<MemoryView[]> {
  return a.tenant(async (tx) => {
    const all = live(await readAll(tx, a.vault, a.workspaceId, a.userId));
    const q = words(query);
    if (!q.length) return [...all.filter((m) => m.pinned), ...all.filter((m) => !m.pinned)].slice(0, limit);
    return all
      .map((m) => ({ m, s: inter(q, words(text(m))) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s || Number(y.m.pinned) - Number(x.m.pinned))
      .slice(0, limit)
      .map((x) => x.m);
  });
}

// ---- Writing

export type MemoryInput = { fact: string; kind?: Kind; subject?: string | null; expiresOn?: string | null; pinned?: boolean };
export type AddResult =
  | { status: "added"; item: MemoryView; similar: MemoryView[] }
  | { status: "duplicate" | "replaced"; item: MemoryView; similar: [] }
  | { status: "full" }
  | { status: "missing" };

const expiry = (d: string | null | undefined) => (d ? new Date(`${d}T23:59:59Z`) : null);

export async function addMemory(a: Actor, input: MemoryInput, opts: { replaces?: string; source?: Source } = {}): Promise<AddResult> {
  const fact = input.fact.replace(/\s+/g, " ").trim().slice(0, MAX_FACT);
  const subject = input.subject?.trim().slice(0, 80) || null;
  return a.tenant(async (tx) => {
    const all = await readAll(tx, a.vault, a.workspaceId, a.userId);
    const audit = (id: string, what: string) => tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: `memory.${what}`, detail: { id, via: opts.source ?? "chat" } });
    const seal = (s: string) => a.vault.seal(a.workspaceId, s);

    if (opts.replaces) {
      const target = all.find((m) => m.id === opts.replaces);
      if (!target) return { status: "missing" } as const;
      const [row] = await tx
        .update(memory)
        .set({
          contentEnc: seal(fact),
          // A quiet update keeps the old wording, so the Memory tab's undo can put it back.
          ...(opts.source === "auto" ? { previousEnc: seal(target.fact) } : {}),
          kind: input.kind ?? target.kind,
          subjectEnc: subject ? seal(subject) : null,
          expiresAt: input.expiresOn !== undefined ? expiry(input.expiresOn) : target.expiresAt ? new Date(target.expiresAt) : null,
          pinned: input.pinned ?? target.pinned,
          updatedAt: new Date(),
        })
        .where(eq(memory.id, target.id))
        .returning();
      await audit(target.id, "update");
      return { status: "replaced", item: view(a.vault, a.workspaceId, row!), similar: [] } as const;
    }

    // The same thing said twice is kept once.
    const mine = words(`${subject ?? ""} ${fact}`);
    const dup = all.find((m) => jaccard(mine, words(text(m))) >= NEAR_DUPLICATE);
    if (dup) {
      const [row] = await tx
        .update(memory)
        .set({ updatedAt: new Date(), ...(input.pinned ? { pinned: true } : {}), ...(input.expiresOn ? { expiresAt: expiry(input.expiresOn) } : {}) })
        .where(eq(memory.id, dup.id))
        .returning();
      return { status: "duplicate", item: view(a.vault, a.workspaceId, row!), similar: [] } as const;
    }
    if (all.length >= MAX_MEMORIES) return { status: "full" } as const;

    const [row] = await tx
      .insert(memory)
      .values({
        workspaceId: a.workspaceId,
        userId: a.userId,
        contentEnc: seal(fact),
        kind: input.kind ?? "fact",
        subjectEnc: subject ? seal(subject) : null,
        pinned: input.pinned ?? false,
        source: opts.source ?? "chat",
        expiresAt: expiry(input.expiresOn),
      })
      .returning();
    await audit(row!.id, "add");
    const similar = all
      .filter((m) => containment(mine, words(text(m))) >= SIMILAR || (subject && m.subject?.toLowerCase() === subject.toLowerCase()))
      .slice(0, 3);
    return { status: "added", item: view(a.vault, a.workspaceId, row!), similar } as const;
  });
}

export type MemoryPatch = { fact?: string; kind?: Kind; subject?: string | null; expiresOn?: string | null; pinned?: boolean };

export async function patchMemory(a: Actor, id: string, p: MemoryPatch): Promise<MemoryView | null> {
  return a.tenant(async (tx) => {
    const [cur] = await tx.select().from(memory).where(and(eq(memory.id, id), eq(memory.userId, a.userId), isNull(memory.archivedAt)));
    if (!cur) return null;
    const set: Partial<typeof memory.$inferInsert> = { updatedAt: new Date() };
    if (p.fact !== undefined) set.contentEnc = a.vault.seal(a.workspaceId, p.fact.replace(/\s+/g, " ").trim().slice(0, MAX_FACT));
    if (p.kind !== undefined) set.kind = p.kind;
    if (p.subject !== undefined) set.subjectEnc = p.subject?.trim() ? a.vault.seal(a.workspaceId, p.subject.trim().slice(0, 80)) : null;
    if (p.expiresOn !== undefined) set.expiresAt = expiry(p.expiresOn);
    if (p.pinned !== undefined) set.pinned = p.pinned;
    const [row] = await tx.update(memory).set(set).where(eq(memory.id, id)).returning();
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "memory.update", detail: { id, via: "app" } });
    return view(a.vault, a.workspaceId, row!);
  });
}

/** Forgetting deletes the row for real. It does not hide it. */
export async function forgetMemory(a: Actor, id: string, via: "chat" | "app" = "app") {
  return a.tenant(async (tx) => {
    const rows = await tx.delete(memory).where(and(eq(memory.id, id), eq(memory.userId, a.userId))).returning({ id: memory.id });
    if (rows.length) await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "memory.forget", detail: { id, via } });
    return rows.length > 0;
  });
}

// ---- Tidying and undo

/** Notes tidied in the last two weeks, for the Memory tab's "undo" panel. */
export async function recentlyTidied(a: Actor, now = new Date()) {
  return a.tenant(async (tx) => {
    const since = new Date(now.getTime() - TIDY_UNDO_DAYS * 86_400_000);
    const rows = await tx
      .select()
      .from(memory)
      .where(and(eq(memory.userId, a.userId), sql`(${memory.archivedAt} >= ${since.toISOString()}::timestamptz or (${memory.previousEnc} is not null and ${memory.updatedAt} >= ${since.toISOString()}::timestamptz))`))
      .orderBy(desc(memory.updatedAt));
    return rows.map((r) => view(a.vault, a.workspaceId, r, now));
  });
}

/** Put a tidied note back: an archived one returns, a shortened one gets its old wording back. */
export async function restoreMemory(a: Actor, id: string) {
  return a.tenant(async (tx) => {
    const [cur] = await tx.select().from(memory).where(and(eq(memory.id, id), eq(memory.userId, a.userId)));
    if (!cur) return null;
    const set: Partial<typeof memory.$inferInsert> = { updatedAt: new Date() };
    if (cur.archivedAt) {
      set.archivedAt = null;
      set.archivedReason = null;
    } else if (cur.previousEnc) {
      set.contentEnc = cur.previousEnc;
      set.previousEnc = null;
    } else return null;
    const [row] = await tx.update(memory).set(set).where(eq(memory.id, id)).returning();
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "memory.restore", detail: { id } });
    return view(a.vault, a.workspaceId, row!);
  });
}

