<script lang="ts">
  import type { Snippet } from "svelte";
  // A collapsible row: the title and its current value up front, the details one tap away.
  let { title, summary = "", open = false, children }: { title: string; summary?: string; open?: boolean; children: Snippet } = $props();
</script>

<details class="sec" {open}>
  <summary>
    <span class="t">{title}</span>
    {#if summary}<span class="s">{summary}</span>{/if}
    <svg class="chev" style:margin-left={summary ? "0" : "auto"} viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6" /></svg>
  </summary>
  <div class="body">{@render children()}</div>
</details>

<style>
  .sec { border-bottom: 1px solid var(--line); width: 100%; }
  summary { list-style: none; display: flex; align-items: center; gap: 12px; min-height: 60px; padding: 8px 4px; cursor: pointer; }
  summary::-webkit-details-marker { display: none; }
  summary:hover .t { color: var(--run); }
  .t { font: 600 1.0625rem/1.2 var(--body); flex: none; }
  summary::after { content: none; }
  .s { flex: 0 1 auto; margin-left: auto; min-width: 0; text-align: right; color: var(--muted); font-size: .9375rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chev { flex: none; color: var(--muted); transition: transform .15s; }
  .sec[open] .chev { transform: rotate(90deg); }
  .sec[open] summary { padding-bottom: 4px; }
  .body { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; padding: 8px 4px 24px; }
  .body :global(p) { color: #c9d0c8; max-width: 52ch; }
  .body :global(p.mono) { color: var(--muted); }
</style>
