export class ApiError extends Error {
  constructor(public status: number, public code: string, message?: string) {
    super(message ?? code);
  }
}

let onUnauthorized: () => void = () => {};
export const setOnUnauthorized = (f: () => void) => (onUnauthorized = f);

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/v1/auth/")) onUnauthorized();
    throw new ApiError(res.status, data?.error ?? "error", data?.message);
  }
  return data as T;
}

export type ChatEvent =
  | { type: "text"; text: string }
  | { type: "tool"; name: string; status: "ran" | "queued" | "error" }
  | { type: "approval"; id: string; title: string }
  | { type: "done" }
  | { type: "error"; code: string; message: string };

/** POST a message and yield server-sent events as they arrive. */
export async function* chatStream(message: string, signal: AbortSignal): AsyncGenerator<ChatEvent> {
  const res = await fetch("/v1/chat", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
    signal,
  });
  if (res.status === 401) onUnauthorized();
  if (!res.ok || !res.body) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error ?? "error", data.message);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (chunk.startsWith("data: ")) yield JSON.parse(chunk.slice(6)) as ChatEvent;
    }
  }
}

export type Me = { user: { id: string; email: string; name: string; timezone: string }; workspaceId: string; role: string; isOwner: boolean };
export type Settings = { dailyCapUsd: number; killSwitch: boolean; spentTodayUsd: number; model: string; demo: boolean; priceInputPerMtokUsd: number; priceOutputPerMtokUsd: number };
export type Approval = { id: string; kind: string; title: string; payload: Record<string, unknown>; status: string; createdAt: string; decidedAt: string | null; executed: boolean; canExecute: boolean; execution: "running" | "done" | "failed" | "unknown" | null; executionNote: string | null };
export type Connection = { id: string; provider: string; label: string; status: string; createdAt: string };
export type MemoryItem = { id: string; content: string; createdAt: string };
export type HistoryMsg = { role: "user" | "assistant"; text: string; at: string };
export type Task = { id: string; title: string; status: string; dueAt: string | null; remindAt: string | null; createdAt: string };
