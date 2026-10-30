import { pkceChallenge } from "../src/lib/google.js";

type Msg = { id: string; threadId: string; from: string; to?: string; subject: string; date?: string; messageId?: string; references?: string; plain?: string; html?: string; files?: string[] };
const b64 = (s: string) => Buffer.from(s).toString("base64url");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A stand-in for Google's sign-in and Gmail API, passed to GoogleService as its fetch. Records everything it is asked. */
export class FakeGoogle {
  email = "justin@example.com";
  grantedScopes = "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send";
  refreshToken = "refresh-1";
  messages = new Map<string, Msg>();
  events: Record<string, unknown>[] = [];
  calendarQueries: URLSearchParams[] = [];
  createdEvents: { sendUpdates: string | null; body: Record<string, any> }[] = [];
  // injected faults
  sendMode: "ok" | "400" | "500" | "network" = "ok";
  invalidGrant = false;
  /** When set, Google only accepts this client ID and secret and answers invalid_client for any other. */
  expectClient: { id: string; secret: string } | null = null;

  // what happened
  sent: { mime: string; threadId?: string }[] = [];
  revoked: string[] = [];
  queries: string[] = [];
  refreshes = 0;
  private challenge = "";
  private validAccess = new Set<string>();

  add(m: Msg) {
    this.messages.set(m.id, m);
  }
  /** Tell the fake which PKCE challenge the app sent users to Google with, so it can check the verifier at exchange. */
  expectChallenge(c: string) {
    this.challenge = c;
  }
  expireAccessTokens() {
    this.validAccess.clear();
  }

  private mint() {
    const t = `access-${++this.refreshes}`;
    this.validAccess.add(t);
    return t;
  }

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" || init?.body instanceof URLSearchParams ? String(init.body) : "";

    if (url.origin === "https://oauth2.googleapis.com") {
      const form = new URLSearchParams(body);
      if (this.expectClient && url.pathname === "/token" && (form.get("client_id") !== this.expectClient.id || form.get("client_secret") !== this.expectClient.secret)) return json(401, { error: "invalid_client" });
      if (url.pathname === "/revoke") {
        this.revoked.push(form.get("token")!);
        return json(200, {});
      }
      if (form.get("grant_type") === "authorization_code") {
        if (form.get("code") !== "code-1" || pkceChallenge(form.get("code_verifier") ?? "") !== this.challenge) return json(400, { error: "invalid_grant" });
        return json(200, { access_token: this.mint(), refresh_token: this.refreshToken, expires_in: 3600, scope: this.grantedScopes });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (this.invalidGrant || form.get("refresh_token") !== this.refreshToken) return json(400, { error: "invalid_grant" });
        return json(200, { access_token: this.mint(), expires_in: 3600, scope: this.grantedScopes });
      }
      return json(400, { error: "unsupported_grant_type" });
    }

    if (url.origin === "https://www.googleapis.com" && url.pathname === "/calendar/v3/calendars/primary/events") {
      const auth = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "");
      if (!auth || !this.validAccess.has(auth)) return json(401, { error: { status: "UNAUTHENTICATED" } });
      if (method === "GET") {
        this.calendarQueries.push(url.searchParams);
        return json(200, { items: this.events });
      }
      if (method === "POST") {
        this.createdEvents.push({ sendUpdates: url.searchParams.get("sendUpdates"), body: JSON.parse(body) });
        return json(200, { id: `ev-${this.createdEvents.length}` });
      }
    }

    if (url.origin === "https://gmail.googleapis.com") {
      const auth = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "");
      if (!auth || !this.validAccess.has(auth)) return json(401, { error: { status: "UNAUTHENTICATED" } });
      const path = url.pathname.replace("/gmail/v1/users/me", "");
      if (path === "/profile") return json(200, { emailAddress: this.email });
      if (path === "/messages" && method === "GET") {
        this.queries.push(url.searchParams.get("q") ?? "");
        const max = Number(url.searchParams.get("maxResults") ?? 10);
        return json(200, { messages: [...this.messages.values()].slice(0, max).map((m) => ({ id: m.id, threadId: m.threadId })) });
      }
      if (path === "/messages/send" && method === "POST") {
        if (this.sendMode === "network") throw new TypeError("fetch failed");
        if (this.sendMode === "500") return json(503, { error: { status: "UNAVAILABLE" } });
        if (this.sendMode === "400") return json(400, { error: { status: "INVALID_ARGUMENT", message: "Invalid To header: secret-provider-text" } });
        const sent = JSON.parse(body) as { raw: string; threadId?: string };
        this.sent.push({ mime: Buffer.from(sent.raw, "base64url").toString("utf8"), threadId: sent.threadId });
        return json(200, { id: `sent-${this.sent.length}` });
      }
      const one = path.match(/^\/messages\/([0-9a-f]+)$/);
      if (one && method === "GET") {
        const m = this.messages.get(one[1]!);
        if (!m) return json(404, { error: { status: "NOT_FOUND" } });
        const headers = [
          { name: "From", value: m.from },
          { name: "To", value: m.to ?? this.email },
          { name: "Subject", value: m.subject },
          { name: "Date", value: m.date ?? "Fri, 30 Oct 2026 09:00:00 -0400" },
          ...(m.messageId ? [{ name: "Message-ID", value: m.messageId }] : []),
          ...(m.references ? [{ name: "References", value: m.references }] : []),
        ];
        const snippet = (m.plain ?? m.html ?? "").slice(0, 60);
        if (url.searchParams.get("format") === "metadata") return json(200, { id: m.id, threadId: m.threadId, snippet, payload: { headers } });
        const parts = [
          ...(m.plain ? [{ mimeType: "text/plain", body: { data: b64(m.plain) } }] : []),
          ...(m.html ? [{ mimeType: "text/html", body: { data: b64(m.html) } }] : []),
          ...(m.files ?? []).map((f) => ({ mimeType: "application/pdf", filename: f, body: {} })),
        ];
        return json(200, { id: m.id, threadId: m.threadId, snippet, payload: { mimeType: "multipart/mixed", headers, parts } });
      }
    }
    return json(404, { error: "fake: unhandled " + method + " " + url });
  };
}
