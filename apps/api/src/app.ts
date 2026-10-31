import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import Fastify from "fastify";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import type { ModelClient } from "./brain/model.js";
import type { Db } from "./db/client.js";
import { Health } from "./lib/health.js";
import { GoogleService } from "./lib/google.js";
import type { PushSender } from "./lib/push.js";
import { ApiKeys } from "./lib/api-keys.js";
import { TurnLock } from "./lib/turn-lock.js";
import type { Transcriber } from "./lib/transcribe.js";
import type { Vault } from "./lib/vault.js";
import type { ToolRegistry } from "./tools/registry.js";
import { connectionRoutes } from "./routes/connections.js";
import { chatRoutes } from "./routes/chat.js";
import { adminRoutes } from "./routes/admin.js";
import { approvalRoutes } from "./routes/approvals.js";
import { authRoutes, loadSession, type AuthCtx } from "./routes/auth.js";
import { googleRoutes } from "./routes/google.js";
import { inviteRequestRoutes } from "./routes/invite-requests.js";
import { memoryRoutes } from "./routes/memory.js";
import { settingsRoutes } from "./routes/settings.js";
import { taskRoutes } from "./routes/tasks.js";
import { goalRoutes } from "./routes/goals.js";
import { connectorRoutes } from "./routes/connectors.js";
import { interestRoutes } from "./routes/interests.js";
import { styleRoutes } from "./routes/style.js";
import { previewRoutes } from "./routes/preview.js";
import { transcribeRoutes } from "./routes/transcribe.js";
import { callRoutes } from "./routes/call.js";

export type Deps = { config: Config; db: Db; model: ModelClient; tools: ToolRegistry; vault: Vault; push: PushSender; google: GoogleService | null; health?: Health; fetchFn?: typeof fetch; previewFetch?: import("./lib/preview.js").FetchPage; transcriber?: Transcriber | null; keys?: ApiKeys; turnLock?: TurnLock; call?: import("./lib/call/providers.js").CallProviders; callOptions?: import("./lib/call/session.js").CallOptions };

declare module "fastify" {
  interface FastifyRequest {
    auth?: AuthCtx;
  }
}

export async function buildApp(deps: Deps) {
  // There is always a Google service. It is "not configured" until the server has a client ID and secret, which the owner can enter in the app.
  deps.google ??= new GoogleService(null);
  deps.turnLock ??= new TurnLock();
  deps.keys ??= new ApiKeys({ anthropic: deps.config.anthropicApiKey, elevenlabs: deps.config.elevenlabsApiKey });
  const { config } = deps;
  const app = Fastify({
    logger: config.env === "test" ? false : { redact: ["req.headers.cookie", "req.headers.authorization"] },
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
  });

  await app.register(helmet, {
    // No inline scripts, no outside hosts. The app talks only to its own origin.
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", "data:"],
        fontSrc: ["'self'", "data:"],
        // Calls use a WebSocket back to this same address. Some browsers don't count "self" for ws://, so name it.
        connectSrc: ["'self'", ...[...config.appOrigins].map((o) => o.replace(/^http/, "ws"))],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.cookieSecure ? { upgradeInsecureRequests: [] } : {}),
      },
    },
  });
  await app.register(cookie);
  // Audio frames from the phone are small (a tenth of a second is about 3 KB).
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  // Rate limits protect the API. Static files for the app itself are not counted.
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute", allowList: (req) => !req.url.startsWith("/v1/") });

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

  // Liveness: the process answers. Cheap, safe to expose, fine for an outside uptime monitor.
  app.get("/healthz", async () => ({ ok: true }));
  // Readiness: the database answers and the reminder scheduler is still ticking. For the watchdog and Docker's health status.
  // It says which check failed and nothing else. The reverse proxy does not expose it to the internet.
  const health = deps.health ?? new Health(false);
  app.get("/readyz", async (_req, reply) => {
    const db = await Promise.race([deps.db.execute(sql`select 1`).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]).catch(() => false);
    const scheduler = health.schedulerOk();
    return reply.code(db && scheduler ? 200 : 503).send({ ok: db && scheduler, db, scheduler });
  });
  await app.register(inviteRequestRoutes, deps);
  await app.register(authRoutes, deps);

  // Everything below needs a signed-in session.
  await app.register(async (r) => {
    r.addHook("preHandler", async (req, reply) => {
      const auth = await loadSession(deps, req);
      if (!auth) return reply.code(401).send({ error: "unauthorized" });
      req.auth = auth;
    });
    await r.register(chatRoutes, deps);
    await r.register(memoryRoutes, deps);
    await r.register(connectionRoutes, deps);
    await r.register(googleRoutes, deps);
    await r.register(approvalRoutes, deps);
    await r.register(settingsRoutes, deps);
    await r.register(taskRoutes, deps);
    await r.register(goalRoutes, deps);
    await r.register(connectorRoutes, deps);
    await r.register(interestRoutes, deps);
    await r.register(styleRoutes, deps);
    await r.register(previewRoutes, deps);
    await r.register(transcribeRoutes, deps);
    await r.register(callRoutes, deps);
    await r.register(adminRoutes, deps);
  });

  const webDir = config.webDir ?? resolve(process.cwd(), "../web/dist");
  if (existsSync(resolve(webDir, "index.html"))) {
    await app.register(fastifyStatic, {
      root: webDir,
      wildcard: false,
      setHeaders: (res, path) => {
        // Built assets have hashed names and never change. Everything else (index.html, sw.js) must be re-checked.
        res.header("cache-control", path.includes("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      },
    });
    // Links into the app (like /accept?token=...) get the app. Unknown API paths stay a JSON 404.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/v1/") && !/\.[a-z0-9]+(\?|$)/i.test(req.url)) {
        return reply.header("cache-control", "no-cache").sendFile("index.html");
      }
      return reply.code(404).send({ error: "not_found" });
    });
  }

  return app;
}
