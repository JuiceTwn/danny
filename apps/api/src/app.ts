import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import type { Db } from "./db/client.js";
import { adminRoutes } from "./routes/admin.js";
import { approvalRoutes } from "./routes/approvals.js";
import { authRoutes, loadSession, type AuthCtx } from "./routes/auth.js";
import { inviteRequestRoutes } from "./routes/invite-requests.js";
import { memoryRoutes } from "./routes/memory.js";
import { settingsRoutes } from "./routes/settings.js";

export type Deps = { config: Config; db: Db };

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthCtx;
  }
}

export async function buildApp(deps: Deps) {
  const { config } = deps;
  const app = Fastify({
    logger: config.env === "test" ? false : { redact: ["req.headers.cookie", "req.headers.authorization"] },
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
  });

  await app.register(helmet, {
    // JSON API: nothing here should ever be rendered, so lock it down hard.
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_request", issues: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? "server_error" : err.message });
  });

  // Same-origin check for every state-changing request. Public invite requests do their own CORS.
  app.addHook("onRequest", async (req, reply) => {
    const safe = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
    if (safe || req.url.startsWith("/v1/invite-requests")) return;
    const origin = req.headers.origin;
    if (!origin || !config.appOrigins.has(origin)) return reply.code(403).send({ error: "bad_origin" });
  });

  app.get("/healthz", async () => ({ ok: true }));
  await app.register(inviteRequestRoutes, deps);
  await app.register(authRoutes, deps);

  // Everything below needs a signed-in session.
  await app.register(async (r) => {
    r.addHook("preHandler", async (req, reply) => {
      const auth = await loadSession(deps, req);
      if (!auth) return reply.code(401).send({ error: "unauthorized" });
      req.auth = auth;
    });
    await r.register(memoryRoutes, deps);
    await r.register(approvalRoutes, deps);
    await r.register(settingsRoutes, deps);
    await r.register(adminRoutes, deps);
  });

  return app;
}
