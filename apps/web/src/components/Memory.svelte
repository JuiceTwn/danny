<script lang="ts">
  import { onMount } from "svelte";
  import { api, type MemoryItem, type MemoryKind, type TidiedItem } from "../lib/api";

  let items = $state<MemoryItem[]>([]);
  let tidied = $state<TidiedItem[]>([]);
  let loaded = $state(false);
  let text = $state("");
  let kind = $state<MemoryKind>("fact");
  let query = $state("");
  let confirming = $state("");
  let editing = $state("");
  let draft = $state("");
  let error = $state("");

  const GROUPS: [MemoryKind, string][] = [
    ["preference", "How you like things"],
    ["person", "People"],
    ["plan", "Plans"],
    ["place", "Places"],
    ["fact", "Everything else"],
  ];

  async function load() {
    try {
      const r = await api<{ items: MemoryItem[]; tidied: TidiedItem[] }>("GET", "/v1/memory");
      items = r.items;
      tidied = r.tidied;
    } catch {
      error = "Couldn't load memory.";
    }
    loaded = true;
  }
  onMount(load);

  const shown = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return q ? items.filter((m) => `${m.subject ?? ""} ${m.content}`.toLowerCase().includes(q)) : items;
  });
  const pinned = $derived(shown.filter((m) => m.pinned));
  const grouped = $derived(GROUPS.map(([k, label]) => ({ k, label, rows: shown.filter((m) => !m.pinned && m.kind === k) })).filter((g) => g.rows.length));

  async function add(e: SubmitEvent) {
    e.preventDefault();
    const content = text.trim();
    if (!content) return;
    error = "";
    try {
      await api("POST", "/v1/memory", { content, kind });
      text = "";
      await load();
    } catch {
      error = "That didn't save. Try again.";
    }
  }
  async function patch(id: string, body: Record<string, unknown>) {
    error = "";
    try {
      await api("PATCH", `/v1/memory/${id}`, body);
      await load();
    } catch {
      error = "That didn't save. Try again.";
    }
  }
  async function saveEdit(m: MemoryItem) {
    const t = draft.trim();
    editing = "";
    if (t && t !== m.content) await patch(m.id, { content: t });
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
  async function restore(id: string) {
    try {
      await api("POST", `/v1/memory/${id}/restore`, {});
      await load();
    } catch {
      error = "Couldn't put that back. Try again.";
    }
  }
  const until = (m: MemoryItem) => (m.expired ? "Expired, not used" : m.expiresOn ? `Until ${m.expiresOn}` : "");
</script>

{#snippet row(m: MemoryItem)}
  <li class:dim={m.expired}>
    <div class="body">
      {#if editing === m.id}
        <form onsubmit={(e) => { e.preventDefault(); saveEdit(m); }}>
          <label class="sr" for="edit-{m.id}">Edit this note</label>
          <input id="edit-{m.id}" class="input" maxlength="300" bind:value={draft} />
          <button class="btn small primary">Save</button>
          <button class="btn small" type="button" onclick={() => (editing = "")}>Cancel</button>
        </form>
      {:else}
        <p>{#if m.subject}<strong>{m.subject}:</strong> {/if}{m.content}</p>
        <span class="mono">{until(m)}{until(m) ? " · " : ""}{m.kind === "fact" ? "" : `${m.kind} · `}added {new Date(m.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
      {/if}
    </div>
    {#if editing !== m.id}
      <div class="ask">
        <button class="btn small" class:primary={m.pinned} onclick={() => patch(m.id, { pinned: !m.pinned })} aria-pressed={m.pinned} aria-label="{m.pinned ? 'Unpin' : 'Pin'}: {m.content}">{m.pinned ? "Pinned" : "Pin"}</button>
        <button class="btn small" onclick={() => { editing = m.id; draft = m.content; }} aria-label="Edit: {m.content}">Edit</button>
        {#if confirming === m.id}
          <button class="btn small warn" onclick={() => forget(m.id)}>Forget it</button>
          <button class="btn small" onclick={() => (confirming = "")}>Keep</button>
        {:else}
          <button class="btn small" onclick={() => (confirming = m.id)} aria-label="Forget: {m.content}">Forget</button>
        {/if}
      </div>
    {/if}
  </li>
{/snippet}

<div class="page">
  <div class="col">
    <p class="lede">What Danny knows about you and your work. Pinned notes are always in front of him. The rest he looks up when they matter. Forgetting deletes for good.</p>
    <form class="add" onsubmit={add}>
      <label class="sr" for="mem">Something for Danny to remember</label>
      <input id="mem" class="input" placeholder="Marlene prefers texts, not calls" maxlength="300" bind:value={text} />
      <label class="sr" for="kind">Kind of note</label>
      <select id="kind" class="input kind" bind:value={kind}>
        <option value="fact">Fact</option>
        <option value="preference">Preference</option>
        <option value="person">Person</option>
        <option value="plan">Plan</option>
        <option value="place">Place</option>
      </select>
      <button class="btn primary" disabled={!text.trim()}>Add</button>
    </form>
    {#if error}<p class="error" role="alert">{error}</p>{/if}

    {#if items.length > 6}
      <label class="sr" for="find">Search your notes</label>
      <input id="find" class="input" type="search" placeholder="Search {items.length} notes" bind:value={query} />
    {/if}

    {#if tidied.length}
      <details class="tidied">
        <summary class="mono">Danny tidied {tidied.length} note{tidied.length === 1 ? "" : "s"} recently. See and undo</summary>
        <ul class="list">
          {#each tidied as t (t.id)}
            <li>
              <div class="body">
                {#if t.archived}
                  <p>{t.content}</p>
                  <span class="mono">Merged into another note</span>
                {:else}
                  <p>{t.content}</p>
                  <span class="mono">Was: {t.previous}</span>
                {/if}
              </div>
              <button class="btn small" onclick={() => restore(t.id)}>Undo</button>
            </li>
          {/each}
        </ul>
      </details>
    {/if}

    {#if loaded && items.length === 0}
      <div class="empty">
        <h2 class="display">Nothing yet.</h2>
        <p>Tell Danny in chat, or add a note above. Rates, preferences, how you like things done.</p>
      </div>
    {/if}

    {#if pinned.length}
      <section aria-label="Pinned">
        <h2 class="mono">Always in front of Danny</h2>
        <ul class="list">{#each pinned as m (m.id)}{@render row(m)}{/each}</ul>
      </section>
    {/if}
    {#each grouped as g (g.k)}
      <section aria-label={g.label}>
        <h2 class="mono">{g.label}</h2>
        <ul class="list">{#each g.rows as m (m.id)}{@render row(m)}{/each}</ul>
      </section>
    {/each}
    {#if query && shown.length === 0}<p class="mono">Nothing matches "{query}".</p>{/if}
  </div>
</div>

<style>
  .page { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 24px 32px; }
  .col { width: min(760px, 100%); margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
  .lede { color: #c9d0c8; }
  .add { display: flex; gap: 10px; flex-wrap: wrap; }
  .add .input:first-of-type { flex: 1 1 240px; }
  .add .kind { flex: 0 0 130px; width: auto; }
  .add .btn { min-width: 88px; }
  section { display: flex; flex-direction: column; gap: 6px; }
  section h2 { font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
  .empty { padding-top: 4vh; display: flex; flex-direction: column; gap: 12px; }
  .empty h2 { font-size: clamp(2.8rem, 8vw, 4.5rem); color: var(--paper); letter-spacing: 0; text-transform: uppercase; }
  .empty p { color: #c9d0c8; max-width: 38ch; }
  .list li { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; border-top: 1px solid var(--line); }
  .list li.dim p { color: var(--muted); }
  .body { min-width: 0; display: flex; flex-direction: column; gap: 4px; flex: 1; }
  .body p { overflow-wrap: anywhere; }
  .body form { display: flex; gap: 8px; flex-wrap: wrap; }
  .body form .input { flex: 1 1 200px; }
  .ask { display: flex; gap: 8px; flex: none; flex-wrap: wrap; }
  .tidied { border: 1px solid var(--line); padding: 10px 14px; }
  .tidied summary { cursor: pointer; color: var(--muted); }
  @media (max-width: 859px) {
    .page { padding: 14px 16px 24px; padding-left: max(16px, var(--safe-left)); padding-right: max(16px, var(--safe-right)); }
    .list li { flex-wrap: wrap; }
  }
</style>
