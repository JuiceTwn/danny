<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Connector, type GoogleSetup } from "../lib/api";
  import { app } from "../lib/store.svelte";

  let items = $state<Connector[]>([]);
  let canConnect = $state(false);
  let loaded = $state(false);
  let notice = $state("");
  let error = $state("");
  let open = $state(""); // which card's connect panel is open
  let confirm = $state(""); // which card is asking "are you sure" about disconnecting
  let busy = $state(false);

  // token connectors: what has been typed, per connector
  let typed = $state<Record<string, Record<string, string>>>({});

  // Google setup (the owner only)
  let setup = $state<GoogleSetup | null>(null);
  let gid = $state("");
  let gsecret = $state("");
  let copied = $state("");

  const GOOGLE_RESULTS: Record<string, string> = {
    connected: "Google connected.",
    denied: "You cancelled, so nothing was connected.",
    scopes: "Danny needs both Gmail permissions, read and send. Try again and leave both ticked.",
    error: "Couldn't connect Google. Try again.",
  };

  async function load() {
    try {
      const r = await api<{ items: Connector[]; canConnect: boolean }>("GET", "/v1/connectors");
      items = r.items;
      canConnect = r.canConnect;
    } catch {
      error = "Couldn't load connections.";
    }
    loaded = true;
  }
  onMount(() => {
    // The server sends people back here with ?google=<result>. Show it once, then clean the address bar.
    const r = new URLSearchParams(location.search).get("google");
    if (r) {
      notice = GOOGLE_RESULTS[r] ?? "";
      history.replaceState(null, "", location.pathname + location.hash);
    }
    load();
  });

  async function openSetup() {
    open = open === "google" ? "" : "google";
    error = "";
    if (open === "google" && !setup) {
      try {
        setup = await api<GoogleSetup>("GET", "/v1/admin/google");
      } catch {
        error = "Couldn't load the setup steps.";
      }
    }
  }
  async function copy(what: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = what;
      setTimeout(() => (copied = ""), 2000);
    } catch {
      /* the text is shown, so it can still be selected by hand */
    }
  }
  async function saveGoogle(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = notice = "";
    try {
      setup = await api<GoogleSetup>("PUT", "/v1/admin/google", { clientId: gid.trim(), clientSecret: gsecret.trim() });
      gid = gsecret = "";
      open = "";
      notice = "Google accepted those. Now tap Connect to link your own account.";
      await load();
    } catch (err) {
      error = (err as { message?: string }).message || "Couldn't save that. Check both values and try again.";
    } finally {
      busy = false;
    }
  }
  async function removeGoogleSetup() {
    busy = true;
    try {
      setup = await api<GoogleSetup>("DELETE", "/v1/admin/google");
      confirm = "";
      await load();
    } catch {
      error = "Couldn't remove that. Try again.";
    } finally {
      busy = false;
    }
  }
  async function connectToken(c: Connector) {
    busy = true;
    error = notice = "";
    try {
      const r = await api<{ label: string }>("POST", `/v1/connectors/${c.id}/connect`, { values: typed[c.id] ?? {} });
      typed[c.id] = {};
      open = "";
      notice = `${c.name} connected as ${r.label}.`;
      await load();
    } catch (err) {
      error = (err as { message?: string }).message || `Couldn't connect ${c.name}. Try again.`;
    } finally {
      busy = false;
    }
  }
  async function disconnect(c: Connector) {
    busy = true;
    error = notice = "";
    try {
      await api("DELETE", `/v1/connections/${c.connectionId}`);
      notice = `${c.name} disconnected.`;
    } catch {
      error = "Couldn't disconnect. Try again.";
    }
    confirm = "";
    busy = false;
    await load();
  }
  const set = (id: string, key: string, v: string) => (typed[id] = { ...typed[id], [key]: v });
  const ready = (c: Connector) => !!c.fields?.every((f) => typed[c.id]?.[f.key]?.trim());
  const STATE: Record<string, string> = { needs_setup: "Needs setup", ready: "Not connected", connected: "Connected", reconnect: "Reconnect" };
