// After the build: fail if a built /docs page names a spec id or a repository source path. The docs
// are written for people who run Sova, and those belong in the spec, not on the page.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("../dist/docs/", import.meta.url).pathname;
const banned = ["§", "pi-config/", "server/", "src/"];

const pages = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith(".html")) pages.push(p);
  }
};
walk(root);

let bad = 0;
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  for (const word of banned) {
    let at = html.indexOf(word);
    while (at !== -1) {
      bad++;
      console.error(`${page.slice(root.length - 5)}: "${word}" in …${html.slice(Math.max(0, at - 40), at + 40).replace(/\s+/g, " ")}…`);
      at = html.indexOf(word, at + 1);
    }
  }
}
if (!pages.length) { console.error("check-docs-leaks: no pages under dist/docs/"); process.exit(1); }
if (bad) { console.error(`check-docs-leaks: ${bad} leak(s) in ${pages.length} docs page(s)`); process.exit(1); }
console.log(`check-docs-leaks: ${pages.length} docs page(s) clean`);
