import { z } from "zod";
import { followTeamNamed, listTeams, setTeamAlerts, TeamError, unfollowTeam } from "../lib/teams.js";
import { defineTool } from "./registry.js";

export const followTeamTool = defineTool({
  name: "follow_team",
  description:
    "Follow an NHL or MLB team: their last score and today's game go in the morning briefing, and by default Danny sends a heads-up before each game and the final score after. " +
    "Use it when they say they follow or root for a team ('the Leafs', 'Blue Jays'). If the name could be two teams (Toronto, New York, Rangers) the tool says so: ask which.",
  kind: "internal",
  input: z.object({ team: z.string().trim().min(2).max(60), league: z.enum(["nhl", "mlb"]).optional() }),
  run: async (ctx, { team, league }) => {
    try {
      const t = await followTeamNamed(ctx, team, league);
      return `Following the ${t.fullName} (${t.leagueName}). They're in the briefing, and Danny will tell them before each game and when it ends. They can turn those alerts off.`;
    } catch (e) {
      if (e instanceof TeamError) return e.message;
      throw e;
    }
  },
});

export const listTeamsTool = defineTool({
  name: "list_teams",
  description: "List the sports teams the user follows, with ids and whether game alerts are on. Use it before changing or removing one.",
  kind: "read",
  input: z.object({}),
  run: async (ctx) => {
    const all = await listTeams(ctx);
    return all.length ? all.map((t) => `${t.id} | ${t.fullName} (${t.leagueName}) | alerts ${t.notify ? "on" : "off"}`).join("\n") : "They follow no teams yet.";
  },
});

export const teamAlertsTool = defineTool({
  name: "set_team_alerts",
  description: "Turn the before-the-game and final-score notifications on or off for one followed team. The team stays in the briefing either way. Take the id from list_teams.",
  kind: "internal",
  input: z.object({ id: z.uuid(), on: z.boolean() }),
  run: async (ctx, { id, on }) => ((await setTeamAlerts(ctx, id, on)) ? (on ? "Game alerts on." : "Game alerts off. Still in the briefing.") : "No team with that id."),
});

export const unfollowTeamTool = defineTool({
  name: "unfollow_team",
  description: "Stop following a team. Take the id from list_teams.",
  kind: "internal",
  input: z.object({ id: z.uuid() }),
  run: async (ctx, { id }) => ((await unfollowTeam(ctx, id)) ? "Removed." : "No team with that id."),
});

export const teamTools = [followTeamTool, listTeamsTool, teamAlertsTool, unfollowTeamTool];
