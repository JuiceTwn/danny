import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

// One self-contained page: fonts and styles inlined, so it can be hosted as a single file. See preview/mock.ts.
export default defineConfig({
  root: "preview",
  base: "./",
  plugins: [svelte()],
  build: { target: "es2022", outDir: "../dist-preview", emptyOutDir: true, assetsInlineLimit: 100_000_000, cssCodeSplit: false, sourcemap: false },
});
