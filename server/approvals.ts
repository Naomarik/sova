import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ApprovalCounts, ApprovalFolder, ApprovalRow, ApprovalSource, ApprovalState, ContextFileRow, FolderApprovalsView } from "../shared/approvals";
import type { ProjectSkillRow } from "../shared/project-skills";
import { defaultClaudeDir } from "../pi-config/extensions/claude-code/accounts.ts";
import { checkoutOf, fileSha256, groupOf, itemKey, type ApprovalLookup, type FolderRef } from "./approvals-lookup";
import { askingFirst } from "./context-approval-setting";
import { skillFolderFingerprint, type Fingerprint } from "./skill-fingerprint";
import { listSubfolderInstructions } from "./deeper-context";
import { folderResources } from "./harness/pi/resources";
import { piSkillsIn } from "./harness/pi/skill-sources";
import { real } from "./mcp/folder";
import { skillDescentAllowed } from "./skill-descent";
import { OrgError } from "./org-error";
import { folderMatcher } from "./project-folder";
import { dirFolderKey, folderDecisions, isItemKey, isSkillName, projectFolderKey, readApprovalStore, updateApprovalStore, type Decision, type ItemKind } from "./project-skills-store";
import { listProjects, readProject } from "./projects/spaces";
import { agentRoot } from "./state-root";
import { listSubfolderSkills } from "./subfolder-skills";

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
 * One row per key, the first found. No subfolder walk for a folder whose chats don't look below it (server/skill-descent.ts:
 * a plain folder, the home folder or above); a project's walks, a chat anywhere inside it may, unless its root is the
 * home folder or above it.
 */
export async function folderQuickScan(where: string | FolderRef, deps: ScanDeps = {}): Promise<FolderScan> {
  const folder = typeof where === "string" ? folderForCwd(where) : where;
  const main = folder.root;
  const listed = await checkoutsFor(main, deps);
  let complete = listed.complete;
  const checkouts = listed.dirs.includes(main) ? listed.dirs : [main, ...listed.dirs];
  const lookup = { checkouts };
  const out = new Map<string, ScanItem>();
  const descends = skillDescentAllowed(main, { home: homedir(), inProject: folder.kind === "project" });
  const add = (kind: ScanItem["kind"], abs: string, checkout: string, extra: { name?: string; description?: string; dir?: string } = {}) => {
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
    out.set(id, { kind, key, path, name: extra.name ?? basename(path), group, ...(folderName ? { folder: folderName } : {}), ...(description ? { description } : {}), sha256: fp.sha256, ...(fp.partial ? { partial: true as const } : {}) });
  };
  for (const checkout of checkouts) {
    const top = checkout === main ? main : checkout;
    try {
      const res = await (deps.loader ?? folderResources)(top, agentRoot());
      for (const c of res.context) add("context", c.path, checkout);
      for (const s of res.skills) add("skill", s.filePath, checkout, { name: s.name, description: s.description });
      // A skill another of the same name shadows is a row of its own: told by its place, never by its name.
      for (const p of res.skillProblems ?? []) if (p.reason === "same-name") add("skill", p.path, checkout, { name: p.name });
    } catch {
      complete = false;
    }
    if (!descends) continue;
    const opts = deps.cap !== undefined ? { cap: deps.cap } : {};
    const files = listSubfolderInstructions(top, [], opts);
    if (files.incomplete) complete = false;
    for (const f of files.files) add("context", f.abs, checkout, { dir: join(top, f.dir) });
    const sub = listSubfolderSkills(top, piSkillsIn, opts);
    if (sub.incomplete) complete = false;
    for (const s of sub.skills) add("skill", s.filePath, checkout, { name: s.name, description: s.description, dir: join(top, s.dir) });
  }
  const scan: FolderScan = { folder, checkouts, items: [...out.values()], complete };
  settleAfterScan(scan);
  return scan;
}

/**
 * What a scan settles in the store: version 1's name-keyed Disallowed skills go to the first skill found of that
 * name, and, after a complete scan, decisions on items no longer
 * found drop off (with the names no skill has). Writes only when something changes.
 */
function settleAfterScan(scan: FolderScan): void {
  const d = folderDecisions(scan.folder.key);
  const found = { context: new Set<string>(), skills: new Set<string>() };
  for (const i of scan.items) found[i.kind === "context" ? "context" : "skills"].add(i.key);
  const legacy = Object.entries(d.legacySkills ?? {});
  const goneContext = scan.complete ? Object.keys(d.context).filter((k) => !found.context.has(k)) : [];
  const goneSkills = scan.complete ? Object.keys(d.skills).filter((k) => !found.skills.has(k)) : [];
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
  return { key: i.key, path: i.path, name: i.name, source: i.folder ? { kind: i.group, folder: i.folder } : { kind: i.group }, state, ...(changed ? { changed: true as const } : {}), ...(i.partial ? { fingerprintPartial: true as const } : {}) };
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
}

/**
 * The one write: resolve the changes against a fresh scan, save them at once (an approval with the item's
 * fingerprint now, a skill with its name), then tell the folder's chats not yet started. The caller has
 * already checked who may make them (changesNeedPage).
 */
export async function writeFolderApprovals(folder: FolderRef, raw: ApprovalChanges, deps: ScanDeps = {}, opts: { scan?: FolderScan } = {}): Promise<ApprovalWrite> {
  const scan = opts.scan ?? (await folderQuickScan(folder, deps));
  const changes = resolveChanges(scan, raw);
  // An approval is of the content it was given for: an item this scan didn't find, or couldn't read, can't be approved.
  for (const kind of ["context", "skills"] as const) {
    for (const [key, to] of Object.entries(changes[kind])) {
      if (to !== "approved") continue;
      const item = scan.items.find((i) => (i.kind === "context") === (kind === "context") && i.key === key);
      if (!item?.sha256) throw new OrgError(`${key} can't be approved: ${item ? "it couldn't be read" : "it wasn't found"}. Nothing was changed.`, 409);
    }
  }
  const before = folderDecisions(folder.key);
  const changed: ApprovalWrite["changed"] = [];
  updateApprovalStore((s) => {
    const f = (s.folders[folder.key] ??= { context: {}, skills: {} });
    for (const kind of ["context", "skills"] as const) {
      for (const [key, to] of Object.entries(changes[kind])) {
        const item = scan.items.find((i) => (i.kind === "context") === (kind === "context") && i.key === key);
        const prev = before[kind][key];
        const from: ApprovalState = prev?.state ?? "waiting";
        const name = item?.name ?? prev?.name ?? basename(key);
        if (to === "waiting") delete f[kind][key];
        else f[kind][key] = { state: to, ...(to === "approved" ? { sha256: item!.sha256 } : {}), ...(kind === "skills" && isSkillName(name) ? { name } : {}) };
        const reapproved = to === "approved" && from === "approved" && prev?.sha256 !== item?.sha256;
        if (from !== to || reapproved) changed.push({ kind, key, name, from, to });
      }
    }
  });
  try {
    await (await import("./projects/skills-chats")).notifySetupChanged(folder.key);
  } catch (err) {
    console.warn(`[approvals] telling ${folder.key}'s new chats failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { scan, changed };
}
