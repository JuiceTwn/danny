<script lang="ts">
  import Rich from "./Rich.svelte";
  import { onMount, tick } from "svelte";
  import { api, chatStream, type Card, type HistoryMsg, type Task } from "../lib/api";
  import Cards from "./Cards.svelte";
  import Preview from "./Preview.svelte";
  import { app, refresh } from "../lib/store.svelte";
  import { fmtDay, fmtTime, go } from "../lib/router.svelte";

  type Noticed = { id: string; fact: string; kind: "added" | "updated"; undone?: boolean };
  type Row = { id: number; kind: "user" | "danny" | "note" | "problem" | "approval"; text: string; at: string; code?: string; cards?: Card[]; noticed?: Noticed[] };

  let rows = $state<Row[]>([]);
  let input = $state("");
  let busy = $state(false);
  let loaded = $state(false);
  let logEl: HTMLDivElement;
  let boxEl: HTMLTextAreaElement;
  let stick = true;
  let nextId = 0;
  let controller: AbortController | null = null;
  // Which tasks are still open, so a task card shows Done once the task is finished, even from the Tasks tab or a notification.
  let openTasks = $state(new Set<string>());
  async function loadOpenTasks() {
    try {
      openTasks = new Set((await api<{ items: Task[] }>("GET", "/v1/tasks")).items.map((t) => t.id));
    } catch {
      /* cards just keep what they show */
    }
  }

  const starters = ["Remember that Marlene prefers texts, not calls", "Draft a reply to a customer asking for a quote", "What do you remember about me?"];

  const push = (kind: Row["kind"], text: string, extra: Partial<Row> = {}) => {
    const row: Row = { id: nextId++, kind, text, at: new Date().toISOString(), ...extra };
    rows.push(row);
    return rows[rows.length - 1]!;
  };
  const toBottom = async () => {
    await tick();
    if (stick && logEl) logEl.scrollTop = logEl.scrollHeight;
  };
  const onScroll = () => (stick = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80);

  onMount(async () => {
    try {
      const h = await api<{ messages: HistoryMsg[] }>("GET", "/v1/chat/history?limit=100");
      rows = h.messages.map((m) => ({ id: nextId++, kind: m.role === "user" ? "user" : "danny", text: m.text, at: m.at, cards: m.cards ?? [] }));
    } catch {
      /* start empty */
    }
    loaded = true;
    void loadOpenTasks();
    await toBottom();
    boxEl?.focus();
  });

  function grow() {
    boxEl.style.height = "auto";
    boxEl.style.height = Math.min(boxEl.scrollHeight, 168) + "px";
  }

  async function send(text: string) {
    text = text.trim();
    if (!text || busy) return;
    input = "";
    await tick();
    grow();
    stick = true;
    busy = true;
    push("user", text);
    let live: Row | null = null;
    const turnCards: Card[] = [];
    const mark = rows.length; // rows from here on belong to this turn
    controller = new AbortController();
    // Everything that ends a turn. It runs on "done", so the box is free again while the quiet memory pass finishes, and not twice.
    let settled = false;
    const settle = async () => {
      if (settled) return;
      settled = true;
      // Cards sit under the last thing Danny said this turn.
      if (turnCards.length) {
        const last = rows.slice(mark).reverse().find((r) => r.kind === "danny");
        if (last) last.cards = turnCards;
        else push("danny", "", { cards: turnCards });
      }
      busy = false;
      controller = null;
      void loadOpenTasks();
      await toBottom();
      void refresh();
      boxEl?.focus();
    };
    try {
      for await (const ev of chatStream(text, controller.signal)) {
        if (ev.type === "text") {
          live ??= push("danny", "");
          live.text += ev.text;
        } else {
          live = null;
          if (ev.type === "tool" && ev.name === "remember" && ev.status === "ran") push("note", "Saved to memory.");
          else if (ev.type === "approval") push("approval", ev.title);
          else if (ev.type === "card") turnCards.push(ev.card);
          else if (ev.type === "done") await settle();
          else if (ev.type === "memory") push("note", "", { noticed: ev.notes.map((n) => ({ ...n })) });
          else if (ev.type === "error") push("problem", ev.message, { code: ev.code });
        }
        await toBottom();
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        const busyErr = (err as { status?: number }).status === 429;
        push("problem", busyErr ? "Danny is still on your last message." : "Couldn't reach Danny. Check your connection and try again.");
      }
    } finally {
      await settle();
    }
  }

  // Undo for something Danny noticed on his own: a new note is forgotten, an updated one gets its old wording back.
  async function undo(n: Noticed) {
    try {
      if (n.kind === "added") await api("DELETE", `/v1/memory/${n.id}`);
      else await api("POST", `/v1/memory/${n.id}/restore`, {});
      n.undone = true;
    } catch {
      push("problem", "Couldn't undo that one. You can fix it in the Memory tab.");
    }
  }

  async function turnOn() {
    await api("PATCH", "/v1/settings", { killSwitch: false });
    await refresh();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send(input);
    }
  }
  const showDay = (i: number) => i === 0 || fmtDay(rows[i]!.at) !== fmtDay(rows[i - 1]!.at);
</script>

