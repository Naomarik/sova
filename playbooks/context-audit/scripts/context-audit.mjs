#!/usr/bin/env node
// context-audit: the Context audit playbook's mechanical pass (playbooks/context-audit/PLAYBOOK.md). It reads
// what a project can load into a chat, measures it the way Sova's Context tab does (≈ tokens: characters / 4,
// plus lines), and finds what needs no judgement: references that lead nowhere, pages nothing points to,
// passages that appear twice. It never edits the project, never flips a context switch and never calls Sova.
// Node builtins only, plus git for HEAD and uncommitted files.
//
//   node scripts/context-audit.mjs inventory [--root <checkout>] [--scope <folder|skill>]… [--personal]
//                                            [--switches <file>] [--run <id>] [--json]
//     every item the project can load: where it is, when it loads, its size, whether it is on; the
//     always-loaded total, each skill's entry page in its band, the subjects for the readers and how many.
//     --switches: the answers of Sova's project.context-files.get and project.skills.get, saved to one file
//     ({"files": [...], "skills": [...], "asking": bool}): an item they show off is listed off and not counted.
//     Writes the detail to <state root>/playbooks/context-audit/<run>/inventory.json and names it. First it
//     deletes every other run's folder there last changed over a day ago: what a run stopped before its cleanup
//     left behind. A recent one may be a run still going, and stays.
//   node scripts/context-audit.mjs links [--root …] [--scope …]… [--json]
//     the reference graph: broken links, stale mentions (a named path or package script that doesn't exist),
//     links out of the project, and pages nothing points to.
//   node scripts/context-audit.mjs repeats [--root …] [--scope …]… [--min <chars>] [--json]
//     passages (normalised paragraphs of at least --min characters, default 160) found in more than one place.
//   node scripts/context-audit.mjs check [--root …] --before <inventory.json> [--base <rev>]
//                                        [--moved <old path>=<new path>,<new path>]… [--clean] [--json]
//     the re-check: the numbers before and after, and for each layout change, that every paragraph of the old
//     page (read at --base, default the before inventory's HEAD) is on exactly one of the new pages. --clean
//     deletes the run's working folder (the before file's, under the state root) when nothing failed.
//   node scripts/context-audit.mjs clean --before <inventory.json> [--json]
//     deletes the run's working folder whatever the last check said: the run's last step, always.
//
// Exit 0: nothing to act on. 1: found something to act on. 2: couldn't check (treat as not known to be fine).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const CHARS_PER_TOKEN = 4;
/** Entry-page bands, in lines: up to `fine` is fine, up to `look` worth a look, above heavy. Never a failure. */
export const BANDS = { fine: 150, look: 400 };
/** Per folder, the first of these found is its instruction file (pi's order). */
export const INSTRUCTION_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
/** Where a project keeps its own playbooks (Sova's PROJECT_PLAYBOOK_DIRS). */
export const PROJECT_PLAYBOOK_DIRS = [".sova/playbooks", ".sova/marketing/playbooks"];
export const SKILL_FOLDERS = [".pi/skills", ".agents/skills", ".claude/skills"];
/** Inside a subfolder, the skills folders a chat is offered when it works there. */
export const SUBFOLDER_SKILL_FOLDERS = [".agents/skills", ".claude/skills"];
export const SCAN_CAP = 5000;
export const MIN_REPEAT = 160;
const MAX_PAGES = 3000;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;
const KNOWN_EXT = /\.(md|mdx|mjs|cjs|js|ts|tsx|jsx|json|jsonl|sh|py|css|html|svg|ya?ml|toml|edn|bb|clj|cljs|txt|sql|go|rs)$/;

export const tokensOf = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);
/** Lines as `wc -l` counts them, plus an unterminated last line. */
export const linesOf = (text) => (text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0));
const posix = (p) => p.split(sep).join("/");
const readText = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
};
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const git = (root, ...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
};
const num = (n) => n.toLocaleString("en-US");
const inside = (root, p) => {
  const r = relative(root, p);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};
/** The file's real place is inside the root (a link out of the project never loads). */
const realInside = (root, p) => {
  try {
    return inside(realpathSync(root), realpathSync(p));
  } catch {
    return false;
  }
};

export const stateRoot = () => {
  const a = process.env.PI_CODING_AGENT_DIR;
  const agent = a ? (a === "~" ? homedir() : a.startsWith("~/") ? join(homedir(), a.slice(2)) : a) : join(homedir(), ".pi", "agent");
  return join(agent, "sova");
};
const agentDirOf = () => dirname(stateRoot());
/** Where each run keeps its working folder, `<run>/`. */
const runsDir = () => join(stateRoot(), "playbooks", "context-audit");
/** The run folder a before file sits in, when it is one under runsDir(); else null. */
const runDirOf = (before) => {
  const dir = dirname(resolve(before));
  return inside(runsDir(), dir) && dir !== runsDir() ? dir : null;
};
/** How long a run folder goes unchanged before it counts as a stopped run's leftover. */
export const LEFTOVER_MS = 24 * 60 * 60 * 1000;
/** When a folder last changed: its own time or any of its entries', the latest. */
const lastChanged = (d) => {
  let t = statSync(d).mtimeMs;
  for (const n of readdirSync(d)) {
    try {
      t = Math.max(t, statSync(join(d, n)).mtimeMs);
    } catch {
      // gone meanwhile
    }
  }
  return t;
};
/**
 * Deletes the run folders but `keep` that last changed over a day ago: the ones a run stopped before its cleanup
 * left. A more recent one may belong to a run still going, so it stays. Returns what went.
 */
export function dropLeftoverRuns(keep, now = Date.now()) {
  let names;
  try {
    names = readdirSync(runsDir());
  } catch {
    return [];
  }
  const gone = [];
  for (const n of names) {
    const d = join(runsDir(), n);
    if (d === keep) continue;
    try {
      if (!statSync(d).isDirectory() || now - lastChanged(d) <= LEFTOVER_MS) continue;
    } catch {
      continue;
    }
    rmSync(d, { recursive: true, force: true });
    gone.push(d);
  }
  return gone;
}

