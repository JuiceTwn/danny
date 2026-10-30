import { z } from "zod";
import { addInterest, InterestError, listInterests, removeInterest } from "../lib/interests.js";
import { defineTool } from "./registry.js";

export const addInterestTool = defineTool({
  name: "add_interest",
  description:
    "Add a topic the user wants news and updates on in their morning briefing, such as 'Premier League', 'AI policy' or 'houses in Leeds'. " +
    "Use it when they say they follow, care about or want to keep up with something. One short topic at a time.",
  kind: "internal",
  input: z.object({ topic: z.string().trim().min(2).max(80) }),
  run: async (ctx, { topic }) => {
    try {
      const i = await addInterest(ctx, topic);
      return `Added "${i.topic}" to what they follow.`;
    } catch (e) {
      if (e instanceof InterestError) return e.message;
      throw e;
    }
  },
});

export const listInterestsTool = defineTool({
  name: "list_interests",
  description: "List the topics the user follows for their briefing, with ids. Use it before removing one.",
  kind: "read",
  input: z.object({}),
  run: async (ctx) => {
    const all = await listInterests(ctx);
    return all.length ? all.map((i) => `${i.id} | ${i.topic}`).join("\n") : "They follow nothing yet.";
  },
});

export const removeInterestTool = defineTool({
  name: "remove_interest",
  description: "Stop following a topic. Take the id from list_interests.",
  kind: "internal",
  input: z.object({ id: z.uuid() }),
  run: async (ctx, { id }) => ((await removeInterest(ctx, id)) ? "Removed." : "No topic with that id."),
});

export const interestTools = [addInterestTool, listInterestsTool, removeInterestTool];
