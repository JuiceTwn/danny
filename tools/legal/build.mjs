#!/usr/bin/env node
// Builds site/privacy.html and site/terms.html from tools/legal/data.mjs. `--check` fails if they are out of date.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { company as c, collected, connections, processors } from "./data.mjs";

const site = join(dirname(fileURLToPath(import.meta.url)), "../../site");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const mail = `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>`;
const live = connections.filter((x) => x.status !== "planned");
const planned = connections.filter((x) => x.status === "planned");

const page = (file, title, desc, body) => ({
  file,
  html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — ${esc(c.productName)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="stylesheet" href="base.css">
<style>
.doc{max-width:760px;margin:0 auto;padding:clamp(24px,5vw,56px) clamp(20px,5vw,40px) 96px}
.doc header{display:flex;justify-content:space-between;align-items:center;margin-bottom:clamp(40px,8vh,80px)}
.doc h1{font-size:clamp(3rem,9vw,6rem);margin-bottom:12px}
.doc h2{font:600 clamp(1.5rem,3vw,2rem)/1.1 var(--display);text-transform:uppercase;letter-spacing:.01em;margin:56px 0 14px;padding-top:24px;border-top:1px solid var(--line)}
.doc p,.doc li{color:#c9d0c8;margin:0 0 14px}
.doc ul{list-style:disc;padding-left:1.25rem}
.doc a{text-decoration-color:var(--run);text-underline-offset:3px}
.doc a:hover{color:var(--run)}
.draft{border:2px solid var(--need);color:var(--need);padding:14px 16px;margin:0 0 32px;font:500 .8125rem/1.5 var(--mono);text-transform:uppercase;letter-spacing:.04em}
.doc dl{margin:0}.doc dt{font:500 .8125rem/1.3 var(--mono);text-transform:uppercase;letter-spacing:.06em;color:var(--run);margin-top:20px}.doc dd{margin:4px 0 0;color:#c9d0c8}
.doc table{width:100%;border-collapse:collapse;margin:0 0 14px}.doc th,.doc td{text-align:left;vertical-align:top;padding:12px 12px 12px 0;border-top:1px solid var(--line);color:#c9d0c8;font-size:1rem}.doc th{font:500 .8125rem/1.3 var(--mono);text-transform:uppercase;color:var(--muted)}
footer{max-width:760px;margin:0 auto;padding:28px clamp(20px,5vw,40px) 48px;display:flex;flex-wrap:wrap;gap:16px;border-top:1px solid var(--line)}
footer a{text-underline-offset:3px}
</style>
</head>
<body>
<main class="doc">
<header><a class="brand" href="/">${esc(c.productName)}</a><a class="mono" href="/">Back to home</a></header>
${c.draft ? `<p class="draft">Draft. Not yet reviewed by a lawyer. Do not rely on it until this banner is gone.</p>` : ""}
<h1 class="display">${esc(title)}</h1>
<p class="mono">Last updated ${esc(c.updated)}</p>
${body}
</main>
<footer><span class="mono">${esc(c.productName)} · ${esc(c.legalName)}</span><a class="mono" href="privacy.html">Privacy</a><a class="mono" href="terms.html">Terms</a><a class="mono" href="mailto:${esc(c.email)}">${esc(c.email)}</a></footer>
</body>
</html>
`,
});

const privacy = `
<p>${esc(c.productName)} is a personal assistant run by ${esc(c.legalName)} ("we", "us"). This explains what we collect, why, who sees it, and what control you have. We follow Canada's privacy law (PIPEDA) and, where it applies, Ontario law.</p>

<h2>What we collect</h2>
<dl>${collected.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
<p>We don't sell your information. We don't use your conversations, memory or connected-account content to advertise to you.</p>

<h2>Connections</h2>
<p>${esc(c.productName)} only reaches a service after you connect it, and you can disconnect it at any time. Disconnecting deletes the stored access.</p>
<ul>${live.map((x) => `<li id="${esc(x.id)}"><strong>${esc(x.name)}.</strong> ${esc(x.access)} Access: ${esc(x.scopes)}. ${esc(x.shares)} ${esc(x.revoke)}</li>`).join("")}</ul>
${planned.length ? `<p>Coming later: ${planned.map((x) => esc(x.name)).join(", ")}. This page will be updated before any of them goes live.</p>` : ""}
<p>${esc(c.productName)} asks before it sends a message, spends money or changes something. You approve each action.</p>

<h2>Google user data</h2>
<p>${esc(c.productName)}'s use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy#limited-use">Google API Services User Data Policy</a>, including the Limited Use requirements. We use your Gmail and Calendar data only to provide the features you asked for. We don't use it for advertising, we don't sell it, and people at ${esc(c.legalName)} don't read it except with your permission, to investigate abuse, or where the law requires.</p>

<h2>Who we share with</h2>
<p>These companies handle information for us or receive it when a feature is used.</p>
<table><thead><tr><th>Company</th><th>Why</th><th>What they get</th><th>Where</th></tr></thead><tbody>
${processors.map((p) => `<tr><td>${p.url ? `<a href="${esc(p.url)}" rel="noopener">${esc(p.name)}</a>` : esc(p.name)}</td><td>${esc(p.why)}</td><td>${esc(p.data)}</td><td>${esc(p.country)}</td></tr>`).join("")}
</tbody></table>
<p>Some of these are outside Canada, so your information may be handled under foreign law. We may also disclose information if the law requires it.</p>

<h2>How we protect it</h2>
<p>Conversations, memory, tokens and similar content are encrypted in our database. Passwords are hashed. Each person's data is separated from everyone else's. Servers are at ${esc(c.hosting)}. No system is perfectly secure. If a breach creates a real risk of serious harm to you, we will tell you and the Privacy Commissioner of Canada.</p>

<h2>How long we keep it</h2>
<p>We keep your information while your account is open. You can delete any memory yourself at any time and it is removed, not hidden. If you ask us to close your account, we delete your data, except what we must keep by law or for backups, which expire on a rolling schedule. Waitlist emails are kept until you ask us to remove them or we've invited you.</p>

<h2>Waitlist and email</h2>
<p>If you join the list you agree to receive email from us about ${esc(c.productName)}. You can withdraw consent at any time with the unsubscribe link in any email or by writing to ${mail}. Our mailing address is ${esc(c.address)}.</p>

<h2>Cookies</h2>
<p>This website sets no tracking or advertising cookies. The app uses a sign-in cookie that is needed to keep you logged in.</p>

<h2>Your rights</h2>
<p>You can ask to see, correct, export or delete your personal information, or withdraw consent, by writing to ${mail}. We'll answer within 30 days. If you're not satisfied you can complain to the Office of the Privacy Commissioner of Canada.</p>

<h2>Children</h2>
<p>${esc(c.productName)} is not for anyone under 18.</p>

<h2>Changes</h2>
<p>If we change this policy in a way that matters, we'll update the date above and tell account holders.</p>

<h2>Contact</h2>
<p>Privacy questions go to ${esc(c.privacyOfficer)} at ${mail}.</p>
`;

const terms = `
<p>These terms are an agreement between you and ${esc(c.legalName)} ("we", "us") for using ${esc(c.productName)}. By using it you agree to them and to our <a href="privacy.html">Privacy Policy</a>.</p>

<h2>What ${esc(c.productName)} is</h2>
<p>${esc(c.productName)} is an AI assistant. It reads, drafts, reminds and, after you approve, acts on your behalf through the services you connect. It is in early access and features change.</p>

<h2>It can be wrong</h2>
<p>AI makes mistakes. ${esc(c.productName)} may misread something, give wrong information or draft something you didn't mean. That's why it asks before sending a message, spending money or changing something. You are responsible for checking and approving what it does. Don't rely on it for medical, legal, financial or safety decisions.</p>

<h2>Your account</h2>
<p>You must be 18 or older. Keep your sign-in private and tell us if you think someone else has it. You're responsible for what happens through your account, including actions you approve.</p>

<h2>Connected services</h2>
<p>When you connect a service (${live.map((x) => esc(x.name)).join(", ")}), you confirm you're allowed to, and that you'll follow that service's own terms. Disconnect them any time. We aren't responsible for those services.</p>

<h2>Acceptable use</h2>
<p>Don't use ${esc(c.productName)} to break the law, send spam or harassment, impersonate someone, attack or probe our systems, or break the rules of a connected service. We may suspend an account that does.</p>

<h2>Payment</h2>
<p>Early access may be free or limited. If we charge, we'll tell you the price before you pay, and you'll be able to cancel. Usage caps may apply.</p>

<h2>Your content</h2>
<p>Your messages and files stay yours. You give us permission to process them as needed to run the service for you, as described in the Privacy Policy.</p>

<h2>No guarantee</h2>
<p>${esc(c.productName)} is provided "as is" and "as available". We don't promise it will always work, be accurate, or be free of interruptions.</p>

<h2>Limit of liability</h2>
<p>To the fullest extent the law allows, we aren't liable for indirect or consequential losses, lost profits or lost data, and our total liability for any claim is limited to what you paid us in the 12 months before it, or $100 CAD if you paid nothing. Some rights can't be limited by law, and nothing here limits those.</p>

<h2>Ending</h2>
<p>You can stop using ${esc(c.productName)} and ask us to delete your account at any time. We can suspend or end access if you break these terms or if we shut the service down.</p>

<h2>Changes</h2>
<p>We may update these terms. If a change matters, we'll update the date above and tell account holders. Using ${esc(c.productName)} after that means you accept it.</p>

<h2>Law</h2>
<p>These terms are governed by ${esc(c.governingLaw)}, and disputes go to the courts of Ontario.</p>

<h2>Contact</h2>
<p>${esc(c.legalName)} · ${esc(c.address)} · ${mail}</p>
`;

const pages = [
  page("privacy.html", "Privacy Policy", `How ${c.productName} handles your information.`, privacy),
  page("terms.html", "Terms of Service", `The terms for using ${c.productName}.`, terms),
];

const check = process.argv.includes("--check");
let stale = false;
for (const p of pages) {
  const path = join(site, p.file);
  if (check) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== p.html) { console.error(`${p.file} is out of date. Run: node tools/legal/build.mjs`); stale = true; }
  } else writeFileSync(path, p.html);
}
if (check) process.exit(stale ? 1 : 0);
const left = pages.flatMap((p) => p.html.match(/\[[A-Z][^\]]*\]/g) ?? []);
if (left.length) console.warn(`Built. Still to fill in: ${[...new Set(left)].join(", ")}`);
else console.log("Built.");
