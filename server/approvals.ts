import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ApprovalCounts, ApprovalFolder, ApprovalRow, ApprovalSource, ApprovalState, ContextFileRow, FolderApprovalsView } from "../shared/approvals";
import type { ProjectSkillRow } from "../shared/project-skills";
import { defaultClaudeDir } from "../pi-config/extensions/claude-code/accounts.ts";
import { checkoutOf, fileSha256, groupOf, itemKey, type ApprovalLookup, type FolderRef } from "./approvals-lookup";
import { askingFirst } from "./context-approval-setting";
import { skillFolderFingerprint, type Fingerprint } from "./skill-fingerprint";
import { keptRead, subfolderWalk, walkMark } from "./folder-walk";
import { measureFile, skillListingTokens } from "./file-measure";
import { folderResources } from "./harness/pi/resources";
import { piSkillsIn } from "./harness/pi/skill-sources";
import { real } from "./mcp/folder";
import { skillDescentAllowed } from "./skill-descent";
import { OrgError } from "./org-error";
import { folderMatcher } from "./project-folder";
import { dirFolderKey, folderDecisions, isItemKey, isSkillName, projectFolderKey, readApprovalStore, updateApprovalStore, type Decision, type ItemKind } from "./project-skills-store";
import { listProjects, readProject } from "./projects/spaces";
import { agentRoot } from "./state-root";

export * from "./approvals-lookup";
export { allowWithoutAsking, askingFirst, setAllowWithoutAsking } from "./context-approval-setting";

/**
 * The approval list's folder layer (shared/approvals.ts has the keys and rules): which folder a chat's
 * cwd belongs to, the bounded scan of everything a chat there could load (context files and skills,
 * the user's own and those above the project included), the views the cards draw, and the one write.
 * A decision on an item no longer found drops off, but only after a complete scan.
 */

const posix = (p: string) => p.split(sep).join("/");

// ---- the folder ---------------------------------------------------------------------------------------

/** The project a chat in `cwd` belongs to (its root, a folder inside it, or one of its worktrees), archived ones left out. */
export function projectForCwd(cwd: string): { id: string; name: string; root: string } | null {
  if (!cwd) return null;
  let projects;
  try {
    projects = listProjects().filter((p) => !p.archived);
  } catch {
    return null;
  }
  if (!projects.length) return null;
  const pid = folderMatcher(projects, agentRoot())(cwd);
  const p = pid ? projects.find((x) => x.id === pid) : undefined;
  return p ? { id: p.id, name: p.name, root: p.root } : null;
}

/** A project's folder. */
export function projectFolder(pid: string): FolderRef {
  const p = readProject(pid);
  return { key: projectFolderKey(p.id), kind: "project", projectId: p.id, name: p.name, root: real(p.root) };
}

/** The main checkout of a linked worktree (its `.git` file names its git dir, whose `commondir` is the main one's);
    `dir` itself for a main checkout or anything unreadable. */
function mainCheckoutOf(dir: string): string {
  try {
    const dotGit = join(dir, ".git");
    if (statSync(dotGit).isDirectory()) return dir;
    const gitDir = resolve(dir, /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim() ?? "");
    const common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
    return basename(common) === ".git" && existsSync(dirname(common)) ? real(dirname(common)) : dir;
  } catch {
    return dir;
  }
}

/** A folder that isn't a project: the nearest folder above `cwd` (itself included) holding `.git` (a linked
    worktree's main checkout, so the two share one list), stopping below the home folder and the file system's
    root; else `cwd` itself. Real paths. */
export function adHocRootOf(cwd: string): string {
  const start = real(resolve(cwd));
  const home = real(homedir());
  for (let dir = start; dir !== home && dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return mainCheckoutOf(dir);
  }
  return start;
}

export function folderForCwd(cwd: string): FolderRef {
  const p = projectForCwd(cwd);
  if (p) return { key: projectFolderKey(p.id), kind: "project", projectId: p.id, name: p.name, root: real(p.root) };
  const root = adHocRootOf(cwd);
  return { key: dirFolderKey(root), kind: "folder", name: basename(root) || root, root };
}

export const approvalFolderOf = (f: FolderRef): ApprovalFolder => (f.kind === "project" ? { kind: "project", id: f.projectId!, name: f.name } : { kind: "folder", path: f.root, name: f.name });

