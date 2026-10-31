import type { FastifyPluginAsync } from "fastify";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { BLOCKED_MESSAGE } from "../brain/run.js";
import { ElevenLabsRealtimeStt, ElevenLabsSpeech } from "../lib/call/elevenlabs.js";
import type { CallProviders } from "../lib/call/providers.js";
import { CallSession } from "../lib/call/session.js";
import { checkBudget } from "../lib/spend.js";

export const callRoutes: FastifyPluginAsync<Deps> = async (app, deps) => {
  const { config, db, keys, fetchFn } = deps;
  const inCall = new Set<string>();

  // Uses whatever ElevenLabs key is set right now, so a key typed into the app works at once.
  let cached: { key: string; p: CallProviders } | null = null;
  const providers = (): CallProviders | null => {
    if (deps.call) return deps.call;
    const key = keys!.get("elevenlabs");
    if (!key) return null;
    if (cached?.key !== key) cached = { key, p: { stt: new ElevenLabsRealtimeStt(key), speech: new ElevenLabsSpeech(key, config.call.voiceId, config.call.ttsModel, fetchFn) } };
    return cached.p;
  };

  app.get(
    "/v1/call",
    {
      websocket: true,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      // These run before the connection is accepted, so a refused call never opens.
      // A web page on another site must not be able to open a call with the user's cookie.
      onRequest: async (req, reply) => {
        const origin = req.headers.origin;
        if (!origin || !config.appOrigins.has(origin)) return reply.code(403).send({ error: "bad_origin" });
      },
      preHandler: async (req, reply) => {
        if (!providers()) return reply.code(503).send({ error: "call_unavailable", message: "Calling isn't turned on." });
        const { workspaceId } = req.auth!;
        if (inCall.has(workspaceId)) return reply.code(409).send({ error: "already_in_call", message: "You're already on a call." });
        const b = await withTenant(db, workspaceId, (tx) => checkBudget(tx, workspaceId));
        if (!b.ok) return reply.code(429).send({ error: b.reason, message: BLOCKED_MESSAGE[b.reason] });
      },
    },
    async (socket, req) => {
      const { workspaceId, userId } = req.auth!;
      inCall.add(workspaceId);
      const session = new CallSession(deps, { workspaceId, userId }, socket, providers()!, deps.callOptions);
      socket.on("message", (data: Buffer, isBinary: boolean) => session.onFrame(data, isBinary));
      socket.on("close", () => {
        session.close();
        inCall.delete(workspaceId);
      });
      socket.on("error", () => socket.close());
      try {
        await session.start();
      } catch (err) {
        req.log.warn({ err }, "call failed to start");
        session.end("start_failed", "Couldn't start the call. Try again in a minute.");
      }
    },
  );
};
