import { reportFailure } from "../lib/model-error.js";
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
      // The owner's own slash commands (/status, /errors, /backup...) run here on the server and never reach the model. Anyone else's "/status" is just a message.
      if (req.auth!.isOwner && looksLikeCommand(message)) {
        await ownerCommand(deps, { workspaceId, userId }, message, emit);
        return;
      }
      await runTurn(deps, { workspaceId, userId }, message, emit, () => closed, release);
    } catch (err) {
      const f = reportFailure("chat turn", err);
      emit({ type: "error", code: "model_failed", message: `Something broke on our side. ${f.hint}` });
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

/** Run an owner command: answer in the chat, save both sides, and for server actions post the result here when the server finishes. */
async function ownerCommand(deps: Deps, who: { workspaceId: string; userId: string }, message: string, emit: (e: ChatEvent) => void) {
  const [u] = await deps.db.select({ tz: users.timezone }).from(users).where(eq(users.id, who.userId));
  const tz = u?.tz ?? "UTC";
  const ctx = { db: deps.db, config: deps.config, vault: deps.vault, keys: deps.keys, health: deps.health, appUrl: deps.config.appUrl, ...who, timezone: tz };
  const r = await runOwnerCommand(ctx, message);
  await saveExchange(deps.db, deps.vault, who.workspaceId, who.userId, message, r.text);
  emit({ type: "text", text: r.text });
  emit({ type: "done" });
  if (r.watch) {
    const { action, since } = r.watch;
    // Detached: the reply above is already sent. The result lands in the chat when the server finishes, even if the app was closed meanwhile.
    void awaitOps(new Ops(deps.config.opsDir), action, since, tz)
      .then((text) => deliver({ db: deps.db, vault: deps.vault, push: deps.push } as unknown as BackgroundDeps, who, text, { title: `Danny: ${action}`, body: text.split("\n")[0] ?? "" }, false))
      .catch((err) => reportFailure(`owner command ${action}`, err));
  }
}
