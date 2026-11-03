import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { LEAGUE_NAMES, TEAMS, fullName, teamByCode } from "../lib/sports.js";
import type { Actor } from "../lib/tasks.js";
import { followTeam, listTeams, setTeamAlerts, TeamError, unfollowTeam } from "../lib/teams.js";

export const teamRoutes: FastifyPluginAsync<Deps> = async (app, { db, vault }) => {
  const actor = (req: { auth?: { workspaceId: string; userId: string } }): Actor => {
    const { workspaceId, userId } = req.auth!;
    return { workspaceId, userId, vault, tenant: (fn) => withTenant(db, workspaceId, fn) };
  };

  app.get("/v1/teams", async (req) => ({ items: await listTeams(actor(req)) }));

  // Every team the picker can offer.
  app.get("/v1/teams/catalog", async () => ({
    items: TEAMS.map((t) => ({ league: t.league, leagueName: LEAGUE_NAMES[t.league], code: t.code, name: t.name, fullName: fullName(t) })).sort((a, b) => a.fullName.localeCompare(b.fullName)),
  }));

  app.post("/v1/teams", async (req, reply) => {
    const { league, code, notify } = z.object({ league: z.enum(["nhl", "mlb"]), code: z.string().trim().min(2).max(4), notify: z.boolean().optional() }).parse(req.body);
    const team = teamByCode(league, code);
    if (!team) return reply.code(400).send({ error: "invalid_request", message: "Unknown team." });
    try {
      return reply.code(201).send({ item: await followTeam(actor(req), team, notify ?? true) });
    } catch (e) {
      if (e instanceof TeamError) return reply.code(400).send({ error: "invalid_request", message: e.message });
      throw e;
    }
  });

  app.patch("/v1/teams/:id", async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { notify } = z.object({ notify: z.boolean() }).parse(req.body);
    return (await setTeamAlerts(actor(req), id, notify)) ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });

  app.delete("/v1/teams/:id", async (req, reply) => {
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    return (await unfollowTeam(actor(req), id)) ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });
};
