import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ModelClient, ModelRequest, ModelResult } from "../src/brain/model.js";
import { auditLog, invites, users } from "../src/db/schema.js";
import { clearErrors, recordError } from "../src/lib/error-ring.js";
import { Ops } from "../src/lib/ops.js";
import { awaitOps, commandList, formatLogs, looksLikeCommand, opsResultText } from "../src/lib/owner-commands.js";
import { createRegistry } from "../src/tools/builtin.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

const root = mkdtempSync(join(tmpdir(), "danny-cmds-"));
const requests = join(root, "requests");
const status = join(root, "status");
let ctx: Ctx;
let owner: Client;
let ownerId = "";
let ownerWs = "";
const modelCalls: ModelRequest[] = [];
const model: ModelClient = {
  async complete(req, onText) {
    modelCalls.push(JSON.parse(JSON.stringify(req)));
    onText("model reply");
    return { content: [{ type: "text", text: "model reply" }], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } } as ModelResult;
  },
};

beforeAll(async () => {
  ctx = await setupApp(model, createRegistry(), { OPS_DIR: root });
  const o = await seedOwner(ctx);
  owner = o.c;
  const me = (await owner.get("/v1/me")).body;
  ownerId = me.user.id;
  ownerWs = me.workspaceId;
});
afterAll(async () => {
  await ctx.close();
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  modelCalls.length = 0;
  clearErrors();
});

const say = async (c: Client, message: string) => {
  const r = await c.req("POST", "/v1/chat", { message });
  const events = String(r.raw.body)
    .split("\n\n")
    .filter((x) => x.startsWith("data: "))
    .map((x) => JSON.parse(x.slice(6)));
  return { events, text: events.filter((e) => e.type === "text").map((e) => e.text).join("") as string };
};
const setUp = () => {
  mkdirSync(requests, { recursive: true });
  mkdirSync(status, { recursive: true });
  writeFileSync(join(status, "repo.json"), JSON.stringify({ version: "abc1234", branch: "main", behind: 2, changes: ["Add goals", "Fix bug"], checkedAt: "2027-01-01T00:00:00Z" }));
};
const clearRequests = () => {
  for (const f of readdirSync(requests)) rmSync(join(requests, f));
};

describe("who can use them", () => {
  it("only the owner: anyone else's slash message is just a message for the model", async () => {
    const u = await signUp(ctx, owner, "Plain");
    const r = await say(u.c, "/status");
    expect(r.text).toBe("model reply");
    expect(modelCalls).toHaveLength(1);
    expect((await u.c.get("/v1/admin/commands")).status).toBe(403);
  });

  it("the owner's commands never reach the model, and both sides are kept in the chat", async () => {
    const r = await say(owner, "/help");
    expect(r.events.map((e) => e.type)).toEqual(["text", "done"]);
    expect(r.text).toContain("**Owner commands**");
    expect(r.text).toContain("/status");
    expect(modelCalls).toHaveLength(0);
    const h = (await owner.get("/v1/chat/history")).body.messages as { role: string; text: string }[];
    expect(h.at(-2)).toMatchObject({ role: "user", text: "/help" });
    expect(h.at(-1)!.role).toBe("assistant");
    expect(h.at(-1)!.text).toContain("Owner commands");
  });

  it("a normal message still goes to the model, and so does a slash in the middle of a sentence", async () => {
    expect((await say(owner, "hello")).text).toBe("model reply");
    expect((await say(owner, "is 3/4 bigger than 2/3?")).text).toBe("model reply");
    expect(looksLikeCommand("/status")).toBe(true);
    expect(looksLikeCommand("  /status ")).toBe(true);
    expect(looksLikeCommand("/ 5")).toBe(false);
    expect(looksLikeCommand("//comment")).toBe(false);
  });

  it("says what it doesn't know, and lists the commands for the menu", async () => {
    const r = await say(owner, "/nonsense");
    expect(r.text).toContain("I don't know **/nonsense**");
    const list = (await owner.get("/v1/admin/commands")).body.items as { name: string; usage: string; help: string }[];
    expect(list.map((c) => c.name)).toEqual(expect.arrayContaining(["status", "errors", "logs", "doctor", "backup", "update", "restart", "invite", "usage", "users", "last", "fix", "check", "help"]));
    expect(list.every((c) => c.usage.startsWith("/") && c.help.length > 5)).toBe(true);
    expect(commandList()).toHaveLength(list.length);
  });

  it("is recorded in the audit log, and says when a confirmation was given", async () => {
    await say(owner, "/help");
    const log = (await ctx.owner.db.select().from(auditLog).where(eq(auditLog.userId, ownerId))).filter((a) => a.action === "owner.command");
    expect(log.some((a) => (a.detail as any).command === "help")).toBe(true);
  });
});

