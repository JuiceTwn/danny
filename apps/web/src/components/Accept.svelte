<script lang="ts">
  import { api, ApiError } from "../lib/api";
  import Logo from "./Logo.svelte";

  const token = new URLSearchParams(location.search).get("token") ?? "";
  let name = $state("");
  let password = $state("");
  let busy = $state(false);
  let error = $state("");

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = "";
    try {
      await api("POST", "/v1/auth/accept-invite", { token, password, name });
      location.replace("/");
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "";
      error =
        code === "invite_invalid_or_expired" ? "This invite link has expired or was already used. Ask for a new one." :
        code === "account_exists" ? "That email already has an account. Sign in instead." :
        code === "invalid_request" ? "Use a password of at least 10 characters." :
        "That didn't work. Try again.";
      busy = false;
    }
  }
</script>

<main class="wrap">
  <form class="card" onsubmit={submit}>
    <div class="brand"><Logo size={40} /><span class="display">Danny</span></div>
    <h1 class="display">You're in.</h1>
    <p>Pick a name and a password. That's the whole signup.</p>
    <div class="field">
      <label for="name">What should Danny call you?</label>
      <input id="name" class="input" autocomplete="given-name" bind:value={name} />
    </div>
    <div class="field">
      <label for="pw">Password (10+ characters)</label>
      <input id="pw" class="input" type="password" autocomplete="new-password" minlength="10" required bind:value={password} />
    </div>
    {#if !token}<p class="error" role="alert">This link is missing its invite code.</p>{/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button class="btn primary" disabled={busy || !token}>{busy ? "Creating" : "Create my account"}</button>
  </form>
</main>

<style>
  .wrap { min-height: 100%; display: grid; place-items: center; padding: max(20px, var(--safe-top)) 20px max(20px, var(--safe-bottom)); }
  .card { width: min(420px, 100%); display: flex; flex-direction: column; gap: 18px; }
  .brand { display: flex; align-items: center; gap: 12px; font-size: 2rem; letter-spacing: .06em; margin-bottom: 12px; }
  h1 { font-size: clamp(3rem, 12vw, 4.5rem); }
</style>
