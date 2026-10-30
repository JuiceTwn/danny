import { createHash } from "node:crypto";

// Least privilege: read mail, and send mail. No modify, no delete, no compose. Danny cannot remove anything from the mailbox.
export const GMAIL_READ = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
// Calendar is optional: Danny still works with Gmail alone if the user unticks it. It reads and creates events; it never deletes or edits one.
export const CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";
export const SCOPES = [GMAIL_READ, GMAIL_SEND, CALENDAR_EVENTS];

/**
 * reconnect  the saved login no longer works; the user must connect again
 * failed     the request definitely did not happen, so retrying is safe
 * unknown    it may have happened (timeout, server error); do not retry blindly
 */
export type GmailErrorKind = "reconnect" | "failed" | "unknown";
export class GmailError extends Error {
  constructor(message: string, readonly kind: GmailErrorKind) {
    super(message);
  }
}

export type GoogleConfig = { clientId: string; clientSecret: string; redirectUri: string };
export type GoogleTokens = { accessToken: string; refreshToken: string | null; expiresIn: number; scope: string };

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const CALENDAR_API = "https://www.googleapis.com/calendar/v3";
const TIMEOUT_MS = 15_000;

export const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Google sign-in and the Gmail REST API. Only fixed sentences leave this class as error text, never Google's own. */
export class GoogleService {
  // Access tokens live an hour and are never stored: only the refresh token is, encrypted. Cached here per connection.
  private cache = new Map<string, { token: string; exp: number }>();

  private cfg: GoogleConfig | null;
  /** Where the client ID and secret came from: the server's environment, the owner typing them into the app, or nowhere yet. */
  source: "env" | "app" | "none";

  constructor(cfg: GoogleConfig | null, private fetchFn: typeof fetch = fetch) {
    this.cfg = cfg;
    this.source = cfg ? "env" : "none";
  }

  get configured() {
    return this.cfg !== null;
  }

  /** Set or clear the client credentials while the server runs. Forgets cached access tokens, which belonged to the old client. */
  configure(cfg: GoogleConfig | null, source: "env" | "app" | "none") {
    this.cfg = cfg;
    this.source = cfg ? source : "none";
    this.cache.clear();
  }

  private need() {
    if (!this.cfg) throw new GmailError("Google isn't set up on this server yet.", "failed");
    return this.cfg;
  }

  /**
   * Asks Google to exchange a code that cannot be valid. Google answers invalid_client if the ID or secret is wrong and
   * invalid_grant if they are right (and only the code is wrong). That tells the owner straight away whether they pasted it correctly.
   */
  async checkCredentials(cfg: GoogleConfig): Promise<"ok" | "bad" | "unreachable"> {
    try {
      const res = await this.request(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: "authorization_code", code: "danny-check", code_verifier: "danny-check-danny-check-danny-check-danny-check", redirect_uri: cfg.redirectUri }) }, "failed");
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (data.error === "invalid_client" || data.error === "unauthorized_client") return "bad";
      return data.error ? "ok" : "bad";
    } catch {
      return "unreachable";
    }
  }

  authUrl(state: string, challenge: string) {
    const cfg = this.need();
    const q = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline", // gives a refresh token
      prompt: "consent", // and makes Google give one every time
      include_granted_scopes: "false",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return `${AUTH_URL}?${q}`;
  }

  private async request(url: string, init: RequestInit, onNetworkError: GmailErrorKind) {
    try {
      return await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      throw new GmailError("Couldn't reach Google.", onNetworkError);
    }
  }

  private async token(params: Record<string, string>) {
    const cfg = this.need();
    const res = await this.request(TOKEN_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }) }, "failed");
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      if (data.error === "invalid_grant") throw new GmailError("The saved Gmail login no longer works. Reconnect Gmail in Settings.", "reconnect");
      throw new GmailError("Couldn't sign in to Gmail. Try again.", "failed");
    }
    return {
      accessToken: String(data.access_token),
      refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
      expiresIn: Number(data.expires_in ?? 3600),
      scope: String(data.scope ?? ""),
    } satisfies GoogleTokens;
  }

  exchangeCode(code: string, verifier: string) {
    return this.token({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: this.need().redirectUri });
  }

  /** Best effort: if Google is unreachable the token is simply dropped on our side. */
  async revoke(refreshToken: string) {
    await this.request(REVOKE_URL, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: refreshToken }) }, "failed").catch(() => {});
  }

  private async accessToken(conn: { id: string; refreshToken: string }, force: boolean) {
    const hit = this.cache.get(conn.id);
    if (!force && hit && hit.exp > Date.now() + 60_000) return hit.token;
    const t = await this.token({ grant_type: "refresh_token", refresh_token: conn.refreshToken });
    this.cache.set(conn.id, { token: t.accessToken, exp: Date.now() + t.expiresIn * 1000 });
    return t.accessToken;
  }

  forget(connId: string) {
    this.cache.delete(connId);
  }

  /** The signed-in address, used to label the connection. */
  async profileEmail(accessToken: string) {
    const res = await this.request(`${API}/profile`, { headers: { authorization: `Bearer ${accessToken}` } }, "failed");
    const data = (await res.json().catch(() => ({}))) as { emailAddress?: string };
    if (!res.ok || !data.emailAddress) throw new GmailError("Couldn't read the Gmail address.", "failed");
    return data.emailAddress;
  }

  async call<T>(conn: { id: string; refreshToken: string }, path: string, init: { method?: string; json?: unknown; api?: "gmail" | "calendar" } = {}): Promise<T> {
    const calendar = init.api === "calendar";
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(conn, attempt > 0);
      const res = await this.request(
        `${calendar ? CALENDAR_API : API}${path}`,
        {
          method: init.method ?? "GET",
          headers: { authorization: `Bearer ${token}`, ...(init.json !== undefined ? { "content-type": "application/json" } : {}) },
          body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
        },
        "unknown", // a sent request that got no answer may still have been acted on
      );
      if (res.status === 401 && attempt === 0) {
        this.cache.delete(conn.id);
        continue; // the token may have just expired: refresh once and retry
      }
      return this.parse<T>(res, calendar ? "Calendar" : "Gmail");
    }
    throw new GmailError(`${calendar ? "Calendar" : "Gmail"} rejected the saved login. Reconnect Google in Settings.`, "reconnect");
  }

  private async parse<T>(res: Response, product: "Gmail" | "Calendar" = "Gmail"): Promise<T> {
    if (res.ok) return (await res.json()) as T;
    const body = (await res.json().catch(() => ({}))) as { error?: { errors?: { reason?: string }[]; status?: string } };
    const reason = `${body.error?.errors?.[0]?.reason ?? ""} ${body.error?.status ?? ""}`;
    if (res.status === 401) throw new GmailError(`${product} rejected the saved login. Reconnect Google in Settings.`, "reconnect");
    if (res.status === 429 || (res.status === 403 && /rate|quota/i.test(reason))) throw new GmailError(`${product} is rate limiting. Try again in a minute.`, "failed");
    if (res.status === 403) throw new GmailError(`${product} refused that. Reconnect Google and allow every permission.`, "failed");
    if (res.status === 404) throw new GmailError(`${product} couldn't find that.`, "failed");
    if (res.status >= 500) throw new GmailError(`${product} had an error on its side.`, "unknown");
    return Promise.reject(new GmailError(`${product} rejected that request.`, "failed"));
  }
}
