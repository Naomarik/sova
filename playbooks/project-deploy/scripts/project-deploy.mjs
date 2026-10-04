#!/usr/bin/env node
// project-deploy: the Project deploy playbook's mechanical reading (§app.project-runtime/deploy-playbook).
// It only reads and formats; it never runs a deploy, a build, a credential check or anything that
// reaches a target. Node builtins, plus the Project verbs driver it shares the canonical form with.
//
//   node scripts/project-deploy.mjs candidates [--root <checkout>] [--json]
//     the deploy entrypoints the repository holds (scripts, tasks, deploy files), quoted, never run;
//     the definition's host names and its current deploy targets. Exit 0.
//   node scripts/project-deploy.mjs check [file] [--root <checkout>] [--json]
//     Sova's own parser on the definition, which must declare deploy; then what the parser can't
//     see: a literal address or user@host in a step (use ${host.NAME}), a shell string inside an
//     argv (sh -c, bash -c), a value that looks like a secret, a target with no verify. Exit 0 ok,
//     1 problems, 2 couldn't check.
//   node scripts/project-deploy.mjs fmt [file] [--root <checkout>] [--check]
//     the canonical form, the same as project-verbs.mjs fmt.

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { CONTRACT_FILE, formatText, inspect } from "../../project-verbs/scripts/project-verbs.mjs";