// ── front matter ────────────────────────────────────────────────────────────────────────────────

/** A page's front matter as plain key → text (folded `>`/`|` blocks joined), and its body. */
export function frontMatter(text) {
  const m = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fields: {}, body: text };
  const fields = {};
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === ">" || v === "|" || v === ">-" || v === "|-") {
      const parts = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(v.startsWith(">") ? " " : "\n");
    } else if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    fields[kv[1]] = v;
  }
  return { fields, body: text.slice(m[0].length) };
}

// ── walking ─────────────────────────────────────────────────────────────────────────────────────

/** The folders a chat's walk enters below root: no node_modules, no hidden folders, at most SCAN_CAP. */
export function walkFolders(root) {
  const out = [];
  const queue = [root];
  let complete = true;
  while (queue.length) {
    const d = queue.shift();
    if (out.length >= SCAN_CAP) {
      complete = false;
      break;
    }
    out.push(d);
    let names = [];
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name === "node_modules" || e.name.startsWith(".")) continue;
      queue.push(join(d, e.name));
    }
  }
  return { folders: out, complete };
}

/** Every file below dir (hidden ones and node_modules skipped), relative to dir. */
function filesBelow(dir, filter = () => true) {
  const out = [];
  const go = (d) => {
    let names = [];
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names) {
      if (e.name === "node_modules" || (e.name.startsWith(".") && e.name !== ".build")) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) go(p);
      else if (filter(p)) out.push(p);
    }
  };
  go(dir);
  return out.sort();
}

const instructionIn = (dir) => {
  for (const n of INSTRUCTION_NAMES) if (isFile(join(dir, n))) return join(dir, n);
  return null;
};

/** The skills a skills folder holds: each folder with a SKILL.md (searched down, not into a found skill), and
    in pi's own `.pi/skills` a standalone .md file at its top. */
export function skillsIn(dir, { standalone = false } = {}) {
  const out = [];
  const go = (d, top) => {
    if (isFile(join(d, "SKILL.md"))) return out.push({ dir: d, entry: join(d, "SKILL.md") });
    let names = [];
    try {
      names = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const p = join(d, e.name);
      if (e.isDirectory() || (e.isSymbolicLink() && isDir(p))) go(p, false);
      else if (top && standalone && e.name.endsWith(".md")) out.push({ dir: d, entry: p, standalone: true });
    }
  };
  if (isDir(dir)) go(dir, true);
  return out;
}

// ── markdown reading ────────────────────────────────────────────────────────────────────────────

/** Each line outside fenced code, with its number (1-based); fenced lines come back as fenced. */
function scanLines(text) {
  const out = [];
  let fence = null;
  text.split("\n").forEach((line, i) => {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
      out.push({ line, n: i + 1, fenced: true });
      return;
    }
    out.push({ line, n: i + 1, fenced: !!fence });
  });
  return out;
}

const LINK_RE = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const CODE_RE = /`([^`\n]+)`/g;
const RUN_RE = /\b(?:pnpm|npm|yarn|bun)\s+run\s+([\w:.-]+)/g;

/** A token in inline code that names a project path, cleaned; null when it doesn't look like one. */
export function pathToken(tok) {
  let t = tok.trim().replace(/^[("'[]+|[)"',;.\]]+$/g, "");
  t = t.replace(/:\d+(?:[-:]\d+)?$/, "").replace(/#.*$/, "");
  if (!t || t.length > 200) return null;
  if (/^[a-z][\w+.-]*:\/\//i.test(t) || t.startsWith("~") || t.startsWith("/") || t.startsWith("-") || t.startsWith("$")) return null;
  if (/[*?<>{}$|=@!]/.test(t) && !t.startsWith("@")) return null;
  if (!/^[\w@.][\w@./-]*\/?$/.test(t)) return null;
  if (t.includes("...") || /^\d+(\.\d+)+$/.test(t)) return null;
  if (!t.includes("/") && !KNOWN_EXT.test(t)) return null;
  return t;
}

/** The references a page makes: markdown links, and path-like tokens in inline code, with their lines. */
export function referencesOf(text) {
  const out = [];
  for (const { line, n, fenced } of scanLines(text)) {
    if (fenced) continue;
    for (const m of line.matchAll(LINK_RE)) {
      const target = m[1];
      if (/^[a-z][\w+.-]*:/i.test(target) || target.startsWith("#")) continue;
      out.push({ kind: "link", target: decodeURI(target.replace(/#.*$/, "")), line: n });
    }
    for (const m of line.matchAll(CODE_RE)) {
      for (const tok of m[1].split(/\s+/)) {
        const t = pathToken(tok);
        if (t) out.push({ kind: "mention", target: t, line: n });
      }
      for (const r of m[1].matchAll(RUN_RE)) out.push({ kind: "script", target: r[1], line: n });
    }
  }
  return out;
}

/** The page's paragraphs (blank-line separated, fenced code skipped), each normalised, with its first line. */
export function paragraphsOf(text) {
  const out = [];
  let cur = [];
  let start = 0;
  const flush = () => {
    if (cur.length) {
      const raw = cur.join("\n");
      const norm = normalise(raw);
      if (norm) out.push({ norm, line: start, raw });
    }
    cur = [];
  };
  for (const { line, n, fenced } of scanLines(text)) {
    if (fenced || !line.trim() || /^<!--.*-->\s*$/.test(line.trim())) {
      flush();
      continue;
    }
    if (/^\s*(#{1,6}\s|---\s*$|\|?\s*:?-{3,})/.test(line)) {
      flush();
      if (/^\s*#{1,6}\s/.test(line)) {
        cur = [line];
        start = n;
        flush();
      }
      continue;
    }
    if (/^\s*([-*+]|\d+\.)\s/.test(line) && cur.length) flush();
    if (!cur.length) start = n;
    cur.push(line);
  }
  flush();
  return out;
}
export const normalise = (s) =>
  s
    .toLowerCase()
    .replace(/^\s*(?:[-*+>]|\d+\.|#{1,6})\s+/gm, "")
    .replace(/[*_`|#>]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/** The page's `##` sections and their lengths, for a reader judging what could move out. */