// ---- checkouts ---------------------------------------------------------------------------------------

export interface ScanDeps {
  loader?: typeof folderResources;
  /** The folder's checkouts (default: `git worktree list`); `complete: false` when they couldn't all be told. */
  checkouts?: (root: string) => Promise<{ dirs: string[]; complete: boolean }>;
  /** The subfolder walks' cap (default the deeper-context walk's). */
  cap?: number;
  /** Read pi's lists and walk the subfolders again now rather than answer from the checkout's last ones
      (server/folder-walk.ts): a save's scan, so it is judged against the folder as it is. */
  fresh?: boolean;
  /** The clock the kept walks are aged by (tests). */
  now?: () => number;
}

/** The root and each git worktree of it, by real path; incomplete when git couldn't answer. */
export function checkoutsOf(root: string): Promise<{ dirs: string[]; complete: boolean }> {
  const main = real(root);
  return new Promise((done) => {
    execFile("git", ["-C", root, "worktree", "list", "--porcelain"], { timeout: 5_000 }, (err, stdout) => {
      // Not a repository at all is a full answer (the root is the only checkout); any other failure is not.
      if (err) return done({ dirs: [main], complete: !existsSync(join(root, ".git")) });
      const all = stdout.split("\n").filter((l) => l.startsWith("worktree ")).map((l) => real(l.slice("worktree ".length)));
      done({ dirs: [...new Set([main, ...all])].filter(existsSync), complete: true });
    });
  });
}

const CHECKOUTS_TTL_MS = 5_000;
const checkoutsCache = new Map<string, { at: number; value: { dirs: string[]; complete: boolean } }>();

async function checkoutsFor(root: string, deps: ScanDeps): Promise<{ dirs: string[]; complete: boolean }> {
  const main = real(root);
  if (deps.checkouts) return deps.checkouts(root).catch(() => ({ dirs: [main], complete: false }));
  const hit = checkoutsCache.get(main);
  if (hit && Date.now() - hit.at < CHECKOUTS_TTL_MS) return hit.value;
  const value = await checkoutsOf(root).catch(() => ({ dirs: [main], complete: false }));
  checkoutsCache.set(main, { at: Date.now(), value });
  return value;
}

// ---- the scan ----------------------------------------------------------------------------------------

export interface ScanItem {
  kind: "context" | "skill";
  key: string;
  /** Absolute, the first copy found (the main checkout's before a worktree's). */
  path: string;
  name: string;
  group: ApprovalSource;
  folder?: string;
  description?: string;
  /** The item's fingerprint now ("" unreadable): a context file's bytes, a skill's whole folder (itemFingerprint). */
  sha256: string;
  /** A skill folder too large to fingerprint fully: its fingerprint is of the listing. */
  partial?: true;
  /** ≈ tokens a new chat carries for it: a context file's whole text, a skill's listing (name and description). */
  tokens?: number;
  /** A skill's whole SKILL.md, ≈ tokens: what using it loads. */
  fileTokens?: number;
  /** A skill only `/skill:name` runs (disable-model-invocation): never listed to the model, so its size is its whole file. */
  manualOnly?: true;
}

export interface FolderScan {
  folder: FolderRef;
  checkouts: string[];
  items: ScanItem[];
  /** Every checkout listed, every loader read and no walk stopped at its cap. */
  complete: boolean;
}

const shaOf = (p: string): string => {
  try {
    return fileSha256(readFileSync(p));
  } catch {
    return "";
  }
};

/** Where an item is: its folder's real path and its own name. A file that is a link (a SKILL.md shared from
    elsewhere, a CLAUDE.md pointing at AGENTS.md) is keyed where it sits, never by what it points at. Pass this,
    not a fully resolved path, to itemKey. */
export function placePath(p: string): string {
  return join(real(dirname(resolve(p))), basename(p));
}

/** An item's fingerprint now: a context file's sha256, a skill's whole folder (server/skill-fingerprint.ts). What an
    approval stores and the "Changed since you approved" check compares; "" when unreadable. */
export function itemFingerprint(kind: "context" | "skill", path: string): Fingerprint {
  return kind === "skill" ? skillFolderFingerprint(path) : { sha256: shaOf(path) };
}

