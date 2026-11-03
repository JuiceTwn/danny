<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { go, router } from "../lib/router.svelte";
  import Tasks from "./Tasks.svelte";
  import Waiting from "./Waiting.svelte";
  // Tasks and the things waiting on your tap are one job: what's on your plate. One page, one switch.
</script>

<div class="todo">
  <div class="bar">
    <div class="seg" role="tablist" aria-label="Your list">
      <button role="tab" class="segbtn" class:on={router.current === "tasks"} aria-selected={router.current === "tasks"} onclick={() => go("tasks")}>Tasks</button>
      <button role="tab" class="segbtn" class:on={router.current === "waiting"} aria-selected={router.current === "waiting"} onclick={() => go("waiting")}>
        Needs you{#if app.pending > 0}<span class="badge" aria-label="{app.pending} waiting">{app.pending}</span>{/if}
      </button>
    </div>
  </div>
  {#if router.current === "waiting"}<Waiting />{:else}<Tasks />{/if}
</div>

<style>
  .todo { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .bar { padding: 14px 24px 0; }
  .seg { width: min(760px, 100%); margin: 0 auto; display: grid; grid-template-columns: 1fr 1fr; max-width: 320px; margin-left: max(0px, calc((100% - 760px) / 2)); border: 1px solid var(--line); background: var(--panel); padding: 3px; gap: 3px; }
  .segbtn { min-height: 44px; display: inline-flex; align-items: center; justify-content: center; gap: 8px; background: none; border: 0; color: var(--muted); font: 600 1rem/1 var(--body); }
  .segbtn:hover { color: var(--paper); }
  .segbtn.on { background: var(--graphite); color: var(--paper); box-shadow: inset 0 -3px 0 var(--run); }
  .badge { min-width: 22px; height: 22px; padding: 0 6px; display: inline-grid; place-items: center; background: var(--need); color: var(--ink); font: 500 .8125rem/1 var(--mono); }
  @media (max-width: 859px) { .bar { padding: 10px 16px 0; padding-left: max(16px, var(--safe-left)); } .seg { max-width: none; margin-left: 0; } }
</style>
