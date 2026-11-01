<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { api, ApiError, type AppItem } from "../lib/api";
  import { go, openApp, router } from "../lib/router.svelte";

  let items = $state<AppItem[]>([]);
  let loaded = $state(false);
  let error = $state("");
  let timer: ReturnType<typeof setInterval> | undefined;

  async function load() {
    try {
      items = (await api<{ items: AppItem[] }>("GET", "/v1/apps")).items;
      error = "";
    } catch {
      error = "Couldn't load your apps.";
    } finally {
      loaded = true;
    }
  }
  // Apps being built finish while you watch, so keep looking while any is still working.
  onMount(() => {
    load();
    timer = setInterval(() => {
      if (items.some((i) => i.status !== "ready" && i.status !== "failed") || !router.appId) load();
    }, 5000);
  });
  onDestroy(() => clearInterval(timer));

  const open = $derived(items.find((i) => i.id === router.appId) ?? null);
  const building = (s: AppItem["status"]) => s === "queued" || s === "working" || s === "editing";

  // ---- The open app ----
  let frame = $state<HTMLIFrameElement | null>(null);
  // A page that sends its own frame somewhere else is stopped: the first load is the app, any later one means it navigated away.
  let loads = 0;
  let wandered = $state(false);
  const frameSrc = $derived(open ? `/v1/apps/${open.id}/html?v=${open.version}` : "");
  $effect(() => {
    frameSrc;
    loads = 0;
    wandered = false;
  });
  let saveError = $state("");
  let change = $state("");
  let busy = $state(false);

  /**
   * The page runs in a sandbox with an empty identity, so it can't reach Danny. It asks this page to load and save its progress by
   * posting a message. Only messages from that frame are listened to, and what is saved is a plain object, size-checked on the server.
   */
  async function onMessage(e: MessageEvent) {
    if (!frame || e.source !== frame.contentWindow || !router.appId) return;
    const d = e.data as { danny?: string; id?: number; state?: unknown } | null;
    if (!d || typeof d !== "object") return;
    try {
      if (d.danny === "load") {
        const a = await api<{ state: Record<string, unknown> | null }>("GET", `/v1/apps/${router.appId}`);
        frame.contentWindow?.postMessage({ danny: "state", id: d.id, state: a.state }, "*");
      } else if (d.danny === "save" && d.state && typeof d.state === "object") {
        await api("PUT", `/v1/apps/${router.appId}/state`, { state: d.state });
        saveError = "";
      }
    } catch {
      saveError = "Couldn't save your progress. Check your connection.";
    }
  }
  onMount(() => {
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  });

  async function ask(request: string) {
    if (!router.appId || busy) return;
    busy = true;
    error = "";
    try {
      await api("POST", `/v1/apps/${router.appId}/change`, { request });
      change = "";
      await load();
    } catch (e) {
      error = e instanceof ApiError && e.message ? e.message : "Couldn't ask for that. Try again.";
    } finally {
      busy = false;
    }
  }
  async function retry(id: string) {
    try {
      await api("POST", `/v1/apps/${id}/retry`, {});
      await load();
    } catch {
      error = "Couldn't retry that.";
    }
  }
  let confirmDelete = $state(false);
  async function remove() {
    if (!router.appId) return;
    try {
      await api("DELETE", `/v1/apps/${router.appId}`);
      confirmDelete = false;
      go("apps");
      await load();
    } catch {
      error = "Couldn't delete that.";
    }
  }
</script>

<div class="page">
  {#if router.appId}
    <div class="col wide">
      <div class="bar">
        <button class="btn small" onclick={() => go("apps")}>All apps</button>
        <h2 class="display">{open?.title ?? "App"}</h2>
        {#if open && building(open.status)}<span class="mono run">Updating…</span>{/if}
      </div>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if saveError}<p class="error" role="alert">{saveError}</p>{/if}
      {#if open && open.status === "failed"}
        <p>Danny couldn't build this one{open.error ? `: ${open.error}` : "."}</p>
        <button class="btn primary" onclick={() => retry(open.id)}>Try again</button>
      {:else if open && (open.status === "queued" || (open.status === "working" && open.version === 0))}
        <p role="status">Danny is building this. It takes a couple of minutes, and you'll get a message when it's ready. You can leave this page.</p>
      {:else if open}
        <!-- No allow-same-origin: the page gets an empty identity, no cookies or storage, and can't call Danny. The server sends the same lock as a header. -->
        {#if wandered}
          <p class="error" role="alert">This app tried to send you to another site, so Danny stopped it. Ask Danny to fix it below.</p>
        {:else}
          <iframe
            bind:this={frame}
            title={open.title}
            src={frameSrc}
            sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
            referrerpolicy="no-referrer"
            onload={() => { if (++loads > 1) wandered = true; }}
          ></iframe>
        {/if}
        <form class="change" onsubmit={(e) => { e.preventDefault(); if (change.trim()) ask(change.trim()); }}>
          <label class="sr" for="chg">Ask for a change</label>
          <input id="chg" class="input" placeholder="Make it harder, add a quiz, the metronome is broken…" maxlength="600" bind:value={change} />
          <button class="btn primary" disabled={busy || !change.trim()}>Change it</button>
        </form>
        <p class="mono hint">Each change takes a couple of minutes and costs a few cents of your allowance. Your progress is kept.</p>
        <div class="del">
          {#if confirmDelete}
            <span>Delete this app and its progress?</span>
            <button class="btn small" onclick={remove}>Yes, delete</button>
            <button class="btn small" onclick={() => (confirmDelete = false)}>Cancel</button>
          {:else}
            <button class="link" onclick={() => (confirmDelete = true)}>Delete this app</button>
          {/if}
        </div>
      {:else if loaded}
        <p>Couldn't find that app.</p>
      {/if}
    </div>
  {:else}
    <div class="col">
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      {#if loaded && items.length === 0}
        <div class="empty">
          <h2 class="display">No apps yet.</h2>
          <p>Tell Danny what you want to learn or keep track of, like "I'm starting electric guitar", and he'll build you your own little app for it.</p>
        </div>
      {:else}
        <ul class="list">
          {#each items as a (a.id)}
            <li>
              <button class="row" onclick={() => openApp(a.id)}>
                <span class="t">{a.title}</span>
                <span class="mono {a.status === 'failed' ? 'bad' : building(a.status) ? 'run' : ''}">{a.status === "failed" ? "Couldn't build" : building(a.status) ? "Building…" : "Open"}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>

<style>
  .page { height: 100%; overflow: auto; padding: 20px; }
  .col { max-width: 720px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
  .col.wide { max-width: 960px; }
  .bar { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .bar h2 { font-size: 1.5rem; flex: 1 1 auto; }
  iframe { width: 100%; height: min(72vh, 780px); border: 2px solid var(--line); background: #15171a; }
  .change { display: flex; gap: 8px; flex-wrap: wrap; }
  .change .input { flex: 1 1 260px; }
  .hint { color: var(--muted); font-size: .8125rem; text-transform: none; letter-spacing: 0; }
  .list { display: flex; flex-direction: column; gap: 8px; }
  .row { width: 100%; display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 16px; background: var(--panel); border: 2px solid var(--line); text-align: left; }
  .row:hover { border-color: var(--run); }
  .t { font-weight: 600; font-size: 1.125rem; overflow-wrap: anywhere; }
  .run { color: var(--run); }
  .bad { color: var(--need); }
  .del { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .empty { padding: 40px 0; display: flex; flex-direction: column; gap: 8px; }
  .error { color: var(--need); }
</style>
