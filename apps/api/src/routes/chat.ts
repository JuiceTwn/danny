import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { FEATURES } from "../brain/router.js";
import { history, lastRequest, runTurn, type ChatEvent } from "../brain/run.js";
import type { Deps } from "../app.js";

export const chatRoutes: FastifyPluginAsync<Deps> = async (app, deps) => {
  // One turn at a time per workspace. This also keeps parallel requests from running past the spend cap.
  // In-memory, so it holds for a single server process.
  const busy = new Set<string>();

  app.post("/v1/chat", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { workspaceId, userId } = req.auth!;
    const body = z
      .object({
        message: z.string().trim().min(1).max(8000).optional(),
        // Text pulled out of files the user attached. Total size is held under the request body limit.
        attachments: z.array(z.object({ name: z.string().trim().min(1).max(200), text: z.string().min(1).max(100_000) })).max(5).optional(),
        feature: z.enum(FEATURES).optional(),
        model: z.literal("opus").optional(), // the only model the user can ask for: Haiku and Sonnet are the router's call
        retryOf: z.uuid().optional(), // "Answer better"
      })
      .refine((b) => b.message || b.retryOf, { message: "message or retryOf is required" })
      .parse(req.body);
    if (busy.has(workspaceId)) return reply.code(429).send({ error: "busy", message: "Danny is still on your last message." });
    busy.add(workspaceId);

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no", "x-content-type-options": "nosniff" });
    let closed = false;
    raw.on("close", () => (closed = true));
    const emit = (e: ChatEvent) => {
      if (!closed) raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    try {
      await runTurn(
        deps,
        { workspaceId, userId },
        { text: body.message ?? "", attachments: body.attachments, feature: body.feature, askedForOpus: body.model === "opus", retryOf: body.retryOf },
        emit,
        () => closed,
      );
    } catch (err) {
      req.log.error(err);
      emit({ type: "error", code: "model_failed", message: "Something broke on our side. Try again." });
    } finally {
      busy.delete(workspaceId);
      raw.end();
    }
  });

  app.get("/v1/chat/history", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const { workspaceId, userId } = req.auth!;
    return { messages: await history(deps.db, deps.vault, workspaceId, userId, limit), lastRequest: await lastRequest(deps.db, workspaceId) };
  });

  app.get("/v1/tools", async () => ({
    tools: deps.tools.list().map((t) => ({ name: t.name, description: t.description, kind: t.kind })),
  }));
};
