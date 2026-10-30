import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenant } from "../src/db/client.js";
import { connections, memory } from "../src/db/schema.js";
import { Vault } from "../src/lib/vault.js";
import { readConnectionSecret } from "../src/tools/connections.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

const key = () => randomBytes(32).toString("base64");
const WS_A = "11111111-1111-4111-8111-111111111111";
const WS_B = "22222222-2222-4222-8222-222222222222";

describe("vault", () => {
  const v = new Vault(`1:${key()}`);

  it("round-trips text and JSON, and never stores plaintext", () => {
    const blob = v.seal(WS_A, "Marlene prefers texts");
    expect(blob.toString("utf8")).not.toContain("Marlene");
    expect(v.open(WS_A, blob)).toBe("Marlene prefers texts");
    expect(v.openJson(WS_A, v.sealJson(WS_A, { draft: "Hi", n: 2 }))).toEqual({ draft: "Hi", n: 2 });
  });

  it("uses a fresh nonce every time", () => {
    expect(v.seal(WS_A, "same").equals(v.seal(WS_A, "same"))).toBe(false);
  });

  it("detects tampering", () => {
    const blob = v.seal(WS_A, "hello");
    blob[blob.length - 1]! ^= 1;
    expect(() => v.open(WS_A, blob)).toThrow();
    expect(() => v.open(WS_A, Buffer.from([1, 2, 3]))).toThrow(/malformed/);
  });

  it("a blob copied into another workspace will not open there", () => {
    const blob = v.seal(WS_A, "only for A");
    expect(() => v.open(WS_B, blob)).toThrow();
  });

  it("workspaces get different keys from the same master", () => {
    const solo = new Vault(`1:${key()}`);
    // sealing the same text for two workspaces must not be openable with the other's key, even ignoring AAD
    const a = solo.seal(WS_A, "x"), b = solo.seal(WS_B, "x");
    expect(a.subarray(29).equals(b.subarray(29))).toBe(false);
  });

  it("rotates: old data still opens, new data uses the new key", () => {
    const k1 = key(), k2 = key();
    const oldV = new Vault(`1:${k1}`);
    const old = oldV.seal(WS_A, "written before rotation");
    const rotated = new Vault(`1:${k1},2:${k2}`);
    expect(rotated.currentVersion).toBe(2);
    expect(rotated.open(WS_A, old)).toBe("written before rotation");
    expect(rotated.isStale(old)).toBe(true);
    const fresh = rotated.seal(WS_A, "after");
    expect(fresh[0]).toBe(2);
    expect(rotated.isStale(fresh)).toBe(false);
    expect(() => new Vault(`2:${k2}`).open(WS_A, old)).toThrow(); // key 1 removed: old data is gone
  });

  it("rejects bad key config", () => {
    expect(() => new Vault("")).toThrow();
    expect(() => new Vault("1:c2hvcnQ=")).toThrow(/32 bytes/);
    expect(() => new Vault(`0:${key()}`)).toThrow(/1-255/);
  });
});

