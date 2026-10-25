import { createHash, randomBytes } from "node:crypto";
import type { HEntry } from "../../shared/harness";
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isTourHandle, normalizeTourAttachment, normalizeTourDetachment, normalizeTourPresentation, TOUR_ATTACHMENT_ENTRY, TOUR_DETACHMENT_ENTRY, TOUR_LIMITS, type TourAttachment, type TourPresentation } from "../../shared/tour";
import { checkedAsset, containedPath, readBounded, tourDirectory, validAsset, writePrivate } from "./assets";
import { isTourSession } from "./store";

/** Destination-owned public snapshots. Nothing here points back to the recording host. */
export class TourBindings {
  readonly root: string;
  constructor(workspace: string) { this.root = join(workspace, "tours"); }
  private path(session: string, attachment: TourAttachment): string {
    if (!isTourSession(session) || !normalizeTourAttachment(attachment)) throw new Error("Invalid tour binding.");
    return join(this.root, session, attachment.handle, attachment.edition);
  }
  publish(session: string, input: TourPresentation, assets: ReadonlyMap<string, Uint8Array>): TourAttachment {
    const manifest = normalizeTourPresentation(input);
    if (!manifest || assets.size !== manifest.assets.length || manifest.assets.some(a => !assets.has(a.file) || !validAsset(a, assets.get(a.file)!))) throw new Error("A binding needs every reviewed picture, unchanged.");
    const handle = `tr_${randomBytes(12).toString("base64url")}`;
    // Public identities are destination-owned, never a source session/tour id.
    manifest.id = `tour-${handle.slice(3).toLowerCase().replace(/_/g, "-")}`;
    manifest.editionId = `edition-${randomBytes(12).toString("hex")}`;
    if (!tourSnapshotFits(manifest)) throw new Error("This checked tour is too large for an organization backup. Record a smaller tour, then review it again.");
    const attachment: TourAttachment = { v: 1, handle, edition: manifest.editionId, files: manifest.assets.map(a => a.file), title: manifest.title, summary: manifest.summary, steps: manifest.steps.length };
    const final = this.path(session, attachment), stage = `${final}.stage`;
    tourDirectory(this.root, join(final, ".."));
    if (existsSync(final)) throw new Error("Tour binding already exists.");
    try {
      tourDirectory(this.root, stage);
      writePrivate(this.root, join(stage, "manifest.json"), JSON.stringify(manifest));
      for (const a of manifest.assets) writePrivate(this.root, join(stage, a.file), assets.get(a.file)!);
      renameSync(stage, final);
    } catch (e) { rmSync(stage, { recursive: true, force: true }); throw e; }
    return attachment;
  }
  /** Validate every exact public byte again before it can bypass backup ignore rules. */
  backupFiles(workspace: string, session: string, attachment: TourAttachment): TourBackupFile[] {
    const snapshot = this.path(session, attachment), path = join(snapshot, "manifest.json");
    const bytes = readBounded(workspace, path, 2 * 1024 * 1024);
    const manifest = this.read(session, attachment);
    if (!bytes || !manifest || !tourSnapshotFits(manifest) || JSON.stringify(normalizeTourPresentation(JSON.parse(bytes.toString("utf8")))) !== JSON.stringify(manifest)) throw new Error(TOUR_BACKUP_WARNING);
    const files = [backupFile(workspace, path, bytes)];
    for (const asset of manifest.assets) {
      const picture = checkedAsset(workspace, join(snapshot, asset.file), asset);
      if (!picture) throw new Error(TOUR_BACKUP_WARNING);
      files.push(backupFile(workspace, join(snapshot, asset.file), picture.bytes));
    }
    return files;
  }
  read(session: string, attachment: TourAttachment): TourPresentation | null {
    try {
      const bytes = readBounded(this.root, join(this.path(session, attachment), "manifest.json"), 2 * 1024 * 1024);
      const m = bytes && normalizeTourPresentation(JSON.parse(bytes.toString("utf8")));
      return m && m.editionId === attachment.edition && m.assets.length === attachment.files.length && m.assets.every(a => attachment.files.includes(a.file)) ? m : null;
    } catch { return null; }
  }
  asset(session: string, attachment: TourAttachment, file: string): { bytes: Buffer; mime: "image/png" } | null {
    // Branch inventory is the authority BEFORE even a snapshot read.
    if (!attachment.files.includes(file)) return null;
    const m = this.read(session, attachment), asset = m?.assets.find(a => a.file === file);
    return asset ? checkedAsset(this.root, join(this.path(session, attachment), file), asset) : null;
  }
}

/** Only a neutral attachment on the visible branch can confer access. */
export function visibleTour(view: { items: { kind: string; id: string; handle?: string }[] }, branch: readonly HEntry[], handle: string): TourAttachment | null {
  if (!isTourHandle(handle) || branch.some(e => e.kind === "state" && e.key === TOUR_DETACHMENT_ENTRY && normalizeTourDetachment(e.data)?.handle === handle)) return null;
  const item = view.items.find(i => i.kind === "tour" && i.handle === handle);
  if (!item) return null;
  const entry = branch.find(e => e.kind === "state" && e.key === TOUR_ATTACHMENT_ENTRY && e.id === item.id);
  const attachment = normalizeTourAttachment(entry?.kind === "state" ? entry.data : undefined);
  return attachment?.handle === handle ? attachment : null;
}

