#!/usr/bin/env node
// mesh-parity: prove that a `mesh` commit with NO peer configured behaves as the master baseline
// (6444a04) does. Both trees are extracted with `git archive` (never a git worktree), installed
// from the frozen lockfile, and run one after the other at the SAME paths (agent dir, HOME, TMPDIR,
// fixture cwd, port), so almost nothing needs normalizing; see normalize.mjs for what does and why.
//
//   node scripts/mesh-parity/parity.mjs                    # baseline vs HEAD of branch `mesh`
//   node scripts/mesh-parity/parity.mjs --mesh <rev>       # vs another commit
//   node scripts/mesh-parity/parity.mjs --aa               # baseline vs itself: the noise floor
//   node scripts/mesh-parity/parity.mjs --patch x.diff     # apply a patch to the mesh tree (canaries)
//   node scripts/mesh-parity/parity.mjs --only rest,watch  # a subset of phases
//   node scripts/mesh-parity/parity.mjs --expect-mesh-ui home-desktop=1,settings=1
//
// Phases: static (typecheck, build, pnpm test), rest, watch, screens, chat (glm-5.3), proc
// (strace + ss: ports, outbound connections, execs, tailscale, idle wakeups), disk (every file the
// run left in the agent dir and HOME). Exit 0 only if every compared item matches or is listed in
// allowed-diffs.json with a reason.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { seedFixtures } from "./fixtures.mjs";
import { canonical, genericPath, jsonDiff, makeNormalizer, maskModelOutput, stripThinking } from "./normalize.mjs";
import { analyzeStrace, listeningSockets } from "./proc.mjs";
import { restSteps, runRest, serverRoutes, uncoveredRoutes } from "./rest.mjs";
import { captureScreens, comparePng, screenList, startBrowser } from "./screens.mjs";
import { buildAgentDir, freePort, pnpmRun, prepareTree, sideEnv, startServer, descendants, serverPids } from "./side.mjs";
import { chatPhase, chatShape, collect, dropOutline, watchPhase } from "./wsphase.mjs";
import { extensionSteps, extensionWs, installExtensions, startEchoBackend } from "./extfixture.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const BASELINE_SHA = "6444a04";
const ALL_PHASES = ["static", "rest", "watch", "screens", "chat", "proc", "disk"];

const { values: opt } = parseArgs({
  options: {
    mesh: { type: "string", default: "mesh" },
    aa: { type: "boolean", default: false },
    patch: { type: "string" },
    only: { type: "string" },
    skip: { type: "string" },
    work: { type: "string", default: join(homedir(), ".cache/sova-mesh/qa-reviewer") },
    baseline: { type: "string", default: join(homedir(), ".cache/sova-mesh/baseline") },
    "expect-mesh-ui": { type: "string", default: "" },
    "idle-seconds": { type: "string", default: "20" },
    auth: { type: "string", default: join(REPO, ".agent/auth.json") },
    label: { type: "string", default: "" },
  },
});
const phases = new Set(opt.only ? opt.only.split(",") : ALL_PHASES);
for (const p of (opt.skip ?? "").split(",").filter(Boolean)) phases.delete(p);
const has = (p) => phases.has(p);
const expectMeshUi = Object.fromEntries(opt["expect-mesh-ui"].split(",").filter(Boolean).map((kv) => kv.split("=")).map(([k, v]) => [k, Number(v)]));
const AUTH_KEYS = ["deepseek", "ollama-cloud", "zai"];

const log = (...a) => console.error(`[parity ${new Date().toISOString().slice(11, 19)}]`, ...a);
const git = (...args) => execFileSync("git", ["-C", REPO, ...args]).toString().trim();