/** The places groupOf tells apart, for a checkout. */
function placesFor(checkout: string) {
  return { checkout, agentDir: real(agentRoot()), home: real(homedir()), claudeDirs: [...new Set([real(defaultClaudeDir()), real(join(homedir(), ".claude"))])] };
}

/** "~/x" for a folder in the home folder, else the folder itself. */
const homeShort = (dir: string) => {
  const home = real(homedir());
  return dir === home ? "~" : (dir + sep).startsWith(home + sep) ? `~/${posix(relative(home, dir))}` : dir;
};

/**
 * Everything a chat in the folder could load at its start or meet in its folders: for each checkout (the root
 * first), pi's own context files (pi's settings folder's, then the checkout's and every folder above it) and
 * skills, and the subfolder walk's instruction files and skills, each walk bounded as the deeper-context walk is.
 * One row per key, the first found. pi's lists and the subfolder walks are kept per checkout and read again in the
 * background (server/folder-walk.ts has the freshness rule; `deps.fresh` reads them now). No subfolder walk for a folder whose chats don't look below it (server/skill-descent.ts:
 * a plain folder, the home folder or above); a project's walks, a chat anywhere inside it may, unless its root is the
 * home folder or above it.
 */
export async function folderQuickScan(where: string | FolderRef, deps: ScanDeps = {}): Promise<FolderScan> {
  const folder = typeof where === "string" ? folderForCwd(where) : where;
  const main = folder.root;
  // When what this scan read was found: its start, or the oldest kept read it took.
  let readFrom = walkMark();
  const listed = await checkoutsFor(main, deps);
  let complete = listed.complete;
  const checkouts = listed.dirs.includes(main) ? listed.dirs : [main, ...listed.dirs];
  const lookup = { checkouts };
  const out = new Map<string, ScanItem>();
  const descends = skillDescentAllowed(main, { home: homedir(), inProject: folder.kind === "project" });
  const add = (kind: ScanItem["kind"], abs: string, checkout: string, extra: { name?: string; description?: string; dir?: string; manualOnly?: boolean } = {}) => {
    const path = placePath(abs);
    const key = itemKey(lookup, path);
    const id = `${kind}\0${key}`;
    if (out.has(id)) return;
    const holder = checkoutOf(checkouts, path) ?? checkout;
    const group = groupOf(kind, path, placesFor(holder));
    let folderName: string | undefined;
    if (group === "subfolder") folderName = posix(relative(main, extra.dir ?? dirname(path)));
    else if (group === "project" && holder !== main) folderName = posix(relative(main, holder));
    else if (group === "above") folderName = homeShort(dirname(path));
    const description = extra.description?.trim();
    const fp = itemFingerprint(kind, path);
    const whole = measureFile(path)?.tokens;
    const name = extra.name ?? basename(path);
    // A skill carries its listing until used; a manual-only one is never listed, so it costs its whole file.
    const sizes =
      kind === "skill" && extra.manualOnly ? { manualOnly: true as const, ...(whole !== undefined ? { tokens: whole, fileTokens: whole } : {}) }
      : kind === "skill" ? { tokens: skillListingTokens(name, description, path), ...(whole !== undefined ? { fileTokens: whole } : {}) }
      : whole !== undefined ? { tokens: whole } : {};
    out.set(id, { kind, key, path, name, group, ...(folderName ? { folder: folderName } : {}), ...(description ? { description } : {}), sha256: fp.sha256, ...(fp.partial ? { partial: true as const } : {}), ...sizes });
  };
  for (const checkout of checkouts) {
    const top = checkout === main ? main : checkout;
    try {
      const agentDir = agentRoot();
      const kept = await keptRead(`pi\0${agentDir}\0${top}`, () => (deps.loader ?? folderResources)(top, agentDir), { serial: true, ...(deps.fresh ? { fresh: true } : {}), ...(deps.now ? { now: deps.now } : {}) });
      readFrom = Math.min(readFrom, kept.seq);
      const res = kept.value;
      for (const c of res.context) add("context", c.path, checkout);
      for (const s of res.skills) add("skill", s.filePath, checkout, { name: s.name, description: s.description, manualOnly: s.manualOnly });
      // A skill another of the same name shadows is a row of its own: told by its place, never by its name.
      for (const p of res.skillProblems ?? []) if (p.reason === "same-name") add("skill", p.path, checkout, { name: p.name });
    } catch {
      complete = false;
    }
    if (!descends) continue;
    const walk = await subfolderWalk(top, { read: piSkillsIn, ...(deps.cap !== undefined ? { cap: deps.cap } : {}), ...(deps.fresh ? { fresh: true } : {}), ...(deps.now ? { now: deps.now } : {}) });
    readFrom = Math.min(readFrom, walk.seq);
    if (walk.incomplete) complete = false;
    for (const f of walk.files) add("context", f.abs, checkout, { dir: join(top, f.dir) });
    for (const s of walk.skills) add("skill", s.filePath, checkout, { name: s.name, description: s.description, dir: join(top, s.dir), manualOnly: s.manualOnly });
  }
  const scan: FolderScan = { folder, checkouts, items: [...out.values()], complete };
  settleAfterScan(scan, readFrom);
  keptScans.set(folder.key, scan);
  return scan;
}

