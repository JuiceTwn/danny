import { randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { withTenant } from "../db/client.js";
import { auditLog, connections } from "../db/schema.js";
import type { GoogleSecret } from "../lib/gmail.js";
import { CALENDAR_EVENTS, GMAIL_READ, GMAIL_SEND, GmailError, pkceChallenge } from "../lib/google.js";

const COOKIE = "danny_oauth";
const PATH = "/v1/connections/google";

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Sign in with Google to connect Gmail. Authorization code flow with PKCE and a state value tied to this browser.
// Only the refresh token is kept, encrypted. It never comes back out of the API.
export const googleRoutes: FastifyPluginAsync<Deps> = async (app, { db, vault, google, config }) => {
  app.get(`${PATH}/start`, async (req, reply) => {
    if (req.auth!.role !== "admin") return reply.code(403).send({ error: "admins_only" });
    if (!google?.configured) return reply.code(503).send({ error: "google_not_configured" });
    const state = randomBytes(24).toString("base64url");
    const verifier = randomBytes(48).toString("base64url");
    reply.setCookie(COOKIE, `${state}.${verifier}`, { httpOnly: true, sameSite: "lax", secure: config.cookieSecure, path: PATH, maxAge: 600 });
    return reply.redirect(google.authUrl(state, pkceChallenge(verifier)));
  });

  app.get(`${PATH}/callback`, async (req, reply) => {
    const { workspaceId, userId, role } = req.auth!;
    const q = z.object({ code: z.string().max(2000).optional(), state: z.string().max(200).optional(), error: z.string().max(200).optional() }).parse(req.query);
    const raw = req.cookies[COOKIE];
    reply.clearCookie(COOKIE, { path: PATH });
    // The result goes back to the app as a query string it reads once and then removes.
    const back = (result: string) => reply.redirect(`/?google=${result}#/settings`);

    const [state, verifier] = (raw ?? "").split(".");
    if (!google?.configured || role !== "admin" || !state || !verifier || !q.state || !same(state, q.state)) return back("error");
    if (q.error || !q.code) return back("denied");

    let tokens;
    let email;
    try {
      tokens = await google.exchangeCode(q.code, verifier);
      email = await google.profileEmail(tokens.accessToken);
    } catch (e) {
      req.log.warn({ kind: e instanceof GmailError ? e.kind : "unexpected" }, "google connect failed");
      return back("error");
    }
    // Google lets people untick permissions on the consent screen. Danny needs both mail permissions, or he would half work. Calendar is optional.
    const granted = tokens.scope.split(" ");
    if (!granted.includes(GMAIL_READ) || !granted.includes(GMAIL_SEND)) {
      await google.revoke(tokens.refreshToken ?? tokens.accessToken);
      return back("scopes");
    }
    const refreshToken = tokens.refreshToken;
    if (!refreshToken) return back("error");

    const old = await withTenant(db, workspaceId, async (tx) => {
      const prev = await tx.delete(connections).where(eq(connections.provider, "google")).returning({ id: connections.id, secretEnc: connections.secretEnc });
      const [c] = await tx
        .insert(connections)
        .values({ workspaceId, provider: "google", label: email, secretEnc: vault.sealJson(workspaceId, { refreshToken, calendar: granted.includes(CALENDAR_EVENTS) } satisfies GoogleSecret) })
        .returning({ id: connections.id });
      await tx.insert(auditLog).values({ workspaceId, userId, action: "connection.add", detail: { id: c!.id, provider: "google" } });
      return prev;
    });
    // Connecting again replaces the old login, and the old one stops working at Google too.
    for (const p of old) {
      google.forget(p.id);
      await google.revoke(vault.openJson<GoogleSecret>(workspaceId, p.secretEnc).refreshToken);
    }
    return back("connected");
  });
};
