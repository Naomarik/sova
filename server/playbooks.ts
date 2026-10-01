import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLAYBOOK_ENTRIES, type PlaybookCatalog, type PlaybookEntry, type PlaybookInfo, type PlaybookSchedule } from "../shared/protocol";
import { scheduleOf, scheduleText } from "../shared/schedules";
import { defaultRemoteOf, type RemoteCwd } from "./files";
import { projectOf } from "./project-root";
import { stateRoot } from "./state-root";

/**
 * Every playbook the composer's Playbooks dialog can offer: markdown recipes an agent runs against
 * any project. Three folders, one grammar — each playbook is a directory `<id>/` whose entry file is
 * `PLAYBOOK.md` or, failing that, `SKILL.md` (plus whatever scripts/, references/, phases/… it
 * names, all relative to that directory; §chat.playbooks/bundles). Sova only ever reads the entry:
 * a playbook's scripts are the agent's to run, never this server's.
 *
 *   - shipped:  playbooks/ at the repo root (source "sova")
 *   - user:     ~/.pi/agent/sova/playbooks/ (source "user"; an id that matches a shipped one
 *               REPLACES it, marked `replacesSova`, like a user theme replaces a built-in)
 *   - project:  <project root>/.sova/playbooks/, then <project root>/.sova/marketing/playbooks/
 *               (source "project"; the root is the cwd's project, server/project-root.ts, so a
 *               worktree or subfolder session reads its main checkout's)
 *
 * No watch and no cache, like server/themes.ts: the dialog fetches once per opening, and three
 * small folders are cheaper to rescan than a watch is to keep honest.
 *
 * The project cwd is handled exactly as server/files.ts handles it: a relative or remote cwd is
 * refused lexically, before any fs call (a placeholder is never a local folder). Nothing here ever
 * fails the request — what couldn't be listed says so in
 * `project` or `error`, beside everything that could.
 */
const SHIPPED_DIR = fileURLToPath(new URL("../playbooks/", import.meta.url));
/** Read per call, like every other agent-dir path: PI_CODING_AGENT_DIR is what the tests move. */
export const userPlaybooksDir = () => join(stateRoot(), "playbooks");
/** Where a project keeps its own playbooks, relative to its root: its own, then the marketing output. */
export const PROJECT_PLAYBOOK_DIRS = [join(".sova", "playbooks"), join(".sova", "marketing", "playbooks")] as const;

/** A directory name we'll treat as a playbook id. Lowercase, digits and hyphens, not leading with
    a hyphen: no dot entries, no separators, nothing that could walk out of its folder. */
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
export const isPlaybookId = (name: string) => ID_RE.test(name);

/** Injectable seams; every one has the real default. Tests swap them, callers never pass them. */
export interface PlaybooksDeps {
  /** The shipped catalog (default: the repo's playbooks/). */
  shippedDir?: string;
  /** The user's folder (default: userPlaybooksDir()). */
  userDir?: string;
  /** The remote reading of a cwd (default: server/files.ts's, lexical). */
  remoteOf?: (path: string) => RemoteCwd | null;
}

/**
 * `---`-fenced leading `key: value` lines, and what follows them. Single-line scalars only; a
 * value wrapped in matching quotes loses them, anything else is taken verbatim after trimming.
 * Lines inside the fence that aren't `key: value` are ignored. No opening fence on line 1, or no
 * closing fence at all, means there is no frontmatter: the whole text is the body.
 */
export function parseFrontmatter(text: string): { fields: Record<string, string>; body: string } {
  const src = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const lines = src.split("\n");
  const fence = (l: string | undefined) => l !== undefined && l.replace(/\r$/, "").trimEnd() === "---";
  if (!fence(lines[0])) return { fields: {}, body: src };
  const close = lines.findIndex((l, i) => i > 0 && fence(l));
  if (close < 0) return { fields: {}, body: src };
  const fields: Record<string, string> = {};
  for (const raw of lines.slice(1, close)) {
    const m = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(raw.replace(/\r$/, ""));
    if (!m) continue;
    let value = m[2]!.trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    fields[m[1]!] = value;
  }
  // The blank line(s) that conventionally follow the fence are layout, not body.
  const body = lines.slice(close + 1).join("\n").replace(/^(?:\r?\n)+/, "");
  return { fields, body };
}

