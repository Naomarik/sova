// The site's brand facts come from ../brand.json at build time; nothing here restates them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";

const brand = JSON.parse(readFileSync(new URL("../brand.json", import.meta.url), "utf8"));
const siteUrl = brand.facts.siteUrl ? new URL(brand.facts.siteUrl) : null;

export default defineConfig({
  site: siteUrl ? siteUrl.origin : undefined,
  // A project page (https://owner.github.io/repo/) is served under /repo/.
  base: siteUrl ? siteUrl.pathname : "/",
  output: "static",
  // Never dist/: the project's .gitignore may match dist/ at any depth, and a site that
  // git silently ignores is a site nobody can publish from a clean clone.
  outDir: "./_site",
  trailingSlash: "always",
  build: { format: "directory" },
  devToolbar: { enabled: false },
  // No highlighter theme: code blocks use the brand's two faces and inks, not a third palette.
  markdown: { syntaxHighlight: false },
  // docs.json may publish docs where they already are in the project, outside this folder; the
  // dev server may read them (and the images they reference) from anywhere under the project root.
  vite: { server: { fs: { allow: [fileURLToPath(new URL("../../../", import.meta.url))] } } },
});
