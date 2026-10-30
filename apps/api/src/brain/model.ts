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
  /** How hard the model thinks. Thinking tokens bill as output, so chat runs low and planning runs medium. */
  effort?: "low" | "medium" | "high";
};
export type ModelResult = {
  content: (TextBlock | ToolUseBlock)[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
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
    const stream = this.client.messages.stream({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: req.messages as Anthropic.MessageParam[],
      tools: req.tools as Anthropic.Tool[],
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
    } as Anthropic.MessageStreamParams);
    stream.on("text", onText);
    const final = await stream.finalMessage();
    return {
      content: final.content.filter((b): b is Anthropic.TextBlock | Anthropic.ToolUseBlock => b.type === "text" || b.type === "tool_use") as ModelResult["content"],
      stopReason: final.stop_reason,
      usage: { inputTokens: final.usage.input_tokens, outputTokens: final.usage.output_tokens },
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
