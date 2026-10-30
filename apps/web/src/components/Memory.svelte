<script lang="ts">
  import { onMount } from "svelte";
  import { api, type MemoryItem } from "../lib/api";
  import { fmtDay } from "../lib/router.svelte";

  let items = $state<MemoryItem[]>([]);
  let loaded = $state(false);
  let text = $state("");
  let confirming = $state("");
  let error = $state("");

  onMount(async () => {
    try {
      items = (await api<{ items: MemoryItem[] }>("GET", "/v1/memory")).items;
    } catch {
      error = "Couldn't load memory.";
    }
    loaded = true;
  });

  async function add(e: SubmitEvent) {
    e.preventDefault();
    const content = text.trim();
    if (!content) return;
    error = "";
    try {
      const r = await api<{ item: MemoryItem }>("POST", "/v1/memory", { content });
      items.unshift(r.item);
      text = "";
    } catch {
      error = "That didn't save. Try again.";
    }
  }

  async function forget(id: string) {
    try {
      await api("DELETE", `/v1/memory/${id}`);
      items = items.filter((i) => i.id !== id);
    } catch {
      error = "Couldn't forget that one. Try again.";
    }
    confirming = "";
  }
</script>

<div class="page">
  <div class="col">
    <p class="lede">What Danny knows about you and your work. Forgetting deletes it for good.</p>
    <form class="add" onsubmit={add}>
      <label class="sr" for="mem">Something for Danny to remember</label>
      <input id="mem" class="input" placeholder="Marlene prefers texts, not calls" maxlength="1000" bind:value={text} />
      <button class="btn primary" disabled={!text.trim()}>Add</button>
    </form>
    {#if error}<p class="error" role="alert">{error}</p>{/if}

    {#if loaded && items.length === 0}
      <div class="empty">
        <h2 class="display">Nothing yet.</h2>
        <p>Tell Danny in chat, or add a note above. Rates, preferences, how you like things done.</p>
      </div>
    {/if}

    <ul class="list">
      {#each items as m (m.id)}
        <li>
          <div class="body">
            <p>{m.content}</p>
            <span class="mono">{fmtDay(m.createdAt)}</span>
          </div>
          {#if confirming === m.id}
            <div class="ask">
              <button class="btn small warn" onclick={() => forget(m.id)}>Forget it</button>
              <button class="btn small" onclick={() => (confirming = "")}>Keep</button>
            </div>
          {:else}
            <button class="btn small" onclick={() => (confirming = m.id)} aria-label="Forget: {m.content}">Forget</button>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
</div>

<style>
  .page { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 24px 32px; }
  .col { width: min(760px, 100%); margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
  .lede { color: #c9d0c8; }
  .add { display: flex; gap: 10px; }
  .add .btn { min-width: 88px; }
  .empty { padding-top: 4vh; display: flex; flex-direction: column; gap: 12px; }
  .empty h2 { font-size: clamp(2.8rem, 8vw, 4.5rem); }
  .empty p { color: #c9d0c8; max-width: 38ch; }
  .list li { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; border-top: 1px solid var(--line); }
  .body { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .body p { overflow-wrap: anywhere; }
  .ask { display: flex; gap: 8px; flex: none; }
  @media (max-width: 859px) {
    .page { padding: 14px 16px 24px; padding-left: max(16px, var(--safe-left)); padding-right: max(16px, var(--safe-right)); }
    .list li { flex-wrap: wrap; }
  }
</style>
