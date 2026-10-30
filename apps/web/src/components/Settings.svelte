<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api";
  import { app, installApp, refresh, signOut } from "../lib/store.svelte";
  import { usd } from "../lib/router.svelte";

  const s = $derived(app.settings);
  let cap = $state("");
  let monthCap = $state("");
  let saving = $state(false);
  let msg = $state("");
  let error = $state("");

  $effect(() => {
    if (s && cap === "") cap = String(s.dailyCapUsd);
    if (s && monthCap === "") monthCap = String(s.monthlyCapUsd);
  });

  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1);
  const device = ios ? "ios" : /Android/.test(ua) ? "android" : "desktop";
  const pct = $derived(s && s.dailyCapUsd > 0 ? Math.min(100, (s.spentTodayUsd / s.dailyCapUsd) * 100) : 0);
  const monthPct = $derived(s && s.monthlyCapUsd > 0 ? Math.min(100, (s.spentMonthUsd / s.monthlyCapUsd) * 100) : 0);
  // The same thresholds the server uses: at 80% Danny drops a model size on each request, at 95% he uses only the smallest.
  const nearness = $derived(Math.max(pct, monthPct) >= 95 ? "critical" : Math.max(pct, monthPct) >= 80 ? "near" : "ok");

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

  let runs = $state("");
  $effect(() => {
    if (s && runs === "") runs = String(s.agentRunsPerDay);
  });
  async function setAgent(patch: { agentEnabled?: boolean; agentRunsPerDay?: number }) {
    error = msg = "";
    try {
      await api("PATCH", "/v1/settings", patch);
      await refresh();
      if (patch.agentRunsPerDay !== undefined) msg = "Saved.";
    } catch {
      error = "Couldn't change that. Only an admin can.";
    }
  }
  const lastRun = $derived(s?.agentLastRunAt ? new Date(s.agentLastRunAt).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "never");

  type Conn = { id: string; provider: string; label: string };
  let conns = $state<Conn[]>([]);
  let mailKey = $state("");
  let mailFrom = $state("");
  const mail = $derived(conns.find((c) => c.provider === "resend"));
  const loadConns = async () => {
    try {
      conns = (await api<{ items: Conn[] }>("GET", "/v1/connections")).items;
    } catch {
      /* section just shows as unlinked */
    }
  };
  onMount(loadConns);
  async function linkMail(e: SubmitEvent) {
    e.preventDefault();
    error = msg = "";
    try {
      await api("POST", "/v1/connections", { provider: "resend", label: mailFrom.trim(), secret: JSON.stringify({ apiKey: mailKey.trim(), from: mailFrom.trim() }) });
      mailKey = mailFrom = "";
      await loadConns();
      msg = "Email linked.";
    } catch {
      error = "Couldn't link that. Only an admin can.";
    }
  }
  async function unlinkMail() {
    if (!mail) return;
    try {
      await api("DELETE", `/v1/connections/${mail.id}`);
      await loadConns();
    } catch {
      error = "Couldn't unlink that.";
    }
  }

  async function saveMonthCap(e: SubmitEvent) {
    e.preventDefault();
    saving = true;
    msg = error = "";
    try {
      await api("PATCH", "/v1/settings", { monthlyCapUsd: Number(monthCap) });
      await refresh();
      msg = "Saved.";
    } catch {
      error = "That number isn't allowed. Try something smaller.";
    } finally {
      saving = false;
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
      <h2 class="display">Works on his own</h2>
      <p>Danny reviews your goals between chats, fixes the plan, and drafts what he can. He never sends anything without your tap. Every review counts against your daily spend cap.</p>
      <div class="state">
        <span class="lamp" class:off={!s?.agentEnabled}></span>
        <strong class="mono big" class:off={!s?.agentEnabled}>{s?.agentEnabled ? "On" : "Off"}</strong>
      </div>
      <button class="btn {s?.agentEnabled ? '' : 'primary'} wide" onclick={() => setAgent({ agentEnabled: !s?.agentEnabled })}>{s?.agentEnabled ? "Turn off" : "Let Danny work on his own"}</button>
      {#if s?.agentEnabled && !s.schedulerOn}<p class="error" role="status">This server isn't running the scheduler (no model key, or AGENT_TICK_SECONDS=0). Danny only reviews when you press Review now.</p>{/if}
      <p class="mono">{s?.agentRunsToday ?? 0} of {s?.agentRunsPerDay ?? 0} reviews used today · last: {lastRun}</p>
      <form class="capform" onsubmit={(e) => { e.preventDefault(); void setAgent({ agentRunsPerDay: Number(runs) }); }}>
        <div class="field">
          <label for="runs">Reviews allowed per day</label>
          <input id="runs" class="input" type="number" min="1" max="24" step="1" inputmode="numeric" bind:value={runs} />
        </div>
        <button class="btn">Save</button>
      </form>
    </section>

    <section>
      <h2 class="display">Email</h2>
      {#if mail}
        <p>Approved emails go out from <strong>{mail.label}</strong>.</p>
        <button class="btn" onclick={unlinkMail}>Unlink</button>
      {:else}
        <p>Link a Resend account so approved emails can actually send. Until then, approving only records your decision. Up to 20 emails a day.</p>
        <form class="mailform" onsubmit={linkMail}>
          <div class="field"><label for="mk">Resend API key</label><input id="mk" class="input" type="password" autocomplete="off" bind:value={mailKey} /></div>
          <div class="field"><label for="mf">Send from</label><input id="mf" class="input" placeholder="Justin <justin@yourdomain.com>" bind:value={mailFrom} /></div>
          <button class="btn" disabled={!mailKey.trim() || mailFrom.trim().length < 3}>Link email</button>
        </form>
      {/if}
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
      <h2 class="display">Monthly spend cap</h2>
      <p>Resets on the 1st (UTC). Danny picks the model for each request: the small one for quick things, a bigger one for drafts and plans. Close to either cap he drops a size instead of stopping, and he only stops at the cap itself.</p>
      {#if s}
        <div class="meter" role="img" aria-label="{usd(s.spentMonthUsd)} of {usd(s.monthlyCapUsd)} used this month"><b style:width="{monthPct}%"></b></div>
        <p class="mono">{usd(s.spentMonthUsd)} used of {usd(s.monthlyCapUsd)} this month</p>
        {#if nearness === "near"}<p class="error" role="status">Nearing a cap. Danny is using a smaller model than usual.</p>{/if}
        {#if nearness === "critical"}<p class="error" role="status">Close to a cap. Danny is using the smallest model for everything until it resets.</p>{/if}
      {/if}
      <form class="capform" onsubmit={saveMonthCap}>
        <div class="field">
          <label for="mcap">Cap in US dollars</label>
          <input id="mcap" class="input" type="number" min="0" step="1" inputmode="decimal" bind:value={monthCap} />
        </div>
        <button class="btn" disabled={saving}>Save</button>
      </form>
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
  .meter { width: 100%; height: 24px; border: 2px solid var(--paper); position: relative; }
  .meter b { position: absolute; inset: 0 auto 0 0; background: var(--run); }
  .capform { display: flex; gap: 12px; align-items: flex-end; width: 100%; max-width: 380px; }
  .capform .field { flex: 1; }
  .mailform { display: flex; flex-direction: column; gap: 12px; width: 100%; max-width: 380px; align-items: flex-start; }
  .mailform .field { width: 100%; }
  .who { text-transform: none; letter-spacing: 0; }
  .steps { counter-reset: s; width: 100%; max-width: 46ch; }
  .steps li { counter-increment: s; display: grid; grid-template-columns: 2.4rem 1fr; padding: 10px 0; border-top: 1px solid var(--line); }
  .steps li::before { content: counter(s, decimal-leading-zero); font: 500 .85rem/1.7 var(--mono); color: var(--run); }
  @media (max-width: 859px) {
    .page { padding: 14px 16px 28px; padding-left: max(16px, var(--safe-left)); padding-right: max(16px, var(--safe-right)); }
  }
</style>
