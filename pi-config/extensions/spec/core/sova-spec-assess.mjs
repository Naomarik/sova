#!/usr/bin/env node
// Observation-only, metadata-only assessments. Node stdlib; no project code, models or semantic verdict.
import { open, lstat, mkdir, writeFile, link, unlink, readdir, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { resolve, join, dirname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { createInspection } from "./sova-spec.mjs";
import { inspectDraft } from "./sova-spec-draft.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)), STORE = ".sova/spec/assessments", FORMAT = "sova-spec-assessment/1";
const MAX_FILE = 2 * 1024 * 1024, MAX_TOTAL = 32 * 1024 * 1024, MAX_RECEIPTS = 100;
const ID = /^§[a-z][a-z-]*(?:\.[a-z][a-z-]*)?\/[a-z][a-z-]*$/, HEX = /^[a-f0-9]{64}$/;
const ATTR = ["ownerSessionId", "sessionId", "workerId", "teamId", "taskId", "attemptId"];
const DISPOSITIONS = ["changed", "preserved", "not-applicable", "unresolved"];
const NOTICE = "Observation of declared candidates and exact input applicability only; dispositions, intent and verification are recorder assertions, not semantic proof or a release gate. Metadata can itself be private.";
const SECRET_DIRS = new Set([".git", ".hg", ".svn", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker"]);
const SECRET_FILE = /^(?:\.env(?:\..*)?|\.envrc|auth\.json|credentials(?:\.json)?|\.netrc|\.npmrc|\.pypirc|\.pgpass|\.git-credentials|\.htpasswd|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|secrets?(?:(?:[.-][a-z0-9_-]+)*\.(?:json|ya?ml|toml|ini|conf|cfg|env|txt|properties|xml|enc|age|asc))?|.*\.(?:pem|key|p12|pfx|jks|keystore|kdbx|gpg))$/i;
class Fail extends Error { constructor(exit, code, message) { super(message); Object.assign(this, { exit, code }); } }
const sha = (b) => createHash("sha256").update(b).digest("hex");
const obj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const sorted = (xs) => [...new Set(xs)].sort();
const keys = (v, allowed) => obj(v) && Object.keys(v).every((k) => allowed.includes(k));
const text = (v, max = 4000) => typeof v === "string" && !!v.trim() && v.length <= max && !/[\0-\x08\x0b-\x1f\x7f]/.test(v);
const nameOk = (n) => typeof n === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(n) && n !== "objects";
function rel(raw) {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return null;
  const s = raw.replaceAll("\\", "/");
  if (s.startsWith("/") || /^[a-zA-Z]:/.test(s) || s.split("/").includes("..")) return null;
  const n = posix.normalize(s).replace(/\/$/, "");
  return n === "." ? null : n;
}
function refused(p) {
  const low = p.toLowerCase();
  if ([STORE, ".sova/spec/reviews", ".sova/spec/.cache"].some((d) => low === d || low.startsWith(d + "/"))) return "receipt/cache storage is not an input";
  const segs = p.split("/");
  if (segs.some((s) => SECRET_DIRS.has(s.toLowerCase())) || SECRET_FILE.test(segs.at(-1))) return "secret or credential path";
  return null;
}
async function inspect(root, p, own = false) {
  if (!rel(p)) return { state: "refused", why: "not a safe relative path" };
  const why = !own && refused(p); if (why) return { state: "refused", why };
  let cur = root;
  for (const s of p.split("/")) {
    cur = join(cur, s);
    let st; try { st = await lstat(cur); } catch (e) { return e.code === "ENOENT" || e.code === "ENOTDIR" ? { state: "absent" } : { state: "refused", why: `unreadable (${e.code})` }; }
    if (st.isSymbolicLink()) return { state: "refused", why: "symlink" };
    if (cur !== join(root, p) && !st.isDirectory()) return { state: "absent" };
    if (cur === join(root, p)) {
      if (!st.isFile()) return { state: "refused", why: "not a regular file" };
      if (st.nlink > 1) return { state: "refused", why: "hard-linked file" };
      if (st.size > MAX_FILE) return { state: "refused", why: "oversize" };
    }
  }
  let fh;
  try {
    fh = await open(cur, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const st = await fh.stat();
    if (!st.isFile()) return { state: "refused", why: "not a regular file" };
    if (st.nlink > 1) return { state: "refused", why: "hard-linked file" };
    if (st.size > MAX_FILE) return { state: "refused", why: "oversize" };
    const buf = await fh.readFile();
    if (buf.length > MAX_FILE) return { state: "refused", why: "oversize" };
    return { state: "present", sha256: sha(buf), bytes: buf.length, buf };
  } catch (e) { return { state: "refused", why: `unreadable (${e.code})` }; }
  finally { await fh?.close(); }
}
const state = (r) => ({ state: r.state, ...(r.state === "present" ? { sha256: r.sha256, bytes: r.bytes } : {}), ...(r.why ? { why: r.why } : {}) });
function stateOk(v) {
  return keys(v, ["path", "state", "sha256", "bytes", "why"]) && !!rel(v.path) && ["present", "absent", "refused"].includes(v.state) &&
    (v.state === "present" ? HEX.test(v.sha256 ?? "") && Number.isSafeInteger(v.bytes) && v.bytes >= 0 : v.sha256 === undefined && v.bytes === undefined) && (v.why === undefined || text(v.why));
}
function attribution(v = Object.fromEntries(ATTR.map((k) => [k, null]))) {
  if (!keys(v, ATTR) || ATTR.some((k) => !(v[k] === null || text(v[k], 128)))) throw new Fail(2, "attribution-invalid", "attribution requires exactly six nullable printable identity fields");
  return Object.fromEntries(ATTR.map((k) => [k, v[k]]));
}
function json(raw, label) { try { return JSON.parse(raw); } catch { throw new Fail(2, "usage", `${label} is not valid JSON`); } }
function queryOk(q) {
  return keys(q, ["base", "spec", "draft", "ids", "paths", "baseline"]) && (q.base === null || /^[a-f0-9]{40,64}$/.test(q.base)) && !!rel(q.spec) &&
    (q.draft === null || nameOk(q.draft)) && Array.isArray(q.ids) && q.ids.every((v) => ID.test(v)) && sorted(q.ids).length === q.ids.length &&
    Array.isArray(q.paths) && q.paths.every((v) => rel(v) === v) && sorted(q.paths).length === q.paths.length &&
    keys(q.baseline, ["inputs"]) && Array.isArray(q.baseline.inputs) && q.baseline.inputs.every(stateOk) && new Set(q.baseline.inputs.map((i) => i.path)).size === q.baseline.inputs.length;
}
function args(argv) {
  const o = { ids: [], paths: [], json: false, write: false, self: false, pos: [] };
  const valued = ["root", "base", "spec", "draft", "id", "path", "baseline-json", "attribution-json", "decisions-json", "by", "owner-session"];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (["--json", "--write", "--self"].includes(a)) o[a.slice(2)] = true;
    else if (a.startsWith("--") && valued.includes(a.slice(2))) {
      if (++i >= argv.length) throw new Fail(2, "usage", `${a} needs a value`);
      const k = a.slice(2); if (k === "id") o.ids.push(argv[i]); else if (k === "path") o.paths.push(argv[i]); else o[k] = argv[i];
    } else if (a.startsWith("-")) throw new Fail(2, "usage", "unsupported flag"); else o.pos.push(a);
  }
  const [cmd, name, ...rest] = o.pos; o.cmd = cmd; o.name = name;
  if (!["prepare", "record", "status"].includes(cmd) || !o.root || rest.length || (name === undefined ? !(cmd === "status" && o["owner-session"]) : !nameOk(name))) throw new Fail(2, "usage", "prepare/record/status NAME --root DIR, or status --owner-session OWNER --root DIR");
  const allowed = { prepare: ["base", "spec", "draft", "id", "path", "baseline-json", "attribution-json", "write"], record: ["by", "decisions-json", "attribution-json", "self", "write"], status: ["owner-session"] }[cmd];
  for (const k of [...valued.filter((k) => k !== "root" && k !== "id" && k !== "path"), "write", "self"]) if (o[k] && !allowed.includes(k)) throw new Fail(2, "usage", `${k} does not apply to ${cmd}`);
  if ((o.ids.length && cmd !== "prepare") || (o.paths.length && cmd !== "prepare") || (name && o["owner-session"])) throw new Fail(2, "usage", "invalid selector combination");
  if (o["owner-session"] !== undefined && !text(o["owner-session"], 128)) throw new Fail(2, "usage", "owner session must be a printable identity");
  o.attribution = attribution(o["attribution-json"] === undefined ? undefined : json(o["attribution-json"], "attribution"));
  if (cmd === "record" && (!o.write || !text(o.by, 128) || !o["decisions-json"])) throw new Fail(2, "usage", "record requires --write --by WHO --decisions-json JSON");
  return o;
}
const gitEnv = () => ({ ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" });
const gitArgs = (root, argv) => [...(argv[0] === "check-ignore" || argv[0] === "-C" && argv[2] === "check-ignore" ? [] : ["--literal-pathspecs"]), "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", root, ...argv];
function git(root, argv, maxBuffer = MAX_TOTAL, input) {
  return spawnSync("git", gitArgs(root, argv), { env: gitEnv(), input, shell: false, encoding: null, maxBuffer, timeout: 30000 });
}
async function gitProject(root) {
  const r = git(root, ["rev-parse", "--show-toplevel"]);
  if (r.status === 0) {
    const top = await realpath(r.stdout.toString().trim());
    if (top !== root) {
      const prefix = root.slice(top.length + 1);
      const ignored = git(root, ["-C", top, "check-ignore", "-q", "--", `${prefix}/`]);
      const tracked = git(root, ["-C", top, "ls-files", "-z", "--", `${prefix}/`]);
      if (ignored.status === 0 && tracked.status === 0 && tracked.stdout.length === 0) return false;
    }
    return true;
  }
  for (let p = root; ; p = dirname(p)) {
    if (await lstat(join(p, ".git")).catch(() => null)) throw new Fail(2, "git-unusable", "Git state exists but cannot be inspected");
    if (dirname(p) === p) break;
  }
  return false;
}
function availableHead(root) { try { return commit(root, "HEAD"); } catch { return null; } }
function commit(root, ref) {
  const r = git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  const s = r.status === 0 ? r.stdout.toString().trim() : "";
  if (!/^[a-f0-9]{40,64}$/.test(s)) throw new Fail(2, "bad-rev", "base does not name an available commit");
  return s;
}
// A capture-local immutable Git inspection. Exact selected paths are grouped by depth so a
// directory selection cannot suppress a separately selected child; nonrecursive metadata retains
// directory/symlink/gitlink modes. Byte keys avoid lossy filename decoding or pathspec aliasing.
async function baselinesAt(root, q, paths) {
  const out = new Map(), pending = new Map(), byDepth = new Map();
  const refusedAt = (why) => ({ source: "git-commit", state: "refused", why });
  for (const p of sorted(paths)) {
    const override = q.baseline.inputs.find((i) => i.path === p);
    if (override) out.set(p, { source: "declared-snapshot", ...state(override) });
    else if (!q.base) out.set(p, { source: "unknown", state: "unknown" });
    else if (refused(p) || !rel(p)) out.set(p, refusedAt("unsafe baseline path"));
    else { const depth = p.split("/").length; byDepth.set(depth, [...(byDepth.get(depth) ?? []), p]); }
  }
  for (const paths of byDepth.values()) {
    const chunks = []; let chunk = [], bytes = 0;
    for (const p of paths) {
      const n = Buffer.byteLength(p) + 1;
      if (chunk.length && bytes + n > 32768) { chunks.push(chunk); chunk = []; bytes = 0; }
      chunk.push(p); bytes += n;
    }
    if (chunk.length) chunks.push(chunk);
    for (const selected of chunks) {
      const ls = git(root, ["ls-tree", "-z", q.base, "--", ...selected]);
      const entries = new Map(); let valid = ls.status === 0, at = 0;
      if (valid) while (at < ls.stdout.length) {
        const end = ls.stdout.indexOf(0, at), tab = ls.stdout.indexOf(9, at);
        if (end < 0 || tab < at || tab > end) { valid = false; break; }
        const meta = ls.stdout.subarray(at, tab).toString("ascii").split(" ");
        if (meta.length !== 3 || !/^[0-7]{6}$/.test(meta[0]) || !["blob", "tree", "commit"].includes(meta[1]) || !/^[a-f0-9]{40,64}$/.test(meta[2])) { valid = false; break; }
        const key = ls.stdout.subarray(tab + 1, end).toString("hex");
        if (entries.has(key)) { valid = false; break; }
        entries.set(key, { mode: meta[0], type: meta[1], oid: meta[2] }); at = end + 1;
      }
      for (const p of selected) {
        const entry = entries.get(Buffer.from(p).toString("hex"));
        if (!valid) out.set(p, refusedAt("baseline unavailable"));
        else if (!entry) out.set(p, { source: "git-commit", state: "absent" });
        else if (!["100644", "100755"].includes(entry.mode) || entry.type !== "blob") out.set(p, refusedAt("baseline is not a regular blob"));
        else pending.set(p, entry.oid);
      }
    }
  }
  const ids = sorted([...pending.values()]);
  if (!ids.length) return out;
  const checked = git(root, ["cat-file", "--batch-check"], MAX_TOTAL, ids.join("\n") + "\n");
  const lines = checked.status === 0 ? checked.stdout.toString("ascii").trimEnd().split("\n") : [];
  const sizes = new Map();
  if (lines.length === ids.length) for (let i = 0; i < ids.length; i++) {
    const fields = lines[i].split(" "), size = Number(fields[2]);
    if (fields.length === 3 && fields[0] === ids[i] && fields[1] === "blob" && Number.isSafeInteger(size) && size >= 0 && size <= MAX_FILE) sizes.set(ids[i], size);
  }
  // Oversize and non-blob bytes are never requested. Only bounded, approved objects are streamed.
  const hashes = await hashBlobs(root, [...sizes.keys()], sizes);
  for (const [p, oid] of pending) {
    if (!sizes.has(oid)) out.set(p, refusedAt("baseline unavailable or oversize"));
    else if (!hashes?.has(oid)) out.set(p, refusedAt("baseline blob unreadable"));
    else out.set(p, { source: "git-commit", state: "present", sha256: hashes.get(oid), bytes: sizes.get(oid) });
  }
  return out;
}
function hashBlobs(root, ids, sizes) {
  if (!ids.length) return Promise.resolve(new Map());
  return new Promise((ok) => {
    const hashes = new Map(); let buffer = Buffer.alloc(0), header = null, index = 0, finished = false;
    const child = spawn("git", gitArgs(root, ["cat-file", "--batch"]), { env: gitEnv(), shell: false, stdio: ["pipe", "pipe", "ignore"], timeout: 30000 });
    const done = (value) => { if (!finished) { finished = true; ok(value); } };
    const bad = () => { child.kill(); done(null); };
    child.stdin.on("error", bad); child.on("error", () => done(null));
    child.stdout.on("data", (chunk) => {
      if (finished) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        if (header === null) {
          const nl = buffer.indexOf(10);
          if (nl < 0) { if (buffer.length > 200) bad(); return; }
          const fields = buffer.subarray(0, nl).toString("ascii").split(" "), size = Number(fields[2]);
          if (fields.length !== 3 || fields[0] !== ids[index] || fields[1] !== "blob" || !Number.isSafeInteger(size) || size !== sizes.get(ids[index])) { bad(); return; }
          header = { oid: ids[index], size }; buffer = buffer.subarray(nl + 1);
        }
        if (buffer.length < header.size + 1) return;
        if (buffer[header.size] !== 10) { bad(); return; }
        hashes.set(header.oid, sha(buffer.subarray(0, header.size)));
        buffer = buffer.subarray(header.size + 1); header = null; index++;
      }
    });
    child.on("close", (status) => done(status === 0 && index === ids.length && header === null && buffer.length === 0 ? hashes : null));
    child.stdin.end(ids.join("\n") + "\n");
  });
}
const equivalent = (a, b) => a.state !== "refused" && a.state === b.state && a.sha256 === b.sha256;
async function capture(root, q) {
  const unknowns = [], warn = (code, extra = {}) => unknowns.push({ code, ...extra });
  const reader = createInspection(root, { spec: q.spec, readPolicy: "assessment" });
  const graphSources = reader.sourceHashes();
  if (graphSources.conflict) throw new Fail(1, "race", "one graph source was parsed from conflicting byte versions");
  const check = reader.check();
  if (check.exit === 2) throw new Fail(2, "graph-untrusted", "selected graph cannot be trusted");
  const mf = await inspect(root, `${q.spec}/manifest.json`);
  if (mf.state !== "present") throw new Fail(2, "graph-untrusted", "manifest unavailable");
  const manifest = json(mf.buf.toString("utf8"), "manifest");
  if (!obj(manifest.claims)) throw new Fail(2, "core-contract", "manifest claims unavailable");
  const inputs = new Map(); let total = 0;
  const add = async (path, role, claim) => {
    const p = rel(path) ?? String(path); let entry = inputs.get(p);
    if (!entry) {
      const r = await inspect(root, p); if (r.state === "present") total += r.bytes;
      entry = { path: p, ...state(r), roles: [], claims: [] }; inputs.set(p, entry);
    }
    entry.roles = sorted([...entry.roles, role]); if (claim) entry.claims = sorted([...entry.claims, claim]);
    return entry;
  };
  await add(`${q.spec}/manifest.json`, "manifest"); await add(`${q.spec}/README.md`, "optional-policy");
  let changedFiles = q.paths;
  if (!q.paths.length && q.base) {
    const c = reader.census({ base: q.base, related: true });
    if (c.exit === 2 || !obj(c.census) || !Array.isArray(c.census.deleted)) throw new Fail(2, "change-inventory-untrusted", "Git changed inventory unavailable");
    const inv = c.census;
    if (inv.unclaimed === null || inv.outside === null) warn("change-boundary-unknown");
    changedFiles = sorted([...(inv.claimed ?? []).map((i) => i.path), ...(inv.mappedOutside ?? []).map((i) => i.path), ...(inv.unclaimed ?? []), ...(inv.outside ?? []), ...(inv.symlinks ?? []), ...inv.deleted]);
    for (const f of c.findings.filter((f) => f.severity === "warn" && f.code !== "changed-unclaimed")) warn(f.code, f.id ? { id: f.id } : {});
  } else if (!q.paths.length) warn("change-inventory-unknown");
  // Caller snapshot overrides subtract pre-existing dirty bytes only on an exact readable state match.
  for (const b of q.baseline.inputs) {
    const now = await add(b.path, "initial-dirty");
    if (b.state === "refused" || now.state === "refused") warn("initial-dirty-unknown", { path: b.path });
  }
  const retained = [];
  for (const p of changedFiles) {
    const i = await add(p, "changed-file");
    const b = q.baseline.inputs.find((v) => v.path === p);
    if (!(b && equivalent(i, b))) retained.push(p);
  }
  changedFiles = sorted(retained);
  // Do not retain a spurious changed-file role for an unchanged initial dirty path.
  for (const i of inputs.values()) if (!changedFiles.includes(i.path)) i.roles = i.roles.filter((r) => r !== "changed-file");
  const candidates = new Map();
  const route = (id, reason) => {
    if (!ID.test(id)) throw new Fail(2, "candidate-invalid", "invalid candidate identity");
    const rs = candidates.get(id) ?? []; if (!rs.some((r) => JSON.stringify(r) === JSON.stringify(reason))) rs.push(reason); candidates.set(id, rs);
  };
  const mapped = new Map();
  for (const [id, record] of Object.entries(manifest.claims)) for (const raw of record.code ?? []) {
    const p = rel(raw); if (p) mapped.set(p, sorted([...(mapped.get(p) ?? []), id]));
  }
  for (const p of changedFiles) for (const id of mapped.get(p) ?? []) route(id, { route: "mapped-file", path: p });
  for (const id of q.ids) route(id, { route: "explicit" });
  for (const id of [...candidates.keys()]) {
    const impact = reader.impact(id);
    if (impact.exit === 2) throw new Fail(2, "candidate-untrusted", "candidate impact unavailable");
    for (const c of impact.consumers ?? []) route(c.id, { route: "declared-consumer", of: id });
    for (const f of impact.frontier ?? []) warn("reverse-dependency-unknown", { id: f.id });
  }
  if (q.draft) {
    const dr = await inspectDraft(root, q.draft, { ...(q.base ? { base: q.base } : {}), readPolicy: "assessment" });
    if (!Array.isArray(dr.inputSources) || dr.inputSources.some(s =>
      !keys(s, ["path", "state", "sha256", "bytes", "why"]) || rel(s.path) !== s.path ||
      !["present", "absent", "refused"].includes(s.state) ||
      (s.state === "present" ? !HEX.test(s.sha256 ?? "") || (s.bytes !== undefined && (!Number.isSafeInteger(s.bytes) || s.bytes < 0))
        : s.sha256 !== undefined || s.bytes !== undefined) || (s.why !== undefined && !text(s.why))))
      throw new Fail(2, "core-contract", "draft triage input sources unavailable or invalid");
    const sourceVersions = new Map();
    for (const source of dr.inputSources) {
      const prior = sourceVersions.get(source.path);
      if (prior && (prior.state !== source.state || (source.state === "present" &&
          (prior.sha256 !== source.sha256 || (prior.bytes !== undefined && source.bytes !== undefined && prior.bytes !== source.bytes)))))
        throw new Fail(1, "race", "draft triage source was read from conflicting byte versions");
      if (!prior) sourceVersions.set(source.path, source);
    }
    if (dr.exit === 2) throw new Fail(2, "draft-untrusted", "draft candidate inventory unavailable");
    for (const source of dr.inputSources) {
      const input = await add(source.path, "draft-triage");
      if (source.state !== input.state || (source.state === "present" &&
          (source.sha256 !== input.sha256 || (source.bytes !== undefined && source.bytes !== input.bytes))))
        throw new Fail(1, "race", "draft triage source bytes differ from their bound input bytes");
    }
    for (const r of dr.drift?.removedElsewhere ?? []) for (const id of [r.id, ...r.alsoIn]) route(id, { route: "heuristic-restatement", of: r.id });
    for (const r of dr.drift?.proseUnchanged ?? []) if (r.citedBy) route(r.id, { route: "cited-unchanged-prose" });
    if (!dr.drift) warn("draft-triage-unknown");
    await add(`.sova/spec/drafts/${q.draft}/draft.json`, "draft-state");
    const baseCheck = createInspection(root, { spec: `.sova/spec/drafts/${q.draft}/base`, readPolicy: "assessment" }).check();
    if (baseCheck.exit === 2) throw new Fail(2, "draft-untrusted", "draft baseline unavailable");
    await add(`.sova/spec/drafts/${q.draft}/base/manifest.json`, "draft-baseline");
    for (const d of baseCheck.declarations ?? []) await add(`.sova/spec/drafts/${q.draft}/base/${d.file.replace(/^.*?\/base\//, "")}`, "draft-baseline");
  }
  const claims = [];
  for (const [id, reasons] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    const scope = reader.scope(id);
    if (scope.exit === 2 || !Array.isArray(scope.passages) || !Array.isArray(scope.code)) throw new Fail(2, "candidate-untrusted", "candidate closure unavailable");
    const own = scope.passages.find((p) => p.id === id), rec = manifest.claims[id];
    if (!own || !rec) throw new Fail(2, "candidate-untrusted", "candidate not declared");
    for (const p of scope.passages) {
      await add(p.file, "claim", p.id);
      for (const e of p.provenance?.entries ?? []) await add(e.file, "incumbent", p.id);
    }
    for (const c of scope.code) for (const cl of c.claims) await add(c.path, "code", cl);
    for (const f of scope.findings.filter((f) => f.severity === "warn" && !["provenance-moved", "provenance-stale"].includes(f.code))) warn(f.code, f.id ? { id: f.id } : {});
    claims.push({ id, kind: own.kind, ...(own.labels ? { declaredLabels: own.labels } : {}), textSha256: sha(own.text), recordSha256: sha(canonical(rec)), reasons, disposition: "unresolved" });
  }
  const boundManifest = inputs.get(rel(`${q.spec}/manifest.json`));
  if (mf.sha256 !== boundManifest?.sha256) throw new Fail(1, "race", "manifest bytes changed between parsing and input binding");
  for (const { path, sha256 } of graphSources.files) {
    const input = inputs.get(path);
    if (input?.state === "present" && input.sha256 !== sha256) throw new Fail(1, "race", "parsed graph source bytes differ from their bound input bytes");
  }
  const implementation = [...inputs.values()].filter((i) => i.roles.some((r) => ["code", "changed-file", "initial-dirty"].includes(r)));
  const baselines = await baselinesAt(root, q, implementation.map((i) => i.path));
  for (const i of inputs.values()) {
    if (baselines.has(i.path)) {
      i.baseline = baselines.get(i.path);
      if (["unknown", "refused"].includes(i.baseline.state)) warn("baseline-unknown", { path: i.path });
    }
    if (i.state === "refused" || (i.state === "absent" && i.roles.some((r) => !["optional-policy", "changed-file", "initial-dirty"].includes(r)))) warn("input-unknown", { path: i.path });
  }
  if (total > MAX_TOTAL) throw new Fail(1, "oversize", "captured inputs exceed total limit");
  const result = { changedFiles, candidates: claims, unmappedFiles: changedFiles.filter((p) => !mapped.has(p)), inputs: [...inputs.values()].sort((a, b) => a.path.localeCompare(b.path)), unknowns: sorted(unknowns.map((v) => JSON.stringify(v))).map((v) => JSON.parse(v)) };
  return { ...result, fingerprint: sha(canonical({ query: q, ...result })) };
}
async function revisionBinding(root, basis, cap) {
  const binding = { source: "recorder-declaration", revisionCommit: null, inputApplicability: "unknown" };
  if (basis.revision === null) return binding;
  let revision; try { revision = commit(root, basis.revision); } catch { return binding; }
  binding.revisionCommit = revision;
  const implementation = cap.inputs.filter((i) => i.roles.some((r) => ["code", "changed-file"].includes(r)));
  if (!implementation.length) return binding;
  let unknown = false, mismatch = false;
  const baselines = await baselinesAt(root, { base: revision, baseline: { inputs: [] } }, implementation.map((i) => i.path));
  for (const i of implementation) {
    const at = baselines.get(i.path);
    if (["refused", "unknown"].includes(at.state) || i.state === "refused") unknown = true;
    else if (!equivalent(i, at)) mismatch = true;
  }
  binding.inputApplicability = mismatch ? "mismatched" : unknown ? "unknown" : "matching";
  return binding;
}
function canonical(v) { return JSON.stringify(v, (_, x) => obj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x); }
async function twice(root, q) {
  const a = await capture(root, q), b = await capture(root, q);
  if (a.fingerprint !== b.fingerprint) throw new Fail(1, "race", "inputs changed during capture"); return b;
}
async function ownDir(root, path, create = false) {
  let cur = root;
  for (const s of path.split("/")) {
    cur = join(cur, s); let st;
    try { st = await lstat(cur); } catch (e) { if (e.code !== "ENOENT" || !create) { if (e.code === "ENOENT") return null; throw new Fail(2, "storage-unreadable", "receipt directory unreadable"); } await mkdir(cur, { mode: 0o700 }); st = await lstat(cur); }
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Fail(2, "storage-refused", "receipt directory is not plain");
  }
  return cur;
}
async function readOwn(root, p) {
  const r = await inspect(root, p, true);
  if (r.state === "absent") return null;
  if (r.state !== "present") throw new Fail(2, "storage-refused", "receipt file refused or unreadable");
  return r.buf;
}
async function writeNew(dir, name, value) {
  if (Buffer.byteLength(value) > MAX_FILE) throw new Fail(1, "oversize", "receipt metadata exceeds readable storage limit");
  const temp = join(dir, `.tmp-${randomBytes(8).toString("hex")}`);
  await writeFile(temp, value, { flag: "wx", mode: 0o600 });
  try { await link(temp, join(dir, name)); } catch (e) { if (e.code === "EEXIST") throw new Fail(1, "record-exists", "immutable receipt already exists"); throw e; } finally { await unlink(temp); }
}
async function locked(root, fn) {
  const dir = await ownDir(root, STORE, true), lock = join(dir, ".lock"), token = `${process.pid}:${randomBytes(8).toString("hex")}`;
  try { await writeFile(lock, token, { flag: "wx", mode: 0o600 }); } catch (e) { if (e.code === "EEXIST") throw new Fail(1, "lock-occupied", "another writer may be active; lock not removed"); throw e; }
  try {
    const ignored = await readOwn(root, `${STORE}/.gitignore`);
    if (ignored === null) await writeNew(dir, ".gitignore", "*\n");
    else if (ignored.toString() !== "*\n") throw new Fail(1, "storage-ignore-conflict", "receipt storage ignore policy differs; not overwritten");
    return await fn(dir);
  } finally { if ((await readOwn(root, `${STORE}/.lock`))?.toString() === token) await unlink(lock); }
}
function decisions(v, cap) {
  if (!keys(v, ["decisions", "files"]) || !Array.isArray(v.decisions) || !Array.isArray(v.files)) throw new Fail(2, "decisions-invalid", "decisions/files arrays required");
  const seenIds = new Set(), seenFiles = new Set(), ids = new Set(cap.candidates.map((c) => c.id)), paths = new Set(cap.unmappedFiles);
  for (const [groups, selector, allowed, seen] of [[v.decisions, "ids", ids, seenIds], [v.files, "paths", paths, seenFiles]]) for (const g of groups) {
    if (!keys(g, [selector, "disposition", "reason", "basis", ...(selector === "ids" ? ["acceptedIntent"] : [])]) || !Array.isArray(g[selector]) || !g[selector].length || !DISPOSITIONS.includes(g.disposition) || !text(g.reason) || !Array.isArray(g.basis) || !g.basis.length || (g.acceptedIntent !== undefined && typeof g.acceptedIntent !== "boolean")) throw new Fail(2, "decisions-invalid", "invalid disposition, reason or basis");
    for (const id of g[selector]) { if (!allowed.has(id) || seen.has(id)) throw new Fail(2, "decisions-invalid", "unknown or repeated candidate/file"); seen.add(id); }
    for (const b of g.basis) if (!keys(b, ["kind", "revision", "result", "summary"]) || !["test", "inspection", "command"].includes(b.kind) || !(b.revision === null || text(b.revision, 128)) || !["passed", "failed", "unknown"].includes(b.result) || !text(b.summary)) throw new Fail(2, "decisions-invalid", "invalid structured verification basis");
  }
  return v;
}
async function load(root, name) {
  await ownDir(root, `${STORE}/${name}`);
  const raw = await readOwn(root, `${STORE}/${name}/packet.json`);
  if (!raw) throw new Fail(2, "packet-missing", "assessment packet absent");
  const p = json(raw.toString(), "packet");
  if (!keys(p, ["format", "name", "createdAt", "capturedGitHead", "query", "attribution", "capture", "notice"]) || p.format !== FORMAT || p.name !== name || !text(p.createdAt, 64) || !(p.capturedGitHead === null || /^[a-f0-9]{40,64}$/.test(p.capturedGitHead ?? "")) || !queryOk(p.query) || !keys(p.capture, ["fingerprint", "changedFiles", "candidates", "unmappedFiles", "inputs", "unknowns"]) || !HEX.test(p.capture.fingerprint ?? "") || !Array.isArray(p.capture.candidates) || !Array.isArray(p.capture.inputs) || !Array.isArray(p.capture.unknowns) || !Array.isArray(p.capture.changedFiles) || !Array.isArray(p.capture.unmappedFiles) || sha(canonical({ query: p.query, ...Object.fromEntries(Object.entries(p.capture).filter(([k]) => k !== "fingerprint")) })) !== p.capture.fingerprint) throw new Fail(2, "packet-corrupt", "assessment packet schema or binding invalid");
  attribution(p.attribution);
  // Validate every stored field used by consumers; hashes alone do not validate arbitrary JSON.
  const capture = p.capture, strings = (xs) => Array.isArray(xs) && xs.every((x) => typeof x === "string");
  const unique = (xs) => new Set(xs).size === xs.length;
  const inputStateOk = (i) => stateOk(Object.fromEntries(Object.entries(i).filter(([k]) => ["path", "state", "sha256", "bytes", "why"].includes(k)))) || (i.state === "refused" && typeof i.path === "string" && i.path.length > 0 && i.sha256 === undefined && i.bytes === undefined && text(i.why));
  if (!strings(capture.changedFiles) || !strings(capture.unmappedFiles) || !unique(capture.changedFiles) || capture.changedFiles.some((p) => !rel(p)) || capture.unmappedFiles.some((p) => !capture.changedFiles.includes(p)) || !unique(capture.candidates.map((c) => c.id)) || !unique(capture.inputs.map((i) => i.path)) ||
    capture.unknowns.some((u) => !keys(u, ["code", "id", "path"]) || !text(u.code, 128) || (u.id !== undefined && !ID.test(u.id)) || (u.path !== undefined && typeof u.path !== "string")) ||
    capture.candidates.some((c) => !keys(c, ["id", "kind", "declaredLabels", "textSha256", "recordSha256", "reasons", "disposition"]) || !ID.test(c.id) || !["surface", "behavior", "note", "section"].includes(c.kind) || !HEX.test(c.textSha256 ?? "") || !HEX.test(c.recordSha256 ?? "") || c.disposition !== "unresolved" ||
      (c.declaredLabels !== undefined && (!keys(c.declaredLabels, ["authority", "evidence"]) || (c.declaredLabels.authority !== undefined && !["candidate", "migrated", "accepted"].includes(c.declaredLabels.authority)) || (c.declaredLabels.evidence !== undefined && !["unreviewed", "reviewed", "verified"].includes(c.declaredLabels.evidence)))) ||
      !Array.isArray(c.reasons) || c.reasons.some((r) => !keys(r, ["route", "path", "of"]) || !["mapped-file", "explicit", "declared-consumer", "heuristic-restatement", "cited-unchanged-prose"].includes(r.route) || (r.path !== undefined && !rel(r.path)) || (r.of !== undefined && !ID.test(r.of)))) ||
    capture.inputs.some((i) => !keys(i, ["path", "state", "sha256", "bytes", "why", "roles", "claims", "baseline"]) || !inputStateOk(i) || !strings(i.roles) || !strings(i.claims) || i.claims.some((c) => !ID.test(c)) ||
      (i.baseline !== undefined && (!keys(i.baseline, ["source", "state", "sha256", "bytes", "why"]) || !["git-commit", "declared-snapshot", "unknown"].includes(i.baseline.source) || (i.baseline.state !== "unknown" && !inputStateOk({ path: i.path, ...Object.fromEntries(Object.entries(i.baseline).filter(([k]) => k !== "source")) })))))
  ) throw new Fail(2, "packet-corrupt", "assessment input/candidate schema invalid");
  let record = null;
  const recRaw = await readOwn(root, `${STORE}/${name}/record.json`);
  if (recRaw) {
    record = json(recRaw.toString(), "record");
    if (!keys(record, ["format", "packetSha256", "recordedAt", "by", "selfReview", "attribution", "decisions", "notice"]) || record.format !== FORMAT || record.packetSha256 !== sha(raw) || !text(record.recordedAt, 64) || !text(record.by, 128) || typeof record.selfReview !== "boolean") throw new Fail(2, "record-corrupt", "assessment record binding invalid");
    attribution(record.attribution); decisions(record.decisions, p.capture);
  }
  return { packet: p, packetSha256: sha(raw), record };
}
async function prepare(root, o) {
  const gitExists = await gitProject(root);
  const q = { base: o.base ? commit(root, o.base) : gitExists ? availableHead(root) : null, spec: o.spec ?? ".sova/spec", draft: o.draft ?? null, ids: sorted(o.ids), paths: sorted(o.paths), baseline: o["baseline-json"] ? json(o["baseline-json"], "baseline") : { inputs: [] } };
  if (!queryOk(q)) throw new Fail(2, "usage", "invalid query paths, IDs or snapshot baseline");
  const finish = async () => {
    const cap = o.write ? await twice(root, q) : await capture(root, q);
    if (o.write) {
      if (await ownDir(root, `${STORE}/${o.name}`)) throw new Fail(1, "name-taken", "assessment names are immutable");
      const dir = await ownDir(root, `${STORE}/${o.name}`, true);
      const packet = { format: FORMAT, name: o.name, createdAt: new Date().toISOString(), capturedGitHead: gitExists ? availableHead(root) : null, query: q, attribution: o.attribution, capture: cap, notice: NOTICE };
      await writeNew(dir, "packet.json", JSON.stringify(packet, null, 2) + "\n");
    }
    return { exit: 0, written: o.write, name: o.name, packet: `${STORE}/${o.name}/packet.json`, query: q, attribution: o.attribution, ...cap };
  };
  return o.write ? locked(root, finish) : finish();
}
async function record(root, o) {
  return locked(root, async () => {
    const old = await load(root, o.name), cap = await twice(root, old.packet.query);
    if (cap.fingerprint !== old.packet.capture.fingerprint) throw new Fail(1, "stale", "input binding changed; prepare a new observation");
    const d = decisions(json(o["decisions-json"], "decisions"), cap);
    const rec = { format: FORMAT, packetSha256: old.packetSha256, recordedAt: new Date().toISOString(), by: o.by, selfReview: o.self, attribution: o.attribution, decisions: d, notice: NOTICE };
    await writeNew(join(root, STORE, o.name), "record.json", JSON.stringify(rec, null, 2) + "\n");
    return { exit: 0, name: o.name, written: true, record: rec };
  });
}
async function statusOne(root, name) {
  const { packet: p, record: r } = await load(root, name);
  let cap = null, currentFailure = null;
  try { cap = await capture(root, p.query); } catch (e) { if (!(e instanceof Fail)) throw e; currentFailure = e.code; }
  const applicability = currentFailure ? "unknown" : cap.fingerprint !== p.capture.fingerprint ? "stale" : cap.unknowns.length ? "unknown" : "current";
  const d = r?.decisions ?? { decisions: [], files: [] }, resolvedIds = new Set(d.decisions.filter((g) => g.disposition !== "unresolved").flatMap((g) => g.ids)), resolvedFiles = new Set(d.files.filter((g) => g.disposition !== "unresolved").flatMap((g) => g.paths));
  const coverage = { unresolvedIds: p.capture.candidates.filter((c) => !resolvedIds.has(c.id)).map((c) => c.id), unresolvedFiles: p.capture.unmappedFiles.filter((p) => !resolvedFiles.has(p)) };
  const verification = { passed: [], failed: [], unknown: [] };
  for (const g of [...d.decisions, ...d.files]) for (const b of g.basis) verification[b.result].push({ ...b, revisionBinding: await revisionBinding(root, b, p.capture), ...(g.ids ? { ids: g.ids } : { paths: g.paths }) });
  return { exit: applicability === "current" ? 0 : 1, name, fingerprint: p.capture.fingerprint, createdAt: p.createdAt, capturedGitHead: p.capturedGitHead ?? null, query: p.query, attribution: p.attribution, recordAttribution: r?.attribution ?? null, applicability, assessmentState: coverage.unresolvedIds.length || coverage.unresolvedFiles.length || !r ? "outstanding" : "recorded", coverage, verification, candidates: p.capture.candidates, changedFiles: p.capture.changedFiles, unmappedFiles: p.capture.unmappedFiles, decisions: r?.decisions ?? null, recorder: r ? { by: r.by, selfReview: r.selfReview, recordedAt: r.recordedAt } : null, unknowns: cap?.unknowns ?? p.capture.unknowns, reasons: currentFailure ? [currentFailure] : applicability === "stale" ? ["inputs-or-inventory-changed"] : [] };
}
async function status(root, o) {
  if (o.name) return statusOne(root, o.name);
  const dir = await ownDir(root, STORE);
  if (!dir) return { exit: 1, state: "absent", observations: [], excluded: 0, reasons: ["no-assessment-store"] };
  let names; try { names = (await readdir(dir)).filter((n) => !n.startsWith(".")).sort(); } catch { return { exit: 1, state: "incomplete", observations: [], excluded: 0, reasons: ["store-unreadable"] }; }
  const observations = [], reasons = []; let excluded = 0;
  if (names.length > MAX_RECEIPTS) reasons.push("receipt-inventory-capped");
  for (const name of names.slice(0, MAX_RECEIPTS)) {
    if (!nameOk(name)) { reasons.push("invalid-receipt-name"); continue; }
    try {
      const { packet } = await load(root, name);
      if (packet.attribution.ownerSessionId !== null && packet.attribution.ownerSessionId !== o["owner-session"]) { excluded++; continue; }
      observations.push(await statusOne(root, name));
    } catch (e) { reasons.push(`${name}:${e instanceof Fail ? e.code : "unreadable"}`); }
  }
  return { exit: reasons.length ? 1 : 0, state: reasons.length ? "incomplete" : observations.length ? "observed" : "absent", observations, excluded, reasons };
}
async function main() {
  let out = { tool: "sova-spec-assess", command: null, findings: [], notice: NOTICE };
  try {
    const o = args(process.argv.slice(2)); out.command = o.cmd;
    const root = resolve(o.root), st = await lstat(root).catch(() => null);
    if (!st?.isDirectory() || await realpath(root) !== root) throw new Fail(2, "root-refused", "root must be a plain existing directory without symlink ancestors");
    out = { ...out, ...await { prepare, record, status }[o.cmd](root, o) };
  } catch (e) {
    const f = e instanceof Fail ? e : new Fail(2, "internal", "assessment operation could not complete");
    out.exit = f.exit; out.findings.push({ severity: f.exit === 2 ? "error" : "warn", code: f.code, message: f.message });
  }
  process.stdout.write(JSON.stringify(out, null, 2) + "\n"); process.exitCode = out.exit;
}
await main();