type Source = PlaybookInfo["source"];

/** Where schedules run (§chat.schedules/header): shown on a Sova or Yours playbook that has `when:`. */
export const NOT_PROJECT_SCHEDULE = "Schedules run only from a project's playbooks.";

/**
 * A playbook's schedule as its header declares it (§chat.schedules/header), before Sova's own
 * state is added (server/schedules.ts): invalid with its error, only-in-projects, or valid and not
 * yet approved.
 */
export function headerSchedule(fields: Record<string, string>, source: Source): PlaybookSchedule | undefined {
  const h = scheduleOf(fields);
  if (!h) return undefined;
  const base = { when: h.when, ...(h.profile ? { profile: h.profile } : {}), ...(h.tz ? { tz: h.tz } : {}) };
  if (source !== "project") return { ...base, state: "not-project", reason: NOT_PROJECT_SCHEDULE };
  if (h.error || !h.triggers) return { ...base, state: "invalid", reason: h.error };
  return { ...base, text: scheduleText(h.triggers), state: "needs-approval" };
}

/**
 * The entry file of a playbook folder and its text: PLAYBOOK.md when the folder has one, else
 * SKILL.md (so a folder with both reads exactly as it did before SKILL.md was accepted). Throws
 * when neither is readable — the folder isn't a playbook.
 */
