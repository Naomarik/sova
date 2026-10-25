// Run: pnpm test -- scripts/agent-guides.test.ts. The agent guides hold together: AGENTS.md's "Areas of
// work" table reaches every agents/**/overview.md through overview links; every relative markdown link
// in AGENTS.md and agents/ resolves (a `#anchor` into a markdown file to one of its headings); every
// backticked repo path there exists; and every guide's front-matter `watches`/`alsoUpdate` glob names a
// file (the merge round's also-update nudge reads them). fs and git only.
//
// A backticked token is a repo path when its first segment is a top-level entry of the repo (`server/…`,
// `pi-config/…`, `AGENTS.md`); anything else (`accounts.ts`, `mode.json`, `zai/glm-5.3`) is not checked.
// Exempt on purpose: placeholders (`<agent dir>/…`, `<pi>/…`), elisions (`…`, `...`), and paths git
// ignores (generated or local: `.cache/test-audit.json`, `.agent/…`, `node_modules/…`). A glob must
// match at least one file. A trailing `:12` or `:12-20` line reference and `#anchor` are dropped first.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { test } from "node:test";

const REPO = resolve(import.meta.dirname, "..");

const git = (root: string, args: string[], input?: string) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 << 20 });

/** A path glob as a whole-path RegExp: `**` any depth, `*` within a segment, `{a,b}` either. */
function globRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") re += "(?:";
    else if (c === "}") re += ")";
    else if (c === ",") re += "|";
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to dashes. */
const slug = (heading: string) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");

function anchorsOf(text: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fence = false;
  for (const line of text.split("\n")) {
    if (/^\s*```/.test(line)) fence = !fence;
    const m = !fence && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[1].replace(/`/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

/** Markdown text with fenced code blocks blanked (links and paths in them are examples). */
const prose = (text: string) => text.replace(/^\s*```[\s\S]*?^\s*```/gm, (b) => b.replace(/[^\n]/g, " "));

function frontMatter(text: string): { watches: string[]; alsoUpdate: string[] } | null {
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (!m) return null;
  const out = { watches: [] as string[], alsoUpdate: [] as string[] };
  for (const line of m[1].split("\n")) {
    const kv = /^(watches|alsoUpdate):\s*(.+)$/.exec(line);
    if (kv) out[kv[1] as "watches" | "alsoUpdate"] = JSON.parse(kv[2]);
  }
  return out;
}

/** Every problem with the guides under `root` (a git work tree), one line each. */
function guideProblems(root: string): string[] {
  const problems: string[] = [];
  const files = git(root, ["ls-files", "-co", "--exclude-standard", "-z"]).split("\0").filter(Boolean);
  const fileSet = new Set(files);
  const top = new Set(readdirSync(root).filter((n) => n !== ".git"));
  const ignored = (paths: string[]) => {
    if (!paths.length) return new Set<string>();
    try {
      return new Set(git(root, ["check-ignore", "--no-index", "--stdin", "-z"], paths.join("\0") + "\0").split("\0").filter(Boolean));
    } catch {
      return new Set<string>(); // exit 1: none ignored
    }
  };

  const guides: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else if (e.name.endsWith(".md")) guides.push(`${rel}/${e.name}`);
    }
  };
  if (existsSync(join(root, "agents"))) walk("agents");
  if (!existsSync(join(root, "AGENTS.md"))) return ["AGENTS.md is missing"];
  const docs = ["AGENTS.md", ...guides];
  const text = new Map(docs.map((d) => [d, readFileSync(join(root, d), "utf8")]));

  // Links resolve; overview links make the reachability graph.
  const edges = new Map<string, string[]>();
  for (const doc of docs) {
    const body = prose(text.get(doc)!);
    const out: string[] = [];
    for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = m[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      const [path, anchor] = href.split("#") as [string, string | undefined];
      const target = path ? normalize(join(dirname(doc), decodeURIComponent(path))) : doc;
      if (target.startsWith("..") || !existsSync(join(root, target))) {
        problems.push(`${doc}: link ${href} → ${target} does not exist`);
        continue;
      }
      if (anchor && target.endsWith(".md")) {
        const body2 = text.get(target) ?? readFileSync(join(root, target), "utf8");
        if (!anchorsOf(body2).has(anchor)) problems.push(`${doc}: link ${href}: ${target} has no heading #${anchor}`);
      }
      if (/^agents\/.*overview\.md$/.test(target)) out.push(target);
    }
    edges.set(doc, out);
  }
  const reached = new Set<string>(["AGENTS.md"]);
  const queue = ["AGENTS.md"];
  while (queue.length) for (const next of edges.get(queue.shift()!) ?? []) if (!reached.has(next)) { reached.add(next); queue.push(next); }
  for (const g of guides) if (g.endsWith("/overview.md") && !reached.has(g)) problems.push(`${g}: not reachable from AGENTS.md through overview links`);
  // The table itself links every top-level area overview.
  const tableLinks = new Set([...(text.get("AGENTS.md")!.split(/^## Areas of work$/m)[1] ?? "").split(/^## /m)[0].matchAll(/\]\((agents\/[^)#]+)\)/g)].map((m) => m[1]));
  for (const g of guides) if (/^agents\/[^/]+\/overview\.md$/.test(g) && !tableLinks.has(g)) problems.push(`AGENTS.md: the "Areas of work" table does not link ${g}`);

  // Backticked repo paths exist.
  const missing: { doc: string; path: string }[] = [];
  const globMisses: { doc: string; path: string }[] = [];
  for (const doc of docs) {
    for (const m of prose(text.get(doc)!).matchAll(/`([^`\n]+)`/g)) {
      let tok = m[1].trim();
      if (/\s/.test(tok) || /[<>…]|\.\.\./.test(tok) || tok.startsWith("~") || tok.startsWith("$")) continue;
      tok = tok.replace(/#.*$/, "").replace(/:\d+(?:-\d+)?$/, "").replace(/[.,;:]$/, "").replace(/\/$/, "");
      const first = tok.split("/")[0];
      if (!tok || !top.has(first)) continue;
      if (/[*?{]/.test(tok)) {
        const re = globRe(tok);
        if (!files.some((f) => re.test(f))) globMisses.push({ doc, path: tok });
      } else if (!existsSync(join(root, tok))) missing.push({ doc, path: tok });
    }
  }
  const ign = ignored(missing.map((x) => x.path));
  for (const x of missing) if (!ign.has(x.path)) problems.push(`${x.doc}: \`${x.path}\` does not exist`);
  for (const x of globMisses) problems.push(`${x.doc}: \`${x.path}\` matches no file`);

  // Every guide has front-matter whose globs name files.
  for (const g of guides) {
    let fm;
    try { fm = frontMatter(text.get(g)!); } catch (e) { problems.push(`${g}: unreadable front-matter (${(e as Error).message})`); continue; }
    if (!fm) { problems.push(`${g}: no watches/alsoUpdate front-matter`); continue; }
    if (!fm.watches.length) problems.push(`${g}: front-matter watches nothing`);
    for (const p of [...fm.watches, ...fm.alsoUpdate]) {
      const re = globRe(p);
      if (!(fileSet.has(p) || files.some((f) => re.test(f)))) problems.push(`${g}: front-matter path ${p} matches no file`);
    }
  }
  return problems;
}

test("AGENTS.md and agents/: every guide reachable, every link and backticked repo path resolves", () => {
  assert.deepEqual(guideProblems(REPO), []);
});

test("the check reports a dangling link, a missing path, a bad anchor and an orphan guide", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-guides-"));
  try {
    git(root, ["init", "-q"]);
    const w = (rel: string, body: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
    const fm = '---\nwatches: ["server/**"]\nalsoUpdate: []\n---\n';
    w("server/a.ts", "");
    w(".gitignore", ".cache/\n");
    w("AGENTS.md", "# Root\n\n## Areas of work\n\n| A | [agents/server/overview.md](agents/server/overview.md) |\n\n## Rules\n\n`server/a.ts` `.cache/x.json` `<agent dir>/x` `accounts.ts`\n");
    w("agents/server/overview.md", `${fm}# Server\n\n## Rules\n\n[up](../../AGENTS.md#rules) [child](child/overview.md)\n`);
    w("agents/server/child/overview.md", `${fm}# Child\n`);
    assert.deepEqual(guideProblems(root), []);

    w("agents/server/overview.md", `${fm}# Server\n\n[gone](../gone.md) [bad](../../AGENTS.md#nope) \`server/b.ts\` \`server/*.mjs\`\n`);
    w("agents/lost/overview.md", '---\nwatches: ["nowhere/**"]\nalsoUpdate: []\n---\n# Lost\n');
    const p = guideProblems(root);
    assert.ok(p.some((x) => x.includes("link ../gone.md")), p.join("\n"));
    assert.ok(p.some((x) => x.includes("has no heading #nope")), p.join("\n"));
    assert.ok(p.some((x) => x.includes("`server/b.ts` does not exist")), p.join("\n"));
    assert.ok(p.some((x) => x.includes("`server/*.mjs` matches no file")), p.join("\n"));
    assert.ok(p.some((x) => x.startsWith("agents/server/child/overview.md: not reachable")), p.join("\n"));
    assert.ok(p.some((x) => x.startsWith("agents/lost/overview.md: not reachable")), p.join("\n"));
    assert.ok(p.some((x) => x.includes('table does not link agents/lost/overview.md')), p.join("\n"));
    assert.ok(p.some((x) => x.includes("front-matter path nowhere/** matches no file")), p.join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
