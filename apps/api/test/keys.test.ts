import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LiveModel } from "../src/brain/model.js";
import { ApiKeys, KEY_DEFS } from "../src/lib/api-keys.js";
import { auditLog, serverSecrets } from "../src/db/schema.js";
import { loadApiKeys } from "../src/lib/server-secrets.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

const SECRET = "sk-test-super-secret-key-12345";
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// What the providers say. Tests change this to play "good key", "bad key" and "provider down".
let verdict: () => Promise<Response> = async () => json(200, { data: [] });
let asked: { url: string; headers: Record<string, string> }[] = [];
const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = String(url);
  if (u.endsWith("/v1/speech-to-text")) return json(200, { text: "spoken words" });
  asked.push({ url: u, headers: (init?.headers ?? {}) as Record<string, string> });
  return verdict();
}) as typeof fetch;

let ctx: Ctx;
let owner: Client;
beforeAll(async () => {
  ctx = await setupApp(undefined, undefined, {}, undefined, null, undefined, fakeFetch);
  owner = (await seedOwner(ctx)).c;
});
afterAll(() => ctx.close());

const row = (body: any, id: string) => body.keys.find((k: any) => k.id === id);

describe("API keys in the Owner tab", () => {
  it("lists every known key with what it is for, and says which are missing", async () => {
    const r = await owner.get("/v1/admin/keys");
    expect(r.status).toBe(200);
    expect(r.body.keys.map((k: any) => k.id)).toEqual(KEY_DEFS.map((d) => d.id));
    const a = row(r.body, "anthropic");
    expect(a).toMatchObject({ needed: "required", source: "none" });
    expect(a.why.length).toBeGreaterThan(10);
    expect(a.steps.length).toBeGreaterThan(1);
    expect(a.url).toMatch(/^https:\/\//);
    expect(row(r.body, "elevenlabs")).toMatchObject({ needed: "optional", source: "none" });
    expect((await owner.get("/v1/settings")).body).toMatchObject({ demo: true, voiceTyping: false });
  });

  it("only the owner can see or change keys", async () => {
    const u = await signUp(ctx, owner, "Member");
    expect((await u.c.get("/v1/admin/keys")).status).toBe(403);
    expect((await u.c.req("PUT", "/v1/admin/keys/anthropic", { value: SECRET })).status).toBe(403);
    expect((await u.c.req("DELETE", "/v1/admin/keys/anthropic")).status).toBe(403);
  });

  it("checks the key with its provider, saves it, and starts using it without a restart", async () => {
    asked = [];
    const put = await owner.req("PUT", "/v1/admin/keys/elevenlabs", { value: SECRET });
    expect(put.status).toBe(200);
    expect(row(put.body, "elevenlabs").source).toBe("app");
    // it was checked against the provider's own address, with the key in the provider's header
    expect(asked[0]!.url).toBe("https://api.elevenlabs.io/v1/models");
    expect(asked[0]!.headers["xi-api-key"]).toBe(SECRET);
    // voice typing is on straight away, and recordings use the saved key
    expect((await owner.get("/v1/settings")).body.voiceTyping).toBe(true);
    const rec = await owner.req("POST", "/v1/transcribe", Buffer.alloc(5000, 1) as never, { "content-type": "audio/webm" });
    expect(rec.status).toBe(200);
    expect(rec.body).toEqual({ text: "spoken words" });
  });

  it("never gives a key back, and stores it encrypted", async () => {
    const all = JSON.stringify([(await owner.get("/v1/admin/keys")).body, (await owner.get("/v1/settings")).body, (await owner.get("/v1/me")).body]);
    expect(all).not.toContain(SECRET);
    const [stored] = await ctx.owner.db.select().from(serverSecrets).where(eq(serverSecrets.name, "key:elevenlabs"));
    expect(stored).toBeTruthy();
    expect(Buffer.from(stored!.secretEnc).toString("utf8")).not.toContain(SECRET);
    // the audit log says which key changed, not what it was
    const audits = await ctx.owner.db.select().from(auditLog).where(eq(auditLog.action, "key.set"));
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(SECRET);
    expect(JSON.stringify(audits)).toContain("elevenlabs");
  });

  it("survives a restart: a new process loads the saved key", async () => {
    const fresh = new ApiKeys({});
    fresh.loadSaved(await loadApiKeys(ctx.runtime.db, ctx.vault));
    expect(fresh.get("elevenlabs")).toBe(SECRET);
    expect(fresh.source("elevenlabs")).toBe("app");
  });

  it("refuses a key the provider rejects, and saves nothing", async () => {
    verdict = async () => json(401, { error: { type: "authentication_error" } });
    const bad = await owner.req("PUT", "/v1/admin/keys/anthropic", { value: "sk-ant-wrong-wrong-wrong" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_key");
    expect(bad.body.message).toMatch(/Anthropic didn't accept/);
    expect(row((await owner.get("/v1/admin/keys")).body, "anthropic").source).toBe("none");
    verdict = async () => json(200);
  });

  it("says so when the provider can't be reached, and saves nothing", async () => {
    verdict = async () => json(503);
    const down = await owner.req("PUT", "/v1/admin/keys/anthropic", { value: "sk-ant-whatever-key-value" });
    expect(down.status).toBe(502);
    expect(down.body.error).toBe("key_unreachable");
    expect(row((await owner.get("/v1/admin/keys")).body, "anthropic").source).toBe("none");
    verdict = async () => json(200);
  });

  it("a key limited to certain permissions still counts as real", async () => {
    verdict = async () => json(401, { detail: { status: "missing_permissions", message: "needs models_read" } });
    expect((await owner.req("PUT", "/v1/admin/keys/elevenlabs", { value: "scoped-key-value-123" })).status).toBe(200);
    verdict = async () => json(200);
  });

  it("rejects junk before asking anyone", async () => {
    asked = [];
    expect((await owner.req("PUT", "/v1/admin/keys/anthropic", { value: "has a space in it" })).status).toBe(400);
    expect((await owner.req("PUT", "/v1/admin/keys/anthropic", { value: "short" })).status).toBe(400);
    expect((await owner.req("PUT", "/v1/admin/keys/not-a-real-key", { value: SECRET })).status).toBe(404);
    expect(asked).toHaveLength(0);
  });

  it("removing a key turns the feature off again", async () => {
    const del = await owner.req("DELETE", "/v1/admin/keys/elevenlabs");
    expect(del.status).toBe(200);
    expect(row(del.body, "elevenlabs").source).toBe("none");
    expect((await owner.get("/v1/settings")).body.voiceTyping).toBe(false);
    expect((await owner.req("POST", "/v1/transcribe", Buffer.alloc(5000, 1) as never, { "content-type": "audio/webm" })).status).toBe(503);
    expect(await ctx.owner.db.select().from(serverSecrets).where(eq(serverSecrets.name, "key:elevenlabs"))).toHaveLength(0);
  });

  it("saving the Anthropic key takes Danny out of demo mode", async () => {
    expect((await owner.get("/v1/settings")).body.demo).toBe(true);
    expect((await owner.req("PUT", "/v1/admin/keys/anthropic", { value: SECRET })).status).toBe(200);
    expect((await owner.get("/v1/settings")).body.demo).toBe(false);
    await owner.req("DELETE", "/v1/admin/keys/anthropic");
    expect((await owner.get("/v1/settings")).body.demo).toBe(true);
  });
});

describe("keys set in the server's .env", () => {
  it("win, show as set on the server, and can't be changed in the app", async () => {
    const envCtx = await setupApp(undefined, undefined, { ANTHROPIC_API_KEY: "from-env-key-12345" }, undefined, null, undefined, fakeFetch);
    try {
      const o = (await seedOwner(envCtx)).c;
      expect(row((await o.get("/v1/admin/keys")).body, "anthropic").source).toBe("env");
      expect((await o.get("/v1/settings")).body.demo).toBe(false);
      const put = await o.req("PUT", "/v1/admin/keys/anthropic", { value: SECRET });
      expect(put.status).toBe(409);
      expect(put.body.error).toBe("set_by_environment");
      expect((await o.req("DELETE", "/v1/admin/keys/anthropic")).status).toBe(409);
    } finally {
      await envCtx.close();
    }
  });
});

describe("LiveModel", () => {
  it("answers in demo mode with no key and notices a key the moment it is set", async () => {
    const keys = new ApiKeys({});
    const model = new LiveModel(keys);
    let said = "";
    await model.complete({ model: "m", system: "", messages: [], tools: [], maxTokens: 10 }, (t) => (said += t));
    expect(said).toMatch(/Demo mode/);
    expect(model.search).toBeUndefined();
    keys.setSaved("anthropic", "sk-ant-now-set-12345");
    expect(typeof model.search).toBe("function"); // the real model can search
    keys.setSaved("anthropic", null);
    expect(model.search).toBeUndefined();
  });
});
