// Folds the preview build into one self-contained page body (title, style, root div, inline module script)
// at dist-preview/danny-preview.html, ready to host as a single file. Run via: npm run build:preview -w @danny/web
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const dir = fileURLToPath(new URL("../dist-preview/assets", import.meta.url));
const read = (ext) => readFileSync(join(dir, readdirSync(dir).find((f) => f.endsWith(ext))), "utf8");
const css = read(".css");
const js = read(".js").replaceAll("</script", "<\\/script");
const out = fileURLToPath(new URL("../dist-preview/danny-preview.html", import.meta.url));
writeFileSync(out, `<title>Danny Preview</title>\n<style>${css}</style>\n<div id="app"></div>\n<script type="module">${js}</script>\n`);
console.log(`wrote ${out} (${Math.round((css.length + js.length) / 1024)} KB)`);
