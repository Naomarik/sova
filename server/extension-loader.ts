// The list Sova writes and what you approve: adding, approving, Turn On, Turn Off,
// Remove and Choose Folder, each on your own page only (server/extension-routes.ts), and the background pass,
// about every 3 s while anything is listed, that notices changed code, a folder gone, an entry taken off the list
// by hand and a program that stopped. With nothing listed and nothing kept it stops, and only the list's own
// change wakes it: no folder is read, no program started.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { approvalOf, approvedIds, codeReadingOf, entryHash, forgetApproval, forgetCodeReading, migrateTrust, recordApproval, setCodeReading, versionOf, type ExtensionApproval } from "./extension-gate";
import { codeFoldersOf, codeHash, codeHashNow, codeSig, codeSigNow } from "./extension-fingerprint";
import type { ExtensionInspect, ExtensionReview } from "../shared/extension-loader";
import { asksOf, readDescription } from "./extension-description";
import { extensionKeys, realClock, SYNC_MS, wakeExtensionKeys } from "./extension-keys";
import { clearHealthOf, contractWords, extensionsFile, listedExtension, listedExtensions, tellPeersOfExtensions, validExtensionId, type ListedExtension } from "./extensions";
import { extensionDataDir, freePort, ProgramNotFound, programStatus, programUnits, startProgram, stopProgram } from "./extension-program";
import { releaseViewWaiters } from "./card-views";
import { cardOwnersChanged, closeCardsOfExtension, setCardsTrusted } from "./transcript-cards";

export class LoaderRefusal extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409, readonly code?: string) {
    super(message);
  }
}

const named = (): boolean => !!process.env.SOVA_EXTENSIONS_FILE;
const CHANGED = "This extension changed since you looked. Check what it asks for, then approve it again.";
const skipDir = (raw: Record<string, unknown>) => (typeof raw.id === "string" && validExtensionId(raw.id) ? extensionDataDir(raw.id) : undefined);

// ---- the list ------------------------------------------------------------------------------------

/** Inside a git checkout: the file is someone's source, and a save would dirty it. */
function inCheckout(path: string): boolean {
  for (let dir = dirname(path), up = dirname(dir); ; dir = up, up = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return true;
    if (up === dir) return false;
  }
}

/** Read, change and write the list whole, keeping other entries and every key Sova doesn't know. */
function changeList(change: (entries: unknown[]) => void): void {
  const file = extensionsFile();
  let doc: Record<string, unknown> = { version: 1, extensions: [] };
  let text: string | null = null;
  let path = file;
  try {
    if (lstatSync(file).isSymbolicLink()) {
      path = realpathSync(file);
      if (inCheckout(path)) throw new LoaderRefusal("Sova can't change the list: it's a link into a git checkout. Edit it there. Nothing was changed.", 409, "list");
    }
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err instanceof LoaderRefusal) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new LoaderRefusal("Sova can't change the list: it can't be read whole. Nothing was changed.", 409, "list");
  }
  if (text !== null) {
    try {
      doc = JSON.parse(text) as Record<string, unknown>;
    } catch {
      doc = null as unknown as Record<string, unknown>;
    }
    if (!doc || doc.version !== 1 || !Array.isArray(doc.extensions)) throw new LoaderRefusal("Sova can't change the list: it can't be read whole. Nothing was changed.", 409, "list");
  }
  change(doc.extensions as unknown[]);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
  renameSync(tmp, path);
}

const isEntry = (r: unknown, id: string): r is Record<string, unknown> => typeof r === "object" && r !== null && (r as { id?: unknown }).id === id;

function putEntry(entry: Record<string, unknown>): void {
  changeList((list) => {
    const i = list.findIndex((r) => isEntry(r, entry.id as string));
    if (i >= 0) list[i] = entry;
    else list.push(entry);
  });
}

function setOff(id: string, off: boolean): void {
  changeList((list) => {
    const e = list.find((r) => isEntry(r, id));
    if (!e) throw new LoaderRefusal("No such extension.", 404);
    const rec = e as Record<string, unknown>;
    if (off) rec.off = true;
    else delete rec.off;
  });
}

/** Whatever changed what is active: the keys follow at once, and peers hear. */
function activeMoved(): void {
  releaseViewWaiters();
  wakeExtensionKeys();
  tellPeersOfExtensions();
  cardOwnersChanged();
  noteLastActive();
  wakePass();
}

