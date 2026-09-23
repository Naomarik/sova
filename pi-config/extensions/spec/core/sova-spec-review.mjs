#!/usr/bin/env node
// sova-spec-review: exact-input review evidence for one .sova/spec closure. Node stdlib only.
//   prepare §id --root DIR --name NAME [--write]     preview by default; --write stores a packet
//   record NAME --root DIR --by WHO --conclusion reconciled|unaffected|unresolved --note TEXT [--self]
//   status NAME --root DIR                           never writes
// All take [--json]. The closure comes from the sibling read-only core (`sova-spec.mjs scope --json`),
// spawned without a shell; no other program is ever run. Writes only under .sova/spec/reviews/.
// Exit: 0 operation done (status: applicable, concluded reconciled|unaffected, no blockers);
//       1 refused or outstanding (stale, race, blocked conclusion, name taken, lock held, oversize);
//       2 cannot (usage, core exit 2 or contract mismatch, corrupt packet or objects).
// Conservative by design: the WHOLE manifest and the spec README (policy) are inputs, so any edit to
// either stales every packet. A recorded conclusion is a reviewer's claim; nothing here computes
// semantic correctness, and nothing here edits claims, mappings or adoption.
// Limits, stated honestly: every path component is lstat'ed and the final open uses O_NOFOLLOW, but a
// parent directory swapped for a symlink between check and open is not fully prevented with portable
// fs calls. The lock and double capture detect races between COOPERATING writers only; nothing here is
// secure against a hostile writer on the same machine. A stale .sova/spec/reviews/.lock (crashed writer)
// is never removed automatically: delete it by hand only after verifying the pid it names is not running.
import { open, lstat, mkdir, writeFile, rename, link, unlink, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { resolve, join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";

const CORE = join(dirname(fileURLToPath(import.meta.url)), "sova-spec.mjs");
const FORMAT = "sova-spec-review/1";
const SPEC = ".sova/spec", REVIEWS = `${SPEC}/reviews`, MANIFEST = `${SPEC}/manifest.json`, POLICY = `${SPEC}/README.md`;
const MAX_FILE_BYTES = 2 * 1024 * 1024;   // one captured input; larger is refused, not truncated
const MAX_TOTAL_BYTES = 32 * 1024 * 1024; // all inputs of one capture; larger refuses --write
const MAX_CORE_STDOUT = 64 * 1024 * 1024;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const RESERVED = new Set(["objects"]);
const CONCLUSIONS = ["reconciled", "unaffected", "unresolved"];
const ID_RE = /^§[a-z][a-z-]*(?:\.[a-z][a-z-]*)?\/[a-z][a-z-]*$/;
// Core warnings that are the REASON for review, not missing evidence: they never block a conclusion.
const INFORMATIONAL = new Set(["provenance-moved", "provenance-stale"]);
// Never captured: credentials, auth/config secrets, VCS and runtime state. Visible as refused inputs.
// A secrets file is refused only bare or with a data extension; secrets.md and lib/secrets.ts are prose and code.
const SECRET_DIRS = new Set([".git", ".hg", ".svn", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"]);
const SECRET_FILE = /^(?:\.env(?:\..*)?|\.envrc|auth\.json|credentials(?:\.json)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|secrets?(?:(?:[.-][a-z0-9_-]+)*\.(?:json|ya?ml|toml|ini|conf|cfg|env|txt|properties|xml|enc|age|asc))?|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg))$/i;
const NOTICE = "Exact bytes of the known declared closure only. A conclusion is a reviewer's claim, not a computed pass; " +
  "unresolved is never completion; the whole manifest is an input on purpose.";

class Fail extends Error { constructor(exit, code, message) { super(message); this.exit = exit; this.code = code; } }
const sha = (b) => createHash("sha256").update(b).digest("hex");
const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
const same = (a = [], b = []) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------------------------------------------------------- args
function parseArgs(argv) {
  const o = { pos: [], json: false, write: false, self: false };
  const valued = new Set(["--root", "--name", "--by", "--conclusion", "--note"]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "--write" || a === "--self") o[a.slice(2)] = true;
    else if (valued.has(a)) { if (i + 1 >= argv.length) throw new Fail(2, "usage", `${a} needs a value`); o[a.slice(2)] = argv[++i]; }
    else if (a.startsWith("-")) throw new Fail(2, "usage", `unknown flag ${a}`);
    else o.pos.push(a);
  }
  const [cmd, arg, ...rest] = o.pos;
  o.cmd = cmd;
  if (!["prepare", "record", "status"].includes(cmd)) throw new Fail(2, "usage", cmd ? `unknown command ${cmd}` : "missing command");
  if (arg === undefined || rest.length) throw new Fail(2, "usage", `${cmd} takes exactly one ${cmd === "prepare" ? "§id" : "NAME"}`);
  if (o.root === undefined) throw new Fail(2, "usage", "--root PROJECT is required");
  const allowed = { prepare: ["name", "write"], record: ["by", "conclusion", "note", "self"], status: [] }[cmd];
  for (const k of ["name", "write", "by", "conclusion", "note", "self"]) if (o[k] && !allowed.includes(k)) throw new Fail(2, "usage", `--${k} does not apply to ${cmd}`);
  if (cmd === "prepare") {
    if (!ID_RE.test(arg)) throw new Fail(2, "usage", `not a § identifier: ${arg}`);
    o.id = arg;
    checkName(o.name);
  } else { checkName(arg); o.name = arg; }
  if (cmd === "record") {
    if (!CONCLUSIONS.includes(o.conclusion)) throw new Fail(2, "usage", `--conclusion must be one of ${CONCLUSIONS.join("|")}`);
    if (typeof o.by !== "string" || !o.by.trim() || o.by.length > 128 || /[\0-\x1f\x7f]/.test(o.by)) throw new Fail(2, "usage", "--by needs 1-128 printable characters");
    if (typeof o.note !== "string" || !o.note.trim() || o.note.length > 4000 || /[\0-\x08\x0b-\x1f\x7f]/.test(o.note)) throw new Fail(2, "usage", "--note needs 1-4000 characters of text");
  }
  return o;
}
function checkName(n) {
  if (typeof n !== "string" || !NAME_RE.test(n) || RESERVED.has(n)) throw new Fail(2, "usage", `review name must match ${NAME_RE} and not be ${[...RESERVED].join("|")}`);
}
const USAGE = "usage: sova-spec-review prepare §id --root DIR --name NAME [--write] | record NAME --root DIR --by WHO " +
  "--conclusion reconciled|unaffected|unresolved --note TEXT [--self] | status NAME --root DIR  [--json]";

// ---------------------------------------------------------------- paths
function normRel(raw) {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return null;
  const s = raw.split("\\").join("/");
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s)) return null;
  const n = posix.normalize(s).replace(/\/$/, "");
  return n === "." || n === ".." || n.startsWith("../") ? null : n;
}
function refusalOf(rel) {
  const low = rel.toLowerCase(), under = (d) => low === d || low.startsWith(d + "/"); // case-insensitive filesystems alias
  if (under(REVIEWS) || under(`${SPEC}/.cache`)) return "review/cache storage is never its own input";
  const segs = rel.split("/");
  if (segs.some((s) => SECRET_DIRS.has(s.toLowerCase()))) return "secret, config or runtime-state directory";
  if (SECRET_FILE.test(segs.at(-1))) return "secret or credential file";
  return null;
}

