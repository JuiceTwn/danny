<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Goal, type Task } from "../lib/api";
  import { fmtWhen } from "../lib/router.svelte";

  let items = $state<Task[]>([]);
  let loaded = $state(false);
  let title = $state("");
  let remind = $state("");
  let error = $state("");
  let snoozing = $state("");

  let goals = $state<Goal[]>([]);
  async function loadGoals() {
    try {
      goals = (await api<{ items: Goal[] }>("GET", "/v1/goals")).items;
    } catch {
      /* goals just stay hidden */
    }
  }
  async function setGoal(id: string, body: Record<string, unknown>) {
    error = "";
    try {
      await api("PATCH", `/v1/goals/${id}`, body);
      await loadGoals();
    } catch {
      error = "That didn't go through. Try again.";
    }
  }

  const next = $derived(items[0]);
  const rest = $derived(items.slice(1));

  async function load() {
    try {
      items = (await api<{ items: Task[] }>("GET", "/v1/tasks")).items;
    } catch {
      error = "Couldn't load tasks.";
    }
    loaded = true;
  }
  onMount(() => {
    load();
    loadGoals();
    // Reminders fire on the server, so pick up changes when the app comes back to the front.
    const onShow = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  });

  async function add(e: SubmitEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    error = "";
    try {
      await api("POST", "/v1/tasks", { title: t, ...(remind ? { remindAt: new Date(remind).toISOString() } : {}) });
      title = remind = "";
      await load();
    } catch {
      error = remind ? "That didn't save. Is the reminder time in the future?" : "That didn't save. Try again.";
    }
  }

  async function act(path: string, body?: unknown) {
    error = "";
    try {
      await api("POST", path, body ?? {});
      snoozing = "";
      await load();
    } catch {
      error = "That didn't go through. Try again.";
    }
  }

  const tomorrow9 = () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    return d.toISOString();
  };
</script>

{#snippet card(t: Task, big: boolean)}
  <li class:big>
    <div class="body">
      <p class="title">{t.title}</p>
      {#if t.remindAt || t.dueAt}
        <span class="mono">{t.remindAt ? `Reminds ${fmtWhen(t.remindAt)}` : `Due ${fmtWhen(t.dueAt!)}`}{t.repeat ? ` · Repeats ${t.repeat.every === 1 ? `every ${t.repeat.unit}` : `every ${t.repeat.every} ${t.repeat.unit}s`}` : ""}</span>
      {/if}
    </div>
    {#if snoozing === t.id}
      <div class="ask" role="group" aria-label="Snooze until">
        <button class="btn small" onclick={() => act(`/v1/tasks/${t.id}/snooze`, { minutes: 10 })}>10 min</button>
        <button class="btn small" onclick={() => act(`/v1/tasks/${t.id}/snooze`, { minutes: 60 })}>1 hour</button>
        <button class="btn small" onclick={() => act(`/v1/tasks/${t.id}/snooze`, { until: tomorrow9() })}>Tomorrow</button>
        <button class="btn small" onclick={() => (snoozing = "")}>Cancel</button>
      </div>
    {:else}
      <div class="ask">
        <button class="btn small primary" onclick={() => act(`/v1/tasks/${t.id}/done`)} aria-label="Done: {t.title}">Done</button>
        <button class="btn small" onclick={() => (snoozing = t.id)} aria-label="Snooze: {t.title}">Snooze</button>
      </div>
    {/if}
  </li>
{/snippet}

<div class="page">
  <div class="col">
    <form class="add" onsubmit={add}>
      <label class="sr" for="task">New task</label>
      <input id="task" class="input" placeholder="Call the dentist" maxlength="300" bind:value={title} />
      <label class="sr" for="remind">Remind me at (optional)</label>
      <input id="remind" class="input when" type="datetime-local" bind:value={remind} />
      <button class="btn primary" disabled={!title.trim()}>Add</button>
    </form>
    {#if error}<p class="error" role="alert">{error}</p>{/if}

    {#if loaded && items.length === 0}
      <div class="empty">
        <h2 class="display">Clear.</h2>
        <p>Nothing open. Tell Danny in chat when something comes up and he'll put it here.</p>
      </div>
    {:else if next}
      <section aria-label="Next up">
        <h2 class="mono">Do this now</h2>
        <ul class="list">{@render card(next, true)}</ul>
      </section>
      {#if rest.length}
        <section aria-label="Everything else">
          <h2 class="mono">Everything else</h2>
          <ul class="list">{#each rest as t (t.id)}{@render card(t, false)}{/each}</ul>
        </section>
      {/if}
    {/if}

    {#if goals.length}
      <section aria-label="Goals">
        <h2 class="mono">Goals</h2>
        <ul class="list">
          {#each goals as g (g.id)}
            <li>
              <div class="body">
                <p class="title">{g.title}</p>
                {#if g.notes}<span class="mono">{g.notes}</span>{/if}
                <span class="mono">
                  {g.status === "paused" ? "Paused" : g.checkEveryHours ? `Watching every ${g.checkEveryHours >= 24 && g.checkEveryHours % 24 === 0 ? `${g.checkEveryHours / 24} day${g.checkEveryHours === 24 ? "" : "s"}` : `${g.checkEveryHours} hours`}${g.lastCheckedAt ? `, last checked ${fmtWhen(g.lastCheckedAt)}` : ""}` : "Not watching. Ask Danny in chat to watch it."}
                </span>
              </div>
              <div class="ask">
                {#if g.checkEveryHours}<button class="btn small" onclick={() => setGoal(g.id, { checkEveryHours: null })} aria-label="Stop watching: {g.title}">Stop watching</button>{/if}
                <button class="btn small" onclick={() => setGoal(g.id, { status: g.status === "paused" ? "open" : "paused" })} aria-label="{g.status === 'paused' ? 'Resume' : 'Pause'}: {g.title}">{g.status === "paused" ? "Resume" : "Pause"}</button>
                <button class="btn small primary" onclick={() => setGoal(g.id, { status: "done" })} aria-label="Done: {g.title}">Done</button>
              </div>
            </li>
          {/each}
        </ul>
      </section>
    {/if}
  </div>
</div>

<style>
  .page { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 24px 32px; }
  .col { width: min(760px, 100%); margin: 0 auto; display: flex; flex-direction: column; gap: 22px; }
  .add { display: flex; gap: 10px; flex-wrap: wrap; }
  .add .input:first-of-type { flex: 1 1 220px; }
  .add .when { flex: 0 1 220px; }
  .add .btn { min-width: 88px; }
  section { display: flex; flex-direction: column; gap: 6px; }
  .empty { padding-top: 4vh; display: flex; flex-direction: column; gap: 12px; }
  .empty h2 { font-size: clamp(2.8rem, 8vw, 4.5rem); }
  .empty p { color: #c9d0c8; max-width: 38ch; }
  .list li { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; border-top: 1px solid var(--line); flex-wrap: wrap; }
  .list li.big { padding: 20px 16px; border: 2px solid var(--run); background: var(--panel); }
  .body { min-width: 0; display: flex; flex-direction: column; gap: 4px; flex: 1 1 200px; }
  .title { overflow-wrap: anywhere; }
  .big .title { font: 700 1.9rem/1.05 var(--display); text-transform: uppercase; letter-spacing: .01em; }
  .ask { display: flex; gap: 8px; flex: none; flex-wrap: wrap; }
  @media (max-width: 859px) {
    .page { padding: 14px 16px 24px; padding-left: max(16px, var(--safe-left)); padding-right: max(16px, var(--safe-right)); }
  }
</style>