// ---- trees -------------------------------------------------------------------------------------
const baseSha = git("rev-parse", `${BASELINE_SHA}^{commit}`);
const meshSha = opt.aa ? baseSha : git("rev-parse", `${opt.mesh}^{commit}`);
const patchTag = opt.patch ? "-" + createHash("sha256").update(readFileSync(opt.patch)).digest("hex").slice(0, 8) : "";
log(`baseline ${baseSha.slice(0, 10)}  vs  ${opt.aa ? "baseline (A/A)" : `mesh ${meshSha.slice(0, 10)}${patchTag ? ` + patch ${opt.patch}` : ""}`}`);
const baseTree = prepareTree({ repo: REPO, sha: baseSha, dest: opt.baseline });
const meshTree = opt.aa && !opt.patch ? baseTree : prepareTree({ repo: REPO, sha: meshSha, dest: join(opt.work, "trees", meshSha.slice(0, 12) + patchTag), patch: opt.patch });

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const RUN = join(opt.work, "runs", `${stamp}${opt.label ? "-" + opt.label : ""}`);
const LIVE = join(opt.work, "live");
mkdirSync(RUN, { recursive: true });
const PORT = await freePort(4871, 4889);
const EXT_PORT = await freePort(4871, 4889, new Set([PORT]));
const DOWN_PORT = await freePort(4871, 4889, new Set([PORT, EXT_PORT])); // never listened on: the "down" extension
const runStart = Date.now();
log(`run dir ${RUN}; live dir ${LIVE}; port ${PORT}`);

// ---- one side ----------------------------------------------------------------------------------
async function runSide(side, tree, browser) {
  const out = { side, tree, marks: [] };
  const dir = join(RUN, side);
  mkdirSync(dir, { recursive: true });
  rmSync(LIVE, { recursive: true, force: true });
  const home = join(LIVE, "home"), tmp = join(LIVE, "tmp"), cwd = join(LIVE, "cwd");
  for (const d of [home, tmp, cwd]) mkdirSync(d, { recursive: true });
  // The fixture cwd: a git repository whose one commit is fixed (author, dates), so its sha and the
  // git summary are the same on both sides.
  writeFileSync(join(cwd, "README.md"), "# parity fixture\n");
  writeFileSync(join(cwd, "notes.txt"), "a file for the @-mention index\n");
  const genv = { ...sideEnv({ home, tmp }), GIT_AUTHOR_NAME: "Parity", GIT_AUTHOR_EMAIL: "parity@example.invalid", GIT_COMMITTER_NAME: "Parity", GIT_COMMITTER_EMAIL: "parity@example.invalid", GIT_AUTHOR_DATE: "2025-06-01T09:00:00Z", GIT_COMMITTER_DATE: "2025-06-01T09:00:00Z" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd, env: genv });
  execFileSync("git", ["add", "."], { cwd, env: genv });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd, env: genv });
  const agent = buildAgentDir({ tree, dir: LIVE, authSource: opt.auth, expectAuthKeys: AUTH_KEYS });
  const authHash = sha256(readFileSync(join(agent, "auth.json")));
  const f = seedFixtures(agent, cwd);
  installExtensions(agent, LIVE, EXT_PORT, DOWN_PORT);
  out.fixtures = f;

  if (has("static") || has("screens")) {
    log(`${side}: build`);
    out.build = pnpmRun(tree, "build", { ...sideEnv({ home, tmp }) }, join(dir, "build.log"));
    delete out.build.output;
  }
  if (!["rest", "watch", "screens", "chat", "proc", "disk"].some(has)) return out;

  const env = sideEnv({ home, tmp, agent, port: PORT });
  const echo = await startEchoBackend(tree, EXT_PORT);
  const server = await startServer({ tree, env, logDir: dir, strace: has("proc") }).catch(async (e) => { await echo.stop(); throw e; });
  // Sub-millisecond: strace stamps are microseconds, and a syscall a few µs after a
  // millisecond-truncated mark lands in the wrong phase.
  const now = () => (performance.timeOrigin + performance.now()) / 1000;
  const mark = (phase) => out.marks.push({ phase, t: now() });
  try {
    mark("rest");
    if (has("rest")) {
      log(`${side}: rest`);
      const steps = restSteps({ f, cwd, extra: extensionSteps() });
      out.rest = await runRest(server.base, steps);
    }
    mark("watch");
    if (has("watch")) {
      log(`${side}: watch`);
      out.watch = await watchPhase(tree, server.base.replace(/^http/, "ws"), f);
      Object.assign(out.watch, await extensionWs(collect, tree, server.base.replace(/^http/, "ws")));
    }
    mark("screens");
    if (has("screens") && browser) {
      log(`${side}: screens`);
      out.screens = await captureScreens(browser, server.base, f, join(dir, "screens"));
    }
    mark("chat");
    if (has("chat")) {
      log(`${side}: chat (glm-5.3)`);
      out.chat = await chatPhase(tree, server.base, cwd);
      if (out.chat.created?.body?.path) {
        out.chatAfter = await runRest(server.base, [
          { name: "transcript:chat", method: "GET", url: `/api/transcript?path=${encodeURIComponent(out.chat.created.body.path)}` },
          { name: "sessions:after-chat", method: "GET", url: "/api/sessions" },
        ]);
      }
    }
    mark("idle");
    if (has("proc")) {
      log(`${side}: idle ${opt["idle-seconds"]}s`);
      const t0 = Date.now() / 1000;
      await new Promise((r) => setTimeout(r, Number(opt["idle-seconds"]) * 1000));
      out.idleWindow = [t0, Date.now() / 1000];
      const pids = descendants(server.proc.pid);
      out.mainPid = serverPids(server.proc.pid)[0];
      out.listening = listeningSockets(execFileSync("ss", ["-ltunpH"]).toString(), pids, PORT);
    }
    mark("stop");
  } finally {
    await server.stop();
    await echo.stop();
  }
  out.gracefulStop = server.stopped.graceful;
  if (has("proc")) out.proc = analyzeStrace(join(dir, "strace.log"), { marks: out.marks, idleWindow: out.idleWindow, port: PORT, mainPid: out.mainPid });
  out.authUnchanged = sha256(readFileSync(join(agent, "auth.json"))) === authHash;
  out.cwdStatus = execFileSync("git", ["status", "--porcelain", "--ignored"], { cwd, env: genv }).toString();
  // Keep the whole live dir as this side's evidence (the next side reuses the path).
  renameSync(LIVE, join(dir, "live"));
  return out;
}

