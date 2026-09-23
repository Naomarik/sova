// Inventories a project's docs folder and proposes what the site may publish. Read-only: it
// moves, copies and writes nothing. Its output is a proposal to check by reading each file and
// then to show the user, never a decision.
//
//   node .sova/marketing/playbooks/doc-site/inventory-docs.mjs [--dir docs]
//
// Every file under the folder lands in one of four classes:
//   publish?    a markdown doc that reads as documentation. Publishable only after each of its
//               claims is found in the README or .sova/marketing/claims.md.
//   referenced  a file another document outside the folder points at (a README's header image).
//               It stays exactly where it is, or that reference breaks. Never published as a doc.
//   exclude     research, feasibility, wishlist, proposal or notes, by its name or first heading;
//               or notes describing referenced assets. Ideas are never cited as shipped.
//   leave       anything else that isn't markdown and nothing outside the folder uses.
// A doc another file links to is still publish?, but read in place (docs.json), never moved.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { flags, ROOT, run } from "../../lib/pw.mjs";

const RESEARCH = /\b(research|feasibility|wishlist|wish-list|proposals?|rfcs?|spikes?|investigations?|brainstorm\w*|roadmap|drafts?|ideas?|notes|scratch|todo|adrs?|decision-records?|post-?mortems?|retros?|explorations?|prototypes?|plans?|planning)\b/i;
const LINKING = /\.(md|mdx|markdown|html?|astro|vue|svelte)$/i;

const posix = (p) => p.split(path.sep).join("/");
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 });

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" || e.name === ".git" ? [] : walk(full);
    return e.isFile() ? [posix(path.relative(ROOT, full))] : [];
  });
}

