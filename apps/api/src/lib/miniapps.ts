import { and, desc, eq, gte, sql } from "drizzle-orm";
import { miniApps, auditLog } from "../db/schema.js";
import type { Actor } from "./tasks.js";

/**
 * Mini apps: a small page a model wrote for one person ("learn electric guitar"), with their progress saved as one JSON blob.
 *
 * The page is model-written code, so it is never trusted. It runs in a sandboxed frame with no cookies, no way to reach Danny's
 * API and no way to send anything anywhere (see APP_CSP). The checks in validateAppHtml are only there to fail early with a clear
 * reason and to catch things that would crash in the sandbox; the sandbox itself is the security.
 */

export const MAX_HTML = 150_000;
export const MAX_STATE = 100_000;
export const MAX_APPS_PER_PERSON = 5;
export const MAX_CHANGES_PER_DAY = 4;
export const MAX_TRIES = 2;

/** Sent with every page. `sandbox` without allow-same-origin gives the page an empty identity: no cookies, no storage, no Danny. */
export const APP_CSP = [
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "media-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
].join("; ");

export class AppError extends Error {}

const DENY: [RegExp, string][] = [
  [/<script[^>]+\bsrc\s*=/i, "loads a script from outside"],
  [/<link[^>]+\bhref\s*=\s*["']?(https?:)?\/\//i, "loads a file from outside"],
  [/@import\s+(url\()?["']?(https?:)?\/\//i, "loads a file from outside"],
  [/\bfetch\s*\(|new\s+(XMLHttpRequest|WebSocket|EventSource)\b|sendBeacon\s*\(|importScripts\s*\(/, "tries to use the network"],
  [/\beval\s*\(|new\s+Function\s*\(/, "uses eval"],
  [/\bwindow\.open\s*\(/, "opens windows itself"],
  [/\b(window\.|top\.|parent\.|self\.|document\.)?location\s*(=[^=]|\.\s*(href|assign|replace)\b)/, "navigates away"],
  [/<meta[^>]+http-equiv\s*=\s*["']?refresh/i, "redirects"],
  [/\b(window\.parent|window\.top|parent\.postMessage|top\.postMessage|window\.frames)\b/, "reaches outside its frame"],
  [/\bdocument\.cookie\b|\b(localStorage|sessionStorage|indexedDB)\b/, "uses browser storage, which the sandbox does not allow"],
];

/** Pull the page out of a model reply (it may add a code fence or a sentence), and refuse anything that is not one complete, self-contained page. */
export function validateAppHtml(raw: string): { ok: true; html: string } | { ok: false; reason: string } {
  let t = raw.trim();
  const fence = t.match(/```(?:html)?\s*\n([\s\S]*?)```/i);
  if (fence) t = fence[1]!.trim();
  const start = t.search(/<!doctype html|<html[\s>]/i);
  const end = t.toLowerCase().lastIndexOf("</html>");
  if (start === -1 || end === -1 || end < start) return { ok: false, reason: "the page was not complete" };
  const html = t.slice(start, end + "</html>".length);
  if (Buffer.byteLength(html) > MAX_HTML) return { ok: false, reason: "the page was too big" };
  for (const [re, why] of DENY) if (re.test(html)) return { ok: false, reason: `the page ${why}` };
  return { ok: true, html };
}

/** What every page gets at the moment it is served: a way to load and save its progress through Danny's page around it. Not stored. */
const BOOTSTRAP = `<script>(function(){var P=window.parent,w={},n=0;
window.danny={load:function(){return new Promise(function(r){var i=++n;w[i]=r;P.postMessage({danny:'load',id:i},'*');setTimeout(function(){if(w[i]){delete w[i];r(null);}},3000);});},
save:function(s){try{P.postMessage({danny:'save',state:JSON.parse(JSON.stringify(s))},'*');}catch(e){}}};
addEventListener('message',function(e){var d=e.data;if(d&&d.danny==='state'&&w[d.id]){w[d.id](d.state||null);delete w[d.id];}});
document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href]');if(!a)return;var h=a.getAttribute('href')||'';if(/^https:\\/\\//i.test(h)){e.preventDefault();window.open(h,'_blank','noopener');}else if(h.charAt(0)!=='#'){e.preventDefault();}},true);
})();</script>`;

export const withBootstrap = (html: string) => (/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${BOOTSTRAP}`) : html.replace(/<html[^>]*>/i, (m) => `${m}<head>${BOOTSTRAP}</head>`));

// ---- Records ----

export type AppView = { id: string; title: string; status: string; version: number; error: string | null; createdAt: string; updatedAt: string };
const view = (a: Actor, r: typeof miniApps.$inferSelect): AppView => ({
  id: r.id,
  title: a.vault.open(a.workspaceId, r.titleEnc),
  status: r.status,
  version: r.version,
  error: r.error,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

export async function createApp(a: Actor, input: { title: string; request: string }) {
  return a.tenant(async (tx) => {
    const mine = await tx.select({ id: miniApps.id }).from(miniApps).where(and(eq(miniApps.userId, a.userId)));
    if (mine.length >= MAX_APPS_PER_PERSON) throw new AppError(`You already have ${MAX_APPS_PER_PERSON} apps. Delete one first.`);
    const [row] = await tx
      .insert(miniApps)
      .values({ workspaceId: a.workspaceId, userId: a.userId, titleEnc: a.vault.seal(a.workspaceId, input.title), requestEnc: a.vault.seal(a.workspaceId, input.request) })
      .returning();
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "app.create", detail: { id: row!.id } });
    return view(a, row!);
  });
}

export async function listApps(a: Actor) {
  const rows = await a.tenant((tx) => tx.select().from(miniApps).where(eq(miniApps.userId, a.userId)).orderBy(desc(miniApps.createdAt)));
  return rows.map((r) => view(a, r));
}

export async function getApp(a: Actor, id: string) {
  const [r] = await a.tenant((tx) => tx.select().from(miniApps).where(and(eq(miniApps.id, id), eq(miniApps.userId, a.userId))));
  if (!r) return null;
  return {
    ...view(a, r),
    html: r.htmlEnc ? a.vault.open(a.workspaceId, r.htmlEnc) : null,
    state: r.stateEnc ? (JSON.parse(a.vault.open(a.workspaceId, r.stateEnc)) as Record<string, unknown>) : null,
  };
}

/** Their progress, as the app saved it. Must be a JSON object and small. */
export async function saveState(a: Actor, id: string, state: unknown) {
  if (!state || typeof state !== "object" || Array.isArray(state)) throw new AppError("Progress has to be a JSON object.");
  const text = JSON.stringify(state);
  if (Buffer.byteLength(text) > MAX_STATE) throw new AppError("That's too much to save.");
  return a.tenant(async (tx) => {
    const rows = await tx
      .update(miniApps)
      .set({ stateEnc: a.vault.seal(a.workspaceId, text), updatedAt: new Date() })
      .where(and(eq(miniApps.id, id), eq(miniApps.userId, a.userId), sql`${miniApps.htmlEnc} is not null`))
      .returning({ id: miniApps.id });
    return rows.length > 0;
  });
}

/** Ask for a change ("make it harder", "add a chord quiz") or report it broken. Rebuilds from the page they have now. */
export async function requestChange(a: Actor, id: string, request: string, now = new Date()) {
  return a.tenant(async (tx) => {
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const [{ n } = { n: 0 }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(and(eq(auditLog.userId, a.userId), eq(auditLog.action, "app.change"), gte(auditLog.at, dayStart)));
    if (n >= MAX_CHANGES_PER_DAY) throw new AppError(`That's ${MAX_CHANGES_PER_DAY} changes today. Each one costs real money, so try again tomorrow.`);
    const rows = await tx
      .update(miniApps)
      .set({ requestEnc: a.vault.seal(a.workspaceId, request), status: "editing", attempts: 0, error: null, runAfter: now, updatedAt: now })
      .where(and(eq(miniApps.id, id), eq(miniApps.userId, a.userId), eq(miniApps.status, "ready")))
      .returning({ id: miniApps.id });
    if (!rows.length) return false;
    await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "app.change", detail: { id } });
    return true;
  });
}

/** A failed first build can be tried again; this puts it back in the queue. */
export async function retryApp(a: Actor, id: string, now = new Date()) {
  return a.tenant(async (tx) => {
    const rows = await tx
      .update(miniApps)
      .set({ status: "queued", attempts: 0, error: null, runAfter: now, updatedAt: now })
      .where(and(eq(miniApps.id, id), eq(miniApps.userId, a.userId), eq(miniApps.status, "failed"), sql`${miniApps.htmlEnc} is null`))
      .returning({ id: miniApps.id });
    return rows.length > 0;
  });
}

export async function deleteApp(a: Actor, id: string) {
  return a.tenant(async (tx) => {
    const rows = await tx.delete(miniApps).where(and(eq(miniApps.id, id), eq(miniApps.userId, a.userId))).returning({ id: miniApps.id });
    if (rows.length) await tx.insert(auditLog).values({ workspaceId: a.workspaceId, userId: a.userId, action: "app.delete", detail: { id } });
    return rows.length > 0;
  });
}