/** Each folder's latest scan, what a save resolves its keys against (scanForSave): no walk, no pi read. */
const keptScans = new Map<string, FolderScan>();

/** The folder's latest scan (a save's answer is drawn from it), or a scan now when there is none yet. */
export async function keptScanFor(folder: FolderRef, deps: ScanDeps = {}): Promise<FolderScan> {
  return keptScans.get(folder.key) ?? folderQuickScan(folder, deps);
}

/** Tests: forget every kept scan. */
export function forgetKeptScansForTest(): void {
  keptScans.clear();
}

/** Each folder's latest decision write, by walkMark: a scan that read anything found before it drops nothing. */
const decidedAt = new Map<string, number>();

/**
 * What a scan settles in the store: version 1's name-keyed Disallowed skills go to the first skill found of that
 * name, and, after a complete scan, decisions on items no longer
 * found drop off (with the names no skill has). Writes only when something changes. A scan that read a walk (or
 * began) before the folder's latest decision write drops no decision: what it lacks may be what was just decided.
 */
function settleAfterScan(scan: FolderScan, readFrom: number): void {
  const d = folderDecisions(scan.folder.key);
  const found = { context: new Set<string>(), skills: new Set<string>() };
  for (const i of scan.items) found[i.kind === "context" ? "context" : "skills"].add(i.key);
  const legacy = Object.entries(d.legacySkills ?? {});
  const drops = scan.complete && readFrom > (decidedAt.get(scan.folder.key) ?? 0);
  const goneContext = drops ? Object.keys(d.context).filter((k) => !found.context.has(k)) : [];
  const goneSkills = drops ? Object.keys(d.skills).filter((k) => !found.skills.has(k)) : [];
  if (!legacy.length && !goneContext.length && !goneSkills.length) return;
  updateApprovalStore((s) => {
    const f = s.folders[scan.folder.key];
    if (!f) return;
    for (const k of goneContext) delete f.context[k];
    for (const k of goneSkills) delete f.skills[k];
    for (const [name, state] of legacy) {
      const item = scan.items.find((i) => i.kind === "skill" && i.name === name);
      if (item) {
        if (!f.skills[item.key]) f.skills[item.key] = { state, name };
        delete f.legacySkills?.[name];
      } else if (scan.complete) delete f.legacySkills?.[name];
    }
  });
}

// ---- the lookup a build reads ---------------------------------------------------------------------------

/** The list for a chat in `cwd`, as plain data: its folder, the setting now, its checkouts and decisions. */
export async function approvalLookupForCwd(cwd: string, deps: ScanDeps = {}): Promise<ApprovalLookup> {
  const folder = folderForCwd(cwd);
  // Decisions still by name (version 1) need the scan that gives them keys.
  if (Object.keys(readApprovalStore().folders[folder.key]?.legacySkills ?? {}).length) await folderQuickScan(folder, deps);
  const { dirs } = await checkoutsFor(folder.root, deps);
  const d = folderDecisions(folder.key);
  return { folder, asking: askingFirst(), checkouts: dirs.includes(folder.root) ? dirs : [folder.root, ...dirs], context: d.context, skills: d.skills };
}

// ---- views --------------------------------------------------------------------------------------------

const zero = (): ApprovalCounts => ({ approved: 0, disallowed: 0, waiting: 0, changed: 0 });

