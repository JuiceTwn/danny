import Anthropic from "@anthropic-ai/sdk";

export type TextBlock = { type: "text"; text: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
export type ToolResultBlock = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export type Block = TextBlock | ToolUseBlock | ToolResultBlock;
export type Msg = { role: "user" | "assistant"; content: string | Block[] };

export type ModelRequest = {
  model: string;
  system: string;
  messages: Msg[];
  tools: { name: string; description: string; input_schema: { type: "object"; [k: string]: unknown } }[];
  maxTokens: number;
};
export type ModelResult = {
  content: (TextBlock | ToolUseBlock)[];
  stopReason: string | null;
  /** inputTokens is only the uncached part. Cached reads and writes are billed at different rates. */
  usage: Usage;
};
export type Usage = { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; searches?: number };
export type SearchRequest = { model: string; system: string; prompt: string; maxSearches: number; maxTokens: number };
export type SearchResult = { text: string; sources: { title: string; url: string }[]; usage: Usage };

/** The one seam to the model provider. Tests script it; production uses AnthropicModel. */
export interface ModelClient {
  complete(req: ModelRequest, onText: (delta: string) => void): Promise<ModelResult>;
  /** One question answered from the live web. Absent on models that cannot search. */
  search?(req: SearchRequest): Promise<SearchResult>;
}

export class AnthropicModel implements ModelClient {
  private client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }
  async search(req: SearchRequest): Promise<SearchResult> {
    const res = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: req.prompt }],
      tools: [{ type: SEARCH_TOOL, name: "web_search", max_uses: req.maxSearches } as unknown as Anthropic.ToolUnion],
    });
    const seen = new Set<string>();
    const sources: SearchResult["sources"] = [];
    let text = "";
    for (const b of res.content as unknown as { type: string; text?: string; content?: unknown }[]) {
      if (b.type === "text") text += b.text ?? "";
      else if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const r of b.content as { url?: string; title?: string }[]) {
          if (r.url && !seen.has(r.url) && sources.length < 8) {
            seen.add(r.url);
            sources.push({ title: r.title ?? r.url, url: r.url });
          }
        }
      }
    }
    const u = res.usage as typeof res.usage & { server_tool_use?: { web_search_requests?: number } };
    return {
      text: text.trim(),
      sources,
      usage: {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
        searches: u.server_tool_use?.web_search_requests ?? 0,
      },
    };
  }

  async complete(req: ModelRequest, onText: (delta: string) => void): Promise<ModelResult> {
    // Prompt caching: tools and system are stable, so they are cached as a unit. A second breakpoint on the
    // last message lets each step of a turn, and the next turn, re-read the conversation so far at a tenth of the price.
    const mark = { type: "ephemeral" } as const;
    const tools = req.tools.map((t, i) => (i === req.tools.length - 1 ? { ...t, cache_control: mark } : t));
    const messages = req.messages.map((m, i): Anthropic.MessageParam => {
      if (i !== req.messages.length - 1) return m as Anthropic.MessageParam;
      const blocks = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : [...m.content];
      const last = blocks.length - 1;
      return { role: m.role, content: blocks.map((b, j) => (j === last ? { ...b, cache_control: mark } : b)) as Anthropic.ContentBlockParam[] };
    });
    const stream = this.client.messages.stream({
      model: req.model,
      max_tokens: req.maxTokens,
      system: [{ type: "text", text: req.system, cache_control: mark }],
      messages,
      ...(tools.length ? { tools: tools as Anthropic.Tool[] } : {}),
    });
    stream.on("text", onText);
    const final = await stream.finalMessage();
    return {
      content: final.content.filter((b): b is Anthropic.TextBlock | Anthropic.ToolUseBlock => b.type === "text" || b.type === "tool_use") as ModelResult["content"],
      stopReason: final.stop_reason,
      usage: {
        inputTokens: final.usage.input_tokens,
        outputTokens: final.usage.output_tokens,
        cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

const SEARCH_TOOL = "web_search_20250305";

/** Used when no API key is set, so the rest of the app can still be tried. Costs nothing. */
export class DemoModel implements ModelClient {
  async complete(_req: ModelRequest, onText: (delta: string) => void): Promise<ModelResult> {
    const text = "Demo mode. No Anthropic key is set on this server, so I can't think yet. Memory, approvals and the spend cap all work.";
    onText(text);
    return { content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
