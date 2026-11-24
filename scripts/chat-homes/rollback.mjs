#!/usr/bin/env node
// One-command rollback from chat homes to master's layout (docs: scripts/chat-homes/README.md):
//   node scripts/chat-homes/rollback.mjs [--dry-run] [--no-backup] [--backup-out <folder>]
//   node scripts/chat-homes/rollback.mjs --from-backup <backup folder>
//
// Default: converts in place, keeping every chat, the ones made on the branch included.
//   1. takes a backup first (backup.mjs), unless --no-backup;
//   2. undoes compression: each <file>.jsonl.gz back to <file>.jsonl, each compressed home unpacked
//      back into its folder, every file checked against the sha256 recorded when it was compressed;
//   3. puts each homed chat where master lists it: every conversation in <agent>/sessions/--<cwd>--/
//      by its own header's cwd, its records merged into master's stores, its workers, team
//      mailboxes, wakes, memory, attachments, cards, offers and shared folder in master's places,
//      every path that named the home rewritten to the new place;
//   4. moves each emptied home to <homes root>/.rolled-back/<id> (nothing is deleted).
// --from-backup instead puts the backup's agent dir, homes and shared folders back exactly, moving
// what is there now aside to <path>.before-restore-<timestamp> (nothing is deleted).
// Then: run master's code (it prints how). Refuses while pi or Sova runs on the agent dir.
import { closeSync, createReadStream, createWriteStream, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { backup } from "./backup.mjs";
import { agentDir, checkoutInfo, cwdSessionsDir, exists, homesRoot, liveProcesses, parseArgs, runningSova, sha256File, sharedBase, stateRootOf, tar } from "./lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

/** Written atomically, keeping the file's own mode (a new file: 0600, as drafts must be). */
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(file).mode & 0o777;
  } catch {
    // new file
  }
  const tmp = `${file}.rollback-${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  renameSync(tmp, file);
}

/** Moves `from` to `to` (a rename, else copy + remove for another filesystem); never over an existing `to`. */
function move(from, to) {
  if (exists(to)) throw new Error(`${to} already exists; nothing was moved over it`);
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    if (err?.code !== "EXDEV") throw err;
    tar(["-cf", `${to}.rollback.tar`, "-C", dirname(from), basename(from)]);
    mkdirSync(dirname(to), { recursive: true });
    tar(["-xf", `${to}.rollback.tar`, "-C", dirname(to)]);
    rmSync(`${to}.rollback.tar`);
    if (basename(from) !== basename(to)) renameSync(join(dirname(to), basename(from)), to);
    rmSync(from, { recursive: true, force: true });
  }
}

/** Moves every entry of folder `from` into folder `to` (merging folders, never overwriting a file). */
function mergeInto(from, to, report) {
  if (!exists(from)) return;
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, e.name);
    const dst = join(to, e.name);
    if (e.isDirectory() && exists(dst)) mergeInto(src, dst, report);
    else if (exists(dst)) report.kept.push(`${src} (master already has ${dst})`);
    else move(src, dst);
  }
}

async function gunzipTo(gz, out) {
  const tmp = `${out}.rollback-${process.pid}.tmp`;
  await pipeline(createReadStream(gz), createGunzip(), createWriteStream(tmp));
  return tmp;
}

// ---- step 2: undo compression ------------------------------------------------------------------

async function uncompress({ state, homes, dry, report }) {
  const storeFile = join(state, "compressed-sessions.json");
  const store = readJson(storeFile, { v: 1, chats: {} });
  const entries = { ...(store.chats ?? {}) };
  // A compressed home's own record beside it covers a store that is gone.
  if (exists(homes))
    for (const n of readdirSync(homes)) {
      if (!n.endsWith(".compressed.json")) continue;
      const e = readJson(join(homes, n), null);
      if (e?.id && !entries[e.id]) entries[e.id] = e;
    }
  /** A chat restored here (now or by an earlier run) leaves the store at once: a rerun after a problem
      elsewhere never reports it again. */
  const drop = (id) => {
    if (dry || !exists(storeFile)) return;
    const cur = readJson(storeFile, null);
    if (!cur?.chats?.[id]) return;
    delete cur.chats[id];
    writeJson(storeFile, cur);
  };
  const kept = join(homes, ".rolled-back");
  const restoredAlready = async (e) => {
    if (e.kind === "files") return (e.files ?? []).length > 0 && e.files.every((f) => exists(f.path) && !exists(f.gz));
    const archive = e.archive ?? join(homes, `${e.id}.tar.gz`);
    const aside = join(kept, `${e.id}.tar.gz`);
    return !exists(archive) && exists(aside) && (!e.archiveSha256 || (await sha256File(aside)) === e.archiveSha256);
  };
  for (const e of Object.values(entries)) {
    if (await restoredAlready(e)) {
      drop(e.id);
      continue;
    }
    const problemsBefore = report.problems.length;
    const keptBefore = report.kept.length;
    if (e.kind === "files") {
      for (const f of e.files ?? []) {
        if (exists(f.path) && !exists(f.gz)) continue; // done already
        if (exists(f.path)) {
          report.kept.push(`${f.gz} (its original ${f.path} is there too)`);
          continue;
        }
        if (!exists(f.gz)) {
          report.problems.push(`${f.gz} is missing: chat ${e.id} can't be uncompressed`);
          continue;
        }
        if (dry) {
          report.uncompressed.push(f.path);
          continue;
        }
        const tmp = await gunzipTo(f.gz, f.path);
        if ((await sha256File(tmp)) !== f.sha256) {
          rmSync(tmp, { force: true });
          report.problems.push(`${f.gz} doesn't match what was compressed; left as it is`);
          continue;
        }
        renameSync(tmp, f.path);
        rmSync(f.gz);
        report.uncompressed.push(f.path);
      }
    } else if (e.kind === "home") {
      const archive = e.archive ?? join(homes, `${e.id}.tar.gz`);
      const home = join(homes, e.id);
      if (exists(home) && !exists(archive)) continue;
      if (!exists(archive)) {
        report.problems.push(`${archive} is missing: chat ${e.id} can't be uncompressed`);
        continue;
      }
      if (exists(home)) {
        report.kept.push(`${archive} (its home ${home} is there too)`);
        continue;
      }
      if (dry) {
        report.uncompressed.push(home);
        continue;
      }
      // The compressed file is checked against the sha256 recorded when it was made, before anything unpacks it.
      if (e.archiveSha256 && (await sha256File(archive)) !== e.archiveSha256) {
        report.problems.push(`${archive} doesn't match what was compressed; left as it is`);
        continue;
      }
      const staging = join(homes, `.rollback-${e.id}`);
      rmSync(staging, { recursive: true, force: true });
      mkdirSync(staging, { recursive: true });
      try {
        tar(["-xzf", archive, "-C", staging]);
      } catch (err) {
        rmSync(staging, { recursive: true, force: true });
        report.problems.push(`${archive} couldn't be unpacked (${String(err?.stderr ?? err?.message ?? err).trim().split("\n")[0]}); left as it is`);
        continue;
      }
      if (!exists(join(staging, "home.json")) && !exists(join(staging, "sessions"))) {
        rmSync(staging, { recursive: true, force: true });
        report.problems.push(`${archive} unpacked to no home; left as it is`);
        continue;
      }
      renameSync(staging, home);
      // The compressed file is kept aside, never deleted.
      mkdirSync(join(homes, ".rolled-back"), { recursive: true });
      renameSync(archive, join(homes, ".rolled-back", `${e.id}.tar.gz`));
      const side = join(homes, `${e.id}.compressed.json`);
      if (exists(side)) renameSync(side, join(homes, ".rolled-back", `${e.id}.compressed.json`));
      report.uncompressed.push(home);
    }
    if (!dry && report.problems.length === problemsBefore && report.kept.length === keptBefore) drop(e.id);
  }
  if (!dry && exists(storeFile) && report.problems.length === 0) renameSync(storeFile, `${storeFile}.rolled-back`);
}

