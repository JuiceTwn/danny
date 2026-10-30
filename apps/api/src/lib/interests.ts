import { and, asc, eq } from "drizzle-orm";
import { auditLog, interests } from "../db/schema.js";
import type { Actor } from "./tasks.js";

export const MAX_INTERESTS = 15;
export type InterestView = { id: string; topic: string };
export class InterestError extends Error {}

export async function listInterests(a: Actor): Promise<InterestView[]> {
  return a.tenant(async (tx) => {
    const rows = await tx.select().from(interests).where(eq(interests.userId, a.userId)).orderBy(asc(interests.createdAt));
    return rows.map((r) => ({ id: r.id, topic: a.vault.open(a.workspaceId, r.topicEnc) }));
  });
}

export async function addInterest(a: Actor, topic: string): Promise<InterestView> {
  return a.tenant(async (tx) => {
    const rows = await tx.select().from(interests).where(eq(interests.userId, a.userId));
    if (rows.length >= MAX_INTERESTS) throw new InterestError(`That's ${MAX_INTERESTS} topics already. Remove one first.`);
    const lower = topic.toLowerCase();
    const dup = rows.find((r) => a.vault.open(a.workspaceId, r.topicEnc).toLowerCase() === lower);
    if (dup) return { id: dup.id, topic: a.vault.open(a.workspaceId, dup.topicEnc) };
    const [row] = await tx.insert(interests).values({ workspaceId: a.workspaceId, userId: a.userId, topicEnc: a.vault.seal(a.workspaceId, topic) }).returning();
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "interest.add", detail: { id: row!.id } });
    return { id: row!.id, topic };
  });
}

export async function removeInterest(a: Actor, id: string) {
  return a.tenant(async (tx) => {
    const gone = await tx.delete(interests).where(and(eq(interests.id, id), eq(interests.userId, a.userId))).returning({ id: interests.id });
    if (gone.length) await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "interest.remove", detail: { id } });
    return gone.length > 0;
  });
}
