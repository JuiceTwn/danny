<script lang="ts">
  import { blocks, type Inline } from "../lib/rich";
  let { text, plain = false }: { text: string; plain?: boolean } = $props();
  const parsed = $derived(blocks(text));
</script>

{#snippet run(parts: Inline[])}
  {#each parts as p}
    {#if p.t === "bold"}<strong>{p.v}</strong>
    {:else if p.t === "link"}<a href={p.href} target="_blank" rel="noopener noreferrer">{p.v}</a>
    {:else}{p.v}{/if}
  {/each}
{/snippet}

{#if plain}
  <p class="rich-p">{text}</p>
{:else}
  <div class="rich">
    {#each parsed as b}
      {#if b.t === "ul"}
        <ul>{#each b.items as it}<li>{@render run(it)}</li>{/each}</ul>
      {:else}
        <p>{#each b.lines as ln, i}{#if i > 0}<br />{/if}{@render run(ln)}{/each}</p>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .rich { display: flex; flex-direction: column; gap: 12px; overflow-wrap: anywhere; white-space: normal; }
  .rich p { white-space: normal; }
  .rich ul { list-style: none; display: flex; flex-direction: column; gap: 8px; padding: 0; }
  .rich li { position: relative; padding-left: 18px; }
  .rich li::before { content: ""; position: absolute; left: 2px; top: .62em; width: 7px; height: 7px; background: var(--run); }
  .rich strong { font-weight: 700; color: var(--paper); }
  .rich a { color: var(--run); text-decoration: underline; text-underline-offset: 3px; word-break: break-word; }
</style>