// ---- what you approve ----------------------------------------------------------------------------

const hasRun = (raw: Record<string, unknown>): boolean => Array.isArray(raw.run) && raw.run.length > 0;

/** The record approved for `described`, over the one on the list: its keys replaced, others kept, its port kept. */
function mergedEntry(described: Record<string, unknown>, was: Record<string, unknown> | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(was ?? {}) };
  for (const k of ["description", "icon", "dist", "run", "programFolder", "commands", "screens", "cards", "drawings", "needsContract"]) delete out[k];
  Object.assign(out, described);
  if (!hasRun(described)) {
    // A program it no longer names: the port goes too. A hand-written `api` with no `run` stays what it was.
    if (was && hasRun(was)) delete out.api;
  }
  return out;
}

/** What Review shows of an entry on the list, or of a folder: its record as it would be approved, and that version. */
export async function versionOfRaw(raw: Record<string, unknown>): Promise<{ version: string; entry: string; code: string; sig: string }> {
  const folders = codeFoldersOf(raw, skipDir(raw));
  const sig = await codeSig(folders);
  const code = await codeHash(folders);
  const entry = entryHash(raw);
  return { version: versionOf(entry, code), entry, code, sig };
}

/** Review's reading of an entry on the list: a folder's re-read description, or the hand-written record as it stands. */
export function candidateOf(l: ListedExtension): { ok: true; raw: Record<string, unknown>; leftOut?: string[] } | { ok: false; reason: string } {
  if (typeof l.raw.folder !== "string") return { ok: true, raw: l.raw };
  const d = readDescription(l.raw.folder, l.valid?.entry.id);
  if (!d.ok) return d;
  if (d.described.entry.id !== l.valid?.entry.id) return { ok: false, reason: `This folder now describes ${d.described.entry.id}, not ${l.valid?.entry.id}.` };
  return { ok: true, raw: mergedEntry(d.described.entry, l.raw), leftOut: d.described.leftOut };
}

/** One thing at a time per program: a start racing the pass's own start would lose its port. */
const programQueue = new Map<string, Promise<unknown>>();
function oneAtATime<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (programQueue.get(id) ?? Promise.resolve()).then(fn, fn);
  const settled = run.catch(() => {});
  programQueue.set(id, settled);
  void settled.then(() => {
    if (programQueue.get(id) === settled) programQueue.delete(id);
  });
  return run;
}
const stopOne = (id: string): Promise<void> => oneAtATime(id, () => stopProgram(id));

async function startNow(raw: Record<string, unknown>, restart: boolean, you: boolean): Promise<void> {
  const id = raw.id as string;
  if (restart) await stopProgram(id);
  if (you) {
    stopped.delete(id);
    recentStarts.delete(id);
  }
  noteStart(id);
  try {
    await startProgram({ id, run: raw.run as string[], folder: raw.folder as string, api: raw.api as string });
    notFound.delete(id);
  } catch (err) {
    if (!(err instanceof ProgramNotFound)) throw err;
    notFound.set(id, err.message);
  }
}

/**
 * Before a new build of a view is handed over: the code folders read afresh, because a save reaches a page
 * within a second and the pass may not have come yet. Without holding up other requests.
 */
export async function codeStillApproved(id: string): Promise<boolean> {
  if (named()) return true;
  const l = listedExtension(id);
  const a = approvalOf(id);
  if (!l || !a) return false;
  const folders = codeFoldersOf(l.raw, skipDir(l.raw));
  const sig = await codeSig(folders);
  const was = codeReadingOf(id);
  const code = a.sig === sig ? a.code : was?.sig === sig && was.code ? was.code : await codeHash(folders);
  setCodeReading(id, { sig, code });
  return code === a.code;
}

/** An address for a program that has none: its own port, once. Whichever way an entry is approved. */
async function givePort(raw: Record<string, unknown>): Promise<void> {
  if (hasRun(raw) && typeof raw.api !== "string") raw.api = `http://127.0.0.1:${await freePort()}`;
}

/** A unit still running: an approved version with no program leaves nothing behind it. */
async function stopIfRunning(id: string): Promise<void> {
  const st = await programStatus(id);
  if (st.state === "active" || st.state === "activating") await stopOne(id);
}

