// The small set of formatting Danny writes: **bold**, [name](https://link), bare https links, "- " lists, blank lines between
// sections. Anything else is shown as plain text. This builds data, never HTML, so nothing a message says can inject markup:
// the chat draws each piece as a text node or an <a> whose address has been checked.

export type Inline = { t: "text"; v: string } | { t: "bold"; v: string } | { t: "link"; v: string; href: string };
export type Block = { t: "p"; lines: Inline[][] } | { t: "ul"; items: Inline[][] };

const safeHref = (raw: string) => {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
};

const host = (href: string) => new URL(href).hostname.replace(/^www\./, "");

// [name](url) | **bold** | https://bare.url
const TOKEN = /\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)|\*\*(.+?)\*\*|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

export function inline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index! > last) out.push({ t: "text", v: text.slice(last, m.index) });
    if (m[2]) {
      const href = safeHref(m[2]);
      out.push(href ? { t: "link", v: m[1]!, href } : { t: "text", v: m[0] });
    } else if (m[3]) {
      out.push({ t: "bold", v: m[3] });
    } else if (m[4]) {
      const href = safeHref(m[4]);
      out.push(href ? { t: "link", v: host(href), href } : { t: "text", v: m[0] }); // a long bare address shows as just the site name
    }
    last = m.index! + m[0].length;
  }
  if (last < text.length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

/** Text to blocks: runs of "- " lines become one list, other lines stay together as a paragraph, blank lines separate blocks. */
export function blocks(text: string): Block[] {
  const out: Block[] = [];
  for (const raw of text.replace(/\r/g, "").split(/\n{2,}/)) {
    let para: Inline[][] = [];
    let list: Inline[][] = [];
    const flush = () => {
      if (para.length) out.push({ t: "p", lines: para });
      if (list.length) out.push({ t: "ul", items: list });
      para = [];
      list = [];
    };
    for (const line of raw.split("\n")) {
      const item = line.match(/^\s*[-•]\s+(.*)$/);
      if (item) {
        if (para.length) flush();
        list.push(inline(item[1]!));
      } else if (line.trim()) {
        if (list.length) flush();
        para.push(inline(line));
      }
    }
    flush();
  }
  return out;
}