describe("looking around", () => {
  it("/status gives the picture in a few lines", async () => {
    const r = await say(owner, "/status");
    expect(r.text).toContain("**All good.**");
    expect(r.text).toContain("Database: answering");
    expect(r.text).toContain(`Model: ${ctx.config.model}`);
    expect(r.text).toContain("Errors in the last hour: 0");
    expect(r.text).toMatch(/\d+ (person|people), \d+ active/);
    expect(r.text).toContain("Server actions: not set up");
  });

  it("/errors lists what went wrong since start-up, newest first, and counts them in /status", async () => {
    expect((await say(owner, "/errors")).text).toContain("**No errors** since the server last started.");
    recordError("chat model call", "chat model call failed: auth (401): invalid x-api-key sk-…");
    recordError("web search", "web search failed: overloaded (529): Overloaded");
    const r = await say(owner, "/errors");
    expect(r.text).toContain("**2 most recent errors**");
    expect(r.text.indexOf("web search")).toBeLessThan(r.text.indexOf("chat model call"));
    expect(r.text).toContain("auth (401)");
    expect((await say(owner, "/errors 1")).text).toContain("**1 most recent error**");
    expect((await say(owner, "/status")).text).toContain("Errors in the last hour: 2 (see /errors)");
  });

  it("/usage and /users show people, and leave out the throwaway preview account", async () => {
    const u = await signUp(ctx, owner, "Spender");
    await owner.post("/v1/preview/start");
    await owner.post("/v1/preview/stop");
    const usage = await say(owner, "/usage");
    expect(usage.text).toContain("**Spend:**");
    expect(usage.text).toMatch(/- \S+@\S+: \$\d+\.\d\d today, \$\d+\.\d\d \/ 30 days/); // only the 15 biggest are shown, so a new person with no spend may not be in it
    expect(usage.text).not.toContain("preview.invalid");
    const list = await say(owner, "/users");
    expect(list.text).toContain(u.email);
    expect(list.text).toContain("[owner]");
    expect(list.text).not.toContain("preview.invalid");
  });

  it("/invite makes a link, refuses a bad address, and notices someone who already has an account", async () => {
    expect((await say(owner, "/invite")).text).toContain("Give an email address");
    expect((await say(owner, "/invite not-an-email")).text).toContain("Give an email address");
    const r = await say(owner, "/invite Friend@Example.com");
    expect(r.text).toContain("**Invite for friend@example.com**");
    expect(r.text).toMatch(/\/accept\?token=[A-Za-z0-9_-]{20,}/);
    expect((await ctx.owner.db.select().from(invites).where(eq(invites.email, "friend@example.com"))).length).toBe(1);
    const [me] = await ctx.owner.db.select().from(users).where(eq(users.id, ownerId));
    expect((await say(owner, `/invite ${me!.email}`)).text).toContain("already has an account");
  });
});

describe("running things on the server", () => {
  it("says what is needed before the server is set up", async () => {
    for (const c of ["/backup", "/doctor", "/logs", "/check"]) expect((await say(owner, c)).text).toContain("danny ops-install");
  });

  it("asks the server for each action by dropping one empty, exactly-named file", async () => {
    setUp();
    for (const [cmd, file] of [["/backup", "backup"], ["/doctor", "doctor"], ["/logs", "logs"], ["/check", "check"]] as const) {
      clearRequests();
      const r = await say(owner, cmd);
      expect(r.text.length).toBeGreaterThan(5);
      expect(readdirSync(requests)).toEqual([file]);
    }
    // one at a time
    const again = await say(owner, "/logs");
    expect(again.text).toContain("already running");
    clearRequests();
  });

  it("asks you to confirm before anything that restarts things, and then does it", async () => {
    setUp();
    clearRequests();
    for (const [cmd, file] of [["/update", "update"], ["/restart", "restart"], ["/fix", "fix"]] as const) {
      const warn = await say(owner, cmd);
      expect(warn.text).toContain(`Send **${cmd} confirm** to go ahead.`);
      expect(readdirSync(requests)).toEqual([]);
      const maybe = await say(owner, `${cmd} please`);
      expect(maybe.text).toContain("to go ahead");
      expect(readdirSync(requests)).toEqual([]);
      const go = await say(owner, `${cmd} confirm`);
      expect(go.text.length).toBeGreaterThan(5);
      expect(readdirSync(requests)).toEqual([file]);
      clearRequests();
    }
    const log = (await ctx.owner.db.select().from(auditLog).where(eq(auditLog.userId, ownerId))).filter((a) => a.action === "owner.command");
    expect(log.some((a) => (a.detail as any).command === "update" && (a.detail as any).confirmed === true)).toBe(true);
  });

  it("/update tells you how many updates are waiting", async () => {
    setUp();
    expect((await say(owner, "/update")).text).toContain("2 updates are waiting");
  });

  it("/last says what the last action did, in words", async () => {
    setUp();
    writeFileSync(join(status, "last.json"), JSON.stringify({ action: "doctor", state: "ok", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), summary: "Ran the doctor." }));
    writeFileSync(join(status, "doctor.txt"), "Danny doctor\n  ok    Docker is running\n  WARN  disk is 88% full\n  FAIL  the API does not answer\n");
    const r = await say(owner, "/last");
    expect(r.text).toContain("**doctor: ok**");
    expect(r.text).toContain("**2 things to look at** (1 fine)");
    expect(r.text).toContain("WARN: disk is 88% full");
    expect(r.text).toContain("/fix confirm");
  });
});

