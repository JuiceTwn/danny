import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Config } from "../config.js";
import { withTenant, type Db } from "../db/client.js";
import { auditLog, conversations, messages, sessions, users } from "../db/schema.js";
import type { ApiKeys } from "./api-keys.js";
import { countErrors, recentErrors } from "./error-ring.js";
import { tidy } from "./format.js";
import type { Health } from "./health.js";
import { createInvite } from "./invites.js";
import { ACTIONS, Ops, type OpsAction, type OpsView } from "./ops.js";
import type { Vault } from "./vault.js";

/**
 * Slash commands for the server owner, typed into the chat: /status, /errors, /logs, /doctor, /backup, /update and so on. They run on the server before
 * anything reaches the model, cost nothing, and only the owner's own signed-in session can use them (everyone else's "/status" is just a message).
 * Anything that changes the server runs through the same allowlisted request files as the Owner tab buttons: the app never gets a shell or Docker.
 */
export type OwnerCtx = { db: Db; config: Config; vault: Vault; keys?: ApiKeys; health?: Health; appUrl: string; userId: string; workspaceId: string; timezone: string };
export type CommandResult = { text: string; /** Wait for this server action to finish, then post what it found in the chat. */ watch?: { action: OpsAction; since: number } };

type Command = { name: string; usage: string; help: string; run: (ctx: OwnerCtx, args: string[], ops: Ops) => Promise<CommandResult> };

const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;
const ago = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const clock = (ms: number, tz: string) => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: tz }).format(new Date(ms));
const lines = (...xs: (string | false | null | undefined)[]) => xs.filter((x): x is string => typeof x === "string" && x !== "").join("\n");
const bullets = (xs: string[]) => xs.map((x) => `- ${x}`).join("\n");

const NEEDS_SETUP = "Server actions aren't turned on yet. Run danny ops-install once on the server, then try again.";

/** Ask the server for one action. `confirm` guards the ones that restart things. */
async function serverAction(ops: Ops, action: OpsAction, what: string, now = Date.now()): Promise<CommandResult> {
  const r = await ops.request(action);
  if (r === "not_set_up") return { text: NEEDS_SETUP };
  if (r === "busy") return { text: "Something is already running on the server. Try again in a minute, or /last to see what it is." };
  return { text: `${what}`, watch: { action, since: now } };
}
const WARN = (what: string, cmd: string) => ({ text: lines(`**${what}**`, `Send **${cmd} confirm** to go ahead.`) });

/** What the server found, shaped for the chat. */
export function opsResultText(action: OpsAction, v: OpsView, texts: { doctor: string | null; logs: string | null }, tz: string): string {
  const last = v.last;
  if (!last || last.action !== action) return "No result yet. Try /last in a minute.";
  if (last.state === "failed") return lines(`**${action} failed**`, last.summary ?? "");
  if (action === "check") return v.behind > 0 ? lines(`**${v.behind} update${v.behind === 1 ? "" : "s"} waiting**`, bullets(v.changes.slice(0, 6)), "Send /update to install them.") : "**Up to date.** Nothing waiting.";
  if (action === "backup") return lines("**Backup done.**", v.backups[0] ? `Newest: ${v.backups[0].name} (${Math.max(1, Math.round((v.backups[0].bytes ?? 0) / 1024))} KB)` : "");
  if (action === "doctor" || action === "fix") {
    const rows = (texts.doctor ?? "").split("\n").map((l) => l.trim());
    const bad = rows.filter((l) => /^(WARN|FAIL)\s/.test(l));
    const good = rows.filter((l) => /^ok\s/.test(l)).length;
    return bad.length ? lines(`**${bad.length} thing${bad.length === 1 ? "" : "s"} to look at** (${good} fine)`, bullets(bad.map((l) => l.replace(/^(WARN|FAIL)\s+/, (m) => `${m.trim()}: `))), action === "doctor" && bad.some((l) => l.startsWith("FAIL")) ? "Send /fix confirm to try the safe repairs." : "") : `**Everything checks out.** ${good} checks passed.`;
  }
  if (action === "logs") return formatLogs(texts.logs ?? "", tz);
  return `**${action} done.**`;
}

