<script lang="ts">
  import { onMount } from "svelte";
  import { api, ApiError, type AgentRun, type Goal, type GoalStep } from "../lib/api";
  import { refresh } from "../lib/store.svelte";
  import { fmtDay } from "../lib/router.svelte";

  let goals = $state<Goal[]>([]);
  let loaded = $state(false);
  let showClosed = $state(false);
  let title = $state("");
  let stepText = $state<Record<string, string>>({});
  let error = $state("");
  let reviewing = $state(false);
  let reviewNote = $state("");

  const next: Record<GoalStep["status"], GoalStep["status"]> = { todo: "doing", doing: "done", done: "todo", blocked: "todo" };
  const label: Record<GoalStep["status"], string> = { todo: "To do", doing: "Doing", done: "Done", blocked: "Waiting" };
  const reasons: Record<string, string> = {
    kill_switch: "Danny is stopped. Start him in Settings.",
    cap_reached: "Daily spend cap reached.",
    run_limit: "He's used today's reviews. Raise the limit in Settings.",
    recent: "He just looked. Give it a minute.",
    model_failed: "The model call failed. Try again.",
    disabled: "Turn on self-review in Settings.",
  };

  async function load() {
    try {
      goals = (await api<{ items: Goal[] }>("GET", `/v1/goals?closed=${showClosed}`)).items;
      error = "";
    } catch {
      error = "Couldn't load goals.";
    }
    loaded = true;
  }
  onMount(load);

  const visible = $derived(showClosed ? goals : goals.filter((g) => g.status === "active"));
  const overdue = (s: GoalStep) => s.dueAt !== null && s.status !== "done" && new Date(s.dueAt) < new Date();

  async function guarded(f: () => Promise<unknown>, fallback = "That didn't go through. Try again.") {
    error = "";
    try {
      await f();
      await load();
    } catch (e) {
      error = e instanceof ApiError && e.status === 409 && e.message !== "limit" ? e.message : fallback;
    }
  }

  const add = (e: SubmitEvent) => {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    return guarded(async () => {
      await api("POST", "/v1/goals", { title: t });
      title = "";
    });
  };
  const addStep = (g: Goal, e: SubmitEvent) => {
    e.preventDefault();
    const t = (stepText[g.id] ?? "").trim();
    if (!t) return;
    return guarded(async () => {
      await api("POST", `/v1/goals/${g.id}/steps`, { steps: [{ text: t }] });
      stepText[g.id] = "";
    });
  };
  const cycle = (g: Goal, s: GoalStep) => guarded(() => api("PATCH", `/v1/goals/${g.id}/steps/${s.id}`, { status: next[s.status] }));
  const setStatus = (g: Goal, status: Goal["status"]) => guarded(() => api("PATCH", `/v1/goals/${g.id}`, { status }));

  async function reviewNow() {
    reviewing = true;
    reviewNote = error = "";
    try {
      const r = await api<AgentRun>("POST", "/v1/agent/run");
      reviewNote = r.ran ? (r.message ?? "Looked it over. Nothing needs you.") : (reasons[r.reason] ?? "He didn't run.");
      await load();
    } catch {
      error = "Couldn't start a review.";
    } finally {
      reviewing = false;
      void refresh();
    }
  }
  const dueText = (g: Goal) => (new Date(g.nextReviewAt) <= new Date() ? "Review due" : `Next look ${fmtDay(g.nextReviewAt)}`);
</script>

