import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { isTourFile, isTourId, normalizeTourEdition, type TourEdition } from "../../shared/tour";
import { stateRoot } from "../state-root";
import { checkedAsset, containedPath, readBounded, tourDirectory, validAsset, writePrivate } from "./assets";
import { tourProgress } from "./progress";
import { isTourSessionDeleted } from "./deleted";

export const isTourSession = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(id) && id !== "." && id !== "..";
const MANIFEST_CAP = 2 * 1024 * 1024;
/** Immutable checked editions only; attempts, scripts and accounts belong in separate private stores. */
export class TourStore {
  constructor(readonly root: string) {}
  private editionPath(session: string, tour: string, edition: string): string {
    if (!isTourSession(session) || !isTourId(tour) || !isTourId(edition)) throw new Error("Invalid tour scope.");
    return join(this.root, session, tour, "editions", edition);
  }
  publishEdition(input: TourEdition, assets: ReadonlyMap<string, Uint8Array>): void {
    const edition = normalizeTourEdition(input);
    if (!edition) throw new Error("Only a complete checked tour edition can be published.");
    if (isTourSessionDeleted(join(this.root, ".."), edition.sessionId)) throw new Error("This tour's chat was deleted. No edition can be published.");
    const m = edition.manifest, final = this.editionPath(edition.sessionId, m.id, m.editionId);
    if (assets.size !== m.assets.length || m.assets.some(a => !assets.has(a.file) || !validAsset(a, assets.get(a.file)!))) throw new Error("Tour asset inventory, bytes or hashes do not match.");
    for (const step of m.steps) for (const view of step.views) for (const size of ["desktop", "phone"] as const) {
      const capture = view.captures[size];
      if (!capture) continue;
      const png = Buffer.from(assets.get(capture.image)!);
      if (png.length < 33 || png.readUInt32BE(8) !== 13 || png.toString("ascii", 12, 16) !== "IHDR" || png.readUInt32BE(16) !== m.viewports[size].w || png.readUInt32BE(20) !== m.viewports[size].h) throw new Error("Tour capture dimensions do not match the recorded viewport.");
    }
    const json = JSON.stringify(edition);
    if (Buffer.byteLength(json) > MANIFEST_CAP) throw new Error("Tour manifest is too large. Split this tour.");
    tourDirectory(this.root, join(final, ".."));
    containedPath(this.root, final, true);
    if (existsSync(final)) throw new Error("A checked edition is immutable. Record a new edition.");
    const stage = `${final}-stage-${randomBytes(12).toString("hex")}`;
    try {
      tourDirectory(this.root, stage);
      for (const a of m.assets) writePrivate(this.root, join(stage, a.file), assets.get(a.file)!);
      writePrivate(this.root, join(stage, "edition.json"), json);
      renameSync(stage, final);
      const latest = join(this.root, edition.sessionId, m.id, "latest.json"), pointer = `${latest}-${randomBytes(12).toString("hex")}`;
      writePrivate(this.root, pointer, JSON.stringify({ editionId: m.editionId }));
      containedPath(this.root, latest, true);
      renameSync(pointer, latest);
    } finally { rmSync(stage, { recursive: true, force: true }); }
  }
  sessions(): string[] {
    try { const path = containedPath(this.root, this.root); return readdirSync(path, { withFileTypes: true }).filter(d => d.isDirectory() && isTourSession(d.name)).map(d => d.name); } catch { return []; }
  }
  sessionTours(session: string): string[] {
    if (!isTourSession(session)) return [];
    try { const path = containedPath(this.root, join(this.root, session)); return readdirSync(path, { withFileTypes: true }).filter(d => d.isDirectory() && isTourId(d.name)).map(d => d.name); } catch { return []; }
  }
  deleteSession(session: string): void {
    if (!isTourSession(session)) throw new Error("Invalid tour session.");
    const path = containedPath(this.root, join(this.root, session), true);
    rmSync(path, { recursive: true, force: true });
  }
  readEdition(session: string, tour: string, editionId: string): TourEdition | null {
    if (isTourSessionDeleted(join(this.root, ".."), session)) return null;
    try {
      const path = this.editionPath(session, tour, editionId);
      const bytes = readBounded(this.root, join(path, "edition.json"), MANIFEST_CAP);
      const e = bytes ? normalizeTourEdition(JSON.parse(bytes.toString("utf8"))) : undefined;
      return e && e.sessionId === session && e.manifest.id === tour && e.manifest.editionId === editionId ? e : null;
    } catch { return null; }
  }
  latestEdition(session: string, tour: string): TourEdition | null {
    try {
      if (!isTourSession(session) || !isTourId(tour) || isTourSessionDeleted(join(this.root, ".."), session)) return null;
      const bytes = readBounded(this.root, join(this.root, session, tour, "latest.json"), 256);
      const id = bytes ? JSON.parse(bytes.toString("utf8")).editionId : null;
      return isTourId(id) ? this.readEdition(session, tour, id) : null;
    } catch { return null; }
  }
  readAsset(session: string, tour: string, editionId: string, file: string): { bytes: Buffer; mime: "image/png" } | null {
    if (!isTourFile(file)) return null;
    const e = this.readEdition(session, tour, editionId), asset = e?.manifest.assets.find(a => a.file === file);
    return asset ? checkedAsset(this.root, join(this.editionPath(session, tour, editionId), file), asset) : null;
  }
}
export const tourStore = (): TourStore => new TourStore(join(stateRoot(), "tours"));
export const publishEdition = (e: TourEdition, a: ReadonlyMap<string, Uint8Array>): void => tourStore().publishEdition(e, a);
export const deleteTourSession = (session: string): void => {
  const store = tourStore();
  for (const tour of store.sessionTours(session)) tourProgress().deleteScope(`owner:${session}:${tour}`);
  store.deleteSession(session);
};
export const readEdition = (s: string, t: string, e: string): TourEdition | null => tourStore().readEdition(s, t, e);
export const latestEdition = (s: string, t: string): TourEdition | null => tourStore().latestEdition(s, t);
export const readAsset = (s: string, t: string, e: string, f: string): { bytes: Buffer; mime: "image/png" } | null => tourStore().readAsset(s, t, e, f);
