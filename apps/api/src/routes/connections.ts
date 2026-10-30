import { and, desc, eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { auditLog, connections } from "../db/schema.js";
import { connectorById } from "../lib/connectors.js";
import type { GoogleSecret } from "../lib/gmail.js";

// Linked accounts. The secret (an API key or token) goes in encrypted and never comes back out:
// no endpoint returns it. Only server-side tool code can read it, through readConnectionSecret.
export const connectionRoutes: FastifyPluginAsync<Deps> = async (app, { db, vault, google }) => {
  app.get("/v1/connections", async (req) => {
    const { workspaceId } = req.auth!;
    const items = await withTenant(db, workspaceId, (tx) =>
      tx
        .select({ id: connections.id, provider: connections.provider, label: connections.label, status: connections.status, createdAt: connections.createdAt })
        .from(connections)
        .orderBy(desc(connections.createdAt)),
    );
    // Whether the Google login can use the calendar. Only a yes or no leaves here, never the secret.
    const full = await withTenant(db, workspaceId, (tx) => tx.select({ id: connections.id, secretEnc: connections.secretEnc }).from(connections).where(eq(connections.provider, "google")));
    const cal = new Set(full.filter((c) => vault.openJson<GoogleSecret>(workspaceId, c.secretEnc).calendar === true).map((c) => c.id));
    return { items: items.map((i) => (i.provider === "google" ? { ...i, calendar: cal.has(i.id) } : i)), google: { configured: google?.configured === true } };
  });

  app.post("/v1/connections", async (req, reply) => {
    const { workspaceId, userId, role } = req.auth!;
    if (role !== "admin") return reply.code(403).send({ error: "admins_only" });
    const body = z
      .object({ provider: z.string().trim().min(1).max(40).refine((p) => p.toLowerCase() !== "google", "Connect Google with Sign in with Google").refine((p) => !connectorById(p.toLowerCase()), "Use the Connect button for that one"), label: z.string().trim().max(100).default(""), secret: z.string().min(1).max(8000) })
      .parse(req.body);
    const item = await withTenant(db, workspaceId, async (tx) => {
      const [c] = await tx
        .insert(connections)
        .values({ workspaceId, provider: body.provider, label: body.label, secretEnc: vault.seal(workspaceId, body.secret) })
        .returning({ id: connections.id, provider: connections.provider, label: connections.label, status: connections.status, createdAt: connections.createdAt });
      await tx.insert(auditLog).values({ workspaceId, userId, action: "connection.add", detail: { id: c!.id, provider: body.provider } });
      return c!;
    });
    return reply.code(201).send({ item });
  });

  app.delete("/v1/connections/:id", async (req, reply) => {
    const { workspaceId, userId, role } = req.auth!;
    if (role !== "admin") return reply.code(403).send({ error: "admins_only" });
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const gone = await withTenant(db, workspaceId, async (tx) => {
      const rows = await tx.delete(connections).where(and(eq(connections.id, id), eq(connections.workspaceId, workspaceId))).returning({ id: connections.id, provider: connections.provider, secretEnc: connections.secretEnc });
      if (rows.length) await tx.insert(auditLog).values({ workspaceId, userId, action: "connection.remove", detail: { id } });
      return rows[0];
    });
    if (!gone) return reply.code(404).send({ error: "not_found" });
    // Disconnecting Gmail also tells Google to cancel the login, so removing it here really removes access.
    if (gone.provider === "google" && google) {
      google.forget(id);
      await google.revoke(vault.openJson<GoogleSecret>(workspaceId, gone.secretEnc).refreshToken);
    }
    return { ok: true };
  });
};