// ---- step 3: homes back to master's places -----------------------------------------------------

/** Each master store a home's records feed, as master creates it when it doesn't exist yet
    (homes-state's table: master's loaders drop a file without its version). */
const EMPTY = {
  "session-titles.json": () => ({ version: 2, titles: {} }),
  "sova-chat-names.json": () => ({ version: 1, names: {} }),
  "session-aliases.json": () => ({ version: 1, aliases: {} }),
  "session-tags.json": () => ({ version: 1, sessions: {} }),
  "archived-sessions.json": () => [],
  "web-sessions.json": () => [],
  "seen.json": () => ({}),
  "drafts.json": () => ({ version: 1, drafts: {} }),
  "signals.json": () => ({ version: 1, sessions: {}, workers: {}, stalls: {} }),
  "turn-outcomes.json": () => ({ version: 1, sessions: {} }),
  "worker-checks.json": () => ({ version: 1, checks: {} }),
  "align-triage.json": () => ({ version: 1, cards: {} }),
  "merge-followups.json": () => ({ cards: {} }),
};

/** A home's record doc merged into master's stores (homes-state's rule: "<file>#<map>" merges into that
    map of <state>/<file>; a bare "<file>" is that file's top-level array, unioned, or map, merged). */
function mergeDoc(state, doc, dry, report) {
  for (const [key, value] of Object.entries(doc ?? {})) {
    if (key === "version" || key === "id" || value === null || value === undefined) continue;
    const [file, map] = key.split("#");
    if (!file.endsWith(".json") || file.includes("/") || file.includes("..")) continue;
    const target = join(state, file);
    let cur = readJson(target, undefined);
    if (file === "session-groups.json") {
      // Kept only into an existing file, and only for a group it still has: with no groups there is nothing to join.
      if (!cur || !Array.isArray(cur.groups)) continue;
      const ids = new Set(cur.groups.map((g) => g?.id));
      const kept = Object.fromEntries(Object.entries(value).filter(([, a]) => ids.has(typeof a === "string" ? a : a?.groupId ?? a?.id)));
      if (Object.keys(kept).length === 0) continue;
      cur = { ...cur, assignments: { ...(cur.assignments ?? {}), ...kept } };
      report.records.add(file);
      if (!dry) writeJson(target, cur);
      continue;
    }
    if (cur === undefined) cur = EMPTY[file]?.() ?? (Array.isArray(value) ? [] : {});
    let next;
    if (map) {
      const base = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
      next = { ...base, [map]: { ...(base[map] ?? {}), ...value } };
    } else if (Array.isArray(value)) {
      const base = Array.isArray(cur) ? cur : [];
      next = [...new Set([...base, ...value])];
    } else if (typeof value === "object") {
      const base = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {};
      next = { ...base };
      // seen.json: the newer stamp wins.
      for (const [k, v] of Object.entries(value)) next[k] = typeof v === "number" && typeof next[k] === "number" ? Math.max(v, next[k]) : v;
    } else continue;
    report.records.add(file);
    if (!dry) writeJson(target, next);
  }
}