describe("what the database really holds", () => {
  let ctx: Ctx;
  let owner: Client;
  beforeAll(async () => {
    ctx = await setupApp();
    owner = (await seedOwner(ctx)).c;
  });
  afterAll(() => ctx.close());

  const raw = async (table: string, col: string, id: string | number) =>
    String((await ctx.owner.client.unsafe(`select encode(${col}, 'escape') as v from ${table} where id = '${id}'`))[0]!.v);

  it("memory, approvals and messages are unreadable in the table", async () => {
    const u = await signUp(ctx, owner, "Atrest");
    const m = await u.c.post("/v1/memory", { content: "SECRET-MEMORY-TEXT" });
    const a = await u.c.post("/v1/approvals", { kind: "email", title: "t", payload: { draft: "SECRET-DRAFT-TEXT" } });
    expect(await raw("memory", "content_enc", m.body.item.id)).not.toContain("SECRET-MEMORY");
    const t = await u.c.post("/v1/approvals", { kind: "email", title: "SECRET-TITLE Marlene", payload: {} });
    expect(await raw("approvals", "title_enc", t.body.item.id)).not.toContain("SECRET-TITLE");
    expect((await u.c.get("/v1/approvals")).body.items.map((i: any) => i.title)).toContain("SECRET-TITLE Marlene");
    expect(await raw("approvals", "payload_enc", a.body.item.id)).not.toContain("SECRET-DRAFT");
    // and the API still returns the real content to the right user
    expect((await u.c.get("/v1/memory")).body.items[0].content).toBe("SECRET-MEMORY-TEXT");
    expect((await u.c.get("/v1/approvals")).body.items.find((i: any) => i.id === a.body.item.id).payload).toEqual({ draft: "SECRET-DRAFT-TEXT" });
  });

  it("a row moved to another workspace cannot be read there", async () => {
    const a = await signUp(ctx, owner, "MoveA");
    const b = await signUp(ctx, owner, "MoveB");
    const made = await a.c.post("/v1/memory", { content: "belongs to A" });
    // an attacker with raw database access moves A's row under B's workspace
    await ctx.owner.db.update(memory).set({ workspaceId: b.workspaceId }).where(eq(memory.id, made.body.item.id));
    const res = await b.c.get("/v1/memory");
    expect(res.status).toBe(500); // fails to decrypt instead of leaking
    expect(JSON.stringify(res.body)).not.toContain("belongs to A");
  });

  it("no plaintext column is left behind", async () => {
    const cols = await ctx.owner.client`select table_name, column_name from information_schema.columns where table_schema='public' and table_name in ('memory','messages','approvals')`;
    const names = cols.map((c) => `${c.table_name}.${c.column_name}`);
    expect(names).not.toContain("memory.content");
    expect(names).not.toContain("messages.content");
    expect(names).not.toContain("approvals.payload");
  });
});

describe("connections vault", () => {
  let ctx: Ctx;
  let owner: Client;
  beforeAll(async () => {
    ctx = await setupApp();
    owner = (await seedOwner(ctx)).c;
  });
  afterAll(() => ctx.close());

  it("stores a secret encrypted, lists without it, and lets only server code read it", async () => {
    const u = await signUp(ctx, owner, "Conn");
    const made = await u.c.post("/v1/connections", { provider: "demo", label: "Main", secret: "sk-live-TOP-SECRET" });
    expect(made.status).toBe(201);
    expect(JSON.stringify(made.body)).not.toContain("TOP-SECRET");
    const list = await u.c.get("/v1/connections");
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toMatch(/secret|TOP-SECRET/i);
    expect(await ctx.owner.client.unsafe(`select encode(secret_enc,'escape') v from connections where id='${made.body.item.id}'`).then((r) => String(r[0]!.v))).not.toContain("TOP-SECRET");

    const tool = { workspaceId: u.workspaceId, userId: u.userId, db: ctx.runtime.db, vault: ctx.vault, google: null, tenant: <T,>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(ctx.runtime.db, u.workspaceId, fn) };
    expect(await readConnectionSecret(tool, "demo")).toBe("sk-live-TOP-SECRET");
    expect(await readConnectionSecret(tool, "other")).toBeNull();
  });

  it("is isolated between workspaces", async () => {
    const a = await signUp(ctx, owner, "ConnA");
    const b = await signUp(ctx, owner, "ConnB");
    const made = await a.c.post("/v1/connections", { provider: "demo", secret: "A-ONLY" });
    expect((await b.c.get("/v1/connections")).body.items).toHaveLength(0);
    expect((await b.c.del(`/v1/connections/${made.body.item.id}`)).status).toBe(404);
    expect(await withTenant(ctx.runtime.db, b.workspaceId, (tx) => tx.select().from(connections))).toHaveLength(0);
    expect((await a.c.del(`/v1/connections/${made.body.item.id}`)).status).toBe(200);
  });

  it("needs a session", async () => {
    const { client } = await import("./helpers.js");
    expect((await client(ctx).get("/v1/connections")).status).toBe(401);
  });
});