/** What an approval does to the program: the version with one starts, unless it's off; one with none stops the old one. */
function settleProgram(raw: Record<string, unknown>): Promise<void> {
  if (!hasRun(raw)) return stopIfRunning(raw.id as string);
  return raw.off === true ? Promise.resolve() : startIfProgram(raw, true);
}

/** Your own start, restart or approval: it clears a stop and the count of recent starts. */
function startIfProgram(raw: Record<string, unknown>, restart: boolean): Promise<void> {
  if (!hasRun(raw) || typeof raw.api !== "string") return Promise.resolve();
  return oneAtATime(raw.id as string, () => startNow(raw, restart, true));
}

/** Review, of a folder: the one reason it can't be used, or all it states, at the version Install must carry back. */
export async function reviewFolder(folder: string, self?: string): Promise<ExtensionInspect> {
  const d = readDescription(folder, self);
  if (!d.ok) return d;
  if (self !== undefined && d.described.entry.id !== self) return { ok: false, reason: `This folder describes ${d.described.entry.id}, not ${self}.` };
  const raw = mergedEntry(d.described.entry, listedExtension(d.described.entry.id)?.raw);
  delete raw.off;
  return { ok: true, review: await reviewOf(raw, d.described.needs, d.described.leftOut) };
}

/** Review, of an entry on the list (Waiting for You, Changed). */
export async function reviewEntry(id: string): Promise<ExtensionInspect> {
  const l = listedExtension(id);
  if (!l) throw new LoaderRefusal("No such extension.", 404);
  const c = candidateOf(l);
  if (!c.ok) return c;
  const needs = typeof c.raw.needsContract === "string" ? c.raw.needsContract : undefined;
  return { ok: true, review: await reviewOf(c.raw, needs, c.leftOut) };
}

async function reviewOf(raw: Record<string, unknown>, needs: string | undefined, leftOut: string[] | undefined): Promise<ExtensionReview> {
  const id = raw.id as string;
  const title = typeof raw.title === "string" && raw.title ? raw.title : id;
  const stated = asksOf(raw, id, title);
  return {
    id,
    title,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(typeof raw.folder === "string" ? { folder: raw.folder } : {}),
    version: (await versionOfRaw(raw)).version,
    asks: stated.asks,
    ...(needs ? { needs } : {}),
    has: contractWords(),
    leftOut: leftOut ?? stated.leftOut,
    ...(hasRun(raw) ? { noServiceManager: true } : {}),
  };
}

/** Install and Turn On: from the folder Review read, at the version Review showed. Nothing runs before this. */
export async function installFolder(folder: string, version: unknown): Promise<string> {
  const d = readDescription(folder);
  if (!d.ok) throw new LoaderRefusal(d.reason, 400, "invalid");
  const was = listedExtension(d.described.entry.id);
  const raw = mergedEntry(d.described.entry, was?.raw);
  delete raw.off;
  const v = await versionOfRaw(raw);
  if (version !== v.version) throw new LoaderRefusal(CHANGED, 409, "changed");
  await givePort(raw);
  // Approved first: the entry is never live under an older approval.
  recordApproval(raw.id as string, { version: v.version, entry: v.entry, code: v.code, sig: v.sig });
  setCodeReading(raw.id as string, { sig: v.sig, code: v.code });
  putEntry(raw);
  const started = settleProgram(raw);
  activeMoved();
  await started;
  return raw.id as string;
}

/** Approve one on the list, at the version Review showed: the description re-read into the entry. */
export async function approveExtension(id: string, version: unknown): Promise<void> {
  const l = listedExtension(id);
  if (!l) throw new LoaderRefusal("No such extension.", 404);
  const c = candidateOf(l);
  if (!c.ok) throw new LoaderRefusal(c.reason, 409, "invalid");
  const v = await versionOfRaw(c.raw);
  if (version !== v.version) throw new LoaderRefusal(CHANGED, 409, "changed");
  const raw = { ...c.raw };
  await givePort(raw);
  recordApproval(id, { version: v.version, entry: v.entry, code: v.code, sig: v.sig });
  setCodeReading(id, { sig: v.sig, code: v.code });
  putEntry(raw);
  const started = settleProgram(raw);
  activeMoved();
  await started;
}

