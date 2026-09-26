import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  IDEA_ID_RE,
  IDEA_STATUSES,
  type IdeaMeta,
  type IdeaPatch,
  type IdeaRecord,
  type IdeaStatus,
  type IdeasManifest,
  type IdeasToc,
  type OverseerIdeaDetail,
  type OverseerIdeasInfo,
} from "../shared/protocol";
import { stateRoot } from "./state-root";

/**
 * The Overseer's ideas backlog, laid out like the spec (`.sova/spec/`): `ideas/manifest.json` holds
 * every record under its `§` id, and each idea's prose is its own `.md`. Spec-SHAPED only: ideas
 * have no code, evidence or authority, so this is a small reader and link graph of its own, not
 * the spec tooling.
 *
 * Same store rules as the rest of the Overseer's files (overseer-store.ts): atomic tmp+rename,
 * re-read before every write, tolerant on read (a bad record is dropped, a dangling link ignored,
 * nothing throws). Nothing here deletes: `dropped` is the terminal status, and a renamed idea keeps
 * its former ids (`renamedFrom`), through which reads and links still reach it. The Overseer's
 * `sova_idea` and the panel's PATCH are the only writers. Every function takes the ideas dir as an
 * optional last argument, so tests can point it at a temp dir.
 */

export const ideasDir = () => join(stateRoot(), "ideas");

export const IDEAS_MAX = 500;
export const IDEA_TITLE_MAX = 120;
/** The prose grows as the user hashes an idea out and explorer plans are appended. */
export const IDEA_TEXT_MAX = 40_000;
export const IDEA_TAGS_MAX = 8;
export const IDEA_LINKS_MAX = 32;
/** Former ids kept per idea; the oldest goes first. */
export const IDEA_RENAMED_MAX = 8;
const TAG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const WORKER_ID_RE = /^[\w.-]{1,64}$/;

/** A refusal the caller relays as it is worded (a 400, or the tool's error). */
export class IdeaError extends Error {}
/** A PATCH whose `base` is stale (a 409 with the current detail). */
export class IdeaConflictError extends Error {
  constructor(readonly current: OverseerIdeaDetail) {
    super("This idea changed since you opened it. Review the current text and apply your edit again.");
  }
}

// ---- ids ---------------------------------------------------------------------------------------

export interface IdeaId {
  id: string;
  ns: string;
  parentName?: string;
  name: string;
}

/** Parse an id (the `§` optional on input), or null. */
export function parseIdeaId(raw: unknown): IdeaId | null {
  if (typeof raw !== "string") return null;
  const m = IDEA_ID_RE.exec(raw.trim());
  if (!m) return null;
  const [, ns, parentName, name] = m as unknown as [string, string, string | undefined, string];
  return { id: `§${ns}${parentName ? `.${parentName}` : ""}/${name}`, ns, ...(parentName ? { parentName } : {}), name };
}

/** The canonical id, or an IdeaError naming the grammar. */
export function canonicalIdeaId(raw: unknown): string {
  const p = parseIdeaId(raw);
  if (!p) throw new IdeaError(`"${String(raw)}" is not an idea id. Use §<project>/<name> (a main entry) or §<project>.<main>/<name> (a sub-entry): lowercase letters, digits and dashes.`);
  return p.id;
}

/** A sub-entry's main entry, or undefined for a main entry. */
export function parentOf(id: string): string | undefined {
  const p = parseIdeaId(id);
  return p?.parentName ? `§${p.ns}/${p.parentName}` : undefined;
}

/** Where an idea's prose lives, relative to the ideas dir. */
export function proseFile(id: string, dir = ideasDir()): string {
  const p = parseIdeaId(id);
  if (!p) throw new IdeaError(`Not an idea id: ${id}`);
  return p.parentName ? join(dir, p.ns, p.parentName, `${p.name}.md`) : join(dir, p.ns, `${p.name}.md`);
}

// ---- files -------------------------------------------------------------------------------------

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

