import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { TOUR_LIMITS, type TourAsset } from "../../shared/tour";

export const digest = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
/** Walk every component, including the final file. Never follow an in-store symlink. */
export function containedPath(root: string, path: string, missing = false): string {
  const base = resolve(root), target = resolve(path), rel = relative(base, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("Tour path escapes its store.");
  const pieces = rel ? rel.split(sep) : [];
  for (const part of [base, ...pieces.map((_, i) => resolve(base, ...pieces.slice(0, i + 1)))]) {
    try { if (lstatSync(part).isSymbolicLink()) throw new Error("Tour symlinks are not readable."); }
    catch (e) { if (missing && (e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
  }
  return target;
}
export function tourDirectory(root: string, path: string): void {
  containedPath(root, path, true);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  containedPath(root, path);
}
export function readBounded(root: string, path: string, cap: number): Buffer | null {
  let fd: number | undefined;
  try {
    containedPath(root, path);
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 0 || stat.size > cap) return null;
    const bytes = readFileSync(fd);
    return bytes.length === stat.size && bytes.length <= cap ? bytes : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}
export function writePrivate(root: string, path: string, bytes: Uint8Array | string): void {
  tourDirectory(root, dirname(path));
  containedPath(root, path, true);
  writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
}
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function validAsset(asset: TourAsset, bytes: Uint8Array): boolean {
  return asset.mime === "image/png" && bytes.byteLength === asset.bytes && bytes.byteLength <= TOUR_LIMITS.assetBytes && Buffer.from(bytes).subarray(0, 8).equals(PNG) && digest(bytes) === asset.sha256;
}
export function checkedAsset(root: string, path: string, asset: TourAsset): { bytes: Buffer; mime: "image/png" } | null {
  const bytes = readBounded(root, path, asset.bytes);
  return bytes && validAsset(asset, bytes) ? { bytes, mime: "image/png" } : null;
}