async function readEntry(dir: string): Promise<{ entry: PlaybookEntry; text: string }> {
  let last: unknown;
  for (const entry of PLAYBOOK_ENTRIES) {
    try {
      return { entry, text: await readFile(join(dir, entry), "utf8") };
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

async function readOne(dir: string, id: string, source: Source): Promise<{ info: PlaybookInfo; fields: Record<string, string> }> {
  const { entry, text } = await readEntry(dir);
  const { fields, body } = parseFrontmatter(text);
  const info: PlaybookInfo = {
    id,
    // A skill names itself with `name:`; Sova's own key wins when both are there.
    title: fields.title?.trim() || fields.name?.trim() || id,
    description: fields.description ?? "",
    source,
    dir,
    entry,
    body,
  };
  if (fields.promptHint) info.promptHint = fields.promptHint;
  const schedule = headerSchedule(fields, source);
  if (schedule) info.schedule = schedule;
  return { info, fields };
}

/**
 * One project playbook by its project root and id, read now (the keeper re-reads the header at
 * every fire): the first of the project's folders that has it, as the catalog lists it, with its raw
 * frontmatter. Null when none has it.
 */
export async function readProjectPlaybook(root: string, id: string): Promise<{ info: PlaybookInfo; fields: Record<string, string> } | null> {
  if (!isPlaybookId(id)) return null;
  for (const rel of PROJECT_PLAYBOOK_DIRS) {
    const dir = join(root, rel, id);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      return await readOne(dir, id, "project");
    } catch {
      continue;
    }
  }
  return null;
}

/** Every playbook in a project's folders, an id in both listed once (the keeper's discovery). */
export async function listProjectPlaybooks(root: string): Promise<PlaybookInfo[]> {
  const out: PlaybookInfo[] = [];
  for (const rel of PROJECT_PLAYBOOK_DIRS) {
    const found = await scan(join(root, rel), "project");
    for (const p of found.entries) if (!out.some((e) => e.id === p.id)) out.push(p);
  }
  return out;
}

/** Every playbook in one folder. A missing folder is empty; any other failure to list it is the
    caller's to report. A child that isn't a well-named directory with a readable entry file is
    skipped — it isn't a playbook, and one bad folder must not hide the rest. */
async function scan(root: string, source: Source): Promise<{ entries: PlaybookInfo[]; error?: string }> {
  let names: string[];
  try {
    names = await readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { entries: [] };
    return { entries: [], error: (err as Error).message };
  }
  const found = await Promise.all(
    names.filter(isPlaybookId).map(async (id) => {
      const dir = join(root, id);
      try {
        if (!(await stat(dir)).isDirectory()) return null; // follows symlinks: a linked playbook counts
        return (await readOne(dir, id, source)).info;
      } catch {
        return null;
      }
    }),
  );
  return { entries: found.filter((p): p is PlaybookInfo => p !== null) };
}

/** Title order, case-insensitive; the id breaks ties so the order never depends on readdir. */
const byTitle = (a: PlaybookInfo, b: PlaybookInfo) =>
  a.title.localeCompare(b.title, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);

/** Why a remote cwd has no project playbooks: the same refusal /api/files gives. */
function remoteMessage(remote: RemoteCwd): string {
  return `This session's files live on ${remote.target}. Project playbooks are read from local folders only`;
}

async function projectPlaybooks(
  rawCwd: string | undefined,
  deps: PlaybooksDeps,
): Promise<{ state: PlaybookCatalog["project"]; entries: PlaybookInfo[] }> {
  if (rawCwd === undefined || rawCwd === "") return { state: { state: "none" }, entries: [] };
  if (!isAbsolute(rawCwd)) return { state: { state: "missing", message: "cwd must be an absolute path" }, entries: [] };
  const resolved = resolve(rawCwd);
  const remote = (deps.remoteOf ?? defaultRemoteOf)(resolved);
  if (remote) return { state: { state: "remote", message: remoteMessage(remote) }, entries: [] }; // lexical, before any fs call
  const path = resolved;
  try {
    if (!(await stat(path)).isDirectory()) return { state: { state: "missing", message: `${path} is not a folder` }, entries: [] };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const message = code === "ENOENT" || code === "ENOTDIR" ? `${path} doesn't exist` : `Sova can't read ${path} (${code ?? "unknown error"})`;
    return { state: { state: "missing", message }, entries: [] };
  }
  const project = await projectOf(path, deps);
  const root = project.state === "ok" ? project.root : path;
  const entries: PlaybookInfo[] = [];
  for (const rel of PROJECT_PLAYBOOK_DIRS) {
    const dir = join(root, rel);
    const found = await scan(dir, "project");
    if (found.error) return { state: { state: "missing", message: `Sova couldn't read ${dir}: ${found.error}` }, entries: [] };
    // An id in both folders is listed once, from the first.
    for (const p of found.entries) if (!entries.some((e) => e.id === p.id)) entries.push(p);
  }
  return { state: { state: "ok" }, entries: entries.sort(byTitle) };
}

/**
 * The catalog, rescanned, one group after another and each sorted by title (then id): shipped
 * first, minus any the user replaced; then the user's; then the project's. A project playbook never replaces anything: it is
 * listed in its own group even when its id matches one above.
 */
export async function listPlaybooks(cwd?: string, deps: PlaybooksDeps = {}): Promise<PlaybookCatalog> {
  const [shipped, user, project] = await Promise.all([
    scan(deps.shippedDir ?? SHIPPED_DIR, "sova"),
    scan(deps.userDir ?? userPlaybooksDir(), "user"),
    projectPlaybooks(cwd, deps),
  ]);
  const shippedIds = new Set(shipped.entries.map((p) => p.id));
  const userIds = new Set(user.entries.map((p) => p.id));
  for (const p of user.entries) if (shippedIds.has(p.id)) p.replacesSova = true;
  const playbooks = [
    ...shipped.entries.filter((p) => !userIds.has(p.id)).sort(byTitle),
    ...user.entries.sort(byTitle),
    ...project.entries,
  ];
  return { playbooks, project: project.state, ...(user.error ? { error: user.error } : {}) };
}