describe("what the server found, shaped for the chat", () => {
  const view = (over: Record<string, unknown> = {}) => ({ available: true, busy: false, pending: [], last: { action: "check", state: "ok", startedAt: null, finishedAt: null, summary: null }, version: "a", branch: "main", behind: 0, changes: [], checkedAt: null, backups: [], ...over }) as never;

  it("check, backup and failures", () => {
    expect(opsResultText("check", view(), { doctor: null, logs: null }, "UTC")).toContain("Up to date");
    expect(opsResultText("check", view({ behind: 1, changes: ["Fix bug"] }), { doctor: null, logs: null }, "UTC")).toContain("**1 update waiting**");
    expect(opsResultText("backup", view({ last: { action: "backup", state: "ok" }, backups: [{ name: "danny-1.sql.gz", bytes: 20480, at: "x" }] }), { doctor: null, logs: null }, "UTC")).toContain("danny-1.sql.gz (20 KB)");
    expect(opsResultText("update", view({ last: { action: "update", state: "failed", summary: "local changes would be overwritten" } }), { doctor: null, logs: null }, "UTC")).toContain("**update failed**");
    expect(opsResultText("backup", view(), { doctor: null, logs: null }, "UTC")).toContain("No result yet");
  });

  it("a clean doctor report is one line", () => {
    const text = opsResultText("doctor", view({ last: { action: "doctor", state: "ok" } }), { doctor: "Danny doctor\n  ok    a\n  ok    b\n", logs: null }, "UTC");
    expect(text).toBe("**Everything checks out.** 2 checks passed.");
  });

  it("log lines become short readable ones, with levels, and health checks gone", () => {
    const raw = [
      'api-1  | {"level":50,"time":1793733500000,"where":"chat model call","msg":"chat model call failed: auth (401): invalid x-api-key"}',
      'api-1  | {"level":40,"time":1793733501000,"msg":"briefing not written","err":{"message":"down"}}',
      "api-1  | plain text line",
    ].join("\n");
    const t = formatLogs(raw, "UTC");
    expect(t).toContain("**Recent server log** (3 lines");
    expect(t).toContain("ERROR chat model call failed: auth (401)");
    expect(t).toContain("WARN briefing not written: down");
    expect(t).toContain("- plain text line");
    expect(formatLogs("", "UTC")).toContain("Nothing in the log");
  });

  it("waits for the server to finish, then reports; gives up politely", async () => {
    setUp();
    const ops = new Ops(root);
    const since = Date.now();
    writeFileSync(join(status, "last.json"), JSON.stringify({ action: "logs", state: "running", startedAt: new Date().toISOString(), finishedAt: null, summary: "" }));
    setTimeout(() => {
      writeFileSync(join(status, "logs.txt"), 'api-1  | {"level":50,"time":1793733500000,"msg":"boom"}\n');
      writeFileSync(join(status, "last.json"), JSON.stringify({ action: "logs", state: "ok", startedAt: new Date(since).toISOString(), finishedAt: new Date().toISOString(), summary: "Read the log." }));
    }, 60);
    const done = await awaitOps(ops, "logs", since, "UTC", 40, 20);
    expect(done).toContain("ERROR boom");
    writeFileSync(join(status, "last.json"), JSON.stringify({ action: "logs", state: "running", startedAt: new Date().toISOString(), finishedAt: null, summary: "" }));
    expect(await awaitOps(ops, "doctor", Date.now(), "UTC", 2, 5)).toContain("Still waiting on **doctor**");
  });
});
