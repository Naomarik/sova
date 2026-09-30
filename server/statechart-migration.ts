// The one-time move of an org's statechart data from the old names to the new ones
// (§app.organizations/statechart-migration). Run before the org's engine opens and before its
// journal replays; after it, nothing reads an old name.
//
// - the workspace's `charts/` → `statecharts/`, committed as one move in the workspace repo;
// - the host-local `<stateRoot>/org-charts/<org>/` → `<stateRoot>/statecharts/<org>/`;
// - inside them: log rows (`chart` → `statechart`, the actor "chart" → "statechart"), snapshot EDN
//   (the engine's old namespaced keys, `:chart`, the actor) and pending journals (the same, plus
//   their file paths).
//
// Markerless and resumable: each file is rewritten in place (atomically, before its folder moves;
// a rewritten file maps to itself), each folder moves by one rename, and the move is committed
// while the repo still tracks `charts/`. Both an old and a new name present: refuse, never overwrite.
import { existsSync, readdirSync, readFileSync, renameSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { writeAtomic } from "./org-host/store";
import { commitPaths, tracks } from "./workspace-git";

// Old names, for this migration only.
const OLD_WORKSPACE = "charts";
const OLD_HOST_LOCAL = "org-charts";
const OLD_ACTOR = "chart";
const OLD_ROW_FIELD = "chart";
/** Keyword renames in snapshot EDN, whole keywords (without the leading colon). */
const OLD_KEYWORDS: Record<string, string> = {
  chart: "statechart",
  "chart-key": "statechart-key",
};
/** The same keys in rows (the data a row mirrors, e.g. `sova/children` entries), camelCased at the bundle. */
const OLD_JSON_KEYS: Record<string, string> = { chartKey: "statechartKey" };
/** Namespace renames, longest first: in EDN keywords, and in a row's keys and string values (an event
    name, a changed path) and an EDN string that is such a name. */
const OLD_NAMESPACES: [string, string][] = [
  ["sova.org-charts.charts.", "sova.statecharts."],
  ["sova.org-charts.", "sova.statecharts."],
  ["sova.charts/", "sova.statecharts/"],
];

function renameName(s: string): string {
  for (const [from, to] of OLD_NAMESPACES) if (s.startsWith(from)) return to + s.slice(from.length);
  return s;
}

export const WORKSPACE_DIR = "statecharts";
export const HOST_LOCAL_DIR = "statecharts";
export const MIGRATION_MESSAGE = "Statecharts: charts/ is statecharts/";

export class StatechartMigrationError extends Error {
  override name = "StatechartMigrationError";
}

const both = (a: string, b: string) =>
  new StatechartMigrationError(`Both ${a} and ${b} exist: Sova moves the old one to the new name once and never overwrites. Keep one of them and restart.`);

// ---------------------------------------------------------------------------------------------
// EDN

function renameKeyword(kw: string): string {
  // kw: the keyword's text after its colon(s)
  return OLD_KEYWORDS[kw] ?? renameName(kw);
}

const DELIM = /[\s,()[\]{}";]/;

/** Snapshot EDN with the old keys and the old actor renamed. Strings, chars and comments are copied
    as they are, except the string "chart" right after a `:by` key and a string that is an old name. A migrated text maps to itself. */
export function migrateEdn(text: string): string {
  let out = "";
  let afterBy = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (/[\s,]/.test(c)) {
      out += c;
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const tok = text.slice(i, j + 1);
      out += afterBy && tok === `"${OLD_ACTOR}"` ? '"statechart"' : `"${renameName(tok.slice(1, -1))}"`;
      afterBy = tok === '"by"';
      i = j + 1;
      continue;
    }
    if (c === ";") {
      const j = text.indexOf("\n", i);
      const end = j < 0 ? text.length : j;
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (c === "\\") {
      // a char literal: the backslash, one char, then any word chars (\newline, A)
      let j = i + 2;
      while (j < text.length && /[A-Za-z0-9]/.test(text[j]!) && /[A-Za-z]/.test(text[i + 1] ?? "")) j++;
      out += text.slice(i, j);
      afterBy = false;
      i = j;
      continue;
    }
    if (c === ":") {
      let j = i + 1;
      if (text[j] === ":") j++;
      const start = j;
      while (j < text.length && !DELIM.test(text[j]!)) j++;
      const kw = text.slice(start, j);
      out += text.slice(i, start) + renameKeyword(kw);
      afterBy = kw === "by";
      i = j;
      continue;
    }
    out += c;
    if (!"#".includes(c)) afterBy = false;
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Log rows and journals

function renameActor(v: unknown): unknown {
  if (typeof v === "string") return renameName(v);
  if (Array.isArray(v)) return v.map(renameActor);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[OLD_KEYWORDS[k] ?? OLD_JSON_KEYS[k] ?? renameName(k)] = k === "by" && x === OLD_ACTOR ? "statechart" : renameActor(x);
  return out;
}

/** A log row with `chart` → `statechart` (in place, same key order), every actor "chart" → "statechart"
    and every old namespaced name renamed. */
export function migrateRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k === OLD_ROW_FIELD ? "statechart" : k] = k === "by" && v === OLD_ACTOR ? "statechart" : renameActor(v);
  return out;
}

function migrateLogText(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.trim()) return line;
      try {
        return JSON.stringify(migrateRow(JSON.parse(line) as Record<string, unknown>));
      } catch {
        return line; // not a row: left as it is (the reader reports it)
      }
    })
    .join("\n");
}

interface Places {
  workspaceDir: string;
  stateDir: string;
  orgId: string;
}