function rowOf(i: ScanItem, d: Decision | undefined, counts: ApprovalCounts): ApprovalRow {
  const state: ApprovalState = d?.state ?? "waiting";
  // An approval matches only the content it was given for; one with no fingerprint matches nothing.
  const changed = state === "approved" && d?.sha256 !== i.sha256;
  counts[state]++;
  if (changed) counts.changed++;
  return { key: i.key, path: i.path, name: i.name, source: i.folder ? { kind: i.group, folder: i.folder } : { kind: i.group }, state, ...(changed ? { changed: true as const } : {}), ...(i.partial ? { fingerprintPartial: true as const } : {}), ...(i.tokens !== undefined ? { tokens: i.tokens } : {}), ...(i.fileTokens !== undefined ? { fileTokens: i.fileTokens } : {}), ...(i.manualOnly ? { manualOnly: true as const } : {}) };
}

const byPlace = (a: ApprovalRow, b: ApprovalRow) => {
  const order: ApprovalSource[] = ["project", "subfolder", "above", "user", "claude"];
  return order.indexOf(a.source.kind) - order.indexOf(b.source.kind) || a.name.localeCompare(b.name) || a.key.localeCompare(b.key);
};

/** Rows and counts from a scan and the folder's decisions. Pure but for the store read. */
export function viewOfScan(scan: FolderScan): FolderApprovalsView & { fileCounts: ApprovalCounts; skillCounts: ApprovalCounts } {
  const d = folderDecisions(scan.folder.key);
  const fileCounts = zero();
  const skillCounts = zero();
  const files: ContextFileRow[] = [];
  const skills: ProjectSkillRow[] = [];
  for (const i of scan.items) {
    if (i.kind === "context") files.push(rowOf(i, d.context[i.key], fileCounts));
    else skills.push({ ...rowOf(i, d.skills[i.key], skillCounts), ...(i.description ? { description: i.description } : {}) });
  }
  files.sort(byPlace);
  skills.sort((a, b) => a.name.localeCompare(b.name) || byPlace(a, b));
  const counts = zero();
  for (const k of Object.keys(counts) as (keyof ApprovalCounts)[]) counts[k] = fileCounts[k] + skillCounts[k];
  return { folder: { key: scan.folder.key, kind: scan.folder.kind, ...(scan.folder.projectId ? { projectId: scan.folder.projectId } : {}), name: scan.folder.name, root: scan.folder.root }, asking: askingFirst(), files, skills, counts, complete: scan.complete, fileCounts, skillCounts };
}

/** GET /api/folder-approvals: both lists of the folder a chat in `cwd` runs in. */
export async function folderApprovalsView(where: string | FolderRef, deps: ScanDeps = {}): Promise<FolderApprovalsView> {
  const { fileCounts: _f, skillCounts: _s, ...view } = viewOfScan(await folderQuickScan(where, deps));
  return view;
}

// ---- the write ----------------------------------------------------------------------------------------

export interface ApprovalChanges {
  context: Record<string, ApprovalState>;
  skills: Record<string, ApprovalState>;
}

const isApprovalState = (v: unknown): v is ApprovalState => v === "approved" || v === "disallowed" || v === "waiting";

/** One list of a body, strictly: `{<key>: "approved" | "disallowed" | "waiting"}`; skills may name a skill by name. */
export function parseItemChanges(v: unknown, kind: ItemKind, what: string): Record<string, ApprovalState> {
  const bad = () => new OrgError(`Expected { ${what}: { <key>: "approved" | "disallowed" | "waiting" } }`);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad();
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 1000) throw bad();
  const out: Record<string, ApprovalState> = {};
  for (const [k, s] of entries) {
    if (!(isItemKey(k) || (kind === "skills" && isSkillName(k))) || !isApprovalState(s)) throw bad();
    out[k] = s;
  }
  return out;
}

/** The changes, each by a found item's key: a bare skill name is the first skill of that name. Unknown items:
    a 404 after a complete scan; saved as given after a partial one ("waiting" is always taken). */