/** Choose Folder: the same id from another folder, after the same review. */
export async function chooseFolder(id: string, folder: string, version: unknown): Promise<void> {
  const l = listedExtension(id);
  if (!l) throw new LoaderRefusal("No such extension.", 404);
  const d = readDescription(folder, id);
  if (!d.ok) throw new LoaderRefusal(d.reason, 400, "invalid");
  if (d.described.entry.id !== id) throw new LoaderRefusal(`This folder describes ${d.described.entry.id}, not ${id}.`, 400, "invalid");
  const raw = mergedEntry(d.described.entry, l.raw);
  const v = await versionOfRaw(raw);
  if (version !== v.version) throw new LoaderRefusal(CHANGED, 409, "changed");
  await givePort(raw);
  recordApproval(id, { version: v.version, entry: v.entry, code: v.code, sig: v.sig });
  setCodeReading(id, { sig: v.sig, code: v.code });
  putEntry(raw);
  const started = settleProgram(raw);
  activeMoved();
  await started;
}

export async function turnOn(id: string): Promise<void> {
  const l = listedExtension(id);
  if (!l) throw new LoaderRefusal("No such extension.", 404);
  setOff(id, false);
  const now = listedExtension(id);
  const started = now?.state === "on" ? startIfProgram(now.raw, false) : Promise.resolve();
  activeMoved();
  await started;
}

export async function turnOff(id: string): Promise<void> {
  if (!listedExtension(id)) throw new LoaderRefusal("No such extension.", 404);
  setOff(id, true);
  activeMoved();
  stopped.delete(id);
  await stopOne(id);
}

/** Start, Restart Program, or stop it: only while it is what you approved. */
export async function programAction(id: string, action: unknown): Promise<void> {
  const l = listedExtension(id);
  if (!l) throw new LoaderRefusal("No such extension.", 404);
  if (action === "stop") {
    stopped.add(id);
    await stopOne(id);
    return;
  }
  if (action !== "start" && action !== "restart") throw new LoaderRefusal("Expected action: start, restart or stop.", 400, "invalid");
  if (l.state !== "on") throw new LoaderRefusal("This extension isn't on, so its program won't start.", 409, "invalid");
  if (!hasRun(l.raw)) throw new LoaderRefusal("You run this program yourself, so Sova doesn't start or stop it.", 409, "invalid");
  // Only a start checks the version: code changed a moment ago never runs unseen.
  if (!named()) {
    const v = await versionOfRaw(l.raw);
    if (approvalOf(id)?.code !== v.code) {
      setCodeReading(id, { sig: v.sig, code: v.code });
      throw new LoaderRefusal(CHANGED, 409, "changed");
    }
  }
  await startIfProgram(l.raw, action === "restart");
}

/** What Remove and an entry leaving the list by hand both do. */
async function forget(id: string, deleteData = false): Promise<void> {
  // A name no valid entry can have, from a hand-edited file, reaches no unit, cards or data folder: only its approval goes.
  const real = validExtensionId(id);
  if (real) await stopOne(id);
  forgetApproval(id);
  forgetCodeReading(id);
  clearHealthOf(id);
  stopped.delete(id);
  notFound.delete(id);
  recentStarts.delete(id);
  absent.delete(id);
  if (!real) return;
  setCardsTrusted(`ext:${id}`, false);
  closeCardsOfExtension(id);
  if (deleteData) rmSync(extensionDataDir(id), { recursive: true, force: true });
}

/** Remove. `key`: an id, or `~<place>` for a dropped entry with none. The folder is never touched. */
export async function removeExtension(key: string, deleteData: boolean): Promise<void> {
  if (key.startsWith("~")) {
    const at = Number(key.slice(1));
    changeList((list) => {
      if (!Number.isInteger(at) || at < 0 || at >= list.length) throw new LoaderRefusal("No such extension.", 404);
      list.splice(at, 1);
    });
    return;
  }
  const list = listedExtensions();
  if (list === null) throw new LoaderRefusal("Sova can't change the list: it can't be read whole. Nothing was changed.", 409, "list");
  const id = key;
  if (!list.some((l) => l.valid?.entry.id === id || l.raw.id === id)) throw new LoaderRefusal("No such extension.", 404);
  changeList((entries) => {
    for (let i = entries.length - 1; i >= 0; i--) if (isEntry(entries[i], id)) entries.splice(i, 1);
  });
  activeMoved();
  await forget(id, deleteData);
}

