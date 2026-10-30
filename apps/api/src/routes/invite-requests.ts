import { sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { emailSchema } from "../lib/validation.js";
import type { Deps } from "../app.js";
import { inviteRequests } from "../db/schema.js";

// Public. The marketing site's "Ask for an invite" form posts here.
export const inviteRequestRoutes: FastifyPluginAsync<Deps> = async (app, { db, config }) => {
  const cors = (origin: string | undefined) =>
    origin && config.marketingOrigins.has(origin)
      ? { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", vary: "origin" }
      : {};

  app.options("/v1/invite-requests", async (req, reply) => reply.code(204).headers(cors(req.headers.origin)).send());

  app.post("/v1/invite-requests", { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } }, async (req, reply) => {
    const { email } = z.object({ email: emailSchema }).parse(req.body);
    await db.insert(inviteRequests).values({ email }).onConflictDoUpdate({ target: inviteRequests.email, set: { createdAt: sql`now()` } });
    // Same answer whether or not the email was already on the list.
    return reply.code(202).headers(cors(req.headers.origin)).send({ ok: true });
  });
};
