import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fetchPage, isPublicAddress, parseHead, previewUrl, type Fetched, type FetchPage } from "../src/lib/preview.js";
import { seedOwner, setupApp, signUp, type Client, type Ctx } from "./helpers.js";

const page = (body: string, extra: Partial<Fetched> = {}): Fetched => ({ status: 200, contentType: "text/html; charset=utf-8", body, ...extra });
const html = `<html><head><title>Fallback &amp; title</title>
<meta property="og:title" content="Entry Level Sales Rep, Toronto">
<meta property="og:site_name" content="Indeed">
<meta name="description" content="Plain description">
<meta property="og:description" content='Sales role &quot;downtown&quot; &#39;now&#39;.'></head><body>x</body></html>`;

describe("which addresses count as public", () => {
  it("refuses everything that is not on the open internet", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.5", "172.31.255.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fd00::1", "fc00::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "not-an-ip", ""]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
  it("allows ordinary public addresses", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.255.255", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) expect(isPublicAddress(ip), ip).toBe(true);
  });
  it("the connection itself refuses a name that resolves to this machine", async () => {
    await expect(fetchPage(new URL("https://localhost:9/"))).rejects.toThrow();
  });
});

describe("reading a page", () => {
  it("takes the social title, site and description, decodes entities, and falls back sensibly", () => {
    expect(parseHead(html, new URL("https://www.indeed.com/x"))).toEqual({ site: "Indeed", title: "Entry Level Sales Rep, Toronto", description: `Sales role "downtown" 'now'.` });
    expect(parseHead("<title>Just a title</title>", new URL("https://www.example.org/a"))).toEqual({ site: "example.org", title: "Just a title", description: "" });
    expect(parseHead("<p>nothing</p>", new URL("https://x.co/")).title).toBe("");
  });
  it("never runs or keeps anything from the page: scripts in a title are just text", () => {
    const p = parseHead(`<title><script>alert(1)</script>Hi</title>`, new URL("https://x.co/"));
    expect(p.title).toContain("Hi"); // it is plain text, and the app draws it as text only
  });
});

describe("what it will fetch", () => {
  const calls: string[] = [];
  const ok: FetchPage = async (u) => (calls.push(u.href), page(html));

  it("only https pages on a name, with no login in the address and no odd port", async () => {
    calls.length = 0;
    for (const bad of ["http://example.com/", "https://user:pw@example.com/", "https://example.com:8443/", "https://127.0.0.1/", "https://[::1]/", "https://10.0.0.1/admin", "ftp://x.co/", "javascript:alert(1)", "nope", ""]) {
      expect(await previewUrl(bad, ok), bad).toBeNull();
    }
    expect(calls).toEqual([]);
    expect(await previewUrl("https://www.indeed.com/jobs", ok, 1)).toMatchObject({ site: "Indeed", title: "Entry Level Sales Rep, Toronto" });
  });

  it("follows a few redirects, re-checking each one, and gives up on a redirect to a private address or a downgrade", async () => {
    const seen: string[] = [];
    const hop: FetchPage = async (u) => {
      seen.push(u.href);
      if (u.pathname === "/a") return { status: 302, location: "/b", contentType: "", body: "" };
      if (u.pathname === "/b") return page(html);
      if (u.pathname === "/evil") return { status: 302, location: "https://169.254.169.254/latest/meta-data", contentType: "", body: "" };
      if (u.pathname === "/downgrade") return { status: 302, location: "http://example.com/", contentType: "", body: "" };
      if (u.pathname === "/loop") return { status: 302, location: "/loop", contentType: "", body: "" };
      return page("");
    };
    expect(await previewUrl("https://redir.example/a", hop, 1)).toMatchObject({ url: "https://redir.example/b" });
    seen.length = 0;
    expect(await previewUrl("https://redir.example/evil", hop, 1)).toBeNull();
    expect(seen).toEqual(["https://redir.example/evil"]); // the metadata address was never requested
    expect(await previewUrl("https://redir.example/downgrade", hop, 1)).toBeNull();
    seen.length = 0;
    expect(await previewUrl("https://redir.example/loop", hop, 1)).toBeNull();
    expect(seen.length).toBeLessThanOrEqual(4);
  });

  it("ignores things that aren't web pages, errors, and failures, and never throws", async () => {
    expect(await previewUrl("https://x.example/img", async () => page("PNG", { contentType: "image/png" }), 1)).toBeNull();
    expect(await previewUrl("https://x.example/404", async () => page(html, { status: 404 }), 1)).toBeNull();
    expect(await previewUrl("https://x.example/boom", async () => { throw new Error("blocked address"); }, 1)).toBeNull();
    expect(await previewUrl("https://x.example/empty", async () => page("<p>no title</p>"), 1)).toBeNull();
  });

  it("remembers an answer for an hour, including a miss", async () => {
    let n = 0;
    const f: FetchPage = async () => (n++, page(html));
    await previewUrl("https://cache.example/p", f, 1000);
    await previewUrl("https://cache.example/p", f, 1000 + 59 * 60_000);
    expect(n).toBe(1);
    await previewUrl("https://cache.example/p", f, 1000 + 61 * 60_000);
    expect(n).toBe(2);
  });
});

describe("the preview route", () => {
  let ctx: Ctx;
  let owner: Client;
  beforeAll(async () => {
    ctx = await setupApp(undefined, undefined, {}, undefined, null, undefined, undefined, async (u) => (u.hostname === "good.example" ? page(html) : page("", { status: 404 })));
    owner = (await seedOwner(ctx)).c;
  });
  afterAll(() => ctx.close());

  it("needs a signed-in person, and returns a preview or a plain 404", async () => {
    expect((await ctx.app.inject({ method: "GET", url: "/v1/preview?url=https://good.example/a", remoteAddress: "10.9.9.9", headers: { origin: "http://app.test" } })).statusCode).toBe(401);
    const u = await signUp(ctx, owner, "Pv");
    const r = await u.c.get("/v1/preview?url=" + encodeURIComponent("https://good.example/a"));
    expect(r.body.preview).toMatchObject({ site: "Indeed", title: "Entry Level Sales Rep, Toronto" });
    expect((await u.c.get("/v1/preview?url=" + encodeURIComponent("https://other.example/a"))).status).toBe(404);
    expect((await u.c.get("/v1/preview?url=" + encodeURIComponent("http://good.example/a"))).status).toBe(404);
    expect((await u.c.get("/v1/preview")).status).toBe(400);
  });
});
