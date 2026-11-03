/**
 * Why a model call failed, in words a person can act on, and a log line that says so. Before this, every failure was caught and thrown away:
 * the app said "the model call failed" and the server log said nothing, so there was nothing to go on. Only a category and a short hint reach the
 * chat; the raw message goes to the log only, with anything that looks like a key removed.
 */
export type FailureKind = "auth" | "model" | "rate" | "overloaded" | "bad_request" | "network" | "timeout" | "unknown";
export type Failure = { kind: FailureKind; status: number | null; hint: string; detail: string };

const HINTS: Record<FailureKind, string> = {
  auth: "The model rejected the server's API key. The owner can check it in Owner, API keys.",
  model: "The model name isn't available to this key. The owner can check MODEL in .env.",
  rate: "The model is rate limiting right now. Try again in a minute.",
  overloaded: "The model service is overloaded right now. Try again in a minute.",
  bad_request: "The model refused the request. The server log has the details.",
  network: "The server couldn't reach the model service. The server log has the details.",
  timeout: "The model took too long to answer. Try again.",
  unknown: "The server log has the details.",
};

const scrub = (s: string) => s.replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-…").replace(/\s+/g, " ").slice(0, 400);

export function classifyModelError(err: unknown): Failure {
  const e = err as { status?: unknown; name?: unknown; message?: unknown; code?: unknown; error?: { error?: { type?: unknown; message?: unknown } } } | null;
  const status = typeof e?.status === "number" ? e.status : null;
  const type = String(e?.error?.error?.type ?? "");
  const name = String(e?.name ?? "");
  const message = String(e?.error?.error?.message ?? e?.message ?? err ?? "");
  const code = String(e?.code ?? "");
  let kind: FailureKind = "unknown";
  if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error") kind = "auth";
  else if (status === 404 || type === "not_found_error") kind = "model";
  else if (status === 429 || type === "rate_limit_error") kind = "rate";
  else if (status === 529 || type === "overloaded_error" || (status !== null && status >= 500)) kind = "overloaded";
  else if (status !== null && status >= 400) kind = "bad_request";
  else if (/timeout|timed out/i.test(name + message) || code === "ETIMEDOUT") kind = "timeout";
  else if (/connection|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network/i.test(name + message + code)) kind = "network";
  return { kind, status, hint: HINTS[kind], detail: scrub(`${name ? `${name}: ` : ""}${message}`) };
}

type Sink = (obj: Record<string, unknown>, msg: string) => void;
let sink: Sink | null = null;
/** The app gives this its logger at start-up. Until then (and in scripts) failures go to stderr. */
export const setErrorSink = (fn: Sink | null) => {
  sink = fn;
};

/** Log a failure with its cause and return the classified version, so the caller can say something useful. */
export function reportFailure(where: string, err: unknown, extra: Record<string, unknown> = {}): Failure {
  const f = classifyModelError(err);
  const line = { where, kind: f.kind, status: f.status, detail: f.detail, ...extra };
  const msg = `${where} failed: ${f.kind}${f.status ? ` (${f.status})` : ""}: ${f.detail.slice(0, 160)}`;
  if (sink) sink(line, msg);
  else console.error(msg, JSON.stringify(line));
  return f;
}