export function sectionsOf(text) {
  const out = [];
  const lines = text.split("\n");
  let cur = { heading: "(top)", from: 1 };
  lines.forEach((l, i) => {
    const m = /^#{1,3}\s+(.*)$/.exec(l);
    if (m && i > 0) {
      out.push({ heading: cur.heading, lines: i + 1 - cur.from });
      cur = { heading: m[1].trim(), from: i + 1 };
    }
  });
  out.push({ heading: cur.heading, lines: lines.length - cur.from + (text.endsWith("\n") ? 0 : 1) });
  return out.filter((s) => s.lines > 0);
}

export const bandOf = (lines) => (lines <= BANDS.fine ? "fine" : lines <= BANDS.look ? "worth a look" : "heavy");
const DELIBERATE_RE = /\bread (?:all of this|this whole|the whole of this|this entire|every line of this) (?:file|page|skill)\b/i;
const GENERATED_RE = /(?:edit the (?:model|source)[^.\n]{0,20}not the (?:output|pages|generated)|do not edit|generated (?:by|from) )/i;

// ── inventory ───────────────────────────────────────────────────────────────────────────────────

/** One loadable item, measured. */
function item(root, path, fields) {
  const text = readText(path) ?? "";
  const personal = !inside(root, path);
  return { path: personal ? path : posix(relative(root, path)), abs: path, lines: linesOf(text), tokens: tokensOf(text), on: true, personal, ...fields };
}

/** What the switches file says is off: a set of absolute paths. */
export function offPaths(switches) {
  const off = new Set();
  if (!switches) return off;
  const asking = !!switches.asking;
  for (const row of [...(switches.files ?? []), ...(switches.skills ?? [])]) {
    if (!row || typeof row.path !== "string") continue;
    if (row.state === "disallowed" || (asking && row.state === "waiting")) off.add(resolve(row.path));
  }
  return off;
}

