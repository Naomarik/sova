#!/usr/bin/env node
// One-shot cleanup: remove the residence statechart's empty minute looks from the host-local transition
// logs (`<stateRoot>/statecharts/<org>/log/<yyyy-mm>.jsonl`). Before the look was timed for the moment a
// workspace commit is due, every minute's `commit/look` that found nothing due was saved and logged
// (one row a minute, an org's log growing ~10 MB a month). Those rows record nothing: same states
// before and after, nothing changed, no effect. Every other row is kept byte for byte, in order.
//
// A row is removed only when ALL hold: statechart "residence", event "commit/look", `before` equal to
// `after` (ending in "clean" or "dirty"), `changed` empty, `effects` empty, not refused, not held.
// Lines that don't parse are kept.
//
//   node scripts/prune-org-look-rows.mjs --state-dir <dir> [--write] [--backup-dir <dir>]
//
// --state-dir: Sova's state root (its `statecharts/` is used) or that `statecharts/` dir itself.
// Default: a dry run printing each log file's size and row count before and after. --write: first copy
// every file it will change into the backup dir (default `~/.cache/sova-statechart-log-backup-<date>/`,
// refused if it exists), then rewrite each file atomically (temp file in the same dir, fsync, rename).
// The live server appends to the current month's file: rows appended while a file is rewritten are
// read again before the rename and kept (filtered the same way).
// Node builtins only; it never touches snapshots, journals or the workspace repos.
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function usage(msg) {
  if (msg) console.error(msg);
  console.error("usage: node scripts/prune-org-look-rows.mjs --state-dir <dir> [--write] [--backup-dir <dir>]");
  process.exit(2);
}

function parseArgs(argv) {
  const o = { write: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") o.write = true;
    else if (a === "--state-dir" || a === "--backup-dir") {
      const v = argv[++i];
      if (!v) usage(`${a} needs a value`);
      o[a === "--state-dir" ? "stateDir" : "backupDir"] = v;
    } else if (a === "-h" || a === "--help") usage();
    else usage(`unknown argument: ${a}`);
  }
  if (!o.stateDir) usage("--state-dir is required");
  return o;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const empty = (v) => v == null || (Array.isArray(v) ? v.length === 0 : typeof v === "object" && Object.keys(v).length === 0);

/** An empty minute look: the residence's `commit/look` that found nothing due. */
export function isEmptyLook(row) {
  if (!row || typeof row !== "object") return false;
  if (row.statechart !== "residence" || row.event !== "commit/look") return false;
  if (!Array.isArray(row.before) || !same(row.before, row.after)) return false;
  const last = row.after[row.after.length - 1];
  if (last !== "clean" && last !== "dirty") return false;
  if (!empty(row.changed) || !empty(row.effects)) return false;
  if (row.refused || row.held) return false;
  return true;
}

/** Filter complete lines (text ending at a newline): [kept text, rows in, rows kept]. */
export function filterText(text) {
  let kept = "", rows = 0, keptRows = 0;
  for (const line of text.split("\n")) {
    if (line === "") continue;
    rows++;
    let row = null;
    try { row = JSON.parse(line); } catch { /* kept as is */ }
    if (row && isEmptyLook(row)) continue;
    kept += line + "\n";
    keptRows++;
  }
  return [kept, rows, keptRows];
}

function logFiles(root) {
  const out = [];
  for (const d of readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const log = join(root, d.name, "log");
    if (!existsSync(log)) continue;
    for (const f of readdirSync(log).sort()) if (/^\d{4}-\d{2}\.jsonl$/.test(f)) out.push(join(log, f));
  }
  return out.sort();
}

function readFrom(file, start) {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const buf = Buffer.alloc(Math.max(0, size - start));
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally { closeSync(fd); }
}

/** Bytes up to the last newline (a torn last line is never cut or rewritten). */
function completePart(buf) {
  const end = buf.lastIndexOf(0x0a) + 1;
  return [buf.subarray(0, end), buf.length - end];
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Rewrite `file` atomically with its empty looks removed, catching up on rows appended meanwhile. */
function rewrite(file) {
  const tmp = join(dirname(file), `.${process.pid}.prune.tmp`);
  const mode = statSync(file).mode & 0o777;
  const fd = openSync(tmp, "wx", mode);
  let read = 0, rows = 0, kept = 0, bytes = 0;
  try {
    for (let attempt = 0; ; attempt++) {
      const [part, torn] = completePart(readFrom(file, read));
      const [text, r, k] = filterText(part.toString("utf8"));
      const out = Buffer.from(text, "utf8");
      writeSync(fd, out);
      read += part.length; rows += r; kept += k; bytes += out.length;
      const size = statSync(file).size;
      if (size === read && torn === 0) break;
      if (attempt > 200) throw new Error(`${file} keeps changing (or ends in a torn line); left untouched`);
      if (size === read + torn) sleep(20); // a writer mid-line: give it a moment
    }
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    unlinkSync(tmp);
    throw e;
  }
  closeSync(fd);
  if (statSync(file).size !== read) { unlinkSync(tmp); throw new Error(`${file} changed during the rename; left untouched, run again`); }
  renameSync(tmp, file);
  const dfd = openSync(dirname(file), "r");
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
  return { rows, kept, bytes };
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const root = existsSync(join(o.stateDir, "statecharts")) && statSync(join(o.stateDir, "statecharts")).isDirectory()
    ? join(o.stateDir, "statecharts") : o.stateDir;
  if (!existsSync(root)) usage(`no such dir: ${root}`);
  const files = logFiles(root);
  console.log(`${o.write ? "Rewriting" : "Dry run (nothing written)"}: ${files.length} log file(s) under ${root}`);
  const plan = [];
  let tb = 0, ta = 0, tr = 0, tk = 0;
  for (const f of files) {
    const buf = readFileSync(f);
    const [part, torn] = completePart(buf);
    const [text, rows, kept] = filterText(part.toString("utf8"));
    const after = Buffer.byteLength(text, "utf8") + torn;
    tb += buf.length; ta += after; tr += rows; tk += kept;
    console.log(`${relative(root, f)}  ${buf.length} B, ${rows} rows -> ${after} B, ${kept} rows  (${rows - kept} empty looks)${torn ? `  [torn last line: ${torn} B kept]` : ""}`);
    if (kept !== rows) plan.push(f);
  }
  console.log(`total  ${tb} B, ${tr} rows -> ${ta} B, ${tk} rows  (${tr - tk} empty looks removed, ${plan.length} file(s) change)`);
  if (!o.write || !plan.length) return;

  const date = new Date().toISOString().slice(0, 10);
  const backup = o.backupDir ?? join(homedir(), ".cache", `sova-statechart-log-backup-${date}`);
  if (existsSync(backup)) usage(`backup dir exists, refusing to overwrite it: ${backup}`);
  for (const f of plan) {
    const to = join(backup, relative(root, f));
    mkdirSync(dirname(to), { recursive: true });
    const size = statSync(f).size;
    copyFileSync(f, to);
    if (statSync(to).size < size) throw new Error(`backup of ${f} is short; nothing rewritten`);
  }
  console.log(`backed up ${plan.length} file(s) to ${backup}`);
  for (const f of plan) {
    const r = rewrite(f);
    console.log(`rewrote ${relative(root, f)}: ${r.rows} rows -> ${r.kept} rows, ${r.bytes} B`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
