import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TODO_ID_RE, TODO_TEXT_MAX, TODOS_MAX, type OverseerTodosInfo, type TodoPatch, type TodoRecord, type TodosFile } from "../shared/protocol";
import { canonicalIdeaId, getIdea, IdeaError, parseIdeaId } from "./overseer-ideas";
import { writeAtomic } from "./overseer-store";
import { stateRoot } from "./state-root";

/**
 * The user's todos: a short checklist of small tasks for themselves, beside the Overseer's other
 * files. One JSON file, `todos.json` = `{ formatVersion: 1, todos: [...] }`, in list order.
 *
 * Same store rules as the rest of the Overseer's files (overseer-store.ts): atomic tmp+rename,
 * re-read before every write, tolerant on read (a bad row, a duplicate id or an unparseable idea
 * link is dropped; nothing throws). Unlike the ideas, a todo is deleted outright (`removeTodo`,
 * `clearDone`): it has no history worth keeping. The Overseer's `sova_todo` and the panel's routes
 * are the only writers. Every function takes the file as an optional last argument, for tests.
 */

export const todosFile = () => join(stateRoot(), "todos.json");

/** A refusal the caller relays as it is worded (a 400, or the tool's error). */
export class TodoError extends Error {}
/** No todo with that id (a 404). */
export class TodoNotFoundError extends TodoError {}
/** A PATCH whose `base` is stale (a 409 with the current list). */
export class TodoConflictError extends Error {
  constructor(readonly current: OverseerTodosInfo) {
    super("This todo changed since you started editing it. Review its current text and apply your edit again.");
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isIso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const oneLine = (v: string) => v.replace(/\s+/g, " ").trim();

/** One stored row, tolerant: null when it can't be a todo, else its good fields. */
function parseRecord(raw: unknown): TodoRecord | null {
  if (!isObj(raw) || typeof raw.id !== "string" || !TODO_ID_RE.test(raw.id)) return null;
  const text = typeof raw.text === "string" ? oneLine(raw.text).slice(0, TODO_TEXT_MAX) : "";
  if (!text) return null;
  const createdAt = isIso(raw.createdAt) ? raw.createdAt : new Date(0).toISOString();
  const r: TodoRecord = { id: raw.id, text, done: raw.done === true, createdAt, updatedAt: isIso(raw.updatedAt) ? raw.updatedAt : createdAt };
  if (r.done && isIso(raw.doneAt)) r.doneAt = raw.doneAt;
  const idea = parseIdeaId(raw.ideaId)?.id;
  if (idea) r.ideaId = idea;
  if (typeof raw.sessionId === "string" && raw.sessionId.trim()) r.sessionId = raw.sessionId.trim();
  return r;
}

/** The list as stored, bad rows and duplicate ids dropped. Missing or corrupt → empty. Never throws. */
export function readTodos(file = todosFile()): TodosFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    raw = undefined;
  }
  const seen = new Set<string>();
  const todos: TodoRecord[] = [];
  for (const row of isObj(raw) && Array.isArray(raw.todos) ? raw.todos : []) {
    const r = parseRecord(row);
    if (!r || seen.has(r.id) || todos.length >= TODOS_MAX) continue;
    seen.add(r.id);
    todos.push(r);
  }
  return { formatVersion: 1, todos };
}

function writeTodos(f: TodosFile, file: string): void {
  writeAtomic(file, `${JSON.stringify({ formatVersion: 1, todos: f.todos }, null, 2)}\n`);
}

export function infoOf(f: TodosFile, file = todosFile()): OverseerTodosInfo {
  const done = f.todos.filter((t) => t.done).length;
  return { todos: f.todos, open: f.todos.length - done, done, file };
}

export function todosInfo(file = todosFile()): OverseerTodosInfo {
  return infoOf(readTodos(file), file);
}

export function openCount(file = todosFile()): number {
  return readTodos(file).todos.filter((t) => !t.done).length;
}

// ---- validation --------------------------------------------------------------------------------

function cleanText(v: unknown): string {
  const t = typeof v === "string" ? oneLine(v) : "";
  if (!t) throw new TodoError("text is required: one short line.");
  if (t.length > TODO_TEXT_MAX) throw new TodoError(`A todo is at most ${TODO_TEXT_MAX} characters (this one is ${t.length}). Shorten it.`);
  return t;
}

/** The canonical id of an idea that exists now; a renamed idea's former id links the idea itself. */
function cleanIdea(v: unknown): string {
  try {
    const id = canonicalIdeaId(v);
    const idea = getIdea(id);
    if (!idea) throw new TodoError(`No idea ${id}. A todo can only link an idea that exists (sova_ideas toc lists them).`);
    return idea.id;
  } catch (err) {
    if (err instanceof IdeaError) throw new TodoError(err.message);
    throw err;
  }
}