/** One manifest record, tolerant: null when it can't be a record at all, else its good fields. */
function parseMeta(raw: unknown): IdeaMeta | null {
  if (!isObj(raw)) return null;
  const title = typeof raw.title === "string" ? raw.title.replace(/\s+/g, " ").trim().slice(0, IDEA_TITLE_MAX) : "";
  if (!title) return null;
  const status = IDEA_STATUSES.includes(raw.status as IdeaStatus) ? (raw.status as IdeaStatus) : "open";
  const tags = Array.isArray(raw.tags) ? [...new Set(raw.tags.filter((t): t is string => typeof t === "string" && TAG_RE.test(t)))].slice(0, IDEA_TAGS_MAX) : [];
  const links = Array.isArray(raw.links) ? [...new Set(raw.links.map((l) => parseIdeaId(l)?.id).filter((l): l is string => !!l))] : [];
  const createdAt = isIso(raw.createdAt) ? raw.createdAt : new Date(0).toISOString();
  const updatedAt = isIso(raw.updatedAt) ? raw.updatedAt : createdAt;
  const meta: IdeaMeta = { title, status, tags, links, createdAt, updatedAt };
  if (typeof raw.sessionId === "string" && raw.sessionId.trim()) meta.sessionId = raw.sessionId.trim();
  if (typeof raw.explorerId === "string" && WORKER_ID_RE.test(raw.explorerId)) meta.explorerId = raw.explorerId;
  if (typeof raw.explorerOverseerId === "string" && raw.explorerOverseerId.trim()) meta.explorerOverseerId = raw.explorerOverseerId.trim();
  if (Array.isArray(raw.renamedFrom)) {
    const former = [...new Set(raw.renamedFrom.map((f) => parseIdeaId(f)?.id).filter((f): f is string => !!f))].slice(-IDEA_RENAMED_MAX);
    if (former.length) meta.renamedFrom = former;
  }
  return meta;
}

/**
 * The manifest as the graph uses it: bad ids and records dropped, a sub-entry without its main
 * entry dropped, links that name no idea (or the idea itself) ignored. Never throws.
 */
export function readManifest(dir = ideasDir()): IdeasManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  } catch {
    raw = undefined;
  }
  const ideas: Record<string, IdeaMeta> = {};
  const src = isObj(raw) && isObj(raw.ideas) ? raw.ideas : {};
  for (const [key, value] of Object.entries(src)) {
    const id = parseIdeaId(key)?.id;
    const meta = id ? parseMeta(value) : null;
    if (id && meta && !ideas[id]) ideas[id] = meta;
  }
  for (const id of Object.keys(ideas)) {
    const parent = parentOf(id);
    if (parent && !ideas[parent]) delete ideas[id];
  }
  for (const [id, meta] of Object.entries(ideas)) meta.links = meta.links.filter((l) => l !== id && !!ideas[l]);
  // A former id names one idea at most, and never a live one.
  const claimed = new Set<string>();
  for (const id of Object.keys(ideas).sort()) {
    const meta = ideas[id]!;
    if (!meta.renamedFrom) continue;
    const former = meta.renamedFrom.filter((f) => !ideas[f] && !claimed.has(f));
    for (const f of former) claimed.add(f);
    if (former.length) meta.renamedFrom = former;
    else delete meta.renamedFrom;
  }
  return { formatVersion: 1, ideas };
}

/** The idea that was renamed from `id`, or undefined. */
function renamedTo(id: string, m: IdeasManifest): string | undefined {
  return Object.keys(m.ideas).find((x) => m.ideas[x]!.renamedFrom?.includes(id));
}

/** The live id `raw` names: itself, or the idea renamed from it. Null for neither, or a bad id. */
export function resolveIdeaId(raw: unknown, m: IdeasManifest): string | null {
  const id = parseIdeaId(raw)?.id;
  if (!id) return null;
  return m.ideas[id] ? id : (renamedTo(id, m) ?? null);
}

function writeManifest(m: IdeasManifest, dir: string): void {
  const sorted: Record<string, IdeaMeta> = {};
  for (const id of Object.keys(m.ideas).sort()) sorted[id] = m.ideas[id]!;
  writeAtomic(join(dir, "manifest.json"), `${JSON.stringify({ formatVersion: 1, ideas: sorted }, null, 2)}\n`);
}

export function readProse(id: string, dir = ideasDir()): string {
  try {
    return readFileSync(proseFile(id, dir), "utf8");
  } catch {
    return "";
  }
}

function recordOf(id: string, meta: IdeaMeta): IdeaRecord {
  const p = parseIdeaId(id)!;
  const parent = parentOf(id);
  return { id, ns: p.ns, ...(parent ? { parent } : {}), ...meta };
}