/** A journal file path after the folders move. */
export function movedPath(file: string, p: Places): string {
  const ws = join(p.workspaceDir, OLD_WORKSPACE) + "/";
  if (file.startsWith(ws)) return join(p.workspaceDir, WORKSPACE_DIR) + "/" + file.slice(ws.length);
  const local = join(p.stateDir, OLD_HOST_LOCAL, p.orgId) + "/";
  if (file.startsWith(local)) return join(p.stateDir, HOST_LOCAL_DIR, p.orgId) + "/" + file.slice(local.length);
  return file;
}

function migrateJournalText(text: string, p: Places): string {
  const j = JSON.parse(text) as { snapshots?: { file: string; text: string }[]; rows?: { file: string; row: Record<string, unknown> }[] };
  for (const s of j.snapshots ?? []) {
    s.file = movedPath(s.file, p);
    s.text = migrateEdn(s.text);
  }
  for (const r of j.rows ?? []) {
    r.file = movedPath(r.file, p);
    r.row = migrateRow(r.row);
  }
  return JSON.stringify(j);
}

/** Rewrite every file under `root` that holds an old name: `.edn` snapshots, `log/*.jsonl`, `journal/*.json`. */
function rewriteTree(root: string, p: Places): number {
  let n = 0;
  const walk = (dir: string, top: string | null) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, e.name);
      if (e.isDirectory()) {
        walk(file, top ?? e.name);
        continue;
      }
      if (!e.isFile() || e.name.includes(".tmp")) continue;
      const text = readFileSync(file, "utf8");
      let next = text;
      if (e.name.endsWith(".edn")) next = migrateEdn(text);
      else if (top === "log" && e.name.endsWith(".jsonl")) next = migrateLogText(text);
      else if (top === "journal" && e.name.endsWith(".json")) next = migrateJournalText(text, p);
      if (next !== text) {
        writeAtomic(file, next, true);
        n++;
      }
    }
  };
  walk(root, null);
  return n;
}

// ---------------------------------------------------------------------------------------------
// The steps

export interface MigrationOutcome {
  /** What moved, e.g. "charts/ → statecharts/". Empty: nothing was under an old name. */
  moved: string[];
  rewritten: number;
  committed: boolean;
}

/** The workspace step: `charts/` → `statecharts/`, committed. Needs no org id (an attach runs it first). */
export async function migrateWorkspace(workspaceDir: string): Promise<MigrationOutcome> {
  const out: MigrationOutcome = { moved: [], rewritten: 0, committed: false };
  const from = join(workspaceDir, OLD_WORKSPACE);
  const to = join(workspaceDir, WORKSPACE_DIR);
  if (existsSync(from)) {
    if (existsSync(to)) throw both(from, to);
    out.rewritten += rewriteTree(from, { workspaceDir, stateDir: "", orgId: "" });
    renameSync(from, to);
    out.moved.push(`${OLD_WORKSPACE}/ → ${WORKSPACE_DIR}/`);
  }
  // A move made but not committed yet (this run, or one cut short after its rename).
  if (existsSync(to) && (await tracks(workspaceDir, OLD_WORKSPACE))) {
    await commitPaths(workspaceDir, [OLD_WORKSPACE, WORKSPACE_DIR], MIGRATION_MESSAGE);
    out.committed = true;
  }
  return out;
}

/** The host-local step: `<stateDir>/org-charts/<org>` → `<stateDir>/statecharts/<org>`, its journals'
    paths following both moves. */
export function migrateHostLocal(orgId: string, workspaceDir: string, stateDir: string): MigrationOutcome {
  const out: MigrationOutcome = { moved: [], rewritten: 0, committed: false };
  const parent = join(stateDir, OLD_HOST_LOCAL);
  const from = join(parent, orgId);
  const to = join(stateDir, HOST_LOCAL_DIR, orgId);
  if (!existsSync(from)) return out;
  if (existsSync(to)) throw both(from, to);
  out.rewritten += rewriteTree(from, { workspaceDir, stateDir, orgId });
  writeAtomic(join(to, ".moving"), "", false); // makes the parent; removed below
  rmdirSafe(to, ".moving");
  renameSync(from, to);
  out.moved.push(`${OLD_HOST_LOCAL}/${orgId}/ → ${HOST_LOCAL_DIR}/${orgId}/`);
  try {
    if (readdirSync(parent).length === 0) rmdirSync(parent);
  } catch {}
  return out;
}

function rmdirSafe(dir: string, marker: string): void {
  renameSync(join(dir, marker), join(dir, "..", `.${marker}-${process.pid}`));
  rmdirSync(dir);
  try {
    readdirSync(join(dir, "..")).includes(`.${marker}-${process.pid}`) && rmFile(join(dir, "..", `.${marker}-${process.pid}`));
  } catch {}
}

function rmFile(file: string): void {
  require("node:fs").rmSync(file, { force: true });
}

/** Both steps for one org; each conflict is checked before anything changes. */
export async function migrateOrg(orgId: string, workspaceDir: string, stateDir: string): Promise<MigrationOutcome> {
  const pairs: [string, string][] = [
    [join(workspaceDir, OLD_WORKSPACE), join(workspaceDir, WORKSPACE_DIR)],
    [join(stateDir, OLD_HOST_LOCAL, orgId), join(stateDir, HOST_LOCAL_DIR, orgId)],
  ];
  for (const [a, b] of pairs) if (existsSync(a) && existsSync(b)) throw both(a, b);
  const local = migrateHostLocal(orgId, workspaceDir, stateDir);
  const ws = await migrateWorkspace(workspaceDir);
  const out = { moved: [...ws.moved, ...local.moved], rewritten: ws.rewritten + local.rewritten, committed: ws.committed };
  if (out.moved.length || out.committed) console.log(`[statecharts] ${orgId}: moved ${out.moved.join(", ") || "nothing"}; ${out.rewritten} file(s) rewritten${out.committed ? "; committed" : ""}`);
  return out;
}
