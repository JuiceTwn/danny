<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { api, ApiError } from "../lib/api";
  import { refresh } from "../lib/store.svelte";
  import { fmtDay, usd } from "../lib/router.svelte";

  type Req = { id: string; email: string; status: string; createdAt: string };
  type Use = { userId: string; email: string; todayCostUsd: number; last30DaysCostUsd: number };

  let requests = $state<Req[]>([]);
  let total = $state(0);
  let usage = $state<Use[]>([]);
  let email = $state("");
  let link = $state<{ email: string; url: string } | null>(null);
  let copied = $state(false);
  let error = $state("");

  type Ops = {
    available: boolean; busy: boolean; pending: string[];
    last: { action: string; state: string; startedAt: string; finishedAt: string | null; summary: string } | null;
    version: string | null; branch: string | null; behind: number; changes: string[]; checkedAt: string | null;
    backups: { name: string; bytes: number; at: string }[];
  };
  let ops = $state<Ops | null>(null);
  let confirmUpdate = $state(false);
  let asked = $state("");
  let reconnecting = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const WORDS: Record<string, string> = { check: "Checking for updates", backup: "Backing up", update: "Updating" };
  const kb = (b: number) => (b >= 1_048_576 ? `${(b / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
  const ago = (iso: string | null) => {
    if (!iso) return "never";
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
  };

  // While something runs, ask again every few seconds. During an update the app restarts, so a failed request is expected, not an error.
  async function loadOps() {
    try {
      ops = await api<Ops>("GET", "/v1/admin/ops");
      reconnecting = false;
    } catch {
      reconnecting = !!asked;
    }
    clearTimeout(timer);
    if (ops?.busy || reconnecting) timer = setTimeout(loadOps, 3000);
    else asked = "";
  }
  async function ask(action: "check" | "backup" | "update") {
    error = "";
    confirmUpdate = false;
    asked = action;
    try {
      await api("POST", "/v1/admin/ops", { action });
    } catch {
      error = "Couldn't start that. If this is the first time, run danny ops-install once on the server.";
      asked = "";
      return;
    }
    await loadOps();
  }
  onDestroy(() => clearTimeout(timer));


  // API keys. One box per key the server knows about, so a feature that needs a new key shows up here after the next update.
  type KeyRow = { id: string; label: string; needed: "required" | "optional"; why: string; steps: string[]; url: string; source: "none" | "app" | "env" };
  let keyRows = $state<KeyRow[]>([]);
  let drafts = $state<Record<string, string>>({});
  let keyBusy = $state("");
  let keyMsg = $state<Record<string, { ok: boolean; text: string }>>({});
  let confirmRemove = $state("");
  // Needed and missing first, then optional and missing, then the ones already set.
  const rank = (k: KeyRow) => (k.source === "none" ? (k.needed === "required" ? 0 : 1) : 2);
  const sortedKeys = $derived([...keyRows].sort((a, b) => rank(a) - rank(b)));
  const keyProblem = (e: unknown) =>
    e instanceof ApiError && e.code === "invalid_request" ? "That doesn't look like a key. Paste just the key, with no spaces." : e instanceof ApiError && e.message ? e.message : "Couldn't save that key. Try again.";

  async function loadKeys() {
    try {
      keyRows = (await api<{ keys: KeyRow[] }>("GET", "/v1/admin/keys")).keys;
    } catch {
      /* the rest of the page still works */
    }
  }
  async function saveKey(k: KeyRow) {
    const value = (drafts[k.id] ?? "").trim();
    if (!value || keyBusy) return;
    keyBusy = k.id;
    keyMsg[k.id] = { ok: true, text: "" };
    try {
      keyRows = (await api<{ keys: KeyRow[] }>("PUT", `/v1/admin/keys/${k.id}`, { value })).keys;
      drafts[k.id] = "";
      keyMsg[k.id] = { ok: true, text: "Checked and saved. It works right away." };
      void refresh();
    } catch (e) {
      keyMsg[k.id] = { ok: false, text: keyProblem(e) };
    } finally {
      keyBusy = "";
    }
  }
  async function removeKey(k: KeyRow) {
    if (confirmRemove !== k.id) {
      confirmRemove = k.id;
      return;
    }
    confirmRemove = "";
    try {
      keyRows = (await api<{ keys: KeyRow[] }>("DELETE", `/v1/admin/keys/${k.id}`)).keys;
      keyMsg[k.id] = { ok: true, text: "Removed." };
      void refresh();
    } catch (e) {
      keyMsg[k.id] = { ok: false, text: keyProblem(e) };
    }
  }

  async function load() {
    void loadKeys();
    try {
      const q = await api<{ items: Req[]; total: number }>("GET", "/v1/admin/invite-requests");
      requests = q.items;
      total = q.total;
      usage = (await api<{ users: Use[] }>("GET", "/v1/admin/usage")).users;
    } catch {
      error = "Couldn't load owner data.";
    }
  }
  onMount(() => {
    load();
    loadOps();
  });

  async function makeLink(forEmail: string, path: string, body?: unknown) {
    error = "";
    copied = false;
    try {
      const r = await api<{ inviteUrl: string }>("POST", path, body);
      link = { email: forEmail, url: r.inviteUrl };
    } catch {
      error = "Couldn't make that invite.";
    }
  }
  const approve = (r: Req) => makeLink(r.email, `/v1/admin/invite-requests/${r.id}/approve`);
  const invite = async (e: SubmitEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    await makeLink(email.trim(), "/v1/admin/invites", { email: email.trim() });
    email = "";
  };
  async function copy() {
    try {
      await navigator.clipboard.writeText(link!.url);
      copied = true;
    } catch {
      /* the link is shown as text, so it can still be selected by hand */
    }
  }
</script>

<div class="page">
  <div class="col">
    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <section class="keys">
      <h2 class="display">API keys</h2>
      <p class="muted">Paste a key and tap Save. Danny checks it first, then uses it right away. No computer needed.</p>
      {#each sortedKeys as k (k.id)}
        <div class="keybox">
          <div class="keyhead">
            <b>{k.label}</b>
            {#if k.source !== "none"}<span class="tag run">Set</span>
            {:else if k.needed === "required"}<span class="tag need">Needed</span>
            {:else}<span class="tag off">Optional</span>{/if}
          </div>
          <p>{k.why}</p>
          {#if k.source === "env"}
            <p class="mono">Set on the server. It can't be changed here.</p>
          {:else}
            {#if k.source === "none"}
              <ol class="how">{#each k.steps as step}<li>{step}</li>{/each}</ol>
              <a class="btn small" href={k.url} target="_blank" rel="noopener noreferrer">Open {k.label}</a>
            {/if}
            <form class="row" onsubmit={(e) => { e.preventDefault(); void saveKey(k); }}>
              <label class="sr" for="key-{k.id}">{k.label} key</label>
              <input
                id="key-{k.id}" class="input" type="password" autocomplete="off" autocapitalize="off" spellcheck="false"
                placeholder={k.source === "app" ? "Paste a new key to replace it" : "Paste the key here"} bind:value={drafts[k.id]}
              />
              <button class="btn primary" disabled={!drafts[k.id]?.trim() || keyBusy === k.id}>{keyBusy === k.id ? "Checking" : "Save"}</button>
            </form>
            {#if k.source === "app"}
              <button class="btn small" type="button" onclick={() => removeKey(k)}>{confirmRemove === k.id ? "Tap again to remove" : "Remove"}</button>
            {/if}
          {/if}
          {#if keyMsg[k.id]?.text}<p class:bad={!keyMsg[k.id]!.ok} class="mono" role="status">{keyMsg[k.id]!.text}</p>{/if}
        </div>
      {/each}
    </section>

    {#if link}
      <section class="linkbox" aria-live="polite">
        <p class="mono">Invite link for {link.email}. Send it yourself. Good for 7 days, works once.</p>
        <code>{link.url}</code>
        <button class="btn small primary" onclick={copy}>{copied ? "Copied" : "Copy link"}</button>
      </section>
    {/if}

    <section>
      <h2 class="display">Invite someone</h2>
      <form class="row" onsubmit={invite}>
        <label class="sr" for="inv">Their email</label>
        <input id="inv" class="input" type="email" placeholder="name@example.com" bind:value={email} />
        <button class="btn" disabled={!email.trim()}>Make link</button>
      </form>
    </section>

    <section>
      <h2 class="display">Asked for an invite</h2>
      {#if total > 0}
        <p class="mono">{total} on the list{total > requests.length ? `, newest ${requests.length} shown` : ""}. <a href="/v1/admin/invite-requests.csv" download>Download all (CSV)</a></p>
      {/if}
      {#if requests.length === 0}<p class="muted">Nobody yet.</p>{/if}
      <ul>
        {#each requests as r (r.id)}
          <li>
            <div class="who"><span>{r.email}</span><span class="mono">{fmtDay(r.createdAt)}</span></div>
            <span class="tag" class:need={r.status === "pending"} class:run={r.status === "approved"}>{r.status}</span>
            {#if r.status === "pending"}<button class="btn small primary" onclick={() => approve(r)}>Approve</button>{/if}
          </li>
        {/each}
      </ul>
    </section>

    <section>
      <h2 class="display">Server</h2>
      {#if !ops}
        <p class="muted">Checking…</p>
      {:else if !ops.available}
        <p>The Update and Backup buttons aren't turned on yet. Once, on the server, run:</p>
        <code>danny ops-install</code>
        <p class="muted">After that, this tab can check for updates, back up and update by itself. The app never gets control of the server: it only leaves a note, and a script on the server does the work.</p>
      {:else}
        <p class="mono">
          Version {ops.version ?? "unknown"}{ops.branch ? ` on ${ops.branch}` : ""}.
          {ops.behind > 0 ? `${ops.behind} update${ops.behind > 1 ? "s" : ""} waiting.` : "Up to date."}
          Checked {ago(ops.checkedAt)}.
        </p>
        {#if ops.behind > 0}
          <ul class="changes">{#each ops.changes as c}<li>{c}</li>{/each}</ul>
        {/if}

        {#if ops.busy || reconnecting}
          <p class="mono" role="status">
            {WORDS[ops.last?.action ?? asked] ?? "Working"}…
            {reconnecting ? "Danny is restarting. This page will pick up again by itself." : "This can take a few minutes."}
          </p>
        {:else}
          <div class="row">
            <button class="btn" onclick={() => ask("check")}>Check for updates</button>
            <button class="btn" onclick={() => ask("backup")}>Back up now</button>
            {#if confirmUpdate}
              <button class="btn warn" onclick={() => ask("update")}>Yes, update</button>
              <button class="btn" onclick={() => (confirmUpdate = false)}>Cancel</button>
            {:else}
              <button class="btn primary" onclick={() => (confirmUpdate = true)}>Update Danny</button>
            {/if}
          </div>
          {#if confirmUpdate}<p class="muted">This backs up first, then restarts Danny for about a minute. If the new version won't start, the old code is put back.</p>{/if}
        {/if}

        {#if ops.last && !ops.busy && !reconnecting}
          <p class="mono" class:bad={ops.last.state === "failed"} role="status">
            Last: {ops.last.action} {ops.last.state === "ok" ? "worked" : ops.last.state === "failed" ? "FAILED" : ops.last.state}, {ago(ops.last.finishedAt ?? ops.last.startedAt)}.
          </p>
          {#if ops.last.summary}<pre>{ops.last.summary}</pre>{/if}
        {/if}

        {#if ops.backups.length}
          <h3 class="mono">Recent backups</h3>
          <ul class="changes">{#each ops.backups as b}<li><span class="mono">{b.name}</span> <span class="muted">{kb(b.bytes)}, {ago(b.at)}</span></li>{/each}</ul>
        {/if}
      {/if}
    </section>

    <section>
      <h2 class="display">Cost by person</h2>
      <p class="muted">What each person's requests really cost, in tokens, searches and speech. Not what they were billed (usage is rounded up to the cent).</p>
      <div class="scroll">
        <table>
          <thead><tr><th>Person</th><th>Today</th><th>30 days</th></tr></thead>
          <tbody>
            {#each usage as u (u.userId)}<tr><td>{u.email}</td><td>${u.todayCostUsd.toFixed(4)}</td><td>${u.last30DaysCostUsd.toFixed(3)}</td></tr>{/each}
          </tbody>
        </table>
      </div>
    </section>
  </div>
</div>

<style>
  .page { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 24px 40px; }
  .col { width: min(760px, 100%); margin: 0 auto; display: flex; flex-direction: column; }
  section { display: flex; flex-direction: column; gap: 12px; padding: 24px 0; border-top: 1px solid var(--line); align-items: flex-start; }
  section:first-child { border-top: 0; padding-top: 8px; }
  section h2 { font-size: 2rem; }
  .muted { color: var(--muted); }
  .row { display: flex; gap: 10px; width: 100%; }
  .linkbox { background: var(--panel); border: 2px solid var(--run); padding: 16px; margin-bottom: 12px; }
  code { display: block; width: 100%; padding: 10px; background: var(--graphite); border: 1px solid var(--line); font: 400 .8125rem/1.4 var(--mono); overflow-wrap: anywhere; user-select: all; }
  ul { width: 100%; }
  .changes li { display: block; padding: 6px 0; overflow-wrap: anywhere; }
  pre { width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; padding: 10px; background: var(--graphite); border: 1px solid var(--line); font: 400 .8125rem/1.4 var(--mono); }
  .bad { color: var(--need); }
  h3 { font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  .row { flex-wrap: wrap; }
  li { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-top: 1px solid var(--line); }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow-wrap: anywhere; }
  .keybox { width: 100%; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; padding: 16px; background: var(--panel); border: 1px solid var(--line); }
  .keyhead { display: flex; align-items: center; gap: 10px; font-size: 1.125rem; }
  .how { margin: 0; padding-left: 20px; list-style: decimal; color: var(--paper); }
  .how li { display: list-item; border: 0; padding: 2px 0; }
  .keybox .row .input { flex: 1; min-width: 0; }
  .scroll { width: 100%; overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font: 500 .75rem/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); padding: 8px 12px 8px 0; }
  td { padding: 10px 12px 10px 0; border-top: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  @media (max-width: 859px) {
    .page { padding: 14px 16px 28px; padding-left: max(16px, var(--safe-left)); padding-right: max(16px, var(--safe-right)); }
  }
</style>
