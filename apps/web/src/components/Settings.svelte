<script lang="ts">
  import { api } from "../lib/api";
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
  .who { text-transform: none; letter-spacing: 0; }
  .steps { counter-reset: s; width: 100%; max-width: 46ch; }
  .steps li { counter-increment: s; display: grid; grid-template-columns: 2.4rem 1fr; padding: 10px 0; border-top: 1px solid var(--line); }
  .steps li::before { content: counter(s, decimal-leading-zero); font: 500 .85rem/1.7 var(--mono); color: var(--run); }
  @media (max-width: 859px) {
    .page { padding: 14px 16px 28px; padding-left: max(16px, var(--safe-left)); padding-right: max(16px, var(--safe-right)); }
  }
</style>
