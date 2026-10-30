import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog } from "../src/db/schema.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

let ctx: Ctx;
let owner: Client;
let ownerWs = "";
const root = mkdtempSync(join(tmpdir(), "danny-ops-"));
const requests = join(root, "requests");
const status = join(root, "status");

beforeAll(async () => {
  ctx = await setupApp(undefined, undefined, { OPS_DIR: root });
  const o = await seedOwner(ctx);
  owner = o.c;
  ownerWs = (await owner.get("/v1/me")).body.workspaceId;
});
afterAll(async () => {
  await ctx.close();
  rmSync(root, { recursive: true, force: true });
});

const put = (name: string, data: unknown) => writeFileSync(join(status, name), JSON.stringify(data));
const clear = () => {
  for (const f of readdirSync(requests)) rmSync(join(requests, f));
};

describe("owner tab: update and backup", () => {
  it("is for the owner only", async () => {
    const u = await signUp(ctx, owner, "Nope");
    expect((await u.c.get("/v1/admin/ops")).status).toBe(403);
    expect((await u.c.post("/v1/admin/ops", { action: "update" })).status).toBe(403);
  });

  it("says it isn't set up, and refuses, until the server has the folders", async () => {
    const v = (await owner.get("/v1/admin/ops")).body;
    expect(v).toMatchObject({ available: false, busy: false, last: null, backups: [] });
    const r = await owner.post("/v1/admin/ops", { action: "backup" });
    expect(r.status).toBe(503);
    expect(r.body.message).toContain("danny ops-install");
  });

  it("drops one empty request file and records who asked, then refuses a second until it is done", async () => {
    mkdirSync(requests, { recursive: true });
    mkdirSync(status, { recursive: true });
    put("repo.json", { version: "abc1234", branch: "main", behind: 2, changes: ["Add goals", "Fix bug"], checkedAt: "2027-01-01T00:00:00Z" });
    put("backups.json", [{ name: "danny-20270101-030000.sql.gz", bytes: 20480, at: "2027-01-01T03:00:00Z" }]);
    const v = (await owner.get("/v1/admin/ops")).body;
    expect(v).toMatchObject({ available: true, busy: false, version: "abc1234", behind: 2, changes: ["Add goals", "Fix bug"] });
    expect(v.backups).toEqual([{ name: "danny-20270101-030000.sql.gz", bytes: 20480, at: "2027-01-01T03:00:00Z" }]);

    expect((await owner.post("/v1/admin/ops", { action: "update" })).status).toBe(202);
    expect(readdirSync(requests)).toEqual(["update"]); // an empty file named for the action, nothing else
    expect((await owner.get("/v1/admin/ops")).body).toMatchObject({ busy: true, pending: ["update"] });
    expect((await owner.post("/v1/admin/ops", { action: "backup" })).status).toBe(409);
    const log = await ctx.owner.db.select().from(auditLog).where(eq(auditLog.workspaceId, ownerWs));
    expect(log.some((l) => l.action === "ops.update")).toBe(true);
    clear();
  });

  it("only knows check, backup and update", async () => {
    for (const bad of ["restore", "update; id", "../update", "", "shell"]) {
      expect((await owner.post("/v1/admin/ops", { action: bad })).status, bad).toBe(400);
    }
    expect(readdirSync(requests)).toEqual([]);
  });

  it("is busy while the server is running something, and recovers if that never finished", async () => {
    put("last.json", { action: "update", state: "running", startedAt: new Date().toISOString(), finishedAt: null, summary: "" });
    expect((await owner.get("/v1/admin/ops")).body).toMatchObject({ busy: true, last: { action: "update", state: "running" } });
    expect((await owner.post("/v1/admin/ops", { action: "backup" })).status).toBe(409);
    put("last.json", { action: "update", state: "running", startedAt: new Date(Date.now() - 2 * 3600_000).toISOString(), finishedAt: null, summary: "" });
    expect((await owner.get("/v1/admin/ops")).body.busy).toBe(false); // a rebooted server must not lock the buttons forever
    clear();
  });

  it("shows the result of the last thing, and ignores junk in the status files", async () => {
    put("last.json", { action: "backup", state: "ok", startedAt: "2027-01-01T03:00:00Z", finishedAt: "2027-01-01T03:00:02Z", summary: "backup ok: /var/backups/danny/x.sql.gz (20K)\n" });
    expect((await owner.get("/v1/admin/ops")).body.last).toMatchObject({ action: "backup", state: "ok", summary: "backup ok: /var/backups/danny/x.sql.gz (20K)\n" });
    writeFileSync(join(status, "last.json"), "not json");
    writeFileSync(join(status, "repo.json"), JSON.stringify({ version: 5, behind: "lots", changes: "x", branch: { a: 1 } }));
    writeFileSync(join(status, "backups.json"), JSON.stringify("nope"));
    expect((await owner.get("/v1/admin/ops")).body).toMatchObject({ last: null, version: null, behind: 0, changes: [], backups: [] });
  });
});
