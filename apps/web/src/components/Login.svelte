<script lang="ts">
  import { api, ApiError } from "../lib/api";
  import { boot } from "../lib/store.svelte";
  import Logo from "./Logo.svelte";

  let email = $state("");
  let password = $state("");
  let busy = $state(false);
  let error = $state("");

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    try {
      await api("POST", "/v1/auth/login", { email, password });
      await boot();
    } catch (err) {
      error = err instanceof ApiError && err.status === 429 ? "Too many tries. Wait a minute." : "Wrong email or password.";
    } finally {
      busy = false;
    }
  }
</script>

<main class="wrap">
  <form class="card" onsubmit={submit}>
    <div class="brand"><Logo size={40} /><span class="display">Danny</span></div>
    <h1 class="display">Sign in</h1>
    <div class="field">
      <label for="email">Email</label>
      <input id="email" class="input" type="email" autocomplete="username" required bind:value={email} />
    </div>
    <div class="field">
      <label for="pw">Password</label>
      <input id="pw" class="input" type="password" autocomplete="current-password" required bind:value={password} />
    </div>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button class="btn primary" disabled={busy}>{busy ? "Signing in" : "Sign in"}</button>
    <p class="mono">Invite only. Got an invite link? Open it.</p>
  </form>
</main>

<style>
  .wrap { min-height: 100%; display: grid; place-items: center; padding: max(20px, var(--safe-top)) 20px max(20px, var(--safe-bottom)); }
  .card { width: min(420px, 100%); display: flex; flex-direction: column; gap: 18px; }
  .brand { display: flex; align-items: center; gap: 12px; font-size: 2rem; letter-spacing: .06em; margin-bottom: 12px; }
  h1 { font-size: clamp(3rem, 12vw, 4.5rem); }
</style>