/** Docker-prefixed JSON log lines into short readable ones. Anything that isn't JSON is shown as it is. */
export function formatLogs(raw: string, tz: string, max = 25): string {
  const out: string[] = [];
  for (const l of raw.split("\n")) {
    const line = l.replace(/^[^|{]*\|\s*/, "").trim();
    if (!line) continue;
    try {
      const j = JSON.parse(line) as { time?: number; level?: number; msg?: string; err?: { message?: string }; detail?: string };
      const level = (j.level ?? 30) >= 50 ? "ERROR" : (j.level ?? 30) >= 40 ? "WARN" : "info";
      const when = typeof j.time === "number" ? `${clock(j.time, tz)} ` : "";
      out.push(`${when}${level} ${j.msg ?? ""}${j.err?.message ? `: ${j.err.message}` : ""}`.replace(/\s+/g, " ").slice(0, 200));
    } catch {
      out.push(line.replace(/\s+/g, " ").slice(0, 200));
    }
  }
  const recent = out.slice(-max);
  return recent.length ? lines(`**Recent server log** (${recent.length} lines, health checks left out)`, bullets(recent)) : "**Nothing in the log** apart from health checks.";
}

export const COMMANDS: Command[] = [
  {
    name: "help",
    usage: "/help",
    help: "What I can do from here",
    run: async () => ({ text: lines("**Owner commands**", bullets(COMMANDS.map((c) => `**${c.usage}**: ${c.help}`))) }),
  },
  {
    name: "status",
    usage: "/status",
    help: "Is everything running? Version, spend, errors",
    run: async (c, _a, ops) => {
      const v = await ops.view();
      const db = await Promise.race([c.db.execute(sql`select 1`).then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), 2000))]).catch(() => false);
      const usage = await c.db.execute<{ today_cost_micros: string; month_cost_micros: string }>(sql`select * from admin_usage()`).catch(() => []);
      const today = usage.reduce((a, r) => a + Number(r.today_cost_micros), 0);
      const people = await c.db.select({ id: users.id }).from(users).where(and(eq(users.isOwner, false), isNull(users.previewOf), isNull(users.disabledAt)));
      const active = await c.db.selectDistinct({ id: sessions.userId }).from(sessions).where(gt(sessions.lastSeenAt, new Date(Date.now() - 86_400_000)));
      const errs = countErrors(Date.now() - 3_600_000);
      const up = process.uptime();
      return {
        text: lines(
          `**${db && (c.health?.schedulerOk() ?? true) ? "All good." : "Something is wrong."}**`,
          bullets([
            `Database: ${db ? "answering" : "NOT answering"}`,
            `Reminder scheduler: ${c.health ? (c.health.schedulerOk() ? "ticking" : "STOPPED") : "not tracked"}`,
            `Up for ${up < 3600 ? `${Math.round(up / 60)} min` : up < 172_800 ? `${Math.round(up / 3600)} h` : `${Math.round(up / 86_400)} days`}`,
            `Model: ${c.config.model}${c.keys ? (c.keys.has("anthropic") ? "" : " (NO API KEY: demo mode)") : ""}`,
            `Version ${v.version ?? "unknown"}${v.branch ? ` on ${v.branch}` : ""}${v.available ? (v.behind > 0 ? `, ${v.behind} update${v.behind === 1 ? "" : "s"} waiting` : ", up to date") : ""}`,
            `Spend today: ${usd(today)} across everyone`,
            `${people.length} ${people.length === 1 ? "person" : "people"}, ${active.length} active in the last day`,
            `Errors in the last hour: ${errs}${errs ? " (see /errors)" : ""}`,
            v.last ? `Last server action: ${v.last.action} ${v.last.state}${v.last.finishedAt ? `, ${ago(Date.now() - Date.parse(v.last.finishedAt))}` : ""}` : v.available ? "" : "Server actions: not set up (danny ops-install)",
          ].filter(Boolean) as string[]),
        ),
      };
    },
  },
  {
    name: "errors",
    usage: "/errors [how many]",
    help: "Recent failures since the server started (model, search, tools)",
    run: async (c, a) => {
      const n = Math.min(Math.max(Number(a[0]) || 10, 1), 30);
      const e = recentErrors(n);
      return { text: e.length ? lines(`**${e.length} most recent error${e.length === 1 ? "" : "s"}**`, bullets(e.map((x) => `${clock(x.at, c.timezone)} ${x.where}: ${x.message}`))) : "**No errors** since the server last started." };
    },
  },
  {
    name: "logs",
    usage: "/logs",
    help: "The latest lines of the server log (health checks left out)",
    run: async (_c, _a, ops) => serverAction(ops, "logs", "Reading the server log…"),
  },
  {
    name: "doctor",
    usage: "/doctor",
    help: "Full health check: containers, database, keys, disk, backups",
    run: async (_c, _a, ops) => serverAction(ops, "doctor", "Checking everything…"),
  },
  {
    name: "fix",
    usage: "/fix confirm",
    help: "Safe repairs: bring the stack up, free disk, clear the watchdog flag",
    run: async (_c, a, ops) => (a[0] === "confirm" ? serverAction(ops, "fix", "Running the safe repairs…") : WARN("This runs the doctor's safe repairs (starts anything that's down, frees disk space).", "/fix")),
  },
  {
    name: "check",
    usage: "/check",
    help: "Look for new versions",
    run: async (_c, _a, ops) => serverAction(ops, "check", "Looking for updates…"),
  },
  {
    name: "backup",
    usage: "/backup",
    help: "Back up the database now",
    run: async (_c, _a, ops) => serverAction(ops, "backup", "Backing up…"),
  },
  {
    name: "update",
    usage: "/update confirm",
    help: "Back up, install the latest version, restart (about 2 minutes)",
    run: async (_c, a, ops) => {
      if (a[0] !== "confirm") {
        const v = await ops.view();
        return WARN(v.available && v.behind > 0 ? `${v.behind} update${v.behind === 1 ? " is" : "s are"} waiting. This backs up, installs and restarts Danny (about 2 minutes). If the new version doesn't come up healthy, it puts the old one back.` : "This backs up, installs the latest version and restarts Danny (about 2 minutes). Run /check first to see if there is anything new.", "/update");
      }
      const r = await serverAction(ops, "update", "Updating. Danny will restart, so this chat will go quiet for a minute or two. Send /status when it's back.");
      return { text: r.text }; // the app restarts mid-update, so there is nothing to wait for here
    },
  },
  {
    name: "restart",
    usage: "/restart confirm",
    help: "Restart the app (fixes a stuck scheduler)",
    run: async (_c, a, ops) => {
      if (a[0] !== "confirm") return WARN("This restarts Danny for a few seconds. Reminders and chats in progress will be interrupted.", "/restart");
      const r = await serverAction(ops, "restart", "Restarting. Back in a few seconds. Send /status to check.");
      return { text: r.text };
    },
  },
  {
    name: "last",
    usage: "/last",
    help: "What the last server action did",
    run: async (c, _a, ops) => {
      const v = await ops.view();
      if (!v.last) return { text: v.available ? "Nothing has been run yet." : NEEDS_SETUP };
      const act = v.last.action as OpsAction;
      const body = ACTIONS.includes(act) ? opsResultText(act, v, { doctor: await ops.text("doctor.txt"), logs: await ops.text("logs.txt") }, c.timezone) : (v.last.summary ?? "");
      return { text: lines(`**${v.last.action}: ${v.last.state}**${v.last.finishedAt ? ` (${ago(Date.now() - Date.parse(v.last.finishedAt))})` : ""}`, body) };
    },
  },
  {
    name: "usage",
    usage: "/usage",
    help: "What each person has cost today and over 30 days",
    run: async (c) => {
      const rows = await c.db.execute<{ email: string; today_cost_micros: string; month_cost_micros: string }>(sql`select * from admin_usage()`);
      const sorted = [...rows].sort((a, b) => Number(b.month_cost_micros) - Number(a.month_cost_micros)).filter((r) => !r.email.endsWith("@preview.invalid"));
      const t = sorted.reduce((a, r) => a + Number(r.today_cost_micros), 0);
      const m = sorted.reduce((a, r) => a + Number(r.month_cost_micros), 0);
      return { text: lines(`**Spend:** ${usd(t)} today, ${usd(m)} over 30 days`, bullets(sorted.slice(0, 15).map((r) => `${r.email}: ${usd(Number(r.today_cost_micros))} today, ${usd(Number(r.month_cost_micros))} / 30 days`))) };
    },
  },
  {
    name: "users",
    usage: "/users",
    help: "Who has an account, and when they were last seen",
    run: async (c) => {
      const rows = await c.db
        .select({ email: users.email, name: users.name, owner: users.isOwner, off: users.disabledAt, created: users.createdAt, seen: sql<Date | null>`(select max(last_seen_at) from sessions s where s.user_id = ${users.id})` })
        .from(users)
        .where(isNull(users.previewOf))
        .orderBy(desc(users.createdAt))
        .limit(40);
      return {
        text: rows.length
          ? lines(`**${rows.length} account${rows.length === 1 ? "" : "s"}**`, bullets(rows.map((r) => `${r.email}${r.name ? ` (${r.name})` : ""}${r.owner ? " [owner]" : ""}${r.off ? " [disabled]" : ""}: ${r.seen ? `seen ${ago(Date.now() - new Date(r.seen).getTime())}` : "never signed in"}`)))
          : "No accounts.",
      };
    },
  },
  {
    name: "invite",
    usage: "/invite name@example.com",
    help: "Make a one-week invite link",
    run: async (c, a) => {
      const email = (a[0] ?? "").toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) return { text: "Give an email address: /invite name@example.com" };
      const [taken] = await c.db.select({ id: users.id }).from(users).where(eq(users.email, email));
      if (taken) return { text: `${email} already has an account.` };
      const { inviteUrl, expiresInDays } = await createInvite(c.db, c.appUrl, email, c.userId);
      await withTenant(c.db, c.workspaceId, (tx) => tx.insert(auditLog).values({ workspaceId: c.workspaceId, userId: c.userId, action: "invite.create", detail: { via: "command" } }));
      return { text: lines(`**Invite for ${email}** (good for ${expiresInDays} days)`, inviteUrl) };
    },
  },
];