/** Every record, ToC order. */
export function listIdeas(dir = ideasDir()): IdeaRecord[] {
  const m = readManifest(dir);
  return tocOrder(Object.keys(m.ideas)).map((id) => recordOf(id, m.ideas[id]!));
}

/** One idea by its id or a former one. */
export function getIdea(raw: unknown, dir = ideasDir()): IdeaRecord | null {
  const m = readManifest(dir);
  const id = resolveIdeaId(raw, m);
  return id ? recordOf(id, m.ideas[id]!) : null;
}

/** Main entries by id, each followed by its sub-entries (by id); namespaces by name. */
function tocOrder(ids: string[]): string[] {
  const key = (id: string) => {
    const parent = parentOf(id);
    return parent ? `${parent}\u0001${id}` : `${id}\u0000`;
  };
  return [...ids].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

// ---- validation --------------------------------------------------------------------------------

function cleanTitle(v: unknown): string {
  const t = typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
  if (!t) throw new IdeaError("title is required: one short line.");
  if (t.length > IDEA_TITLE_MAX) throw new IdeaError(`title must be at most ${IDEA_TITLE_MAX} characters.`);
  return t;
}

function cleanTags(v: unknown): string[] {
  if (!Array.isArray(v)) throw new IdeaError("tags must be a list.");
  const tags = [...new Set(v.map((t) => (typeof t === "string" ? t.trim().toLowerCase().replace(/^#/, "") : "")))].filter(Boolean);
  for (const t of tags) if (!TAG_RE.test(t)) throw new IdeaError(`Tag "${t}" is not valid: lowercase letters, digits and dashes, at most 32.`);
  if (tags.length > IDEA_TAGS_MAX) throw new IdeaError(`At most ${IDEA_TAGS_MAX} tags.`);
  return tags;
}

/** Links as the store keeps them: canonical, a former id resolved to the idea it names now. */
function cleanLinks(v: unknown, self: string, m: IdeasManifest): string[] {
  if (!Array.isArray(v)) throw new IdeaError("links must be a list of idea ids.");
  const links = [
    ...new Set(
      v.map((l) => {
        const id = canonicalIdeaId(l);
        const live = resolveIdeaId(id, m);
        if (!live) throw new IdeaError(`No idea ${id}. Links must name existing ideas (sova_ideas toc lists them).`);
        return live;
      }),
    ),
  ];
  for (const l of links) if (l === self) throw new IdeaError("An idea cannot link to itself.");
  if (links.length > IDEA_LINKS_MAX) throw new IdeaError(`At most ${IDEA_LINKS_MAX} links.`);
  return links;
}

function cleanText(v: unknown): string {
  if (typeof v !== "string") throw new IdeaError("text must be a string.");
  if (v.length > IDEA_TEXT_MAX) throw new IdeaError(`The idea's text would be ${v.length} characters; the limit is ${IDEA_TEXT_MAX}. Summarise it.`);
  return v;
}

/** A timestamp strictly after `prev`, so `updatedAt` works as a PATCH base even within one ms. */
function nextStamp(prev?: string): string {
  let t = Date.now();
  const p = prev ? Date.parse(prev) : NaN;
  if (Number.isFinite(p) && t <= p) t = p + 1;
  return new Date(t).toISOString();
}

/** A status change, refused out of `dropped` (terminal). */
function withStatus(meta: IdeaMeta, status: IdeaStatus): IdeaStatus {
  if (meta.status === "dropped" && status !== "dropped") throw new IdeaError("This idea was dropped; dropped is final. File a new idea instead.");
  return status;
}

/** The automatic status a link brings, unless the user already closed the idea. */
function autoStatus(meta: IdeaMeta, to: "exploring" | "started"): IdeaStatus {
  if (meta.status === "done" || meta.status === "dropped") return meta.status;
  if (to === "exploring" && meta.status === "started") return meta.status;
  return to;
}

// ---- writes ------------------------------------------------------------------------------------

export interface NewIdea {
  id: unknown;
  title: unknown;
  text?: unknown;
  tags?: unknown;
  links?: unknown;
}

/** File a new idea. The id must be new; a sub-entry's main entry must exist. */
export function addIdea(input: NewIdea, dir = ideasDir()): IdeaRecord {
  const id = canonicalIdeaId(input.id);
  const m = readManifest(dir);
  if (m.ideas[id]) throw new IdeaError(`${id} already exists. Append to it, or pick another name.`);
  const to = renamedTo(id, m);
  if (to) throw new IdeaError(`${id} was renamed to ${to}. Append to ${to}, or pick another name.`);
  if (Object.keys(m.ideas).length >= IDEAS_MAX) throw new IdeaError(`The backlog holds at most ${IDEAS_MAX} ideas. Ask the user which to mark done or dropped.`);
  const parent = parentOf(id);
  if (parent && !m.ideas[parent]) throw new IdeaError(`${id} is a sub-entry of ${parent}, which does not exist. File ${parent} first, or use a main entry.`);
  const now = nextStamp();
  const meta: IdeaMeta = {
    title: cleanTitle(input.title),
    status: "open",
    tags: input.tags === undefined ? [] : cleanTags(input.tags),
    links: input.links === undefined ? [] : cleanLinks(input.links, id, m),
    createdAt: now,
    updatedAt: now,
  };
  const text = input.text === undefined ? "" : cleanText(input.text);
  writeAtomic(proseFile(id, dir), text.endsWith("\n") || !text ? text : `${text}\n`);
  m.ideas[id] = meta;
  writeManifest(m, dir);
  return recordOf(id, meta);
}

export interface IdeaUpdate extends IdeaPatch {
  /** Links to add / remove (the tool's `link` op); `links` replaces them all. */
  addLinks?: unknown[];
  removeLinks?: unknown[];
  /** A dated paragraph appended to the prose. */
  append?: string;
  sessionId?: string;
  explorer?: { id: string; overseerId: string };
}

/**
 * Change one idea. Re-reads the manifest first; `base` (the updatedAt the editor started from)
 * that no longer matches throws IdeaConflictError. Returns the detail after the write.
 */
export function updateIdea(raw: unknown, patch: IdeaUpdate, dir = ideasDir(), now = new Date()): OverseerIdeaDetail {
  const asked = canonicalIdeaId(raw);
  const m = readManifest(dir);
  const id = resolveIdeaId(asked, m) ?? asked;
  const cur = m.ideas[id];
  if (!cur) throw new IdeaError(`No idea ${id}. sova_ideas toc lists them.`);
  if (patch.base !== undefined && patch.base !== cur.updatedAt) throw new IdeaConflictError(ideaDetail(id, dir)!);
  const next: IdeaMeta = { ...cur, tags: [...cur.tags], links: [...cur.links] };
  if (patch.title !== undefined) next.title = cleanTitle(patch.title);
  if (patch.tags !== undefined) next.tags = cleanTags(patch.tags);
  if (patch.links !== undefined) next.links = cleanLinks(patch.links, id, m);
  if (patch.addLinks?.length) next.links = cleanLinks([...next.links, ...patch.addLinks], id, m);
  if (patch.removeLinks?.length) {
    const gone = new Set(patch.removeLinks.map((l) => resolveIdeaId(l, m) ?? canonicalIdeaId(l)));
    next.links = next.links.filter((l) => !gone.has(l));
  }
  if (patch.sessionId !== undefined) {
    if (!patch.sessionId.trim()) throw new IdeaError("session must be a session id.");
    next.sessionId = patch.sessionId.trim();
    next.status = autoStatus(next, "started");
  }
  if (patch.explorer) {
    if (!WORKER_ID_RE.test(patch.explorer.id)) throw new IdeaError(`Not a worker id: ${patch.explorer.id}`);
    next.explorerId = patch.explorer.id;
    next.explorerOverseerId = patch.explorer.overseerId;
    next.status = autoStatus(next, "exploring");
  }
  if (patch.status !== undefined) {
    if (!IDEA_STATUSES.includes(patch.status)) throw new IdeaError(`status must be one of ${IDEA_STATUSES.join(", ")}.`);
    next.status = withStatus(cur, patch.status);
  }
  let text: string | undefined;
  if (patch.text !== undefined) text = cleanText(patch.text);
  if (patch.append !== undefined) {
    const add = patch.append.trim();
    if (!add) throw new IdeaError("text to append must not be blank.");
    const before = (text ?? readProse(id, dir)).replace(/\s*$/, "");
    text = cleanText(`${before}${before ? "\n\n" : ""}_${now.toISOString().slice(0, 10)}_ — ${add}\n`);
  }
  next.updatedAt = nextStamp(cur.updatedAt);
  if (text !== undefined) writeAtomic(proseFile(id, dir), text);
  m.ideas[id] = next;
  writeManifest(m, dir);
  return ideaDetail(id, dir)!;
}

// ---- rename ------------------------------------------------------------------------------------

export interface IdeaRename {
  detail: OverseerIdeaDetail;
  /** The id it had. */
  from: string;
  /** Every id that moved, old → new: the idea, then its sub-entries. */
  moved: Record<string, string>;
  /** Other ideas whose links were rewritten. */
  relinked: string[];
  /** Ideas whose text still names a moved idea by its old id (text is never rewritten). */
  mentions: string[];
}

interface RenamePlan {
  from: string;
  moved: Record<string, string>;
  ideas: Record<string, IdeaMeta>;
  relinked: string[];
}

/** Everything a rename would write, or the refusal. Writes nothing. */
function planRename(raw: unknown, newRaw: unknown, m: IdeasManifest, base: string | undefined, dir: string): RenamePlan {
  const asked = canonicalIdeaId(raw);
  const from = resolveIdeaId(asked, m);
  if (!from) throw new IdeaError(`No idea ${asked}. sova_ideas toc lists them.`);
  const to = canonicalIdeaId(newRaw);
  const cur = m.ideas[from]!;
  if (base !== undefined && base !== cur.updatedAt) throw new IdeaConflictError(ideaDetail(from, dir)!);
  if (to === from) throw new IdeaError(`${from} already has that id.`);
  const subs = Object.keys(m.ideas).filter((x) => parentOf(x) === from).sort();
  const parent = parentOf(to);
  if (parent && subs.length)
    throw new IdeaError(`${from} has sub-entries (${subs.join(", ")}), so it can't become a sub-entry. Pick a main entry id: §<project>/<name>.`);
  if (parent === from) throw new IdeaError(`${to} would be a sub-entry of ${from} itself. Pick another id.`);
  if (parent && !m.ideas[parent]) throw new IdeaError(`${to} is a sub-entry of ${parent}, which does not exist. Pick an existing main entry, or a main entry id.`);
  const p = parseIdeaId(to)!;
  const moved: Record<string, string> = { [from]: to };
  for (const s of subs) moved[s] = `§${p.ns}.${p.name}/${parseIdeaId(s)!.name}`;
  for (const [old, next] of Object.entries(moved)) {
    if (m.ideas[next]) throw new IdeaError(`${next} already exists. Pick another id.`);
    const owner = renamedTo(next, m);
    if (owner && owner !== old) throw new IdeaError(`${next} is a former id of ${owner}, so it still leads there. Pick another id.`);
  }
  const ideas: Record<string, IdeaMeta> = {};
  const relinked: string[] = [];
  for (const [id, meta] of Object.entries(m.ideas)) {
    const links = meta.links.map((l) => moved[l] ?? l);
    const relink = links.some((l, i) => l !== meta.links[i]);
    const next = moved[id];
    if (next) {
      const renamedFrom = [...(meta.renamedFrom ?? []).filter((f) => f !== next && f !== id), id].slice(-IDEA_RENAMED_MAX);
      ideas[next] = { ...meta, tags: [...meta.tags], links, renamedFrom, updatedAt: nextStamp(meta.updatedAt) };
    } else {
      ideas[id] = relink ? { ...meta, links } : meta;
      if (relink) relinked.push(id);
    }
  }
  return { from, moved, ideas, relinked: relinked.sort() };
}

/** Would this rename go through? Throws the refusal it would give (IdeaError), else nothing. */
export function checkRename(raw: unknown, newRaw: unknown, dir = ideasDir()): void {
  planRename(raw, newRaw, readManifest(dir), undefined, dir);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * Give an idea a new id. Its sub-entries move with it (`§ns.old/x` → `§ns.new/x`), every other
 * idea's links to a moved id are rewritten, and each moved record keeps its old id in
 * `renamedFrom`, all in one manifest write. Only the moved records' `updatedAt` changes. Prose is
 * copied first, the manifest written (the commit point), then the old files removed; a failure
 * before the commit leaves only strays, which nothing indexes. `base` works as in updateIdea.
 * Todos are another file: the caller retargets them with the returned `moved`.
 */
export function renameIdea(raw: unknown, newRaw: unknown, opts: { base?: string } = {}, dir = ideasDir()): IdeaRename {
  const m = readManifest(dir);
  const plan = planRename(raw, newRaw, m, opts.base, dir);
  const copies: string[] = [];
  try {
    for (const [old, next] of Object.entries(plan.moved)) {
      const src = proseFile(old, dir);
      const dst = proseFile(next, dir);
      if (existsSync(src)) {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
        copies.push(dst);
      } else if (existsSync(dst)) unlinkSync(dst); // a stray under an id nothing indexed
    }
    writeManifest({ formatVersion: 1, ideas: plan.ideas }, dir);
  } catch (err) {
    for (const c of copies) {
      try {
        unlinkSync(c);
      } catch {}
    }
    throw err;
  }
  for (const old of Object.keys(plan.moved)) {
    try {
      unlinkSync(proseFile(old, dir));
    } catch {}
  }
  const p = parseIdeaId(plan.from)!;
  if (!p.parentName && Object.keys(plan.moved).length > 1) {
    try {
      rmdirSync(join(dir, p.ns, p.name));
    } catch {}
  }
  const olds = Object.keys(plan.moved).map((o) => new RegExp(`${escapeRe(o)}(?![a-z0-9-])`));
  const mentions = Object.keys(plan.ideas)
    .filter((id) => {
      const prose = readProse(id, dir);
      return olds.some((re) => re.test(prose));
    })
    .sort();
  return { detail: ideaDetail(plan.moved[plan.from]!, dir)!, from: plan.from, moved: plan.moved, relinked: plan.relinked, mentions };
}

// ---- the graph ---------------------------------------------------------------------------------

/** The ids `id` reaches through links, transitively, plus its sub-entries (and theirs' links);
    itself excluded. Breadth-first, so nearer ideas come first; cycles are harmless. */
export function scopeOf(id: string, m: IdeasManifest): string[] {
  const seen = new Set([id]);
  const out: string[] = [];
  const queue = [id];
  const children = (x: string) => Object.keys(m.ideas).filter((c) => parentOf(c) === x).sort();
  while (queue.length) {
    const x = queue.shift()!;
    for (const y of [...children(x), ...(m.ideas[x]?.links ?? [])]) {
      if (seen.has(y) || !m.ideas[y]) continue;
      seen.add(y);
      out.push(y);
      queue.push(y);
    }
  }
  return out;
}

/** The ideas that link to `id` directly. */
export function linkedBy(id: string, m: IdeasManifest): string[] {
  return Object.keys(m.ideas).filter((x) => m.ideas[x]!.links.includes(id)).sort();
}

/** The ideas that reach `id`, transitively (what a change to it may affect), nearest first. */
export function impactOf(id: string, m: IdeasManifest): string[] {
  const seen = new Set([id]);
  const out: string[] = [];
  const queue = [id];
  while (queue.length) {
    const x = queue.shift()!;
    for (const y of linkedBy(x, m)) {
      if (seen.has(y)) continue;
      seen.add(y);
      out.push(y);
      queue.push(y);
    }
  }
  return out;
}

/** One idea with its prose and graph, by its id or a former one. */
export function ideaDetail(raw: unknown, dir = ideasDir()): OverseerIdeaDetail | null {
  const m = readManifest(dir);
  const id = resolveIdeaId(raw, m);
  if (!id) return null;
  return { idea: recordOf(id, m.ideas[id]!), text: readProse(id, dir), scope: scopeOf(id, m), linkedBy: linkedBy(id, m) };
}

const emptyCounts = (): Record<IdeaStatus, number> => ({ open: 0, exploring: 0, started: 0, done: 0, dropped: 0 });

export function ideasToc(m: IdeasManifest): IdeasToc {
  const byNs = new Map<string, IdeasToc["namespaces"][number]>();
  for (const id of tocOrder(Object.keys(m.ideas))) {
    const meta = m.ideas[id]!;
    const ns = parseIdeaId(id)!.ns;
    let entry = byNs.get(ns);
    if (!entry) byNs.set(ns, (entry = { ns, counts: emptyCounts(), entries: [] }));
    entry.counts[meta.status]++;
    const parent = parentOf(id);
    entry.entries.push({ id, title: meta.title, status: meta.status, ...(parent ? { parent } : {}) });
  }
  const namespaces = [...byNs.values()].sort((a, b) => (a.ns < b.ns ? -1 : a.ns > b.ns ? 1 : 0));
  return { total: Object.keys(m.ideas).length, namespaces };
}

export function ideasInfo(dir = ideasDir()): OverseerIdeasInfo {
  const m = readManifest(dir);
  const ideas = tocOrder(Object.keys(m.ideas)).map((id) => recordOf(id, m.ideas[id]!));
  const edges = ideas.flatMap((i) => i.links.map((to) => ({ from: i.id, to })));
  return { toc: ideasToc(m), ideas, edges, dir };
}

// ---- search (the similar-idea scan) ------------------------------------------------------------

const STOP = new Set("a an and are as at be but by can could do for from have i if in into is it its it'd of on or our should so that the their then there this to we when where which will with would".split(" "));

export function words(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w));
}

/** Loose stem so "retries" meets "retry" and "backing" meets "backoff" only when they share one. */
const stem = (w: string) => w.replace(/(ies|es|s|ing|ed)$/, "").slice(0, 6);

/**
 * Ideas ranked by how much of the query they share: title and tags weigh most, then the id's
 * words, then the prose. Zero scores are left out.
 */
export function searchIdeas(query: string, opts: { ns?: string; status?: IdeaStatus | "all"; limit?: number } = {}, dir = ideasDir()): { record: IdeaRecord; score: number }[] {
  const m = readManifest(dir);
  const q = [...new Set(words(query).map(stem))];
  if (!q.length) return [];
  const hits: { record: IdeaRecord; score: number }[] = [];
  for (const [id, meta] of Object.entries(m.ideas)) {
    if (opts.ns && parseIdeaId(id)!.ns !== opts.ns) continue;
    if (opts.status && opts.status !== "all" && meta.status !== opts.status) continue;
    const bag = (s: string) => new Set(words(s).map(stem));
    const title = bag(meta.title);
    const tags = bag(meta.tags.join(" "));
    const idw = bag(id.replace(/[§./-]/g, " "));
    const prose = bag(readProse(id, dir));
    let score = 0;
    for (const w of q) score += (title.has(w) ? 3 : 0) + (tags.has(w) ? 3 : 0) + (idw.has(w) ? 2 : 0) + (prose.has(w) ? 1 : 0);
    if (score > 0) hits.push({ record: recordOf(id, meta), score: score / q.length });
  }
  hits.sort((a, b) => b.score - a.score || (a.record.id < b.record.id ? -1 : 1));
  return hits.slice(0, Math.min(50, Math.max(1, opts.limit ?? 10)));
}

// ---- the prompt's ToC ----------------------------------------------------------------------------

const PROMPT_NS_ENTRIES = 12;

/**
 * The backlog as the Overseer's prompt carries it: one short line per namespace, counts and entry
 * names, never titles or prose. An entry with an explorer this conversation owns is marked, from
 * the STORE (never worker liveness), so an unchanged store renders byte-identical.
 */
export function promptToc(m: IdeasManifest, overseerId: string): string {
  const toc = ideasToc(m);
  if (!toc.total) return "(no ideas yet)";
  return toc.namespaces
    .map((n) => {
      const counts = IDEA_STATUSES.filter((s) => n.counts[s] > 0).map((s) => `${n.counts[s]} ${s}`).join(", ");
      const live = n.entries.filter((e) => e.status !== "done" && e.status !== "dropped");
      const names = live.slice(0, PROMPT_NS_ENTRIES).map((e) => {
        const meta = m.ideas[e.id]!;
        const p = parseIdeaId(e.id)!;
        const name = p.parentName ? `${p.parentName}/${p.name}` : p.name;
        const explorer = meta.explorerId && meta.explorerOverseerId === overseerId ? ` [explorer ${meta.explorerId}]` : "";
        return `${name}${e.status !== "open" ? ` (${e.status})` : ""}${explorer}`;
      });
      const more = live.length > PROMPT_NS_ENTRIES ? `, +${live.length - PROMPT_NS_ENTRIES} more` : "";
      return `- §${n.ns} (${counts})${names.length ? `: ${names.join(", ")}${more}` : ""}`;
    })
    .join("\n");
}
