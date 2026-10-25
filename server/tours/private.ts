import { renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { normalizeTourLookResult, type TourLookResult } from "./look";
import { isTourRoute, isTourFile, isTourId, isTourOrigin, normalizeTourJob, normalizeTourManifest, normalizeTourScript, TOUR_LIMITS, type TourJob, type TourManifest, type TourScript } from "../../shared/tour";
import { checkedAsset, containedPath, readBounded, writePrivate } from "./assets";
import { isTourSession } from "./store";

export interface TourPrivateAttempt {
  v: 1; sessionId: string; jobId: string; tourId: string;
  script: TourScript; mode: "dry-run" | "record" | "look"; dryRunId?: string;
  /** A look (§app.tours/look): its lists once finished, and the sign-in page's route it was given alone. */
  look?: TourLookResult; lookRoute?: string;
  dryRunPassed?: true; manifest?: TourManifest; origin?: string; generation?: number;
  suspicious: string[]; receipts: string[]; contactedOrigins?: string[];
  /** Exact named origins attested public by the recording child; never presentation data. */
  publicOrigins?: string[]; report?: TourJob;
  /** Some recorded answer came from a Sova; `sovaCopy`: the source was a verified managed Sova copy. */
  sovaServer?: boolean; sovaCopy?: true;
  /** The capture ran signed in through the script's form sign-in (never HTTP Basic, never a Sova copy's cookie). */
  signedIn?: true;
}
const CAP = 4 * 1024 * 1024;
/** Host-local authoring artifacts. This store is deliberately not mounted on any HTTP route. */
export class TourPrivateStore {
  constructor(readonly root: string) {}
  private dir(session: string, job: string): string {
    if (!isTourSession(session) || !isTourId(job)) throw new Error("Invalid private recording scope.");
    return join(this.root, session, job);
  }
  save(input: TourPrivateAttempt): void {
    if (!this.valid(input)) throw new Error("Invalid private recording artifact.");
    const path = join(this.dir(input.sessionId, input.jobId), "attempt.json"), temp = `${path}-${randomUUID()}`;
    const bytes = JSON.stringify(input);
    if (Buffer.byteLength(bytes) > CAP) throw new Error("Private recording report is too large.");
    try { writePrivate(this.root, temp, bytes); containedPath(this.root, path, true); renameSync(temp, path); }
    finally { rmSync(temp, { force: true }); }
  }
  read(session: string, job: string): TourPrivateAttempt | null {
    try {
      const bytes = readBounded(this.root, join(this.dir(session, job), "attempt.json"), CAP);
      const value: unknown = bytes ? JSON.parse(bytes.toString("utf8")) : null;
      return this.valid(value) && value.sessionId === session && value.jobId === job ? value : null;
    } catch { return null; }
  }
  writeImage(session: string, job: string, file: string, bytes: Uint8Array): void {
    if (!isTourFile(file) || !bytes.length || bytes.length > TOUR_LIMITS.assetBytes || Buffer.from(bytes.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a") throw new Error("Invalid private recording picture.");
    writePrivate(this.root, join(this.dir(session, job), "pictures", file), bytes);
  }
  readImage(session: string, job: string, file: string): Buffer | null {
    const attempt = this.read(session, job);
    // Contact sheets are allowed only here, not through owner/public presentation inventories.
    const asset = attempt?.manifest?.assets.find(a => a.file === file);
    if (!isTourFile(file) || !asset) return null;
    return checkedAsset(this.root, join(this.dir(session, job), "pictures", file), asset)?.bytes ?? null;
  }
  images(attempt: TourPrivateAttempt): Map<string, Uint8Array> {
    const out = new Map<string, Uint8Array>();
    for (const asset of attempt.manifest?.assets ?? []) {
      const bytes = this.readImage(attempt.sessionId, attempt.jobId, asset.file);
      if (!bytes) throw new Error("The private recording inventory is incomplete. Re-record this tour.");
      out.set(asset.file, bytes);
    }
    return out;
  }
  /** Only chat deletion, never archive or completion, may release its private authoring state. */
  removeSession(session: string): void {
    if (!isTourSession(session)) throw new Error("Invalid private recording scope.");
    const path = join(this.root, session); containedPath(this.root, path, true); rmSync(path, { recursive: true, force: true });
  }
  private valid(v: unknown): v is TourPrivateAttempt {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const a = v as TourPrivateAttempt;
    return a.v === 1 && isTourSession(a.sessionId) && isTourId(a.jobId) && isTourId(a.tourId) && !!normalizeTourScript(a.script)
      && ["dry-run", "record", "look"].includes(a.mode) && (a.dryRunId === undefined || isTourId(a.dryRunId))
      && (a.look === undefined || a.mode === "look" && !!normalizeTourLookResult(a.look)) && (a.lookRoute === undefined || a.mode === "look" && isTourRoute(a.lookRoute))
      && (a.dryRunPassed === undefined || a.dryRunPassed === true)
      && (a.manifest === undefined || !!normalizeTourManifest(a.manifest) && a.manifest.id === a.tourId)
      && (a.report === undefined || !!normalizeTourJob(a.report) && a.report.id === a.jobId && a.report.sessionId === a.sessionId)
      && (a.contactedOrigins === undefined || Array.isArray(a.contactedOrigins) && a.contactedOrigins.length <= 64 && a.contactedOrigins.every(isTourOrigin))
      && (a.publicOrigins === undefined || Array.isArray(a.publicOrigins) && a.publicOrigins.length <= 64 && new Set(a.publicOrigins).size === a.publicOrigins.length && a.publicOrigins.every(isTourOrigin))
      && (a.sovaServer === undefined || typeof a.sovaServer === "boolean") && (a.sovaCopy === undefined || a.sovaCopy === true) && (a.signedIn === undefined || a.signedIn === true)
      && Array.isArray(a.suspicious) && a.suspicious.length <= TOUR_LIMITS.assets && a.suspicious.every(isTourFile)
      && Array.isArray(a.receipts) && a.receipts.length <= TOUR_LIMITS.assets && a.receipts.every(isTourFile);
  }
}
