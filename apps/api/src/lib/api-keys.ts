/**
 * Every API key Danny can use, in one list. The Owner tab draws one box per entry, so a new feature that needs a key
 * only has to add an entry here: after the next update the owner sees a new box, marked Needed or Optional.
 */
export type KeyDef = {
  id: string;
  label: string;
  /** required: Danny is limited without it. optional: one feature turns on with it. */
  needed: "required" | "optional";
  /** One plain sentence on what it does. */
  why: string;
  steps: string[];
  url: string;
  /** Asks the provider whether the key works. Free calls only, to fixed addresses. */
  check(key: string, f: typeof fetch): Promise<"ok" | "bad" | "unreachable">;
};

async function ping(f: typeof fetch, url: string, headers: Record<string, string>, bad: (status: number, body: string) => boolean) {
  try {
    const res = await f(url, { headers, signal: AbortSignal.timeout(8000) });
    if (res.ok) return "ok" as const;
    const body = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) return bad(res.status, body) ? ("bad" as const) : ("ok" as const);
    if (res.status === 429) return "ok" as const; // rate limited means the key was recognised
    return "unreachable" as const;
  } catch {
    return "unreachable" as const;
  }
}

export const KEY_DEFS: KeyDef[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    needed: "required",
    why: "Danny's brain. Without it he runs in demo mode and can't think.",
    steps: ["Open console.anthropic.com and sign in.", "Add a payment method under Billing.", "Go to API keys and create one.", "Copy it and paste it here."],
    url: "https://console.anthropic.com/settings/keys",
    check: (key, f) => ping(f, "https://api.anthropic.com/v1/models?limit=1", { "x-api-key": key, "anthropic-version": "2023-06-01" }, (status) => status === 401),
  },
  {
    id: "elevenlabs",
    label: "ElevenLabs",
    needed: "optional",
    why: "Danny's voice: voice typing (the mic button) and calls (the Call button).",
    steps: ["Open elevenlabs.io and sign in.", "Open your profile, then API keys.", "Create a key. Allow Speech to Text and Text to Speech.", "Copy it and paste it here."],
    url: "https://elevenlabs.io/app/settings/api-keys",
    // A key limited to speech to text gets "missing permissions" here, which still means the key is real.
    check: (key, f) => ping(f, "https://api.elevenlabs.io/v1/models", { "xi-api-key": key }, (_status, body) => !/permission/i.test(body)),
  },
];

/** Keys come from the server's .env or from the app. A key in .env always wins and can't be changed in the app. */
export class ApiKeys {
  private saved = new Map<string, string>();
  constructor(private readonly env: Record<string, string | undefined>) {}

  get(id: string): string | undefined {
    return this.env[id] || this.saved.get(id);
  }
  source(id: string): "env" | "app" | "none" {
    return this.env[id] ? "env" : this.saved.has(id) ? "app" : "none";
  }
  has(id: string) {
    return Boolean(this.get(id));
  }
  setSaved(id: string, value: string | null) {
    if (value) this.saved.set(id, value);
    else this.saved.delete(id);
  }
  loadSaved(all: Record<string, string>) {
    for (const [id, v] of Object.entries(all)) if (KEY_DEFS.some((d) => d.id === id)) this.saved.set(id, v);
  }
}