/** Every relative URL a markdown or HTML file refers to, resolved to a project path, with its line. */
function linksIn(file) {
  const out = [];
  const lines = fs.readFileSync(path.join(ROOT, file), "utf8").split("\n");
  lines.forEach((line, i) => {
    const urls = [...line.matchAll(/\]\(\s*<?([^)\s>]+)/g), ...line.matchAll(/\b(?:src|href|srcset)\s*=\s*["']([^"']+)["']/gi)].flatMap((m) => m[1].split(",").map((s) => s.trim().split(/\s+/)[0]));
    for (const url of urls) {
      if (!url || /^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(url)) continue;
      const clean = decodeURI(url.split(/[?#]/)[0]);
      if (!clean) continue;
      const target = clean.startsWith("/") ? clean.slice(1) : posix(path.normalize(path.join(path.dirname(file), clean)));
      out.push({ target, where: `${file}:${i + 1}` });
    }
  });
  return out;
}

run(async () => {
  const opts = flags({ dir: "string" });
  const dir = opts.dir ?? ["docs", "doc", "documentation", "wiki"].find((d) => fs.existsSync(path.join(ROOT, d)));
  if (!dir || !fs.existsSync(path.join(ROOT, dir))) throw new Error(`no docs folder found; pass --dir <folder relative to the project root>`);
  const prefix = `${posix(path.normalize(dir)).replace(/\/$/, "")}/`;
  const files = walk(path.join(ROOT, dir)).sort();
  const tracked = new Set(git("ls-files", "-z").split("\0").filter(Boolean));
  // Generated files and the site only restate brand.json, which does count (its mark variants).
  const generated = (f) => f.startsWith(".sova/marketing/") && f !== ".sova/marketing/brand.json";
  const others = [...tracked].filter((f) => !generated(f) && fs.existsSync(path.join(ROOT, f)));

  // Who refers to each file: relative links from markdown and HTML anywhere in the project, plus
  // the file's project path written literally in any tracked file (code, config, manifests).
  const refs = new Map(files.map((f) => [f, []]));
  for (const from of others.filter((f) => LINKING.test(f))) for (const l of linksIn(from)) if (refs.has(l.target) && l.target !== from) refs.get(l.target).push(l.where);
  for (const f of files) {
    let hits = "";
    try {
      hits = git("grep", "-n", "-F", "-e", f);
    } catch {} // git grep exits 1 when nothing matches
    for (const h of hits.split("\n").filter(Boolean)) {
      const where = h.split(":").slice(0, 2).join(":");
      if (!generated(where.split(":")[0]) && !where.startsWith(`${f}:`) && !refs.get(f).includes(where)) refs.get(f).push(where);
    }
  }
  const outside = (f) => refs.get(f).filter((w) => !w.startsWith(prefix));

  const rows = files.map((f) => {
    const md = /\.(md|markdown)$/i.test(f);
    const firstHeading = md ? /^#\s+(.+)$/m.exec(fs.readFileSync(path.join(ROOT, f), "utf8"))?.[1] ?? "" : "";
    const words = `${path.basename(f).replace(/\.[^.]+$/, "").replace(/[_.]/g, "-")} ${firstHeading}`;
    const ext = outside(f);
    const note = tracked.has(f) ? [] : ["untracked"];
    if (!md) {
      if (ext.length) return { file: f, class: "referenced", reason: `used by ${ext.join(", ")}: stays where it is`, note };
      return { file: f, class: "leave", reason: refs.get(f).length ? `used only by ${refs.get(f).join(", ")}` : "nothing refers to it", note };
    }
    const m = RESEARCH.exec(words);
    if (m) return { file: f, class: "exclude", reason: `"${m[0]}" in its ${RESEARCH.test(path.basename(f)) ? "name" : "heading"} (${firstHeading || path.basename(f)}): research and plans are never documentation`, note };
    // Notes that sit beside assets other documents use, with no other doc in the folder, describe
    // those assets (a brand folder's README), not the product.
    const folder = path.posix.dirname(f);
    const siblings = files.filter((o) => path.posix.dirname(o) === folder && o !== f);
    if (folder !== prefix.slice(0, -1) && siblings.length && siblings.every((o) => !/\.(md|markdown)$/i.test(o)) && siblings.some((o) => outside(o).length))
      return { file: f, class: "exclude", reason: `describes the assets beside it, used by ${siblings.filter((o) => outside(o).length).map((o) => outside(o)[0].split(":")[0]).filter((v, i, a) => a.indexOf(v) === i).join(", ")}`, note };
    if (ext.length) note.push(`linked from ${ext.join(", ")}: read in place, never moved`);
    return { file: f, class: "publish?", reason: `reads as documentation (${firstHeading || "no heading"}); check every claim against the README before publishing`, note };
  });

  // A candidate that links to a file the site won't have is a broken link on the site.
  const candidates = rows.filter((r) => r.class === "publish?").map((r) => r.file);
  for (const r of rows.filter((r) => r.class === "publish?"))
    for (const l of linksIn(r.file)) {
      const t = rows.find((o) => o.file === l.target);
      if (t && t.class !== "publish?" && t.class !== "leave") r.note.push(`links to ${l.target} (${t.class}) at line ${l.where.split(":").pop()}`);
      else if (t?.class === "leave" && /\.(md|markdown)$/i.test(l.target)) r.note.push(`links to ${l.target}`);
    }

  console.log(`Docs in ${prefix} (${files.length} files). A proposal: read each file before trusting its class.\n`);
  console.log("| File | Class | Why | Notes |\n|---|---|---|---|");
  for (const r of rows) console.log(`| \`${r.file}\` | ${r.class} | ${r.reason} | ${r.note.join("; ")} |`);
  console.log(`\nProposed docs.json (the publish? files, once their claims check out):\n`);
  console.log(JSON.stringify({ dir: prefix.slice(0, -1), publish: candidates.map((f) => f.slice(prefix.length)) }, null, 2));
  console.log(`\nNothing was moved, copied or written. Show the user this mapping and the excluded files, and wait for a yes.`);
});
