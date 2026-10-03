#!/usr/bin/env node
// The Project verbs playbook's driver (playbooks/project-verbs/PLAYBOOK.md). Node builtins, plus the
// contract's parser from Sova's shared/project-contract.ts (Node strips its types), so `check` reads
// a definition exactly as the engine does. It reads the project and this host; it writes only the
// file `fmt` is given. It never starts, stops or approves anything: the verbs do that.
//
//   node scripts/project-verbs.mjs inspect [--root <dir>] [--json]
//   node scripts/project-verbs.mjs plan    [--root <dir>] [--json]
//   node scripts/project-verbs.mjs check   [<file>] [--root <dir>] [--json]
//   node scripts/project-verbs.mjs fmt     [<file>] [--root <dir>] [--check]
//   node scripts/project-verbs.mjs ram     [--instance <id>]... [--unit <name>]... [--pid <n>]... [--json]
//
// --root defaults to the git checkout of the current directory; <file> to <root>/.sova/project.json.
// Exit 0: all is well. 1: it found something to act on (read the digest). 2: it couldn't check.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export const CONTRACT_FILE = ".sova/project.json";

// ---- canonical key order (references/contract.md; pinned against the parser by tests/) ----------

export const ORDER = {
  top: ["version", "slots", "host", "sources", "setup", "data", "services", "hooks", "test", "share", "deploy"],
  slots: ["cap"],
  step: ["id", "run", "inputs", "timeout"],
  data: ["kind", "path", "from", "provision", "deprovision", "timeout", "sensitive"],
  service: ["cmd", "static", "cwd", "env", "ports", "requires", "ready", "reload", "build", "scope", "container", "start", "about", "isolation", "adopt"],
  port: ["base", "stride", "fixed"],
  ready: ["tcp", "http", "path", "timeout"],
  reload: ["signal", "cmd"],
  container: ["name", "engine"],
  hooks: ["probe"],
  test: ["run", "requires", "timeout", "smoke"],
  isolation: ["method", "why"],
  adopt: ["unit", "ports"],
  share: ["endpoints", "maxDays", "allow"],
};
/** Maps whose keys are names in declaration order, kept as written. */
const NAMED_MAPS = new Set(["data", "services", "ports", "env"]);

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

function sortKeys(o, order) {
  const out = {};
  for (const k of order) if (k in o) out[k] = o[k];
  for (const k of Object.keys(o)) if (!(k in out)) out[k] = o[k];
  return out;
}

/** The definition with every object's keys in the contract's order (names keep declaration order). */
export function canonical(def) {
  if (!isObj(def)) return def;
  const d = sortKeys(def, ORDER.top);
  if (isObj(d.slots)) d.slots = sortKeys(d.slots, ORDER.slots);
  if (Array.isArray(d.setup)) d.setup = d.setup.map((s) => (isObj(s) ? sortKeys(s, ORDER.step) : s));
  if (isObj(d.data)) for (const [k, v] of Object.entries(d.data)) if (isObj(v)) d.data[k] = sortKeys(v, ORDER.data);
  if (isObj(d.services))
    for (const [k, v] of Object.entries(d.services)) {
      if (!isObj(v)) continue;
      const s = sortKeys(v, ORDER.service);
      if (isObj(s.ports)) for (const [p, pv] of Object.entries(s.ports)) if (isObj(pv)) s.ports[p] = sortKeys(pv, ORDER.port);
      if (isObj(s.ready)) s.ready = sortKeys(s.ready, ORDER.ready);
      if (isObj(s.reload)) s.reload = sortKeys(s.reload, ORDER.reload);
      if (isObj(s.build)) s.build = sortKeys(s.build, ORDER.step);
      if (isObj(s.container)) s.container = sortKeys(s.container, ORDER.container);
      if (isObj(s.isolation)) s.isolation = sortKeys(s.isolation, ORDER.isolation);
      if (isObj(s.adopt)) s.adopt = sortKeys(s.adopt, ORDER.adopt);
      d.services[k] = s;
    }
  if (isObj(d.hooks)) {
    d.hooks = sortKeys(d.hooks, ORDER.hooks);
    if (isObj(d.hooks.probe)) d.hooks.probe = sortKeys(d.hooks.probe, ORDER.step);
  }
  if (isObj(d.test)) d.test = sortKeys(d.test, ORDER.test);
  if (isObj(d.share)) d.share = sortKeys(d.share, ORDER.share);
  return d;
}

const WIDTH = 100;
const scalar = (v) => v === null || typeof v !== "object";

