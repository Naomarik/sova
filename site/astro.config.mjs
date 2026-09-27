// @ts-check
import { defineConfig } from "astro/config";

// Static HTML and CSS, no framework integration. The only scripts are two small inline ones
// (theme toggle, copy button) in src/layouts/Base.astro.
export default defineConfig({
  output: "static",
  build: { inlineStylesheets: "auto" },
  devToolbar: { enabled: false },
  server: { port: 4340, host: true },
});