// ---- disk snapshot ---------------------------------------------------------------------------------
function snapshot(root) {
  const files = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(root, p);
      if (rel === "tmp" || rel.startsWith("tmp/")) continue; // tsx's compile cache and uploads: checked via REST
      if (rel === "cwd/.git" || rel.startsWith("cwd/.git/")) continue; // git's own index timestamps
      const st = lstatSync(p);
      if (st.isSymbolicLink()) files[rel] = { link: readlinkSync(p) };
      else if (st.isDirectory()) walk(p);
      else files[rel] = { mode: (st.mode & 0o777).toString(8), path: p };
    }
  };
  walk(root);
  return files;
}

function readForCompare(file, norm, maskModel, chatPath) {
  const text = readFileSync(file, "utf8");
  // owned-writes.json records each owned session's size: for the live chat, that is the length of
  // what the model wrote.
  if (file.endsWith("/sova/owned-writes.json") && chatPath) {
    const doc = JSON.parse(text);
    if (doc[chatPath]?.size !== undefined) doc[chatPath].size = "<model-dependent>";
    return norm.value(doc);
  }
  // The live chat's own file and the live registry records carry the background outline (see
  // wsphase chatShape): dropped there, compared everywhere else.
  if (file.endsWith(".jsonl")) {
    const lines = text.split("\n").filter(Boolean).map((l) => { try { const v = norm.value(maskModel ? stripThinking(JSON.parse(l)) : JSON.parse(l)); return maskModel ? maskModelOutput(v) : v; } catch { return norm.text(l); } });
    return maskModel ? dropOutline(lines) : lines;
  }
  if (file.endsWith(".json")) try { const v = norm.value(JSON.parse(text)); return /\/sessions\/live\//.test(file) ? liveRecord(dropOutline(v)) : v; } catch {}
  if (/[\0]/.test(text)) return `<sha:${sha256(readFileSync(file))}>`;
  return norm.text(text);
}

/** A live-registry record: its activity histogram buckets by wall-clock time. */
function liveRecord(v) {
  if (v?.presence?.activity?.buckets) v.presence.activity.buckets = "<time-bucketed>";
  return v;
}

/** Every array sorted (by canonical form), recursively: for telling an order-only diff apart. */
function sortDeep(v) {
  if (Array.isArray(v)) return v.map(sortDeep).sort((x, y) => (canonical(x) < canonical(y) ? -1 : 1));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sortDeep(x)]));
  return v;
}