// Read a project-relative file: every component lstat'ed, no symlinks, regular file, size-bounded.
async function inspect(root, rel) {
  const why = refusalOf(rel);
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
  let fh;
  try { fh = await open(cur, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (e) {
    return e.code === "ENOENT" ? { state: "absent" } : { state: "refused", why: e.code === "ELOOP" ? "symlink" : `unreadable (${e.code})` };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { state: "refused", why: "not a regular file" };
    // A hard link may alias bytes kept elsewhere (a key outside the project): refused, conservatively.
    if (st.nlink > 1) return { state: "refused", why: `hard-linked file (${st.nlink} links)` };
    if (st.size > MAX_FILE_BYTES) return { state: "refused", why: `oversize (${st.size} > ${MAX_FILE_BYTES} bytes)` };
    const buf = await fh.readFile();
    if (buf.length > MAX_FILE_BYTES) return { state: "refused", why: `oversize (> ${MAX_FILE_BYTES} bytes)` };
    return { state: "present", bytes: buf.length, sha256: sha(buf), buf };
  } finally { await fh.close(); }
}

// Our own storage: each of .sova, .sova/spec, reviews, ... must be a real directory (created only if asked).
async function ownDir(root, rel, create) {
  let cur = root;
  for (const seg of rel.split("/")) {
    cur = join(cur, seg);
    let st;
    try { st = await lstat(cur); } catch (e) {
      if (e.code !== "ENOENT" || !create) return null;
      await mkdir(cur); st = await lstat(cur);
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Fail(2, "storage-refused", `${rel}: ${seg} is not a plain directory`);
  }
  return cur;
}
async function readOwn(abs) {
  let fh;
  try { fh = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch (e) { if (e.code === "ENOENT") return null; throw new Fail(2, "storage-refused", `${abs}: ${e.code}`); }
  try { if (!(await fh.stat()).isFile()) throw new Fail(2, "storage-refused", `${abs} is not a file`); return await fh.readFile(); } finally { await fh.close(); }
}
const exists = async (p) => { try { await lstat(p); return true; } catch { return false; } };
// Create `final` with `data` or fail; never overwrites (hard link from a private temp).
async function writeNew(dir, name, data) {
  const tmp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  await writeFile(tmp, data, { flag: "wx" });
  try { await link(tmp, join(dir, name)); return true; } catch (e) { if (e.code === "EEXIST") return false; throw e; } finally { await unlink(tmp); }
}

// ---------------------------------------------------------------- lock
async function withLock(root, fn) {
  const dir = await ownDir(root, REVIEWS, true);
  const lock = join(dir, ".lock"), token = `${process.pid} ${randomBytes(8).toString("hex")} ${new Date().toISOString()}`;
  try { await writeFile(lock, token, { flag: "wx" }); } catch (e) {
    if (e.code !== "EEXIST") throw e;
    const held = (await readOwn(lock).catch(() => null))?.toString("utf8") ?? "?";
    throw new Fail(1, "lock-occupied", `${REVIEWS}/.lock is held (${held.trim()}); another writer may be active. It was not removed.`);
  }
  try { return await fn(dir); } finally {
    if ((await readOwn(lock).catch(() => null))?.toString("utf8") === token) await unlink(lock);
  }
}

// ---------------------------------------------------------------- core
function runCore(root, id) {
  return new Promise((ok, bad) => {
    const ch = spawn(process.execPath, [CORE, "scope", id, "--root", root, "--json"], { cwd: root, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = []; let n = 0;
    ch.stdout.on("data", (c) => { n += c.length; if (n > MAX_CORE_STDOUT) ch.kill(); else chunks.push(c); });
    ch.stderr.resume();
    ch.on("error", (e) => bad(new Fail(2, "core-unavailable", `cannot run ${CORE}: ${e.message}`)));
    ch.on("close", (status) => {
      let j;
      try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return bad(new Fail(2, "core-contract", `core printed no JSON (status ${status})`)); }
      const why = contract(j, status);
      if (why) return bad(new Fail(2, "core-contract", `core output does not match the expected scope contract: ${why}`));
      ok(j);
    });
  });
}
function contract(j, status) {
  if (!j || j.tool !== "sova-spec") return "tool is not sova-spec";
  if (![0, 1, 2].includes(j.exit) || j.exit !== status) return "exit missing or differs from process status";
  if (!Array.isArray(j.findings)) return "findings is not an array";
  if (j.exit === 2) return null;
  if (!Array.isArray(j.passages) || !Array.isArray(j.code)) return "passages/code arrays missing";
  for (const p of j.passages)
    if (typeof p.id !== "string" || typeof p.file !== "string" || typeof p.text !== "string" || !Array.isArray(p.lines) || !Array.isArray(p.provenance?.entries)) return `passage ${p?.id} lacks id/file/lines/text/provenance.entries`;
  for (const c of j.code) if (typeof c.path !== "string" || typeof c.state !== "string" || !Array.isArray(c.claims)) return "code entry lacks path/state/claims";
  return null;
}

// ---------------------------------------------------------------- capture
// One capture: current closure from core, then exact bytes of every input it names, plus `extra`
// retained paths (an old packet's inputs, so removed dependencies are still compared).
async function capture(root, id, extra = []) {
  const core = await runCore(root, id);
  const cap = { core, inputs: [], blockers: [], informational: [], total: 0 };
  if (core.exit === 2) return cap;
  const want = new Map();
  const add = (raw, role, claim) => {
    const n = normRel(raw), key = n ?? String(raw);
    const e = want.get(key) ?? { path: key, roles: new Set(), claims: new Set(), derived: true, bad: !n };
    e.roles.add(role); if (claim) e.claims.add(claim);
    want.set(key, e);
  };
  add(MANIFEST, "manifest"); add(POLICY, "policy");
  for (const p of core.passages) { add(p.file, "claim", p.id); for (const e of p.provenance.entries) add(e.file, "incumbent", p.id); }
  for (const c of core.code) for (const cl of c.claims) add(c.path, "code", cl);
  for (const x of extra) if (!want.has(x)) want.set(x, { path: x, roles: new Set(), claims: new Set(), derived: false, bad: !normRel(x) });
  for (const e of [...want.values()].sort(byPath)) {
    const r = e.bad ? { state: "refused", why: "not a project-relative path" } : await inspect(root, e.path);
    if (r.state === "present") cap.total += r.bytes;
    cap.inputs.push({ path: e.path, roles: [...e.roles].sort(), claims: [...e.claims].sort(), derived: e.derived, ...r });
  }
  cap.closure = {
    passages: core.passages.map((p) => ({ id: p.id, kind: p.kind, file: p.file, lines: p.lines, reasons: p.reasons, textSha256: sha(p.text) })),
    code: core.code.map((c) => ({ path: c.path, state: c.state, claims: c.claims })),
    frontier: core.frontier ?? [],
  };
  for (const f of core.findings) if (f.severity === "warn")
    (INFORMATIONAL.has(f.code) ? cap.informational : cap.blockers).push({ source: "core", code: f.code, message: f.message, ...(f.id ? { id: f.id } : {}) });
  for (const i of cap.inputs) if (i.derived) {
    if (i.state === "refused") cap.blockers.push({ source: "capture", code: "input-refused", path: i.path, message: `${i.roles.join("+")} ${i.path}: ${i.why}` });
    else if (i.state === "absent" && !same(i.roles, ["policy"])) cap.blockers.push({ source: "capture", code: "input-absent", path: i.path, message: `${i.roles.join("+")} ${i.path} does not exist` });
  }
  return cap;
}
const plain = (i) => ({ path: i.path, roles: i.roles, claims: i.claims, state: i.state, ...(i.sha256 ? { sha256: i.sha256, bytes: i.bytes } : {}), ...(i.why ? { why: i.why } : {}) });
const fingerprint = (c) => sha(JSON.stringify({ exit: c.core.exit, findings: c.core.findings, closure: c.closure, inputs: c.inputs.map((i) => ({ ...plain(i), derived: i.derived })) }));
async function captureTwice(root, id, extra) {
  const a = await capture(root, id, extra), b = await capture(root, id, extra);
  if (b.core.exit === 2) return b;
  if (a.core.exit === 2 || fingerprint(a) !== fingerprint(b)) throw new Fail(1, "race", "inputs changed between two consecutive captures; retry when the files are quiet");
  return b;
}

// ---------------------------------------------------------------- compare
function changeOf(o, n) {
  if (!n) return "unreadable";
  if (o.state === n.state && o.sha256 === n.sha256 && o.why === n.why) return "unchanged";
  if (o.state === "present" && n.state === "present") return "changed";
  if (o.state === "absent" && n.state === "present") return "appeared";
  if (o.state === "present" && n.state === "absent") return "deleted";
  return "unreadable";
}
function compare(packet, cur) {
  const old = new Map(packet.inputs.map((i) => [i.path, i])), now = new Map(cur.inputs.map((i) => [i.path, i]));
  const movement = [...new Set([...old.keys(), ...now.keys()])].sort().map((path) => {
    const o = old.get(path), n = now.get(path);
    const mapping = !o ? "added" : !n?.derived ? "removed" : same(o.roles, n.roles) && same(o.claims, n.claims) ? "retained" : "remapped";
    const change = !o ? "new" : changeOf(o, n);
    const st = (i) => i && { state: i.state, ...(i.sha256 ? { sha256: i.sha256 } : {}), ...(i.why ? { why: i.why } : {}) };
    return { path, roles: (n?.derived ? n : o).roles, claims: (n?.derived ? n : o).claims, mapping, change, old: st(o) ?? null, current: st(n) ?? null };
  });
  const span = (p) => `${p.file}:${p.lines.join("-")}:${p.textSha256}`;
  const oldP = new Map(packet.closure.passages.map((p) => [p.id, p])), curP = new Map(cur.closure.passages.map((p) => [p.id, p]));
  const closure = {
    added: [...curP.keys()].filter((k) => !oldP.has(k)).sort(),
    removed: [...oldP.keys()].filter((k) => !curP.has(k)).sort(),
    respanned: [...curP.keys()].filter((k) => oldP.has(k) && span(oldP.get(k)) !== span(curP.get(k))).sort(),
  };
  const stale = movement.some((m) => m.change !== "unchanged" || m.mapping !== "retained") || Object.values(closure).some((l) => l.length);
  return { applicability: stale ? "stale" : "applicable", closure, movement };
}

// ---------------------------------------------------------------- packet storage
async function loadPacket(root, name) {
  const dir = await ownDir(root, `${REVIEWS}/${name}`, false);
  const raw = dir && (await readOwn(join(dir, "packet.json")));
  if (!raw) throw new Fail(2, "packet-missing", `no packet ${REVIEWS}/${name}/packet.json`);
  let p;
  try { p = JSON.parse(raw.toString("utf8")); } catch (e) { throw new Fail(2, "packet-corrupt", `packet.json: ${e.message}`); }
  const why = packetSchema(p, name);
  if (why) throw new Fail(2, "packet-corrupt", `packet.json is not a valid ${FORMAT} packet named ${name}: ${why}`);
  // Retained bytes must still be exactly what was captured.
  const objs = await ownDir(root, `${REVIEWS}/objects`, false);
  for (const i of p.inputs) if (i.state === "present") {
    const b = objs && (await readOwn(join(objs, i.sha256)));
    if (!b || sha(b) !== i.sha256) throw new Fail(2, "object-missing", `retained bytes of ${i.path} (${i.sha256}) are missing or corrupt`);
  }
  return { packet: p, packetSha256: sha(raw), dir };
}

// Every packet field the commands read, checked before use; anything else is packet-corrupt.
const HEX = /^[0-9a-f]{64}$/;
const obj = (x) => !!x && typeof x === "object" && !Array.isArray(x);
const strs = (x) => Array.isArray(x) && x.every((s) => typeof s === "string");
const findingsOk = (x) => Array.isArray(x) && x.every((f) => obj(f) && typeof f.code === "string" && typeof f.message === "string");
function packetSchema(p, name) {
  if (!obj(p) || p.format !== FORMAT || p.name !== name) return "format/name";
  if (!obj(p.query) || typeof p.query.id !== "string" || !ID_RE.test(p.query.id)) return "query.id";
  if (!Array.isArray(p.inputs)) return "inputs";
  const seen = new Set();
  for (const i of p.inputs) {
    if (!obj(i) || typeof i.path !== "string" || !i.path || seen.has(i.path)) return "input path";
    seen.add(i.path);
    if (!strs(i.roles) || !strs(i.claims)) return `${i.path}: roles/claims`;
    if (!["present", "absent", "refused"].includes(i.state)) return `${i.path}: state`;
    if (i.why !== undefined && typeof i.why !== "string") return `${i.path}: why`;
    if (i.state === "present" ? !(HEX.test(i.sha256 ?? "") && Number.isInteger(i.bytes) && i.bytes >= 0) : i.sha256 !== undefined) return `${i.path}: sha256/bytes`;
  }
  if (!obj(p.closure) || !Array.isArray(p.closure.passages) || !Array.isArray(p.closure.code)) return "closure";
  for (const q of p.closure.passages)
    if (!obj(q) || typeof q.id !== "string" || typeof q.file !== "string" || !HEX.test(q.textSha256 ?? "") ||
      !Array.isArray(q.lines) || q.lines.length !== 2 || !q.lines.every(Number.isInteger)) return "closure passage";
  if (!findingsOk(p.blockers) || !findingsOk(p.informational)) return "blockers/informational";
  return null;
}

// ---------------------------------------------------------------- commands
async function prepare(root, o) {
  const preview = async () => {
    const cap = await capture(root, o.id);
    return { cap, taken: await exists(join(root, REVIEWS, o.name)) };
  };
  const summary = (cap) => ({
    id: o.id, name: o.name, packet: `${REVIEWS}/${o.name}/packet.json`, coreExit: cap.core.exit, coreFindings: cap.core.findings,
    inputs: cap.inputs.map(plain), totals: { files: cap.inputs.filter((i) => i.state === "present").length, bytes: cap.total, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES },
    blockers: cap.blockers, informational: cap.informational,
  });
  const gate = (cap, taken) => {
    if (cap.core.exit === 2) throw Object.assign(new Fail(2, "core-untrusted", "core scope exited 2: the graph cannot be trusted, so no packet"), { out: summary(cap) });
    if (taken) throw Object.assign(new Fail(1, "name-taken", `${REVIEWS}/${o.name} already exists; packets are never overwritten`), { out: summary(cap) });
    if (cap.total > MAX_TOTAL_BYTES) throw Object.assign(new Fail(1, "oversize", `inputs total ${cap.total} bytes > ${MAX_TOTAL_BYTES}`), { out: summary(cap) });
  };
  if (!o.write) {
    const { cap, taken } = await preview();
    gate(cap, taken);
    return { exit: 0, written: false, ...summary(cap) };
  }
  return withLock(root, async (reviews) => {
    const cap = await captureTwice(root, o.id, []);
    gate(cap, await exists(join(reviews, o.name)));
    const objs = await ownDir(root, `${REVIEWS}/objects`, true);
    let added = 0;
    for (const i of cap.inputs) if (i.state === "present") {
      if (await writeNew(objs, i.sha256, i.buf)) added += i.bytes;
      else if (sha((await readOwn(join(objs, i.sha256))) ?? "") !== i.sha256) throw new Fail(2, "object-corrupt", `objects/${i.sha256} exists with other bytes`);
    }
    const packet = {
      format: FORMAT, name: o.name, createdAt: new Date().toISOString(),
      query: { command: "scope", id: o.id, exit: cap.core.exit, findings: cap.core.findings, notice: cap.core.notice },
      tools: { core: sha((await readOwn(CORE)) ?? ""), review: sha((await readOwn(fileURLToPath(import.meta.url))) ?? "") },
      closure: cap.closure, inputs: cap.inputs.map(plain), totals: { files: cap.inputs.filter((i) => i.state === "present").length, bytes: cap.total },
      blockers: cap.blockers, informational: cap.informational, notice: NOTICE,
    };
    const tmp = join(reviews, `.tmp-${randomBytes(8).toString("hex")}`);
    await mkdir(tmp);
    try {
      await writeFile(join(tmp, "packet.json"), JSON.stringify(packet, null, 2) + "\n", { flag: "wx" });
      if (await exists(join(reviews, o.name))) throw new Fail(1, "name-taken", `${REVIEWS}/${o.name} already exists`);
      await rename(tmp, join(reviews, o.name));
    } catch (e) { await rm(tmp, { recursive: true, force: true }); throw e; }
    return { exit: 0, written: true, newObjectBytes: added, ...summary(cap) };
  });
}

async function record(root, o) {
  return withLock(root, async () => {
    const { packet, packetSha256, dir } = await loadPacket(root, o.name);
    if (await exists(join(dir, "record.json"))) throw new Fail(1, "record-exists", `${REVIEWS}/${o.name}/record.json already exists; records are immutable — prepare a new packet`);
    const cur = await captureTwice(root, packet.query.id, packet.inputs.map((i) => i.path));
    if (cur.core.exit === 2) throw new Fail(2, "core-untrusted", "core scope now exits 2; cannot recheck the closure");
    const cmp = compare(packet, cur);
    const base = { name: o.name, id: packet.query.id, applicability: cmp.applicability, closure: cmp.closure, movement: cmp.movement.filter((m) => m.change !== "unchanged" || m.mapping !== "retained") };
    if (cmp.applicability === "stale") throw Object.assign(new Fail(1, "stale", "inputs or the closure moved since the packet was prepared; prepare a new packet and review again"), { out: base });
    const blockers = [...packet.blockers, ...cur.blockers];
    if (o.conclusion !== "unresolved" && blockers.length)
      throw Object.assign(new Fail(1, "evidence-incomplete", `a ${o.conclusion} conclusion needs complete evidence; ${blockers.length} blocker(s). Record unresolved instead, or fix and re-prepare`), { out: { ...base, blockers } });
    const rec = {
      format: FORMAT, packet: o.name, packetSha256, id: packet.query.id, recordedAt: new Date().toISOString(),
      by: o.by, selfReview: o.self, conclusion: o.conclusion, note: o.note, blockers,
      notice: "A reviewer's conclusion over the packet's exact bytes. Not a computed pass. Self-review is never independent review.",
    };
    if (!(await writeNew(dir, "record.json", JSON.stringify(rec, null, 2) + "\n"))) throw new Fail(1, "record-exists", "record.json appeared concurrently; not overwritten");
    return { exit: 0, ...base, record: rec, completion: o.conclusion === "unresolved" ? "not complete: unresolved" : "concluded (see status)" };
  });
}

async function status(root, o) {
  const { packet, packetSha256, dir } = await loadPacket(root, o.name);
  let rec = null, recordState = "none";
  const raw = await readOwn(join(dir, "record.json"));
  if (raw) {
    try { rec = JSON.parse(raw.toString("utf8")); recordState = obj(rec) && rec.packetSha256 === packetSha256 && CONCLUSIONS.includes(rec.conclusion) ? "valid" : "mismatched"; }
    catch { recordState = "corrupt"; }
  }
  const cur = await capture(root, packet.query.id, packet.inputs.map((i) => i.path));
  if (cur.core.exit === 2) throw Object.assign(new Fail(2, "core-untrusted", "core scope exits 2; the current closure cannot be computed"), { out: { findings: cur.core.findings } });
  const cmp = compare(packet, cur);
  const conclusion = recordState === "valid" ? rec.conclusion : null;
  const met = cmp.applicability === "applicable" && !packet.blockers.length && !cur.blockers.length && (conclusion === "reconciled" || conclusion === "unaffected");
  return {
    exit: met ? 0 : 1, name: o.name, id: packet.query.id, createdAt: packet.createdAt,
    movement: cmp.movement, closure: cmp.closure, applicability: cmp.applicability,
    conclusion: { state: recordState, conclusion, ...(rec && recordState === "valid" ? { by: rec.by, selfReview: rec.selfReview, recordedAt: rec.recordedAt, note: rec.note } : {}) },
    blockers: { packet: packet.blockers, current: cur.blockers }, informational: cur.informational,
    gate: met ? "met: applicable, concluded, no blockers (a local review gate, not semantic correctness)" : "outstanding",
  };
}

// ---------------------------------------------------------------- output
function human(out) {
  const L = [];
  if (out.command === "prepare" && out.inputs) {
    L.push(`prepare ${out.id} → ${out.packet} ${out.written ? `(written; ${out.newObjectBytes} new object bytes)` : "(preview; nothing written — pass --write)"}`);
    L.push(`inputs: ${out.totals.files} files, ${out.totals.bytes} bytes (limits ${MAX_FILE_BYTES}/file, ${MAX_TOTAL_BYTES}/total)`);
    for (const i of out.inputs) L.push(`  ${i.roles.join("+").padEnd(16)} ${i.path}  ${i.state === "present" ? `${i.bytes} B ${i.sha256.slice(0, 12)}` : i.state}${i.why ? ` (${i.why})` : ""}`);
  }
  if (out.movement) {
    L.push(`${out.name} ${out.id}: ${out.applicability}`);
    for (const m of out.movement) if (m.change !== "unchanged" || m.mapping !== "retained") L.push(`  ${m.change.padEnd(10)} ${m.mapping.padEnd(9)} ${m.path}`);
    for (const k of ["added", "removed", "respanned"]) if (out.closure[k].length) L.push(`  closure ${k}: ${out.closure[k].join(", ")}`);
  }
  if (out.conclusion) L.push(`conclusion: ${out.conclusion.conclusion ?? out.conclusion.state}${out.conclusion.by ? ` by ${out.conclusion.by}${out.conclusion.selfReview ? " (self-review)" : ""}` : ""}`);
  if (out.record) L.push(`recorded ${out.record.conclusion} by ${out.record.by}${out.record.selfReview ? " (self-review)" : ""}: ${out.completion}`);
  const bl = Array.isArray(out.blockers) ? out.blockers : [...(out.blockers?.packet ?? []), ...(out.blockers?.current ?? [])];
  for (const b of bl) L.push(`blocker ${b.code}: ${b.message}`);
  for (const b of out.informational ?? []) L.push(`info ${b.code}: ${b.message}`);
  if (out.gate) L.push(`gate: ${out.gate}`);
  for (const f of out.findings) L.push(`${f.severity} ${f.code}: ${f.message}`);
  L.push(`note: ${NOTICE}`, `exit ${out.exit}`);
  return L.join("\n") + "\n";
}

async function main(argv) {
  let out = { tool: "sova-spec-review", command: null, findings: [] }, json = argv.includes("--json");
  try {
    const o = parseArgs(argv);
    out.command = o.cmd;
    const root = resolve(o.root);
    if (!(await lstat(root).catch(() => null))?.isDirectory()) throw new Fail(2, "root-missing", `${root} is not a directory`);
    out.root = root;
    out = { ...out, ...(await { prepare, record, status }[o.cmd](root, o)) };
  } catch (e) {
    if (!(e instanceof Fail)) e = new Fail(2, "internal", e.stack ?? String(e));
    out = { ...out, ...(e.out ?? {}), exit: e.exit };
    out.findings.push({ severity: e.exit === 2 ? "error" : "warn", code: e.code, message: e.code === "usage" ? `${e.message}. ${USAGE}` : e.message });
  }
  process.stdout.write(json ? JSON.stringify(out, null, 2) + "\n" : human(out));
  return out.exit;
}

process.exitCode = await main(process.argv.slice(2));
