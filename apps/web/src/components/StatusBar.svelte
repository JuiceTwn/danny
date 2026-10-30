<script lang="ts">
  import { app } from "../lib/store.svelte";
  import { resetsIn } from "../lib/router.svelte";
  const s = $derived(app.settings);
</script>

<div class="status" role="status">
  {#if s}
    <span class="lamp" class:off={s.killSwitch}></span>
    <span class="word" class:off={s.killSwitch}>{s.killSwitch ? "Stopped" : "Running"}</span>
    <span class="spend mono" title="Resets in {resetsIn(s.resetsAt)}">{s.usedPercent}% used today</span>
    <span class="spend mono model" title="Model in use">{s.demo ? "demo" : s.model}</span>
  {/if}
</div>

<style>
  .status { display: flex; align-items: center; gap: 8px; min-height: 20px; }
  .lamp { width: 10px; height: 10px; background: var(--run); display: block; flex: none; }
  .lamp.off { background: var(--need); }
  .word { font: 500 .75rem/1 var(--mono); letter-spacing: .08em; text-transform: uppercase; color: var(--run); }
  .word.off { color: var(--need); }
  .spend { margin-left: 6px; }
  .model { opacity: .7; }
</style>
