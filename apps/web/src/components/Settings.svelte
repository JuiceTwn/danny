<script lang="ts">
  import { onMount } from "svelte";
  import { api, type CatalogTeam, type FollowedTeam, type Interest, type Style } from "../lib/api";
  import Connections from "./Connections.svelte";
  import Section from "./Section.svelte";
  import { go } from "../lib/router.svelte";
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
  let adhdOn = $state(false);
  let prepOn = $state(false);
  let goodNewsOn = $state(false);
  let tipsOn = $state(true);
  let newsItems = $state(3);
  $effect(() => {
    if (app.me) {
      quietStart = app.me.user.quietStart;
      quietEnd = app.me.user.quietEnd;
      units = app.me.user.units;
      adhdOn = app.me.user.adhdMode;
      prepOn = app.me.user.eventPrep;
      goodNewsOn = app.me.user.goodNews;
      tipsOn = app.me.user.tips;
      newsItems = app.me.user.newsItems;
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
  type Prefs = { briefingEnabled?: boolean; briefingTime?: string; wrapupEnabled?: boolean; wrapupTime?: string; voice?: string; quietStart?: number; quietEnd?: number; units?: string; learnEnabled?: boolean; autoMemory?: boolean; adhdMode?: boolean; eventPrep?: boolean; goodNews?: boolean; newsItems?: number; tips?: boolean };
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
  let teams = $state<FollowedTeam[]>([]);
  let catalog = $state<CatalogTeam[]>([]);
  let pick = $state("");
  async function loadTeams() {
    try {
      teams = (await api<{ items: FollowedTeam[] }>("GET", "/v1/teams")).items;
      if (!catalog.length) catalog = (await api<{ items: CatalogTeam[] }>("GET", "/v1/teams/catalog")).items;
    } catch {
      /* the list just stays empty */
    }
  }
  async function addTeam(e: SubmitEvent) {
    e.preventDefault();
    const [league, code] = pick.split(":");
    if (!league || !code) return;
    error = "";
    try {
      await api("POST", "/v1/teams", { league, code });
      pick = "";
      await loadTeams();
    } catch {
      error = "Couldn't add that team. You can follow up to 8.";
    }
  }
  async function teamAlerts(t: FollowedTeam) {
    try {
      await api("PATCH", `/v1/teams/${t.id}`, { notify: !t.notify });
      await loadTeams();
    } catch {
      error = "Couldn't change that. Try again.";
    }
  }
  async function dropTeam(id: string) {
    try {
      await api("DELETE", `/v1/teams/${id}`);
      await loadTeams();
    } catch {
      error = "Couldn't remove that. Try again.";
    }
  }
  const followedKeys = $derived(new Set(teams.map((t) => `${t.league}:${t.code}`)));
  async function saveBrief(patch: Prefs) {
    briefBusy = true;
    error = "";
    try {
      const r = await api<Prefs & { briefingEnabled: boolean; briefingTime: string; wrapupEnabled: boolean; wrapupTime: string; voice: string; quietStart: number; quietEnd: number; units: string; learnEnabled: boolean; autoMemory: boolean; adhdMode: boolean; eventPrep: boolean; goodNews: boolean; newsItems: number; tips: boolean }>("PATCH", "/v1/profile", patch);
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
        app.me.user.adhdMode = r.adhdMode;
        app.me.user.eventPrep = r.eventPrep;
        app.me.user.goodNews = r.goodNews;
        app.me.user.newsItems = r.newsItems;
        app.me.user.tips = r.tips;
      }
    } catch {
      error = "Couldn't save that. Try again.";
    } finally {
      briefBusy = false;
    }
  }

  onMount(() => {
    loadInterests();
    loadTeams();
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
  type Tab = "danny" | "routine" | "account";
  let tab = $state<Tab>("danny");
  const TABS: [Tab, string][] = [["danny", "Danny"], ["routine", "Routine"], ["account", "Account"]];
  const onOff = (b: boolean) => (b ? "On" : "Off");
  const voiceName = $derived((VOICES.find(([v]) => v === voice)?.[1] ?? "").split(":")[0]);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

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
    <div class="seg" role="tablist" aria-label="Settings">
      {#each TABS as [id, label] (id)}
        <button role="tab" class="segbtn" class:on={tab === id} aria-selected={tab === id} onclick={() => (tab = id)}>{label}</button>
      {/each}
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}

    {#if tab === "danny"}
      <div class="group" role="tabpanel">
        <Section title="How Danny talks" summary={voiceName}>
          <div class="field">
            <label for="voice">Style</label>
            <select id="voice" class="input" bind:value={voice} onchange={() => saveBrief({ voice })}>
              {#each VOICES as [v, label]}<option value={v}>{label}</option>{/each}
            </select>
          </div>
        </Section>

        <Section title="About you" summary={[place, units === "metric" ? "Celsius" : "Fahrenheit"].filter(Boolean).join(" · ")}>
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
          <button class="btn" onclick={() => saveStyle("instruction", instruction)}>Save</button>
          {#if styleMsg}<p class="mono" role="status">{styleMsg}</p>{/if}
        </Section>

        <Section title="What you follow" summary={interests.length ? plural(interests.length, "topic") : "Nothing yet"}>
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
          <div class="field">
            <label for="news-items">News in your briefing</label>
            <select id="news-items" class="input" bind:value={newsItems} onchange={() => saveBrief({ newsItems: Number(newsItems) })}>
              <option value={0}>None</option>
              <option value={1}>Just one story</option>
              <option value={2}>Up to 2 stories</option>
              <option value={3}>Up to 3 stories</option>
              <option value={5}>Up to 5 stories</option>
            </select>
          </div>
          <p>{goodNewsOn ? "On. Each morning ends with one real, uplifting story." : "Off. Turn it on for one real, uplifting story each morning."}</p>
          <button class="btn {goodNewsOn ? '' : 'primary'}" disabled={briefBusy} onclick={() => saveBrief({ goodNews: !goodNewsOn })}>{goodNewsOn ? "Turn off good news" : "Add a good news story"}</button>
        </Section>

        <Section title="Your teams" summary={teams.length ? plural(teams.length, "team") : "None"}>
          <p>NHL and MLB. Your briefing gets last night's score and today's game. With alerts on, Danny also tells you about an hour before a game and the final score when it ends (quiet hours: in the chat, no buzz).</p>
          {#if teams.length}
            <ul class="topics">
              {#each teams as t (t.id)}
                <li>
                  <span>{t.fullName} <small class="mono">{t.leagueName}</small></span>
                  <span class="row">
                    <button class="btn small" onclick={() => teamAlerts(t)} aria-pressed={t.notify}>{t.notify ? "Alerts on" : "Alerts off"}</button>
                    <button class="btn small" onclick={() => dropTeam(t.id)} aria-label="Stop following {t.fullName}">Remove</button>
                  </span>
                </li>
              {/each}
            </ul>
          {/if}
          <form class="capform" onsubmit={addTeam}>
            <div class="field">
              <label for="team">Add a team</label>
              <select id="team" class="input" bind:value={pick}>
                <option value="">Choose a team</option>
                {#each ["nhl", "mlb"] as lg}
                  <optgroup label={lg.toUpperCase()}>
                    {#each catalog.filter((c) => c.league === lg && !followedKeys.has(`${c.league}:${c.code}`)) as c (c.code)}
                      <option value="{c.league}:{c.code}">{c.fullName}</option>
                    {/each}
                  </optgroup>
                {/each}
              </select>
            </div>
            <button class="btn" disabled={!pick}>Add</button>
          </form>
        </Section>

        <Section title="Starting help" summary={onOff(adhdOn)}>
          <p>{adhdOn ? "On. Danny turns a brain dump into tasks, gives you one thing at a time with a tiny first step, breaks things down when they feel too big, and plans a snooze with you instead of letting a task sit. If a task goes quiet or keeps getting put off, he asks once, kindly, at most one task a day. He never scolds." : "Off. Turn it on if starting is the hard part: Danny will break things down, offer one thing at a time, and help you put things off honestly."}</p>
          <button class="btn {adhdOn ? '' : 'primary'}" disabled={briefBusy} onclick={() => saveBrief({ adhdMode: !adhdOn })}>{adhdOn ? "Turn off starting help" : "Turn on starting help"}</button>
        </Section>

        <Section title="Suggestions" summary={onOff(tipsOn)}>
          <p>{tipsOn ? "On. Now and then, at most once every few days, Danny mentions something he can do that you haven't tried, like an evening wrap-up or news in your brief. He never buzzes your phone for it." : "Off. Danny won't mention things he can do unless you ask."}</p>
          <button class="btn {tipsOn ? '' : 'primary'}" disabled={briefBusy} onclick={() => saveBrief({ tips: !tipsOn })}>{tipsOn ? "Stop the suggestions" : "Allow suggestions"}</button>
        </Section>

        <p class="hint">What Danny remembers and has learned about you lives in <button class="linkbtn" onclick={() => go("memory")}>Memory</button>.</p>
      </div>
    {:else if tab === "routine"}
      <div class="group" role="tabpanel">
        <Section title="Morning briefing" summary={briefOn ? `On · ${briefTime}` : "Off"}>
          <p>Each morning Danny sends your day, how your goals are going, and news on what you care about. It uses web searches, so it costs a few cents a day.</p>
          <button class="btn {briefOn ? '' : 'primary'}" disabled={briefBusy} onclick={() => saveBrief({ briefingEnabled: !briefOn })}>{briefOn ? "Turn off" : "Turn on"}</button>
          {#if briefOn}
            <div class="field">
              <label for="brief-time">Send at (your local time)</label>
              <input id="brief-time" class="input" type="time" bind:value={briefTime} onchange={() => briefTime && saveBrief({ briefingTime: briefTime })} />
            </div>
          {/if}
        </Section>

        <Section title="Evening wrap-up" summary={wrapOn ? `On · ${wrapTime}` : "Off"}>
          <p>Each evening Danny sums up what got done, what's still open and tomorrow's top three. On Sundays it's a weekly review.</p>
          <button class="btn {wrapOn ? '' : 'primary'}" disabled={briefBusy} onclick={() => saveBrief({ wrapupEnabled: !wrapOn })}>{wrapOn ? "Turn off" : "Turn on"}</button>
          {#if wrapOn}
            <div class="field">
              <label for="wrap-time">Send at (your local time)</label>
              <input id="wrap-time" class="input" type="time" bind:value={wrapTime} onchange={() => wrapTime && saveBrief({ wrapupTime: wrapTime })} />
            </div>
          {/if}
        </Section>

        <Section title="Before your events" summary={onOff(prepOn)}>
          <p>{prepOn ? "On. About an hour before an event with a place or people (10 minutes before a video call), Danny sends where it is, who's going, the join link and your last email with them. Needs Google Calendar connected. Quiet hours: it goes in the chat without a buzz." : "Off. Turn it on and Danny will send a short heads-up before each event: where, who, the join link, and your last email with them. Needs Google Calendar connected."}</p>
          <button class="btn {prepOn ? '' : 'primary'}" disabled={briefBusy} onclick={() => saveBrief({ eventPrep: !prepOn })}>{prepOn ? "Turn off event heads-ups" : "Turn on event heads-ups"}</button>
        </Section>

        <Section title="Quiet hours" summary="{HOURS[quietStart]?.[1]} to {HOURS[quietEnd]?.[1]}">
          <p>Repeat reminders and watch alerts stay silent in this window. The first reminder at the time you asked for always comes through.</p>
          <div class="field">
            <label for="qs">Quiet from</label>
            <select id="qs" class="input" bind:value={quietStart} onchange={() => saveBrief({ quietStart })}>{#each HOURS as [h, label]}<option value={h}>{label}</option>{/each}</select>
          </div>
          <div class="field">
            <label for="qe">Until</label>
            <select id="qe" class="input" bind:value={quietEnd} onchange={() => saveBrief({ quietEnd })}>{#each HOURS as [h, label]}<option value={h}>{label}</option>{/each}</select>
          </div>
        </Section>

        <Section title="Notifications" summary={notify === "checking" ? "" : notify === "on" ? "On for this device" : notify === "off" ? "Off" : notify === "denied" ? "Blocked" : "Not available"}>
          {#if notify === "checking"}
            <p class="mono">Checking…</p>
          {:else if notify === "unconfigured"}
            <p>Push isn't set up on this server yet. Reminders still show up in your chat.</p>
          {:else if notify === "unsupported"}
            <p>{ios && !app.installed ? "On iPhone, add Danny to your Home Screen first (see Install in Account), then come back here." : "This browser can't receive notifications. Reminders still show up in your chat."}</p>
          {:else if notify === "denied"}
            <p>Notifications are blocked for this site. Allow them in your browser settings, then come back.</p>
          {:else}
            <p>{notify === "on" ? "Reminders will buzz this device. Repeat nudges wait out your quiet hours." : "Get reminders on this device, even when Danny is closed."}</p>
            <button class="btn {notify === 'on' ? '' : 'primary'}" disabled={notifyBusy} onclick={toggleNotify}>{notify === "on" ? "Turn off" : "Turn on"}</button>
          {/if}
        </Section>
      </div>
    {:else}
      <div class="group" role="tabpanel">
        <Connections />

        <Section title="Danny" summary={s?.killSwitch ? "Stopped" : "Running"}>
          <div class="state">
            <span class="lamp" class:off={s?.killSwitch}></span>
            <strong class="mono big" class:off={s?.killSwitch}>{s?.killSwitch ? "Stopped" : "Running"}</strong>
          </div>
          <p>{s?.killSwitch ? "Danny won't answer or spend anything until you start him again." : "One tap stops everything. Danny won't answer or spend until you start him again."}</p>
          <button class="btn {s?.killSwitch ? 'primary' : 'warn'}" onclick={toggle}>{s?.killSwitch ? "Start Danny" : "Stop Danny"}</button>
        </Section>

        <Section title="Model and usage" summary={s ? `${s.usedPercent}% used today` : ""}>
          {#if s}
            <p class="mono big">{s.demo ? "None (demo mode)" : s.model}</p>
            <div class="meter" role="img" aria-label="{s.usedPercent}% of today's usage"><b style:width="{pct}%"></b></div>
            <p class="mono">{s.usedPercent}% used · resets in {resetsIn(s.resetsAt)}</p>
            <p>{s.usedPercent >= 100 ? "You've used all of today's allowance. Danny is back at midnight UTC." : "Danny stops for the day when the bar is full. It resets at midnight UTC."} Each message sends your recent chat and memory along with it, so a short reply uses more than its length suggests.</p>
            {#if s.canSetCap}
              <p class="mono">{usd(s.priceInputPerMtokUsd ?? 0)} per million tokens in, {usd(s.priceOutputPerMtokUsd ?? 0)} out · {s.priceSource === "env" ? "set by hand in .env" : s.priceSource === "list" ? "Anthropic's list price" : "model not in the price book"}</p>
              {#if s.priceDiffersFromList}
                <p class="warn">These differ from Anthropic's list price for {s.model} ({usd(s.priceListInputPerMtokUsd ?? 0)} in, {usd(s.priceListOutputPerMtokUsd ?? 0)} out). Remove PRICE_INPUT_PER_MTOK_USD and PRICE_OUTPUT_PER_MTOK_USD from .env on the server, then restart, to use the list price.</p>
              {:else if s.priceSource === "unknown-model"}
                <p class="warn">{s.model} isn't in the price book, so Danny is pricing it as the dearest model to be safe. Set the two PRICE lines in .env.</p>
              {/if}
              <p class="mono">{usd(s.spentTodayUsd ?? 0)} used of {usd(s.dailyCapUsd ?? 0)} · real cost ${(s.costTodayUsd ?? 0).toFixed(4)}</p>
              <form class="capform" onsubmit={saveCap}>
                <div class="field">
                  <label for="cap">Your daily limit in US dollars (owner only)</label>
                  <input id="cap" class="input" type="number" min="0" step="0.5" inputmode="decimal" bind:value={cap} />
                </div>
                <button class="btn" disabled={saving}>Save</button>
              </form>
              {#if msg}<p class="mono" role="status">{msg}</p>{/if}
              <p>Change the model with the MODEL setting on the server.</p>
            {/if}
          {/if}
        </Section>

        <Section title="Install" summary={app.installed ? "Installed" : ""}>
          {#if app.installed}
            <p>Danny is installed on this device.</p>
          {:else}
            {#if app.canInstall}<button class="btn primary" onclick={installApp}>Install Danny</button>{/if}
            {#if device === "ios"}
              <ol class="steps"><li>Open Danny in Safari (iOS 16.4 or later).</li><li>Tap Share.</li><li>Tap Add to Home Screen.</li></ol>
            {:else if device === "android"}
              {#if !app.canInstall}<ol class="steps"><li>Open the browser menu.</li><li>Tap Install app.</li></ol>{/if}
            {:else if !app.canInstall}
              <ol class="steps"><li>In Chrome or Edge, click the install icon in the address bar.</li><li>Click Install.</li></ol>
            {/if}
          {/if}
        </Section>

        <Section title="What's stored">
          <p>Your memory, messages and drafts are encrypted before they're saved. Your email and the titles of your approval cards are not. Spend is counted, never the content.</p>
        </Section>

        <Section title="Your account" summary={app.me?.user.email ?? ""}>
          <p class="mono who">{app.me?.user.email}</p>
          <div class="row">
            {#if app.me?.isOwner}<button class="btn" onclick={() => go("owner")}>Owner tools</button>{/if}
            <button class="btn" onclick={signOut}>Sign out</button>
          </div>
        </Section>
      </div>
    {/if}
  </div>
</div>

<style>
  .page { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 24px 40px; }
  .col { width: min(640px, 100%); margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
  .seg { display: grid; grid-template-columns: repeat(3, 1fr); border: 1px solid var(--line); background: var(--panel); padding: 3px; gap: 3px; }
  .segbtn { min-height: 44px; background: none; border: 0; color: var(--muted); font: 600 1rem/1 var(--body); }
  .segbtn:hover { color: var(--paper); }
  .segbtn.on { background: var(--graphite); color: var(--paper); box-shadow: inset 0 -3px 0 var(--run); }
  .group { border-top: 1px solid var(--line); }
  .hint { color: var(--muted); font-size: .9375rem; padding: 16px 4px 0; }
  .linkbtn { background: none; border: 0; padding: 0; color: var(--paper); text-decoration: underline; font: inherit; }
  .state { display: flex; align-items: center; gap: 10px; }
  .lamp { width: 14px; height: 14px; background: var(--run); display: block; }
  .lamp.off { background: var(--need); }
  .big { font-size: 1rem; color: var(--run); }
  .big.off { color: var(--need); }
  .warn { color: var(--need); }
  .meter { width: 100%; height: 12px; border: 1px solid var(--line); background: var(--graphite); position: relative; }
  .meter b { position: absolute; inset: 0 auto 0 0; background: var(--run); }
  .capform { display: flex; gap: 12px; align-items: flex-end; width: 100%; max-width: 380px; }
  .capform .field { flex: 1; }
  .who { text-transform: none; letter-spacing: 0; }
  .steps { counter-reset: s; width: 100%; max-width: 46ch; }
  .steps li { counter-increment: s; display: grid; grid-template-columns: 2.4rem 1fr; padding: 10px 0; border-top: 1px solid var(--line); }
  .steps li::before { content: counter(s, decimal-leading-zero); font: 500 .85rem/1.7 var(--mono); color: var(--run); }
  .topics { width: 100%; display: flex; flex-direction: column; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .topics li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); }
  .field { width: 100%; max-width: 380px; }
  @media (max-width: 859px) {
    .page { padding: 12px 16px 28px; padding-left: max(16px, var(--safe-left)); padding-right: max(16px, var(--safe-right)); }
  }
</style>
