import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "../db/schema.js";
import { readStyle } from "../lib/style.js";
import { weatherToday } from "../lib/weather.js";
import { defineTool } from "./registry.js";

export const getWeather = defineTool({
  name: "get_weather",
  description:
    "Today's weather: conditions, high, low and chance of rain. Free and instant, so use it for questions like 'do I need a coat' or 'will it rain'. " +
    "Leave `place` empty to use where the user is. Pass a place only if they ask about somewhere else. It covers today only; for a trip or a forecast further out, use search_web.",
  kind: "read",
  input: z.object({ place: z.string().trim().max(80).optional() }),
  run: async (ctx, { place }) => {
    const [u] = await ctx.db.select({ units: users.units }).from(users).where(eq(users.id, ctx.userId));
    const where = place || (await ctx.tenant((tx) => readStyle(tx, ctx.vault, ctx.workspaceId, ctx.userId))).location;
    if (!where) return "I don't know where they are. Ask them, or tell them to set it in Settings under About you.";
    const w = await weatherToday(where, u?.units === "imperial" ? "imperial" : "metric", ctx.fetchFn);
    if (!w) return `Couldn't get the weather for ${where}. Try search_web, or check the spelling of the place.`;
    ctx.card?.({ kind: "weather", place: w.place, summary: w.summary, high: w.high, low: w.low, rain: w.rain });
    return w.line;
  },
});

export const weatherTools = [getWeather];
