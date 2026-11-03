import { eq } from "drizzle-orm";
import { z } from "zod";
import { auditLog, users } from "../db/schema.js";
import { setSingle } from "../lib/style.js";
import { defineTool } from "./registry.js";

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24 hour");
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));

const input = z.object({
  setting: z.enum(["briefing", "briefing_time", "wrapup", "wrapup_time", "event_heads_ups", "good_news", "news_items", "location", "tips"]),
  on: z.boolean().optional(),
  time: clock.optional(),
  count: z.number().int().min(0).max(5).optional(),
  place: z.string().trim().min(2).max(80).optional(),
});

export const changeSettingTool = defineTool({
  name: "change_setting",
  description:
    "Change one of the user's own settings when they ask, so they never have to open Settings. " +
    "briefing / wrapup / event_heads_ups / good_news / tips: pass on true or false. (briefing = the morning brief; wrapup = the evening wrap-up; event_heads_ups = a heads-up before calendar events; good_news = one uplifting story in the brief; tips = Danny's occasional 'btw I can also do this' suggestions: turn them off if they say stop the tips.) " +
    "briefing_time / wrapup_time: pass time as 24-hour HH:MM in their own clock. news_items: pass count 0 to 5, how many news stories the brief carries (0 means no news). " +
    "location: pass place, a city, for the weather in the brief. For teams and topics use follow_team and add_interest instead.",
  kind: "internal",
  input,
  run: async (ctx, i) => {
    const need = (v: unknown, what: string) => {
      if (v === undefined) throw new Error(`${i.setting} needs ${what}`);
      return v;
    };
    try {
      if (i.setting === "location") {
        await setSingle(ctx, "location", String(need(i.place, "place")));
        return `Got it, the brief will have the weather for ${i.place}.`;
      }
      const set: Partial<typeof users.$inferInsert> = {};
      let said = "";
      switch (i.setting) {
        case "briefing": set.briefingEnabled = Boolean(need(i.on, "on")); said = i.on ? "Morning brief is on." : "Morning brief is off."; break;
        case "briefing_time": set.briefingMinute = minutes(String(need(i.time, "time"))); said = `Morning brief at ${i.time}.`; break;
        case "wrapup": set.wrapupEnabled = Boolean(need(i.on, "on")); said = i.on ? "Evening wrap-up is on, at 20:00 unless you want another time." : "Evening wrap-up is off."; break;
        case "wrapup_time": set.wrapupMinute = minutes(String(need(i.time, "time"))); set.wrapupEnabled = true; said = `Evening wrap-up at ${i.time}.`; break;
        case "event_heads_ups": set.eventPrep = Boolean(need(i.on, "on")); said = i.on ? "Event heads-ups are on (they need Google Calendar connected)." : "Event heads-ups are off."; break;
        case "good_news": set.goodNews = Boolean(need(i.on, "on")); said = i.on ? "Added one good news story to the brief." : "No more good news story in the brief."; break;
        case "news_items": set.newsItems = Number(need(i.count, "count")); said = i.count ? `The brief carries up to ${i.count} news stories.` : "No news in the brief."; break;
        case "tips": set.tips = Boolean(need(i.on, "on")); said = i.on ? "I'll mention things I can do now and then." : "No more suggestions from me."; break;
      }
      await ctx.db.update(users).set(set).where(eq(users.id, ctx.userId));
      await ctx.tenant((tx) => tx.insert(auditLog).values({ workspaceId: ctx.workspaceId, userId: ctx.userId, action: "profile.preferences", detail: { via: "chat", setting: i.setting } }));
      return said;
    } catch (e) {
      return e instanceof Error ? e.message : "I couldn't change that.";
    }
  },
});

export const settingsTools = [changeSettingTool];
