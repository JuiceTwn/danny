/**
 * How everything Danny writes should look. The app shows a small, safe set of formatting (see web/src/lib/rich.ts):
 * bold, dash lists, blank lines between sections, and [name](link). Nothing else is drawn, so nothing else is asked for.
 */
export const FORMAT =
  "Formatting: the app shows light formatting. Use **bold** for a label or the key fact. Make lists with a dash at the start of each line, one item per line. " +
  "Put a blank line between sections. Link with [short name](https://…) and never paste a long bare URL. " +
  "No # headings, tables, code blocks, numbered lists or emoji. Keep every line short enough to read on a phone.";

/** Anything the model slips in that the app does not draw is removed, so it never shows as stray symbols. */
export const tidy = (s: string) =>
  s
    .replace(/^#{1,6}\s+(.+)$/gm, "**$1**") // a heading becomes a bold label
    .replace(/__(.+?)__/gs, "**$1**")
    .replace(/^\s*[*+•]\s+/gm, "- ")
    .replace(/^\s*\d+[.)]\s+/gm, "- ")
    .replace(/```[a-z]*\n?/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*\|?[-: |]{3,}\|?\s*$/gm, "") // table rules
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** Cut a reply that ran out of room back to its last complete line or sentence, so it never ends mid-word. */
export function cutToComplete(s: string) {
  const t = s.trimEnd();
  const line = t.lastIndexOf("\n");
  const sentence = Math.max(t.lastIndexOf(". "), t.lastIndexOf("! "), t.lastIndexOf("? "));
  const endsClean = /[.!?)\]]$/.test(t);
  if (endsClean) return t;
  const cut = Math.max(line, sentence + 1);
  return cut > t.length * 0.4 ? t.slice(0, cut).trimEnd() : t;
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/** At most four sources, one per website, as links: "- [Indeed](https://…)". Nothing when there are none. */
export function sourceLinks(sources: { title: string; url: string }[], max = 4) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of sources) {
    const h = host(s.url);
    if (!h || seen.has(h)) continue;
    seen.add(h);
    out.push(`- [${h}](${s.url})`);
    if (out.length >= max) break;
  }
  return out.length ? `\n\n**Sources**\n${out.join("\n")}` : "";
}

/** For a phone notification, which shows no formatting: bold marks, list dashes and link addresses are dropped. */
export const unmark = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\(https?:[^)]*\)/g, "$1")
    .replace(/\*\*(.+?)\*\*/gs, "$1")
    .replace(/^\s*-\s+/gm, "")
    .trim();
