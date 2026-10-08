// @ts-check
import { defineConfig } from "astro/config";

// Static HTML and CSS, no framework integration. The only scripts are two small inline ones
// (theme toggle, copy button) in src/layouts/Base.astro.
export default defineConfig({
  // The address the site is served from; when set, Base.astro makes og:image absolute.
  site: process.env.SOVA_SITE_URL || undefined,
  output: "static",
  build: { inlineStylesheets: "auto" },
  devToolbar: { enabled: false },
  server: { port: 4340, host: true },
  // The docs' code blocks are commands and file names: plain, in the site's own colours.
  markdown: { syntaxHighlight: false },
});
