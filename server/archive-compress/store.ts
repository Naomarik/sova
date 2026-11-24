/**
 * The compressed chats (§app.session-list/archive-compression): `<state root>/compressed-sessions.json`,
 * `{ v: 1, chats: { [id]: CompressedChat } }`. Each entry keeps the chat's row as it was when compressed, so
 * the list shows it without reading anything compressed, and names every compressed file it made. A chat
 * with a home also gets the same entry beside its compressed home (`<homes root>/<id>.compressed.json`),
 * so the home's record travels with it (backup, rollback).
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionSummary } from "../../shared/protocol";
import { homeIdOfPath } from "../chat-homes/root";
import { sessionsChanged } from "../list-generation";
import { stateRoot } from "../state-root";

export interface CompressedFile {
  /** The conversation file as it was (absolute). */
  path: string;
  /** Its compressed copy: `<path>.gz`. */
  gz: string;
  size: number;
  sha256: string;
}

export interface CompressedChat {
  id: string;
  /** "home": the whole home is one `<homes root>/<id>.tar.gz`; "files": each conversation file gzipped where it was. */
  kind: "home" | "files";
  /** When it was compressed (ISO), and by what. */
  at: string;
  by: "auto" | "user";
  /** The row as it was, with `compressed: true` and nothing live. */
  row: SessionSummary;
  /** kind "home": the compressed home, and the home folder it was. */
  archive?: string;
  home?: string;
  /** kind "files": the chat's own conversation and its helpers'. */
  files?: CompressedFile[];
}

interface StoreFile {
  v: 1;
  chats: Record<string, CompressedChat>;
}

export const storeFile = (): string => join(stateRoot(), "compressed-sessions.json");

let cache: { file: string; stamp: string; checked: number; data: StoreFile } | null = null;
const CHECK_MS = 1000;

function stamp(file: string): string {
  try {
    const st = statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return "";
  }
}

function load(file: string): StoreFile {
  try {
    const v = JSON.parse(readFileSync(file, "utf8")) as StoreFile;
    if (v && v.v === 1 && v.chats && typeof v.chats === "object" && !Array.isArray(v.chats)) return v;
  } catch {
    // missing or unreadable: none compressed
  }
  return { v: 1, chats: {} };
}

/** The store as the file has it, re-read when its stat changes (another process's write shows within a second). */
export function compressedChats(): Readonly<Record<string, CompressedChat>> {
  const file = storeFile();
  const now = Date.now();
  if (cache && cache.file === file && now - cache.checked < CHECK_MS) return cache.data.chats;
  const s = stamp(file);
  if (!cache || cache.file !== file || cache.stamp !== s) cache = { file, stamp: s, checked: now, data: load(file) };
  else cache.checked = now;
  return cache.data.chats;
}

function save(mutate: (chats: Record<string, CompressedChat>) => void): void {
  const file = storeFile();
  const data = load(file);
  mutate(data.chats);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
  cache = { file, stamp: stamp(file), checked: Date.now(), data };
  rows = null;
  sessionsChanged();
}

export function putCompressed(entry: CompressedChat): void {
  if (entry.kind === "home" && entry.archive) {
    const side = sidecarOf(entry.archive);
    const tmp = `${side}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    renameSync(tmp, side);
  }
  save((chats) => {
    chats[entry.id] = entry;
  });
}

export function dropCompressed(id: string): void {
  const e = compressedChats()[id];
  if (e?.kind === "home" && e.archive) {
    try {
      unlinkSync(sidecarOf(e.archive));
    } catch {
      // gone already
    }
  }
  save((chats) => {
    delete chats[id];
  });
}

/** `<homes root>/<id>.tar.gz` → `<homes root>/<id>.compressed.json`. */
export const sidecarOf = (archive: string): string => archive.replace(/\.tar\.gz$/, "") + ".compressed.json";

/** Rows by path, memoized on the store's identity: the same objects while nothing changed, so a list
    comparison sees them unchanged. */
let rows: { chats: Readonly<Record<string, CompressedChat>>; byPath: Map<string, SessionSummary>; byId: Map<string, CompressedChat>; byFile: Map<string, CompressedChat> } | null = null;

function index(): NonNullable<typeof rows> {
  const chats = compressedChats();
  if (rows && rows.chats === chats) return rows;
  const byPath = new Map<string, SessionSummary>();
  const byId = new Map<string, CompressedChat>();
  const byFile = new Map<string, CompressedChat>();
  for (const e of Object.values(chats)) {
    if (!e?.row?.path) continue;
    byPath.set(e.row.path, Object.freeze(e.row));
    byId.set(e.id, e);
    byFile.set(e.row.path, e);
    for (const f of e.files ?? []) byFile.set(f.path, e);
  }
  return (rows = { chats, byPath, byId, byFile });
}

/** The compressed chats' kept rows, for the session list (never a read of anything compressed). */
export const compressedRows = (): ReadonlyMap<string, SessionSummary> => index().byPath;

/** The compressed chat a session path (its conversation file, as its row named it) or a helper's file belongs to. */
export function compressedAt(path: string): CompressedChat | undefined {
  const e = index().byFile.get(path);
  if (e) return e;
  // Any file a compressed home held (a helper's conversation): by the home's id.
  const id = homeIdOfPath(path);
  const h = id ? index().byId.get(id) : undefined;
  return h?.kind === "home" ? h : undefined;
}

export const isCompressedId = (id: string): boolean => index().byId.has(id);

/** The one refusal for a route that would read a compressed chat (§design.copy-deck/archive-compression). */
export const COMPRESSED_REFUSAL = "This chat is compressed, so Sova doesn't open it.";

/** Tests only. */
export function resetCompressedForTests(): void {
  cache = null;
  rows = null;
}
