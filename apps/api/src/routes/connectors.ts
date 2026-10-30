import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { auditLog, connections } from "../db/schema.js";
import type { GoogleSecret } from "../lib/gmail.js";
import { ConnectorError, CONNECTORS, connectorById } from "../lib/connectors.js";

// One place that lists everything Danny can connect to and where each one stands, so the app can show one simple screen.
export const connectorRoutes: FastifyPluginAsync<Deps> = async (app, { db, vault, google, fetchFn }) => {
  app.get("/v1/connectors", async (req) => {
    const { workspaceId, isOwner, role } = req.auth!;
    const rows = await withTenant(db, workspaceId, (tx) => tx.select().from(connections).orderBy(desc(connections.createdAt)));
    const latest = (provider: string) => rows.find((r) => r.provider === provider);

    const g = latest("google");
    const calendar = g ? vault.openJson<GoogleSecret>(workspaceId, g.secretEnc).calendar === true : false;
    const googleState = !google?.configured ? "needs_setup" : !g ? "ready" : g.status === "active" ? "connected" : "reconnect";

    return {
      canConnect: role === "admin",
      items: [
        {
          id: "google",
          kind: "oauth",
          name: "Gmail and Calendar",
          blurb: "Read your mail and calendar, and draft replies and events. Nothing is sent or added until you tap Approve. Danny can't delete anything.",
          state: googleState,
          connectionId: g?.id ?? null,
          label: g?.label ?? null,
          calendar,
          canSetUp: isOwner && google?.source !== "env",
          setUpBy: google?.source ?? "none",
        },
        ...CONNECTORS.map((c) => {
          const r = latest(c.id);
          return {
            id: c.id,
            kind: "token",
            name: c.name,
            blurb: c.blurb,
            fields: c.fields,
            steps: c.steps,
            helpUrl: c.helpUrl,
            state: !r ? "ready" : r.status === "active" ? "connected" : "reconnect",
            connectionId: r?.id ?? null,
            label: r?.label ?? null,
          };
        }),
      ],
    };
  });

  // Connect something that takes a pasted key or token. It is checked against the real service first, so a typo is caught here
  // and not later when Danny tries to use it. The secret is stored encrypted and never comes back out.
  app.post("/v1/connectors/:id/connect", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { workspaceId, userId, role } = req.auth!;
    if (role !== "admin") return reply.code(403).send({ error: "admins_only" });
    const { id } = z.object({ id: z.string().max(40) }).parse(req.params);
    const def = connectorById(id);
    if (!def) return reply.code(404).send({ error: "not_found" });
    const values = z.object({ values: z.record(z.string(), z.string().max(2000)) }).parse(req.body).values;
    for (const f of def.fields) if (!values[f.key]?.trim()) return reply.code(400).send({ error: "invalid_request", message: `${f.label} is empty.` });

    let label: string;
    try {
      label = await def.verify(Object.fromEntries(def.fields.map((f) => [f.key, values[f.key]!.trim()])), fetchFn ?? fetch);
    } catch (e) {
      if (e instanceof ConnectorError) return reply.code(400).send({ error: "invalid_request", message: e.message });
      return reply.code(502).send({ error: "unreachable", message: `Couldn't reach ${def.name} to check that. Try again in a minute.` });
    }
    const secret = Object.fromEntries(def.fields.map((f) => [f.key, values[f.key]!.trim()]));
    await withTenant(db, workspaceId, async (tx) => {
      await tx.delete(connections).where(and(eq(connections.provider, def.id)));
      const [c] = await tx.insert(connections).values({ workspaceId, provider: def.id, label, secretEnc: vault.sealJson(workspaceId, secret) }).returning({ id: connections.id });
      await tx.insert(auditLog).values({ workspaceId, userId, action: "connection.add", detail: { id: c!.id, provider: def.id } });
    });
    return reply.code(201).send({ ok: true, label });
  });
};