// ---- the program's watch -------------------------------------------------------------------------

/** Stopped with Stop: not started again until Start or the next server start. */
const stopped = new Set<string>();
/** What a start couldn't find, for the row. */
const notFound = new Map<string, string>();
const startedAt = new Map<string, number>();
const recentStarts = new Map<string, number[]>();
const START_BURST = 5;
const START_WINDOW_MS = 60_000;
const noteStart = (id: string) => {
  const now = Date.now();
  startedAt.set(id, now);
  recentStarts.set(id, [...(recentStarts.get(id) ?? []).filter((t) => now - t < START_WINDOW_MS), now]);
};
export const programStartedAt = (id: string): number | undefined => startedAt.get(id);
export const programNotFound = (id: string): string | undefined => notFound.get(id);

/** One failed program, while what it runs is what you approved. Read again in its turn: a stop may have come first. */
const watchProgram = (id: string): Promise<void> =>
  oneAtATime(id, async () => {
    const l = listedExtension(id);
    if (!l || l.state !== "on" || !hasRun(l.raw) || typeof l.raw.api !== "string" || stopped.has(id) || notFound.has(id)) return;
    const st = await programStatus(id);
    if (st.state === "active" || st.state === "activating") return;
    const recent = (recentStarts.get(id) ?? []).filter((t) => Date.now() - t < START_WINDOW_MS);
    if (recent.length >= START_BURST) return;
    // Only a start checks the version.
    if (!named()) {
      const v = await versionOfRaw(l.raw);
      setCodeReading(id, { sig: v.sig, code: v.code });
      if (approvalOf(id)?.code !== v.code) return;
    }
    await startNow(l.raw, false, false).catch((err) => console.warn(`[extensions] ${id}: start failed: ${(err as Error).message}`));
  });

// ---- the background pass -------------------------------------------------------------------------

/** Ids missing from whole reads in a row, as the key sync counts them: a save that moves the file away keeps them. */
const absent = new Map<string, number>();
const LEAVE_AFTER = 2;
let known = new Set<string>();
let lastActive = "";
const activeWords = (list: ListedExtension[]): string => list.filter((l) => l.active).map((l) => `${l.valid!.entry.id}:${l.state}`).join("\n");
const noteLastActive = (): void => {
  lastActive = activeWords(listedExtensions() ?? []);
};

/** Read one entry's code as the pass does: the sig, and the hash only when the sig moved. */
async function readCode(l: ListedExtension): Promise<void> {
  const id = l.valid!.entry.id;
  const folder = l.raw.folder;
  if (typeof folder === "string" && !isFolder(folder)) {
    setCodeReading(id, { sig: "", missing: true });
    return;
  }
  if (named()) {
    forgetCodeReading(id);
    return;
  }
  if (!approvalOf(id)) return;
  const folders = codeFoldersOf(l.raw, skipDir(l.raw));
  const sig = await codeSig(folders);
  const was = codeReadingOf(id);
  if (was?.sig === sig && !was.missing) return;
  const a = approvalOf(id);
  setCodeReading(id, { sig, code: a?.sig === sig ? a.code : await codeHash(folders) });
}

const isFolder = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

