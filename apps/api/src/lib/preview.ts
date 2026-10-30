import { lookup as dnsLookup } from "node:dns";
import { request } from "node:https";
import { isIP } from "node:net";

/**
 * A short preview of a web page (title, site, one sentence) for links in chat. The server fetches the page, so this is built so that it
 * can never be pointed at the server's own network: https only, every address checked at connection time (a name that resolves to a
 * private address is refused, and so is one that changes its answer between lookups), redirects re-checked, small and quick.
 */
export type Preview = { url: string; site: string; title: string; description: string };

/** True only for addresses on the public internet. */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 || // this network, private, loopback, multicast and reserved
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, including cloud metadata addresses
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) // documentation and benchmarking
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === "::" || x === "::1") return false;
    const mapped = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // an IPv4 address inside IPv6
    if (mapped) return isPublicAddress(mapped[1]!);
    return !(x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe8") || x.startsWith("fe9") || x.startsWith("fea") || x.startsWith("feb") || x.startsWith("ff") || x.startsWith("2001:db8"));
  }
  return false;
}

const MAX_BYTES = 200_000;
const TIMEOUT_MS = 6_000;

export type Fetched = { status: number; location?: string; contentType: string; body: string };
export type FetchPage = (url: URL) => Promise<Fetched>;

/** One request, with the address check done by the connection itself. */
export const fetchPage: FetchPage = (url) =>
  new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        timeout: TIMEOUT_MS,
        headers: { "user-agent": "Mozilla/5.0 (compatible; DannyPreview/1.0)", accept: "text/html,application/xhtml+xml", "accept-language": "en" },
        // Every address the name resolves to must be public, or the connection is refused. This runs at connect time, so it also
        // stops a name that answers "public" to a check and "private" to the real connection.
        lookup: (host, opts, cb) =>
          dnsLookup(host, { ...opts, all: true }, (err, addrs) => {
            if (err) return (cb as (e: Error) => void)(err);
            const list = addrs as { address: string; family: number }[];
            if (!list.length || !list.every((a) => isPublicAddress(a.address))) return (cb as (e: Error) => void)(new Error("blocked address"));
            if (opts.all) return (cb as (e: null, a: unknown) => void)(null, list);
            (cb as (e: null, a: string, f: number) => void)(null, list[0]!.address, list[0]!.family);
          }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BYTES) {
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        const finish = () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, contentType: String(res.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString("utf8") });
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
const decode = (s: string) => s.replace(/&(#?\w+);/g, (m, e: string) => ENT[e] ?? (/^#\d+$/.test(e) ? String.fromCodePoint(Number(e.slice(1))) : m));
const clean = (s: string | undefined, n: number) => (s ? decode(s).replace(/\s+/g, " ").trim().slice(0, n) : "");

/** The title, site name and description out of a page's head. Reads text only: nothing in the page is run. */
export function parseHead(html: string, url: URL): Omit<Preview, "url"> {
  const head = html.slice(0, MAX_BYTES);
  const meta = (key: string) => {
    for (const m of head.matchAll(/<meta\s+[^>]*>/gi)) {
      const tag = m[0];
      const name = tag.match(/(?:property|name)\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
      if (name === key) return tag.match(/content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i)?.slice(1).find(Boolean);
    }
    return undefined;
  };
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return {
    site: clean(meta("og:site_name"), 60) || url.hostname.replace(/^www\./, ""),
    title: clean(meta("og:title") ?? meta("twitter:title") ?? titleTag, 140),
    description: clean(meta("og:description") ?? meta("twitter:description") ?? meta("description"), 220),
  };
}

const cache = new Map<string, { at: number; value: Preview | null }>();
const TTL = 60 * 60_000;

/** A preview of the page at `raw`, or null if it can't be had. Never throws. */
export async function previewUrl(raw: string, fetcher: FetchPage = fetchPage, now = Date.now()): Promise<Preview | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return null;
  if (isIP(url.hostname.replace(/^\[|\]$/g, ""))) return null; // names only, never bare addresses
  const key = url.href;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL) return hit.value;

  let value: Preview | null = null;
  try {
    let cur = url;
    for (let hop = 0; hop < 4; hop++) {
      const r = await fetcher(cur);
      if (r.status >= 300 && r.status < 400 && r.location) {
        const next = new URL(r.location, cur);
        if (next.protocol !== "https:" || next.username || next.password || (next.port && next.port !== "443") || isIP(next.hostname.replace(/^\[|\]$/g, ""))) break;
        cur = next;
        continue;
      }
      if (r.status === 200 && /text\/html|application\/xhtml/i.test(r.contentType)) {
        const p = parseHead(r.body, cur);
        if (p.title) value = { url: cur.href, ...p };
      }
      break;
    }
  } catch {
    value = null;
  }
  if (cache.size > 300) cache.clear();
  cache.set(key, { at: now, value });
  return value;
}
