<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../lib/api";

  let { text }: { text: string } = $props();
  type P = { url: string; site: string; title: string; description: string };
  let p = $state<P | null>(null);

  // The first web link in the message, whether it was written as [name](link) or pasted bare.
  const first = (t: string) => t.match(/\]\((https:\/\/[^\s)]+)\)/)?.[1] ?? t.match(/(https:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/)?.[1] ?? null;

  onMount(async () => {
    const url = first(text);
    if (!url) return;
    try {
      p = (await api<{ preview: P }>("GET", `/v1/preview?url=${encodeURIComponent(url)}`)).preview;
    } catch {
      /* no preview: the link is still in the message */
    }
  });
</script>

{#if p}
  <a class="pv" href={p.url} target="_blank" rel="noopener noreferrer">
    <span class="site mono">{p.site}</span>
    <strong>{p.title}</strong>
    {#if p.description}<span class="desc">{p.description}</span>{/if}
  </a>
{/if}

<style>
  .pv { display: flex; flex-direction: column; gap: 4px; margin-top: 12px; padding: 12px 14px; border: 2px solid var(--line); border-left: 4px solid var(--run); background: var(--panel); color: var(--paper); text-decoration: none; overflow-wrap: anywhere; }
  .pv:hover { border-color: var(--run); }
  .site { font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  .desc { color: var(--muted); font-size: .9rem; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
</style>