let passing = false;
/** One pass. Never throws. */
export async function loaderPass(): Promise<void> {
  if (passing) return;
  passing = true;
  try {
    const list = listedExtensions();
    if (list === null) return; // a list that can't be read whole changes nothing
    const ids = new Set(list.flatMap((l) => (l.valid ? [l.valid.entry.id] : [])));
    // Off the list by hand: Remove's clean-up, data kept.
    for (const id of [...new Set([...known, ...absent.keys(), ...(named() ? [] : approvedIds())])]) {
      if (ids.has(id)) {
        absent.delete(id);
        continue;
      }
      const n = (absent.get(id) ?? 0) + 1;
      if (n >= LEAVE_AFTER) await forget(id);
      else absent.set(id, n);
    }
    known = ids;
    for (const l of list) if (l.valid) await readCode(l);
    const after = listedExtensions() ?? list;
    let units: Set<string> | null = null;
    for (const l of after) {
      if (!l.valid) continue;
      const id = l.valid.entry.id;
      if (!hasRun(l.raw)) {
        // No program on the entry: a unit under its name is what an older version left.
        units ??= new Set(await programUnits());
        if (units.has(id)) await stopIfRunning(id);
      } else if (l.state === "folder-not-found" || l.state === "needs-newer" || l.state === "waiting" || l.state === "off") {
        // A folder gone stops the program; anything else that isn't active does too.
        await stopIfRunning(id);
      } else await watchProgram(id);
    }
    const words = activeWords(after);
    if (words !== lastActive) {
      lastActive = words;
      releaseViewWaiters();
      wakeExtensionKeys();
      tellPeersOfExtensions();
      cardOwnersChanged();
    }
  } catch (err) {
    console.warn(`[extensions] the pass failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    passing = false;
  }
}

/** Nothing listed and nothing kept: the pass can wait for the list to change. */
const idle = (): boolean => !known.size && !absent.size && !(named() ? 0 : approvedIds().length) && !(listedExtensions() ?? [1]).length;

let wakePass: () => void = () => {};

/**
 * At a server start, before it answers anything: the first start's approvals, then a whole reading of what is
 * approved, so nothing changed is served even once. Then units back to the list, a pass every SYNC_MS while
 * anything is listed, and a wait on the list's folder otherwise. Returns the stop (tests).
 */
export function startExtensionLoader(): () => void {
  if (!named()) {
    migrateTrust(() => {
      const out: Record<string, ExtensionApproval> = {};
      for (const l of listedExtensions() ?? []) {
        if (!l.valid) continue;
        const folders = codeFoldersOf(l.raw, skipDir(l.raw));
        const entry = entryHash(l.raw);
        const code = codeHashNow(folders);
        out[l.valid.entry.id] = { version: versionOf(entry, code), entry, code, sig: codeSigNow(folders), at: new Date().toISOString() };
      }
      return out;
    });
  }
  // Whole, now: the listener answers nothing until this returns.
  for (const l of listedExtensions() ?? []) {
    if (!l.valid) continue;
    const id = l.valid.entry.id;
    if (typeof l.raw.folder === "string" && !isFolder(l.raw.folder)) {
      setCodeReading(id, { sig: "", missing: true });
      continue;
    }
    const a = named() ? undefined : approvalOf(id);
    if (!a) continue;
    const folders = codeFoldersOf(l.raw, skipDir(l.raw));
    const sig = codeSigNow(folders);
    setCodeReading(id, { sig, code: a.sig === sig ? a.code : codeHashNow(folders) });
  }
  const list = listedExtensions() ?? [];
  known = new Set(list.flatMap((l) => (l.valid ? [l.valid.entry.id] : [])));
  noteLastActive();
  extensionKeys.sync();
  void reconcileUnits();

  const clock = realClock();
  let stopTimer: (() => void) | null = null;
  const tick = () => {
    void loaderPass().then(() => {
      if (idle() && stopTimer && watching) {
        stopTimer();
        stopTimer = null;
      }
    });
  };
  const ensure = () => {
    if (!stopTimer) stopTimer = clock.every(tick, SYNC_MS);
  };
  wakePass = () => {
    ensure();
    tick();
  };
  const unwatch = clock.watch(() => {
    if (stopTimer) return;
    if (!idle()) ensure();
    else if ((listedExtensions() ?? []).length) ensure();
  });
  const watching = unwatch !== null;
  if (!watching || !idle()) ensure();
  return () => {
    stopTimer?.();
    stopTimer = null;
    unwatch?.();
    wakePass = () => {};
  };
}

/** Units back to the list at a server start: an active, approved one not running is started; a Changed one is
    not; a unit whose id isn't active, or whose entry names no program, is stopped. Only a start checks the version. */
async function reconcileUnits(): Promise<void> {
  try {
    const list = listedExtensions();
    if (list === null) return;
    const on = new Set(list.filter((l) => l.active && hasRun(l.raw)).map((l) => l.valid!.entry.id));
    for (const id of await programUnits()) if (!on.has(id)) await stopOne(id);
    for (const l of list) if (l.valid && l.state === "on") await watchProgram(l.valid.entry.id);
  } catch (err) {
    console.warn(`[extensions] bringing programs back failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Tests: as a fresh process. */
export function resetLoaderForTest(): void {
  stopped.clear();
  notFound.clear();
  startedAt.clear();
  recentStarts.clear();
  absent.clear();
  known = new Set();
  lastActive = "";
  passing = false;
}
