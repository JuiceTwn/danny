import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { APP_CSP, AppError, deleteApp, getApp, listApps, requestChange, retryApp, saveState, withBootstrap } from "../lib/miniapps.js";
import type { Actor } from "../lib/tasks.js";

/**
 * Mini apps. The page is served by itself, from a URL that needs the person's login, with headers that put it in a sandbox
 * (no cookies, no storage, no way to call this API or any other address). Danny's own page holds it in an iframe, hands it the
 * progress that was saved and saves what it sends back. Nothing the page does reaches anything else.
 */
export const appRoutes: FastifyPluginAsync<Deps> = async (app, { db, vault, config }) => {
  const actor = (req: { auth?: { workspaceId: string; userId: string } }): Actor => {
    const { workspaceId, userId } = req.auth!;
    return { workspaceId, userId, vault, tenant: (fn) => withTenant(db, workspaceId, fn) };
  };
  const id = (req: { params: unknown }) => z.object({ id: z.uuid() }).parse(req.params).id;
  const allowed = (req: { auth?: { isOwner: boolean } }) => config.miniApps === "all" || (config.miniApps === "owner" && req.auth!.isOwner);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) return reply.code(400).send({ error: "invalid_request", message: err.message });
    throw err;
  });

  app.get("/v1/apps", async (req) => ({ enabled: allowed(req), items: await listApps(actor(req)) }));

  app.get("/v1/apps/:id", async (req, reply) => {
    const a = await getApp(actor(req), id(req));
    if (!a) return reply.code(404).send({ error: "not_found" });
    const { html: _html, ...meta } = a;
    return { ...meta, hasPage: Boolean(a.html) };
  });

  // The page itself. It is data written by a model, served like an untrusted download that is allowed to run inside a locked frame.
  app.get("/v1/apps/:id/html", async (req, reply) => {
    // The sandbox keeps a page away from your cookies and from Danny, but a page opened on its own can still send the tab somewhere else.
    // So it is only served into a frame. (Browsers say what a request is for; one that says nothing, an old browser, is let through.)
    const dest = req.headers["sec-fetch-dest"];
    if (dest && dest !== "iframe") return reply.code(403).send({ error: "frame_only", message: "Open this from the Apps tab." });
    const a = await getApp(actor(req), id(req));
    if (!a?.html) return reply.code(404).send({ error: "not_found" });
    return reply
      .header("content-security-policy", APP_CSP)
      .header("x-content-type-options", "nosniff")
      .header("x-frame-options", "SAMEORIGIN")
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "private, no-store")
      .type("text/html; charset=utf-8")
      .send(withBootstrap(a.html));
  });

  app.put("/v1/apps/:id/state", async (req, reply) => {
    const body = z.object({ state: z.record(z.string(), z.unknown()) }).parse(req.body);
    return (await saveState(actor(req), id(req), body.state)) ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });

  app.post("/v1/apps/:id/change", async (req, reply) => {
    if (!allowed(req)) return reply.code(403).send({ error: "not_available" });
    const { request } = z.object({ request: z.string().trim().min(3).max(600) }).parse(req.body);
    return (await requestChange(actor(req), id(req), request)) ? { ok: true } : reply.code(409).send({ error: "not_ready", message: "That app isn't finished yet." });
  });

  app.post("/v1/apps/:id/retry", async (req, reply) => {
    if (!allowed(req)) return reply.code(403).send({ error: "not_available" });
    return (await retryApp(actor(req), id(req))) ? { ok: true } : reply.code(409).send({ error: "not_failed" });
  });

  app.delete("/v1/apps/:id", async (req, reply) => ((await deleteApp(actor(req), id(req))) ? { ok: true } : reply.code(404).send({ error: "not_found" })));
};
