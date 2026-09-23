// Helpers for the docs collection. Relative links between docs ("[x](setup.md#install)") are
// rewritten to the built page's URL by looking the target up in the collection itself, so the
// site never re-implements Astro's id rules. A link to the project's root README.md goes to the
// site's home, which says what the README's opening says. A link to any other file that isn't
// published is left as written and caught by check-site.mjs as a broken link.
import fs from "node:fs";
import path from "node:path";

// npm runs every script in the site folder, which is .sova/marketing/site/ under the project root.
const SITE = process.cwd();
const ROOT = path.resolve(SITE, "..", "..", "..");
const rel = (p) => path.relative(SITE, p).split(path.sep).join("/") || ".";

/** docs.json: the folder, and the explicit list of files in it that the site publishes, in order. */
export const published = (() => {
  const spec = JSON.parse(fs.readFileSync(path.join(SITE, "docs.json"), "utf8"));
  const dir = path.resolve(ROOT, spec.dir);
  for (const f of spec.publish) {
    if (!f.endsWith(".md")) throw new Error(`docs.json: ${f} is not a .md file; only markdown becomes a page`);
    if (/[*?[\]{}()!]/.test(f)) throw new Error(`docs.json: ${f} contains a glob character; list each file by name`);
    if (!fs.existsSync(path.join(dir, f))) throw new Error(`docs.json: ${spec.dir}/${f} does not exist`);
  }
  return { base: rel(dir), files: spec.publish };
})();
const README = path.posix.normalize(rel(path.join(ROOT, "README.md")));

/** A doc's title: frontmatter, else its first "# " heading, else its id. */
export function titleOf(entry) {
  if (entry.data.title) return entry.data.title;
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(entry.body ?? "");
  return h1 ? h1[1] : entry.id;
}

/** True when the doc supplies its own top-level heading, so the page must not add another. */
export const hasOwnH1 = (entry) => /^\s*#\s/.test(entry.body ?? "");

/** The order of docs.json's publish list. */
export function sortDocs(entries) {
  const at = (e) => published.files.indexOf(path.posix.relative(published.base, path.posix.normalize(e.filePath)));
  return [...entries].sort((a, b) => at(a) - at(b));
}

export function rewriteLinks(html, entry, entries, base) {
  const byPath = new Map(entries.map((e) => [path.posix.normalize(e.filePath), e.id]));
  const dir = path.posix.dirname(entry.filePath);
  return html.replace(/href="([^"#:?]+\.md)(#[^"]*)?"/g, (whole, target, hash = "") => {
    const to = path.posix.normalize(path.posix.join(dir, decodeURI(target)));
    if (to === README) return `href="${base}"`;
    const id = byPath.get(to);
    return id === undefined ? whole : `href="${base}docs/${id}/${hash}"`;
  });
}
