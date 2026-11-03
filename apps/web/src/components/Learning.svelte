<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Style } from "../lib/api";
  import { app } from "../lib/store.svelte";
  import Section from "./Section.svelte";

  // What Danny remembers and learns about you: the two switches and the list of things he has noticed.
  let style = $state<Style>({ instruction: null, location: null, notes: [] });
  let learnOn = $state(true);
  let autoMemOn = $state(true);
  let busy = $state(false);
  let error = $state("");
  $effect(() => {
    if (app.me) {
      learnOn = app.me.user.learnEnabled;
      autoMemOn = app.me.user.autoMemory;
    }
  });
  async function loadStyle() {
    try {
      style = await api<Style>("GET", "/v1/style");
    } catch {
      /* the list just stays empty */
    }
  }
  onMount(loadStyle);
  async function save(patch: { learnEnabled?: boolean; autoMemory?: boolean }) {
    busy = true;
    error = "";
    try {
      const r = await api<{ learnEnabled: boolean; autoMemory: boolean }>("PATCH", "/v1/profile", patch);
      if (app.me) {
        app.me.user.learnEnabled = r.learnEnabled;
        app.me.user.autoMemory = r.autoMemory;
      }
    } catch {
      error = "Couldn't save that. Try again.";
    } finally {
      busy = false;
    }
  }
  async function forgetNote(id: string) {
    try {
      await api("DELETE", `/v1/style/notes/${id}`);
      await loadStyle();
    } catch {
      error = "Couldn't forget that. Try again.";
    }
  }
  async function forgetAll() {
    try {
      await api("DELETE", "/v1/style/notes");
      await loadStyle();
    } catch {
      error = "Couldn't forget those. Try again.";
    }
  }
</script>

<div class="learn">
  <Section title="Remembering" summary={autoMemOn ? "On its own" : "Only when asked"}>
    <p>{autoMemOn ? "After you tell him something about your life or work, Danny quietly keeps what's worth keeping, without being asked. You see it in the chat with an Undo, and in the list above." : "Danny only remembers what you ask him to. Nothing is saved on his own."}</p>
    <button class="btn {autoMemOn ? '' : 'primary'}" disabled={busy} onclick={() => save({ autoMemory: !autoMemOn })}>{autoMemOn ? "Only remember what I ask" : "Let him remember on his own"}</button>
  </Section>
  <Section title="How Danny has learned to help you" summary={style.notes.length ? `${style.notes.length} note${style.notes.length === 1 ? "" : "s"}` : learnOn ? "Nothing yet" : "Off"}>
    <p>How you like to be helped, from what you tell him and how you use him. It only changes his style and timing, never his rules or what needs your approval. You can remove any of it.</p>
    {#if style.notes.length}
      <ul class="notes">
        {#each style.notes as n (n.id)}
          <li><span>{n.note} <span class="mono">({n.kind === "said" ? "you told him" : "he noticed"})</span></span><button class="btn small" onclick={() => forgetNote(n.id)} aria-label="Forget: {n.note}">Forget</button></li>
        {/each}
      </ul>
      <button class="btn" onclick={forgetAll}>Forget all of it</button>
    {/if}
    <button class="btn {learnOn ? '' : 'primary'}" disabled={busy} onclick={() => save({ learnEnabled: !learnOn })}>{learnOn ? "Stop him learning from how I use him" : "Let him learn from how I use him"}</button>
  </Section>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .learn { margin-top: 8px; border-top: 1px solid var(--line); }
  .notes { width: 100%; display: flex; flex-direction: column; }
  .notes li { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 0; border-top: 1px solid var(--line); }
</style>
