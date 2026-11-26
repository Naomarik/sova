/**
 * Every homed conversation file, for the session list's full build (§app.chat-homes/change-log): from the homes
 * index, not one folder read per home. A home's `sessions/` folder is read again only when something says it changed:
 * a line of the change log names the home (a new chat, a fork, a helper, an arrival, a delete), or the session feed's
 * watch noted a file in it (noteHomeSessionPath). The backstop sweep reads every one: BACKSTOP_MS after the last, when
 * lines may have gone by unread, and shortly after a start that began from the index on disk. A file made in a home
 * with neither (a program writing there behind Sova's back) is listed at that sweep: late, never lost.
 *
 * The index is kept in `<homes root>/.index.json` (changes.ts) so a restart starts from it; a missing, torn or unknown
 * one is rebuilt by reading every home once.
 */
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { BACKSTOP_MS } from "./records";
import { homeIdOfPath, homesRoot, isHomeSessionFile, listHomeIds, onHomesRootSwitch } from "./root";
import { appendChange, onChanges, pollChanges, readIndex, startTail, tailCursor, writeIndex, type IndexedHome } from "./changes";

/** After a start from the index on disk, the backstop sweep runs this much later (the first list is the index's). */
const START_SWEEP_MS = 30_000;
/** The index file is written at most this often (the next write waits on a timer). */
const INDEX_WRITE_MS = 10_000;

type Held = IndexedHome;

interface State {
  root: string;
  homes: Map<string, Held>;
  dirty: Set<string>;
  sweptAt: number;
  sweepNow: boolean;
  changed: boolean;
  writtenAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** The pending write, run now (a reset). */
  flush?: () => void;
}

/** Folder reads and stats the listing did (the bench and tests count them). */
export const sessionFilesIo = { readdirs: 0, stats: 0, sweeps: 0, fromIndex: 0 };

let st: State | null = null;

function state(): State {
  const root = homesRoot();
  if (st && st.root === root) return st;
  if (st?.timer) clearTimeout(st.timer);
  const idx = readIndex(root);
  // The log from where the index left off: what changed since is read again.
  startTail(root, idx?.cursor);
  const homes = new Map<string, Held>();
  // An index read back holds no read time: each folder whose stat still matches is trusted unless it's recent.
  if (idx) for (const [id, h] of Object.entries(idx.homes)) homes.set(id, { files: h.files, st: h.st });
  st = { root, homes, dirty: new Set(), sweptAt: idx ? Date.now() - BACKSTOP_MS + START_SWEEP_MS : 0, sweepNow: !idx, changed: !idx, writtenAt: 0, timer: null };
  return st;
}

onChanges((root, lines, gap) => {
  const s = st;
  if (!s || s.root !== root) return;
  if (gap) s.sweepNow = true;
  for (const l of lines) if (l.d === "sessions" || l.d === "home" || l.d === "gone") s.dirty.add(l.h);
});

async function stampOf(dir: string): Promise<{ st: string } | null> {
  sessionFilesIo.stats++;
  try {
    const s = await stat(dir);
    return { st: `${s.ino}:${s.mtimeMs}` };
  } catch {
    return null;
  }
}

/** Every `<homes root>/<id>/sessions/<name>.jsonl` of this state root's homes: real files only, never a dot-file (a
    worker fork's temporary source copy). */
export async function homeSessionFiles(): Promise<string[]> {
  const s = state();
  const root = s.root;
  pollChanges(root);
  const cursor = tailCursor(root);
  const now = Date.now();
  const full = s.sweepNow || now - s.sweptAt >= BACKSTOP_MS || now < s.sweptAt;
  if (full) {
    sessionFilesIo.sweeps++;
    s.sweptAt = now;
    s.sweepNow = false;
  }
  const dirty = s.dirty;
  s.dirty = new Set();
  const ids = listHomeIds();
  const out: string[][] = [];
  await Promise.all(
    ids.map(async (id, i) => {
      const dir = join(root, id, "sessions");
      const held = s.homes.get(id);
      if (!full && held && !dirty.has(id)) {
        sessionFilesIo.fromIndex++;
        out[i] = held.files.map((f) => join(dir, f));
        return;
      }
      // The stat first: a file landing during the read moves it again, so the index never holds a stamp newer than its list.
      const stamp = await stampOf(dir);
      sessionFilesIo.readdirs++;
      let files: string[] = [];
      try {
        for (const f of await readdir(dir, { withFileTypes: true })) if (f.isFile() && f.name.endsWith(".jsonl") && !f.name.startsWith(".")) files.push(f.name);
      } catch {
        // missing or unreadable: none
      }
      const st = stamp?.st ?? "";
      if (!held || held.st !== st || held.files.length !== files.length || held.files.some((f, k) => f !== files[k])) s.changed = true;
      s.homes.set(id, { files, st });
      out[i] = files.map((f) => join(dir, f));
    }),
  );
  if (s.homes.size > ids.length) {
    const live = new Set(ids);
    for (const id of s.homes.keys())
      if (!live.has(id)) {
        s.homes.delete(id);
        s.changed = true;
      }
  }
  saveIndexSoon(s, cursor);
  return out.flat();
}

function saveIndexSoon(s: State, cursor: { seg: number; off: number }): void {
  if (!s.changed) return;
  const write = () => {
    s.timer = null;
    s.flush = undefined;
    s.changed = false;
    s.writtenAt = Date.now();
    const homes: Record<string, IndexedHome> = {};
    for (const [id, h] of s.homes) homes[id] = { files: h.files, st: h.st };
    writeIndex(s.root, { v: 1, cursor, homes });
  };
  if (Date.now() - s.writtenAt >= INDEX_WRITE_MS) return write();
  if (!s.timer) {
    s.flush = write;
    s.timer = setTimeout(write, INDEX_WRITE_MS);
    s.timer.unref?.();
  }
}

/**
 * The session feed's watch saw `path` change. A homed conversation that is new to the index, or one it holds that is
 * gone, changes its home's files: the home is read at the next listing, and a line in the change log says so, so a
 * restart that starts from an index written before it reads that home too. A write to a file it holds changes nothing.
 */
export function noteHomeSessionPath(path: string): void {
  const s = st;
  if (!s || !isHomeSessionFile(path)) return;
  const id = homeIdOfPath(path);
  if (!id || s.dirty.has(id)) return;
  const held = s.homes.get(id);
  if (held?.files.includes(basename(path)) && existsSync(path)) return;
  s.dirty.add(id);
  appendChange(s.root, id, "sessions");
}

/** Forget what is held (a Chats folder move, tests): the next listing starts from the index on disk. */
export function resetHomeSessionFiles(): void {
  const s = st;
  st = null;
  if (s?.timer) {
    clearTimeout(s.timer);
    s.flush?.();
  }
}

onHomesRootSwitch(resetHomeSessionFiles);

/** Tests: a crash (what is held goes, a pending index write with it). */
export function crashHomeSessionFilesForTest(): void {
  if (st?.timer) clearTimeout(st.timer);
  st = null;
}

/** Tests: the next listing reads every folder, as the backstop sweep does. */
export function expireHomeSessionFilesSweepForTest(): void {
  if (st) st.sweptAt = 0;
}