export function resolveChanges(scan: FolderScan, changes: ApprovalChanges): ApprovalChanges {
  const out: ApprovalChanges = { context: {}, skills: {} };
  const unknown: string[] = [];
  for (const kind of ["context", "skills"] as const) {
    const items = scan.items.filter((i) => (i.kind === "context") === (kind === "context"));
    const keys = new Set(items.map((i) => i.key));
    for (const [k, s] of Object.entries(changes[kind])) {
      const key = keys.has(k) ? k : kind === "skills" ? (items.find((i) => i.name === k)?.key ?? k) : k;
      if (!keys.has(key) && s !== "waiting" && (scan.complete || !isItemKey(key))) unknown.push(k);
      else out[kind][key] = s;
    }
  }
  if (unknown.length) throw new OrgError(`Nothing named ${unknown.map((n) => `"${n}"`).join(", ")} is found in ${scan.folder.name}.`, 404);
  return out;
}

/** Whether any change approves (Re-approve included) or turns a disallowed item back on: the operator's page only.
    Judge changes resolveChanges made (by key): a bare name is no key, and a name's own decision is found only by name. */
export function changesNeedPage(folderKey: string, changes: ApprovalChanges): boolean {
  const d = folderDecisions(folderKey);
  for (const kind of ["context", "skills"] as const) {
    for (const [k, s] of Object.entries(changes[kind])) {
      if (s === "approved") return true;
      const was = d[kind][k]?.state ?? (kind === "skills" ? d.legacySkills?.[k] : undefined);
      if (was === "disallowed" && s !== "disallowed") return true;
    }
  }
  return false;
}

export interface ApprovalWrite {
  scan: FolderScan;
  /** By kind and key, what each was before and is now, for those that changed (a Re-approve counts). */
  changed: { kind: ItemKind; key: string; name: string; from: ApprovalState; to: ApprovalState }[];
  /** A group save's (WriteOptions.group, something changed) Undo token: the latest per folder (undoFolderApprovals). */
  undo?: string;
}

/** Whether a key named in `changes` (or a skill by its name) is one of the scan's items. */
function scanHas(scan: FolderScan, changes: ApprovalChanges): boolean {
  for (const kind of ["context", "skills"] as const) {
    const items = scan.items.filter((i) => (i.kind === "context") === (kind === "context"));
    for (const k of Object.keys(changes[kind])) if (!items.some((i) => i.key === k || (kind === "skills" && i.name === k))) return false;
  }
  return true;
}

/**
 * The scan a save is resolved and judged against: the folder's kept one (its latest scan, no walk and no pi read)
 * when it holds every key the save names, else one fresh scan (a key it lacks may be an item that just appeared).
 * What an approval stores is read again at the write (itemFingerprint), never taken from the scan.
 */
export async function scanForSave(folder: FolderRef, changes: ApprovalChanges, deps: ScanDeps = {}): Promise<FolderScan> {
  const kept = await keptScanFor(folder, deps);
  return scanHas(kept, changes) ? kept : folderQuickScan(folder, { ...deps, fresh: true });
}

/** On for a new chat: approved always, waiting only without asking first, disallowed never. */
const onFor = (state: ApprovalState, asking: boolean) => state === "approved" || (state === "waiting" && !asking);

const sameDecision = (a: Decision | undefined, b: Decision | undefined) => (!a && !b) || (!!a && !!b && a.state === b.state && a.sha256 === b.sha256 && a.name === b.name);

/** One key's records around a group save: what it was, and what the save wrote (undefined: no record, waiting). */
export interface UndoItem {
  kind: ItemKind;
  key: string;
  name: string;
  before?: Decision;
  wrote?: Decision;
}
/** The latest save of each group switch of each folder (by `<folder key>\0<group id>`), with its token: kept in memory
    only, so a restart forgets it. A newer save of the same group takes its place; another group's never does. */
const undoSaves = new Map<string, { token: string; items: UndoItem[] }>();
const undoSlot = (folder: FolderRef, group: string) => `${folder.key}\0${group}`;
/** How many groups' Undo a folder keeps (the oldest goes first). */
export const UNDO_SLOTS = 32;
/** The slot and save a token names in a folder, or null when it is no group's latest there. */
function savedFor(folder: FolderRef, token: string): { slot: string; token: string; items: UndoItem[] } | null {
  const prefix = `${folder.key}\0`;
  for (const [slot, saved] of undoSaves) if (slot.startsWith(prefix) && saved.token === token) return { slot, ...saved };
  return null;
}