/** JSON, 2-space indent; an array of scalars, or an object of scalars, on one line when it fits. */
export function pretty(v, indent = "", lead = 0) {
  if (scalar(v)) return JSON.stringify(v);
  const entries = Array.isArray(v) ? v.map((x) => [null, x]) : Object.entries(v);
  if (!entries.length) return Array.isArray(v) ? "[]" : "{}";
  if (entries.every(([, x]) => scalar(x))) {
    const one = Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(", ")}]` : `{${entries.map(([k, x]) => `${JSON.stringify(k)}: ${JSON.stringify(x)}`).join(", ")}}`;
    if (indent.length + lead + one.length <= WIDTH) return one;
  }
  const inner = `${indent}  `;
  const lines = entries.map(([k, x]) => {
    const key = k === null ? "" : `${JSON.stringify(k)}: `;
    return `${inner}${key}${pretty(x, inner, key.length)}`;
  });
  return `${Array.isArray(v) ? "[" : "{"}\n${lines.join(",\n")}\n${indent}${Array.isArray(v) ? "]" : "}"}`;
}

/** The file's canonical text: parsed, keys ordered, printed, one trailing newline. Throws on bad JSON. */
export const formatText = (text) => `${pretty(canonical(JSON.parse(text)))}\n`;

// ---- small helpers ------------------------------------------------------------------------------

function sh(cmd, args, cwd, timeout = 10000) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}
const git = (root, ...a) => sh("git", ["-C", root, ...a], root);
const readText = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
};

function gitRoot(dir) {
  const top = sh("git", ["-C", dir, "rev-parse", "--show-toplevel"], dir);
  return top ? top.trim() : null;
}

/** The main checkout of the repository `root` belongs to (a worktree's first worktree). */
function mainOf(root) {
  const list = git(root, "worktree", "list", "--porcelain");
  const m = list && /^worktree (.+)$/m.exec(list);
  return m ? m[1] : root;
}

export const stateRoot = () => {
  const a = process.env.PI_CODING_AGENT_DIR;
  const agent = a ? (a === "~" ? homedir() : a.startsWith("~/") ? join(homedir(), a.slice(2)) : a) : join(homedir(), ".pi", "agent");
  return join(agent, "sova");
};

let contract;
/** Sova's contract module, or null when this playbook runs outside a Sova checkout. */
async function loadContract() {
  if (contract !== undefined) return contract;
  try {
    contract = await import(new URL("../../../shared/project-contract.ts", import.meta.url).href);
  } catch {
    contract = null;
  }
  return contract;
}

/** Whether the parser takes `key` (probed with a minimal definition, since its key lists are private). */
async function parserTakes(where) {
  const c = await loadContract();
  if (!c) return false;
  const base = { version: 1, services: { web: { cmd: ["true"] } } };
  const probe =
    where === "sources" ? { ...base, sources: ["package.json"] } : { version: 1, services: { web: { cmd: ["true"], isolation: { method: "ports", why: "probe" } } } };
  try {
    c.parseDefinition(JSON.stringify(probe));
    return true;
  } catch {
    return false;
  }
}

// ---- inspect ------------------------------------------------------------------------------------

/** Files whose change can change what a project runs: they declare tasks, services, tools or dependencies. */
export const STACK_FILES = [
  "package.json",
  "pnpm-workspace.yaml",
  "bb.edn",
  "deps.edn",
  "project.clj",
  "shadow-cljs.edn",
  "tests.edn",
  "kaocha.edn",
  "Procfile",
  "Procfile.dev",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "Dockerfile",
  "Makefile",
  "justfile",
  "mise.toml",
  ".mise.toml",
  ".tool-versions",
  "Gemfile",
  "pyproject.toml",
  "requirements.txt",
  "go.mod",
  "Cargo.toml",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
];
const DOC_FILES = ["CLAUDE.md", "AGENTS.md", "README.md", "README", "README.org"];
const TOOLS = ["bb", "clojure", "clj", "java", "node", "npm", "pnpm", "yarn", "bun", "npx", "python3", "ruby", "bundle", "redis-server", "postgres", "psql", "mysqld", "sass", "mailcatcher", "docker", "podman", "mise", "go", "cargo", "deno", "caddy", "nginx"];
/** A task or script that brings production data here (clone, download, dump, restore, backup of prod). */
const PROD_DATA = /\b(prod|production)\b.*\b(clone|download|dump|restore|backup|import|copy|sync)|\b(clone|download|dump|restore|backup|import|copy|sync)\b.*\b(prod|production)\b/i;
const DEPLOY = /\b(deploy|prod(?:uction)?|release|publish|ansible|terraform|kubectl|helm|rsync|scp|ssh)\b/i;

/** Files tracked at HEAD (paths), or null outside git. */
function tracked(root) {
  const out = git(root, "ls-tree", "-r", "--name-only", "HEAD");
  return out === null ? null : out.split("\n").filter(Boolean);
}
const atHead = (root, path) => git(root, "show", `HEAD:${path}`);

const TEXT_EXT = /\.(clj|cljs|cljc|edn|bb|js|mjs|cjs|ts|tsx|jsx|json|ya?ml|toml|properties|env|conf|cfg|ini|sh|rb|py|go|rs|md|org|html|txt)$/i;
const SKIP = /(^|\/)(node_modules|vendor|dist|build|target|\.git|\.shadow-cljs|\.cpcache)\//;
const LOCKS = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Gemfile\.lock|Cargo\.lock|go\.sum|poetry\.lock)$/;

const PORT_RES = [
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])\s*:\s*(\d{2,5})\b/gi,
  /\bport\b["'\s]*[:=]?\s*["']?(\d{4,5})\b/gi,
  /"--port"\s*,?\s*"(\d{4,5})"/g,
  /-port["'\s]+(\d{4,5})\b/gi,
  /\bport\b[^\n]{0,40}?(?:\?\?|\|\||\bor\b|getenv[^)]*\))\s*["']?(\d{4,5})\b/gi,
];

/** Port numbers written in tracked text files: {port, refs: ["file:line", …]} by port. */
export function portLiterals(root, files) {
  const want = new Set(
    files.filter((f) => (TEXT_EXT.test(f) || /(^|\/)(Procfile|Makefile|Dockerfile|justfile)$/.test(f)) && !SKIP.test(f) && !LOCKS.test(f) && !/\.min\./.test(f)),
  );
  // Lines at HEAD with a 4-5 digit number, never the working tree's.
  const out = git(root, "grep", "-I", "-n", "-E", "[0-9]{4,5}", "HEAD", "--") ?? "";
  const by = new Map();
  for (const row of out.split("\n")) {
    const m = /^HEAD:(.+?):(\d+):(.*)$/.exec(row);
    if (!m || !want.has(m[1]) || m[3].length > 400) continue;
    const [, f, lineNo, line] = m;
    const seen = new Set();
    for (const re of PORT_RES)
      for (const x of line.matchAll(re)) {
        const n = Number(x[1]);
        if (n < 1024 || n > 65535 || seen.has(n)) continue;
        seen.add(n);
        if (!by.has(n)) by.set(n, []);
        const refs = by.get(n);
        if (refs.length < 6) refs.push(`${f}:${lineNo}`);
      }
  }
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([port, refs]) => ({ port, refs }));
}

function packageJson(text) {
  try {
    const p = JSON.parse(text);
    return { scripts: isObj(p.scripts) ? p.scripts : {}, packageManager: p.packageManager ?? null, workspaces: p.workspaces ?? null };
  } catch {
    return { scripts: {}, packageManager: null, workspaces: null, error: "not JSON" };
  }
}

/** bb.edn task names (with :doc), by a light read of the text: top-level keys of :tasks. */
export function bbTasks(text) {
  const out = [];
  const start = text.indexOf(":tasks");
  if (start < 0) return out;
  const body = text.slice(start);
  for (const m of body.matchAll(/^\s{1,16}([a-z][\w:.\-/]*)\s+\{(?:\s*:doc\s+"((?:[^"\\]|\\.)*)")?/gm)) {
    if (["requires", "init", "enter", "leave"].includes(m[1])) continue;
    if (out.some((t) => t.name === m[1])) continue;
    out.push({ name: m[1], doc: m[2] ? m[2].replace(/\s+/g, " ").slice(0, 120) : null });
  }
  return out;
}

/** deps.edn alias names, by a light read: a keyword opening a map with an alias's own keys. */
export function depsAliases(text) {
  const out = [];
  for (const m of text.matchAll(/:([a-z][\w.\-]*)\s+\{\s*:(?:extra-paths|extra-deps|main-opts|jvm-opts|exec-fn|exec-args|ns-default|replace-deps|replace-paths|deps|paths)\b/g))
    if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

function composeServices(text) {
  const out = [];
  const lines = text.split("\n");
  let inServices = false;
  let cur = null;
  for (const line of lines) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      continue;
    }
    if (inServices && /^\S/.test(line)) inServices = false;
    if (!inServices) continue;
    const s = /^ {2}([\w.-]+):\s*$/.exec(line);
    if (s) {
      cur = { name: s[1], image: null, ports: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const img = /^\s+image:\s*["']?([^"'\s]+)/.exec(line);
    if (img) cur.image = img[1];
    const p = /^\s+-\s*["']?([\d.:]+)["']?\s*$/.exec(line);
    if (p && p[1].includes(":")) cur.ports.push(p[1]);
  }
  return out;
}

/** Listening TCP ports on this host's namespace, with the owning process when it is readable. */
export function listening() {
  const inodes = new Map();
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const text = readText(f);
    if (!text) continue;
    for (const line of text.split("\n").slice(1)) {
      const c = line.trim().split(/\s+/);
      if (c.length < 10 || c[3] !== "0A") continue;
      const port = parseInt(c[1].split(":").pop(), 16);
      const addr = c[1].split(":")[0];
      const local = /^(0100007F|00000000000000000000000001000000)$/.test(addr);
      if (!inodes.has(c[9])) inodes.set(c[9], { port, local });
    }
  }
  const owners = new Map();
  let pids = [];
  try {
    pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {}
  for (const pid of pids) {
    let fds;
    try {
      fds = readdirSync(`/proc/${pid}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let l;
      try {
        l = readlinkSync(`/proc/${pid}/fd/${fd}`);
      } catch {
        continue;
      }
      const m = /^socket:\[(\d+)\]$/.exec(l);
      if (m && inodes.has(m[1]) && !owners.has(m[1])) {
        let comm = "";
        let cwd = "";
        try {
          comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        } catch {}
        try {
          cwd = readlinkSync(`/proc/${pid}/cwd`);
        } catch {}
        owners.set(m[1], { pid: Number(pid), comm, cwd });
      }
    }
  }
  const by = new Map();
  for (const [inode, { port, local }] of inodes) {
    const prev = by.get(port);
    const owner = owners.get(inode) ?? null;
    if (!prev) by.set(port, { port, loopbackOnly: local, owner });
    else {
      prev.loopbackOnly = prev.loopbackOnly && local;
      prev.owner ??= owner;
    }
  }
  return [...by.values()].sort((a, b) => a.port - b.port);
}

