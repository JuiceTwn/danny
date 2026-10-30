import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [svelte()],
  build: { target: "es2022", sourcemap: false },
  server: { port: 5173, proxy: { "/v1": "http://localhost:8787", "/healthz": "http://localhost:8787" } },
});
