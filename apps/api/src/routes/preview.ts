import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { previewUrl } from "../lib/preview.js";

export const previewRoutes: FastifyPluginAsync<Deps> = async (app, { previewFetch }) => {
  // Only for signed-in people (every route here is), and rate limited, since it makes the server fetch a page.
  app.get("/v1/preview", { config: { rateLimit: { max: 40, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { url } = z.object({ url: z.string().max(500) }).parse(req.query);
    const p = await previewUrl(url, previewFetch);
    return p ? { preview: p } : reply.code(404).send({ error: "no_preview" });
  });
};
