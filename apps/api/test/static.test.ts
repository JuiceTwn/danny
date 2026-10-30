import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupApp, type Ctx } from "./helpers.js";

let ctx: Ctx;
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "danny-web-"));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Danny</title>");
  writeFileSync(join(dir, "sw.js"), "// sw");
  writeFileSync(join(dir, "assets", "index-abc123.js"), "console.log(1)");
  ctx = await setupApp(undefined, undefined, { WEB_DIR: dir });
});
afterAll(() => ctx.close());

const get = (url: string) => ctx.app.inject({ method: "GET", url, remoteAddress: "10.9.9.9" });

describe("serving the web app", () => {
  it("serves the app at / with a strict content security policy", async () => {
    const res = await get("/");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Danny</title>");
    const csp = String(res.headers["content-security-policy"]);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("gives app links the app, so /accept?token=... opens the signup screen", async () => {
    const res = await get("/accept?token=abc");
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("<title>Danny</title>");
    expect((await get("/anything/else")).statusCode).toBe(200);
  });

  it("caches hashed assets for a year and never caches the shell or service worker", async () => {
    expect(String((await get("/assets/index-abc123.js")).headers["cache-control"])).toContain("immutable");
    expect(String((await get("/sw.js")).headers["cache-control"])).toContain("no-cache");
    expect(String((await get("/")).headers["cache-control"])).toContain("no-cache");
  });

  it("keeps unknown API paths and missing files as 404, not the app", async () => {
    const api = await get("/v1/nope");
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: "not_found" });
    expect((await get("/missing.png")).statusCode).toBe(404);
  });

  it("does not count static files against the API rate limit", async () => {
    for (let i = 0; i < 320; i++) await get("/assets/index-abc123.js");
    expect((await get("/")).statusCode).toBe(200);
  });

  it("still protects the API", async () => {
    expect((await get("/v1/me")).statusCode).toBe(401);
  });
});
