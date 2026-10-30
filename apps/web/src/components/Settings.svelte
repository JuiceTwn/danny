<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Interest, type Style } from "../lib/api";
  import Connections from "./Connections.svelte";
  import { disablePush, enablePush, pushState, type PushState } from "../lib/push";
  import { app, installApp, refresh, signOut } from "../lib/store.svelte";
  import { resetsIn, usd } from "../lib/router.svelte";

  const s = $derived(app.settings);
  let cap = $state("");
  let saving = $state(false);
  let msg = $state("");
  let error = $state("");

  $effect(() => {
    if (s?.dailyCapUsd !== undefined && cap === "") cap = String(s.dailyCapUsd);
  });

  let briefOn = $state(false);
  let briefTime = $state("07:30");
  let briefBusy = $state(false);
  $effect(() => {
    if (app.me) {
      briefOn = app.me.user.briefingEnabled;
      briefTime = app.me.user.briefingTime;
    }
  });
  let wrapOn = $state(false);
  let wrapTime = $state("20:00");
  let voice = $state("foreman");
  $effect(() => {
    if (app.me) {
      wrapOn = app.me.user.wrapupEnabled;
      wrapTime = app.me.user.wrapupTime;
      voice = app.me.user.voice;
    }
  });
  let quietStart = $state(22);
  let quietEnd = $state(7);
  let units = $state("metric");
  let learnOn = $state(true);
  let autoMemOn = $state(true);
  $effect(() => {
    if (app.me) {
      quietStart = app.me.user.quietStart;
      quietEnd = app.me.user.quietEnd;
      units = app.me.user.units;
      learnOn = app.me.user.learnEnabled;
      autoMemOn = app.me.user.autoMemory;
    }
  });
  const HOURS = Array.from({ length: 24 }, (_, h) => [h, `${String(h).padStart(2, "0")}:00`] as const);
  let style = $state<Style>({ instruction: null, location: null, notes: [] });
  let instruction = $state("");
  let place = $state("");
  let styleMsg = $state("");
  async function loadStyle() {
    try {
      style = await api<Style>("GET", "/v1/style");
      instruction = style.instruction ?? "";
      place = style.location ?? "";
    } catch {
      /* the section just stays empty */
    }
  }
  async function saveStyle(which: "instruction" | "location", text: string) {
    styleMsg = error = "";
    try {
      style = await api<Style>("PUT", `/v1/style/${which}`, { text });
      styleMsg = "Saved.";
    } catch {
      error = "Couldn't save that. Try again.";
    }
  }
  async function forgetNote(id: string) {
    try {
      await api("DELETE", `/v1/style/notes/${id}`);
      await loadStyle();
    } catch {
      error = "Couldn't forget that. Try again.";
    }
  }
  async function forgetAll() {
    try {
      await api("DELETE", "/v1/style/notes");
      await loadStyle();
    } catch {
      error = "Couldn't forget those. Try again.";
    }
  }
  type Prefs = { briefingEnabled?: boolean; briefingTime?: string; wrapupEnabled?: boolean; wrapupTime?: string; voice?: string; quietStart?: number; quietEnd?: number; units?: string; learnEnabled?: boolean; autoMemory?: boolean };
  const VOICES = [
    ["foreman", "Foreman: short and dry"],
    ["warm", "Warm: friendly and encouraging"],
    ["brief", "Brief: as few words as possible"],
  ];
  let interests = $state<Interest[]>([]);
  let topic = $state("");
  async function loadInterests() {
    try {
      interests = (await api<{ items: Interest[] }>("GET", "/v1/interests")).items;
    } catch {
      /* the list just stays empty */
    }
  }
  async function addTopic(e: SubmitEvent) {
    e.preventDefault();
    const t = topic.trim();
    if (!t) return;
    error = "";
    try {
      await api("POST", "/v1/interests", { topic: t });
      topic = "";
      await loadInterests();
    } catch {
      error = "Couldn't add that. You can follow up to 15 topics.";
    }
  }
  async function dropTopic(id: string) {
    try {
      await api("DELETE", `/v1/interests/${id}`);
      await loadInterests();
    } catch {
      error = "Couldn't remove that. Try again.";
    }
  }
  async function saveBrief(patch: Prefs) {
    briefBusy = true;
    error = "";
    try {
      const r = await api<Prefs & { briefingEnabled: boolean; briefingTime: string; wrapupEnabled: boolean; wrapupTime: string; voice: string; quietStart: number; quietEnd: number; units: string; learnEnabled: boolean; autoMemory: boolean }>("PATCH", "/v1/profile", patch);
      if (app.me) {
        app.me.user.briefingEnabled = r.briefingEnabled;
        app.me.user.briefingTime = r.briefingTime;
        app.me.user.wrapupEnabled = r.wrapupEnabled;
        app.me.user.wrapupTime = r.wrapupTime;
        app.me.user.voice = r.voice;
        app.me.user.quietStart = r.quietStart;
        app.me.user.quietEnd = r.quietEnd;
        app.me.user.units = r.units;
        app.me.user.learnEnabled = r.learnEnabled;
        app.me.user.autoMemory = r.autoMemory;
      }
    } catch {
      error = "Couldn't save that. Try again.";
    } finally {
      briefBusy = false;
    }
  }

  onMount(() => {
    loadInterests();
    loadStyle();
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
  const pct = $derived(s?.usedPercent ?? 0);

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

    <Connections />

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
      <h2 class="display">Model</h2>
      {#if s}
        <p class="mono big">{s.demo ? "None (demo mode)" : s.model}</p>
        {#if s.canSetCap}
          <p class="mono">{usd(s.priceInputPerMtokUsd ?? 0)} per million tokens in, {usd(s.priceOutputPerMtokUsd ?? 0)} out</p>
          <p>Each message sends your recent chat and memory along with it, so a short reply still costs more than its length. Change it with the MODEL setting on the server.</p>
        {:else}
          <p>Each message sends your recent chat and memory along with it, so a short reply uses more than its length suggests.</p>
        {/if}
      {/if}
    </section>

    <section>
      <h2 class="display">Daily usage</h2>
      {#if s}
        <div class="meter" role="img" aria-label="{s.usedPercent}% of today's usage"><b style:width="{pct}%"></b></div>
        <p class="mono">{s.usedPercent}% used · resets in {resetsIn(s.resetsAt)}</p>
        <p>{s.usedPercent >= 100 ? "You've used all of today's allowance. Danny is back at midnight UTC." : "Danny stops for the day when the bar is full. It resets at midnight UTC."}</p>
        {#if s.canSetCap}
          <p class="mono">{usd(s.spentTodayUsd ?? 0)} used of {usd(s.dailyCapUsd ?? 0)}</p>
        {/if}
      {/if}
      {#if s?.canSetCap}
        <form class="capform" onsubmit={saveCap}>
          <div class="field">
            <label for="cap">Your daily limit in US dollars (owner only)</label>
            <input id="cap" class="input" type="number" min="0" step="0.5" inputmode="decimal" bind:value={cap} />
          </div>
          <button class="btn" disabled={saving}>Save</button>
        </form>
        {#if msg}<p class="mono" role="status">{msg}</p>{/if}
      {/if}
    </section>

    <section>
      <h2 class="display">Morning briefing</h2>
      <p>Each morning Danny sends your day, how your goals are going, and news on what you care about. It uses web searches, so it costs a few cents a day. Off until you turn it on.</p>
      <button class="btn {briefOn ? '' : 'primary'} wide" disabled={briefBusy} onclick={() => saveBrief({ briefingEnabled: !briefOn })}>{briefOn ? "Turn off" : "Turn on"}</button>
      {#if briefOn}
        <div class="field">
          <label for="brief-time">Send at (your local time)</label>
          <input id="brief-time" class="input" type="time" bind:value={briefTime} onchange={() => briefTime && saveBrief({ briefingTime: briefTime })} />
        </div>
      {/if}
    </section>

    <section>
      <h2 class="display">Evening wrap-up</h2>
      <p>Each evening Danny sums up what got done, what's still open and tomorrow's top three. On Sundays it's a weekly review. Off until you turn it on.</p>
      <button class="btn {wrapOn ? '' : 'primary'} wide" disabled={briefBusy} onclick={() => saveBrief({ wrapupEnabled: !wrapOn })}>{wrapOn ? "Turn off" : "Turn on"}</button>
      {#if wrapOn}
        <div class="field">
          <label for="wrap-time">Send at (your local time)</label>
          <input id="wrap-time" class="input" type="time" bind:value={wrapTime} onchange={() => wrapTime && saveBrief({ wrapupTime: wrapTime })} />
        </div>
      {/if}
    </section>

    <section>
      <h2 class="display">What you follow</h2>
      <p>Topics Danny looks up news on for your morning briefing. You can also just tell him in chat.</p>
      {#if interests.length}
        <ul class="topics">
          {#each interests as i (i.id)}
            <li><span>{i.topic}</span><button class="btn small" onclick={() => dropTopic(i.id)} aria-label="Stop following {i.topic}">Remove</button></li>
          {/each}
        </ul>
      {/if}
      <form class="capform" onsubmit={addTopic}>
        <div class="field">
          <label for="topic">Add a topic</label>
          <input id="topic" class="input" maxlength="80" placeholder="Premier League" bind:value={topic} />
        </div>
        <button class="btn" disabled={!topic.trim()}>Add</button>
      </form>
    </section>

    <section>
      <h2 class="display">How Danny talks</h2>
      <div class="field">
        <label for="voice">Style</label>
        <select id="voice" class="input" bind:value={voice} onchange={() => saveBrief({ voice })}>
          {#each VOICES as [v, label]}<option value={v}>{label}</option>{/each}
        </select>
      </div>
    </section>

    <section>
      <h2 class="display">About you</h2>
      <p>Where you are, for the weather in your briefing. And anything Danny should always do, in your own words.</p>
      <div class="field">
        <label for="place">Where you are</label>
        <input id="place" class="input" maxlength="80" placeholder="Leeds, UK" bind:value={place} onchange={() => saveStyle("location", place)} />
      </div>
      <div class="field">
        <label for="units">Temperature</label>
        <select id="units" class="input" bind:value={units} onchange={() => saveBrief({ units })}>
          <option value="metric">Celsius</option>
          <option value="imperial">Fahrenheit</option>
        </select>
      </div>
      <div class="field">
        <label for="instr">Standing instructions</label>
        <textarea id="instr" class="input" rows="4" maxlength="1000" placeholder="Call me Jo. Nothing before 10am. Keep it short." bind:value={instruction}></textarea>
      </div>
      <button class="btn wide" onclick={() => saveStyle("instruction", instruction)}>Save</button>
      {#if styleMsg}<p class="mono" role="status">{styleMsg}</p>{/if}
    </section>

    <section>
      <h2 class="display">What Danny has learned</h2>
      <p>How you like to be helped, from what you tell him and how you use him. It only changes his style and timing, never his rules or what needs your approval. Everything is listed here and you can remove any of it.</p>
      {#if style.notes.length}
        <ul class="topics">
          {#each style.notes as n (n.id)}
            <li><span>{n.note} <span class="mono">({n.kind === "said" ? "you told him" : "he noticed"})</span></span><button class="btn small" onclick={() => forgetNote(n.id)} aria-label="Forget: {n.note}">Forget</button></li>
          {/each}
        </ul>
        <button class="btn wide" onclick={forgetAll}>Forget all of it</button>
      {:else}
        <p class="mono">Nothing yet.</p>
      {/if}
      <button class="btn {learnOn ? '' : 'primary'} wide" disabled={briefBusy} onclick={() => saveBrief({ learnEnabled: !learnOn })}>{learnOn ? "Stop him learning from how I use him" : "Let him learn from how I use him"}</button>
    </section>

    <section>
      <h2 class="display">Remembering</h2>
      <p>{autoMemOn ? "After you tell him something about your life or work, Danny quietly keeps what's worth keeping, without being asked. You see it in the chat with an Undo, and in the Memory tab." : "Danny only remembers what you ask him to. Nothing is saved on his own."}</p>
      <button class="btn {autoMemOn ? '' : 'primary'} wide" disabled={briefBusy} onclick={() => saveBrief({ autoMemory: !autoMemOn })}>{autoMemOn ? "Only remember what I ask" : "Let him remember on his own"}</button>
    </section>

    <section>
      <h2 class="display">Quiet hours</h2>
      <p>Repeat reminders and watch alerts stay silent in this window. The first reminder at the time you asked for always comes through.</p>
      <div class="field">
        <label for="qs">Quiet from</label>
        <select id="qs" class="input" bind:value={quietStart} onchange={() => saveBrief({ quietStart })}>{#each HOURS as [h, label]}<option value={h}>{label}</option>{/each}</select>
      </div>
      <div class="field">
        <label for="qe">Until</label>
        <select id="qe" class="input" bind:value={quietEnd} onchange={() => saveBrief({ quietEnd })}>{#each HOURS as [h, label]}<option value={h}>{label}</option>{/each}</select>
      </div>
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
        <p>{notify === "on" ? "Reminders will buzz this device. Repeat nudges wait out your quiet hours (see below)." : "Get reminders on this device, even when Danny is closed."}</p>
        <button class="btn {notify === 'on' ? '' : 'primary'} wide" disabled={notifyBusy} onclick={toggleNotify}>{notify === "on" ? "Turn off" : "Turn on"}</button>
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
  .topics { display: flex; flex-direction: column; }
  .topics li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); }
</style>