<div class="chat">
  <div class="log" bind:this={logEl} onscroll={onScroll}>
    <div class="col">
      {#if loaded && rows.length === 0}
        <div class="empty">
          <h2 class="display">Tell Danny what's up.</h2>
          <p>He keeps track of the work, drafts what needs doing, and asks before anything goes out.</p>
          <ul class="starters">
            {#each starters as s}<li><button class="chip" onclick={() => send(s)}>{s}</button></li>{/each}
          </ul>
        </div>
      {/if}
      {#each rows as r, i (r.id)}
        {#if showDay(i)}<p class="day mono">{fmtDay(r.at)}</p>{/if}
        {#if r.kind === "user" || r.kind === "danny"}
          <div class="row {r.kind}" aria-live={r.kind === "danny" && busy ? "polite" : undefined}>
            <div class="who mono">{r.kind === "user" ? "You" : "Danny"}<span>{fmtTime(r.at)}</span></div>
            <div class="text">{#if r.kind === "danny"}{#if r.text}<Rich text={r.text} />{/if}{:else}{r.text}{/if}</div>
            {#if r.kind === "danny" && r.text && i >= rows.length - 6 && !r.cards?.some((c) => c.kind === "list" || c.kind === "place")}
              <Preview text={r.text} />
            {/if}
            {#if r.kind === "danny" && r.cards?.length}
              <Cards cards={r.cards} {openTasks} canReply={!busy && i === rows.length - 1} onreply={(t) => send(t)} onchange={loadOpenTasks} />
            {/if}
          </div>
        {:else if r.kind === "note"}
          <div class="row note">
            <div class="who mono">{r.noticed ? "Noticed" : "Noted"}</div>
            {#if r.noticed}
              <ul class="noticed">
                {#each r.noticed as n (n.id)}
                  <li>
                    <span class:undone={n.undone}>{n.kind === "added" ? "Remembered" : "Updated"}: {n.fact}</span>
                    {#if n.undone}<span class="mono">undone</span>{:else}<button type="button" class="btn small" onclick={() => undo(n)} aria-label="Undo: {n.fact}">Undo</button>{/if}
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="text">{r.text}</p>
            {/if}
          </div>
        {:else if r.kind === "approval"}
          <div class="row approval">
            <div class="who mono need">Needs you</div>
            <div class="text">
              <p>{r.text}</p>
              <button class="btn small warn" onclick={() => go("waiting")}>Review it</button>
            </div>
          </div>
        {:else}
          <div class="row problem" role="alert">
            <div class="who mono need">Stopped</div>
            <div class="text">
              <p>{r.text}</p>
              {#if r.code === "kill_switch"}<button class="btn small" onclick={turnOn}>Turn Danny back on</button>{/if}
            </div>
          </div>
        {/if}
      {/each}
      {#if busy && rows.at(-1)?.kind === "user"}<p class="thinking mono" role="status">Danny is on it</p>{/if}
    </div>
  </div>

  <form class="composer" onsubmit={(e) => { e.preventDefault(); void send(input); }}>
    <div class="col bar">
      <label class="sr" for="msg">Message to Danny</label>
      <textarea
        id="msg" bind:this={boxEl} bind:value={input} rows="1" placeholder={app.settings?.killSwitch ? "Danny is stopped" : "Tell Danny what's up"}
        oninput={grow} onkeydown={onKey} enterkeyhint="send"
      ></textarea>
      {#if busy}
        <button type="button" class="btn warn" onclick={() => controller?.abort()}>Stop</button>
      {:else}
        <button class="btn primary" disabled={!input.trim()}>Send</button>
      {/if}
    </div>
  </form>
</div>

<style>
  .chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .log { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 8px 24px 16px; }
  .col { width: min(760px, 100%); margin: 0 auto; }
  .row { display: grid; grid-template-columns: 88px minmax(0, 1fr); gap: 16px; padding: 14px 0; border-top: 1px solid var(--line); }
  .row:first-of-type { border-top: 0; }
  .who { display: flex; flex-direction: column; gap: 4px; padding-top: 3px; }
  .who span { color: var(--muted); font-weight: 400; text-transform: none; letter-spacing: 0; }
  .who.need { color: var(--need); }
  .row.user .who { color: var(--paper); }
  .row.user .text { border-left: 3px solid var(--paper); padding-left: 14px; }
  .text { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 1.0625rem; line-height: 1.55; }
  .row.note .text { color: var(--muted); }
  .row.approval .text, .row.problem .text { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
  .day { padding: 18px 0 6px; }
  .thinking { padding: 10px 0 0 104px; }
  .empty { padding: 8vh 0 0; display: flex; flex-direction: column; gap: 16px; }
  .empty h2 { font-size: clamp(2.8rem, 8vw, 4.5rem); }
  .empty p { color: #c9d0c8; max-width: 34ch; }
  .starters { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; align-items: flex-start; }
  .chip { min-height: 44px; padding: 8px 14px; text-align: left; background: var(--panel); border: 1px solid var(--line); color: var(--paper); }
  .chip:hover { border-color: var(--run); }

  .composer { border-top: 1px solid var(--line); background: var(--graphite); padding: 12px 24px; }
  .bar { display: flex; gap: 10px; align-items: flex-end; }
  textarea { flex: 1; min-width: 0; resize: none; min-height: 48px; max-height: 168px; padding: 11px 14px; background: var(--panel); border: 2px solid var(--line); color: var(--paper); line-height: 1.4; }
  textarea:focus { border-color: var(--run); outline: none; }
  .bar .btn { min-width: 96px; }

  @media (max-width: 859px) {
    .log { padding: 4px 16px 12px; padding-left: max(16px, var(--safe-left)); padding-right: max(16px, var(--safe-right)); }
    .composer { padding: 10px 16px; padding-left: max(16px, var(--safe-left)); padding-right: max(16px, var(--safe-right)); }
    .row { grid-template-columns: 1fr; gap: 4px; }
    .who { flex-direction: row; gap: 10px; align-items: baseline; padding-top: 0; }
    .thinking { padding-left: 0; }
    .bar .btn { min-width: 78px; padding: 0 16px; }
  }
  .noticed { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; font-size: .9375rem; color: var(--muted); }
  .noticed li { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .noticed .undone { text-decoration: line-through; opacity: .6; }
</style>
