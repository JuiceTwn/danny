<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Connection } from "../lib/api";
  import { disablePush, enablePush, pushState, type PushState } from "../lib/push";
  import { app, installApp, refresh, signOut } from "../lib/store.svelte";
  import { usd } from "../lib/router.svelte";

  const s = $derived(app.settings);
  let cap = $state("");
  let saving = $state(false);
  let msg = $state("");
  let error = $state("");

  $effect(() => {
    if (s && cap === "") cap = String(s.dailyCapUsd);
  });

  let conns = $state<Connection[]>([]);
  let googleConfigured = $state(false);
  let googleLoaded = $state(false);
  let googleMsg = $state("");
  let confirmGmail = $state(false);
  const gmail = $derived(conns.find((c) => c.provider === "google"));
  const isAdmin = $derived(app.me?.role === "admin");
  const GOOGLE_RESULTS: Record<string, string> = {
    connected: "Gmail connected.",
    denied: "You cancelled, so nothing was connected.",
    scopes: "Danny needs both permissions, read and send. Try again and leave both ticked.",
    error: "Couldn't connect Gmail. Try again.",
  };
  async function loadConnections() {
    try {
      const r = await api<{ items: Connection[]; google: { configured: boolean } }>("GET", "/v1/connections");
      conns = r.items;
      googleConfigured = r.google.configured;
    } catch {
      /* the section just stays empty */
    }
    googleLoaded = true;
  }
  async function disconnectGmail() {
    if (!gmail) return;
    try {
      await api("DELETE", `/v1/connections/${gmail.id}`);
      googleMsg = "Gmail disconnected. Google has been told to cancel the login.";
    } catch {
      error = "Couldn't disconnect. Try again.";
    }
    confirmGmail = false;
    await loadConnections();
  }
  onMount(() => {
    // The server sends people back here with ?google=<result>. Show it once, then clean the address bar.
    const r = new URLSearchParams(location.search).get("google");
    if (r) {
      googleMsg = GOOGLE_RESULTS[r] ?? "";
      history.replaceState(null, "", location.pathname + location.hash);
    }
    loadConnections();
  });

  let notify = $state<PushState | "checking">("checking");
  let notifyBusy = $state(false);
  onMount(() => {
    pushState().then((x) => (notify = x)).catch(() => (notify = "unsupported"));
  });
  async function toggleNotify() {
    notifyBusy = true;
    error = "";
    try {
      if (notify === "on") await disablePush();
      else await enablePush();
      notify = await pushState();
    } catch {
      notify = await pushState().catch(() => "unsupported" as const);
      error = notify === "denied" ? "Notifications are blocked for this site in your browser settings." : "Couldn't change notifications. Try again.";
    } finally {
      notifyBusy = false;
    }
  }

  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1);
  const device = ios ? "ios" : /Android/.test(ua) ? "android" : "desktop";
  const pct = $derived(s && s.dailyCapUsd > 0 ? Math.min(100, (s.spentTodayUsd / s.dailyCapUsd) * 100) : 0);

  async function toggle() {
    if (!s) return;
    error = "";
    try {
      await api("PATCH", "/v1/settings", { killSwitch: !s.killSwitch });
      await refresh();
    } catch {
      error = "Couldn't change that. Try again.";
    }
  }

  async function saveCap(e: SubmitEvent) {
    e.preventDefault();
    saving = true;
    msg = error = "";
    try {
      await api("PATCH", "/v1/settings", { dailyCapUsd: Number(cap) });
      await refresh();
      msg = "Saved.";
    } catch {
      error = "That number isn't allowed. Try something smaller.";
    } finally {
      saving = false;
    }
  }
</script>

