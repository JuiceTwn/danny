/**
 * Anthropic's list prices in US dollars per million tokens, for prompts up to 100k tokens
 * (platform.claude.com/docs/en/about-claude/pricing). This is what a request REALLY costs; what a person is
 * charged is that rounded up to the next cent (lib/spend.ts). Check it when Anthropic changes prices or you add a model.
 */
export const LIST_PRICES: Record<string, { input: number; output: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

/** A model not in the book is priced as the dearest one in it, so an unknown model can only ever be over-counted, never given away. */
const UNKNOWN_MODEL = LIST_PRICES["claude-fable-5-1"]!;

/** A dated id such as claude-haiku-5-5-20260101 is the same model. The longest matching name wins. */
export function listPrice(model: string) {
  const name = Object.keys(LIST_PRICES)
    .filter((k) => model === k || model.startsWith(`${k}-`))
    .sort((a, b) => b.length - a.length)[0];
  return name ? LIST_PRICES[name]! : null;
}

export type PriceSource = "list" | "env" | "unknown-model";

/**
 * The prices to use. A value set in .env wins (so a negotiated price still works), but it is reported as "env"
 * so the owner can see that the server is not using the list price. With nothing set, the model's list price is
 * used, so changing MODEL changes the prices with it.
 */
export function resolvePrice(model: string, env: { input?: number; output?: number }) {
  const book = listPrice(model);
  const fallback = book ?? UNKNOWN_MODEL;
  const input = env.input ?? fallback.input;
  const output = env.output ?? fallback.output;
  const source: PriceSource = env.input !== undefined || env.output !== undefined ? "env" : book ? "list" : "unknown-model";
  const differs = book ? input !== book.input || output !== book.output : false;
  return { input, output, source, list: book, differsFromList: differs };
}