export const UNDO_GONE = "Undo is no longer available. Nothing was changed.";

/** What an Undo would restore: for each key of that save whose record is still what it wrote, its record before
    (verbatim), and the states that means, for changesNeedPage. Null for a token that isn't its group's latest save. */
export interface UndoPlan {
  token: string;
  changes: ApprovalChanges;
  items: UndoItem[];
  kept: number;
}
export function undoPlan(folder: FolderRef, token: string): UndoPlan | null {
  const saved = savedFor(folder, token);
  if (!saved) return null;
  const d = folderDecisions(folder.key);
  const changes: ApprovalChanges = { context: {}, skills: {} };
  const items: UndoItem[] = [];
  for (const i of saved.items) {
    if (!sameDecision(d[i.kind][i.key], i.wrote)) continue;
    items.push(i);
    changes[i.kind][i.key] = i.before?.state ?? "waiting";
  }
  return { token, changes, items, kept: saved.items.length - items.length };
}

/**
 * Undo a group save: each key whose record is still what that save wrote gets its record from before it back,
 * exactly (an approval with the fingerprint it had, so a change made since is never accepted by it); the others
 * are left as they are. The caller has judged the plan's changes (changesNeedPage). A 409 for a token that isn't its
 * group's latest save in the folder (a newer save of that group, a restart, used already).
 */
export async function undoFolderApprovals(folder: FolderRef, token: string, judged?: UndoPlan): Promise<{ changed: ApprovalWrite["changed"]; undone: number; kept: number }> {
  // The plan its caller judged (who may: changesNeedPage), so nothing it didn't judge is restored; still its group's latest.
  const saved = savedFor(folder, token);
  const plan = saved ? (judged?.token === token ? judged : undoPlan(folder, token)) : null;
  if (!saved || !plan) throw new OrgError(UNDO_GONE, 409, "undo-gone");
  undoSaves.delete(saved.slot);
  const asking = askingFirst();
  const changed: ApprovalWrite["changed"] = [];
  let undone = 0;
  let flips = false;
  decidedAt.set(folder.key, walkMark());
  updateApprovalStore((s) => {
    const f = (s.folders[folder.key] ??= { context: {}, skills: {} });
    for (const i of plan.items) {
      // Judged on the plan: anything written since leaves the key as it is.
      if (!sameDecision(f[i.kind][i.key], i.wrote)) continue;
      if (i.before) f[i.kind][i.key] = { ...i.before };
      else delete f[i.kind][i.key];
      undone++;
      const from: ApprovalState = i.wrote?.state ?? "waiting";
      const to: ApprovalState = i.before?.state ?? "waiting";
      if (from !== to || i.wrote?.sha256 !== i.before?.sha256) changed.push({ kind: i.kind, key: i.key, name: i.name, from, to });
      if (onFor(from, asking) !== onFor(to, asking)) flips = true;
    }
  });
  await tellNewChats(folder.key, flips);
  return { changed, undone, kept: plan.kept + (plan.items.length - undone) };
}

