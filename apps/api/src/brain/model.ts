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
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
};

/** The one seam to the model provider. Tests script it; production uses AnthropicModel. */
export interface ModelClient {
  complete(req: ModelRequest, onText: (delta: string) => void): Promise<ModelResult>;
}

export class AnthropicModel implements ModelClient {
  private client: Anthropic;
  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
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
      tools: tools as Anthropic.Tool[],
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

/** Used when no API key is set, so the rest of the app can still be tried. Costs nothing. */
export class DemoModel implements ModelClient {
  async complete(_req: ModelRequest, onText: (delta: string) => void): Promise<ModelResult> {
    const text = "Demo mode. No Anthropic key is set on this server, so I can't think yet. Memory, approvals and the spend cap all work.";
    onText(text);
    return { content: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
