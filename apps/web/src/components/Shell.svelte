<script lang="ts">
  import { app, signOut } from "../lib/store.svelte";
  import { go, router, type Route } from "../lib/router.svelte";
  import Logo from "./Logo.svelte";
  import StatusBar from "./StatusBar.svelte";
  import Chat from "./Chat.svelte";
  import Waiting from "./Waiting.svelte";
  import Memory from "./Memory.svelte";
  import Settings from "./Settings.svelte";
  import Owner from "./Owner.svelte";

  const tabs = $derived<{ id: Route; label: string }[]>([
    { id: "chat", label: "Chat" },
    { id: "waiting", label: "Waiting" },
    { id: "memory", label: "Memory" },
    { id: "settings", label: "Settings" },
    ...(app.me?.isOwner ? [{ id: "owner" as Route, label: "Owner" }] : []),
  ]);
  const titles: Record<Route, string> = { chat: "Chat", waiting: "Waiting on you", memory: "Memory", settings: "Settings", owner: "Owner" };
</script>

<div class="app">
  <nav class="rail" aria-label="Main">
    <div class="brand"><Logo size={30} /><span class="display">Danny</span></div>
    <ul>
      {#each tabs as t (t.id)}
        <li>
          <button class="nav" class:on={router.current === t.id} aria-current={router.current === t.id ? "page" : undefined} onclick={() => go(t.id)}>
            <span>{t.label}</span>
            {#if t.id === "waiting" && app.pending > 0}<span class="badge" aria-label="{app.pending} waiting">{app.pending}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
    <div class="foot">
      <StatusBar />
      <p class="mono who">{app.me?.user.email}</p>
      <button class="link" onclick={signOut}>Sign out</button>
    </div>
  </nav>

  <div class="main">
    {#if !app.online}<p class="offline" role="status">Offline. Danny needs a connection to answer.</p>{/if}
    <header class="top">
      <div class="brand small"><Logo size={26} /></div>
      <h1 class="display">{titles[router.current]}</h1>
      <div class="topstatus"><StatusBar /></div>
    </header>
    <div class="content">
      {#if router.current === "chat"}<Chat />
      {:else if router.current === "waiting"}<Waiting />
      {:else if router.current === "memory"}<Memory />
      {:else if router.current === "settings"}<Settings />
      {:else if router.current === "owner" && app.me?.isOwner}<Owner />
      {/if}
    </div>
  </div>

  <nav class="tabbar" aria-label="Main">
    {#each tabs as t (t.id)}
      <button class="tab" class:on={router.current === t.id} aria-current={router.current === t.id ? "page" : undefined} onclick={() => go(t.id)}>
        <span>{t.label}</span>
        {#if t.id === "waiting" && app.pending > 0}<span class="badge" aria-label="{app.pending} waiting">{app.pending}</span>{/if}
      </button>
    {/each}
  </nav>
</div>

<style>
  .app { height: 100%; display: grid; grid-template-columns: 232px minmax(0, 1fr); }
  .rail { border-right: 1px solid var(--line); background: var(--panel); display: flex; flex-direction: column; padding: 20px 14px; gap: 22px; min-height: 0; }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 1.75rem; letter-spacing: .06em; padding: 0 8px; }
  .rail ul { display: flex; flex-direction: column; gap: 4px; flex: 1; }
  .nav { width: 100%; min-height: 48px; display: flex; align-items: center; justify-content: space-between; padding: 0 12px; background: none; border: 0; border-left: 4px solid transparent;
    font: 600 1.25rem/1 var(--display); text-transform: uppercase; letter-spacing: .06em; color: var(--muted); text-align: left; }
  .nav:hover { color: var(--paper); background: var(--graphite); }
  .nav.on { color: var(--paper); border-left-color: var(--run); background: var(--graphite); }
  .badge { min-width: 24px; height: 24px; padding: 0 6px; display: inline-grid; place-items: center; background: var(--need); color: var(--ink); font: 500 .8125rem/1 var(--mono); }
  .foot { display: flex; flex-direction: column; gap: 10px; padding: 0 8px; }
  .who { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-transform: none; letter-spacing: 0; }
  .link { align-self: flex-start; min-height: 44px; padding: 0; background: none; border: 0; color: var(--muted); text-decoration: underline; font: 500 .75rem/1 var(--mono); text-transform: uppercase; letter-spacing: .06em; }
  .link:hover { color: var(--paper); }

  .main { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; }
  .top { display: flex; align-items: center; gap: 14px; padding: 14px 24px; border-bottom: 1px solid var(--line); min-height: 64px; }
  .top h1 { font-size: 2rem; flex: 1; }
  .brand.small { display: none; padding: 0; }
  .topstatus { display: none; }
  .content { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
  .offline { margin: 0; padding: 8px 24px; background: var(--need); color: var(--ink); font: 500 .8125rem/1.3 var(--mono); text-transform: uppercase; letter-spacing: .04em; }
  .tabbar { display: none; }

  @media (max-width: 859px) {
    .app { grid-template-columns: 1fr; grid-template-rows: minmax(0, 1fr) auto; }
    .rail { display: none; }
    .main { padding-top: var(--safe-top); }
    .top { padding: 10px 16px; padding-left: max(16px, var(--safe-left)); padding-right: max(16px, var(--safe-right)); min-height: 56px; }
    .top h1 { font-size: 1.6rem; }
    .brand.small { display: flex; }
    .topstatus { display: block; }
    .topstatus :global(.spend) { display: none; }
    .tabbar { display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; border-top: 1px solid var(--line); background: var(--panel); padding-bottom: var(--safe-bottom); }
    .tab { position: relative; min-height: 56px; display: flex; align-items: center; justify-content: center; gap: 6px; background: none; border: 0; border-top: 4px solid transparent; font: 600 1.1rem/1 var(--display); text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
    .tab.on { color: var(--paper); border-top-color: var(--run); }
    .offline { padding-left: 16px; }
  }
</style>
