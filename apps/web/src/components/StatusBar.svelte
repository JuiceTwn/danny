<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { resetsIn } from "../lib/router.svelte";
  const s = $derived(app.settings);
  // Quiet when all is well: a small lamp. Words appear only when something needs a look.
  const nearLimit = $derived((s?.usedPercent ?? 0) >= 80);
  const tip = $derived(s ? `${s.killSwitch ? "Stopped" : "Running"} · ${s.usedPercent}% used today, resets in ${resetsIn(s.resetsAt)} · ${s.demo ? "demo" : s.model}` : "");
</script>

<div class="status" role="status" title={tip}>
  {#if s}
    <span class="lamp" class:off={s.killSwitch} class:warn={!s.killSwitch && nearLimit}></span>
    {#if s.killSwitch}
      <span class="word off">Stopped</span>
    {:else if nearLimit}
      <span class="word warn">{s.usedPercent}% used today</span>
    {:else}
      <span class="sr">Running, {s.usedPercent}% used today</span>
    {/if}
  {/if}
</div>

<style>
  .status { display: flex; align-items: center; gap: 8px; min-height: 20px; }
  .lamp { width: 8px; height: 8px; border-radius: 50%; background: var(--run); display: block; flex: none; }
  .lamp.off { background: var(--need); }
  .lamp.warn { background: var(--need); }
  .word { font: 500 .75rem/1 var(--mono); letter-spacing: .04em; }
  .word.off, .word.warn { color: var(--need); }
</style>
