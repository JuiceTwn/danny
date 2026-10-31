import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { history, runTurn, type BrainDeps, type ChatEvent } from "../brain/run.js";
import type { Deps } from "../app.js";

export const chatRoutes: FastifyPluginAsync<Deps> = async (app, deps) => {
  // One turn at a time per workspace. This also keeps parallel requests from running past the spend cap.
  // In-memory, so it holds for a single server process.
  const busy = new Map<string, symbol>();

  app.post("/v1/chat", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { workspaceId, userId } = req.auth!;
    const { message } = z.object({ message: z.string().trim().min(1).max(8000) }).parse(req.body);
    // Free the workspace for the next message as soon as the reply is done, but never free someone else's turn.
    const release = deps.turnLock!.tryAcquire(workspaceId);
    if (!release) return reply.code(429).send({ error: "busy", message: "Danny is still on your last message." });

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no", "x-content-type-options": "nosniff" });
    let closed = false;
    raw.on("close", () => (closed = true));
    const emit = (e: ChatEvent) => {
      if (!closed) raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    try {
      await runTurn(deps, { workspaceId, userId }, message, emit, () => closed, release);
    } catch (err) {
      req.log.error(err);
      emit({ type: "error", code: "model_failed", message: "Something broke on our side. Try again." });
    } finally {
      release();
      raw.end();
    }
  });

  app.get("/v1/chat/history", async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }).parse(req.query);
    const { workspaceId, userId } = req.auth!;
    return { messages: await history(deps.db, deps.vault, workspaceId, userId, limit) };
  });

  app.get("/v1/tools", async () => ({
    tools: deps.tools.list().map((t) => ({ name: t.name, description: t.description, kind: t.kind })),
  }));
};