/** A worker record no longer names a home: the env a homed chat's processes got is dropped. */
function unhomeWorkerRecord(file) {
  const rec = readJson(file, null);
  const env = rec?.spec?.env;
  if (!env || typeof env !== "object") return;
  if (!("SOVA_CHAT_HOME" in env) && !("SOVA_CHAT_HOMES_ROOT" in env)) return;
  delete env.SOVA_CHAT_HOME;
  delete env.SOVA_CHAT_HOMES_ROOT;
  writeJson(file, rec);
}

function rewritePaths(file, pathMap) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  let out = text;
  for (const [from, to] of pathMap) if (out.includes(from)) out = out.split(from).join(to);
  if (out === text) return false;
  const tmp = `${file}.rollback-${process.pid}.tmp`;
  writeFileSync(tmp, out, { mode: statSync(file).mode & 0o777 });
  renameSync(tmp, file);
  return true;
}

/** The session header (the file's first line), read from its first 256 KB only. */
function headerOf(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString("utf8");
    const nl = text.indexOf("\n");
    const h = JSON.parse(nl >= 0 ? text.slice(0, nl) : text);
    return h && h.type === "session" ? h : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Every move a rollback makes, and every path it rewrites, written down before the first move
 * (`<homes>/.rollback-journal.json`): a run cut short (^C, a full disk) and run again still rewrites
 * the paths of what the first run already moved. Retired only once the rewrite is done.
 */
const journalFile = (homes) => join(homes, ".rollback-journal.json");

function loadJournal(homes) {
  const j = readJson(journalFile(homes), null);
  return j && j.v === 1 && Array.isArray(j.paths) ? j : { v: 1, paths: [], moves: [], workers: [], homes: [] };
}

/** What one home's rollback does: its conversations' moves and every path into it, read from the home as it is. */
function planHome({ agent, state, homes, shared, id, report }) {
  const home = join(homes, id);
  const moves = [];
  const paths = [];
  const sessions = join(home, "sessions");
  if (exists(sessions))
    for (const n of readdirSync(sessions)) {
      if (!n.endsWith(".jsonl")) continue;
      const from = join(sessions, n);
      const h = headerOf(from);
      if (!h?.cwd) {
        report.problems.push(`${from} has no readable session header; left in its home`);
        continue;
      }
      const to = join(cwdSessionsDir(agent, h.cwd), n);
      moves.push([from, to]);
      paths.push([from, to]);
    }
  // Every place a path into the home may name (worker records, wake nudges, conversations' image links).
  paths.push([join(home, "shared"), join(shared, id)]);
  paths.push([`${join(home, "chat", "attachments")}/`, `${join(state, "attachments", id)}/`]);
  paths.push([`${join(home, "chat", "memory")}/`, `${join(state, "memory")}/`]);
  if (exists(join(home, "teams"))) for (const lead of readdirSync(join(home, "teams"))) paths.push([join(home, "teams", lead), join(state, "teams", lead, "mailbox")]);
  const workers = exists(join(home, "workers")) ? readdirSync(join(home, "workers")).filter((w) => w.endsWith(".json")).map((w) => join(state, "chats", "workers", w)) : [];
  return { moves, paths, workers };
}

async function unhome({ agent, state, homes, shared, dry, report, hooks = {} }) {
  if (!exists(homes)) return;
  const ids = readdirSync(homes, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .filter((id) => exists(join(homes, id, "home.json")));
  // 1. The plan of every home, added to what an earlier run wrote down, saved before anything moves.
  const journal = loadJournal(homes);
  const seenPath = new Set(journal.paths.map(([f]) => f));
  const addUnique = (list, items, key = (x) => x) => {
    const have = new Set(list.map(key));
    for (const x of items) if (!have.has(key(x))) list.push(x);
  };
  for (const id of ids) {
    const plan = planHome({ agent, state, homes, shared, id, report });
    for (const pair of plan.paths) if (!seenPath.has(pair[0])) {
      journal.paths.push(pair);
      seenPath.add(pair[0]);
    }
    addUnique(journal.moves, plan.moves, ([f]) => f);
    addUnique(journal.workers, plan.workers);
    addUnique(journal.homes, [id]);
  }
  if (dry) {
    for (const [, to] of journal.moves) report.sessions.push(to);
    report.homes.push(...ids);
    for (const id of ids) for (const doc of ["meta", "seen", "draft", "signals"]) mergeDoc(state, readJson(join(homes, id, "chat", `${doc}.json`), null), true, report);
    return;
  }
  if (journal.moves.length || journal.homes.length) writeJson(journalFile(homes), journal);
  // 2. The moves (one already made by an earlier run is passed over) and the records.
  for (const [from, to] of journal.moves) {
    if (exists(from)) move(from, to);
    if (exists(to)) report.sessions.push(to);
  }
  hooks.afterMoves?.();
  for (const id of ids) {
    const home = join(homes, id);
    for (const doc of ["meta", "seen", "draft", "signals"]) mergeDoc(state, readJson(join(home, "chat", `${doc}.json`), null), false, report);
    const chat = join(home, "chat");
    mergeInto(join(chat, "attachments"), join(state, "attachments", id), report);
    mergeInto(join(chat, "memory"), join(state, "memory"), report);
    mergeInto(join(chat, "offers"), join(state, "session-offers"), report);
    mergeInto(join(chat, "cards"), join(state, "session-cards"), report);
    mergeInto(join(home, "workers"), join(state, "chats", "workers"), report);
    if (exists(join(home, "teams")))
      for (const lead of readdirSync(join(home, "teams"))) mergeInto(join(home, "teams", lead), join(state, "teams", lead, "mailbox"), report);
    mergeInto(join(home, "wakes"), join(state, "wake-nudges"), report);
    mergeInto(join(home, "shared"), join(shared, id), report);
    hooks.afterHome?.(id);
  }
  report.homes.push(...journal.homes);
  // 3. Every path that named a home now names its new place, from the whole journal: in the moved
  // conversations (a worker's completion names its file), the worker records and Sova's other stores.
  const pathMap = new Map(journal.paths);
  const rewrite = journal.moves.map(([, to]) => to).filter((to) => exists(to));
  const walk = (d, depth) => {
    if (!exists(d) || depth > 3) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "attachments" && e.name !== "memory") walk(p, depth + 1);
      } else if (e.name.endsWith(".json")) rewrite.push(p);
    }
  };
  walk(state, 0);
  for (const f of rewrite) if (rewritePaths(f, pathMap)) report.rewritten++;
  for (const f of journal.workers) if (exists(f)) unhomeWorkerRecord(f);
  // 4. The emptied homes are kept aside, never deleted; then the journal is retired.
  for (const id of journal.homes) {
    const home = join(homes, id);
    if (exists(home)) move(home, join(homes, ".rolled-back", id));
  }
  if (exists(journalFile(homes))) renameSync(journalFile(homes), join(homes, `.rollback-journal.done-${Date.now()}.json`));
}

