import { randomBytes } from "node:crypto";
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { isTourHandle, isTourId } from "../../shared/tour";
import { stateRoot } from "../state-root";
import { containedPath, readBounded, writePrivate } from "./assets";
import { isTourSession } from "./store";
export interface TourBindingReference { sessionId: string; tourId: string; editionId: string; destinationSessionId: string; handle: string }
const valid = (r: TourBindingReference): boolean => !!r && Object.keys(r).every(k => ["sessionId", "tourId", "editionId", "destinationSessionId", "handle"].includes(k)) && isTourSession(r.sessionId) && isTourId(r.tourId) && isTourId(r.editionId) && isTourSession(r.destinationSessionId) && isTourHandle(r.handle);
/** A host-local convenience index only. The current conversation branch grants/revokes authority. */
export class TourBindingIndex {
  constructor(readonly root: string) {}
  private file() { return join(this.root, "tour-binding-index.json"); }
  private read(): TourBindingReference[] {
    if (!existsSync(this.file())) return [];
    const bytes = readBounded(this.root, this.file(), 4 * 1024 * 1024);
    const rows: unknown = bytes && JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(rows) || rows.length > 10_000 || !rows.every(valid)) throw new Error("Tour attachment index is unavailable.");
    return rows;
  }
  list(sessionId: string, tourId: string, editionId: string) { return this.read().filter(r => r.sessionId === sessionId && r.tourId === tourId && r.editionId === editionId); }
  /** The source edition a destination snapshot came from, when this host minted it. */
  source(destinationSessionId: string, handle: string): TourBindingReference | undefined { return this.read().find(r => r.destinationSessionId === destinationSessionId && r.handle === handle); }
  add(row: TourBindingReference): void {
    if (!valid(row)) throw new Error("Invalid attachment reference.");
    const rows = this.read();
    if (rows.some(r => r.handle === row.handle)) throw new Error("Duplicate attachment reference.");
    if (rows.length >= 10_000) throw new Error("This host's attachment index is full.");
    rows.push(row);
    const next = `${this.file()}-${randomBytes(12).toString("hex")}.tmp`;
    writePrivate(this.root, next, JSON.stringify(rows)); containedPath(this.root, this.file(), true); renameSync(next, this.file());
  }
}
export const tourBindingIndex = () => new TourBindingIndex(stateRoot());
