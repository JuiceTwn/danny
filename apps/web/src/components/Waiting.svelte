<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Approval } from "../lib/api";
  import { refresh } from "../lib/store.svelte";
  import { fmtDay, fmtTime, go } from "../lib/router.svelte";

  let items = $state<Approval[]>([]);
  let loaded = $state(false);
  let busyId = $state("");
  let notes = $state<Record<string, string>>({});
  let error = $state("");

  const pending = $derived(items.filter((a) => a.status === "pending"));
  const done = $derived(items.filter((a) => a.status !== "pending"));
  const words: Record<string, string> = { approved: "Approved", changes_requested: "Sent back", dropped: "Dropped" };
  // What actually happened, in words. "Sent" only when the server confirmed it.
  function outcome(a: Approval) {
    if (a.status !== "approved" || !a.canExecute) return words[a.status] ?? a.status;
    if (a.execution === "done") return "Sent";
    if (a.execution === "failed") return "Didn't send";
    return a.execution === "running" ? "Sending…" : "Check Gmail";
  }

  async function load() {
    try {
      items = (await api<{ items: Approval[] }>("GET", "/v1/approvals")).items;
    } catch {
      error = "Couldn't load your list. Pull to retry.";
    }
    loaded = true;
    void refresh();
  }
  onMount(load);

  async function decide(a: Approval, decision: "approve" | "changes" | "drop") {
    busyId = a.id;
    error = "";
    try {
      const r = await api<{ item: Approval; note: string }>("POST", `/v1/approvals/${a.id}/decision`, { decision });
      notes[a.id] = r.note;
      const i = items.findIndex((x) => x.id === a.id);
      if (i !== -1) items[i] = r.item;
    } catch {
      error = "That didn't go through. It may already be decided.";
      await load();
    } finally {
      busyId = "";
      void refresh();
    }
  }

  const list = (v: unknown) => (Array.isArray(v) ? v.join(", ") : "");
  const draftOf = (a: Approval) => {
    const p = a.payload;
    // An email card shows exactly what will go out: who, what, and the words.
    if (a.kind === "send_email") {
      return [`To: ${list(p.to)}`, ...(list(p.cc) ? [`Cc: ${list(p.cc)}`] : []), `Subject: ${p.subject}`, ...(p.reply_to_message_id ? ["(Reply in the same thread)"] : []), "", String(p.body ?? "")].join("\n");
    }
    return typeof p.draft === "string" ? p.draft : Object.entries(p).map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`).join("\n");
  };
</script>

<div class="page">
  <div class="col">
    <p class="honest mono">Approving an email sends it from your Gmail right then. Other cards are only recorded: Danny can't act on those yet.</p>
    {#if error}<p class="error" role="alert">{error}</p>{/if}

    {#if loaded && pending.length === 0}
      <div class="empty">
        <h2 class="display">Nothing waiting.</h2>
        <p>When Danny drafts something, it lands here for your tap.</p>
        <button class="btn" onclick={() => go("chat")}>Back to chat</button>
      </div>
    {/if}

    <ul class="tickets">
      {#each pending as a (a.id)}
        <li class="ticket">
          <div class="th"><span class="mono ink">{a.kind} · {fmtDay(a.createdAt)} {fmtTime(a.createdAt)}</span><span class="tag need">Needs you</span></div>
          <div class="tb">
            <h2 class="display">{a.title}</h2>
            {#if draftOf(a)}<blockquote>{draftOf(a)}</blockquote>{/if}
          </div>
          <div class="tf">
            <button class="btn primary" disabled={busyId === a.id} onclick={() => decide(a, "approve")}>{busyId === a.id && a.canExecute ? "Sending…" : a.canExecute ? "Send it" : "Approve"}</button>
            <button class="btn" disabled={busyId === a.id} onclick={() => decide(a, "changes")}>Change</button>
            <button class="btn" disabled={busyId === a.id} onclick={() => decide(a, "drop")}>Drop</button>
          </div>
        </li>
      {/each}
    </ul>

    {#if done.length}
      <h3 class="mono earlier">Earlier</h3>
      <ul class="earlierlist">
        {#each done as a (a.id)}
          <li>
            <span class="tag" class:run={a.status === "approved" && (!a.canExecute || a.execution === "done")} class:need={a.canExecute && (a.execution === "failed" || a.execution === "unknown" || a.execution === "running")} class:off={a.status !== "approved"}>{outcome(a)}</span>
            <span class="t">{a.title}</span>
            <span class="mono">{notes[a.id] ?? a.executionNote ?? (a.decidedAt ? `${fmtDay(a.decidedAt)} ${fmtTime(a.decidedAt)}` : "")}</span>
            {#if a.execution === "failed"}
              <button class="btn small" disabled={busyId === a.id} onclick={() => decide(a, "approve")}>Try again</button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</div>

<style>
  .page { flex: 1; min-height: 0; overflow-y: auto; padding: 20px 24px 32px; }
  .col { width: min(760px, 100%); margin: 0 auto; display: flex; flex-direction: column; gap: 18px; }
  .honest { text-transform: none; letter-spacing: .02em; }
  .empty { padding: 6vh 0 0; display: flex; flex-direction: column; gap: 14px; align-items: flex-start; }
  .empty h2 { font-size: clamp(2.8rem, 8vw, 4.5rem); }
  .empty p { color: #c9d0c8; }
  .tickets { display: flex; flex-direction: column; gap: 20px; }
  .ticket { background: var(--paper); color: var(--ink); }
  .th { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 12px 18px; border-bottom: 2px dashed var(--ink); }
  .mono.ink { color: var(--ink); }
  .tb { padding: 20px 18px 6px; display: flex; flex-direction: column; gap: 16px; }
  .tb h2 { font-size: clamp(1.9rem, 5vw, 2.6rem); }
  blockquote { margin: 0; padding: 14px 16px; border-left: 4px solid var(--ink); background: #dfe4d9; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 1.0625rem; }
  .tf { display: flex; flex-wrap: wrap; gap: 10px; padding: 18px; }
  .ticket .btn { border-color: var(--ink); color: var(--ink); }
  .ticket .btn:hover:not(:disabled) { background: var(--ink); color: var(--paper); }
  .ticket .btn.primary { background: var(--run); }
  .ticket .btn.primary:hover:not(:disabled) { background: var(--ink); color: var(--run); }
  .earlier { margin-top: 12px; }
  .earlierlist { display: flex; flex-direction: column; }
  .earlierlist li { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; padding: 12px 0; border-top: 1px solid var(--line); }
  .earlierlist .t { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; }
  @media (max-width: 859px) {
    .page { padding: 14px 16px 24px; padding-left: max(16px, var(--safe-left)); padding-right: max(16px, var(--safe-right)); }
    .tf .btn { flex: 1 1 30%; padding: 0 10px; }
  }
</style>