// ---- --from-backup ------------------------------------------------------------------------------

async function restore(from, { dry, log }) {
  const manifest = readJson(join(from, "backup.json"), null);
  if (!manifest || manifest.v !== 1) throw new Error(`${from} holds no backup record (backup.json).`);
  for (const p of manifest.parts) {
    const file = join(from, p.name);
    if ((await sha256File(file)) !== p.sha256) throw new Error(`${file} doesn't match its manifest; nothing was restored.`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  // Each place the backup knew: restored from its part, or, when it had none (nothing there then),
  // whatever is there now is moved aside, so the install is exactly as backed up.
  const places = [manifest.agentDir, manifest.homesRoot, manifest.sharedBase].filter(Boolean);
  for (const target of places) {
    const p = manifest.parts.find((x) => x.from === target);
    if (dry) {
      log(p ? `would restore ${target} from ${p.name}` : exists(target) ? `would move ${target} aside (the backup had none)` : `${target}: nothing to do`);
      continue;
    }
    if (exists(target)) {
      renameSync(target, `${target}.before-restore-${stamp}`);
      log(`moved ${target} aside to ${target}.before-restore-${stamp}`);
    }
    if (!p) continue;
    mkdirSync(dirname(target), { recursive: true });
    tar(["-xzf", join(from, p.name), "-C", dirname(target)]);
    log(`restored ${target}`);
  }
}

// ---- main ---------------------------------------------------------------------------------------

export async function rollback({ dryRun = false, noBackup = false, allowRunning = false, backupOut, fromBackup, env = process.env, log = console.log, hooks } = {}) {
  const agent = agentDir(env);
  const running = [...liveProcesses(agent).map((r) => `pi (pid ${r.pid})`), ...(await runningSova(agent))];
  if (running.length && !allowRunning)
    throw new Error(`Still running on ${agent}: ${running.join(", ")}. Stop Sova, then its chats (bun scripts/stop-chats.ts --agent-dir ${agent}), first; --allow-running goes ahead anyway, only when you are sure nothing runs.`);
  if (fromBackup) {
    await restore(fromBackup, { dry: dryRun, log });
    return null;
  }
  if (!dryRun && !noBackup) await backup({ out: backupOut, env, log, allowRunning });
  const state = stateRootOf(agent);
  const homes = homesRoot(agent, env);
  const shared = sharedBase(env);
  const report = { uncompressed: [], sessions: [], homes: [], records: new Set(), rewritten: 0, kept: [], problems: [] };
  await uncompress({ state, homes, dry: dryRun, report });
  await unhome({ agent, state, homes, shared, dry: dryRun, report, hooks });
  const did = dryRun ? "Would" : "Done:";
  log(`${did} uncompress ${report.uncompressed.length} chats, move ${report.sessions.length} conversations out of ${report.homes.length} homes, merge records into ${[...report.records].join(", ") || "no stores"}${dryRun ? "" : `, rewrite paths in ${report.rewritten} files`}.`);
  for (const k of report.kept) log(`kept as it was: ${k}`);
  for (const p of report.problems) log(`PROBLEM: ${p}`);
  const sova = checkoutInfo(here);
  if (!dryRun)
    log(`Now run master's code${sova ? ` (this checkout: git -C ${sova.root} switch master, then restart Sova)` : ", then restart Sova"}. Homes moved aside are in ${join(homes, ".rolled-back")}.`);
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const a = parseArgs(process.argv.slice(2), { "dry-run": "flag", "no-backup": "flag", "allow-running": "flag", "backup-out": "value", "from-backup": "value" });
    const r = await rollback({ dryRun: !!a["dry-run"], noBackup: !!a["no-backup"], allowRunning: !!a["allow-running"], backupOut: a["backup-out"], fromBackup: a["from-backup"] });
    if (r && r.problems.length) process.exit(2);
  } catch (err) {
    console.error(`rollback: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