/** Ports Sova's registry holds for instances of any project on this host. */
export function sovaHeld(file = join(stateRoot(), "project-services", "registry.json")) {
  const text = readText(file);
  if (!text) return { readable: false, ports: [] };
  try {
    const r = JSON.parse(text);
    const ports = [];
    for (const i of r.instances ?? [])
      for (const [svc, ps] of Object.entries(i.ports ?? {})) for (const [p, n] of Object.entries(ps)) ports.push({ port: n, project: i.project, instance: i.id, slot: i.slot, service: svc, name: p });
    for (const s of r.shared ?? [])
      for (const [svc, ps] of Object.entries(s.ports ?? {})) for (const [p, n] of Object.entries(ps)) ports.push({ port: n, project: s.project, instance: "shared", slot: null, service: svc, name: p });
    return { readable: true, ports: ports.sort((a, b) => a.port - b.port) };
  } catch {
    return { readable: false, ports: [] };
  }
}

const which = (t) => {
  const out = sh("sh", ["-c", 'command -v "$1"', "sh", t], process.cwd(), 3000);
  return out ? out.trim() : null;
};

/** The definition at HEAD: absent, invalid (with the parser's message) or present. */
async function definitionAtHead(root) {
  const text = atHead(root, CONTRACT_FILE);
  if (text === null) return { state: "absent" };
  const c = await loadContract();
  if (!c) return { state: "unchecked", text };
  try {
    const def = c.parseDefinition(text);
    return { state: "present", text, def, canonical: formatText(text) === text };
  } catch (err) {
    return { state: "invalid", text, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function inspect(root) {
  const files = tracked(root);
  if (!files) return null;
  const has = new Set(files);
  const head = git(root, "rev-parse", "HEAD")?.trim() ?? null;
  const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD")?.trim() ?? null;
  const dirty = (git(root, "status", "--porcelain") ?? "").split("\n").filter(Boolean);
  const main = mainOf(root);

  const stack = STACK_FILES.filter((f) => has.has(f));
  const docs = DOC_FILES.filter((f) => has.has(f));
  const details = {};
  const tests = [];
  const deploy = [];
  const prodData = [];
  const tasksText = [];
  if (has.has("package.json")) {
    const p = packageJson(atHead(root, "package.json") ?? "");
    details["package.json"] = p;
    for (const [k, v] of Object.entries(p.scripts)) {
      tasksText.push(String(v));
      if (/test|spec|vitest|jest|mocha|playwright/i.test(k)) tests.push(`package.json script ${k}: ${v}`);
      if (DEPLOY.test(k)) deploy.push(`package.json script ${k}: ${v}`);
      if (PROD_DATA.test(`${k} ${v}`)) prodData.push(`package.json script ${k}: ${v}`);
    }
  }
  if (has.has("bb.edn")) {
    const t = atHead(root, "bb.edn") ?? "";
    tasksText.push(t);
    const tasks = bbTasks(t);
    details["bb.edn"] = { tasks };
    for (const x of tasks) {
      if (/test/i.test(x.name)) tests.push(`bb ${x.name}${x.doc ? ` — ${x.doc}` : ""}`);
      if (DEPLOY.test(x.name) || (x.doc && /\bdeploy|\bprod\b/i.test(x.doc))) deploy.push(`bb ${x.name}${x.doc ? ` — ${x.doc}` : ""}`);
      if (PROD_DATA.test(`${x.name.replace(/[:_-]/g, " ")} ${x.doc ?? ""}`)) prodData.push(`bb ${x.name}${x.doc ? ` — ${x.doc}` : ""}`);
    }
    if (/\(slurp\s+"([^"]+)"\)/.test(t)) details["bb.edn"].reads = [...t.matchAll(/\(slurp\s+"([^"]+)"\)/g)].map((m) => m[1]);
  }
  if (has.has("deps.edn")) {
    const t = atHead(root, "deps.edn") ?? "";
    const aliases = depsAliases(t);
    details["deps.edn"] = { aliases };
    for (const a of aliases) if (/test/i.test(a)) tests.push(`deps.edn alias :${a}`);
  }
  for (const f of ["kaocha.edn", "tests.edn"]) if (has.has(f)) tests.push(`${f} (kaocha)`);
  if (has.has("shadow-cljs.edn")) {
    const t = atHead(root, "shadow-cljs.edn") ?? "";
    details["shadow-cljs.edn"] = { builds: [...t.matchAll(/^\s{1,12}:([\w-]+)\s+\{\s*:target\b/gm)].map((m) => m[1]) };
  }
  for (const f of ["Procfile", "Procfile.dev"])
    if (has.has(f))
      details[f] = (atHead(root, f) ?? "")
        .split("\n")
        .map((l) => /^([\w-]+):\s*(.+)$/.exec(l))
        .filter(Boolean)
        .map((m) => ({ name: m[1], cmd: m[2] }));
  for (const f of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) if (has.has(f)) details[f] = { services: composeServices(atHead(root, f) ?? "") };
  if (has.has("Makefile")) {
    const targets = [...(atHead(root, "Makefile") ?? "").matchAll(/^([A-Za-z][\w.-]*):(?!=)/gm)].map((m) => m[1]);
    details.Makefile = { targets };
    for (const t of targets) {
      if (/test/i.test(t)) tests.push(`make ${t}`);
      if (DEPLOY.test(t)) deploy.push(`make ${t}`);
      if (PROD_DATA.test(t.replace(/[:_-]/g, " "))) prodData.push(`make ${t}`);
    }
  }
  for (const f of files) if (!SKIP.test(f) && /(^|\/)[^/]*(deploy|release)[^/]*\.(sh|bb|mjs|js|py|rb)$/i.test(f)) deploy.push(f);
  if (files.some((f) => f.startsWith("ansible/"))) deploy.push("ansible/");
  const testDirs = ["test", "tests", "spec", "__tests__", "e2e"].filter((d) => files.some((f) => f.startsWith(`${d}/`)));
  for (const d of testDirs) tests.push(`${d}/ (${files.filter((f) => f.startsWith(`${d}/`)).length} files)`);

  const docLines = [];
  for (const f of docs) {
    const lines = (atHead(root, f) ?? "").split("\n");
    for (const [i, l] of lines.entries())
      if (/\b(test|repl|nrepl|port|localhost|run|start)\b/i.test(l) && /(\d{4,5}|`[^`]+`)/.test(l) && docLines.length < 30) docLines.push(`${f}:${i + 1}: ${l.trim().slice(0, 160)}`);
  }

  // Gitignored material present in this checkout that a fresh worktree lacks.
  const ignoredOut = git(root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "--no-empty-directory") ?? "";
  const configText = [tasksText.join("\n"), ...["deps.edn", "shadow-cljs.edn", "Makefile", "Procfile", "Procfile.dev"].filter((f) => has.has(f)).map((f) => atHead(root, f) ?? "")].join("\n");
  const ignored = ignoredOut
    .split("\n")
    .filter(Boolean)
    .filter((p) => p.split("/").filter(Boolean).length <= 2)
    .slice(0, 80)
    .map((p) => {
      const name = p.replace(/\/$/, "");
      const leaf = basename(name);
      const referenced = leaf.length > 2 && configText.includes(leaf);
      return { path: p, referenced };
    });

  const tools = {};
  const mise = ["mise.toml", ".mise.toml", ".tool-versions"].filter((f) => has.has(f));
  const allText = `${configText}\n${mise.map((f) => atHead(root, f) ?? "").join("\n")}`;
  for (const t of TOOLS) if (new RegExp(`(^|[\\s"'(\\[/=])${t.replace(/[-]/g, "\\-")}([\\s"')\\]]|$)`, "m").test(allText)) tools[t] = which(t);
  const staticSite = !has.has("package.json") && !stack.some((f) => f !== "Makefile") && ["index.html", "public/index.html", "site/index.html", "docs/index.html"].find((f) => has.has(f));

  const literals = portLiterals(root, files);
  const listen = listening();
  const held = sovaHeld();
  const def = await definitionAtHead(root);
  const suggestedSources = staticSite ? [...stack, staticSite] : stack;
  return {
    root,
    main,
    isMain: resolve(main) === resolve(root),
    head,
    branch,
    dirty: dirty.length,
    stack,
    docs,
    details,
    staticSite: staticSite || null,
    tests,
    deploy: [...new Set(deploy)],
    prodData: [...new Set(prodData)],
    docLines,
    ignored,
    tools,
    mise,
    literals,
    listening: listen,
    sovaHeld: held,
    definition: { state: def.state, ...(def.error ? { error: def.error } : {}), ...(def.def ? { services: def.def.services.map((s) => s.name), canonical: def.canonical } : {}) },
    suggestedSources,
  };
}

function inspectDigest(r) {
  const out = [];
  out.push(`project-verbs inspect: ${r.root}${r.isMain ? " (main checkout)" : ` (worktree of ${r.main})`}`);
  out.push(`HEAD ${r.head?.slice(0, 12) ?? "?"} on ${r.branch ?? "?"}; ${r.dirty} uncommitted change(s) (ignored: this digest reads HEAD).`);
  out.push(`definition at HEAD: ${r.definition.state}${r.definition.error ? ` — ${r.definition.error}` : ""}${r.definition.services ? ` — services ${r.definition.services.join(", ")}${r.definition.canonical ? "" : " (not in canonical form: run fmt)"}` : ""}`);
  out.push("");
  out.push(`stack files: ${r.stack.join(", ") || "none"}${r.staticSite ? `; static site (${r.staticSite})` : ""}`);
  out.push(`docs: ${r.docs.join(", ") || "none"}`);
  for (const [f, d] of Object.entries(r.details)) {
    if (f === "package.json") out.push(`  package.json: ${Object.entries(d.scripts).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join("; ") || "no scripts"}${d.packageManager ? ` (${d.packageManager})` : ""}`);
    else if (f === "bb.edn") out.push(`  bb.edn tasks: ${d.tasks.map((t) => t.name).join(", ")}${d.reads ? `; :init reads ${d.reads.join(", ")}` : ""}`);
    else if (f === "deps.edn") out.push(`  deps.edn aliases: ${d.aliases.map((a) => `:${a}`).join(" ")}`);
    else if (f === "shadow-cljs.edn") out.push(`  shadow-cljs builds: ${d.builds.join(", ")}`);
    else if (f === "Makefile") out.push(`  make targets: ${d.targets.join(", ")}`);
    else if (Array.isArray(d)) out.push(`  ${f}: ${d.map((p) => `${p.name}: ${p.cmd}`).join("; ")}`);
    else if (d.services) out.push(`  ${f}: ${d.services.map((s) => `${s.name}${s.image ? ` (${s.image})` : ""}${s.ports.length ? ` ${s.ports.join(",")}` : ""}`).join("; ")}`);
  }
  out.push("");
  out.push("tests:");
  for (const t of r.tests) out.push(`  ${t}`);
  if (!r.tests.length) out.push("  none found");
  out.push("production data brought here (a data resource copied from what these fill is sensitive: true):");
  for (const d of r.prodData) out.push(`  ${d}`);
  if (!r.prodData.length) out.push("  none found");
  out.push("deploy entrypoints (report them; never run them):");
  for (const d of r.deploy) out.push(`  ${d}`);
  if (!r.deploy.length) out.push("  none found");
  out.push("doc lines naming commands or ports:");
  for (const l of r.docLines) out.push(`  ${l}`);
  out.push("");
  out.push("port literals in tracked files (slot 0 keeps each as its default):");
  for (const l of r.literals.slice(0, 60)) out.push(`  ${l.port}: ${l.refs.join(" ")}`);
  if (!r.literals.length) out.push("  none");
  out.push("gitignored here, missing in a fresh worktree (referenced = named by a task or config):");
  for (const i of r.ignored.filter((x) => x.referenced)) out.push(`  ${i.path} (referenced)`);
  const rest = r.ignored.filter((x) => !x.referenced).map((x) => x.path);
  if (rest.length) out.push(`  also: ${rest.slice(0, 30).join(" ")}${rest.length > 30 ? " …" : ""}`);
  out.push(`tools: ${Object.entries(r.tools).map(([t, p]) => `${t}${p ? "" : " (missing)"}`).join(", ") || "none named"}${r.mise.length ? `; mise: ${r.mise.join(", ")} (units need MISE_TRUSTED_CONFIG_PATHS=\${checkout})` : ""}`);
  out.push("");
  out.push(`listening now: ${r.listening.map((l) => `${l.port}${l.owner ? `(${l.owner.comm})` : ""}`).join(" ") || "none visible"}`);
  out.push(r.sovaHeld.readable ? `held by Sova instances: ${r.sovaHeld.ports.map((p) => `${p.port}(${basename(p.project)}#${p.slot ?? "shared"})`).join(" ") || "none"}` : "Sova's registry: not readable here");
  out.push(`suggested sources: ${JSON.stringify(r.suggestedSources)}`);
  out.push("");
  out.push(
    r.definition.state === "present"
      ? "next: node scripts/project-verbs.mjs plan — is there anything to change?"
      : "next: choose isolation per service (references/isolation.md), then write .sova/project.json (references/contract.md).",
  );
  return out.join("\n");
}

// ---- plan: is there anything to do on a rerun? ----------------------------------------------------

export async function plan(root) {
  const files = tracked(root);
  if (!files) return null;
  const def = await definitionAtHead(root);
  const why = [];
  if (def.state === "absent") why.push(`${CONTRACT_FILE} is missing at HEAD: onboard the project.`);
  if (def.state === "invalid") why.push(`${CONTRACT_FILE} at HEAD is invalid: ${def.error}`);
  if (def.state === "unchecked") why.push("Sova's contract module could not be loaded, so the definition can't be checked here.");
  let raw = null;
  try {
    raw = def.text ? JSON.parse(def.text) : null;
  } catch {}
  const sources = Array.isArray(raw?.sources) ? raw.sources.filter((s) => typeof s === "string") : null;
  const since = git(root, "log", "-1", "--format=%H", "HEAD", "--", CONTRACT_FILE)?.trim() || null;
  const has = new Set(files);
  const stack = STACK_FILES.filter((f) => has.has(f));
  let changed = [];
  let unlisted = [];
  let gone = [];
  if (def.state === "present") {
    if (!def.canonical) why.push(`${CONTRACT_FILE} is not in canonical form: run fmt.`);
    if (sources === null && (await parserTakes("sources"))) why.push("The definition records no `sources`: list the files it was derived from.");
    if (sources) {
      gone = sources.filter((s) => !has.has(s));
      unlisted = stack.filter((s) => !sources.includes(s));
      if (since) changed = (git(root, "diff", "--name-only", since, "HEAD", "--", ...sources) ?? "").split("\n").filter(Boolean);
      if (gone.length) why.push(`Sources gone from HEAD: ${gone.join(", ")}.`);
      if (unlisted.length) why.push(`Stack files the sources don't list: ${unlisted.join(", ")}.`);
      if (changed.length) why.push(`Sources changed since the definition's last commit (${since.slice(0, 12)}): ${changed.join(", ")}.`);
    }
    for (const s of def.def.services) if (Object.keys(s.ports).length && !s.about) why.push(`Service ${s.name} has ports but no \`about\`.`);
  }
  return { root, definition: def.state, ...(def.error ? { error: def.error } : {}), since, sources, changed, unlisted, gone, why, nothing: why.length === 0 };
}

function planDigest(p) {
  const out = [`project-verbs plan: ${p.root}`, `definition at HEAD: ${p.definition}${p.since ? `, last changed in ${p.since.slice(0, 12)}` : ""}`];
  if (p.nothing) {
    out.push("Nothing points at a change: the sources are unchanged since the definition's last commit and every stack file is listed.");
    out.push("next: confirm with the conform report (status/doctor), and if nothing else is wrong end with 'No change: the contract matches the project.'");
  } else {
    for (const w of p.why) out.push(`- ${w}`);
    out.push("next: reconcile only these (keep everything they don't contradict), then fmt, check, commit, conform.");
  }
  return out.join("\n");
}

// ---- check: parse as the engine does, then the playbook's lints ----------------------------------

export async function check(file, root) {
  const text = readText(file);
  if (text === null) return { file, ok: false, problems: [`${file} can't be read`], notes: [], fatal: true };
  const c = await loadContract();
  if (!c) return { file, ok: false, problems: ["Sova's contract module could not be loaded (run this from Sova's playbooks/ folder)"], notes: [], fatal: true };
  const problems = [];
  const notes = [];
  let def;
  try {
    def = c.parseDefinition(text);
  } catch (err) {
    return { file, ok: false, problems: [err instanceof Error ? err.message : String(err)], notes, fatal: false };
  }
  let canonicalOk = false;
  try {
    canonicalOk = formatText(text) === text;
  } catch {}
  if (!canonicalOk) problems.push("not in canonical form: run fmt");
  const raw = JSON.parse(text);
  const takesSources = await parserTakes("sources");
  const takesIsolation = await parserTakes("isolation");
  if (takesSources && !Array.isArray(raw.sources)) problems.push("$.sources: list the files the definition was derived from (drift is measured over them)");
  if (takesSources && Array.isArray(raw.sources) && root) {
    const have = new Set(tracked(root) ?? []);
    for (const s of raw.sources) if (typeof s === "string" && have.size && !have.has(s)) problems.push(`$.sources: ${s} is not tracked at HEAD`);
  }
  const listen = new Map(listening().map((l) => [l.port, l]));
  const held = sovaHeld().ports;
  const top = def.slots.cap + 2;
  for (const s of def.services) {
    const at = `$.services.${s.name}`;
    if (takesIsolation && !isObj(raw.services?.[s.name]?.isolation)) problems.push(`${at}.isolation: record {method, why} (references/isolation.md)`);
    if (s.container) notes.push(`${at}: a container service conforms only after the operator approves the definition`);
    if (Object.keys(s.ports).length && !s.about) notes.push(`${at}.about: say how a builder uses it (a client command with its port)`);
    for (const [k, p] of Object.entries(s.ports)) {
      if ("fixed" in p && s.scope === "checkout") problems.push(`${at}.ports.${k}: a fixed port on a checkout service gives every instance the same port; use {base, stride}`);
      for (let slot = 0; slot <= top; slot++) {
        const n = c.portFor(p, slot);
        const l = listen.get(n);
        const h = held.find((x) => x.port === n && !(resolve(x.project) === resolve(root ?? "") && x.slot === slot && x.service === s.name));
        // Slot 0 is the main checkout's own: what listens there today is usually the app itself.
        if (slot > 0 && l) problems.push(`${at}.ports.${k}: slot ${slot} gives ${n}, which ${l.owner ? `${l.owner.comm} (pid ${l.owner.pid})` : "something"} listens on now`);
        if (h) problems.push(`${at}.ports.${k}: slot ${slot} gives ${n}, which Sova instance ${h.instance} (${basename(h.project)}) holds`);
        if ("fixed" in p) break;
      }
    }
  }
  for (const d of def.data)
    if (d.kind === "dir" && d.from !== "empty" && !/^\$\{(main|checkout)\}/.test(d.from)) problems.push(`$.data.${d.name}.from: copy from inside the project (\${main}/… or \${checkout}/…); a path outside it is refused under confinement`);
  return { file, ok: problems.length === 0, problems, notes, services: def.services.map((s) => s.name), fatal: false };
}

// ---- ram: memory per unit (systemd cgroups) or per process tree (/proc) ---------------------------

function findSlice(dir, depth = 0) {
  if (depth > 6) return null;
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of ents) if (e.isDirectory() && e.name === "sova-services.slice") return join(dir, e.name);
  for (const e of ents) {
    if (!e.isDirectory() || !/\.(slice|service)$/.test(e.name)) continue;
    const f = findSlice(join(dir, e.name), depth + 1);
    if (f) return f;
  }
  return null;
}
const num = (f) => {
  const t = readText(f);
  const n = t === null ? NaN : Number(t.trim());
  return Number.isFinite(n) ? n : null;
};

function treeRss(pid) {
  const kids = new Map();
  let pids = [];
  try {
    pids = readdirSync("/proc").filter((p) => /^\d+$/.test(p));
  } catch {}
  for (const p of pids) {
    const st = readText(`/proc/${p}/stat`);
    if (!st) continue;
    const ppid = Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]);
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(Number(p));
  }
  let total = 0;
  let seen = 0;
  const walk = (p) => {
    const s = readText(`/proc/${p}/status`);
    const m = s && /^VmRSS:\s+(\d+)\s+kB/m.exec(s);
    if (m) {
      total += Number(m[1]) * 1024;
      seen++;
    }
    for (const k of kids.get(p) ?? []) walk(k);
  };
  walk(pid);
  return seen ? total : null;
}

export function ram({ instances = [], units = [], pids = [], cgroupRoot = "/sys/fs/cgroup" } = {}) {
  const rows = [];
  const slice = findSlice(cgroupRoot);
  if (slice) {
    let ents = [];
    try {
      ents = readdirSync(slice).filter((n) => n.endsWith(".service"));
    } catch {}
    for (const n of ents) {
      const unit = n.replace(/\.service$/, "");
      const want = units.includes(unit) || instances.some((i) => unit.includes(`-${i}-`));
      if (!want) continue;
      rows.push({ unit, current: num(join(slice, n, "memory.current")), peak: num(join(slice, n, "memory.peak")), source: "cgroup" });
    }
  }
  for (const u of units) if (!rows.some((r) => r.unit === u)) rows.push({ unit: u, current: null, peak: null, source: slice ? "not running" : "no cgroup view" });
  for (const p of pids) rows.push({ unit: `pid ${p}`, current: treeRss(p), peak: null, source: "proc" });
  return { slice, rows, total: rows.reduce((a, r) => a + (r.current ?? 0), 0) };
}

const mib = (n) => (n === null || n === undefined ? "?" : `${(n / 1048576).toFixed(0)} MiB`);

// ---- CLI ----------------------------------------------------------------------------------------

function args(argv) {
  const o = { _: [], instance: [], unit: [], pid: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "--check") o[a.slice(2)] = true;
    else if (["--root", "--instance", "--unit", "--pid"].includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      const k = a.slice(2);
      if (Array.isArray(o[k])) o[k].push(k === "pid" ? Number(v) : v);
      else o[k] = v;
    } else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
    else o._.push(a);
  }
  return o;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  let o;
  try {
    o = args(rest);
  } catch (err) {
    console.error(`project-verbs: ${err.message}`);
    return 2;
  }
  const root = o.root ? resolve(o.root) : gitRoot(process.cwd());
  const print = (v, digest) => console.log(o.json ? JSON.stringify(v, null, 2) : digest(v));
  if (cmd === "ram") {
    const r = ram({ instances: o.instance, units: o.unit, pids: o.pid });
    print(r, (x) =>
      [
        `project-verbs ram: ${x.slice ?? "no sova-services.slice visible (sandboxed, or nothing ever ran under systemd here)"}`,
        ...x.rows.map((row) => `  ${row.unit}: ${mib(row.current)} now${row.peak !== null ? `, peak ${mib(row.peak)}` : ""} (${row.source})`),
        `  total now: ${mib(x.total)}`,
      ].join("\n"),
    );
    return r.rows.length ? 0 : 1;
  }
  if (!root) {
    console.error("project-verbs: not inside a git checkout (pass --root)");
    return 2;
  }
  if (cmd === "inspect") {
    const r = await inspect(root);
    if (!r) return (console.error("project-verbs: can't read the repository's HEAD"), 2);
    print(r, inspectDigest);
    return r.definition.state === "present" ? 0 : 1;
  }
  if (cmd === "plan") {
    const p = await plan(root);
    if (!p) return (console.error("project-verbs: can't read the repository's HEAD"), 2);
    print(p, planDigest);
    return p.definition === "unchecked" ? 2 : p.nothing ? 0 : 1;
  }
  if (cmd === "check") {
    const file = resolve(o._[0] ?? join(root, CONTRACT_FILE));
    const r = await check(file, root);
    print(r, (x) =>
      [
        `project-verbs check: ${x.file}: ${x.ok ? "ok" : `${x.problems.length} problem(s)`}${x.services ? ` — services ${x.services.join(", ")}` : ""}`,
        ...x.problems.map((p) => `  problem: ${p}`),
        ...x.notes.map((n) => `  note: ${n}`),
      ].join("\n"),
    );
    return r.fatal ? 2 : r.ok ? 0 : 1;
  }
  if (cmd === "fmt") {
    const file = resolve(o._[0] ?? join(root, CONTRACT_FILE));
    const text = readText(file);
    if (text === null) return (console.error(`project-verbs: ${file} can't be read`), 2);
    let out;
    try {
      out = formatText(text);
    } catch (err) {
      console.error(`project-verbs: ${file} is not JSON: ${err.message}`);
      return 1;
    }
    if (out === text) {
      console.log(`project-verbs fmt: ${file} is canonical`);
      return 0;
    }
    if (o.check) {
      console.log(`project-verbs fmt: ${file} is not canonical (run fmt without --check)`);
      return 1;
    }
    writeFileSync(file, out);
    console.log(`project-verbs fmt: rewrote ${file}`);
    return 0;
  }
  console.error("usage: project-verbs <inspect|plan|check|fmt|ram> … (see the header of scripts/project-verbs.mjs)");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`project-verbs: ${err instanceof Error ? err.stack : err}`);
      process.exit(2);
    },
  );
}
