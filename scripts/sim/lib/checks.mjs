// Contract-free checks: they read files and texts, never a tool name or a route.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** sha256 of every file under <root>/.sova/spec/claims plus manifest.json, path by path. */
export function specHashes(root) {
  const spec = join(root, ".sova", "spec");
  const out = {};
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const n of readdirSync(dir).sort()) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(root, p)] = createHash("sha256").update(readFileSync(p)).digest("hex");
    }
  };
  walk(join(spec, "claims"));
  const m = join(spec, "manifest.json");
  if (existsSync(m)) out[relative(root, m)] = createHash("sha256").update(readFileSync(m)).digest("hex");
  return out;
}

/** The same files at a git revision (master's committed spec), or null when the root has no git. */
export function specHashesAt(root, rev = "HEAD") {
  try {
    const names = execFileSync("git", ["-C", root, "ls-tree", "-r", "--name-only", rev, "--", ".sova/spec/claims", ".sova/spec/manifest.json"], { encoding: "utf8" }).split("\n").filter(Boolean);
    const out = {};
    for (const n of names) out[n] = createHash("sha256").update(execFileSync("git", ["-C", root, "show", `${rev}:${n}`])).digest("hex");
    return out;
  } catch {
    return null;
  }
}

export function sameHashes(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const diff = [...keys].filter((k) => a[k] !== b[k]);
  return { ok: diff.length === 0, diff };
}

/** Every regex in `patterns` (case-insensitive) that matches `text`, with a snippet around the hit. */
export function hits(text, patterns) {
  const out = [];
  for (const p of patterns) {
    const m = new RegExp(p, "i").exec(text);
    if (m) out.push({ pattern: p, at: text.slice(Math.max(0, m.index - 60), m.index + m[0].length + 60).replace(/\s+/g, " ") });
  }
  return out;
}

/** Which requirement groups a text holds: {found: [...], missing: [...]} per kind. */
export function requirementGroups(text, groups) {
  const r = {};
  for (const kind of ["required", "optional"]) {
    const found = [], missing = [];
    for (const [name, pats] of Object.entries(groups[kind] ?? {})) (pats.some((p) => new RegExp(p, "i").test(text)) ? found : missing).push(name);
    r[kind] = { found, missing };
  }
  return r;
}

/** A pi session file's entries. */
export function readJsonl(path) {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

/** Every tool call and its result in a session file: [{name, args, result}] (result as text). */
export function toolExchanges(entries) {
  const calls = new Map();
  const out = [];
  for (const e of entries) {
    const m = e.type === "message" ? e.message : null;
    if (!m) continue;
    if (m.role === "assistant") for (const c of m.content ?? []) if (c.type === "toolCall") calls.set(c.id, { name: c.name, args: c.arguments });
    if (m.role === "toolResult") {
      const text = (m.content ?? []).map((c) => (c.type === "text" ? c.text : "")).join("\n");
      out.push({ ...(calls.get(m.toolCallId) ?? { name: m.toolName }), result: text, isError: !!m.isError });
    }
  }
  return out;
}

/** Text added in `draftRoot`'s spec relative to `masterRoot`'s: every claims line not in master. */
export function addedSpecText(draftSpecDir, masterSpecDir) {
  const lines = (dir) => {
    const s = new Set();
    const walk = (d) => {
      if (!existsSync(d)) return;
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (n.endsWith(".md")) for (const l of readFileSync(p, "utf8").split("\n")) s.add(l.trim());
      }
    };
    walk(join(dir, "claims"));
    return s;
  };
  const master = lines(masterSpecDir);
  return [...lines(draftSpecDir)].filter((l) => l && !master.has(l)).join("\n");
}

/** Spec drafts under a directory tree: every `drafts/<name>/spec` holding a manifest.json. */
export function findDrafts(...roots) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 6 || !existsSync(d)) return;
    for (const n of readdirSync(d)) {
      if (n === "node_modules" || n === ".git") continue;
      const p = join(d, n);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (n === "spec" && d.split("/").at(-2) === "drafts" && existsSync(join(p, "manifest.json"))) out.push(p);
      else walk(p, depth + 1);
    }
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/** Quoted spans of `minWords`+ words, quotes paired left to right within one line ("…", “…”, «…»). */
export function longQuotes(text, minWords = 4) {
  const out = [];
  for (const line of text.split("\n"))
    for (const re of [/"([^"]*)"/g, /“([^”]*)”/g, /«([^»]*)»/g])
      for (const m of line.matchAll(re)) if (m[1].trim().split(/\s+/).filter(Boolean).length >= minWords) out.push(m[0]);
  return out;
}
