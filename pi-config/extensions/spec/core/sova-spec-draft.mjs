#!/usr/bin/env node
// sova-spec-draft: isolated proposal drafts of a project's .sova/spec, and guarded promotion. Node stdlib only.
//   new NAME [--purpose TEXT] [--write]                  literal copy of manifest + whole claims tree
//   status NAME | diff NAME [--against base|current]      never write
//   check NAME [--base REV]                              the sibling core's `check` over the draft graph, plus drift checks
//   evidence NAME --id §x... --by WHO --verification TEXT (--commit REV | --snapshot | --doc-only)
//            [--path P]... [--log FILE] [--write]        record implementation + verification evidence
//   promote NAME (--id §x... | --all) [--meta KEY]... [--file PATH]... [--plan SHA] [--write]
//   recover [--write]                                    roll back an interrupted promotion
//   merge-manifest [--base F --ours F --theirs F] [--write]  record-level 3-way merge of manifest.json (a Git conflict)
// All take --root DIR (required) and [--json]. Writes happen only with --write, only under
// .sova/spec/drafts/, except `promote --write`/`recover --write`, which also write .sova/spec/manifest.json
// and files in the claims tree. It runs only the sibling core (`sova-spec.mjs`) and, in a Git project,
// read-only `git` plumbing (rev-parse, cat-file, merge-base), always without a shell. It never runs a
// project script and never implements anything.
// Exit: 0 done / nothing outstanding; 1 refused or outstanding (conflict, evidence missing or stale,
//       selection incomplete, lock held, pending transaction, race); 2 cannot (usage, corrupt draft,
//       symlink, core contract, Git unusable).
// Limits, stated honestly: the machine checks bytes, revisions and graph structure, never that code
// implements prose; evidence text is the recorder's claim. Prose is merged per declaration (H1 lede or H2
// span): one changed on both sides, differently, is a conflict, never merged as text. The lock and the before-hash checks keep COOPERATING
// writers apart; a writer racing between a check and a rename, or a parent directory swapped for a
// symlink, is not fully prevented with portable fs calls.
import { open, lstat, mkdir, writeFile, rename, link, unlink, rm, readdir, rmdir, mkdtemp } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { resolve, join, dirname, posix, relative } from "node:path";
import { realpathSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { fileURLToPath } from "node:url";
import { createInspection } from "./sova-spec.mjs";

const CORE = join(dirname(fileURLToPath(import.meta.url)), "sova-spec.mjs");
const FORMAT = "sova-spec-draft/1";
const SPEC = ".sova/spec", DRAFTS = `${SPEC}/drafts`, LOCK = `${DRAFTS}/.lock`, TXN = `${DRAFTS}/.txn`;
const MAX_FILE_BYTES = 2 * 1024 * 1024, MAX_TOTAL_BYTES = 64 * 1024 * 1024, MAX_CORE_STDOUT = 64 * 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ID_RE = /^§[a-z][a-z-]*(?:\.[a-z][a-z-]*)?\/[a-z][a-z-]*$/;
const HEX = /^[0-9a-f]{64}$/;
// Kinds that carry no implementation: their prose may be promoted on --doc-only evidence.
const DOC_ONLY_KINDS = new Set(["note", "section"]);
// Kinds whose record may say who agreed to its wording before it is built (`agreed: {by, at}`); with no `code`
// such a record may land on --doc-only evidence too. Built = `code` plus one of BUILT_LABELS as its `evidence`.
const AGREED_KINDS = new Set(["behavior", "surface"]), BUILT_LABELS = new Set(["reviewed", "verified"]);
const AGREED_AT = /^(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))?$/;
const STARTER = JSON.stringify({ formatVersion: 1, claims: {} }, null, 2) + "\n";
const SECRET_DIRS = new Set([".git", ".hg", ".svn", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"]);
// Credential data by name (secrets.json, .env, id_rsa…), not source or docs named after secrets (secrets.ts, secrets.md).
const SECRET_NAME = /^(?:\.env(?:\..*)?|\.envrc|auth\.json|credentials(?:\.json)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|secrets?(?:(?:[.-][a-z0-9_-]+)*\.(?:json|ya?ml|toml|ini|conf|cfg|env|txt|properties|xml|enc|age|asc))?)$/i;
const SECRET_EXT = /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg)$/i;
const NOTICE = "A draft is a proposal: nothing in it is current until promoted. Evidence is bytes, revisions and the " +
  "recorder's claim; no tool here verifies that code implements prose. Prose conflicts are refused, never merged.";

class Fail extends Error { constructor(exit, code, message, out) { super(message); this.exit = exit; this.code = code; this.out = out; } }
const sha = (b) => createHash("sha256").update(b).digest("hex");
const obj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const sortKeys = (v) => Array.isArray(v) ? v.map(sortKeys) : obj(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;
const canon = (v) => (v === undefined ? null : JSON.stringify(sortKeys(v)));
const uniqSorted = (a) => [...new Set(a)].sort();

// ---------------------------------------------------------------- args
const FLAGS = { new: ["purpose", "write"], status: [], diff: ["against"], check: ["base"],
  evidence: ["id", "by", "verification", "commit", "snapshot", "doc-only", "path", "log", "write"],
  promote: ["id", "all", "meta", "file", "plan", "write", "own-base"], recover: ["write"], "merge-manifest": ["base", "ours", "theirs", "write"] };
const BOOL = new Set(["json", "write", "snapshot", "doc-only", "all"]), MULTI = new Set(["id", "path", "meta", "file", "own-base"]);
function parseArgs(argv) {
  const o = { pos: [], id: [], path: [], meta: [], file: [], "own-base": [], seen: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { o.pos.push(a); continue; }
    const k = a.slice(2);
    if (BOOL.has(k)) { o[k] = true; o.seen.add(k); continue; }
    if (!["root", "purpose", "against", "by", "verification", "commit", "log", "plan", "base", "ours", "theirs", ...MULTI].includes(k)) throw new Fail(2, "usage", `unknown flag ${a}`);
    if (i + 1 >= argv.length) throw new Fail(2, "usage", `${a} needs a value`);
    if (MULTI.has(k)) o[k].push(argv[++i]); else o[k] = argv[++i];
    o.seen.add(k);
  }
  const [cmd, name, ...rest] = o.pos;
  o.cmd = cmd;
  if (!FLAGS[cmd]) throw new Fail(2, "usage", cmd ? `unknown command ${cmd}` : "missing command");
  if (o.root === undefined) throw new Fail(2, "usage", "--root PROJECT is required");
  for (const k of o.seen) if (k !== "root" && k !== "json" && !FLAGS[cmd].includes(k)) throw new Fail(2, "usage", `--${k} does not apply to ${cmd}`);
  if (cmd === "recover" || cmd === "merge-manifest") {
    if (name !== undefined) throw new Fail(2, "usage", `${cmd} takes no arguments`);
    const sides = ["base", "ours", "theirs"].filter((k) => o[k] !== undefined).length;
    if (sides !== 0 && sides !== 3) throw new Fail(2, "usage", "merge-manifest takes all of --base, --ours and --theirs (a merge driver's %O %A %B), or none (the index stages)");
    return o;
  }
  if (name === undefined || rest.length) throw new Fail(2, "usage", `${cmd} takes exactly one draft NAME`);
  if (!NAME_RE.test(name)) throw new Fail(2, "usage", `draft name must match ${NAME_RE}`);
  o.name = name;
  for (const id of o.id) if (!ID_RE.test(id)) throw new Fail(2, "usage", `not a § identifier: ${id}`);
  const text = (k, max) => { if (typeof o[k] !== "string" || !o[k].trim() || o[k].length > max || /[\0-\x08\x0b-\x1f\x7f]/.test(o[k])) throw new Fail(2, "usage", `--${k} needs 1-${max} characters of text`); };
  if (o.purpose !== undefined) text("purpose", 4000);
  if (o.base !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,199}$/.test(o.base)) throw new Fail(2, "usage", "--base is not a plain revision name");
  if (o.against !== undefined && !["base", "current"].includes(o.against)) throw new Fail(2, "usage", "--against must be base or current");
  if (cmd === "evidence") {
    if (!o.id.length) throw new Fail(2, "usage", "evidence needs at least one --id");
    text("by", 128); text("verification", 8000);
    const modes = [o.commit !== undefined, !!o.snapshot, !!o["doc-only"]].filter(Boolean).length;
    if (modes !== 1) throw new Fail(2, "usage", "evidence needs exactly one of --commit REV, --snapshot, --doc-only");
    if (o.commit !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,199}$/.test(o.commit)) throw new Fail(2, "usage", "--commit is not a plain revision name");
    if (o["doc-only"] && o.path.length) throw new Fail(2, "usage", "--doc-only takes no --path");
  }
  if (cmd === "promote") {
    if (!o.id.length && !o.all && !o.meta.length && !o.file.length) throw new Fail(2, "usage", "promote needs --id, --meta, --file or --all");
    if (o.all && (o.id.length || o.meta.length || o.file.length)) throw new Fail(2, "usage", "--all selects everything; do not combine it with --id/--meta/--file");
    if (o.plan !== undefined && !HEX.test(o.plan)) throw new Fail(2, "usage", "--plan takes the 64-hex plan printed by the preview");
    for (const k of o.meta) if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(k) || k === "claims") throw new Fail(2, "usage", `--meta ${k}: a top-level manifest key other than claims`);
    for (const r of o["own-base"]) if (!/^[A-Za-z0-9][A-Za-z0-9._/~^@{}-]{0,199}$/.test(r)) throw new Fail(2, "usage", "--own-base is not a plain revision name");
  }
  return o;
}
const USAGE = "usage: sova-spec-draft <new NAME [--purpose T] | status NAME | diff NAME [--against base|current] | check NAME | " +
  "evidence NAME --id §x --by WHO --verification T (--commit REV|--snapshot|--doc-only) [--path P] [--log FILE] | " +
  "promote NAME (--id §x|--all) [--meta K] [--file P] [--plan SHA] [--own-base REV]... | check NAME [--base REV] | recover | " +
  "merge-manifest [--base F --ours F --theirs F]> --root DIR [--write] [--json]";

