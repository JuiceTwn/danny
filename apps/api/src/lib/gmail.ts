import { desc, eq } from "drizzle-orm";
import { connections } from "../db/schema.js";
import { GmailError } from "./google.js";
import type { ToolCtx } from "../tools/registry.js";

/** `calendar` is true when the user ticked the calendar permission. Logins saved before calendar existed have no flag. */
export type GoogleSecret = { refreshToken: string; calendar?: boolean };
type Conn = { id: string; label: string; refreshToken: string; calendar: boolean };

const NOT_CONNECTED = "Gmail isn't connected. Tell the user to connect it in Settings.";
const RECONNECT = "Gmail needs to be reconnected. Tell the user to reconnect it in Settings.";

async function activeConnection(ctx: ToolCtx): Promise<Conn> {
  const [row] = await ctx.tenant((tx) => tx.select().from(connections).where(eq(connections.provider, "google")).orderBy(desc(connections.createdAt)).limit(1));
  if (!row) throw new GmailError(NOT_CONNECTED, "failed");
  if (row.status !== "active") throw new GmailError(RECONNECT, "reconnect");
  const secret = JSON.parse(ctx.vault.open(ctx.workspaceId, row.secretEnc)) as GoogleSecret;
  return { id: row.id, label: row.label, refreshToken: secret.refreshToken, calendar: secret.calendar === true };
}

/** One Gmail API call for this workspace's connected account. */
export async function google<T>(ctx: ToolCtx, path: string, init?: { method?: string; json?: unknown; api?: "gmail" | "calendar" }): Promise<T> {
  if (!ctx.google) throw new GmailError(NOT_CONNECTED, "failed");
  const conn = await activeConnection(ctx);
  if (init?.api === "calendar" && !conn.calendar) throw new GmailError("Calendar isn't connected. Tell the user to reconnect Google in Settings and leave the calendar permission ticked.", "failed");
  try {
    return await ctx.google.call<T>(conn, path, init);
  } catch (e) {
    if (e instanceof GmailError && e.kind === "reconnect") {
      await ctx.tenant((tx) => tx.update(connections).set({ status: "needs_reconnect" }).where(eq(connections.id, conn.id)));
      ctx.google.forget(conn.id);
    }
    throw e;
  }
}

// ---- Reading ----

type Part = { mimeType?: string; filename?: string; body?: { data?: string }; parts?: Part[] };
type ApiMessage = { id: string; threadId: string; snippet?: string; payload?: Part & { headers?: { name: string; value: string }[] } };

export type MailSummary = { id: string; from: string; subject: string; date: string; snippet: string };
export type Mail = MailSummary & { to: string; cc: string; text: string; attachments: string[]; truncated: boolean };

const header = (m: ApiMessage, name: string) => m.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };
export const htmlToText = (html: string) =>
  html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

function walk(p: Part | undefined, out: { plain: string[]; html: string[]; files: string[] }) {
  if (!p) return;
  if (p.filename) out.files.push(p.filename);
  else if (p.body?.data && p.mimeType === "text/plain") out.plain.push(decode(p.body.data));
  else if (p.body?.data && p.mimeType === "text/html") out.html.push(decode(p.body.data));
  for (const c of p.parts ?? []) walk(c, out);
}

const BODY_LIMIT = 6000;

export function parseMail(m: ApiMessage): Mail {
  const out = { plain: [] as string[], html: [] as string[], files: [] as string[] };
  walk(m.payload, out);
  const text = (out.plain.length ? out.plain.join("\n") : htmlToText(out.html.join("\n"))).trim();
  return {
    id: m.id,
    from: header(m, "From"),
    to: header(m, "To"),
    cc: header(m, "Cc"),
    subject: header(m, "Subject"),
    date: header(m, "Date"),
    snippet: m.snippet ?? "",
    text: text.slice(0, BODY_LIMIT),
    attachments: out.files,
    truncated: text.length > BODY_LIMIT,
  };
}

export async function searchMail(ctx: ToolCtx, query: string, max: number): Promise<MailSummary[]> {
  const list = await google<{ messages?: { id: string }[] }>(ctx, `/messages?${new URLSearchParams({ q: query, maxResults: String(max) })}`);
  const ids = (list.messages ?? []).map((m) => m.id);
  const meta = await Promise.all(
    ids.map((id) => google<ApiMessage>(ctx, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)),
  );
  return meta.map((m) => ({ id: m.id, from: clip(oneLine(header(m, "From")), 100), subject: clip(oneLine(header(m, "Subject")), 150), date: header(m, "Date"), snippet: clip(oneLine(m.snippet ?? ""), 200) }));
}

export async function readMail(ctx: ToolCtx, id: string): Promise<Mail> {
  return parseMail(await google<ApiMessage>(ctx, `/messages/${id}?format=full`));
}

// ---- Sending ----

const b64lines = (buf: Buffer) => (buf.toString("base64").match(/.{1,76}/g) ?? []).join("\r\n");

/** RFC 2047: non-ASCII header text as encoded words of at most 75 characters each. */
export function encodeHeader(s: string) {
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words: string[] = [];
  let cur = "";
  for (const ch of s) {
    if (Buffer.byteLength(cur + ch) > 45) {
      words.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

export type Outgoing = { to: string[]; cc: string[]; subject: string; body: string; inReplyTo?: string; references?: string };

/** The message exactly as it will be sent. Callers validate addresses; this refuses anything that could add a header. */
export function buildMime(o: Outgoing) {
  for (const v of [...o.to, ...o.cc, o.subject, o.inReplyTo ?? "", o.references ?? ""]) {
    if (/[\r\n]/.test(v)) throw new GmailError("That message has an invalid header.", "failed");
  }
  const lines = [
    `To: ${o.to.join(", ")}`,
    ...(o.cc.length ? [`Cc: ${o.cc.join(", ")}`] : []),
    `Subject: ${encodeHeader(o.subject)}`,
    ...(o.inReplyTo ? [`In-Reply-To: ${o.inReplyTo}`] : []),
    ...(o.references ? [`References: ${o.references}`] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    b64lines(Buffer.from(o.body.replace(/\r?\n/g, "\r\n"), "utf8")),
  ];
  return lines.join("\r\n");
}

/** Send a message from the connected account. Replying also threads it under the original. */
export async function sendMail(ctx: ToolCtx, o: Omit<Outgoing, "inReplyTo" | "references"> & { replyToId?: string }) {
  let thread: string | undefined;
  let inReplyTo: string | undefined;
  let references: string | undefined;
  if (o.replyToId) {
    const orig = await google<ApiMessage>(ctx, `/messages/${o.replyToId}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References`);
    thread = orig.threadId;
    inReplyTo = header(orig, "Message-ID") || undefined;
    references = [header(orig, "References"), inReplyTo].filter(Boolean).join(" ") || undefined;
  }
  const raw = Buffer.from(buildMime({ ...o, inReplyTo, references })).toString("base64url");
  const sent = await google<{ id: string }>(ctx, "/messages/send", { method: "POST", json: { raw, ...(thread ? { threadId: thread } : {}) } });
  return sent.id;
}
