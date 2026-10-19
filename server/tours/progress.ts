import { randomBytes } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { normalizeTourProgress, tourProgressFits, type TourPresentation, type TourProgress } from "../../shared/tour";
import { stateRoot } from "../state-root";
import { containedPath, digest, readBounded, writePrivate } from "./assets";

export class TourProgressStore {
  constructor(readonly root: string) {}
  private file(scope: string): string { if (!scope || scope.length > 2000) throw new Error("Invalid progress scope."); return join(this.root, "positions", `${digest(scope)}.json`); }
  get(scope: string, manifest: TourPresentation): TourProgress | null {
    const bytes = readBounded(this.root, this.file(scope), 1024);
    try {
      const p = bytes ? normalizeTourProgress(JSON.parse(bytes.toString("utf8"))) : undefined;
      if (!p || p.tourId !== manifest.id) return null;
      // Stable identities may map to a new edition, never an array index or a guessed nearby step.
      const mapped = { ...p, tourId: manifest.id, editionId: manifest.editionId };
      return tourProgressFits(mapped, manifest) ? mapped : null;
    } catch { return null; }
  }
  put(scope: string, manifest: TourPresentation, input: unknown, now = Date.now()): TourProgress {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !["stepId", "viewId", "size"].includes(k))) throw new Error("Choose a recorded tour step, view and picture size.");
    const p = normalizeTourProgress({ ...input, v: 1, tourId: manifest.id, editionId: manifest.editionId, updatedAt: new Date(now).toISOString() });
    if (!p || !tourProgressFits(p, manifest)) throw new Error("That position is not in this edition.");
    const file = this.file(scope), tmp = `${file}-${randomBytes(12).toString("hex")}.tmp`;
    writePrivate(this.root, tmp, JSON.stringify(p)); containedPath(this.root, file, true); renameSync(tmp, file);
    return p;
  }
  deleteScope(scope: string): void {
    const file = this.file(scope); containedPath(this.root, file, true); rmSync(file, { force: true });
  }
  deleteShareReaders(shareHash: string): void {
    if (!/^[a-f0-9]{64}$/.test(shareHash)) throw new Error("Invalid tour share.");
    const file = join(this.root, "readers", `${shareHash}.json`), bytes = readBounded(this.root, file, 80_000);
    const hashes: unknown = bytes ? JSON.parse(bytes.toString("utf8")) : [];
    if (!Array.isArray(hashes) || !hashes.every(h => typeof h === "string" && /^[a-f0-9]{64}$/.test(h))) throw new Error("Tour reader cleanup could not be completed.");
    for (const hash of hashes) this.deleteScope(`public:${shareHash}:${hash}`);
    // Retain the reader inventory if any position removal failed, for a later cleanup sweep.
    containedPath(this.root, file, true); rmSync(file, { force: true });
  }
  /** A random resume capability is hash-only and still requires its original live share token. */
  createReader(shareHash: string): string {
    if (!/^[a-f0-9]{64}$/.test(shareHash)) throw new Error("Invalid tour share.");
    const file = join(this.root, "readers", `${shareHash}.json`);
    let hashes: string[] = [];
    if (existsSync(file)) {
      const bytes = readBounded(this.root, file, 80_000);
      if (!bytes) throw new Error("Tour reader store is unavailable.");
      hashes = JSON.parse(bytes.toString("utf8"));
      if (!Array.isArray(hashes) || !hashes.every(h => typeof h === "string" && /^[a-f0-9]{64}$/.test(h))) throw new Error("Tour reader store is unavailable.");
    }
    if (hashes.length >= 1000) throw new Error("This tour has reached its resume-link limit.");
    const reader = randomBytes(32).toString("base64url"); hashes.push(digest(reader));
    const tmp = `${file}-${randomBytes(12).toString("hex")}.tmp`;
    writePrivate(this.root, tmp, JSON.stringify(hashes)); containedPath(this.root, file, true); renameSync(tmp, file);
    return reader;
  }
  readerScope(shareHash: string, reader: string): string | null {
    if (!/^[a-f0-9]{64}$/.test(shareHash) || !/^[A-Za-z0-9_-]{43}$/.test(reader)) return null;
    const bytes = readBounded(this.root, join(this.root, "readers", `${shareHash}.json`), 80_000);
    try { const rows: unknown = bytes ? JSON.parse(bytes.toString("utf8")) : null; return Array.isArray(rows) && rows.includes(digest(reader)) ? `public:${shareHash}:${digest(reader)}` : null; }
    catch { return null; }
  }
}
export const tourProgress = () => new TourProgressStore(join(stateRoot(), "tour-progress"));
