import type { FastifyPluginAsync } from "fastify";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { BLOCKED_MESSAGE } from "../brain/run.js";
import { checkBudget, recordSpend } from "../lib/spend.js";

// Two minutes of speech at most. A typical phone recording is well under 24 KB a second, so the size cap enforces the time cap.
const MAX_SECONDS = 120;
const BYTES_PER_SECOND = 24_000;
const MAX_BYTES = MAX_SECONDS * BYTES_PER_SECOND;

export const transcribeRoutes: FastifyPluginAsync<Deps> = async (app, { db, config, transcriber }) => {
  // The browser sends the recording as the raw request body.
  app.addContentTypeParser(/^audio\/.+/, { parseAs: "buffer", bodyLimit: MAX_BYTES }, (_req, body, done) => done(null, body));

  // One recording at a time per workspace, so parallel requests can't run past the spend cap.
  const busy = new Set<string>();

  app.post("/v1/transcribe", { bodyLimit: MAX_BYTES, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req, reply) => {
    if (!transcriber || !config.voice) return reply.code(503).send({ error: "voice_unavailable", message: "Voice typing isn't turned on." });
    const { workspaceId, userId } = req.auth!;
    const audio = req.body;
    if (!Buffer.isBuffer(audio) || audio.length < 500) return reply.code(400).send({ error: "no_audio", message: "That recording was empty." });
    if (busy.has(workspaceId)) return reply.code(429).send({ error: "busy", message: "Still working on your last recording." });

    // Billed on the longer of what the app says and what the size implies, so under-reporting the length saves nothing.
    const claimed = Number(req.headers["x-audio-seconds"]);
    const seconds = Math.min(MAX_SECONDS, Math.max(1, Number.isFinite(claimed) ? claimed : 0, audio.length / BYTES_PER_SECOND));

    busy.add(workspaceId);
    try {
      const budget = await withTenant(db, workspaceId, (tx) => checkBudget(tx, workspaceId));
      if (!budget.ok) return reply.code(429).send({ error: budget.reason, message: BLOCKED_MESSAGE[budget.reason] });

      let text: string;
      try {
        text = await transcriber.transcribe(audio, String(req.headers["content-type"] ?? "audio/webm").split(";")[0]!);
      } catch (err) {
        req.log.warn({ err }, "transcription failed");
        return reply.code(502).send({ error: "transcribe_failed", message: "Couldn't hear that. Try again." });
      }
      const costMicros = Math.ceil((seconds / 3600) * config.voice.pricePerHourUsd * 1_000_000);
      await withTenant(db, workspaceId, (tx) =>
        recordSpend(tx, { workspaceId, userId, model: `stt:${config.voice!.model}`, inputTokens: 0, outputTokens: 0, costMicros }),
      );
      return { text };
    } finally {
      busy.delete(workspaceId);
    }
  });
};
