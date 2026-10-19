import { isTourOrigin } from "../../shared/tour";
import { privateTourDirectory, readPrivateTourJson, writePrivateTourJson } from "./job";

/** Consent is not network authorization. The sandbox and verified project source checks still apply. */
export class TourApprovalStore {
  constructor(readonly root: string) { privateTourDirectory(root); }
  private read(): string[] {
    try {
      const data = readPrivateTourJson(this.root, "origins.json") as { v?: unknown; origins?: unknown };
      if (data?.v !== 1 || !Array.isArray(data.origins) || !data.origins.every(isTourOrigin)) throw new Error("Invalid site approvals.");
      return [...new Set(data.origins as string[])];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Site approvals could not be read. Repair the host-local approval state before recording.");
    }
  }
  list(): string[] { return this.read(); }
  isApproved(origin: string): boolean { return isTourOrigin(origin) && this.read().includes(origin); }
  approve(origin: string): void {
    if (!isTourOrigin(origin)) throw new Error("Approve an exact HTTP(S) origin, including its scheme and port.");
    const origins = this.read();
    if (!origins.includes(origin)) origins.push(origin);
    writePrivateTourJson(this.root, "origins.json", { v: 1, origins: origins.sort() });
  }
  revoke(origin: string): void {
    if (!isTourOrigin(origin)) throw new Error("Invalid site origin.");
    writePrivateTourJson(this.root, "origins.json", { v: 1, origins: this.read().filter(o => o !== origin) });
  }
  missing(origins: readonly string[], verifiedProjectOrigin?: string): string[] {
    if (origins.some(o => !isTourOrigin(o)) || (verifiedProjectOrigin !== undefined && !isTourOrigin(verifiedProjectOrigin))) throw new Error("Invalid site origin.");
    const approved = this.read();
    // The exemption is an independently verified current project origin, never 'all loopback'.
    return [...new Set(origins)].filter(o => o !== verifiedProjectOrigin && !approved.includes(o));
  }
}
