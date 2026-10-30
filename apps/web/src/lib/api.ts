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

export type Me = { user: { id: string; email: string; name: string; timezone: string; briefingEnabled: boolean; briefingTime: string; wrapupEnabled: boolean; wrapupTime: string; voice: string; quietStart: number; quietEnd: number; units: string; learnEnabled: boolean }; workspaceId: string; role: string; isOwner: boolean };
export type Settings = { dailyCapUsd: number; killSwitch: boolean; spentTodayUsd: number; model: string; demo: boolean; priceInputPerMtokUsd: number; priceOutputPerMtokUsd: number };
export type Approval = { id: string; kind: string; title: string; payload: Record<string, unknown>; status: string; createdAt: string; decidedAt: string | null; executed: boolean; canExecute: boolean; execution: "running" | "done" | "failed" | "unknown" | null; executionNote: string | null };
export type Connection = { id: string; provider: string; label: string; status: string; createdAt: string; calendar?: boolean };
export type MemoryKind = "fact" | "preference" | "person" | "plan" | "place";
export type MemoryItem = { id: string; content: string; kind: MemoryKind; subject: string | null; pinned: boolean; expiresOn: string | null; expired: boolean; createdAt: string; updatedAt: string };
export type TidiedItem = MemoryItem & { archived: boolean; reason: string | null; previous: string | null };
export type HistoryMsg = { role: "user" | "assistant"; text: string; at: string };
export type Goal = { id: string; title: string; notes: string | null; watchQuery: string | null; checkEveryHours: number | null; status: string; lastCheckedAt: string | null; lastFinding: string | null };
export type ConnectorField = { key: string; label: string; secret: boolean; placeholder?: string };
export type Connector = {
  id: string; kind: "oauth" | "token"; name: string; blurb: string;
  state: "needs_setup" | "ready" | "connected" | "reconnect";
  connectionId: string | null; label: string | null;
  calendar?: boolean; canSetUp?: boolean; setUpBy?: "env" | "app" | "none";
  fields?: ConnectorField[]; steps?: string[]; helpUrl?: string;
};
export type GoogleSetup = { configured: boolean; source: "env" | "app" | "none"; redirectUri: string; scopes: string[] };
export type Interest = { id: string; topic: string };
export type StyleNote = { id: string; kind: "said" | "observed"; note: string };
export type Style = { instruction: string | null; location: string | null; notes: StyleNote[] };
export type Task = { id: string; title: string; status: string; dueAt: string | null; remindAt: string | null; createdAt: string };