/** After a write: the folder's chats not yet started are rebuilt when an item's on/off changed, else only told. */
async function tellNewChats(folderKey: string, rebuild: boolean): Promise<void> {
  try {
    await (await import("./projects/skills-chats")).notifySetupChanged(folderKey, { rebuild });
  } catch (err) {
    console.warn(`[approvals] telling ${folderKey}'s new chats failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface WriteOptions {
  /** The scan to resolve against (the route's, already judged); default scanForSave. */
  scan?: FolderScan;
  /** A group switch's save (its caller says so: `group: "<group id>"`, or `true` for the group its lists name): an
      item already approved is left as it is, so a Changed one's fingerprint is never rewritten unseen; and when it
      changed anything it answers an Undo token, that group's latest in the folder. */
  group?: boolean | string;
}

/**
 * The one write, item by item: resolve the changes against the folder's kept scan (scanForSave: a fresh scan only
 * for a key it lacks), fingerprint the items turned on now, save them at once (an approval with that fingerprint,
 * a skill with its name), then tell the folder's chats not yet started: rebuilt when an item's on/off changed,
 * else only told to read again. The caller has already checked who may make them (changesNeedPage).
 */
export async function writeFolderApprovals(folder: FolderRef, raw: ApprovalChanges, deps: ScanDeps = {}, opts: WriteOptions = {}): Promise<ApprovalWrite> {
  const scan = opts.scan ?? (await scanForSave(folder, raw, deps));
  const resolved = resolveChanges(scan, raw);
  const before = folderDecisions(folder.key);
  const changes: ApprovalChanges = { context: {}, skills: {} };
  for (const kind of ["context", "skills"] as const)
    for (const [key, to] of Object.entries(resolved[kind])) if (!(opts.group && to === "approved" && before[kind][key]?.state === "approved")) changes[kind][key] = to;
  const itemOf = (kind: ItemKind, key: string) => scan.items.find((i) => (i.kind === "context") === (kind === "context") && i.key === key);
  // An approval is of the content it is given for, read now: an item the scan didn't find, or that can't be read, can't be approved.
  const prints = new Map<string, string>();
  for (const kind of ["context", "skills"] as const) {
    for (const [key, to] of Object.entries(changes[kind])) {
      if (to !== "approved") continue;
      const item = itemOf(kind, key);
      const sha = item ? itemFingerprint(item.kind, item.path).sha256 : "";
      if (!sha) throw new OrgError(`${key} can't be approved: ${item ? "it couldn't be read" : "it wasn't found"}. Nothing was changed.`, 409);
      prints.set(`${kind}\0${key}`, sha);
    }
  }
  const asking = askingFirst();
  const changed: ApprovalWrite["changed"] = [];
  const undo: UndoItem[] = [];
  let flips = false;
  decidedAt.set(folder.key, walkMark());
  updateApprovalStore((s) => {
    const f = (s.folders[folder.key] ??= { context: {}, skills: {} });
    for (const kind of ["context", "skills"] as const) {
      for (const [key, to] of Object.entries(changes[kind])) {
        const item = itemOf(kind, key);
        const prev = f[kind][key] ? { ...f[kind][key] } : undefined;
        const from: ApprovalState = prev?.state ?? "waiting";
        const name = item?.name ?? prev?.name ?? basename(key);
        const sha = prints.get(`${kind}\0${key}`);
        if (to === "waiting") delete f[kind][key];
        else f[kind][key] = { state: to, ...(sha ? { sha256: sha } : {}), ...(kind === "skills" && isSkillName(name) ? { name } : {}) };
        const wrote = f[kind][key] ? { ...f[kind][key] } : undefined;
        if (sameDecision(prev, wrote)) continue;
        undo.push({ kind, key, name, ...(prev ? { before: prev } : {}), ...(wrote ? { wrote } : {}) });
        const reapproved = to === "approved" && from === "approved" && prev?.sha256 !== sha;
        if (from !== to || reapproved) changed.push({ kind, key, name, from, to });
        if (onFor(from, asking) !== onFor(to, asking)) flips = true;
      }
    }
  });
  // What the save's answer is drawn from: the scan, with the fingerprints just read for what it approved.
  const after: FolderScan = prints.size ? { ...scan, items: scan.items.map((i) => { const sha = prints.get(`${i.kind === "context" ? "context" : "skills"}\0${i.key}`); return sha ? { ...i, sha256: sha } : i; }) } : scan;
  if (prints.size && keptScans.get(folder.key) === scan) keptScans.set(folder.key, after);
  let token: string | undefined;
  if (opts.group && undo.length) {
    token = randomUUID();
    const named = (["context", "skills"] as const).filter((k) => Object.keys(resolved[k]).length);
    const group = typeof opts.group === "string" ? opts.group : named.length === 1 ? named[0]! : "both";
    const slot = undoSlot(folder, group);
    undoSaves.delete(slot); // a newer save of the group goes to the end: the newest are kept
    undoSaves.set(slot, { token, items: undo });
    // A group id is the caller's word, and a turn-off is anyone's: a folder keeps its UNDO_SLOTS newest groups.
    const prefix = `${folder.key}\0`;
    const mine = [...undoSaves.keys()].filter((k) => k.startsWith(prefix));
    for (const k of mine.slice(0, Math.max(0, mine.length - UNDO_SLOTS))) undoSaves.delete(k);
  }
  await tellNewChats(folder.key, flips);
  return { scan: after, changed, ...(token ? { undo: token } : {}) };
}