function scopeMatch(scope, it) {
  if (!scope?.length) return true;
  return scope.some((s) => {
    const p = s.replace(/^\.\//, "").replace(/\/$/, "");
    return it.path === p || it.path.startsWith(p + "/") || (it.skill && it.skill === s);
  });
}

/**
 * Everything the project at `root` can load into a chat, and what the mechanical pass finds.
 * opts: scope (folders or skill names), personal (bool), switches (parsed JSON), agentDir, claudeDir, home, minRepeat.
 */
export function inventory(root, opts = {}) {
  root = resolve(root);
  if (!isDir(root)) return { error: `no folder at ${root}` };
  const top = git(root, "rev-parse", "--show-toplevel")?.trim();
  const head = git(root, "rev-parse", "HEAD")?.trim() ?? null;
  const dirty = (git(root, "status", "--porcelain") ?? "").split("\n").filter(Boolean).map((l) => l.slice(3));
  const off = offPaths(opts.switches);
  const items = [];
  const skills = [];
  const outside = [];
  const add = (path, fields) => {
    const it = item(root, path, fields);
    if (off.has(resolve(path))) it.on = false;
    items.push(it);
    return it;
  };

  // Instruction files: the top's in every message, a subfolder's once the agent works there.
  const { folders, complete } = walkFolders(root);
  for (const d of folders) {
    const f = instructionIn(d);
    if (!f) continue;
    if (!realInside(root, f)) {
      outside.push({ path: posix(relative(root, f)), why: "links out of the project: never loads" });
      continue;
    }
    if (d === root) add(f, { kind: "instructions", loads: "every message" });
    else add(f, { kind: "instructions", loads: `when the agent works in ${posix(relative(root, d))}/` });
  }
  for (const [name, loads] of [
    [".pi/SYSTEM.md", "every message (replaces the system prompt)"],
    [".pi/APPEND_SYSTEM.md", "every message (added to the system prompt)"],
  ])
    if (isFile(join(root, name))) add(join(root, name), { kind: "system", loads });

  // Skills: the top's folders, the settings file's skills array, then each subfolder's.
  const settings = (() => {
    try {
      return JSON.parse(readText(join(root, ".pi", "settings.json")) ?? "{}");
    } catch {
      return {};
    }
  })();
  const skillDirs = SKILL_FOLDERS.map((f) => ({ dir: join(root, f), standalone: f === ".pi/skills", where: "" }));
  for (const s of Array.isArray(settings.skills) ? settings.skills : []) if (typeof s === "string") skillDirs.push({ dir: resolve(root, ".pi", s), standalone: true, where: "" });
  for (const d of folders) if (d !== root) for (const f of SUBFOLDER_SKILL_FOLDERS) skillDirs.push({ dir: join(d, f), standalone: false, where: posix(relative(root, d)) });
  if (opts.personal) {
    const agent = opts.agentDir ?? agentDirOf();
    const home = opts.home ?? homedir();
    const claude = opts.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude");
    const mine = instructionIn(agent);
    if (mine) add(mine, { kind: "instructions", loads: "every message (yours, every project)" });
    for (const d of [join(agent, "skills"), join(home, ".agents", "skills"), join(claude, "skills")]) skillDirs.push({ dir: d, standalone: d === join(agent, "skills"), where: "", personal: true });
    for (const p of filesBelow(join(agent, "prompts"), (p) => p.endsWith(".md"))) add(p, { kind: "prompt", loads: "when typed (yours)" });
    const userPlaybooks = join(stateRoot(), "playbooks");
    for (const d of isDir(userPlaybooks) ? readdirSync(userPlaybooks) : []) {
      const e = ["PLAYBOOK.md", "SKILL.md"].map((n) => join(userPlaybooks, d, n)).find(isFile);
      if (e) add(e, { kind: "playbook", loads: "when started (yours)", bundle: join(userPlaybooks, d) });
    }
  }
  const seenSkill = new Set();
  for (const sd of skillDirs) {
    for (const s of skillsIn(sd.dir, { standalone: sd.standalone })) {
      if (seenSkill.has(s.entry)) continue;
      seenSkill.add(s.entry);
      if (!sd.personal && !realInside(root, s.entry)) {
        outside.push({ path: posix(relative(root, s.entry)), why: "skill links out of the project: never loads" });
        continue;
      }
      const text = readText(s.entry) ?? "";
      const { fields } = frontMatter(text);
      const name = fields.name || (s.standalone ? s.entry.split(sep).pop().replace(/\.md$/, "") : s.dir.split(sep).pop());
      const description = fields.description ?? "";
      const manualOnly = /^true$/i.test(fields["disable-model-invocation"] ?? "");
      const problems = [];
      if (!description.trim()) problems.push("no description: pi doesn't load it");
      if (name.length > NAME_MAX) problems.push(`name over ${NAME_MAX} characters`);
      if (description.length > DESCRIPTION_MAX) problems.push(`description over ${DESCRIPTION_MAX} characters`);
      const listing = `  <skill>\n    <name>${name}</name>\n    <description>${description}</description>\n    <location>${s.entry}</location>\n  </skill>`;
      const where = sd.where ? `when the agent works in ${sd.where}/: ` : "";
      const entry = add(s.entry, {
        kind: "skill",
        skill: name,
        bundle: s.standalone ? null : s.dir,
        loads: manualOnly ? `${where}when typed (/skill:${name}), never offered` : `${where}when the skill is used`,
        ...(sd.personal ? { personal: true } : {}),
      });
      const generated = generatedOf(s, text);
      const pages = s.standalone ? [] : filesBelow(s.dir, (p) => p.endsWith(".md") && p !== s.entry);
      skills.push({
        name,
        path: entry.path,
        dir: s.standalone ? null : posix(inside(root, s.dir) ? relative(root, s.dir) : s.dir),
        lines: entry.lines,
        tokens: entry.tokens,
        listingTokens: manualOnly || !description.trim() ? 0 : tokensOf(listing),
        manualOnly,
        offered: !manualOnly && !!description.trim() && !sd.where,
        on: entry.on,
        band: bandOf(entry.lines),
        deliberate: DELIBERATE_RE.test(text),
        generated,
        pages: pages.length,
        pagesLines: pages.reduce((n, p) => n + linesOf(readText(p) ?? ""), 0),
        sections: bandOf(entry.lines) === "fine" ? [] : sectionsOf(text),
        problems,
        personal: !!sd.personal,
      });
    }
  }

  // Prompt commands, playbooks and the project's modes.
  const promptDirs = [join(root, ".pi", "prompts"), ...(Array.isArray(settings.prompts) ? settings.prompts.filter((p) => typeof p === "string").map((p) => resolve(root, ".pi", p)) : [])];
  for (const d of promptDirs) for (const p of filesBelow(d, (p) => p.endsWith(".md"))) add(p, { kind: "prompt", loads: "when typed" });
  for (const pd of PROJECT_PLAYBOOK_DIRS) {
    const base = join(root, pd);
    for (const d of isDir(base) ? readdirSync(base).sort() : []) {
      const e = ["PLAYBOOK.md", "SKILL.md"].map((n) => join(base, d, n)).find(isFile);
      if (e) add(e, { kind: "playbook", loads: "when started", bundle: join(base, d) });
    }
  }
  const modes = join(root, ".sova", "minor-modes");
  for (const d of isDir(modes) ? readdirSync(modes).sort() : []) if (isFile(join(modes, d, "MODE.md"))) add(join(modes, d, "MODE.md"), { kind: "mode", loads: "while the mode is on", bundle: join(modes, d) });

  // Pages reached by reference, and what the references find.
  const graph = referenceGraph(root, items, opts);
  for (const p of graph.reached) items.push(p);
  for (const it of items) it.inScope = scopeMatch(opts.scope, it);
  const counted = items.filter((i) => i.on && i.inScope);
  const always = counted.filter((i) => i.loads.startsWith("every message"));
  const listings = skills.filter((s) => s.on && s.offered && s.listingTokens && scopeMatch(opts.scope, { path: s.path, skill: s.name }));
  const alwaysParts = [...always.map((i) => ({ path: i.path, tokens: i.tokens })), ...(listings.length ? [{ path: `skill listings (${listings.length})`, tokens: listings.reduce((n, s) => n + s.listingTokens, 0) }] : [])];
  const scoped = (list) => list.filter((x) => scopeMatch(opts.scope, { path: x.from ?? x.path }));
  const rep = repeatsOf(root, counted, opts.minRepeat ?? MIN_REPEAT);
  const subjects = subjectsOf(counted, skills.filter((s) => s.on && scopeMatch(opts.scope, { path: s.path, skill: s.name })));
  const total = counted.reduce((n, i) => n + i.tokens, 0);
  const result = {
    root,
    repository: top ? posix(relative(top, root)) || "." : null,
    head,
    dirty,
    complete,
    scope: opts.scope ?? [],
    personal: !!opts.personal,
    depth: opts.depth ?? 1,
    totals: { items: counted.length, tokens: total, lines: counted.reduce((n, i) => n + i.lines, 0), off: items.filter((i) => !i.on).length, leftOut: items.filter((i) => !i.inScope).length },
    alwaysLoaded: { tokens: alwaysParts.reduce((n, p) => n + p.tokens, 0), top: [...alwaysParts].sort((a, b) => b.tokens - a.tokens).slice(0, 3) },
    skills,
    broken: scoped(graph.broken),
    stale: scoped(graph.stale),
    outside: [...outside, ...scoped(graph.outside)],
    beyond: graph.beyond,
    orphans: scoped(graph.orphans),
    repeats: rep,
    subjects,
    suggestedReaders: readersFor(total, subjects.length),
    items: items.map(({ abs, ...i }) => i),
  };
  result.numbers = numbersOf(result);
  return result;
}

function generatedOf(s, text) {
  if (s.standalone) return null;
  const build = join(s.dir, ".build");
  if (isDir(build)) {
    const gen = ["build.mjs", "build.js", "build.ts"].find((n) => isFile(join(build, n)));
    return { source: gen ? `.build/${gen}` : ".build/", how: gen ? `node .build/${gen}` : null };
  }
  const line = text.split("\n").find((l) => GENERATED_RE.test(l));
  return line ? { source: line.trim().slice(0, 160), how: null } : null;
}

/** The project's files (tracked, and untracked but not ignored), relative, for matching a short mention by its end. */
function projectFiles(root) {
  const listed = git(root, "ls-files", "-co", "--exclude-standard");
  if (listed != null) return listed.split("\n").filter(Boolean);
  return filesBelow(root).map((p) => posix(relative(root, p)));
}
/** Which of these relative paths git ignores (generated output, caches): never stale. */
function ignoredOf(root, paths) {
  if (!paths.length) return new Set();
  try {
    const outp = execFileSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: root, input: paths.join("\n"), encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    return new Set(outp.split("\n").filter(Boolean));
  } catch (e) {
    return new Set(String(e.stdout ?? "").split("\n").filter(Boolean));
  }
}
/** The scripts of the package.json nearest above dir (inside root), or null. */
function scriptsNear(root, dir, cache) {
  for (let d = dir; inside(root, d); d = dirname(d)) {
    if (cache.has(d)) return cache.get(d);
    const t = readText(join(d, "package.json"));
    if (t != null) {
      let s = null;
      try {
        const pkg = JSON.parse(t);
        s = pkg && typeof pkg.scripts === "object" ? new Set(Object.keys(pkg.scripts)) : new Set();
      } catch {
        s = null;
      }
      cache.set(d, s);
      return s;
    }
    if (d === root) break;
  }
  return null;
}

/**
 * The reference graph over every entry and the pages they reach. A bundle's pages (a skill's, a playbook's, a mode's)
 * are followed through; a page outside the entry's bundle is a guide, followed up to `depth` hops from the entry
 * (default 1: AGENTS.md → an area's guide; 2 adds the pages those guides point to). Pages past that are counted, not read.
 */
function referenceGraph(root, items, opts) {
  const maxDepth = opts.depth ?? 1;
  const pkgCache = new Map();
  const files = projectFiles(root);
  const known = new Map(items.map((i) => [resolve(i.abs), i]));
  const reached = [];
  const broken = [];
  const staleCandidates = [];
  const out = [];
  const pointedTo = new Set();
  const beyond = new Set();
  const queue = items.filter((i) => !i.personal).map((i) => ({ abs: resolve(i.abs), bundle: i.bundle ?? null, path: i.path, depth: 0 }));
  const visited = new Set();
  const bySuffix = (target, within) => {
    const t = target.replace(/\/$/, "");
    const pre = within ? posix(relative(root, within)) + "/" : "";
    const hits = files.filter((f) => f.startsWith(pre) && (f === t || f.endsWith("/" + t) || f.startsWith(t + "/") || f.includes("/" + t + "/")));
    return hits;
  };
  while (queue.length && visited.size < MAX_PAGES) {
    const page = queue.shift();
    if (visited.has(page.abs)) continue;
    visited.add(page.abs);
    const text = readText(page.abs);
    if (text == null || !page.abs.endsWith(".md")) continue;
    const here = dirname(page.abs);
    // A playbook's description names its step and member pages: the entry points to them.
    const desc = page.bundle && /(?:^|\/)(?:PLAYBOOK|SKILL)\.md$/.test(page.abs) ? readText(join(page.bundle, "playbook.json")) : null;
    if (desc) {
      const pages = [];
      const walk = (v) => (typeof v === "string" ? v.endsWith(".md") && pages.push(v) : v && typeof v === "object" && Object.values(v).forEach(walk));
      try {
        walk(JSON.parse(desc));
      } catch {}
      for (const p of pages) {
        const to = resolve(page.bundle, p);
        if (inside(page.bundle, to) && existsSync(to)) follow(to, page);
        else broken.push({ from: posix(relative(root, join(page.bundle, "playbook.json"))), line: 0, target: p });
      }
    }
    for (const ref of referencesOf(text)) {
      if (ref.kind === "script") {
        const scripts = scriptsNear(root, here, pkgCache);
        if (scripts && !scripts.has(ref.target)) staleCandidates.push({ from: page.path, line: ref.line, target: `${ref.target} (package script)`, script: true });
        continue;
      }
      if (ref.kind === "link") {
        if (ref.target.startsWith("/")) continue; // a site route, not a file
        const to = resolve(here, ref.target);
        if (!inside(root, to)) {
          out.push({ from: page.path, line: ref.line, target: ref.target, why: "link leads out of the project" });
          continue;
        }
        if (!existsSync(to)) {
          broken.push({ from: page.path, line: ref.line, target: ref.target });
          continue;
        }
        follow(to, page);
        continue;
      }
      // A mention: the page's folder, its bundle's folder, the project's top, then by its end inside the bundle.
      const bases = [here, page.bundle, root].filter(Boolean);
      const hit = bases.map((b) => resolve(b, ref.target)).find((p) => inside(root, p) && existsSync(p));
      if (hit) {
        follow(hit, page);
        continue;
      }
      if (page.bundle) {
        const inBundle = bySuffix(ref.target, page.bundle);
        if (inBundle.length) {
          for (const h of inBundle) follow(join(root, h), page);
          continue;
        }
      }
      const elsewhere = bySuffix(ref.target, null);
      if (elsewhere.length) {
        for (const h of elsewhere) pointedTo.add(resolve(root, h));
        continue; // a short mention of a real file elsewhere
      }
      if (/(^|\/)[A-Z_]{3,}(\/|$)/.test(ref.target)) continue; // a placeholder (drafts/NAME/)
      // Stale only when the path starts somewhere real: its first folder exists from one of the bases.
      const first = ref.target.replace(/\/$/, "").split("/")[0];
      if (first && bases.some((b) => isDir(resolve(b, first)) && inside(root, resolve(b, first)))) {
        const base = bases.find((b) => isDir(resolve(b, first)));
        staleCandidates.push({ from: page.path, line: ref.line, target: ref.target, rel: posix(relative(root, resolve(base, ref.target))) });
      }
    }
  }
  function follow(to, page) {
    if (!isFile(to)) return;
    const abs = resolve(to);
    pointedTo.add(abs);
    if (known.has(abs)) {
      if (!visited.has(abs)) queue.push({ abs, bundle: known.get(abs).bundle ?? null, path: known.get(abs).path, depth: known.get(abs).depth ?? 0 });
      return;
    }
    if (!to.endsWith(".md")) return;
    const bundle = page.bundle && inside(page.bundle, abs) ? page.bundle : null;
    const depth = bundle ? page.depth : page.depth + 1;
    if (depth > maxDepth) {
      beyond.add(abs);
      return;
    }
    const it = item(root, abs, { kind: bundle ? "page" : "guide", loads: `when ${page.path} sends the agent there`, depth, ...(bundle ? { bundle } : {}) });
    known.set(abs, it);
    reached.push(it);
    queue.push({ abs, bundle, path: it.path, depth });
  }
  const ignored = ignoredOf(root, staleCandidates.filter((s) => s.rel).map((s) => s.rel));
  const stale = staleCandidates.filter((s) => !s.rel || !ignored.has(s.rel)).map(({ rel, script, ...s }) => s);
  // Pages nothing points to: markdown in an entry's bundle, or beside a reached guide page.
  const areas = new Set();
  for (const i of items) if (i.bundle) areas.add(`${resolve(i.bundle)}\0deep`);
  for (const g of reached) if (g.kind === "guide" && dirname(resolve(g.abs)) !== root) areas.add(`${dirname(resolve(g.abs))}\0flat`);
  const orphans = [];
  const seen = new Set();
  for (const a of areas) {
    const [dir, how] = a.split("\0");
    const found = how === "deep" ? filesBelow(dir, (p) => p.endsWith(".md")) : readdirSync(dir).map((n) => join(dir, n)).filter((p) => p.endsWith(".md") && isFile(p));
    for (const f of found) {
      const abs = resolve(f);
      if (seen.has(abs) || pointedTo.has(abs) || known.has(abs) || beyond.has(abs) || INSTRUCTION_NAMES.includes(f.split(sep).pop())) continue;
      seen.add(abs);
      orphans.push({ path: posix(relative(root, abs)), lines: linesOf(readText(abs) ?? "") });
    }
  }
  const dedupe = (xs) => [...new Map(xs.map((x) => [`${x.from}:${x.line}:${x.target}`, x])).values()];
  return { reached, beyond: beyond.size, broken: dedupe(broken), stale: dedupe(stale), outside: dedupe(out), orphans: orphans.sort((a, b) => a.path.localeCompare(b.path)) };
}

/** Passages found in more than one place (or twice in one file). */
export function repeatsOf(root, items, min = MIN_REPEAT) {
  const groups = new Map();
  for (const it of items) {
    if (it.personal || !it.path.endsWith(".md")) continue;
    for (const p of paragraphsOf(readText(join(root, it.path)) ?? "")) {
      if (p.norm.length < min) continue;
      const h = createHash("sha1").update(p.norm).digest("hex").slice(0, 12);
      const g = groups.get(h) ?? { text: p.raw.replace(/\s+/g, " ").trim().slice(0, 120), chars: p.norm.length, at: [] };
      g.at.push({ path: it.path, line: p.line });
      groups.set(h, g);
    }
  }
  return [...groups.values()].filter((g) => g.at.length > 1).sort((a, b) => b.chars * b.at.length - a.chars * a.at.length);
}

/** The readers' subjects: the instruction files and their guides, each sizeable skill alone, small skills together,
    then playbooks, prompts and modes. */
function subjectsOf(items, skills) {
  const sum = (xs) => xs.reduce((n, i) => n + i.tokens, 0);
  const out = [];
  const instr = items.filter((i) => ["instructions", "system", "guide"].includes(i.kind));
  if (instr.length) out.push({ id: "instructions", label: "Instruction files and the guides they point to", files: instr.length, tokens: sum(instr) });
  const small = [];
  for (const s of skills) {
    const own = items.filter((i) => i.path === s.path || (s.dir && i.path.startsWith(s.dir + "/") && (i.kind === "page" || i.kind === "skill")));
    const t = sum(own);
    if (t >= 2000) out.push({ id: `skill:${s.name}`, label: `Skill ${s.name}`, files: own.length, tokens: t });
    else small.push(...own);
  }
  if (small.length) out.push({ id: "skills", label: "The smaller skills", files: small.length, tokens: sum(small) });
  const rest = items.filter((i) => ["prompt", "playbook", "mode"].includes(i.kind) || (i.kind === "page" && !skills.some((s) => s.dir && i.path.startsWith(s.dir + "/"))));
  if (rest.length) out.push({ id: "runs", label: "Playbooks, prompt commands and modes", files: rest.length, tokens: sum(rest) });
  return out;
}
/** One reader for a small project; else one per subject, at most 6, and never fewer than the text needs (≈40,000 each). */
export const readersFor = (tokens, subjects) => (tokens <= 30000 ? 1 : Math.max(1, Math.min(6, subjects, Math.max(2, Math.ceil(tokens / 40000)))));

function numbersOf(r) {
  return {
    contradictions: null,
    alwaysLoaded: r.alwaysLoaded.tokens,
    skillEntries: r.skills.filter((s) => s.on && !s.personal).map((s) => ({ name: s.name, lines: s.lines, tokens: s.tokens, band: s.band })),
    references: r.broken.length + r.stale.length + r.outside.length,
    orphans: r.orphans.length,
    repeats: r.repeats.length,
  };
}

// ── the moved-text check ────────────────────────────────────────────────────────────────────────

/** Every paragraph of the old page on exactly one new page: `missing` ones on none, `doubled` ones on several. */
export function movedCheck(oldText, newPages, min = 20) {
  const pages = newPages.map(({ path, text }) => ({ path, norms: new Set(paragraphsOf(text).map((p) => p.norm)), all: normalise(text) }));
  const missing = [];
  const doubled = [];
  for (const p of paragraphsOf(oldText)) {
    if (p.norm.length < min) continue;
    const on = pages.filter((pg) => pg.norms.has(p.norm) || pg.all.includes(p.norm)).map((pg) => pg.path);
    if (on.length === 0) missing.push({ line: p.line, text: p.raw.replace(/\s+/g, " ").slice(0, 120) });
    else if (on.length > 1) doubled.push({ line: p.line, text: p.raw.replace(/\s+/g, " ").slice(0, 120), on });
  }
  return { missing, doubled };
}

// ── digests ─────────────────────────────────────────────────────────────────────────────────────

const plural = (n, one, many = `${one}s`) => `${num(n)} ${n === 1 ? one : many}`;
const at = (x) => `${x.from}:${x.line} → ${x.target}`;

export function inventoryDigest(r, detail) {
  const L = [];
  L.push(`context-audit inventory · ${r.root} · HEAD ${r.head ? r.head.slice(0, 12) : "(not a git repository)"}`);
  if (r.dirty.length) L.push(`uncommitted: ${plural(r.dirty.length, "file")} (${r.dirty.slice(0, 5).join(", ")}${r.dirty.length > 5 ? ", …" : ""}): read as on disk; the audit is of HEAD`);
  if (!r.complete) L.push(`walk stopped at ${num(SCAN_CAP)} folders: the list may miss some`);
  L.push(`items ${num(r.totals.items)} · ${num(r.totals.lines)} lines · ≈${num(r.totals.tokens)} tokens${r.totals.off ? ` · ${r.totals.off} off (listed, not counted)` : ""}${r.totals.leftOut ? ` · ${r.totals.leftOut} left out by scope` : ""}${r.personal ? " · yours included (report only)" : ""}`);
  L.push(`always loaded ≈${num(r.alwaysLoaded.tokens)}: ${r.alwaysLoaded.top.map((p) => `${p.path} ≈${num(p.tokens)}`).join(" · ") || "nothing"}`);
  for (const s of r.skills) {
    const bits = [`${s.lines} lines ≈${num(s.tokens)}`, s.band, s.pages ? `${s.pages} pages (${num(s.pagesLines)} lines)` : "no other pages"];
    if (s.deliberate) bits.push("asks to be read whole (deliberate)");
    if (s.generated) bits.push(`generated: ${s.generated.source.length > 80 ? s.generated.source.slice(0, 79) + "…" : s.generated.source}`);
    if (s.manualOnly) bits.push("manual only");
    if (!s.on) bits.push("off");
    if (s.personal) bits.push("yours");
    bits.push(...s.problems);
    L.push(`skill ${s.name} (${s.path}): ${bits.join(" · ")}`);
  }
  L.push(`references: ${r.broken.length} broken · ${r.stale.length} stale · ${r.outside.length} out of the project`);
  for (const x of [...r.broken, ...r.stale].slice(0, 8)) L.push(`  ${at(x)}`);
  L.push(`orphans: ${r.orphans.length}${r.orphans.length ? ` (${r.orphans.slice(0, 5).map((o) => o.path).join(", ")}${r.orphans.length > 5 ? ", …" : ""})` : ""}`);
  const firstAt = (g) => `${g.at.slice(0, 3).map((a) => `${a.path}:${a.line}`).join(" = ")}${g.at.length > 3 ? ` (+${g.at.length - 3} more)` : ""}`;
  L.push(`repeats: ${r.repeats.length}${r.repeats.length ? ` (largest: ${firstAt(r.repeats[0])})` : ""}`);
  if (r.beyond) L.push(`pages past ${r.depth ?? 1} hops from an entry: ${r.beyond} (not read; --depth to follow further)`);
  L.push(`subjects: ${r.subjects.map((s) => `${s.label} (${s.files} files ≈${num(s.tokens)})`).join(" · ")}`);
  L.push(`suggested readers: ${r.suggestedReaders}`);
  if (detail) L.push(`detail: ${detail}`);
  return L.join("\n");
}

const somethingToAct = (r) => r.broken.length + r.stale.length + r.outside.length + r.orphans.length + r.repeats.length > 0 || r.skills.some((s) => s.band !== "fine" || s.problems.length);

// ── command line ────────────────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const o = { scope: [], moved: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--root") o.root = val();
    else if (a === "--scope") o.scope.push(...val().split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--personal") o.personal = true;
    else if (a === "--switches") o.switches = val();
    else if (a === "--run") o.run = val();
    else if (a === "--json") o.json = true;
    else if (a === "--min") o.min = Number(val());
    else if (a === "--depth") o.depth = Number(val());
    else if (a === "--before") o.before = val();
    else if (a === "--base") o.base = val();
    else if (a === "--moved") o.moved.push(val());
    else if (a === "--clean") o.clean = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** Runs one subcommand; returns its exit code, writing to out/err. */
export function main(argv, out = (s) => process.stdout.write(s + "\n"), err = (s) => process.stderr.write(s + "\n")) {
  const [cmd, ...rest] = argv;
  let o;
  try {
    o = parseArgs(rest);
  } catch (e) {
    err(`context-audit: ${e.message}`);
    return 2;
  }
  const root = resolve(o.root ?? process.cwd());
  if (!isDir(root)) {
    err(`context-audit: no folder at ${root}`);
    return 2;
  }
  let switches;
  if (o.switches) {
    try {
      switches = JSON.parse(readFileSync(o.switches, "utf8"));
    } catch (e) {
      err(`context-audit: can't read the switches file ${o.switches}: ${e.message}`);
      return 2;
    }
  }
  const opts = { scope: o.scope, personal: o.personal, switches, minRepeat: o.min, depth: o.depth };
  switch (cmd) {
    case "inventory": {
      const r = inventory(root, opts);
      if (r.error) return err(`context-audit: ${r.error}`), 2;
      let detail = null;
      try {
        const dir = join(runsDir(), o.run ?? (r.head ? r.head.slice(0, 12) : "no-head"));
        dropLeftoverRuns(dir);
        mkdirSync(dir, { recursive: true });
        detail = join(dir, "inventory.json");
        writeFileSync(detail, JSON.stringify(r, null, 2) + "\n");
      } catch {
        detail = null;
      }
      out(o.json ? JSON.stringify(r, null, 2) : inventoryDigest(r, detail));
      return somethingToAct(r) ? 1 : 0;
    }
    case "links": {
      const r = inventory(root, opts);
      if (r.error) return err(`context-audit: ${r.error}`), 2;
      const v = { broken: r.broken, stale: r.stale, outside: r.outside, orphans: r.orphans };
      if (o.json) out(JSON.stringify(v, null, 2));
      else {
        out(`links: ${r.broken.length} broken · ${r.stale.length} stale · ${r.outside.length} out of the project · ${r.orphans.length} orphans`);
        for (const x of r.broken) out(`broken  ${at(x)}`);
        for (const x of r.stale) out(`stale   ${at(x)}`);
        for (const x of r.outside) out(`outside ${x.from ? at(x) : x.path}: ${x.why}`);
        for (const x of r.orphans) out(`orphan  ${x.path} (${x.lines} lines)`);
      }
      return r.broken.length + r.stale.length + r.outside.length + r.orphans.length ? 1 : 0;
    }
    case "repeats": {
      const r = inventory(root, opts);
      if (r.error) return err(`context-audit: ${r.error}`), 2;
      if (o.json) out(JSON.stringify(r.repeats, null, 2));
      else {
        out(`repeats: ${r.repeats.length}`);
        for (const g of r.repeats) out(`${g.at.map((a) => `${a.path}:${a.line}`).join(" = ")}  "${g.text}${g.text.length >= 120 ? "…" : ""}"`);
      }
      return r.repeats.length ? 1 : 0;
    }
    case "check": {
      if (!o.before && !o.moved.length) return err("context-audit: check needs --before <inventory.json> or --moved <old>=<new,…>"), 2;
      let before = null;
      if (o.before) {
        try {
          before = JSON.parse(readFileSync(o.before, "utf8"));
        } catch (e) {
          return err(`context-audit: can't read ${o.before}: ${e.message}`), 2;
        }
      }
      const after = inventory(root, { ...opts, scope: o.scope.length ? o.scope : before?.scope, personal: o.personal ?? before?.personal });
      if (after.error) return err(`context-audit: ${after.error}`), 2;
      const base = o.base ?? before?.head;
      const moves = [];
      for (const m of o.moved) {
        const [old, news] = m.split("=");
        if (!old || !news) return err(`context-audit: --moved wants <old path>=<new path>,<new path>, not ${m}`), 2;
        const oldText = base ? git(root, "show", `${base}:${old}`) : readText(join(root, old));
        if (oldText == null) return err(`context-audit: can't read ${old} at ${base ?? "the working tree"}`), 2;
        const pages = news.split(",").map((p) => ({ path: p, text: readText(join(root, p)) }));
        const gone = pages.find((p) => p.text == null);
        if (gone) return err(`context-audit: no page at ${gone.path}`), 2;
        moves.push({ old, ...movedCheck(oldText, pages) });
      }
      const n0 = before?.numbers;
      const n1 = after.numbers;
      const failed = moves.some((m) => m.missing.length || m.doubled.length);
      if (o.json) out(JSON.stringify({ before: n0 ?? null, after: n1, moves }, null, 2));
      else {
        const row = (label, a, b) => out(`${label}: ${a === undefined ? "?" : num(a)} → ${num(b)}`);
        out(`context-audit check · HEAD ${after.head ? after.head.slice(0, 12) : "?"}${base ? ` against ${base.slice(0, 12)}` : ""}`);
        if (n0) {
          row("always loaded ≈", n0.alwaysLoaded, n1.alwaysLoaded);
          row("references", n0.references, n1.references);
          row("orphans", n0.orphans, n1.orphans);
          row("repeats", n0.repeats, n1.repeats);
          for (const s of n1.skillEntries) {
            const b = n0.skillEntries.find((x) => x.name === s.name);
            out(`skill ${s.name}: ${b ? `${b.lines} lines ≈${num(b.tokens)} (${b.band})` : "new"} → ${s.lines} lines ≈${num(s.tokens)} (${s.band})`);
          }
        }
        for (const m of moves) {
          out(`moved ${m.old}: ${m.missing.length || m.doubled.length ? `${m.missing.length} paragraphs on no new page, ${m.doubled.length} on several` : "every paragraph on exactly one new page"}`);
          for (const x of m.missing) out(`  missing (old line ${x.line}): "${x.text}"`);
          for (const x of m.doubled) out(`  on ${x.on.join(", ")} (old line ${x.line}): "${x.text}"`);
        }
      }
      // The run's working folder goes once the recheck is clean: nothing is kept between runs.
      if (o.clean && o.before && !failed) {
        const dir = runDirOf(o.before);
        if (dir) {
          rmSync(dir, { recursive: true, force: true });
          if (!o.json) out(`cleaned: ${dir}`);
        }
      }
      return failed ? 1 : 0;
    }
    case "clean": {
      if (!o.before) return err("context-audit: clean needs --before <inventory.json>"), 2;
      const dir = runDirOf(o.before);
      if (!dir) return err(`context-audit: ${o.before} is not in a run folder under ${runsDir()}`), 2;
      rmSync(dir, { recursive: true, force: true });
      out(o.json ? JSON.stringify({ cleaned: dir }) : `cleaned: ${dir}`);
      return 0;
    }
    default:
      err("usage: context-audit.mjs inventory|links|repeats|check|clean [--root <checkout>] … (see the header)");
      return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  process.exitCode = main(process.argv.slice(2));
}