export const commandList = () => COMMANDS.map((c) => ({ name: c.name, usage: c.usage, help: c.help }));

/** "/status", "/errors 5", "/update confirm". Not a command if it doesn't start with a slash and a letter. */
export const looksLikeCommand = (text: string) => /^\/[a-z]/i.test(text.trim());

export async function runOwnerCommand(c: OwnerCtx, text: string): Promise<CommandResult> {
  const [head = "", ...args] = text.trim().slice(1).split(/\s+/);
  const cmd = COMMANDS.find((x) => x.name === head.toLowerCase());
  if (!cmd) return { text: lines(`I don't know **/${head.slice(0, 30)}**.`, "Send /help for the list.") };
  const ops = new Ops(c.config.opsDir);
  try {
    const r = await cmd.run(c, args, ops);
    await withTenant(c.db, c.workspaceId, (tx) => tx.insert(auditLog).values({ workspaceId: c.workspaceId, userId: c.userId, action: "owner.command", detail: { command: cmd.name, ...(args[0] === "confirm" ? { confirmed: true } : {}) } }));
    return r;
  } catch {
    return { text: `**/${cmd.name} failed.** Try /errors for details.` };
  }
}

/** Put what was typed and what came back in the chat, so it is still there after a reload. */
export async function saveExchange(db: Db, vault: Vault, workspaceId: string, userId: string, typed: string, reply: string) {
  await withTenant(db, workspaceId, async (tx) => {
    let [conv] = await tx.select().from(conversations).where(eq(conversations.userId, userId)).limit(1);
    conv ??= (await tx.insert(conversations).values({ workspaceId, userId }).returning())[0]!;
    await tx.insert(messages).values({ workspaceId, conversationId: conv.id, role: "user", contentEnc: vault.sealJson(workspaceId, typed) });
    await tx.insert(messages).values({ workspaceId, conversationId: conv.id, role: "assistant", contentEnc: vault.sealJson(workspaceId, tidy(reply)) });
  });
}

/** Wait for a server action to finish (it runs on the host, not here), then say what it found. Gives up after a few minutes. */
export async function awaitOps(ops: Ops, action: OpsAction, since: number, tz: string, tries = 80, everyMs = 3000): Promise<string> {
  for (let i = 0; i < tries; i++) {
    const v = await ops.view();
    const done = v.last && v.last.action === action && v.last.state !== "running" && v.last.finishedAt && Date.parse(v.last.finishedAt) >= since - 5000;
    if (done) return opsResultText(action, v, { doctor: await ops.text("doctor.txt"), logs: await ops.text("logs.txt") }, tz);
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return `Still waiting on **${action}**. Try /last in a minute.`;
}