<div class="page">
  <div class="col">
    <p class="lede">What you're after, and Danny's plan for each. He checks these on his own, drafts what he can, and asks before anything goes out.</p>

    <form class="add" onsubmit={add}>
      <label class="sr" for="goal">A goal for Danny to work on</label>
      <input id="goal" class="input" placeholder="Land three new Google Business Profile clients by month end" maxlength="200" bind:value={title} />
      <button class="btn primary" disabled={!title.trim()}>Add</button>
    </form>

    <div class="bar">
      <button class="btn" disabled={reviewing || goals.length === 0} onclick={reviewNow}>{reviewing ? "Looking…" : "Review now"}</button>
      <label class="check"><input type="checkbox" bind:checked={showClosed} onchange={load} /> Show finished</label>
    </div>
    {#if reviewNote}<p class="mono note" role="status">{reviewNote}</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}

    {#if loaded && visible.length === 0}
      <div class="empty">
        <h2 class="display">No goals yet.</h2>
        <p>Tell Danny what you want done, in chat or above. He'll turn it into a plan and keep after it.</p>
      </div>
    {/if}

    <ul class="goals">
      {#each visible as g (g.id)}
        <li class="goal" class:closed={g.status !== "active"}>
          <div class="gh">
            <h2 class="display">{g.title}</h2>
            <div class="tags">
              {#if g.status !== "active"}<span class="tag off">{g.status === "done" ? "Done" : "Dropped"}</span>{/if}
              {#if g.createdBy === "danny"}<span class="tag run">Danny's idea</span>{/if}
            </div>
          </div>
          <p class="mono meta">{g.status === "active" ? dueText(g) : ""}{g.dueAt ? ` · Due ${fmtDay(g.dueAt)}` : ""}</p>
          {#if g.notes}<p class="notes">{g.notes}</p>{/if}

          {#if g.steps.length}
            <ul class="steps">
              {#each g.steps as s (s.id)}
                <li>
                  <button class="step {s.status}" onclick={() => cycle(g, s)} aria-label="{label[s.status]}: {s.text}. Tap to change.">
                    <span class="box" aria-hidden="true">{s.status === "done" ? "✓" : s.status === "doing" ? "…" : s.status === "blocked" ? "!" : ""}</span>
                    <span class="t">{s.text}</span>
                    <span class="mono st">{overdue(s) ? "Overdue" : label[s.status]}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}

          {#if g.status === "active"}
            <form class="addstep" onsubmit={(e) => addStep(g, e)}>
              <label class="sr" for="s-{g.id}">Add a step</label>
              <input id="s-{g.id}" class="input" placeholder="Add a step" maxlength="300" bind:value={stepText[g.id]} />
              <button class="btn small" disabled={!(stepText[g.id] ?? "").trim()}>Add</button>
            </form>
            <div class="gf">
              <button class="btn small" onclick={() => setStatus(g, "done")}>Mark done</button>
              <button class="btn small" onclick={() => setStatus(g, "dropped")}>Drop</button>
            </div>
          {:else}
            <div class="gf"><button class="btn small" onclick={() => setStatus(g, "active")}>Reopen</button></div>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .page { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 24px 32px; }
  .col { width: min(760px, 100%); margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
  .lede { color: #c9d0c8; max-width: 52ch; }
  .add, .addstep { display: flex; gap: 10px; }
  .add .input, .addstep .input { flex: 1; min-width: 0; }
  .bar { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  .check { display: flex; align-items: center; gap: 8px; min-height: 44px; font: 500 .75rem/1 var(--mono); letter-spacing: .06em; text-transform: uppercase; color: var(--muted); }
  .check input { width: 20px; height: 20px; accent-color: var(--run); }
  .note { text-transform: none; letter-spacing: .02em; color: var(--paper); white-space: pre-wrap; }
  .empty { padding: 4vh 0 0; display: flex; flex-direction: column; gap: 12px; }
  .empty h2 { font-size: clamp(2.8rem, 8vw, 4.5rem); }
  .empty p { color: #c9d0c8; max-width: 46ch; }
  .goals { display: flex; flex-direction: column; gap: 18px; }
  .goal { background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--run); padding: 18px; display: flex; flex-direction: column; gap: 12px; }
  .goal.closed { border-left-color: var(--muted); opacity: .8; }
  .gh { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
  .gh h2 { font-size: clamp(1.6rem, 4.5vw, 2.1rem); overflow-wrap: anywhere; }
  .tags { display: flex; gap: 6px; flex-shrink: 0; }
  .meta { text-transform: none; letter-spacing: .02em; }
  .notes { color: #c9d0c8; white-space: pre-wrap; overflow-wrap: anywhere; }
  .steps { display: flex; flex-direction: column; }
  .step { width: 100%; min-height: 48px; display: grid; grid-template-columns: 28px 1fr auto; gap: 12px; align-items: center; padding: 6px 0; background: none; border: 0; border-top: 1px solid var(--line); text-align: left; }
  .step:hover .t { color: var(--run); }
  .box { width: 24px; height: 24px; border: 2px solid var(--paper); display: grid; place-items: center; font: 700 .9rem/1 var(--mono); color: var(--ink); }
  .step.done .box { background: var(--run); border-color: var(--run); }
  .step.doing .box { border-color: var(--run); color: var(--run); }
  .step.blocked .box { background: var(--need); border-color: var(--need); }
  .step.done .t { color: var(--muted); text-decoration: line-through; }
  .t { overflow-wrap: anywhere; }
  .st { text-align: right; }
  .gf { display: flex; gap: 10px; flex-wrap: wrap; }
  @media (max-width: 859px) {
    .page { padding: 14px 16px 24px; padding-left: max(16px, var(--safe-left)); padding-right: max(16px, var(--safe-right)); }
    .goal { padding: 14px; }
  }
</style>
