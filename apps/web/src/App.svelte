<script lang="ts">
  import { app } from "./lib/store.svelte";
  import Login from "./components/Login.svelte";
  import Accept from "./components/Accept.svelte";
  import Shell from "./components/Shell.svelte";

  const accepting = location.pathname === "/accept";
</script>

{#if accepting}
  <Accept />
{:else if !app.loaded}
  <div class="boot" role="status"><span class="sr">Loading Danny</span></div>
{:else if !app.me}
  <Login />
{:else}
  <Shell />
{/if}

<style>
  .boot { height: 100%; display: grid; place-items: center; }
</style>