<div class="page">
  <div class="col">
    {#if error}<p class="error" role="alert">{error}</p>{/if}

    <section>
      <h2 class="display">Danny</h2>
      <div class="state">
        <span class="lamp" class:off={s?.killSwitch}></span>
        <strong class="mono big" class:off={s?.killSwitch}>{s?.killSwitch ? "Stopped" : "Running"}</strong>
      </div>
      <p>{s?.killSwitch ? "Danny won't answer or spend anything until you start him again." : "One tap stops everything. Danny won't answer or spend until you start him again."}</p>
      <button class="btn {s?.killSwitch ? 'primary' : 'warn'} wide" onclick={toggle}>{s?.killSwitch ? "Start Danny" : "Stop Danny"}</button>
    </section>

    <section>
      <h2 class="display">Daily spend cap</h2>
      <p>Danny stops for the day when he hits this number. It resets at midnight UTC.</p>
      {#if s}
        <div class="meter" role="img" aria-label="{usd(s.spentTodayUsd)} of {usd(s.dailyCapUsd)} used today"><b style:width="{pct}%"></b></div>
        <p class="mono">{usd(s.spentTodayUsd)} used of {usd(s.dailyCapUsd)}</p>
      {/if}
      <form class="capform" onsubmit={saveCap}>
        <div class="field">
          <label for="cap">Cap in US dollars</label>
          <input id="cap" class="input" type="number" min="0" step="0.5" inputmode="decimal" bind:value={cap} />
        </div>
        <button class="btn" disabled={saving}>Save</button>
      </form>
      {#if msg}<p class="mono" role="status">{msg}</p>{/if}
    </section>

    <section>
      <h2 class="display">Notifications</h2>
      {#if notify === "checking"}
        <p class="mono">Checking…</p>
      {:else if notify === "unconfigured"}
        <p>Push isn't set up on this server yet. Reminders still show up in your chat.</p>
      {:else if notify === "unsupported"}
        <p>{ios && !app.installed ? "On iPhone, add Danny to your Home Screen first (see Install below), then come back here." : "This browser can't receive notifications. Reminders still show up in your chat."}</p>
      {:else if notify === "denied"}
        <p>Notifications are blocked for this site. Allow them in your browser settings, then come back.</p>
      {:else}
        <p>{notify === "on" ? "Reminders will buzz this device. Quiet hours are 10pm to 7am: repeat nudges wait until morning." : "Get reminders on this device, even when Danny is closed."}</p>
        <button class="btn {notify === 'on' ? '' : 'primary'} wide" disabled={notifyBusy} onclick={toggleNotify}>{notify === "on" ? "Turn off" : "Turn on"}</button>
      {/if}
    </section>

    <section>
      <h2 class="display">Gmail</h2>
      {#if googleMsg}<p class="mono" role="status">{googleMsg}</p>{/if}
      {#if !googleLoaded}
        <p class="mono">Checking…</p>
      {:else if !googleConfigured}
        <p>Gmail isn't set up on this server yet. The server needs a Google client ID and secret (see docs/GMAIL_SETUP.md).</p>
      {:else if gmail && gmail.status === "active"}
        <p>Connected as <strong class="mono who">{gmail.label}</strong>. Danny can read your mail. He sends only after you tap Send on a card, and he can't delete anything.</p>
        {#if isAdmin}
          {#if confirmGmail}
            <div class="row">
              <button class="btn warn" onclick={disconnectGmail}>Disconnect</button>
              <button class="btn" onclick={() => (confirmGmail = false)}>Keep</button>
            </div>
          {:else}
            <button class="btn wide" onclick={() => (confirmGmail = true)}>Disconnect Gmail</button>
          {/if}
        {/if}
      {:else if gmail}
        <p>Gmail needs to be connected again. Google stopped honouring the saved login{gmail.label ? ` for ${gmail.label}` : ""}.</p>
        {#if isAdmin}<a class="btn primary wide" href="/v1/connections/google/start">Reconnect Gmail</a>{/if}
      {:else}
        <p>Let Danny read your mail and draft replies. Nothing is sent until you tap Send on a card. He can't delete or change anything in your mailbox.</p>
        {#if isAdmin}<a class="btn primary wide" href="/v1/connections/google/start">Connect Gmail</a>{/if}
      {/if}
    </section>

    <section>
      <h2 class="display">Install</h2>
      {#if app.installed}
        <p>Danny is installed on this device.</p>
      {:else}
        {#if app.canInstall}<button class="btn primary wide" onclick={installApp}>Install Danny</button>{/if}
        {#if device === "ios"}
          <ol class="steps"><li>Open Danny in Safari (iOS 16.4 or later).</li><li>Tap Share.</li><li>Tap Add to Home Screen.</li></ol>
        {:else if device === "android"}
          {#if !app.canInstall}<ol class="steps"><li>Open the browser menu.</li><li>Tap Install app.</li></ol>{/if}
        {:else if !app.canInstall}
          <ol class="steps"><li>In Chrome or Edge, click the install icon in the address bar.</li><li>Click Install.</li></ol>
        {/if}
      {/if}
    </section>

    <section>
      <h2 class="display">What's stored</h2>
      <p>Your memory, messages and drafts are encrypted before they're saved. Your email and the titles of your approval cards are not. Spend is counted, never the content.</p>
    </section>

    <section>
      <h2 class="display">Account</h2>
      <p class="mono who">{app.me?.user.email}</p>
      <button class="btn" onclick={signOut}>Sign out</button>
    </section>
  </div>
</div>

<style>
  .page { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 24px 40px; }
  .col { width: min(640px, 100%); margin: 0 auto; display: flex; flex-direction: column; gap: 0; }
  section { display: flex; flex-direction: column; gap: 12px; padding: 28px 0; border-top: 1px solid var(--line); align-items: flex-start; }
  section:first-of-type { border-top: 0; padding-top: 8px; }
  section h2 { font-size: 2.2rem; }
  section p { color: #c9d0c8; max-width: 46ch; }
  .state { display: flex; align-items: center; gap: 10px; }
  .lamp { width: 14px; height: 14px; background: var(--run); display: block; }
  .lamp.off { background: var(--need); }
  .big { font-size: 1rem; color: var(--run); }
  .big.off { color: var(--need); }
  .wide { min-width: 200px; }
  .row { display: flex; gap: 10px; }
  .meter { width: 100%; height: 24px; border: 2px solid var(--paper); position: relative; }
  .meter b { position: absolute; inset: 0 auto 0 0; background: var(--run); }
  .capform { display: flex; gap: 12px; align-items: flex-end; width: 100%; max-width: 380px; }
  .capform .field { flex: 1; }
  .who { text-transform: none; letter-spacing: 0; }
  .steps { counter-reset: s; width: 100%; max-width: 46ch; }
  .steps li { counter-increment: s; display: grid; grid-template-columns: 2.4rem 1fr; padding: 10px 0; border-top: 1px solid var(--line); }
  .steps li::before { content: counter(s, decimal-leading-zero); font: 500 .85rem/1.7 var(--mono); color: var(--run); }
  @media (max-width: 859px) {
    .page { padding: 14px 16px 28px; padding-left: max(16px, var(--safe-left)); padding-right: max(16px, var(--safe-right)); }
  }
</style>
