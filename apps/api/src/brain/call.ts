import type { ModelClient, ModelRequest, ModelResult } from "./model.js";
import type { Tier } from "./router.js";

export type CallState = {
  /** Where the request currently stands. Moves to opus if Sonnet fails twice, and stays there for the rest of the request. */
  tier: Tier;
  canEscalate: boolean;
  failures: number;
  sonnetFailures: number;
  escalated: boolean;
};

export const newCallState = (tier: Tier, canEscalate: boolean): CallState => ({ tier, canEscalate, failures: 0, sonnetFailures: 0, escalated: false });

/**
 * One model call with the retry rules. A failed call is tried again once on the same model.
 * The one way up is Sonnet failing twice, which moves the request to Opus (unless the user is near a cap).
 * Throws when it has run out of tries. `state` carries across the calls of one request.
 */
export async function callWithEscalation(
  model: ModelClient,
  models: Record<Tier, string>,
  state: CallState,
  build: (tier: Tier, modelId: string) => ModelRequest,
  onText: (delta: string) => void,
  onRetry: () => void = () => {},
): Promise<ModelResult & { tier: Tier; model: string }> {
  // Sonnet gets two tries and then Opus one; every other tier gets two.
  for (let attempt = 0; ; attempt++) {
    const tier = state.tier;
    try {
      const res = await model.complete(build(tier, models[tier]), onText);
      return { ...res, tier, model: models[tier] };
    } catch (e) {
      state.failures++;
      if (tier === "sonnet") state.sonnetFailures++;
      const goUp = tier === "sonnet" && state.sonnetFailures >= 2 && state.canEscalate;
      if (goUp) {
        state.tier = "opus";
        state.escalated = true;
      }
      const maxAttempts = state.escalated ? 3 : 2;
      if (attempt + 1 >= maxAttempts) throw e;
      onRetry(); // anything that streamed from the failed attempt should be thrown away by the client
    }
  }
}
