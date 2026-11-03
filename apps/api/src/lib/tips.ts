import { and, count, eq, sql } from "drizzle-orm";
import { withTenant } from "../db/client.js";
import { connections, followedTeams, goals, interests, pushSubscriptions, tipsSent, users } from "../db/schema.js";
import { deliver, type BackgroundDeps } from "./background.js";
import type { Card } from "./cards.js";
import { readStyle } from "./style.js";

/**
 * "btw, I can also do this": one gentle suggestion at a time, about something Danny can do that the person has not set up. Fixed wording and no
 * model call. Each is said once, only while it still applies, never more than one every 3 days, and only mid-day. It lands in the chat without a
 * buzz. The replies are buttons: tapping one just sends that sentence, and Danny does the rest in chat.
 */
type State = { location: boolean; follows: boolean; goals: boolean; push: boolean; google: boolean; wrapup: boolean };
type Tip = { key: string; applies: (s: State, deps: BackgroundDeps) => boolean; text: string; replies?: string[] };

export const TIPS: Tip[] = [
  {
    key: "location",
    applies: (s) => !s.location,
    text: "btw, tell me what city you're in and I'll put the weather in your morning brief. Just reply with a city. (If these little suggestions are too much, say \"stop the tips\".)",
  },
  {
    key: "follows",
    applies: (s) => !s.follows,
    text: "btw, I can add news and scores to your morning brief if you're interested: topics like tech or AI, your NHL or MLB teams, and one good-news story each morning. Tell me what you like, or tap one.",
    replies: ["Add a good news story", "Tech news", "Follow a team"],
  },
  {
    key: "wrapup",
    applies: (s) => !s.wrapup,
    text: "btw, I can also send a short wrap-up in the evening: what got done, what's still open and tomorrow's top three. Want it?",
    replies: ["Yes, evening wrap-up", "No thanks"],
  },
  {
    key: "push",
    applies: (s, d) => !s.push && Boolean(d.push.publicKey),
    text: "btw, I can buzz your phone for reminders instead of only leaving them here. Open Settings and turn on notifications; it takes one tap.",
  },
  {
    key: "google",
    applies: (s, d) => !s.google && Boolean(d.google?.configured),
    text: "btw, if you connect Gmail and Google Calendar (Settings, Connections), I can point out the emails that need you, put your day in the brief, and give you a heads-up before events. Totally optional.",
  },
  {
    key: "goals",
    applies: (s) => !s.goals,
    text: "btw, if you're working toward something (a job, a move, something you want to buy), tell me. I'll keep an eye on the web for it and only speak up when something new turns up.",
  },
];

type Due = { workspace_id: string; user_id: string; timezone: string };

/** Send the next suggestion to anyone who is due one. Returns how many went out. */
export async function runTips(deps: BackgroundDeps, now = new Date()) {
  const { db, vault } = deps;
  const due = (await db.execute<Due>(sql`select * from due_tips(${now.toISOString()}::timestamptz)`)) as unknown as Due[];
  let sent = 0;
  const done = new Set<string>();
  for (const d of due) {
    if (done.has(d.user_id)) continue; // a person in two workspaces is told once
    done.add(d.user_id);
    try {
      const picked = await withTenant(db, d.workspace_id, async (tx): Promise<Tip | null> => {
        const [u] = await tx.select({ wrapup: users.wrapupEnabled, tips: users.tips }).from(users).where(eq(users.id, d.user_id));
        if (!u?.tips) return null;
        const style = await readStyle(tx, vault, d.workspace_id, d.user_id);
        const n = async (table: typeof interests | typeof followedTeams | typeof goals | typeof pushSubscriptions) =>
          Number((await tx.select({ c: count() }).from(table).where(eq(table.userId, d.user_id)))[0]?.c ?? 0);
        const [google] = await tx.select({ id: connections.id }).from(connections).where(and(eq(connections.provider, "google"), eq(connections.status, "active"))).limit(1);
        const state: State = {
          location: Boolean(style.location),
          follows: (await n(interests)) + (await n(followedTeams)) > 0,
          goals: (await n(goals)) > 0,
          push: (await n(pushSubscriptions)) > 0,
          google: Boolean(google),
          wrapup: u.wrapup,
        };
        const have = new Set((await tx.select({ k: tipsSent.key }).from(tipsSent).where(eq(tipsSent.userId, d.user_id))).map((r) => r.k));
        for (const tip of TIPS) {
          if (have.has(tip.key) || !tip.applies(state, deps)) continue;
          // Claim it before saying it, so two passes never say it twice.
          const rows = await tx.insert(tipsSent).values({ workspaceId: d.workspace_id, userId: d.user_id, key: tip.key, sentAt: now }).onConflictDoNothing().returning({ id: tipsSent.id });
          return rows.length ? tip : null;
        }
        return null;
      });
      if (!picked) continue;
      const cards: Card[] = picked.replies ? [{ kind: "replies", options: picked.replies }] : [];
      await deliver(deps, { workspaceId: d.workspace_id, userId: d.user_id }, picked.text, { title: "Danny", body: picked.text }, false, cards);
      sent++;
    } catch (err) {
      deps.log?.error({ err, user: d.user_id }, "tip failed");
    }
  }
  return sent;
}
