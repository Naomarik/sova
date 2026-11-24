/**
 * Compressing one archived chat, and deleting a compressed one (§app.session-list/archive-compression).
 * Nothing is dropped: every file is written compressed, read back and checked against the original
 * (size and sha256) before the original goes, and the entry naming what was made is saved first. A
 * failure at any step leaves the originals as they were (a half-written compressed file is removed).
 *
 * The caller (sessions-index cleanupSessions, `action: "compress"`) has already made every check Clean Up
 * makes: archived, not live, not busy, not just written, not an organization's or the Overseer's.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip, constants as zc } from "node:zlib";
import type { SessionSummary } from "../../shared/protocol";
import { chatHome, forgetHome, hasHome, homeIdOfPath, homesRoot } from "../chat-homes/root";
import { forgetHomeRecords } from "../chat-homes/records";
import { compressedChats, type CompressedChat, type CompressedFile, dropCompressed, putCompressed } from "./store";
import { readTarGz, sameEntries, writeTarGz } from "./tar";

/** The row a compressed chat keeps: as it was, marked, with nothing live or held (§app.session-list/archive-compression "In the list"). */
export function keptRow(row: SessionSummary): SessionSummary {
  const { chat: _chat, workers: _workers, jobsRunning: _jobs, hasDraft: _draft, draftPreview: _preview, ...rest } = row;
  return { ...rest, live: null, busy: false, archived: true, compressed: true };
}

async function sha256Of(file: string, gunzip = false): Promise<{ sha256: string; size: number }> {
  const h = createHash("sha256");
  let size = 0;
  const sink = async function* (src: AsyncIterable<Buffer>) {
    for await (const c of src) {
      h.update(c);
      size += c.length;
    }
  };
  if (gunzip) await pipeline(createReadStream(file), createGunzip(), sink);
  else await pipeline(createReadStream(file), sink);
  return { sha256: h.digest("hex"), size };
}

function rmQuiet(p: string): void {
  try {
    rmSync(p, { force: true, recursive: true });
  } catch {
    // best effort: a leftover temp file is harmless and never listed
  }
}

/** The home a session file is the chat's conversation of, when it has one (else null: an older chat). */
export function homeOfChat(path: string): string | null {
  const id = homeIdOfPath(path);
  return id && hasHome(id) ? id : null;
}

/** Compresses a chat with a home: the whole home becomes `<homes root>/<id>.tar.gz`, then the home folder goes. */
async function compressHome(id: string, row: SessionSummary, by: CompressedChat["by"]): Promise<CompressedChat> {
  const home = chatHome(id);
  const archive = join(homesRoot(), `${id}.tar.gz`);
  const tmp = `${archive}.${process.pid}.tmp`;
  try {
    const want = await writeTarGz(home, tmp);
    const got = await readTarGz(tmp);
    if (!sameEntries(want, got)) throw new Error("the compressed home doesn't read back as the home");
    renameSync(tmp, archive);
  } catch (err) {
    rmQuiet(tmp);
    throw err;
  }
  const entry: CompressedChat = { id, kind: "home", at: new Date().toISOString(), by, row: keptRow(row), archive, home };
  putCompressed(entry);
  // Forgotten first: a store write in flight finds no home and never makes part of it again.
  forgetHome(id);
  forgetHomeRecords(id);
  rmSync(home, { recursive: true, force: true });
  return entry;
}

/** Compresses an older chat: its own and each helper's conversation file, each to `<file>.gz` where it is. */
async function compressFiles(id: string, row: SessionSummary, helpers: readonly string[], by: CompressedChat["by"]): Promise<CompressedChat> {
  const paths = [row.path, ...helpers.filter((p) => p !== row.path && existsSync(p))];
  const made: CompressedFile[] = [];
  try {
    for (const path of paths) {
      const gz = `${path}.gz`;
      const tmp = `${gz}.${process.pid}.tmp`;
      const want = await sha256Of(path);
      await pipeline(createReadStream(path), createGzip({ level: zc.Z_BEST_COMPRESSION }), createWriteStream(tmp, { mode: statSync(path).mode & 0o777 }));
      const got = await sha256Of(tmp, true);
      if (got.sha256 !== want.sha256 || got.size !== want.size) {
        rmQuiet(tmp);
        throw new Error(`${path} doesn't read back as it was`);
      }
      renameSync(tmp, gz);
      made.push({ path, gz, size: want.size, sha256: want.sha256 });
    }
  } catch (err) {
    // Nothing of a half-done chat stays compressed: its originals are all still there.
    for (const f of made) rmQuiet(f.gz);
    throw err;
  }
  const entry: CompressedChat = { id, kind: "files", at: new Date().toISOString(), by, row: keptRow(row), files: made };
  putCompressed(entry);
  for (const f of made) unlinkSync(f.path);
  return entry;
}

/**
 * Compresses one chat. `row`: its row as the list has it now. `helpers`: an older chat's helpers'
 * conversation files (a homed chat's are in its home). Throws when nothing was compressed.
 */
export async function compressChat(row: SessionSummary, helpers: readonly string[], by: CompressedChat["by"]): Promise<CompressedChat> {
  const home = homeOfChat(row.path);
  return home ? compressHome(home, row, by) : compressFiles(row.id, row, helpers, by);
}

/** Your Delete of a compressed chat: its compressed files (a homed chat's compressed home), then its entry. */
export function deleteCompressed(id: string): boolean {
  const e = compressedChats()[id];
  if (!e) return false;
  if (e.kind === "home" && e.archive) rmQuiet(e.archive);
  for (const f of e.files ?? []) rmQuiet(f.gz);
  dropCompressed(id);
  return true;
}

/** The folder a compressed home was in (tests, rollback). */
export const homeParent = (e: CompressedChat): string | null => (e.archive ? dirname(e.archive) : null);

/**
 * A compress cut short (the server stopped between saving the entry and removing the originals): the
 * originals of each entry whose compressed copy is there go now. Each copy was read back and checked
 * before its entry was saved, so nothing is lost. Run before the first automatic pass.
 */
export function finishPending(): number {
  let n = 0;
  for (const e of Object.values(compressedChats())) {
    if (e.kind === "home" && e.home && e.archive && existsSync(e.archive) && existsSync(e.home)) {
      rmQuiet(e.home);
      forgetHome(e.id);
      forgetHomeRecords(e.id);
      n++;
    }
    for (const f of e.files ?? [])
      if (existsSync(f.gz) && existsSync(f.path)) {
        rmQuiet(f.path);
        n++;
      }
  }
  return n;
}
