import type { Block, Msg, ToolResultBlock, ToolUseBlock } from "./model.js";

const isResults = (m: Msg) => m.role === "user" && Array.isArray(m.content) && m.content.length > 0 && m.content.every((b) => b.type === "tool_result");

/**
 * Make a saved conversation safe to send to the model. The model's rules are strict: the message right after a tool call must hold a result for
 * EVERY call in it, and a result may only follow its call. A call and its results are saved together, but messages are read back by id, and a
 * message Danny writes on his own at the same moment (a brief, a game alert, a reminder) can take an id in between. One such message used to make
 * every later chat fail with a 400 ("tool_use ids were found without tool_result blocks"), for good.
 *
 * This puts each call's results straight after it, writes a plain "no result" for any that were never saved, and drops results that belong to
 * a call that is not here. History that is already fine comes back unchanged. Nothing is deleted from storage.
 */
export function repairHistory(rows: Msg[]): Msg[] {
  const results = new Map<string, ToolResultBlock>();
  for (const m of rows) if (isResults(m)) for (const b of m.content as Block[]) if (b.type === "tool_result") results.set(b.tool_use_id, b);

  const out: Msg[] = [];
  for (const m of rows) {
    if (isResults(m)) continue; // placed after its own call, below
    out.push(m);
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const calls = m.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    if (!calls.length) continue;
    out.push({
      role: "user",
      content: calls.map((c) => results.get(c.id) ?? ({ type: "tool_result", tool_use_id: c.id, content: "(That step did not finish, so there is no result.)", is_error: true } satisfies ToolResultBlock)),
    });
  }
  return out;
}
