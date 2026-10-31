<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { CallClient, CallError, type CallState } from "../lib/call";
  import { go } from "../lib/router.svelte";

  let { onclose }: { onclose: () => void } = $props();

  let phase = $state<CallState>("connecting");
  let you = $state("");
  let danny = $state("");
  let level = $state(0);
  let secs = $state(0);
  let muted = $state(false);
  let notice = $state("");
  let approval = $state("");
  let ended = $state<string | null>(null);
  let client: CallClient | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let gone = false;

  const clock = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
  const label = $derived(
    ended !== null ? "Call ended" : phase === "connecting" ? "Calling" : phase === "listening" ? (muted ? "Muted" : "Listening") : phase === "thinking" ? "Thinking" : "Talking",
  );

  onMount(async () => {
    client = new CallClient({
      onState: (s) => {
        phase = s;
        if (s === "thinking") danny = "";
      },
      onYou: (t, final) => {
        you = t;
        if (final) {
          danny = "";
          notice = "";
        }
      },
      onDanny: (t) => (danny += t),
      onApproval: (t) => (approval = t),
      onLevel: (l) => (level = l),
      onNotice: (m) => (notice = m),
      onEnded: (_reason, message) => {
        clearInterval(timer);
        // Hung up on purpose: just close. Otherwise say why, and let them close it.
        if (message) ended = message;
        else if (!gone) onclose();
      },
    });
    try {
      await client.start();
      timer = setInterval(() => secs++, 1000);
    } catch (e) {
      ended = e instanceof CallError ? e.message : "Couldn't start the call.";
    }
  });
  onDestroy(() => {
    gone = true;
    clearInterval(timer);
    client?.hangUp();
  });

  const tapOrb = () => phase === "speaking" && client?.interrupt();
  const toggleMute = () => client?.setMuted((muted = !muted));
  const review = () => {
    client?.hangUp();
    onclose();
    go("waiting");
  };
</script>

<div class="call" role="dialog" aria-modal="true" aria-label="Call with Danny">
  <p class="mono top">Danny{#if ended === null && phase !== "connecting"} · {clock(secs)}{/if}</p>

  <button class="orb {phase}" class:muted class:over={ended !== null} style="--lvl:{muted ? 0 : Math.min(1, level * 5)}" onclick={tapOrb} aria-label={phase === "speaking" ? "Interrupt Danny" : label} disabled={phase !== "speaking"}>
    <span class="core"></span>
  </button>

  <p class="status display" role="status">{label}</p>

  <div class="lines" aria-live="polite">
    {#if ended}<p class="end">{ended}</p>{/if}
    {#if you}<p class="you"><span class="mono">You</span>{you}</p>{/if}
    {#if danny}<p class="danny"><span class="mono">Danny</span>{danny}</p>{/if}
    {#if notice}<p class="mono notice">{notice}</p>{/if}
  </div>

  {#if approval && ended === null}
    <div class="ask"><p>Waiting on your tap: {approval}</p><button class="btn small primary" onclick={review}>Review it</button></div>
  {/if}

  <div class="controls">
    {#if ended !== null}
      <button class="btn primary" onclick={onclose}>Close</button>
    {:else}
      <button class="btn" class:on={muted} onclick={toggleMute} aria-pressed={muted}>{muted ? "Unmute" : "Mute"}</button>
      {#if phase === "speaking"}<button class="btn" onclick={tapOrb}>Interrupt</button>{/if}
      <button class="btn warn" onclick={() => client?.hangUp()}>End</button>
    {/if}
  </div>
</div>

<style>
  .call { position: fixed; inset: 0; z-index: 50; display: flex; flex-direction: column; align-items: center; gap: 18px; padding: max(28px, env(safe-area-inset-top)) 24px max(24px, env(safe-area-inset-bottom)); background: var(--graphite); overflow-y: auto; }
  .top { margin-top: 8px; }
  .orb { position: relative; flex: none; width: 190px; height: 190px; margin-top: 4vh; border-radius: 50%; border: 3px solid var(--run); background: transparent; padding: 0; display: grid; place-items: center; cursor: default; transition: transform .12s linear; transform: scale(calc(1 + var(--lvl) * .12)); }
  .orb:not(:disabled) { cursor: pointer; }
  .core { width: 70%; height: 70%; border-radius: 50%; background: var(--panel); border: 2px solid var(--line); transition: background .2s; }
  .orb.listening .core { border-color: var(--run); }
  .orb.thinking .core { background: var(--panel); animation: pulse 1.1s ease-in-out infinite; }
  .orb.speaking .core { background: var(--run); border-color: var(--run); animation: pulse 1.6s ease-in-out infinite; }
  .orb.connecting { border-style: dashed; }
  .orb.muted, .orb.over { border-color: var(--muted); opacity: .6; }
  .status { font-size: 2.2rem; }
  .lines { width: min(520px, 100%); display: flex; flex-direction: column; gap: 14px; min-height: 120px; }
  .lines p { margin: 0; font-size: 1.1rem; line-height: 1.5; overflow-wrap: anywhere; }
  .lines .mono { display: block; margin-bottom: 2px; }
  .you { color: var(--muted); }
  .danny { color: var(--paper); }
  .end { color: var(--need); font-size: 1.25rem; }
  .notice { color: var(--need); }
  .ask { width: min(520px, 100%); display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; background: var(--panel); border: 1px solid var(--need); }
  .ask p { margin: 0; }
  .controls { margin-top: auto; display: flex; gap: 12px; padding-top: 12px; }
  .controls .btn { min-width: 110px; }
  .controls .btn.on { background: var(--paper); color: var(--graphite); }
  @keyframes pulse { 50% { transform: scale(.94); opacity: .8; } }
  @media (prefers-reduced-motion: reduce) { .orb, .core { animation: none !important; transition: none; } }
</style>