// ---------------------------------------------------------------- paths and bytes
function normRel(raw) {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return null;
  const s = raw.split("\\").join("/");
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s) || s.split("/").includes("..")) return null;
  const n = posix.normalize(s).replace(/\/+$/, "");
  return !n || n === "." ? null : n;
}
function secretOf(rel) {
  const segs = rel.split("/");
  if (segs.some((s) => SECRET_DIRS.has(s.toLowerCase()))) return "secret, config or runtime-state directory";
  if (SECRET_EXT.test(segs.at(-1)) || SECRET_NAME.test(segs.at(-1))) return "secret or credential file";
  return null;
}
// A project-relative file: every component lstat'ed, no symlinks, regular, single link, bounded.
// → {state: present|absent|refused, buf?, sha256?, bytes?, why?}
async function readFileSafe(root, rel, { secrets = true } = {}) {
  const why = secrets && secretOf(rel);
  if (why) return { state: "refused", why };
  const segs = rel.split("/");
  let cur = root;
  for (let i = 0; i < segs.length; i++) {
    cur = join(cur, segs[i]);
    let st;
    try { st = await lstat(cur); } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return { state: "absent" };
      return { state: "refused", why: `unreadable (${e.code})` };
    }
    if (st.isSymbolicLink()) return { state: "refused", why: "symlink" };
    if (i < segs.length - 1 && !st.isDirectory()) return { state: "absent" };
    if (i === segs.length - 1 && !st.isFile()) return { state: "refused", why: "not a regular file" };
  }
  return readOpen(cur);
}
async function readOpen(abs) {
  let fh;
  try { fh = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (e) {
    return e.code === "ENOENT" ? { state: "absent" } : { state: "refused", why: e.code === "ELOOP" ? "symlink" : `unreadable (${e.code})` };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { state: "refused", why: "not a regular file" };
    if (st.nlink > 1) return { state: "refused", why: `hard-linked file (${st.nlink} links)` };
    if (st.size > MAX_FILE_BYTES) return { state: "refused", why: `oversize (${st.size} > ${MAX_FILE_BYTES} bytes)` };
    const buf = await fh.readFile();
    if (buf.length > MAX_FILE_BYTES) return { state: "refused", why: "oversize" };
    return { state: "present", buf, sha256: sha(buf), bytes: buf.length };
  } finally { await fh.close(); }
}
// Capture-local metadata from the exact safe bytes used by read-only assessment triage.
async function readSource(root, path, inputSources, readPolicy) {
  const low = path.toLowerCase();
  const storage = readPolicy === "assessment" && [".sova/spec/assessments", ".sova/spec/reviews", ".sova/spec/.cache"].some(d => low === d || low.startsWith(d + "/"));
  const r = storage ? { state: "refused", why: "receipt/cache storage is not an input" } : await readFileSafe(root, path);
  if (inputSources) inputSources.push({ path, state: r.state,
    ...(r.state === "present" ? { sha256: r.sha256, bytes: r.bytes } : {}), ...(r.why ? { why: r.why } : {}) });
  return r;
}
// Every component of a project-relative directory must be a plain directory; created only if asked.
async function ownDir(root, rel, create, made) {
  let cur = root;
  for (const seg of rel.split("/")) {
    cur = join(cur, seg);
    let st;
    try { st = await lstat(cur); } catch (e) {
      if (e.code !== "ENOENT" || !create) return null;
      await mkdir(cur); made?.push(cur); st = await lstat(cur);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Fail(2, "storage-refused", `${rel}: ${seg} is not a plain directory`);
  }
  return cur;
}
const exists = async (p) => { try { await lstat(p); return true; } catch { return false; } };
// Replace or create `name` in `dir` atomically (temp file + rename in the same directory).
async function writeAtomic(dir, name, data) {
  const tmp = join(dir, `.tmp-draft-${randomBytes(8).toString("hex")}`);
  await writeFile(tmp, data, { flag: "wx" });
  try { await rename(tmp, join(dir, name)); } catch (e) { await unlink(tmp).catch(() => {}); throw e; }
}
// Create `name` in `dir` or return false; never overwrites.
async function writeNew(dir, name, data) {
  const tmp = join(dir, `.tmp-draft-${randomBytes(8).toString("hex")}`);
  await writeFile(tmp, data, { flag: "wx" });
  try { await link(tmp, join(dir, name)); return true; } catch (e) { if (e.code === "EEXIST") return false; throw e; } finally { await unlink(tmp); }
}

// ---------------------------------------------------------------- spec trees
// One spec tree at project-relative `rel`: manifest.json plus every file under its claimsRoot.
// Files are keyed relative to `rel`. A symlink, special file or unreadable file anywhere is exit 2.
async function readTree(root, rel, optional, inputSources, readPolicy) {
  const where = (p) => `${rel}/${p}`;
  if ((await ownDir(root, rel, false)) === null) {
    if (optional) {
      inputSources?.push({ path: where("manifest.json"), state: "absent" });
      return { exists: false, claimsRoot: null, manifest: null, files: new Map(), total: 0 };
    }
    throw new Fail(2, "spec-missing", `${rel} does not exist`);
  }
  const m = await readSource(root, where("manifest.json"), inputSources, readPolicy);
  if (m.state === "absent") {
    if (await exists(join(root, rel, "claims")))
      throw new Fail(2, "orphaned-spec", `${rel}/claims exists but ${rel}/manifest.json does not; nothing was changed — restore the manifest (or move the tree aside) before using drafts`);
    if (optional) return { exists: false, claimsRoot: null, manifest: null, files: new Map(), total: 0 };
    throw new Fail(2, "manifest-missing", `${where("manifest.json")} does not exist`);
  }
  if (m.state !== "present") throw new Fail(2, "file-refused", `${where("manifest.json")}: ${m.why}`);
  let manifest;
  try { manifest = JSON.parse(m.buf.toString("utf8")); } catch (e) { throw new Fail(2, "manifest-unreadable", `${where("manifest.json")}: ${e.message}`); }
  if (!obj(manifest) || (manifest.claims !== undefined && !obj(manifest.claims))) throw new Fail(2, "manifest-unreadable", `${where("manifest.json")}: not an object with an object claims`);
  const claimsRoot = normRel(manifest.grammar?.claimsRoot ?? "claims/");
  if (!claimsRoot || claimsRoot === "manifest.json" || /^(drafts|reviews|tools|\.txn)(\/|$)/.test(claimsRoot))
    throw new Fail(2, "claims-root-invalid", `${where("manifest.json")}: grammar.claimsRoot must be a plain directory inside the spec`);
  const files = new Map([["manifest.json", m]]);
  let total = m.bytes;
  const walk = async (sub) => {
    const abs = join(root, rel, sub);
    let names;
    try { names = (await readdir(abs)).sort(); } catch (e) { throw new Fail(2, "claims-unreadable", `${where(sub)}: ${e.code}`); }
    for (const n of names) {
      const p = `${sub}/${n}`, st = await lstat(join(root, rel, p));
      if (st.isSymbolicLink()) throw new Fail(2, "symlink-refused", `${where(p)} is a symlink; drafts never copy or follow links`);
      if (st.isDirectory()) { await walk(p); continue; }
      const r = st.isFile() ? await readSource(root, where(p), inputSources, readPolicy) : { state: "refused", why: "not a regular file" };
      if (r.state !== "present") throw new Fail(2, "file-refused", `${where(p)}: ${r.why ?? r.state}`);
      files.set(p, r); total += r.bytes;
    }
  };
  const cst = await lstat(join(root, rel, claimsRoot)).catch(() => null);
  if (cst?.isSymbolicLink()) throw new Fail(2, "symlink-refused", `${where(claimsRoot)} is a symlink`);
  if (cst?.isDirectory()) { await ownDir(root, `${rel}/${claimsRoot}`, false); await walk(claimsRoot); }
  if (total > MAX_TOTAL_BYTES) throw new Fail(1, "oversize", `${rel} holds ${total} bytes > ${MAX_TOTAL_BYTES}`);
  return { exists: true, claimsRoot, manifest, files, total };
}
const treePrint = (t) => [...t.files].map(([p, f]) => `${p} ${f.sha256}`).join("\n");

// ---------------------------------------------------------------- core
function coreContract(j, status) {
  return !j || j.tool !== "sova-spec" ? "tool is not sova-spec"
    : ![0, 1, 2].includes(j.exit) || j.exit !== status ? "exit missing or differs from process status"
    : !Array.isArray(j.findings) ? "findings is not an array"
    : j.exit !== 2 && !(Array.isArray(j.declarations) && j.declarations.every((d) => obj(d) && ID_RE.test(d.id) && typeof d.file === "string" && HEX.test(d.textSha256 ?? ""))) ? "declarations[] with id/file/textSha256 missing (this tool needs a core with --spec and check declarations)"
    : null;
}
function runCore(root, specRel, readPolicy, inputSources) {
  if (readPolicy !== undefined) {
    const reader = createInspection(root, { spec: specRel, readPolicy });
    if (inputSources) inputSources.push(...reader.sourceHashes().files.map(f => ({ ...f, state: "present" })));
    const j = reader.check();
    const why = coreContract(j, j.exit);
    if (why || Buffer.byteLength(JSON.stringify(j, null, 2) + "\n") > MAX_CORE_STDOUT) throw new Fail(2, "core-contract", `core check does not match the expected contract: ${why ?? "output exceeds capture limit"}`);
    return Promise.resolve(j);
  }
  return new Promise((ok, bad) => {
    const ch = spawn(process.execPath, [CORE, "check", "--root", root, "--spec", specRel, "--json"], { cwd: root, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = []; let n = 0;
    ch.stdout.on("data", (c) => { n += c.length; if (n > MAX_CORE_STDOUT) ch.kill(); else chunks.push(c); });
    ch.stderr.resume();
    ch.on("error", (e) => bad(new Fail(2, "core-unavailable", `cannot run ${CORE}: ${e.message}`)));
    ch.on("close", (status) => {
      let j;
      try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return bad(new Fail(2, "core-contract", `core printed no JSON (status ${status})`)); }
      const why = coreContract(j, status);
      if (why) return bad(new Fail(2, "core-contract", `core check does not match the expected contract: ${why}`));
      ok(j);
    });
  });
}
// Declarations keyed by id, with files made relative to the spec directory.
async function declsOf(root, specRel, readPolicy, inputSources) {
  const j = await runCore(root, specRel, readPolicy, inputSources);
  const decls = new Map();
  for (const d of j.declarations ?? []) decls.set(d.id, { file: d.file.startsWith(`${specRel}/`) ? d.file.slice(specRel.length + 1) : d.file, textSha256: d.textSha256, lines: d.lines });
  return { exit: j.exit, findings: j.findings, decls, counts: j.counts };
}

// ---------------------------------------------------------------- git (read-only plumbing, no shell)
function git(root, args, binary = false, input) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
    shell: false, encoding: binary ? "buffer" : "utf8", maxBuffer: 4 * MAX_FILE_BYTES, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], input,
    env: { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return r.error ? { status: null, error: r.error.code } : { status: r.status, out: r.stdout, err: String(r.stderr ?? "") };
}
// Work-tree diff can execute configured filters even with --no-ext-diff/--no-textconv.
function refuseGitFilters(root, base) {
  const tracked = git(root, ["ls-files", "--cached", "-z", "--", "."]);
  const prior = git(root, ["ls-tree", "--name-only", "-r", "-z", base, "--", "."]);
  if (tracked.status !== 0 || prior.status !== 0) throw new Fail(2, "git-failed", "cannot enumerate paths for Git filter inspection");
  const paths = uniqSorted([...tracked.out.split("\0"), ...prior.out.split("\0")].filter(Boolean));
  if (!paths.length) return;
  const attrs = git(root, ["check-attr", "--all", "-z", "--stdin"], false, paths.join("\0") + "\0");
  if (attrs.status !== 0) throw new Fail(2, "git-failed", "cannot inspect Git filter attributes");
  const fields = attrs.out.split("\0");
  if (fields.pop() !== "" || fields.length % 3 !== 0) throw new Fail(2, "git-failed", "unexpected Git filter attribute output");
  const drivers = new Set();
  for (let i = 0; i < fields.length; i += 3) {
    // --all omits absent/reset attributes, distinguishing them from literal filter=unspecified.
    // Boolean set/unset still collide with literal driver names and must fail closed.
    if (fields[i + 1] === "filter") drivers.add(fields[i + 2]);
  }
  for (const driver of drivers) for (const kind of ["clean", "process"]) {
    const r = git(root, ["config", "--get", `filter.${driver}.${kind}`]);
    if (r.status !== 0 && r.status !== 1) throw new Fail(2, "git-failed", "cannot inspect selected Git filter configuration");
    if (r.status === 0 && r.out.trim()) throw new Fail(2, "git-filter-refused", "a tracked path's filter attribute names or is ambiguous with a configured Git clean/process filter; read-only work-tree inspection is unsupported and no diff was run");
  }
}
async function dotGitAbove(root) {
  for (let d = root; ; d = dirname(d)) { if (await exists(join(d, ".git"))) return true; if (dirname(d) === d) return false; }
}
// {git:false} | {git:true, prefix}: prefix is the project root relative to the work tree top.
async function gitInfo(root) {
  const r = git(root, ["rev-parse", "--show-toplevel"]);
  if (r.status === 0) {
    const top = realpathSync(r.out.trim()), here = realpathSync(root);
    const prefix = relative(top, here).split("\\").join("/");
    if (prefix.startsWith("..")) throw new Fail(2, "git-unusable", "the project root is outside the Git work tree git reports");
    // An enclosing repository that ignores this project (a home-directory dotfiles repo, say) and tracks
    // nothing in it is not this project's Git: the project is treated as having none.
    if (prefix && git(root, ["-C", top, "check-ignore", "-q", "--", `${prefix}/`]).status === 0 &&
        git(root, ["-C", top, "ls-files", "--", `${prefix}/`]).out === "")
      return { git: false, ignoredBy: top };
    return { git: true, prefix };
  }
  if (await dotGitAbove(root)) throw new Fail(2, "git-unusable", `a .git exists but git ${r.error ? `cannot run (${r.error})` : `fails: ${r.err.trim()}`}; refusing to treat this as a no-Git project`);
  return { git: false };
}
function resolveCommit(root, rev) {
  const r = git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
  return r.status === 0 ? r.out.trim() : null;
}
const isAncestor = (root, oid) => git(root, ["merge-base", "--is-ancestor", oid, "HEAD"]).status === 0;
function blobAt(root, g, oid, path) {
  const spec = `${oid}:${g.prefix ? `${g.prefix}/` : ""}${path}`;
  if (git(root, ["cat-file", "-e", spec]).status !== 0) return { state: "absent" };
  if (git(root, ["cat-file", "-t", spec]).out?.trim() !== "blob") return { state: "refused", why: "not a file at that commit" };
  const r = git(root, ["cat-file", "blob", spec], true);
  if (r.status !== 0) return { state: "refused", why: "unreadable at that commit" };
  return { state: "present", sha256: sha(r.out), bytes: r.out.length };
}

// ---------------------------------------------------------------- draft storage
const draftRel = (name) => `${DRAFTS}/${name}`;
async function loadDraft(root, name, inputSources, readPolicy) {
  const rel = draftRel(name);
  if (!(await ownDir(root, rel, false))) throw new Fail(2, "draft-missing", `no draft ${rel}`);
  const raw = await readSource(root, `${rel}/draft.json`, inputSources, readPolicy);
  if (raw.state !== "present") throw new Fail(2, "draft-corrupt", `${rel}/draft.json: ${raw.why ?? raw.state}`);
  let d;
  try { d = JSON.parse(raw.buf.toString("utf8")); } catch (e) { throw new Fail(2, "draft-corrupt", `draft.json: ${e.message}`); }
  const why = draftSchema(d, name);
  if (why) throw new Fail(2, "draft-corrupt", `draft.json is not a valid ${FORMAT} draft named ${name}: ${why}`);
  // The baseline is immutable: exactly the recorded files with exactly the recorded bytes.
  const base = await readTree(root, `${rel}/base`, true, inputSources, readPolicy);
  const want = Object.entries(d.base.files).map(([p, h]) => `${p} ${h}`).sort().join("\n");
  const got = [...base.files].map(([p, f]) => `${p} ${f.sha256}`).sort().join("\n");
  if (want !== got || base.exists !== d.base.specExisted) throw new Fail(2, "base-tampered", `${rel}/base no longer matches the baseline recorded in draft.json; a draft's baseline is never edited — start a new draft`);
  return { d, rel, base, sha: raw.sha256 };
}
const strs = (x) => Array.isArray(x) && x.every((s) => typeof s === "string");
function draftSchema(d, name) {
  if (!obj(d) || d.format !== FORMAT || d.name !== name) return "format/name";
  if (!obj(d.base) || typeof d.base.specExisted !== "boolean" || !obj(d.base.files)) return "base";
  for (const [p, h] of Object.entries(d.base.files)) if (!normRel(p) || !HEX.test(h)) return `base file ${p}`;
  if (d.base.commit !== undefined && !/^[0-9a-f]{40,64}$/.test(d.base.commit)) return "base commit";
  if (!Array.isArray(d.evidence) || !Array.isArray(d.promotions)) return "evidence/promotions";
  for (const e of d.evidence) {
    if (!obj(e) || !["commit", "snapshot", "doc-only"].includes(e.mode) || typeof e.by !== "string" || typeof e.verification !== "string") return "evidence entry";
    if (!Array.isArray(e.ids) || !e.ids.length || !e.ids.every((x) => obj(x) && ID_RE.test(x.id) && (x.recordSha === null || HEX.test(x.recordSha)) && (x.textSha256 === null || HEX.test(x.textSha256)))) return "evidence ids";
    if (!Array.isArray(e.inputs) || !e.inputs.every((i) => obj(i) && normRel(i.path) === i.path && (i.state === "absent" ? i.sha256 === undefined : i.state === "present" && HEX.test(i.sha256 ?? "")))) return "evidence inputs";
    if (e.mode === "commit" ? !/^[0-9a-f]{40,64}$/.test(e.commit ?? "") : e.commit !== undefined) return "evidence commit";
    if (e.log !== undefined && !(obj(e.log) && HEX.test(e.log.sha256 ?? ""))) return "evidence log";
  }
  return null;
}
async function saveDraft(root, rel, d) { await writeAtomic(await ownDir(root, rel, false), "draft.json", JSON.stringify(d, null, 2) + "\n"); }

// ---------------------------------------------------------------- lock and pending transaction
async function withLock(root, fn, { takeOverDead = false } = {}) {
  const dir = await ownDir(root, DRAFTS, true);
  const lock = join(dir, ".lock"), token = `${process.pid} ${hostname()} ${randomBytes(8).toString("hex")} ${new Date().toISOString()}`;
  const take = () => writeFile(lock, token, { flag: "wx" });
  try { await take(); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const held = ((await readOpen(lock)).buf ?? Buffer.from("?")).toString("utf8").trim();
    const [pid, host] = held.split(" ");
    if (!(takeOverDead && host === hostname() && /^\d+$/.test(pid) && !alive(Number(pid))))
      throw new Fail(1, "lock-occupied", `${LOCK} is held (${held}); another writer may be active. It was not removed.`);
    // recover only: the holder on this host is gone. A competitor that takes the lock at any point
    // here wins; we fail closed with lock-occupied and never remove a lock whose contents changed.
    const busy = () => new Fail(1, "lock-occupied", `${LOCK} was taken by another writer during takeover; it was not removed.`);
    if ((await readOpen(lock)).buf?.toString("utf8").trim() !== held) throw busy();
    await unlink(lock).catch((u) => { if (u.code !== "ENOENT") throw u; });
    try { await take(); } catch (t) { throw t.code === "EEXIST" ? busy() : t; }
  }
  try { return await fn(); } finally {
    if ((await readOpen(lock)).buf?.toString("utf8") === token) await unlink(lock);
  }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
async function refusePending(root) {
  if (await exists(join(root, TXN))) throw new Fail(1, "pending-transaction", `${TXN} exists: a promotion was interrupted. Run \`recover\` (preview) then \`recover --write\` before anything else writes`);
}

// ---------------------------------------------------------------- analysis: three trees, three-way units
function merge3(b, c, p) {
  if (p === b) return "unchanged";    // the draft did not change this unit
  if (c === p) return "same";         // current already says what the draft proposes
  if (c === b) return "apply";        // only the draft changed it
  return "conflict";                  // both changed it, differently
}
// One claim file cut at its declarations' spans (the core's lines): the bytes before the first one, then each
// declaration's span and the gap after it (the blank lines up to the next one, or the file's tail). The pieces
// concatenate back to the file exactly. → {pre, spans: [{id, text, gap}]} | null (not cut: CR, no or overlapping spans)
function cutFile(buf, decls, path) {
  const s = buf.toString("utf8");
  if (s.includes("\r") || !Buffer.from(s, "utf8").equals(buf)) return null;
  const ds = [...decls].filter(([, d]) => d.file === path && Array.isArray(d.lines)).map(([id, d]) => ({ id, a: d.lines[0], b: d.lines[1] })).sort((x, y) => x.a - y.a);
  if (!ds.length || ds.some((d, k) => !(d.a >= 1 && d.b >= d.a && (k === 0 || ds[k - 1].b < d.a)))) return null;
  const off = [0];
  for (const l of s.split("\n")) off.push(Math.min(off.at(-1) + l.length + 1, s.length));
  if (ds.at(-1).b >= off.length) return null;
  const spans = ds.map((d, k) => ({ id: d.id, text: s.slice(off[d.a - 1], off[d.b]), gap: s.slice(off[d.b], k + 1 < ds.length ? off[ds[k + 1].a - 1] : s.length) }));
  const pre = s.slice(0, off[ds[0].a - 1]);
  return pre + spans.map((x) => x.text + x.gap).join("") === s ? { pre, spans } : null;
}
// Three-way merge of one claim file per declaration. Each declaration's span and the gap after it merge as their
// own units; the bytes before the lede are one more. Declarations new on either side hang off the nearest kept
// declaration before them; when both sides add after the same one, each side's run stays whole and the run whose
// first id sorts first goes first. → {text, ids: Map id→span text} | {conflicts: [what]} | null (whole-file conflict)
function mergeSpans(B, C, P) {
  const conflicts = [];
  const m3 = (b, c, p, what) => { if (p === b || c === p) return c; if (c === b) return p; conflicts.push(what); return c; };
  const byId = (x) => new Map(x.spans.map((s, k) => [s.id, { ...s, next: x.spans[k + 1]?.id ?? null }]));
  const b = byId(B), c = byId(C), p = byId(P);
  const pre = m3(B.pre, C.pre, P.pre, "the bytes before the lede");
  const kept = new Map(); // base id → merged {text, gap}
  for (const { id } of B.spans) {
    const x = b.get(id), y = c.get(id), z = p.get(id);
    if (y && z) kept.set(id, { text: m3(x.text, y.text, z.text, id), gap: m3(x.gap, y.gap, z.gap, `the blank lines after ${id}`) });
    else if (y && y.text !== x.text) conflicts.push(`${id} (changed in current, deleted in the draft)`);
    else if (z && z.text !== x.text) conflicts.push(`${id} (deleted in current, changed in the draft)`);
  }
  // Kept declarations must keep base order on both sides; a reorder is merged as a whole file.
  const order = (x) => x.spans.map((s) => s.id).filter((id) => kept.has(id)).join("\n");
  if (order(C) !== order(B) || order(P) !== order(B)) return null;
  // Runs of new declarations, keyed by the kept (base) declaration they follow ("" = file start).
  const runs = (x, side) => {
    const out = new Map(); let anchor = "";
    for (const s of x.spans) {
      if (b.has(s.id)) { anchor = s.id; continue; }
      if (anchor && !kept.has(anchor)) conflicts.push(`${s.id} (added after ${anchor}, which the other side deleted)`);
      out.set(anchor, [...(out.get(anchor) ?? []), { ...s, side }]);
    }
    return out;
  };
  const rc = runs(C, "c"), rp = runs(P, "p");
  const same = (u, v) => u.length === v.length && u.every((s, k) => s.id === v[k].id && s.text === v[k].text && s.gap === v[k].gap);
  const both = new Set([...rc.values()].flat().map((s) => s.id).filter((id) => p.has(id) && !b.has(id)));
  for (const id of both) {
    const anchor = [...rc].find(([, r]) => r.some((s) => s.id === id))[0];
    if (!rp.has(anchor) || !same(rc.get(anchor), rp.get(anchor))) conflicts.push(`${id} (added on both sides, differently)`);
  }
  if (conflicts.length) return { conflicts: uniqSorted(conflicts) };
  const out = [];
  for (const anchor of ["", ...B.spans.map((s) => s.id).filter((id) => kept.has(id))]) {
    if (anchor) out.push({ id: anchor, ...kept.get(anchor), side: "k" });
    const u = rc.get(anchor) ?? [], v = rp.get(anchor) ?? [];
    if (same(u, v)) out.push(...u);
    else out.push(...[u, v].filter((r) => r.length).sort((r1, r2) => (r1[0].id < r2[0].id ? -1 : 1)).flat());
  }
  // A declaration followed by one it was not followed by on any side gets a blank line before it.
  const followed = (s, nextId) => s.side === "k" ? [b, c, p].some((m) => m.get(s.id)?.next === nextId) : (s.side === "c" ? c : p).get(s.id).next === nextId;
  let text = pre;
  out.forEach((s, k) => {
    let piece = s.text + s.gap;
    if (k + 1 < out.length && !followed(s, out[k + 1].id) && !piece.endsWith("\n\n")) piece += piece.endsWith("\n") ? "\n" : "\n\n";
    text += piece;
  });
  return { text, ids: new Map(out.map((s) => [s.id, s.text])) };
}
const recOf = (t, id) => (t.manifest?.claims ?? {})[id];
// A record's `agreed: {by, at}`: who agreed to its wording, and when. → null (absent or well-formed) | what is wrong
function agreedProblem(rec) {
  if (rec?.agreed === undefined) return null;
  const x = rec.agreed, day = obj(x) && typeof x.at === "string" ? AGREED_AT.exec(x.at)?.[1] : undefined;
  if (!AGREED_KINDS.has(rec.kind)) return `agreed sits on a ${rec.kind}; only behavior and surface records are agreed before they are built`;
  if (!obj(x) || Object.keys(x).some((k) => k !== "by" && k !== "at") || typeof x.by !== "string" || !x.by.trim() || !day ||
      Number.isNaN(Date.parse(x.at)) || new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day)
    return `agreed must be {"by": "<who agreed>", "at": "<ISO date, optionally with a time>"}`;
  return null;
}
// Why a changed ID cannot take --doc-only evidence → null when it can: notes and sections carry no implementation;
// an agreed behavior or surface may land before it is built, while nothing in its record says it was.
function docOnlyRefusal(c) {
  if (DOC_ONLY_KINDS.has(c.kind)) return null;
  if (c.agreed === undefined) return `kind ${c.kind} without agreed`;
  if (c.agreedProblem) return `${c.kind}: ${c.agreedProblem}`;
  if (c.code.length) return `${c.kind} that maps code: an agreed record that is built takes commit or snapshot evidence`;
  if (BUILT_LABELS.has(c.evidenceLabel)) return `${c.kind} labelled evidence "${c.evidenceLabel}", which says it was built and checked`;
  return null;
}
async function analyze(root, name, readPolicy, inputSources) {
  const draft = await loadDraft(root, name, inputSources, readPolicy);
  const { d, rel, base } = draft;
  const prop = await readTree(root, `${rel}/spec`, false, inputSources, readPolicy);
  const cur = await readTree(root, SPEC, true, inputSources, readPolicy);
  const roots = [base, cur, prop].filter((t) => t.exists).map((t) => t.claimsRoot);
  if (new Set(roots).size > 1) throw new Fail(1, "claims-root-changed", `claimsRoot differs between base, current and draft (${uniqSorted(roots).join(", ")}); drafts do not move the claims tree`);
  const pc = await declsOf(root, `${rel}/spec`, readPolicy, inputSources);
  const bc = base.exists ? await declsOf(root, `${rel}/base`, readPolicy, inputSources) : { exit: 0, findings: [], decls: new Map() };

  const fileSha = (t, p) => t.files.get(p)?.sha256 ?? null;
  const files = uniqSorted([...base.files.keys(), ...cur.files.keys(), ...prop.files.keys()]).filter((p) => p !== "manifest.json").map((path) => {
    const b = fileSha(base, path), c = fileSha(cur, path), p = fileSha(prop, path);
    const ids = uniqSorted([...bc.decls, ...pc.decls].filter(([, x]) => x.file === path).map(([id]) => id));
    let changedIds = ids.filter((id) => bc.decls.get(id)?.textSha256 !== pc.decls.get(id)?.textSha256);
    if (b !== p && !changedIds.length) changedIds = ids; // bytes moved outside any span: every declaration in the file owns it
    return { path, base: b, current: c, proposed: p, merge: merge3(b, c, p), ids: b === p ? [] : changedIds };
  });
  // A file both sides changed merges per declaration when all three graphs load and every side cuts cleanly.
  const both = files.filter((f) => f.merge === "conflict" && f.base && f.current && f.proposed);
  const cc = both.length && bc.exit !== 2 && pc.exit !== 2 ? await declsOf(root, SPEC, readPolicy, inputSources) : null;
  for (const f of both) {
    if (!cc || cc.exit === 2) continue;
    const cuts = [[base, bc], [cur, cc], [prop, pc]].map(([t, x]) => cutFile(t.files.get(f.path).buf, x.decls, f.path));
    const m = cuts.every(Boolean) ? mergeSpans(...cuts) : null;
    if (!m) continue;
    if (m.conflicts) { f.spanConflicts = m.conflicts; continue; }
    const buf = Buffer.from(m.text, "utf8");
    if (sha(buf) === f.current) { f.merge = "same"; continue; }
    Object.assign(f, { merge: "merge", merged: { buf, sha256: sha(buf), ids: m.ids } });
  }
  const records = uniqSorted([base, cur, prop].flatMap((t) => Object.keys(t.manifest?.claims ?? {}))).map((id) => {
    const b = canon(recOf(base, id)), c = canon(recOf(cur, id)), p = canon(recOf(prop, id));
    return { id, merge: merge3(b, c, p), base: b && sha(b), current: c && sha(c), proposed: p && sha(p) };
  });
  const meta = uniqSorted([base, cur, prop].flatMap((t) => Object.keys(t.manifest ?? {}))).filter((k) => k !== "claims").map((key) => {
    const b = canon(base.manifest?.[key]), c = canon(cur.manifest?.[key]), p = canon(prop.manifest?.[key]);
    return { key, merge: merge3(b, c, p) };
  });
  const changed = new Map(); // id → {record, text, files}
  const touch = (id) => changed.get(id) ?? changed.set(id, { id, record: false, text: false, files: [] }).get(id);
  for (const r of records) if (r.merge !== "unchanged") touch(r.id).record = true;
  for (const f of files) for (const id of f.ids) { const t = touch(id); t.files.push(f.path); if (bc.decls.get(id)?.textSha256 !== pc.decls.get(id)?.textSha256) t.text = true; }
  for (const c of changed.values()) {
    const rec = recOf(prop, c.id) ?? recOf(base, c.id);
    c.kind = rec?.kind ?? null;
    c.deleted = recOf(prop, c.id) === undefined && !pc.decls.has(c.id);
    c.binding = { recordSha: recOf(prop, c.id) === undefined ? null : sha(canon(recOf(prop, c.id))), textSha256: pc.decls.get(c.id)?.textSha256 ?? null };
    c.code = uniqSorted((rec?.code ?? []).filter((p) => typeof p === "string"));
    c.agreed = rec?.agreed; c.agreedProblem = agreedProblem(rec); c.evidenceLabel = rec?.evidence;
  }
  return { ...draft, prop, cur, pc, bc, files, records, meta, changed };
}

// ---------------------------------------------------------------- evidence
// Recheck one evidence entry against the bytes and revisions now. → [] (valid) or reasons.
async function evidenceProblems(root, g, e, draftRelDir) {
  const out = [];
  if (e.log) {
    const log = await readFileSafe(root, `${draftRelDir}/evidence/objects/${e.log.sha256}`, { secrets: false });
    if (log.state !== "present" || log.sha256 !== e.log.sha256) out.push("retained verification log is missing or corrupt");
  }
  if (e.mode === "doc-only") {
    if (e.inputs.length) out.push("--doc-only evidence takes no implementation inputs");
    return out;
  }
  for (const i of e.inputs) if (i.path === SPEC || i.path.startsWith(`${SPEC}/`) || i.path === ".sova" || secretOf(i.path))
    out.push(`${i.path} is not an allowed implementation evidence path`);
  if (e.mode === "snapshot") {
    if (g.git) out.push("snapshot evidence, but this is now a Git project: record --commit evidence");
    for (const i of e.inputs) if (i.state === "present") {
      const o = await readFileSafe(root, `${draftRelDir}/evidence/objects/${i.sha256}`, { secrets: false });
      if (o.state !== "present" || o.sha256 !== i.sha256) out.push(`retained snapshot of ${i.path} is missing or corrupt`);
    }
  } else {
    if (!g.git) out.push("commit evidence, but this is not a Git project");
    else if (resolveCommit(root, e.commit) !== e.commit) out.push(`commit ${e.commit} no longer exists`);
    else if (!isAncestor(root, e.commit)) out.push(`commit ${e.commit} is not an ancestor of HEAD`);
    else for (const i of e.inputs) {
      const b = blobAt(root, g, e.commit, i.path);
      if (b.state !== i.state || b.sha256 !== i.sha256) out.push(`${i.path} at ${e.commit.slice(0, 12)} is not the recorded bytes`);
    }
  }
  for (const i of e.inputs) {
    const w = await readFileSafe(root, i.path);
    if (w.state !== i.state || w.sha256 !== i.sha256) out.push(`${i.path} in the working tree differs from the verified ${e.mode === "commit" ? "commit" : "snapshot"}`);
  }
  return out;
}
// Latest evidence entry naming the id, and whether it still applies to what the draft now proposes.
async function evidenceState(root, a, g, c) {
  const e = [...a.d.evidence].reverse().find((x) => x.ids.some((y) => y.id === c.id));
  if (!e) return { state: "none", reasons: ["no evidence recorded"] };
  const bound = e.ids.find((y) => y.id === c.id);
  const reasons = [];
  if (bound.recordSha !== c.binding.recordSha) reasons.push("the proposed record changed after evidence was recorded");
  if (bound.textSha256 !== c.binding.textSha256) reasons.push("the proposed prose changed after evidence was recorded");
  const docOnly = e.mode === "doc-only" && docOnlyRefusal(c);
  if (docOnly) reasons.push(`--doc-only evidence does not cover ${docOnly}`);
  if (e.mode !== "doc-only" && !c.deleted && !e.inputs.some((i) => i.state === "present"))
    reasons.push("evidence has no present implementation file");
  for (const p of c.code) if (e.mode !== "doc-only" && !e.inputs.some((i) => i.path === p && (c.deleted || i.state === "present")))
    reasons.push(`mapped code ${p} is not among the evidence inputs as a present file`);
  reasons.push(...(await evidenceProblems(root, g, e, a.rel)));
  return { state: reasons.length ? "stale" : "valid", reasons, recordedAt: e.recordedAt, by: e.by, mode: e.mode, ...(e.commit ? { commit: e.commit } : {}) };
}

// ---------------------------------------------------------------- commands
async function cmdNew(root, o) {
  const rel = draftRel(o.name);
  const capture = async () => { const t = await readTree(root, SPEC, true); return { t, print: treePrint(t) }; };
  const a = await capture();
  const summary = (t) => ({ name: o.name, draft: rel, specExisted: t.exists, claimsRoot: t.claimsRoot ?? "claims",
    files: [...t.files].map(([path, f]) => ({ path, bytes: f.bytes, sha256: f.sha256 })), bytes: t.total });
  if (await exists(join(root, rel))) throw new Fail(1, "name-taken", `${rel} already exists; drafts are never overwritten`, summary(a.t));
  if (!o.write) return { exit: 0, written: false, ...summary(a.t) };
  return withLock(root, async () => {
    await refusePending(root);
    const b = await capture();
    if (a.print !== b.print) throw new Fail(1, "race", "the current spec changed while it was being copied; retry when it is quiet");
    const drafts = await ownDir(root, DRAFTS, true);
    if (await exists(join(drafts, o.name))) throw new Fail(1, "name-taken", `${rel} already exists`);
    const tmpRel = `${DRAFTS}/.new-${randomBytes(6).toString("hex")}`;
    await mkdir(join(root, tmpRel));
    try {
      for (const side of ["base", "spec"]) {
        await mkdir(join(root, tmpRel, side));
        for (const [p, f] of b.t.files) {
          await mkdir(join(root, tmpRel, side, dirname(p)), { recursive: true });
          await writeFile(join(root, tmpRel, side, p), f.buf, { flag: "wx" });
        }
      }
      if (!b.t.exists) { // no current spec: an empty baseline and a starter manifest to author into
        await writeFile(join(root, tmpRel, "spec/manifest.json"), STARTER, { flag: "wx" });
        await mkdir(join(root, tmpRel, "spec/claims"));
      } else await mkdir(join(root, tmpRel, "spec", b.t.claimsRoot), { recursive: true });
      // The code the draft starts from, so `check` can tell code changed since then from prose that did not follow.
      const g = await gitInfo(root), commit = g.git ? resolveCommit(root, "HEAD") : null;
      const d = { format: FORMAT, name: o.name, createdAt: new Date().toISOString(), ...(o.purpose ? { purpose: o.purpose } : {}),
        base: { specExisted: b.t.exists, claimsRoot: b.t.claimsRoot ?? "claims", files: Object.fromEntries([...b.t.files].map(([p, f]) => [p, f.sha256])), ...(commit ? { commit } : {}) },
        evidence: [], promotions: [] };
      await writeFile(join(root, tmpRel, "draft.json"), JSON.stringify(d, null, 2) + "\n", { flag: "wx" });
      if (await exists(join(drafts, o.name))) throw new Fail(1, "name-taken", `${rel} already exists`);
      await rename(join(root, tmpRel), join(drafts, o.name));
    } catch (e) { await rm(join(root, tmpRel), { recursive: true, force: true }); throw e; }
    return { exit: 0, written: true, ...summary(b.t), edit: `${rel}/spec` };
  });
}

async function statusOut(root, a) {
  const g = await gitInfo(root);
  const ids = [];
  for (const c of [...a.changed.values()].sort((x, y) => (x.id < y.id ? -1 : 1))) {
    const rec = a.records.find((r) => r.id === c.id);
    const conflict = (rec && rec.merge === "conflict") || a.files.some((f) => c.files.includes(f.path) && f.merge === "conflict");
    const promoted = (!rec || ["same", "unchanged"].includes(rec.merge)) && a.files.filter((f) => c.files.includes(f.path)).every((f) => f.merge === "same");
    ids.push({ id: c.id, kind: c.kind, change: c.deleted ? "deleted" : !a.bc.decls.has(c.id) && !recOf(a.base, c.id) ? "added" : "modified",
      record: c.record, prose: c.text, files: c.files, current: promoted ? "already-current" : conflict ? "conflict" : "pending",
      evidence: await evidenceState(root, a, g, c) });
  }
  const undeclared = a.files.filter((f) => f.merge !== "unchanged" && !f.ids.length).map((f) => f.path);
  return {
    name: a.d.name, draft: a.rel, purpose: a.d.purpose ?? null, createdAt: a.d.createdAt, git: g.git,
    proposedGraph: { exit: a.pc.exit, errors: a.pc.findings.filter((f) => f.severity === "error") },
    ids, undeclaredFiles: undeclared,
    meta: a.meta.filter((m) => m.merge !== "unchanged"),
    files: a.files.filter((f) => f.merge !== "unchanged" || f.base !== f.current).map(({ merged, ...f }) => (merged ? { ...f, merged: merged.sha256 } : f)),
    currentMoved: a.files.filter((f) => f.base !== f.current).map((f) => f.path).concat(a.records.filter((r) => r.base !== r.current).map((r) => r.id)),
    promotions: a.d.promotions,
  };
}
async function cmdStatus(root, o) {
  const s = await statusOut(root, await analyze(root, o.name));
  const conflicts = s.ids.filter((i) => i.current === "conflict").length + s.files.filter((f) => f.merge === "conflict").length;
  return { exit: conflicts || s.proposedGraph.exit === 2 ? 1 : 0, ...s };
}

// Line diff (LCS) for review; big files fall back to "differ".
function lineDiff(a, b) {
  const x = a.split("\n"), y = b.split("\n");
  if (x.length * y.length > 4e6) return ["(files differ; too large for an inline diff)"];
  const n = x.length, m = y.length, L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { out.push(`  ${x[i]}`); i++; j++; }
    else if (i < n && (j >= m || L[i + 1][j] >= L[i][j + 1])) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  // keep 2 lines of context around changes
  const keep = out.map((l, k) => out.slice(Math.max(0, k - 2), k + 3).some((z) => z[0] !== " "));
  return out.flatMap((l, k) => (keep[k] ? [l] : k > 0 && keep[k - 1] ? ["  …"] : []));
}
async function cmdDiff(root, o) {
  const a = await analyze(root, o.name);
  const against = o.against ?? "base", left = against === "base" ? a.base : a.cur;
  const text = (t, p) => t.files.get(p)?.buf.toString("utf8") ?? "";
  const files = a.files.filter((f) => f[against] !== f.proposed).map((f) => ({ path: f.path, [against]: f[against], proposed: f.proposed, ids: f.ids, diff: lineDiff(text(left, f.path), text(a.prop, f.path)) }));
  const records = a.records.filter((r) => r[against] !== r.proposed).map((r) => ({ id: r.id, diff: lineDiff(JSON.stringify(recOf(left, r.id) ?? null, null, 2), JSON.stringify(recOf(a.prop, r.id) ?? null, null, 2)) }));
  const meta = a.meta.map((m) => m.key).filter((k) => canon(left.manifest?.[k]) !== canon(a.prop.manifest?.[k]))
    .map((key) => ({ key, diff: lineDiff(JSON.stringify(left.manifest?.[key] ?? null, null, 2), JSON.stringify(a.prop.manifest?.[key] ?? null, null, 2)) }));
  return { exit: 0, name: o.name, against, files, records, meta };
}

// Words that never make a phrase on their own ("the count", "is shown" say nothing about one claim).
const STOP = new Set(("a an and are as at be been but by can each for from has have if in into is it its no not of on or so such " +
  "than that the their them then there these they this those to was were when where which while who will with without you your " +
  "one two all any only also its it's own every more most other same does do done still").split(" "));
const words = (text) => text.split("\n").filter((l) => !/^#{1,2}\s+§/.test(l)).join("\n").toLowerCase()
  .replace(/§[^\s)]*/g, " ").match(/[a-z0-9][a-z0-9'-]*/g) ?? [];
// Two- and three-word phrases with no stopword and at least one word of four letters or more.
function phrases(text) {
  const w = words(text), out = new Set();
  for (let n = 2; n <= 3; n++) for (let i = 0; i + n <= w.length; i++) {
    const g = w.slice(i, i + n);
    if (g.every((x) => !STOP.has(x) && x.length > 1 && !x.includes("'") && !/^\d+$/.test(x)) && g.some((x) => x.length >= 4)) out.add(g.join(" "));
  }
  return out;
}
const MAX_ELSEWHERE = 5, MAX_REMOVED = 30;
// Quantities: a number with a comparator or a unit ("≥80%", "90%", "20s", "480px"). A bare number says too little.
const tokens = (text) => text.split("\n").filter((l) => !/^#{1,2}\s+§/.test(l)).join("\n").toLowerCase()
  .replace(/§[^\s)]*/g, " ").match(/[≥≤<>~±]?\d+(?:\.\d+)?(?:%|px|ms|s\b|min\b|kb\b|mb\b|x\b)?|[a-z][a-z0-9'-]*/g) ?? [];
const isQuantity = (t) => /\d/.test(t) && /^[≥≤<>~±]|[^\d.]$/.test(t);
const QTY_WINDOW = 8, RARE_SHARE = 0.1;
// The content words within QTY_WINDOW tokens of each occurrence of a quantity.
function nearWords(toks, qty) {
  const out = new Set();
  toks.forEach((t, i) => {
    if (t !== qty) return;
    for (const w of toks.slice(Math.max(0, i - QTY_WINDOW), i + QTY_WINDOW + 1)) if (w.length >= 4 && !STOP.has(w) && !/\d/.test(w)) out.add(w);
  });
  return out;
}
const declText = (tree, d) => d && tree.files.get(d.file) ? tree.files.get(d.file).buf.toString("utf8").split(/\r?\n/).slice(d.lines[0] - 1, d.lines[1]).join("\n") + "\n" : null;

// Drift a draft can carry unnoticed: (1) a phrase it removed from one § that other § still say (the same fact written
// twice, edited once); (2) code changed since the draft's base commit under a § whose prose the draft left as it was.
async function drift(root, a, g, baseRev) {
  const removedElsewhere = [], cited = new Map(); // § cited on a line the draft changed → the § whose text changed
  const texts = new Map([...a.pc.decls].map(([id, d]) => [id, declText(a.prop, d)]));
  const grams = new Map([...texts].map(([id, t]) => [id, phrases(t ?? "")]));
  const toks = new Map([...texts].map(([id, t]) => [id, tokens(t ?? "")]));
  // A word ties two quantities together only if it is rare in the spec (in at most RARE_SHARE of the §).
  const df = new Map();
  for (const ts of toks.values()) for (const w of new Set(ts)) df.set(w, (df.get(w) ?? 0) + 1);
  const rare = (w) => (df.get(w) ?? 0) <= Math.max(2, RARE_SHARE * toks.size);
  for (const [id, d] of [...a.pc.decls].sort(([x], [y]) => (x < y ? -1 : 1))) {
    const b = a.bc.decls.get(id);
    if (!b || b.textSha256 === d.textSha256) continue;
    const [was, now] = [declText(a.base, b) ?? "", texts.get(id) ?? ""].map((t) => t.split("\n"));
    const edited = [...was.filter((l) => !now.includes(l)), ...now.filter((l) => !was.includes(l))];
    for (const c of edited.join("\n").match(new RegExp(ID_RE.source.slice(1, -1), "g")) ?? []) if (c !== id) cited.set(c, uniqSorted([...(cited.get(c) ?? []), id]));
    const gone = [...phrases(declText(a.base, b) ?? "")].filter((p) => !grams.get(id).has(p));
    const kept = [];
    for (const phrase of gone.sort((x, y) => x.split(" ").length - y.split(" ").length || (x < y ? -1 : 1))) {
      if (kept.some((k) => phrase.includes(k.phrase))) continue; // a longer phrase around one already reported
      const alsoIn = [...grams].filter(([o, gs]) => o !== id && gs.has(phrase)).map(([o]) => o).sort();
      if (alsoIn.length && alsoIn.length <= MAX_ELSEWHERE) kept.push({ id, phrase, alsoIn });
    }
    // A quantity the draft removed ("≥80%" → "≥90%") that another § still states about the same thing: the same
    // quantity with a rare content word in common near it, one for a comparison ("≥80%"), two for a bare unit
    // ("80%"), so the context meter's "80%" never matches a usage meter's.
    const wasToks = tokens(declText(a.base, b) ?? ""), nowToks = new Set(toks.get(id));
    for (const qty of uniqSorted(wasToks.filter((t) => isQuantity(t) && !nowToks.has(t)))) {
      const near = nearWords(wasToks, qty);
      const hits = [...toks].filter(([o, ts]) => o !== id && ts.includes(qty))
        .map(([o, ts]) => ({ o, shared: [...nearWords(ts, qty)].filter((w) => near.has(w) && rare(w)) }))
        .filter((h) => h.shared.length >= (/^[≥≤<>]/.test(qty) ? 1 : 2));
      if (hits.length && hits.length <= MAX_ELSEWHERE)
        kept.push({ id, phrase: qty, alsoIn: hits.map((h) => h.o).sort(), near: uniqSorted(hits.flatMap((h) => h.shared)) });
    }
    removedElsewhere.push(...kept);
  }
  let base = null, proseUnchanged = [];
  const rev = baseRev ?? a.d.base.commit;
  if (g.git && rev) {
    base = resolveCommit(root, rev);
    if (!base) throw new Fail(1, "bad-rev", `--base ${rev} does not name a commit`);
    refuseGitFilters(root, base);
    const diff = git(root, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--relative", base, "--", "."]);
    const others = git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", "."]);
    if (diff.status !== 0 || others.status !== 0) throw new Fail(2, "git-failed", `git diff/ls-files: ${(diff.err || others.err || "").trim()}`);
    const changed = new Set([...diff.out.split("\0"), ...others.out.split("\0")].filter((p) => p && !(p === SPEC || p.startsWith(`${SPEC}/`))));
    for (const [id, d] of [...a.pc.decls].sort(([x], [y]) => (x < y ? -1 : 1))) {
      const b = a.bc.decls.get(id);
      if (!b || b.textSha256 !== d.textSha256) continue;
      const files = uniqSorted((recOf(a.prop, id)?.code ?? []).filter((p) => typeof p === "string" && changed.has(normRel(p))));
      if (files.length) proseUnchanged.push({ id, files, ...(cited.has(id) ? { citedBy: cited.get(id) } : {}) });
    }
    proseUnchanged.sort((x, y) => (y.citedBy ? 1 : 0) - (x.citedBy ? 1 : 0));
  }
  return { base, removedElsewhere: removedElsewhere.slice(0, MAX_REMOVED), proseUnchanged };
}

const removedText = (r) => `the draft removed "${r.phrase}" from ${r.id}, but ${r.alsoIn.join(", ")} still say${r.alsoIn.length === 1 ? "s" : ""} it${r.near ? ` (near ${r.near.join(", ")})` : ""}: read them; if the fact changed, change it there too (each is a foreign §)`;
const citedText = (r, base) => `the draft edited a line of ${r.citedBy.join(", ")} that cites ${r.id}, and ${r.files.join(", ")} changed since ${base.slice(0, 12)}, but ${r.id}'s prose is as it was: read it; if what it says changed, edit it in this draft (it is a foreign §)`;

async function cmdCheck(root, o) {
  const { rel, d } = await loadDraft(root, o.name, o.inputSources, o.readPolicy), g = await gitInfo(root);
  const j = await runCore(root, `${rel}/spec`, o.readPolicy, o.inputSources);
  const findings = [];
  let a = null;
  try { if (j.exit !== 2) a = await analyze(root, o.name, o.readPolicy, o.inputSources); } catch (e) {
    if (!(e instanceof Fail) || e.exit === 2) throw e;
    findings.push({ severity: "note", code: "drift-skipped", message: `drift checks skipped: ${e.message}` });
  }
  const dr = a && a.bc.exit !== 2 ? await drift(root, a, g, o.base) : null;
  for (const r of dr?.removedElsewhere ?? [])
    findings.push({ severity: "warn", code: "removed-phrase-elsewhere", id: r.id, message: removedText(r) });
  for (const r of dr?.proseUnchanged ?? [])
    findings.push(r.citedBy
      ? { severity: "warn", code: "cited-prose-unchanged", id: r.id, message: citedText(r, dr.base) }
      : { severity: "note", code: "code-changed-prose-unchanged", id: r.id, message: `${r.files.join(", ")} changed since ${dr.base.slice(0, 12)} and the draft leaves ${r.id}'s prose as it was: read it; if what it says changed, edit it in this draft` });
  if (dr && !dr.base && g.git) findings.push({ severity: "note", code: "drift-base-unknown", message: "the draft records no base commit (made before drafts recorded one): pass --base REV to check code changed since then" });
  // Evidence that names a commit this line no longer has (a rebase after evidence): the record's claim is orphaned.
  const evidenceNotAncestor = [];
  const latest = new Map();
  for (const e of d.evidence) for (const i of e.ids) latest.set(i.id, e);
  if (g.git) for (const e of d.evidence) if (e.mode === "commit") {
    const activeIds = e.ids.filter((i) => latest.get(i.id) === e).map((i) => i.id);
    if (!activeIds.length) continue;
    const why = resolveCommit(root, e.commit) !== e.commit ? "missing" : !isAncestor(root, e.commit) ? "not-ancestor" : null;
    if (!why) continue;
    const x = evidenceNotAncestor.find((y) => y.commit === e.commit) ?? (evidenceNotAncestor.push({ commit: e.commit, reason: why, ids: [] }), evidenceNotAncestor.at(-1));
    x.ids = uniqSorted([...x.ids, ...activeIds]);
  }
  for (const x of evidenceNotAncestor)
    findings.push({ severity: "warn", code: "evidence-not-ancestor", message: `evidence commit ${x.commit.slice(0, 12)} (${x.ids.join(", ")}) is ${x.reason === "missing" ? "gone" : "not an ancestor of HEAD"}: a rebase after evidence orphans it; merge instead, and re-record evidence against the commit HEAD has` });
  const exit = Math.max(j.exit, findings.some((f) => f.severity === "warn") ? 1 : 0);
  return { exit, name: o.name, spec: `${rel}/spec`, counts: j.counts, coreFindings: j.findings, frontier: j.frontier ?? [],
    drift: dr, evidenceNotAncestor, findings };
}

async function cmdEvidence(root, o) {
  const build = async () => {
    const a = await analyze(root, o.name), g = await gitInfo(root);
    const targets = uniqSorted(o.id).map((id) => {
      const c = a.changed.get(id);
      if (!c) throw new Fail(1, "not-changed", `${id} is not changed by draft ${o.name}; evidence binds to a proposed change`);
      return c;
    });
    if (o["doc-only"]) { const bad = targets.filter((c) => docOnlyRefusal(c)); if (bad.length) throw new Fail(1, "doc-only-refused", `--doc-only covers only ${[...DOC_ONLY_KINDS].join("/")} kinds and agreed ${[...AGREED_KINDS].join("/")} records with no code, not ${bad.map((c) => `${c.id} (${docOnlyRefusal(c)})`).join(", ")}`); }
    const malformed = targets.filter((c) => !c.deleted && c.agreedProblem);
    if (malformed.length) throw new Fail(1, "agreed-invalid", malformed.map((c) => `${c.id}: ${c.agreedProblem}`).join("; "));
    if (o.snapshot && g.git) throw new Fail(1, "git-requires-commit", "this is a Git project: name the implementation commit with --commit REV; without permission to commit, leave evidence pending and say so");
    if (o.commit !== undefined && !g.git) throw new Fail(1, "not-git", "this is not a Git project: use --snapshot to retain the implementation bytes");
    const paths = o["doc-only"] ? [] : uniqSorted([...targets.flatMap((c) => c.code), ...o.path]);
    const inputs = [];
    for (const raw of paths) {
      const p = normRel(raw);
      if (!p || p !== raw) throw new Fail(2, "path-refused", `${raw}: evidence paths are plain project-relative paths`);
      if (p === SPEC || p.startsWith(`${SPEC}/`) || p === ".sova") throw new Fail(1, "path-refused", `${p}: spec files are documentation, not implementation evidence`);
      const r = await readFileSafe(root, p);
      if (r.state === "refused") throw new Fail(1, "path-refused", `${p}: ${r.why}`);
      inputs.push({ path: p, state: r.state, ...(r.state === "present" ? { sha256: r.sha256, bytes: r.bytes, buf: r.buf } : {}) });
    }
    for (const c of targets) if (!o["doc-only"] && !c.deleted) {
      const missing = c.code.filter((p) => !inputs.some((i) => i.path === p && i.state === "present"));
      if (missing.length) throw new Fail(1, "evidence-code-missing", `${c.id} maps ${missing.join(", ")}, which does not exist; every mapped code path must be present (--path cannot stand in for it)`);
      if (!inputs.some((i) => i.state === "present")) throw new Fail(1, "evidence-no-code", `${c.id} maps no present implementation file; map it in the draft record's code or pass --path`);
    }
    let commit;
    if (o.commit !== undefined) {
      commit = resolveCommit(root, o.commit);
      if (!commit) throw new Fail(1, "commit-missing", `${o.commit} is not an existing commit`);
      if (!isAncestor(root, commit)) throw new Fail(1, "commit-not-ancestor", `${commit} is not an ancestor of HEAD; promote only implementation that is committed on this line`);
      const bad = [];
      for (const i of inputs) { const b = blobAt(root, g, commit, i.path); if (b.state !== i.state || b.sha256 !== i.sha256) bad.push(i.path); }
      if (bad.length) throw new Fail(1, "input-uncommitted", `the working tree differs from ${commit.slice(0, 12)} for ${bad.join(", ")}: commit the implementation (only it) and name that commit`);
    }
    let log;
    if (o.log !== undefined) {
      const abs = resolve(o.log), rel = abs.split("\\").join("/").replace(/^\/+/, "");
      const r = await readFileSafe(resolve("/"), rel);
      if (r.state !== "present") throw new Fail(1, "log-refused", `--log ${o.log}: ${r.why}`);
      log = r;
    }
    return { a, targets, inputs, commit, log };
  };
  const show = ({ targets, inputs, commit, log }) => ({ name: o.name, mode: o.commit !== undefined ? "commit" : o.snapshot ? "snapshot" : "doc-only",
    ids: targets.map((c) => ({ id: c.id, kind: c.kind, deleted: c.deleted, ...c.binding })), ...(commit ? { commit } : {}),
    inputs: inputs.map(({ buf, ...i }) => i), ...(log ? { log: { sha256: log.sha256, bytes: log.bytes } } : {}) });
  const first = await build();
  if (!o.write) return { exit: 0, written: false, ...show(first) };
  return withLock(root, async () => {
    await refusePending(root);
    const now = await build();
    if (JSON.stringify(show(now)) !== JSON.stringify(show(first))) throw new Fail(1, "race", "the draft or inputs changed while evidence was prepared; retry");
    const entry = { recordedAt: new Date().toISOString(), by: o.by, verification: o.verification, ...show(now) };
    delete entry.name;
    if (o.snapshot || now.log) {
      const objs = await ownDir(root, `${now.a.rel}/evidence/objects`, true);
      for (const x of [...(o.snapshot ? now.inputs.filter((i) => i.state === "present") : []), ...(now.log ? [now.log] : [])])
        if (!(await writeNew(objs, x.sha256, x.buf)) && (await readOpen(join(objs, x.sha256))).sha256 !== x.sha256) throw new Fail(2, "object-corrupt", `evidence/objects/${x.sha256} exists with other bytes`);
    }
    const cur = await loadDraft(root, o.name);
    if (cur.sha !== now.a.sha) throw new Fail(1, "race", "draft.json changed concurrently; retry");
    cur.d.evidence.push(entry);
    await saveDraft(root, now.a.rel, cur.d);
    return { exit: 0, written: true, ...show(now), recordedAt: entry.recordedAt };
  });
}

// Build the promotion: selected units, conflicts, evidence, the full candidate tree, and the file plan.
async function plan(root, o) {
  const a = await analyze(root, o.name), g = await gitInfo(root);
  const refusals = [];
  const refuse = (code, message) => refusals.push({ code, message });
  if (a.bc.exit === 2) refuse("base-untrusted", "the draft's baseline graph does not load (exit 2); changes cannot be attributed to identifiers");
  if (a.pc.exit === 2) refuse("draft-invalid", "the draft graph does not load (exit 2); run `check` and fix it first");
  const undeclared = a.files.filter((f) => f.merge !== "unchanged" && !f.ids.length);
  const ids = new Set(o.all ? a.changed.keys() : o.id);
  const fileSel = new Set(o.all ? undeclared.map((f) => f.path) : o.file);
  const bootstrap = !a.cur.exists;
  const metaSel = new Set(o.all || bootstrap ? a.meta.filter((m) => m.merge !== "unchanged").map((m) => m.key) : o.meta);
  for (const id of ids) if (!a.changed.has(id)) refuse("not-changed", `${id} is not changed by this draft`);
  for (const p of fileSel) if (!undeclared.some((f) => f.path === p)) refuse("not-changed", `--file ${p} is not a changed file without declarations (declared prose is selected by --id)`);
  for (const k of metaSel) if (!a.meta.some((m) => m.key === k && m.merge !== "unchanged")) refuse("not-changed", `--meta ${k} is not changed by this draft`);

  // Whole files move: every changed identifier in a promoted file must be selected too.
  const files = a.files.filter((f) => f.merge !== "unchanged" && (f.ids.some((id) => ids.has(id)) || fileSel.has(f.path)));
  for (const f of files) { const missing = f.ids.filter((id) => !ids.has(id)); if (missing.length) refuse("selection-incomplete", `${f.path} also carries unselected changes to ${missing.join(", ")}; files move whole, so select them too (with their evidence) or revert them in the draft`); }
  const records = a.records.filter((r) => r.merge !== "unchanged" && ids.has(r.id));
  const meta = a.meta.filter((m) => m.merge !== "unchanged" && metaSel.has(m.key));
  for (const u of [...files.map((f) => ({ what: f.spanConflicts ? `${f.path}: ${f.spanConflicts.join(", ")}` : f.path, merge: f.merge })), ...records.map((r) => ({ what: `record ${r.id}`, merge: r.merge })), ...meta.map((m) => ({ what: `manifest ${m.key}`, merge: m.merge }))])
    if (u.merge === "conflict") refuse("conflict", `${u.what} changed in current since the draft was made, differently; current and draft are left as they are — bring the draft up to date by hand (or start a new draft) and retry`);

  // Every selected ID that stays current must say, explicitly, that it is not a proposal.
  for (const id of [...ids].filter((x) => a.changed.has(x) && !a.changed.get(x).deleted).sort()) {
    const auth = recOf(a.prop, id)?.authority;
    if (auth === "candidate") refuse("candidate-label", `${id} is still labelled authority "candidate" in the draft; a promoted record is current, so relabel it ("accepted" once the user adopted it) before recording evidence`);
    else if (auth !== "accepted" && auth !== "migrated") refuse("authority-missing", `${id} declares no authority label; set "authority": "accepted" (or keep "migrated" for ported text) in the draft record before recording evidence`);
    const bad = agreedProblem(recOf(a.prop, id));
    if (bad) refuse("agreed-invalid", `${id}: ${bad}`);
    // `agreed` is written once, at agreement: the build adds code and evidence to the same record and keeps who decided.
    const was = recOf(a.cur, id)?.agreed, r = a.records.find((x) => x.id === id);
    if (was !== undefined && r?.merge === "apply" && recOf(a.prop, id) !== undefined && canon(recOf(a.prop, id).agreed) !== canon(was))
      refuse("agreed-rewritten", `${id} was agreed ${JSON.stringify(was)} in current; agreed is written once, at agreement, so keep it as it is in the draft record`);
  }
  const evidence = [];
  for (const id of [...ids].filter((x) => a.changed.has(x)).sort()) {
    const ev = await evidenceState(root, a, g, a.changed.get(id));
    evidence.push({ id, ...ev });
    const gone = ev.reasons.find((r) => /is not an ancestor of HEAD|no longer exists/.test(r));
    if (gone) refuse("evidence-not-ancestor", `${id}: evidence commit ${ev.commit.slice(0, 12)} was rewritten (rebase?) or is not on this line: never rebase after evidence; re-record evidence on the current commit, or merge master in instead`);
    else if (ev.state !== "valid") refuse(ev.state === "none" ? "evidence-missing" : "evidence-stale", `${id}: ${ev.reasons.join("; ")}`);
  }

  // Candidate = current tree with only the selected units replaced.
  const cand = new Map([...a.cur.files].filter(([p]) => p !== "manifest.json").map(([p, f]) => [p, f.buf]));
  for (const f of files) if (f.merge === "apply") { if (f.proposed === null) cand.delete(f.path); else cand.set(f.path, a.prop.files.get(f.path).buf); }
    else if (f.merge === "merge") cand.set(f.path, f.merged.buf);
  let manifestBuf = a.cur.files.get("manifest.json")?.buf ?? null;
  if (records.some((r) => r.merge === "apply") || meta.some((m) => m.merge === "apply")) {
    const m = structuredClone(a.cur.manifest ?? {});
    for (const x of meta) if (x.merge === "apply") { if (a.prop.manifest[x.key] === undefined) delete m[x.key]; else m[x.key] = a.prop.manifest[x.key]; }
    m.claims ??= {};
    for (const r of records) if (r.merge === "apply") { const p = recOf(a.prop, r.id); if (p === undefined) delete m.claims[r.id]; else m.claims[r.id] = p; }
    manifestBuf = Buffer.from(JSON.stringify(m, null, 2) + "\n");
  }
  if (manifestBuf) cand.set("manifest.json", manifestBuf);
  const targets = uniqSorted([...a.cur.files.keys(), ...cand.keys()]).map((path) => ({ path, before: a.cur.files.get(path)?.sha256 ?? null, after: cand.has(path) ? sha(cand.get(path)) : null }))
    .filter((t) => t.before !== t.after);

  // The whole merged graph must load, and must not dangle where current does not.
  let candidate = null;
  if (!refusals.length && targets.length) {
    const tmp = await mkdtemp(join(tmpdir(), "sova-spec-draft-"));
    try {
      for (const [p, b] of cand) { await mkdir(join(tmp, SPEC, dirname(p)), { recursive: true }); await writeFile(join(tmp, SPEC, p), b); }
      const cj = await runCore(tmp, SPEC);
      const nowDangling = a.cur.exists ? (await runCore(root, SPEC)).findings.filter((f) => f.code === "dangling-edge").map((f) => f.message) : [];
      const errors = cj.findings.filter((f) => f.severity === "error");
      const dangling = cj.findings.filter((f) => f.code === "dangling-edge" && !nowDangling.includes(f.message));
      candidate = { exit: cj.exit, errors, newDangling: dangling, warnings: cj.findings.filter((f) => f.severity === "warn" && !/^code-|^provenance-/.test(f.code)).length };
      if (errors.length) refuse("candidate-invalid", `the merged graph would not load: ${errors.slice(0, 5).map((f) => `${f.code} ${f.message}`).join("; ")}`);
      if (dangling.length) refuse("candidate-dangling", `the merged graph would gain dangling edges: ${dangling.map((f) => f.message).join("; ")}; select the targets too`);
      // A per-declaration merge must read back as exactly the declarations it was built from, byte for byte.
      const got = new Map((cj.declarations ?? []).map((d) => [d.id, d]));
      for (const f of files.filter((x) => x.merge === "merge")) {
        const back = [...got].filter(([, d]) => d.file === `${SPEC}/${f.path}`).map(([id]) => id).sort().join(",");
        const lost = [...f.merged.ids].filter(([id, t]) => got.get(id)?.textSha256 !== sha(t.endsWith("\n") ? t : `${t}\n`)).map(([id]) => id);
        if (lost.length || back !== [...f.merged.ids.keys()].sort().join(","))
          refuse("conflict", `${f.path}: the per-declaration merge does not read back as the declarations it was built from (${lost.join(", ") || "declarations differ"}); merge it by hand in a new draft from current`);
      }
    } finally { await rm(tmp, { recursive: true, force: true }); }
  }
  const planSha = sha(JSON.stringify({ draft: o.name, targets }));
  const bases = ownBases(root, g, o), own = ownPredicate(root, g, bases);
  const also = alsoChanges(a, [...ids].filter((x) => a.changed.has(x)), own);
  // Drift the draft carries, shown at promotion too (never a refusal): nobody has to have run `check`.
  const dr = a.bc.exit !== 2 && a.pc.exit !== 2 ? await drift(root, a, g, undefined) : null;
  const driftWarnings = dr ? [...dr.removedElsewhere.map(removedText), ...dr.proseUnchanged.filter((r) => r.citedBy).map((r) => citedText(r, dr.base))] : [];
  return { a, g, bases, cand, targets, planSha, refusals, out: {
    name: o.name, ids: [...ids].sort(), alsoChanges: also.map((x) => x.id), alsoChangesDetail: also, driftWarnings, meta: meta.map((m) => m.key), files: files.map((f) => ({ path: f.path, merge: f.merge, ids: f.ids })),
    records: records.map((r) => ({ id: r.id, merge: r.merge })), evidence, candidate, bootstrap,
    targets: targets.map((t) => ({ ...t, action: t.before === null ? "create" : t.after === null ? "delete" : "replace" })), plan: planSha, refusals } };
}

const samePath = (x, y) => { try { return realpathSync(x) === realpathSync(y); } catch { return false; } };
// The default branch: origin/HEAD, else master, else main. → name | null
function defaultBranch(root) {
  const o = git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (o.status === 0 && o.out.trim()) return o.out.trim().replace(/^origin\//, "");
  for (const b of ["master", "main"]) if (git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]).status === 0) return b;
  return null;
}
// Where the task's own claims are judged from: the --own-base revisions given, else the fork point from the default
// branch and that branch's tip. A claim absent at every one is the task's own (created by it, in this promotion or an
// earlier one), never foreign; master's own new claims are on its tip, so they stay foreign. → [commit]
function ownBases(root, g, o) {
  if (!g.git) return [];
  if (o["own-base"].length) return o["own-base"].map((r) => { const c = resolveCommit(root, r); if (!c) throw new Fail(1, "bad-rev", `--own-base ${r} does not name a commit`); return c; });
  const target = defaultBranch(root), tip = target && resolveCommit(root, `refs/heads/${target}`);
  if (!tip) return [];
  const fork = git(root, ["merge-base", "HEAD", tip]);
  return uniqSorted([tip, ...(fork.status === 0 ? [fork.out.trim()] : [])]);
}
// The claim ids at each base, read from Git. → id => boolean (own)
function ownPredicate(root, g, bases) {
  if (!bases.length) return () => false;
  const sets = bases.map((c) => {
    const r = git(root, ["show", `${c}:${g.prefix ? `${g.prefix}/` : ""}${SPEC}/manifest.json`]);
    if (r.status !== 0) return new Set();
    try { return new Set(Object.keys(JSON.parse(r.out)?.claims ?? {})); } catch { return new Set(); }
  });
  return (id) => sets.every((k) => !k.has(id));
}
// What the promotion lands besides §, from the core's `foreign --landing` over the task's range (its fork point, else
// the draft's base commit, to the working tree) with the draft's graph as the head: unmapped changed files, § whose
// code changed under unchanged prose, and draft records left unpromoted. → {unmappedChanged, mappedUntouched, unpromotedDrafts} | {}
function landingOf(root, g, a, bases) {
  if (!g.git) return {};
  const target = defaultBranch(root), tip = target && resolveCommit(root, `refs/heads/${target}`);
  const fork = tip && git(root, ["merge-base", "HEAD", tip]);
  const head = resolveCommit(root, "HEAD");
  const from = fork?.status === 0 && fork.out.trim() !== head ? fork.out.trim() : a.d.base.commit ?? head;
  if (!from) return {};
  const r = spawnSync(process.execPath, [CORE, "foreign", "--base", from, "--spec", `${a.rel}/spec`, "--landing", ...bases.flatMap((b) => ["--own-base", b]), "--root", root, "--json"],
    { cwd: root, encoding: "utf8", maxBuffer: MAX_CORE_STDOUT, stdio: ["ignore", "pipe", "pipe"] });
  let j;
  try { j = JSON.parse(r.stdout); } catch { return { landingError: `core foreign --landing printed no JSON (status ${r.status})` }; }
  if (!Array.isArray(j.unmappedChanged)) return { landingError: j.findings?.map((f) => f.message).join("; ") || "no landing data" };
  return { unmappedChanged: j.unmappedChanged, mappedUntouched: j.mappedUntouched, unpromotedDrafts: j.unpromotedDrafts,
    complete: j.complete, incomplete: j.incomplete, draftScan: j.draftScan, findings: j.findings ?? [] };
}

// The foreign § a promotion of `ids` changes: each one current already has, and each current H1 that gains a new H2,
// never the task's own claims (`own`: absent at every own base). This, not memory, is what the reply's "Also changes:" line names.
function alsoChanges(a, ids, own = () => false) {
  const inCur = (id) => recOf(a.cur, id) !== undefined && !own(id), dirKinds = a.prop.manifest?.grammar?.directoryKinds ?? ["section"];
  const kinds = new Map(), mark = (id, k) => kinds.set(id, [...(kinds.get(id) ?? []), k]);
  const children = new Map();
  for (const id of uniqSorted(ids)) {
    const c = a.changed.get(id);
    if (inCur(id)) { if (c.deleted) mark(id, "deleted"); else { if (c.text) mark(id, "text"); if (c.record) mark(id, "record"); } continue; }
    const [ns] = id.slice(1).split("/"), parts = ns.split(".");
    const parent = parts.length > 1 && !dirKinds.includes(parts[0]) ? `§${parts[0]}/${parts[1]}` : null;
    if (own(id) && recOf(a.cur, id) !== undefined) continue; // an own claim promoted earlier: its parent gained it then
    if (parent && inCur(parent) && !c.deleted) children.set(parent, [...(children.get(parent) ?? []), id]);
  }
  for (const p of children.keys()) mark(p, "child-added");
  return [...kinds.keys()].sort().map((id) => ({ id, change: kinds.get(id).join("+") || "file", ...(children.has(id) ? { children: children.get(id) } : {}) }));
}

async function cmdPromote(root, o) {
  if (!o.write) {
    const p = await plan(root, o);
    // A preview: this promotion's own selected records are about to land, so they are not "left unpromoted".
    const l = landingOf(root, p.g, p.a, p.bases);
    if (l.unpromotedDrafts) l.unpromotedDrafts = l.unpromotedDrafts.map((d) => d.draft === o.name && samePath(d.worktree, root) ? { ...d, ids: d.ids.filter((id) => !p.out.ids.includes(id)) } : d).filter((d) => d.ids.length);
    return { exit: p.refusals.length ? 1 : 0, written: false, ...p.out, ...l };
  }
  return withLock(root, async () => {
    await refusePending(root);
    const p = await plan(root, o);
    if (p.refusals.length) throw new Fail(1, p.refusals[0].code, `promotion refused (${p.refusals.length} reason(s)); nothing was written`, { written: false, ...p.out });
    if (o.plan !== undefined && o.plan !== p.planSha) throw new Fail(1, "plan-changed", "the plan differs from the previewed --plan; preview again", { written: false, ...p.out });
    if (!p.targets.length) throw new Fail(1, "nothing-to-write", "current already equals the selected proposal", { written: false, ...p.out });
    const d = structuredClone(p.a.d);
    d.promotions.push({ at: new Date().toISOString(), plan: p.planSha, ids: p.out.ids, meta: p.out.meta, files: p.targets.map((t) => t.path) });
    const receipt = Buffer.from(JSON.stringify(d, null, 2) + "\n");
    await applyTxn(root, o.name, p.targets, p.cand, { before: p.a.sha, buf: receipt });
    return { exit: 0, written: true, ...p.out, ...landingOf(root, p.g, p.a, p.bases) };
  });
}

// ---------------------------------------------------------------- transaction
// Journal first (with old and new bytes), then each file by rename; any failure rolls back what was
// applied. A journal left behind (crash, failed rollback) blocks every write until `recover`.
const targetRel = (t) => `${t.storage === "draft" ? DRAFTS : SPEC}/${t.path}`;
async function applyTxn(root, name, targets, cand, receipt) {
  const drafts = await ownDir(root, DRAFTS, true);
  const txn = join(drafts, ".txn");
  await mkdir(txn);
  const entries = [...targets, { storage: "draft", path: `${name}/draft.json`, before: receipt.before, after: sha(receipt.buf) }].map((t, i) => ({ ...t, i }));
  const before = new Map();
  for (const t of entries) before.set(t.i, await readFileSafe(root, targetRel(t)));
  for (const t of entries) if ((before.get(t.i).sha256 ?? null) !== t.before || !["present", "absent"].includes(before.get(t.i).state)) {
    await rm(txn, { recursive: true, force: true });
    throw new Fail(1, "race", `${targetRel(t)} changed after the plan was made; nothing was written`);
  }
  for (const t of entries) {
    if (t.before !== null) await writeFile(join(txn, `old-${t.i}`), before.get(t.i).buf, { flag: "wx" });
    if (t.after !== null) await writeFile(join(txn, `new-${t.i}`), t.storage === "draft" ? receipt.buf : cand.get(t.path), { flag: "wx" });
  }
  await writeAtomic(txn, "journal.json", JSON.stringify({ format: FORMAT, draft: name, startedAt: new Date().toISOString(), pid: process.pid, targets: entries }, null, 2) + "\n");
  const made = [];
  try {
    for (const t of entries) {
      const now = await readFileSafe(root, targetRel(t));
      if ((now.sha256 ?? null) !== t.before || (now.state !== "present" && now.state !== "absent")) throw new Fail(1, "race", `${targetRel(t)} changed during promotion`);
      const dir = await ownDir(root, dirname(targetRel(t)), true, made);
      if (t.after === null) await unlink(join(dir, posix.basename(t.path)));
      else await writeAtomic(dir, posix.basename(t.path), t.storage === "draft" ? receipt.buf : cand.get(t.path));
    }
    for (const t of entries) {
      const now = await readFileSafe(root, targetRel(t));
      if (now.state !== (t.after === null ? "absent" : "present") || (now.sha256 ?? null) !== t.after) throw new Fail(1, "race", `${targetRel(t)} changed right after it was written`);
    }
  } catch (e) {
    try {
      // Inspect actual bytes: a syscall may have applied a rename before reporting failure.
      const applied = [];
      for (const t of entries) {
        const now = await readFileSafe(root, targetRel(t)), h = now.sha256 ?? null;
        if (!["present", "absent"].includes(now.state) || (h !== t.before && h !== t.after)) throw new Fail(1, "race", `${targetRel(t)} matches neither transaction side`);
        if (h === t.after) applied.push(t);
      }
      for (const t of applied) await backupOf(txn, t);
      for (const t of applied.reverse()) await restore(root, txn, t);
      for (const d of made.reverse()) await rmdir(d).catch(() => {});
    } catch (r) { throw new Fail(2, "rollback-failed", `promotion failed (${e.message}) and rollback failed (${r.message}); ${TXN} is kept — run recover`, { pending: true }); }
    await rm(txn, { recursive: true, force: true });
    if (!(e instanceof Fail)) e = new Fail(2, "write-failed", `${e.code ?? ""} ${e.message}`.trim());
    throw Object.assign(e, { message: `${e.message}; every applied file was rolled back` });
  }
  // The receipt has been applied and checked before the journal is retired.
  await rm(txn, { recursive: true, force: true });
}
async function backupOf(txn, t) {
  if (t.before === null) return null;
  const old = await readOpen(join(txn, `old-${t.i}`));
  if (old.state !== "present" || old.sha256 !== t.before) throw new Fail(2, "backup-corrupt", `backup of ${t.path} is missing or corrupt`);
  return old.buf;
}
async function restore(root, txn, t) {
  const old = await backupOf(txn, t);
  const dir = await ownDir(root, dirname(targetRel(t)), true);
  if (t.before === null) { await unlink(join(dir, posix.basename(t.path))).catch((e) => { if (e.code !== "ENOENT") throw e; }); return; }
  await writeAtomic(dir, posix.basename(t.path), old);
}

async function cmdRecover(root, o) {
  const inspectTxn = async () => {
    if (!(await exists(join(root, TXN)))) return null;
    const txn = await ownDir(root, TXN, false);
    const j = await readOpen(join(txn, "journal.json"));
    if (j.state === "absent") return { txn, journal: null, targets: [] }; // crashed before any live write
    let journal;
    try { journal = JSON.parse(j.buf.toString("utf8")); } catch { throw new Fail(2, "journal-corrupt", `${TXN}/journal.json is unreadable; inspect it by hand`); }
    if (!obj(journal) || journal.format !== FORMAT || !Array.isArray(journal.targets)) throw new Fail(2, "journal-corrupt", `${TXN}/journal.json is not a ${FORMAT} journal`);
    const targets = [];
    for (const t of journal.targets) {
      if (!obj(t) || normRel(t.path) !== t.path || !Number.isInteger(t.i) || t.i < 0 || targets.some((x) => x.i === t.i || targetRel(x) === targetRel(t)) || ![t.before, t.after].every((h) => h === null || HEX.test(h)) ||
          (t.storage !== undefined && (t.storage !== "draft" || !NAME_RE.test(journal.draft ?? "") || t.path !== `${journal.draft}/draft.json`))) throw new Fail(2, "journal-corrupt", "journal target malformed");
      const now = await readFileSafe(root, targetRel(t));
      const h = now.sha256 ?? null;
      targets.push({ ...t, state: now.state === "refused" ? "foreign" : h === t.before ? "untouched" : h === t.after ? "applied" : "foreign" });
    }
    return { txn, journal, targets };
  };
  const view = (x) => x && { draft: x.journal?.draft ?? null, startedAt: x.journal?.startedAt ?? null, targets: x.targets.map(({ i, ...t }) => t) };
  const foreignFail = (x) => {
    const foreign = x.targets.filter((t) => t.state === "foreign");
    if (foreign.length) throw new Fail(1, "recover-conflict", `${foreign.map((t) => t.path).join(", ")} match neither the pre- nor post-promotion bytes; nothing restored — resolve by hand using ${TXN}/old-* and new-*`, { pending: true, ...view(x) });
  };
  if (!o.write) {
    const x = await inspectTxn();
    if (!x) return { exit: 0, pending: false, written: false };
    foreignFail(x);
    return { exit: 0, pending: true, written: false, ...view(x), action: "roll back every applied file to its pre-promotion bytes" };
  }
  // With --write, also clears a lock left by a writer that is no longer running on this host.
  return withLock(root, async () => {
    const x = await inspectTxn();
    if (!x) return { exit: 0, pending: false, written: true, action: "no pending promotion; lock is clear" };
    foreignFail(x);
    // Validate every needed backup before restoring anything, receipt included.
    for (const t of x.targets) if (t.state === "applied") await backupOf(x.txn, t);
    for (const t of x.targets) if (t.state === "applied") await restore(root, x.txn, t);
    await rm(x.txn, { recursive: true, force: true });
    return { exit: 0, pending: false, written: true, ...view(x), action: "rolled back" };
  }, { takeOverDead: true });
}

// ---------------------------------------------------------------- merge-manifest
// Record-level three-way merge of manifest.json: each claim record and each top-level key merges on its own; the
// same key changed differently on both sides is a conflict, and a conflict writes nothing. Claim prose files are not
// touched: a claims file conflict is Git's (and yours) to resolve.
function mergeValue(b, o, t) {
  const [cb, co, ct] = [canon(b), canon(o), canon(t)];
  if (co === ct) return { v: o };
  if (co === cb) return { v: t, from: "theirs" };
  if (ct === cb) return { v: o };
  return { conflict: true };
}
function mergeObjects(b, o, t, kind, conflicts, taken) {
  const out = {};
  for (const k of uniqOrdered([...Object.keys(o), ...Object.keys(t)])) {
    const r = mergeValue(b[k], o[k], t[k]);
    if (r.conflict) { conflicts.push({ key: k, kind }); continue; }
    if (r.from === "theirs") taken.push({ key: k, kind, action: t[k] === undefined ? "delete" : o[k] === undefined ? "add" : "replace" });
    if (r.v !== undefined) out[k] = r.v;
  }
  return out;
}
const uniqOrdered = (a) => [...new Set(a)];
function mergeManifests(bText, oText, tText) {
  const parse = (text, side) => {
    if (text === null || !text.trim()) return {};
    let m;
    try { m = JSON.parse(text); } catch (e) { throw new Fail(2, "manifest-unreadable", `${side} manifest.json: ${e.message}`); }
    if (!obj(m) || (m.claims !== undefined && !obj(m.claims))) throw new Fail(2, "manifest-unreadable", `${side} manifest.json is not an object with an object claims`);
    return m;
  };
  const [b, o, t] = [parse(bText, "base"), parse(oText, "ours"), parse(tText, "theirs")];
  const conflicts = [], taken = [];
  const meta = (m) => Object.fromEntries(Object.entries(m).filter(([k]) => k !== "claims"));
  const top = mergeObjects(meta(b), meta(o), meta(t), "meta", conflicts, taken);
  const claims = mergeObjects(b.claims ?? {}, o.claims ?? {}, t.claims ?? {}, "claim", conflicts, taken);
  // Ours' key order, with claims where ours had them (or last).
  const merged = {};
  for (const k of uniqOrdered([...Object.keys(o), ...Object.keys(top), "claims"])) if (k === "claims") merged.claims = claims; else if (k in top) merged[k] = top[k];
  return { conflicts, taken, text: JSON.stringify(merged, null, 2) + "\n" };
}
async function cmdMergeManifest(root, o) {
  const driver = o.ours !== undefined;
  let texts, target;
  if (driver) {
    const read = async (p, side) => {
      const r = await readOpen(resolve(p));
      if (r.state === "absent" && side === "base") return null;
      if (r.state !== "present") throw new Fail(2, "file-refused", `--${side} ${p}: ${r.why ?? r.state}`);
      return r.buf.toString("utf8");
    };
    texts = [await read(o.base, "base"), await read(o.ours, "ours"), await read(o.theirs, "theirs")];
    target = resolve(o.ours);
  } else {
    const g = await gitInfo(root);
    if (!g.git) throw new Fail(2, "not-git", "merge-manifest without --base/--ours/--theirs reads Git's index stages; this is not a Git project");
    const path = `${g.prefix ? `${g.prefix}/` : ""}${SPEC}/manifest.json`;
    const stages = git(root, ["ls-files", "-u", "-z", "--full-name", "--", `${SPEC}/manifest.json`]);
    const have = new Set(stages.out?.split("\0").filter(Boolean).map((l) => l.split(/\s+/)[2]) ?? []);
    if (!have.has("2") || !have.has("3")) throw new Fail(1, "not-conflicted", `${SPEC}/manifest.json is not in a merge conflict (no index stages 2 and 3); nothing to merge`);
    const stage = (n) => { if (!have.has(n)) return null; const r = git(root, ["cat-file", "blob", `:${n}:${path}`]); if (r.status !== 0) throw new Fail(2, "git-failed", `git cat-file :${n}:${path}: ${r.err.trim()}`); return r.out; };
    texts = [stage("1"), stage("2"), stage("3")];
  }
  const m = mergeManifests(...texts);
  const out = { mode: driver ? "driver" : "index", conflicts: m.conflicts, fromTheirs: m.taken, written: false };
  if (m.conflicts.length) throw new Fail(1, "manifest-conflict", `${m.conflicts.length} key(s) changed differently on both sides (${m.conflicts.map((c) => `${c.kind} ${c.key}`).join(", ")}); nothing was written — re-apply one side's change in a new draft from the other and promote it`, out);
  if (!o.write) return { exit: 0, ...out };
  if (driver) await writeAtomic(dirname(target), posix.basename(target.split("\\").join("/")), m.text);
  else await withLock(root, async () => { await refusePending(root); await writeAtomic(await ownDir(root, SPEC, false), "manifest.json", m.text); });
  return { exit: 0, ...out, written: true, ...(driver ? {} : { next: `run sova-spec.mjs check, resolve any claims/ conflicts, then git add ${SPEC}/manifest.json` }) };
}

// ---------------------------------------------------------------- output
function human(out) {
  const L = [];
  if (out.command === "new" && out.files) L.push(`new ${out.name} → ${out.draft} ${out.written ? `(written; edit ${out.edit})` : "(preview; nothing written — pass --write)"}`,
    `copies ${out.specExisted ? `${out.files.length} files, ${out.bytes} bytes` : "nothing: no current spec (bootstrap draft with a starter manifest)"}`);
  if (out.command === "status" && out.ids) {
    L.push(`draft ${out.name}${out.purpose ? `: ${out.purpose}` : ""} (${out.git ? "Git" : "no Git"}; draft graph exit ${out.proposedGraph.exit})`);
    for (const i of out.ids) L.push(`  ${i.id} ${i.change}${i.record ? " record" : ""}${i.prose ? " prose" : ""} [${i.current}] evidence ${i.evidence.state}${i.evidence.reasons?.length && i.evidence.state !== "none" ? `: ${i.evidence.reasons.join("; ")}` : ""}`);
    for (const f of out.undeclaredFiles) L.push(`  file ${f} (no declarations; select with --file)`);
    for (const m of out.meta) L.push(`  manifest ${m.key} [${m.merge}]`);
    if (out.currentMoved.length) L.push(`current changed since the draft: ${out.currentMoved.join(", ")}`);
  }
  if (out.command === "diff" && out.files) {
    for (const f of out.files) L.push(`── ${f.path} (${out.against} → proposed)${f.ids.length ? ` ids ${f.ids.join(", ")}` : ""}`, ...f.diff);
    for (const r of out.records) L.push(`── record ${r.id}`, ...r.diff);
    for (const m of out.meta) L.push(`── manifest ${m.key}`, ...m.diff);
  }
  if (out.command === "check" && out.spec) L.push(`check ${out.spec}`, ...(out.coreFindings ?? []).map((f) => `${f.severity} ${f.code}: ${f.message}`));
  if (out.command === "evidence" && out.ids) L.push(`evidence ${out.mode}${out.commit ? ` ${out.commit}` : ""} for ${out.ids.map((i) => i.id).join(", ")} ${out.written ? "(recorded)" : "(preview; nothing written — pass --write)"}`,
    ...out.inputs.map((i) => `  ${i.path} ${i.state}${i.sha256 ? ` ${i.sha256.slice(0, 12)}` : ""}`));
  if (out.command === "promote" && out.targets) {
    L.push(`promote ${out.name}: ${out.ids.join(", ") || "(no ids)"} ${out.written ? "(written)" : "(preview; nothing written)"}`);
    for (const e of out.evidence) L.push(`  evidence ${e.id} ${e.state}${e.state !== "valid" ? `: ${e.reasons.join("; ")}` : ""}`);
    for (const t of out.targets) L.push(`  ${t.action.padEnd(7)} ${SPEC}/${t.path}`);
    for (const r of out.refusals ?? []) L.push(`  refused ${r.code}: ${r.message}`);
    for (const w of out.driftWarnings ?? []) L.push(`  warn drift: ${w}`);
    if (out.alsoChanges) L.push(`Also changes must name: ${out.alsoChanges.join(", ") || "none"} (foreign § this promotion changes)`);
    if (!out.written && !(out.refusals ?? []).length) L.push(`plan ${out.plan} — write with: promote ${out.name} … --plan ${out.plan} --write`);
  }
  if (out.command === "merge-manifest" && out.mode) L.push(`merge-manifest (${out.mode}): ${out.conflicts.length ? `${out.conflicts.length} conflict(s): ${out.conflicts.map((c) => `${c.kind} ${c.key}`).join(", ")}` : `${out.fromTheirs.length} key(s) from theirs`} ${out.written ? "(written)" : "(nothing written)"}`);
  if (out.command === "recover") L.push(out.pending === false ? "no pending promotion" : `pending promotion of draft ${out.draft}: ${(out.targets ?? []).map((t) => `${t.path} ${t.state}`).join(", ")}${out.action ? ` → ${out.action}` : ""}`);
  for (const f of out.findings) L.push(`${f.severity} ${f.code}: ${f.message}`);
  L.push(`note: ${NOTICE}`, `exit ${out.exit}`);
  return L.join("\n") + "\n";
}

async function evaluate(argv, readPolicy, inputSources) {
  let out = { tool: "sova-spec-draft", command: null, findings: [] };
  try {
    const o = parseArgs(argv);
    out.command = o.cmd;
    if (readPolicy !== undefined) {
      if (o.cmd !== "check" || !["review", "assessment"].includes(readPolicy)) throw new Fail(2, "usage", "read policy applies only to internal draft inspection");
      o.readPolicy = readPolicy;
      o.inputSources = inputSources;
    }
    const root = resolve(o.root);
    if (!(await lstat(root).catch(() => null))?.isDirectory()) throw new Fail(2, "root-missing", `${root} is not a directory`);
    out.root = root;
    if (await ownDir(root, SPEC, false).catch(() => { throw new Fail(2, "symlink-refused", `${SPEC} or .sova is not a plain directory`); }) === null && o.cmd !== "new")
      throw new Fail(2, "draft-missing", `no ${SPEC} under ${root}`);
    const cmds = { new: cmdNew, status: cmdStatus, diff: cmdDiff, check: cmdCheck, evidence: cmdEvidence, promote: cmdPromote, recover: cmdRecover, "merge-manifest": cmdMergeManifest };
    out = { ...out, ...(await cmds[o.cmd](root, o)) };
  } catch (e) {
    if (!(e instanceof Fail)) e = new Fail(2, "internal", e.stack ?? String(e));
    out = { ...out, ...(e.out ?? {}), exit: e.exit };
    out.findings.push({ severity: e.exit === 2 ? "error" : "warn", code: e.code, message: e.code === "usage" ? `${e.message}. ${USAGE}` : e.message });
  }
  out.notice = NOTICE;
  return out;
}

// Read-only internal triage: explicit per-call policy, no environment/global selector or write API.
export async function inspectDraft(root, name, options = {}) {
  if (typeof root !== "string" || typeof name !== "string" || !obj(options) || Object.keys(options).some(k => !["base", "readPolicy"].includes(k)) ||
      (options.base !== undefined && typeof options.base !== "string") || (options.readPolicy !== undefined && typeof options.readPolicy !== "string"))
    return { tool: "sova-spec-draft", command: "check", findings: [{ severity: "error", code: "usage", message: "invalid internal draft inspection arguments" }], exit: 2, notice: NOTICE };
  const { base, readPolicy = "default" } = options;
  const argv = ["check", name, "--root", root, "--json", ...(base === undefined ? [] : ["--base", base])];
  const inputSources = readPolicy === "assessment" ? [] : undefined;
  const out = await evaluate(argv, readPolicy === "default" ? undefined : readPolicy, inputSources);
  return JSON.parse(JSON.stringify({ ...out, ...(inputSources ? { inputSources } : {}) }));
}
async function main(argv) {
  const out = await evaluate(argv);
  process.stdout.write(argv.includes("--json") ? JSON.stringify(out, null, 2) + "\n" : human(out));
  return out.exit;
}
const direct = (() => {
  try { return !!process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (direct) process.exitCode = await main(process.argv.slice(2));
