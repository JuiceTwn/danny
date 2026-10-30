<script lang="ts">
  import { api, type Card } from "../lib/api";
  import { fmtWhen } from "../lib/router.svelte";

  let { cards, openTasks, canReply, onreply, onchange }: {
    cards: Card[];
    openTasks: Set<string>;
    canReply: boolean;
    onreply: (text: string) => void;
    onchange: () => void;
  } = $props();

  let done = $state<Record<string, string>>({}); // task id -> what just happened, until the list catches up
  let failed = $state("");

  async function act(id: string, what: "done" | "snooze") {
    failed = "";
    try {
      if (what === "done") await api("POST", `/v1/tasks/${id}/done`, {});
      else await api("POST", `/v1/tasks/${id}/snooze`, { minutes: 60 });
      done[id] = what === "done" ? "Done" : "Snoozed an hour";
      onchange();
    } catch {
      failed = id;
    }
  }
  const status = (id: string) => done[id] ?? (openTasks.has(id) ? "" : "Done");
  const maps = (c: Extract<Card, { kind: "place" }>) => encodeURIComponent(c.address ? `${c.name}, ${c.address}` : c.name);
</script>

{#each cards as c}
  {#if c.kind === "task"}
    <div class="card task" class:finished={status(c.id) !== ""}>
      <div class="main">
        <p class="t">{c.title}</p>
        {#if c.remindAt || c.dueAt}<span class="mono">{c.remindAt ? `Reminds ${fmtWhen(c.remindAt)}` : `Due ${fmtWhen(c.dueAt!)}`}</span>{/if}
        {#if failed === c.id}<span class="mono bad">That didn't go through. Try again.</span>{/if}
      </div>
      {#if status(c.id)}
        <span class="badge mono">{status(c.id)}</span>
      {:else}
        <div class="acts">
          <button class="btn small primary" onclick={() => act(c.id, "done")} aria-label="Done: {c.title}">Done</button>
          <button class="btn small" onclick={() => act(c.id, "snooze")} aria-label="Snooze an hour: {c.title}">Snooze 1h</button>
        </div>
      {/if}
    </div>
  {:else if c.kind === "events"}
    <div class="card">
      <h3 class="mono">{c.day}</h3>
      {#if c.items.length === 0}<p class="mono">Nothing on the calendar.</p>{/if}
      <ul class="rows">
        {#each c.items as e}
          <li>
            <span class="when mono">{e.when}</span>
            <span class="what">{e.title}{#if e.where}<span class="sub"> · {e.where}</span>{/if}{#if e.others}<span class="sub"> · with {e.others} other{e.others > 1 ? "s" : ""}</span>{/if}</span>
          </li>
        {/each}
      </ul>
    </div>
  {:else if c.kind === "weather"}
    <div class="card weather">
      <div>
        <h3 class="mono">{c.place}</h3>
        <p class="t">{c.summary}</p>
        {#if c.rain !== null}<span class="mono">{c.rain}% chance of rain</span>{/if}
      </div>
      <div class="temps"><strong>{c.high}</strong><span class="mono">low {c.low}</span></div>
    </div>
  {:else if c.kind === "list"}
    <div class="card">
      {#if c.title}<h3 class="mono">{c.title}</h3>{/if}
      <ul class="rows {c.style}">
        {#each c.items as it, i}
          <li>
            {#if c.style === "steps"}<span class="num mono">{i + 1}</span>{:else if c.style === "check"}<span class="box" aria-hidden="true"></span>{/if}
            <span class="what">
              {#if it.href}<a href={it.href} target="_blank" rel="noopener noreferrer">{it.text}</a>{:else}{it.text}{/if}
              {#if it.sub}<span class="sub block">{it.sub}</span>{/if}
            </span>
          </li>
        {/each}
      </ul>
    </div>
  {:else if c.kind === "table"}
    <div class="card">
      {#if c.title}<h3 class="mono">{c.title}</h3>{/if}
      <div class="scroll">
        <table>
          <thead><tr>{#each c.columns as col}<th>{col}</th>{/each}</tr></thead>
          <tbody>{#each c.rows as r}<tr>{#each c.columns as _, i}<td>{r[i] ?? ""}</td>{/each}</tr>{/each}</tbody>
        </table>
      </div>
    </div>
  {:else if c.kind === "place"}
    <div class="card task">
      <div class="main">
        <p class="t">{c.name}</p>
        {#if c.address}<span class="mono">{c.address}</span>{/if}
        {#if c.note}<span class="sub">{c.note}</span>{/if}
      </div>
      <div class="acts">
        <a class="btn small" href="https://maps.apple.com/?q={maps(c)}" target="_blank" rel="noopener noreferrer">Apple Maps</a>
        <a class="btn small" href="https://www.google.com/maps/search/?api=1&query={maps(c)}" target="_blank" rel="noopener noreferrer">Google Maps</a>
      </div>
    </div>
  {:else if c.kind === "replies" && canReply}
    <div class="replies" role="group" aria-label="Quick replies">
      {#each c.options as o}<button class="chip" onclick={() => onreply(o)}>{o}</button>{/each}
    </div>
  {/if}
{/each}

<style>
  .card { margin-top: 12px; padding: 14px 16px; border: 2px solid var(--line); background: var(--panel); display: flex; flex-direction: column; gap: 8px; }
  .card.task, .card.weather { flex-direction: row; justify-content: space-between; align-items: center; gap: 14px; flex-wrap: wrap; }
  .card.finished { border-color: var(--run); }
  .card.finished .t { color: var(--muted); text-decoration: line-through; }
  h3 { font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  .main { min-width: 0; display: flex; flex-direction: column; gap: 4px; flex: 1 1 180px; }
  .t { font-weight: 600; font-size: 1.0625rem; overflow-wrap: anywhere; }
  .acts { display: flex; gap: 8px; flex-wrap: wrap; }
  .badge { color: var(--run); border: 1px solid var(--run); padding: 6px 10px; text-transform: uppercase; letter-spacing: .08em; font-size: .75rem; }
  .bad { color: var(--need); }
  .rows { display: flex; flex-direction: column; gap: 10px; }
  .rows li { display: flex; gap: 12px; align-items: baseline; }
  .when { flex: 0 0 10.5em; color: var(--muted); font-size: .8125rem; text-transform: none; letter-spacing: 0; }
  .what { min-width: 0; overflow-wrap: anywhere; }
  .sub { color: var(--muted); font-size: .9rem; }
  .sub.block { display: block; }
  .bullets li::before { content: ""; flex: none; width: 7px; height: 7px; background: var(--run); transform: translateY(-1px); }
  .box { flex: none; width: 14px; height: 14px; border: 2px solid var(--line); transform: translateY(2px); }
  .num { flex: none; width: 1.6em; color: var(--run); }
  .weather .t { font-size: 1.25rem; text-transform: capitalize; }
  .temps { display: flex; flex-direction: column; align-items: flex-end; }
  .temps strong { font: 700 2.2rem/1 var(--display); }
  .scroll { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font: 500 .75rem/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); padding: 6px 12px 6px 0; }
  td { padding: 8px 12px 8px 0; border-top: 1px solid var(--line); }
  a { color: var(--run); text-underline-offset: 3px; }
  a.btn { color: var(--paper); text-decoration: none; }
  .replies { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  .chip { min-height: 44px; padding: 8px 16px; text-align: left; background: var(--panel); border: 2px solid var(--run); color: var(--paper); font-weight: 600; cursor: pointer; }
  .chip:hover { background: var(--run); color: var(--ink); }
</style>