const IPV4 = /(^|[^\d.])((25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(25[0-5]|2[0-4]\d|1?\d?\d)(?![\d.])/;
/** user@host with a literal dotted host (an address the repository would publish). */
const USER_AT_HOST = /[A-Za-z0-9._-]+@[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/;
const LITERAL_URL = /^https?:\/\/[A-Za-z0-9-]+\.[A-Za-z0-9.-]+/;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "/bin/sh", "/bin/bash", "/usr/bin/env"]);
const SECRETISH = /(token|secret|password|passwd|apikey|api_key|bearer)\s*[=:]\s*\S{6,}|\b(ghp|gho|github_pat|sk|xox[bpa])[-_][A-Za-z0-9_]{12,}/i;

const readText = (f) => {
  try {
    return readFileSync(f, "utf8");
  } catch {
    return null;
  }
};

function gitRoot(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function loadContract() {
  try {
    return await import(new URL("../../../shared/project-contract.ts", import.meta.url).href);
  } catch {
    return null;
  }
}

/** The repository's deploy candidates (from the Project verbs driver's inspect), host names and current targets. Reads only. */
export async function candidates(root) {
  const r = await inspect(root);
  if (!r) return null;
  let def = null;
  try {
    def = JSON.parse(execFileSync("git", ["-C", root, "show", `HEAD:${CONTRACT_FILE}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {}
  const targets = def && def.deploy && def.deploy.targets && typeof def.deploy.targets === "object" ? Object.keys(def.deploy.targets) : [];
  return { root, entrypoints: r.deploy, host: Array.isArray(def?.host) ? def.host : [], targets };
}

/** Problems Sova's parser can't see in a deploy section (pure, for tests). */
export function deployProblems(raw) {
  const problems = [];
  const notes = [];
  const targets = raw?.deploy?.targets && typeof raw.deploy.targets === "object" ? raw.deploy.targets : {};
  for (const [name, t] of Object.entries(targets)) {
    const lists = [
      ...["plan", "build", "steps"].map((l) => [l, Array.isArray(t?.[l]) ? t[l] : []]),
      ["rollback", Array.isArray(t?.rollback?.steps) ? t.rollback.steps : []],
    ];
    const argvs = [
      ...lists.flatMap(([l, steps]) => steps.map((s) => [`${name}.${l}.${s?.id}`, Array.isArray(s?.run) ? s.run : []])),
      ...(Array.isArray(t?.credentials) ? t.credentials.map((c) => [`${name}.credentials.${c?.name}`, Array.isArray(c?.check) ? c.check : []]) : []),
    ];
    for (const [where, argv] of argvs) {
      if (SHELLS.has(argv[0]) && argv.some((a) => a === "-c" || a === "-lc")) problems.push(`${where}: a shell string inside an argv; put it in a script under .sova/bin/ the operator agreed to, and run that`);
      for (const a of argv) {
        const plain = String(a).replace(/\$\{[^}]*\}/g, "");
        if (IPV4.test(plain)) problems.push(`${where}: a literal IP address (${a}); use \${host.NAME}`);
        else if (USER_AT_HOST.test(plain)) problems.push(`${where}: a literal user@host (${a}); use \${host.NAME}`);
        if (SECRETISH.test(a)) problems.push(`${where}: a value that looks like a secret; credentials go by name only`);
      }
    }
    const url = t?.verify?.http;
    if (typeof url === "string" && (LITERAL_URL.test(url) || IPV4.test(url))) problems.push(`${name}.verify.http: a literal address (${url}); use https://\${host.NAME}/…`);
    if (!t?.verify) notes.push(`${name}: no verify; a deploy is then done when its steps exit 0`);
  }
  return { problems, notes };
}

/** Sova's parser, the canonical form, and what the parser can't see. */
export async function check(file) {
  const text = readText(file);
  if (text === null) return { file, ok: false, problems: [`${file} can't be read`], notes: [], fatal: true };
  const c = await loadContract();
  if (!c) return { file, ok: false, problems: ["Sova's contract module could not be loaded (run this from Sova's playbooks/ folder)"], notes: [], fatal: true };
  let def;
  try {
    def = c.parseDefinition(text);
  } catch (err) {
    return { file, ok: false, problems: [err instanceof Error ? err.message : String(err)], notes: [], fatal: false };
  }
  if (!def.deploy) return { file, ok: false, problems: ["$.deploy: the definition declares no deploy"], notes: [], fatal: false };
  const problems = [];
  let canonicalOk = false;
  try {
    canonicalOk = formatText(text) === text;
  } catch {}
  if (!canonicalOk) problems.push("not in canonical form: run fmt");
  const more = deployProblems(JSON.parse(text));
  problems.push(...more.problems);
  return { file, ok: problems.length === 0, problems, notes: more.notes, fatal: false, targets: def.deploy.targets.map((t) => t.name) };
}

function args(list) {
  const o = { _: [] };
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (a === "--json" || a === "--check") o[a.slice(2)] = true;
    else if (a === "--root") o.root = list[++i];
    else if (a.startsWith("--")) throw new Error(`unknown option ${a}`);
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
    console.error(`project-deploy: ${err.message}`);
    return 2;
  }
  const root = o.root ? resolve(o.root) : gitRoot(process.cwd());
  if (!root) {
    console.error("project-deploy: not inside a git checkout (pass --root)");
    return 2;
  }
  const print = (v, digest) => console.log(o.json ? JSON.stringify(v, null, 2) : digest(v));
  if (cmd === "candidates") {
    const r = await candidates(root);
    if (!r) return (console.error("project-deploy: can't read the repository's HEAD"), 2);
    print(r, (x) =>
      [
        `project-deploy candidates: ${x.root}`,
        "deploy entrypoints (offer them, quoted; never run them):",
        ...(x.entrypoints.length ? x.entrypoints.map((d) => `  ${d}`) : ["  none found: ask the operator how they ship today"]),
        `host names declared: ${x.host.length ? x.host.join(", ") : "none"}`,
        `deploy targets declared: ${x.targets.length ? x.targets.join(", ") : "none"}`,
      ].join("\n"),
    );
    return 0;
  }
  if (cmd === "check") {
    const file = resolve(o._[0] ?? join(root, CONTRACT_FILE));
    const r = await check(file);
    print(r, (x) =>
      [
        `project-deploy check: ${x.file}: ${x.ok ? "ok" : `${x.problems.length} problem(s)`}${x.targets ? ` — targets ${x.targets.join(", ")}` : ""}`,
        ...x.problems.map((p) => `  problem: ${p}`),
        ...x.notes.map((n) => `  note: ${n}`),
      ].join("\n"),
    );
    return r.fatal ? 2 : r.ok ? 0 : 1;
  }
  if (cmd === "fmt") {
    const file = resolve(o._[0] ?? join(root, CONTRACT_FILE));
    const text = readText(file);
    if (text === null) return (console.error(`project-deploy: ${file} can't be read`), 2);
    let out;
    try {
      out = formatText(text);
    } catch (err) {
      console.error(`project-deploy: ${file} is not JSON: ${err.message}`);
      return 1;
    }
    if (out === text) return (console.log(`project-deploy fmt: ${file} is canonical`), 0);
    if (o.check) return (console.log(`project-deploy fmt: ${file} is not canonical (run fmt without --check)`), 1);
    writeFileSync(file, out);
    console.log(`project-deploy fmt: rewrote ${file}`);
    return 0;
  }
  console.error("usage: project-deploy <candidates|check|fmt> … (see the header of scripts/project-deploy.mjs)");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main().then((code) => process.exit(code));
}
