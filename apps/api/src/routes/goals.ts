import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { runAgent } from "../brain/agent.js";
import { withTenant } from "../db/client.js";
import { GOAL_STATUS, STEP_STATUS, addSteps, createGoal, listGoals, updateGoal, updateStep } from "../lib/goals.js";

const date = z.coerce.date();
const step = z.object({ text: z.string().trim().min(1).max(300), due: date.nullish() });

export const goalRoutes: FastifyPluginAsync<Deps> = async (app, deps) => {
  const { db, vault } = deps;
  const busy = new Set<string>();

  app.get("/v1/goals", async (req) => {
    const { workspaceId } = req.auth!;
    const { closed } = z.object({ closed: z.enum(["true", "false"]).default("false") }).parse(req.query);
    return { items: await withTenant(db, workspaceId, (tx) => listGoals(tx, vault, workspaceId, { closed: closed === "true" })) };
  });

  app.post("/v1/goals", async (req, reply) => {
    const { workspaceId, userId } = req.auth!;
    const b = z
      .object({ title: z.string().trim().min(1).max(200), notes: z.string().trim().max(2000).optional(), due: date.nullish(), steps: z.array(step).max(15).optional() })
      .parse(req.body);
    const id = await withTenant(db, workspaceId, (tx) =>
      createGoal(tx, vault, { workspaceId, userId }, { title: b.title, notes: b.notes, dueAt: b.due, steps: b.steps?.map((s) => ({ text: s.text, dueAt: s.due })), createdBy: "user" }),
    );
    const [item] = (await withTenant(db, workspaceId, (tx) => listGoals(tx, vault, workspaceId, { closed: true }))).filter((g) => g.id === id);
    return reply.code(201).send({ item });
  });

  app.patch("/v1/goals/:id", async (req, reply) => {
    const { workspaceId, userId } = req.auth!;
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z
      .object({ title: z.string().trim().min(1).max(200).optional(), notes: z.string().trim().max(2000).optional(), status: z.enum(GOAL_STATUS).optional(), due: date.nullable().optional() })
      .parse(req.body);
    const ok = await withTenant(db, workspaceId, (tx) => updateGoal(tx, vault, { workspaceId, userId }, id, { title: b.title, notes: b.notes, status: b.status, dueAt: b.due }, "user"));
    return ok ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });

  app.post("/v1/goals/:id/steps", async (req, reply) => {
    const { workspaceId, userId } = req.auth!;
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const { steps } = z.object({ steps: z.array(step).min(1).max(10) }).parse(req.body);
    const ok = await withTenant(db, workspaceId, (tx) => addSteps(tx, vault, { workspaceId, userId }, id, steps.map((s) => ({ text: s.text, dueAt: s.due }))));
    return ok ? reply.code(201).send({ ok: true }) : reply.code(404).send({ error: "not_found" });
  });

  app.patch("/v1/goals/:id/steps/:stepId", async (req, reply) => {
    const { workspaceId, userId } = req.auth!;
    const { id, stepId } = z.object({ id: z.uuid(), stepId: z.uuid() }).parse(req.params);
    const b = z.object({ status: z.enum(STEP_STATUS).optional(), text: z.string().trim().min(1).max(300).optional(), due: date.nullable().optional() }).parse(req.body);
    const row = await withTenant(db, workspaceId, (tx) => updateStep(tx, vault, { workspaceId, userId }, stepId, { status: b.status, text: b.text, dueAt: b.due }, id));
    return row ? { ok: true } : reply.code(404).send({ error: "not_found" });
  });

  // "Look at everything now." Counts against the same daily run limit and spend cap as his own wake-ups.
  app.post("/v1/agent/run", { config: { rateLimit: { max: 6, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { workspaceId, userId } = req.auth!;
    if (busy.has(workspaceId)) return reply.code(429).send({ error: "busy" });
    busy.add(workspaceId);
    try {
      return await runAgent(deps, { workspaceId, userId }, "manual");
    } finally {
      busy.delete(workspaceId);
    }
  });
};