</script>

<section class="conn">
  <h2 class="display">Connections</h2>
  <p>Link the things Danny can help with. Each one is yours alone: nobody else on this server can see or use it.</p>
  {#if notice}<p class="mono ok" role="status">{notice}</p>{/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if !loaded}<p class="mono">Checking…</p>{/if}

  {#each items as c (c.id)}
    <div class="card" class:on={c.state === "connected"}>
      <div class="head">
        <strong class="name">{c.name}</strong>
        <span class="pill mono" class:good={c.state === "connected"} class:warn={c.state === "reconnect"}>{STATE[c.state]}</span>
      </div>
      <p>{c.blurb}</p>

      {#if c.state === "connected"}
        <p class="mono">Connected as {c.label}.{c.id === "google" ? (c.calendar ? " Calendar is on." : " Calendar is off.") : ""}</p>
        {#if canConnect}
          <div class="row">
            {#if c.id === "google" && !c.calendar}<a class="btn" href="/v1/connections/google/start">Reconnect to add Calendar</a>{/if}
            {#if confirm === c.id}
              <button class="btn warn" disabled={busy} onclick={() => disconnect(c)}>Yes, disconnect</button>
              <button class="btn" onclick={() => (confirm = "")}>Keep it</button>
            {:else}
              <button class="btn" onclick={() => (confirm = c.id)}>Disconnect</button>
            {/if}
          </div>
        {/if}
      {:else if c.id === "google"}
        {#if c.state === "needs_setup"}
          {#if c.canSetUp}
            <button class="btn primary" onclick={openSetup}>{open === "google" ? "Close" : "Set up Google"}</button>
            {#if open === "google" && setup}
              <div class="panel">
                <p>One-time setup, about 10 minutes. Google needs to know it's okay for Danny to ask for sign-ins. You do this once for the whole server.</p>
                <ol class="steps">
                  <li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Google Cloud</a> and make a project. Any name.</li>
                  <li>Turn on two APIs: <a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Gmail API</a> and <a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com" target="_blank" rel="noopener">Google Calendar API</a>. Tap Enable on each.</li>
                  <li>
                    Open the <a href="https://console.cloud.google.com/auth/overview" target="_blank" rel="noopener">Auth Platform</a> and set it up: choose External, add your own email as a test user, and add these permissions:
                    <ul class="scopes">{#each setup.scopes as sc}<li class="mono">{sc}</li>{/each}</ul>
                    <button class="btn small" type="button" onclick={() => copy("scopes", setup!.scopes.join("\n"))}>{copied === "scopes" ? "Copied" : "Copy all three"}</button>
                  </li>
                  <li>
                    Go to <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noopener">Credentials</a>, then Create credentials, then OAuth client ID, type Web application. Under Authorized redirect URIs add exactly:
                    <code>{setup.redirectUri}</code>
                    <button class="btn small" type="button" onclick={() => copy("uri", setup!.redirectUri)}>{copied === "uri" ? "Copied" : "Copy"}</button>
                  </li>
                  <li>Google shows a Client ID and a Client secret. Paste both here.</li>
                </ol>
                <form onsubmit={saveGoogle}>
                  <div class="field">
                    <label for="gid">Client ID</label>
                    <input id="gid" class="input" autocomplete="off" spellcheck="false" placeholder="123456789-abc….apps.googleusercontent.com" bind:value={gid} />
                  </div>
                  <div class="field">
                    <label for="gsecret">Client secret</label>
                    <input id="gsecret" class="input" type="password" autocomplete="off" spellcheck="false" placeholder="GOCSPX-…" bind:value={gsecret} />
                  </div>
                  <button class="btn primary" disabled={busy || !gid.trim() || !gsecret.trim()}>{busy ? "Checking with Google…" : "Save and check"}</button>
                </form>
                <p class="note">Danny checks them with Google before saving. The secret is stored encrypted and never shown again.</p>
              </div>
            {/if}
          {:else}
            <p class="note">The owner of this Danny needs to finish Google setup first. Once they do, a Connect button appears here.</p>
          {/if}
        {:else if canConnect}
          <a class="btn primary" href="/v1/connections/google/start">{c.state === "reconnect" ? "Reconnect Google" : "Connect Google"}</a>
          <p class="note">On Google's screen, leave every box ticked. If it says "Google hasn't verified this app", tap Advanced, then continue. That's normal for your own setup.</p>
        {/if}
        {#if c.canSetUp && c.setUpBy === "app" && c.state !== "needs_setup"}
          {#if confirm === "google-setup"}
            <div class="row">
              <button class="btn warn" disabled={busy} onclick={removeGoogleSetup}>Yes, remove setup</button>
              <button class="btn" onclick={() => (confirm = "")}>Keep it</button>
            </div>
          {:else}
            <button class="linkbtn" onclick={() => (confirm = "google-setup")}>Change or remove the Google setup</button>
          {/if}
        {/if}
      {:else if canConnect}
        <button class="btn primary" onclick={() => (open = open === c.id ? "" : c.id)}>{open === c.id ? "Close" : c.state === "reconnect" ? "Reconnect" : "Connect"}</button>
        {#if open === c.id}
          <div class="panel">
            <ol class="steps">{#each c.steps ?? [] as step}<li>{step}</li>{/each}</ol>
            {#if c.helpUrl}<a class="btn small" href={c.helpUrl} target="_blank" rel="noopener">Open {c.name}</a>{/if}
            <form onsubmit={(e) => { e.preventDefault(); connectToken(c); }}>
              {#each c.fields ?? [] as f (f.key)}
                <div class="field">
                  <label for="{c.id}-{f.key}">{f.label}</label>
                  <input id="{c.id}-{f.key}" class="input" type={f.secret ? "password" : "text"} autocomplete="off" spellcheck="false" placeholder={f.placeholder} value={typed[c.id]?.[f.key] ?? ""} oninput={(e) => set(c.id, f.key, e.currentTarget.value)} />
                </div>
              {/each}
              <button class="btn primary" disabled={busy || !ready(c)}>{busy ? `Checking with ${c.name}…` : "Connect"}</button>
            </form>
            <p class="note">Danny checks it with {c.name} before saving. It's stored encrypted and never shown again.</p>
          </div>
        {/if}
      {/if}
    </div>
  {/each}
</section>

<style>
  .conn { display: flex; flex-direction: column; gap: 12px; }
  .card { border: 2px solid var(--line); padding: 16px; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; background: var(--panel); }
  .card.on { border-color: var(--run); }
  .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; width: 100%; }
  .name { font: 700 1.4rem/1 var(--display); text-transform: uppercase; letter-spacing: .01em; }
  .pill { font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); border: 1px solid var(--line); padding: 4px 8px; }
  .pill.good { color: var(--run); border-color: var(--run); }
  .pill.warn { color: var(--need); border-color: var(--need); }
  .ok { color: var(--run); }
  .row { display: flex; gap: 10px; flex-wrap: wrap; }
  .panel { width: 100%; display: flex; flex-direction: column; gap: 12px; padding-top: 6px; border-top: 1px solid var(--line); }
  .steps { padding-left: 1.5em; list-style: decimal; display: flex; flex-direction: column; gap: 12px; }
  .steps li::marker { font-family: var(--mono); color: var(--run); }
  .steps li { padding-left: 4px; }
  .scopes { margin: 8px 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; font-size: .8125rem; overflow-wrap: anywhere; }
  .scopes li { text-transform: none; letter-spacing: 0; }
  code { display: block; margin: 8px 0; padding: 10px; background: var(--graphite); border: 1px solid var(--line); font: 400 .8125rem/1.4 var(--mono); overflow-wrap: anywhere; user-select: all; }
  form { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; width: 100%; }
  form .field { width: 100%; }
  .note { font-size: .875rem; color: var(--muted); }
  .linkbtn { background: none; border: 0; padding: 4px 0; color: var(--muted); text-decoration: underline; cursor: pointer; font-size: .875rem; }
  a { color: inherit; }
</style>