function readProbe(S) {
  try {
    return JSON.parse(readFileSync(join(RUN, S.side, "probe.json"), "utf8"));
  } catch {
    return null;
  }
}

// ---- comparison ------------------------------------------------------------------------------------
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const results = []; // { check, ok, detail, allowed? }
const record = (check, ok, detail = "") => results.push({ check, ok, detail });

function compareSides(A, B) {
  const runEnd = Date.now();
  // An hour either side: scheduled times (nextFetchAt) point minutes past the run; the fixtures sit in 2025.
  const window = [runStart - 3_600_000, runEnd + 3_600_000];
  const keepIds = new Set();
  for (const p of Object.values(A.fixtures ?? {})) for (const l of readFileSync(p.replace(LIVE, join(RUN, "base", "live")), "utf8").split("\n").filter(Boolean)) { const e = JSON.parse(l); if (e.id) keepIds.add(e.id); }
  const mk = (S) => makeNormalizer({ window, keepIds, literals: [[S.tree, "<TREE>"], [join(RUN, S.side, "live"), LIVE]] });

  // REST
  // A fresh normalizer per compared item: runtime ids are numbered within the item, so one extra id
  // early on cannot renumber (and fail) everything after it.
  if (A.rest && B.rest) {
    const len = Math.max(A.rest.length, B.rest.length);
    for (let i = 0; i < len; i++) {
      const a = A.rest[i], b = B.rest[i];
      const name = `rest:${a?.name ?? b?.name}`;
      if (!a || !b) { record(name, false, "missing on one side"); continue; }
      const va = mk(A).value({ status: a.status, type: a.type, body: a.body });
      const vb = mk(B).value({ status: b.status, type: b.type, body: b.body });
      const ok = canonical(va) === canonical(vb);
      record(name, ok, ok ? `${a.method} ${a.status}` : jsonDiff(va, vb).join("\n"));
      if (!ok && canonical(sortDeep(va)) === canonical(sortDeep(vb))) results.at(-1).orderOnly = true;
      if (ok && JSON.stringify(va) !== JSON.stringify(vb)) record(`${name}:key-order`, false, "same content, different key order");
    }
    const routes = serverRoutes(A.tree);
    const miss = uncoveredRoutes(routes, A.rest);
    record("rest:coverage(baseline routes)", miss.length === 0, miss.length ? miss.map((r) => `${r.method} ${r.path} (${r.file})`).join("\n") : `${routes.length} routes, all exercised`);
    const meshOnly = serverRoutes(B.tree).filter((r) => !routes.some((x) => x.method === r.method && x.path === r.path));
    results.push({ check: "info:mesh-only-routes", ok: true, info: true, detail: meshOnly.map((r) => `${r.method} ${r.path} (${r.file})`).join("\n") || "none" });
  }

  // WS watch + error paths
  if (A.watch && B.watch) {
    for (const k of new Set([...Object.keys(A.watch), ...Object.keys(B.watch)])) {
      const va = mk(A).value(A.watch[k]), vb = mk(B).value(B.watch[k]);
      const ok = canonical(va) === canonical(vb);
      record(`ws:${k}`, ok, ok ? `close ${JSON.stringify(A.watch[k]?.close)}` : jsonDiff(va, vb).join("\n"));
    }
  }

  // WS chat
  if (A.chat && B.chat) {
    record("chat:completed(base)", A.chat.completed === true, A.chat.completed ? "" : "baseline chat did not finish its script");
    record("chat:completed(mesh)", B.chat.completed === true, B.chat.completed ? "" : "mesh chat did not finish its script");
    const na = mk(A), nb = mk(B);
    const sa = chatShape(stripThinking(A.chat.msgs)), sb = chatShape(stripThinking(B.chat.msgs));
    const seqA = maskModelOutput(na.value({ created: A.chat.created, seq: sa.sequence, close: A.chat.close }));
    const seqB = maskModelOutput(nb.value({ created: B.chat.created, seq: sb.sequence, close: B.chat.close }));
    const ok = canonical(seqA) === canonical(seqB);
    record("chat:ordered-stream", ok, ok ? `${sa.sequence.length} messages` : jsonDiff(seqA, seqB).join("\n"));
    const endA = mk(A).value({ status: sa.status, workers: sa.workers }), endB = mk(B).value({ status: sb.status, workers: sb.workers });
    const okU = canonical(endA) === canonical(endB);
    record("chat:final-status", okU, okU ? Object.keys(sa.status).join(", ") : jsonDiff(endA, endB).join("\n"));
    results.push({ check: "info:chat-background-outline", ok: true, info: true, detail: `base: ${A.chat.outlineIdle ? "finished" : "unfinished"}, ${sa.background.length} traces\nmesh: ${B.chat.outlineIdle ? "finished" : "unfinished"}, ${sb.background.length} traces` });
    if (A.chatAfter && B.chatAfter) {
      for (let i = 0; i < A.chatAfter.length; i++) {
        const pick = (r) => stripThinking(dropOutline({ status: r.status, type: r.type, body: r.body }));
        const va = maskModelOutput(mk(A).value(pick(A.chatAfter[i]))), vb = maskModelOutput(mk(B).value(pick(B.chatAfter[i])));
        const okT = canonical(va) === canonical(vb);
        record(`chat:${A.chatAfter[i].name}`, okT, okT ? "" : jsonDiff(va, vb).join("\n"));
      }
    }
  }

  // proc
  if (A.proc && B.proc) {
    const eq = (k, a, b) => record(`proc:${k}`, canonical(a) === canonical(b), `base ${JSON.stringify(a)}\nmesh ${JSON.stringify(b)}`);
    eq("binds", A.proc.binds, B.proc.binds);
    eq("listen-calls", A.proc.listens, B.proc.listens);
    eq("listening-sockets(ss)", A.listening, B.listening);
    eq("unix-connects", A.proc.unix, B.proc.unix);
    eq("execs", A.proc.execs.map((e) => e.replace(A.tree, "<TREE>")), B.proc.execs.map((e) => e.replace(B.tree, "<TREE>")));
    for (const ph of new Set([...Object.keys(A.proc.connects), ...Object.keys(B.proc.connects)])) {
      const a = A.proc.connects[ph] ?? {}, b = B.proc.connects[ph] ?? {};
      // Which KINDS of connection (loopback:<port>, remote:<port>) per phase must match exactly; how
      // many is timing (the extension health probe's 10 s cache, the UI's polls, provider keep-alive).
      eq(`connects:${ph}(kinds)`, Object.keys(a).sort(), Object.keys(b).sort());
    }
    // Who created a timer / watcher / listener / outbound request (probe.mjs), by app source file.
    const pa = readProbe(A), pb = readProbe(B);
    if (pa && pb) {
      const onlyB = Object.keys(pb).filter((k) => !(k in pa));
      const onlyA = Object.keys(pa).filter((k) => !(k in pb));
      record("proc:creation-sites(new in mesh)", onlyB.length === 0, onlyB.length ? onlyB.map((k) => `${k} ×${pb[k]}`).join("\n") : `${Object.keys(pb).length} sites, none new`);
      record("proc:creation-sites(gone in mesh)", onlyA.length === 0, onlyA.map((k) => `${k} ×${pa[k]}`).join("\n"));
      const meshCode = Object.keys(pb).filter((k) => /server\/(mesh|sync)\//.test(k));
      record("proc:mesh-code-created-nothing", meshCode.length === 0, meshCode.join("\n") || "no timer, watcher, listener or request from server/mesh or server/sync");
    } else record("proc:creation-sites", false, `probe output missing: base ${!!pa}, mesh ${!!pb}`);
    record("proc:tailscale(base)", A.proc.tailscale.length === 0, A.proc.tailscale.slice(0, 5).join("\n"));
    record("proc:tailscale(mesh)", B.proc.tailscale.length === 0, B.proc.tailscale.slice(0, 5).join("\n"));
    const limit = Math.ceil(A.proc.idleWakeups * 1.5) + 10;
    record("proc:idle-wakeups", B.proc.idleWakeups <= limit, `base ${A.proc.idleWakeups}, mesh ${B.proc.idleWakeups} (limit ${limit}) over ${opt["idle-seconds"]}s`);
  }
  record("proc:graceful-shutdown(base)", A.gracefulStop !== false, "SIGTERM → exit within 10 s");
  record("proc:graceful-shutdown(mesh)", B.gracefulStop !== false, "SIGTERM → exit within 10 s");
  record("disk:auth.json-unchanged(base)", A.authUnchanged !== false);
  record("disk:auth.json-unchanged(mesh)", B.authUnchanged !== false);
  record("disk:fixture-cwd-untouched(base)", (A.cwdStatus ?? "") === "", A.cwdStatus);
  record("disk:fixture-cwd-untouched(mesh)", (B.cwdStatus ?? "") === "", B.cwdStatus);

  // disk
  if (has("disk") && existsSync(join(RUN, "base", "live")) && existsSync(join(RUN, "mesh", "live"))) {
    const ra = join(RUN, "base", "live"), rb = join(RUN, "mesh", "live");
    const fa = snapshot(ra), fb = snapshot(rb);
    const chatA = A.chat?.created?.body?.path, chatB = B.chat?.created?.body?.path;
    // Each file gets its OWN normalizer, so runtime-id numbering is file-local: numbering across
    // files would depend on the directory walk order, which the random ids themselves decide.
    const keyed = (files, S, chat, root) => {
      const m = new Map();
      for (const [rel, info] of Object.entries(files)) {
        const key = genericPath(rel, window);
        const n = mk(S);
        const isChat = chat && info.path === join(root, relative(LIVE, chat));
        const v = info.link ? { link: n.text(info.link) } : { mode: info.mode, content: readForCompare(info.path, n, isChat, chat) };
        if (!m.has(key)) m.set(key, []);
        m.get(key).push(v);
      }
      for (const list of m.values()) list.sort((x, y) => (canonical(x) < canonical(y) ? -1 : 1));
      return m;
    };
    const ka = keyed(fa, A, chatA, ra), kb = keyed(fb, B, chatB, rb);
    for (const k of [...new Set([...ka.keys(), ...kb.keys()])].sort()) {
      const a = ka.get(k), b = kb.get(k);
      if (!a || !b) { record(`disk:${k}`, false, a ? "only in baseline" : "only in mesh"); continue; }
      if (a.length !== b.length) { record(`disk:${k}`, false, `${a.length} file(s) in baseline, ${b.length} in mesh`); continue; }
      const i = a.findIndex((x, j) => canonical(x) !== canonical(b[j]));
      if (i >= 0) record(`disk:${k}`, false, jsonDiff(a[i], b[i]).join("\n"));
    }
    record("disk:files-compared", true, `${ka.size} base, ${kb.size} mesh`);
  }

  // screens
  if (A.screens && B.screens) {
    return (async () => {
      for (const [name] of screenList(A.fixtures)) {
        const a = A.screens[name], b = B.screens[name];
        if (a?.error || b?.error) { record(`screen:${name}`, false, `base: ${a?.error ?? "ok"}\nmesh: ${b?.error ?? "ok"}`); continue; }
        record(`screen:${name}:mesh-ui-count(base)`, a.meshUi === 0, `found ${a.meshUi}`);
        const want = expectMeshUi[name] ?? 0;
        record(`screen:${name}:mesh-ui-count(mesh)`, b.meshUi === want, `found ${b.meshUi}, expected ${want}`);
        const ta = mk(A).text(a.text), tb = mk(B).text(b.text);
        record(`screen:${name}:text`, ta === tb, ta === tb ? "" : textDiff(ta, tb));
        // Link targets in the tree are URL-encoded (#/s/%2Fhome%2F…): decode the slashes so the run
        // timestamps and ids inside them are normalized like everywhere else.
        const aa = mk(A).text((a.aria ?? "").replace(/%2F/gi, "/")), ab = mk(B).text((b.aria ?? "").replace(/%2F/gi, "/"));
        record(`screen:${name}:accessibility`, aa === ab, aa === ab ? "" : textDiff(aa, ab));
        const px = await comparePng(a.png, b.png, join(RUN, `diff-${name}.png`));
        record(`screen:${name}:pixels`, px.same, px.same ? "" : `${px.reason ?? `${px.diffPixels} px differ in box ${JSON.stringify(px.box)}`}; mask ${px.diffPath ?? ""}`);
      }
    })();
  }
}

function multisetDiff(a, b) {
  const count = (xs) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
  const ca = count(a), cb = count(b);
  const lines = [];
  for (const k of new Set([...ca.keys(), ...cb.keys()])) if ((ca.get(k) ?? 0) !== (cb.get(k) ?? 0)) lines.push(`${ca.get(k) ?? 0} vs ${cb.get(k) ?? 0}: ${k.slice(0, 200)}`);
  return lines.slice(0, 20).join("\n");
}

function textDiff(a, b) {
  const la = a.split("\n"), lb = b.split("\n");
  const out = [];
  for (let i = 0; i < Math.max(la.length, lb.length) && out.length < 12; i++) if (la[i] !== lb[i]) out.push(`line ${i + 1}: ${JSON.stringify(la[i])} !== ${JSON.stringify(lb[i])}`);
  return out.join("\n");
}

// ---- static: typecheck / build / tests ------------------------------------------------------------
function runTests(tree, side) {
  const dir = join(RUN, side);
  // A SHORT TMPDIR: tsx's IPC socket lives there, and a unix socket path over 107 bytes is EINVAL.
  const home = join(dir, "test-home"), tmp = join(opt.work, `tt-${side}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const env = sideEnv({ home, tmp });
  log(`${side}: typecheck`);
  const typecheck = pnpmRun(tree, "typecheck", env, join(dir, "typecheck.log"));
  log(`${side}: pnpm test`);
  const test = pnpmRun(tree, "test", env, join(dir, "test.log"));
  // node's spec reporter ("ℹ tests 1509", "✖ name (1.2ms)"); TAP ("# tests 1509", "not ok 3 - name") also read.
  const num = (k) => Number(new RegExp(`^(?:ℹ|#) ${k} (\\d+)`, "m").exec(test.output)?.[1] ?? NaN);
  const failed = [...new Set([...test.output.matchAll(/^\s*(?:✖ (.+?)(?: \([\d.]+m?s\))?|not ok \d+ - (.+))$/gm)].map((m) => (m[1] ?? m[2]).trim()))];
  // tsx's own compile cache and IPC dir are not a test's leftovers.
  const leftovers = readdirSync(tmp).filter((n) => !/^tsx-\d+$/.test(n));
  rmSync(tmp, { recursive: true, force: true });
  return { typecheck: typecheck.ok, test: { ok: test.ok, tests: num("tests"), pass: num("pass"), fail: num("fail"), failed, tmpLeftovers: leftovers } };
}

// ---- main ------------------------------------------------------------------------------------------
let browser = null;
const sides = {};
try {
  if (has("screens")) browser = await startBrowser();
  sides.base = await runSide("base", baseTree, browser?.browser);
  sides.mesh = await runSide("mesh", meshTree, browser?.browser);
} finally {
  await browser?.stop();
}
if (has("static")) {
  sides.base.static = runTests(baseTree, "base");
  sides.mesh.static = runTests(meshTree, "mesh");
  const A = sides.base.static, B = sides.mesh.static;
  record("static:build(base)", sides.base.build?.ok === true);
  record("static:build(mesh)", sides.mesh.build?.ok === true, sides.mesh.build?.ok ? "" : `see ${join(RUN, "mesh", "build.log")}`);
  record("static:typecheck(base)", A.typecheck);
  record("static:typecheck(mesh)", B.typecheck, B.typecheck ? "" : `see ${join(RUN, "mesh", "typecheck.log")}`);
  const newFails = B.test.failed.filter((t) => !A.test.failed.includes(t));
  record("static:tests(no new failures)", newFails.length === 0 && Number.isFinite(B.test.pass), `base ${A.test.pass}/${A.test.tests} pass, mesh ${B.test.pass}/${B.test.tests} pass${newFails.length ? `\nnew failures:\n${newFails.join("\n")}` : ""}`);
  record("static:tests(mesh count >= base)", B.test.tests >= A.test.tests, `base ${A.test.tests}, mesh ${B.test.tests}`);
  record("static:tests(all green, mesh)", B.test.ok, B.test.ok ? "" : `see ${join(RUN, "mesh", "test.log")}`);
  // mkdtemp's random 6-character suffix is not part of what a leftover IS.
  const stem = (n) => n.replace(/-[A-Za-z0-9]{6}$/, "");
  const newLeft = B.test.tmpLeftovers.filter((n) => !A.test.tmpLeftovers.some((a) => stem(a) === stem(n)));
  record("static:tests(no new tmp leftovers, mesh)", newLeft.length === 0, `baseline leaves ${A.test.tmpLeftovers.length}: ${A.test.tmpLeftovers.join(" ")}\nmesh leaves ${B.test.tmpLeftovers.length}: ${B.test.tmpLeftovers.join(" ")}`);
}
await compareSides(sides.base, sides.mesh);

// ---- allowed diffs + report ----------------------------------------------------------------------
const allowed = existsSync(join(import.meta.dirname, "allowed-diffs.json")) ? JSON.parse(readFileSync(join(import.meta.dirname, "allowed-diffs.json"), "utf8")) : [];
for (const r of results) {
  if (r.ok) continue;
  // An orderOnly allowance covers a diff that disappears once every array is sorted, nothing more.
  const a = allowed.find((x) => new RegExp(x.check).test(r.check) && (!x.orderOnly || r.orderOnly));
  if (a) r.allowed = a.reason;
}
const failed = results.filter((r) => !r.ok && !r.allowed);
const summary = {
  verdict: failed.length === 0 ? "PASS" : "FAIL",
  baseline: baseSha,
  mesh: opt.aa ? `A/A ${baseSha}` : meshSha,
  patch: opt.patch ?? null,
  phases: [...phases],
  run: RUN,
  counts: { checks: results.length, failed: failed.length, allowed: results.filter((r) => r.allowed).length },
};
writeFileSync(join(RUN, "report.json"), JSON.stringify({ summary, results, sides: stripForReport(sides) }, null, 1));
const md = [
  `# mesh parity: ${summary.verdict}`,
  "",
  `baseline \`${baseSha.slice(0, 10)}\` vs ${opt.aa ? "itself (A/A)" : `mesh \`${meshSha.slice(0, 10)}\``}${opt.patch ? ` + patch \`${opt.patch}\`` : ""}; phases ${[...phases].join(", ")}`,
  `${results.length} checks, ${failed.length} failed, ${summary.counts.allowed} allowed by allowed-diffs.json`,
  "",
  ...failed.map((r) => `## FAIL ${r.check}\n\n\`\`\`\n${r.detail}\n\`\`\``),
  ...results.filter((r) => r.allowed).map((r) => `## allowed ${r.check}: ${r.allowed}\n\n\`\`\`\n${r.detail}\n\`\`\``),
  "## passed",
  "",
  ...results.filter((r) => r.ok && !r.info).map((r) => `- ${r.check}${r.detail && !r.detail.includes("\n") ? ` — ${r.detail}` : ""}`),
  ...results.filter((r) => r.info).map((r) => `\n## ${r.check}\n\n\`\`\`\n${r.detail}\n\`\`\``),
].join("\n");
writeFileSync(join(RUN, "report.md"), md + "\n");
console.log(`${summary.verdict}: ${results.length} checks, ${failed.length} failed — ${join(RUN, "report.md")}`);
for (const r of failed.slice(0, 30)) console.log(`  FAIL ${r.check}\n    ${String(r.detail).split("\n").slice(0, 4).join("\n    ")}`);
process.exit(failed.length === 0 ? 0 : 1);

function stripForReport(s) {
  return JSON.parse(JSON.stringify(s, (k, v) => (k === "output" ? undefined : v)));
}
