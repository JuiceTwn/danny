import { and, asc, eq } from "drizzle-orm";
import { auditLog, followedTeams } from "../db/schema.js";
import { findTeams, fullName, LEAGUE_NAMES, teamByCode, type League, type Team } from "./sports.js";
import type { Actor } from "./tasks.js";

export const MAX_TEAMS = 8;
export type FollowedView = { id: string; league: League; code: string; name: string; fullName: string; leagueName: string; notify: boolean };
export class TeamError extends Error {}

type Stored = { league: League; code: string };
const view = (a: Actor, r: typeof followedTeams.$inferSelect): FollowedView | null => {
  const s = a.vault.openJson<Stored>(a.workspaceId, r.teamEnc);
  const t = teamByCode(s.league, s.code);
  return t ? { id: r.id, league: t.league, code: t.code, name: t.name, fullName: fullName(t), leagueName: LEAGUE_NAMES[t.league], notify: r.notify } : null;
};

export async function listTeams(a: Actor): Promise<FollowedView[]> {
  return a.tenant(async (tx) => {
    const rows = await tx.select().from(followedTeams).where(eq(followedTeams.userId, a.userId)).orderBy(asc(followedTeams.createdAt));
    return rows.map((r) => view(a, r)).filter((v): v is FollowedView => v !== null);
  });
}

/** Follow a team by league and code (from the picker). Following one that is already followed returns it unchanged. */
export async function followTeam(a: Actor, team: Team, notify = true): Promise<FollowedView> {
  return a.tenant(async (tx) => {
    const rows = await tx.select().from(followedTeams).where(eq(followedTeams.userId, a.userId));
    const have = rows.map((r) => view(a, r));
    const dup = have.find((v) => v && v.league === team.league && v.code === team.code);
    if (dup) return dup;
    if (rows.length >= MAX_TEAMS) throw new TeamError(`That's ${MAX_TEAMS} teams already. Remove one first.`);
    const [row] = await tx
      .insert(followedTeams)
      .values({ workspaceId: a.workspaceId, userId: a.userId, teamEnc: a.vault.sealJson(a.workspaceId, { league: team.league, code: team.code } satisfies Stored), notify })
      .returning();
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "team.follow", detail: { id: row!.id } });
    return view(a, row!)!;
  });
}

/** Follow a team by what the person called it. Says which ones it could be when that is not clear. */
export async function followTeamNamed(a: Actor, query: string, league?: League): Promise<FollowedView> {
  const found = findTeams(query, league);
  if (!found.length) throw new TeamError(`I don't know a team called "${query}". I cover the NHL and MLB.`);
  if (found.length > 1) throw new TeamError(`"${query}" could be ${found.map((t) => `${fullName(t)} (${LEAGUE_NAMES[t.league]})`).join(" or ")}. Which one?`);
  return followTeam(a, found[0]!);
}

export async function setTeamAlerts(a: Actor, id: string, notify: boolean) {
  return a.tenant(async (tx) => {
    const done = await tx.update(followedTeams).set({ notify }).where(and(eq(followedTeams.id, id), eq(followedTeams.userId, a.userId))).returning({ id: followedTeams.id });
    if (done.length) await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "team.alerts", detail: { id, notify } });
    return done.length > 0;
  });
}

export async function unfollowTeam(a: Actor, id: string) {
  return a.tenant(async (tx) => {
    const gone = await tx.delete(followedTeams).where(and(eq(followedTeams.id, id), eq(followedTeams.userId, a.userId))).returning({ id: followedTeams.id });
    if (gone.length) await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "team.unfollow", detail: { id } });
    return gone.length > 0;
  });
}