export function tourSnapshotFits(manifest: TourPresentation): boolean {
  const manifestBytes = Buffer.byteLength(JSON.stringify(manifest));
  return manifestBytes <= 2 * 1024 * 1024 && manifestBytes + manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0) <= TOUR_LIMITS.totalBytes;
}
export const TOUR_BACKUP_WARNING = "Organization backup is incomplete: a checked tour or its conversation changed, is unsafe, or is missing. Review the tour and retry Commit Now.";
export interface TourBackupFile { path: string; sha1: string; sha256: string }
export interface TourBackupInventory { files: TourBackupFile[]; conversations: TourBackupFile[]; detached: string[]; removedConversations: string[] }
export type TourBackupReader = (source: string | { text: string }) => Promise<{ id: string; branch: HEntry[] }>;
function attachmentPaths(session: string, attachment: TourAttachment): string[] {
  if (!isTourSession(session) || !normalizeTourAttachment(attachment)) throw new Error(TOUR_BACKUP_WARNING);
  return ["manifest.json", ...attachment.files].map(file => ["tours", session, attachment.handle, attachment.edition, file].join("/"));
}
/** Exact historical attachment inventory, never a directory or a picture-name guess. */
export function tourAttachmentPaths(session: string, branch: readonly HEntry[]): string[] {
  return [...new Set(branch.flatMap(entry => {
    const attachment = entry.kind === "state" && entry.key === TOUR_ATTACHMENT_ENTRY ? normalizeTourAttachment(entry.data) : null;
    return attachment ? attachmentPaths(session, attachment) : [];
  }))];
}
function backupFile(workspace: string, path: string, bytes: Uint8Array): TourBackupFile {
  const target = containedPath(workspace, path), base = realpathSync(workspace), actual = realpathSync(target), rel = relative(base, actual);
  if (actual !== resolve(target) || !rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error(TOUR_BACKUP_WARNING);
  const header = Buffer.from(`blob ${bytes.byteLength}\0`);
  const oid = (algorithm: string) => createHash(algorithm).update(header).update(bytes).digest("hex");
  return { path: rel.split(sep).join("/"), sha1: oid("sha1"), sha256: oid("sha256") };
}
/** Called inside the workspace's serialized backup job, never while attaching an edition. */
export async function tourBackupInventory(workspace: string, reader?: TourBackupReader): Promise<TourBackupInventory> {
  // The existing neutral reader does not depend on the attached-org index (detach backs up too).
  const { readStoredConversation } = await import("../share/hub");
  const inventory: TourBackupInventory = { files: [], conversations: [], detached: [], removedConversations: [] }, snapshots = new TourBindings(workspace);
  const sessions = join(workspace, "sessions"), seen = new Set<string>();
  if (!existsSync(sessions)) return inventory;
  containedPath(workspace, sessions);
  for (const file of readdirSync(sessions, { withFileTypes: true })) {
    if (!file.name.endsWith(".jsonl")) continue;
    if (!file.isFile()) throw new Error(TOUR_BACKUP_WARNING);
    const path = containedPath(workspace, join(sessions, file.name));
    const before = readFileSync(path);
    let conversation: Awaited<ReturnType<TourBackupReader>>;
    try { conversation = await (reader ?? readStoredConversation)(path); }
    catch (error) {
      // A conversation still being written (or any transcript) that never held an attachment
      // is ordinary backup content, not tour inventory: it must never fail the organization backup.
      if (!before.includes(TOUR_ATTACHMENT_ENTRY) && !readFileSync(path).includes(TOUR_ATTACHMENT_ENTRY)) continue;
      throw error;
    }
    const after = readFileSync(path);
    const branch = conversation.branch, attached = new Map<string, TourAttachment>(), detached = new Set<string>();
    for (const entry of branch) {
      if (entry.kind !== "state") continue;
      if (entry.key === TOUR_ATTACHMENT_ENTRY) {
        const attachment = normalizeTourAttachment(entry.data);
        if (attachment) attached.set(attachment.handle, attachment);
      } else if (entry.key === TOUR_DETACHMENT_ENTRY) {
        const detachment = normalizeTourDetachment(entry.data);
        if (detachment) detached.add(detachment.handle);
      }
    }
    if (!attached.size) continue;
    if (!before.equals(after) || !isTourSession(conversation.id) || !(file.name === `${conversation.id}.jsonl` || file.name.endsWith(`_${conversation.id}.jsonl`)) || seen.has(conversation.id)) throw new Error(TOUR_BACKUP_WARNING);
    seen.add(conversation.id);
    inventory.conversations.push(backupFile(workspace, path, after));
    for (const attachment of attached.values()) {
      if (detached.has(attachment.handle)) {
        inventory.detached.push(...attachmentPaths(conversation.id, attachment));
      } else inventory.files.push(...snapshots.backupFiles(workspace, conversation.id, attachment));
    }
  }
  return inventory;
}