function cleanSession(v: unknown): string {
  const s = typeof v === "string" ? v.trim().replace(/^sova:\/\/s\//, "") : "";
  if (!s) throw new TodoError("sessionId must be a session id.");
  return s;
}

/** A timestamp strictly after `prev`, so `updatedAt` works as a PATCH base even within one ms. */
function nextStamp(prev?: string): string {
  let t = Date.now();
  const p = prev ? Date.parse(prev) : NaN;
  if (Number.isFinite(p) && t <= p) t = p + 1;
  return new Date(t).toISOString();
}

function newId(taken: Set<string>): string {
  for (;;) {
    const id = `td_${randomBytes(4).toString("hex")}`;
    if (!taken.has(id)) return id;
  }
}

function find(f: TodosFile, id: unknown): number {
  const i = typeof id === "string" ? f.todos.findIndex((t) => t.id === id.trim()) : -1;
  if (i < 0) throw new TodoNotFoundError(`No todo ${String(id)}. sova_todos lists them.`);
  return i;
}

// ---- writes ------------------------------------------------------------------------------------

export interface NewTodo {
  text: unknown;
  ideaId?: unknown;
  sessionId?: unknown;
}

/** Add a todo at the end of the list. */
export function addTodo(input: NewTodo, file = todosFile()): TodoRecord {
  const f = readTodos(file);
  if (f.todos.length >= TODOS_MAX) throw new TodoError(`The list holds at most ${TODOS_MAX} todos. Ask the user which done ones to clear.`);
  const now = nextStamp();
  const r: TodoRecord = { id: newId(new Set(f.todos.map((t) => t.id))), text: cleanText(input.text), done: false, createdAt: now, updatedAt: now };
  if (input.ideaId !== undefined && input.ideaId !== null && input.ideaId !== "") r.ideaId = cleanIdea(input.ideaId);
  if (input.sessionId !== undefined && input.sessionId !== null && input.sessionId !== "") r.sessionId = cleanSession(input.sessionId);
  f.todos.push(r);
  writeTodos(f, file);
  return r;
}

/**
 * Change one todo. Re-reads the file first; a `base` (the updatedAt the editor started from) that
 * no longer matches throws TodoConflictError. `null` or "" unlinks an idea or a session.
 */
export function updateTodo(id: unknown, patch: TodoPatch, file = todosFile(), now = new Date()): TodoRecord {
  const f = readTodos(file);
  const i = find(f, id);
  const cur = f.todos[i]!;
  if (patch.base !== undefined && patch.base !== cur.updatedAt) throw new TodoConflictError(infoOf(f, file));
  const next: TodoRecord = { ...cur };
  if (patch.text !== undefined) next.text = cleanText(patch.text);
  if (patch.done !== undefined) {
    if (typeof patch.done !== "boolean") throw new TodoError("done must be true or false.");
    if (patch.done && !cur.done) next.doneAt = now.toISOString();
    if (!patch.done) delete next.doneAt;
    next.done = patch.done;
  }
  if (patch.ideaId !== undefined) {
    if (patch.ideaId === null || patch.ideaId === "") delete next.ideaId;
    else next.ideaId = cleanIdea(patch.ideaId);
  }
  if (patch.sessionId !== undefined) {
    if (patch.sessionId === null || patch.sessionId === "") delete next.sessionId;
    else next.sessionId = cleanSession(patch.sessionId);
  }
  next.updatedAt = nextStamp(cur.updatedAt);
  f.todos[i] = next;
  writeTodos(f, file);
  return next;
}

/** Delete one todo; returns it. */
export function removeTodo(id: unknown, file = todosFile()): TodoRecord {
  const f = readTodos(file);
  const [gone] = f.todos.splice(find(f, id), 1);
  writeTodos(f, file);
  return gone!;
}

/** Delete every done todo; returns how many. */
export function clearDone(file = todosFile()): number {
  const f = readTodos(file);
  const keep = f.todos.filter((t) => !t.done);
  const removed = f.todos.length - keep.length;
  if (removed) writeTodos({ formatVersion: 1, todos: keep }, file);
  return removed;
}

/** Put the list in this order. `ids` must name every todo exactly once. */
export function reorderTodos(ids: unknown, file = todosFile()): void {
  const f = readTodos(file);
  const byId = new Map(f.todos.map((t) => [t.id, t]));
  const list = Array.isArray(ids) ? ids : null;
  if (!list || list.length !== byId.size || new Set(list).size !== list.length || !list.every((id) => typeof id === "string" && byId.has(id)))
    throw new TodoError("ids must list every todo exactly once. The list changed meanwhile; reload it and try again.");
  writeTodos({ formatVersion: 1, todos: list.map((id) => byId.get(id as string)!) }, file);
}

/**
 * An idea rename reached the todos: every idea link named in `moved` (old id → new id) follows it.
 * The todos keep their `updatedAt`, so an edit open on one is not refused for it. Returns how many
 * changed; writes only when one did.
 */
export function retargetIdeas(moved: Record<string, string>, file = todosFile()): number {
  const f = readTodos(file);
  let n = 0;
  for (const t of f.todos) {
    const to = t.ideaId ? moved[t.ideaId] : undefined;
    if (!to) continue;
    t.ideaId = to;
    n++;
  }
  if (n) writeTodos(f, file);
  return n;
}

// ---- the prompt --------------------------------------------------------------------------------

/** What the Overseer's prompt carries: the counts only, never a todo's text, so an unchanged
    list renders byte-identical and no todo rides in every request. */
export function promptTodos(f: TodosFile): string {
  if (!f.todos.length) return "(no todos)";
  const done = f.todos.filter((t) => t.done).length;
  return `${f.todos.length - done} open, ${done} done (sova_todos lists them)`;
}
