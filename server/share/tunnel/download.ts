import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import { localRequest } from "../../mesh/proxy";
import { yourClickRefusal } from "../../page-only";
import { binDir, type CloudflaredFound, forgetCloudflared, infoOf } from "./binary";
import { assetFor, assetUrl, CLOUDFLARED_MAX_BYTES, CLOUDFLARED_VERSION, installCommand, type CloudflaredAsset } from "./release";

/**
 * The one-click download of cloudflared (POST /api/public-links/cloudflared/download, the operator's click only).
 * The pinned asset (release.ts) streams to `<stateRoot>/bin/cloudflared.part`, hashed as it arrives and cut off past
 * its size; only an exact size and sha256 match is kept. A macOS .tgz gives up its one `cloudflared` member, by name,
 * to the system tar, and that file is checked against its own pinned sum. Then 0755 and a rename into place, and
 * the record (version, sha256) binary.ts checks on each server start. One download at a time: a second click joins.
 */

/** Why a download failed: the share screens say "Couldn't download cloudflared. {error}", but for `checksum` and
    `unsupported`, whose own lines they show (§design.copy-deck/where-links-open). */
export type DownloadFailure = "unsupported" | "network" | "answer" | "checksum" | "broke-off" | "unpack" | "save";

export type DownloadResult = { ok: true; found: CloudflaredFound } | { ok: false; code: DownloadFailure; error: string; status: 400 | 502 | 500 };

export interface DownloadDeps {
  fetch: typeof fetch;
  asset: CloudflaredAsset | null;
  version: string;
  platform: string;
  dir: string;
  /** Extracts `member` from the .tgz at `archive` into `into` (the system tar). */
  untar: (archive: string, member: string, into: string) => Promise<void>;
  now: () => number;
  /** How long the whole fetch may take. */
  timeoutMs: number;
}

/** The system tar, taking one member by name. */
export const systemUntar = (archive: string, member: string, into: string): Promise<void> =>
  new Promise((ok, fail) => {
    execFile("tar", ["-xzf", archive, "-C", into, member], { timeout: 60_000 }, (err, _o, stderr) => (err ? fail(new Error(String(stderr).trim() || err.message)) : ok()));
  });

const realDeps = (): DownloadDeps => ({
  fetch: (...a) => fetch(...a),
  asset: assetFor(),
  version: CLOUDFLARED_VERSION,
  platform: process.platform,
  dir: binDir(),
  untar: systemUntar,
  now: Date.now,
  timeoutMs: 10 * 60_000,
});

const sha256Of = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const MISMATCH = "The download didn't match its checksum, so it was deleted.";

type Failed = { code: DownloadFailure; error: string };

/** Streams the asset to `part`; the bytes' sha256, or the error in the screen's words. */
async function fetchTo(deps: DownloadDeps, asset: CloudflaredAsset, part: string): Promise<{ sha256: string } | Failed> {
  const signal = AbortSignal.timeout(deps.timeoutMs);
  let res: Response;
  try {
    res = await deps.fetch(assetUrl(asset, deps.version), { redirect: "follow", signal });
  } catch {
    return { code: "network", error: "GitHub couldn't be reached. Check this computer's connection and try again." };
  }
  if (!res.ok || !res.body) return { code: "answer", error: `GitHub answered ${res.status}. Try again later.` };
  const told = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(told) && told !== asset.size) {
    await res.body.cancel().catch(() => {});
    return { code: "checksum", error: MISMATCH };
  }
  const limit = Math.min(asset.size, CLOUDFLARED_MAX_BYTES);
  const hash = createHash("sha256");
  const fd = openSync(part, "w", 0o600);
  let bytes = 0;
  try {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => {});
        return { code: "checksum", error: MISMATCH };
      }
      hash.update(value);
      writeSync(fd, value);
    }
    fsyncSync(fd);
  } catch {
    return { code: "broke-off", error: "The download broke off. Try again." };
  } finally {
    closeSync(fd);
  }
  const sha256 = hash.digest("hex");
  if (bytes !== asset.size || sha256 !== asset.sha256) return { code: "checksum", error: MISMATCH };
  return { sha256 };
}

async function download(deps: DownloadDeps): Promise<DownloadResult> {
  const asset = deps.asset;
  if (!asset) return { ok: false, status: 400, code: "unsupported", error: `Install cloudflared yourself, then reload this page. ${installCommand(deps.platform)}` };
  mkdirSync(deps.dir, { recursive: true, mode: 0o700 });
  const part = join(deps.dir, asset.member ? "cloudflared.tgz.part" : "cloudflared.part");
  const target = join(deps.dir, "cloudflared");
  let scratch: string | null = null;
  try {
    const got = await fetchTo(deps, asset, part);
    if ("error" in got) return { ok: false, status: 502, ...got };
    let binary = part;
    let sha256 = got.sha256;
    if (asset.member) {
      scratch = mkdtempSync(join(deps.dir, "unpack-"));
      try {
        await deps.untar(part, asset.member.name, scratch);
      } catch {
        return { ok: false, status: 500, code: "unpack", error: "The archive couldn't be unpacked. Install cloudflared yourself." };
      }
      binary = join(scratch, asset.member.name);
      // Only a plain file, never a link the archive planted.
      let plain = false;
      try {
        plain = lstatSync(binary).isFile();
      } catch {
        plain = false;
      }
      if (!plain || (sha256 = sha256Of(binary)) !== asset.member.sha256) return { ok: false, status: 502, code: "checksum", error: MISMATCH };
    }
    chmodSync(binary, 0o755);
    renameSync(binary, target);
    writeFileSync(join(deps.dir, ".cloudflared.json.tmp"), `${JSON.stringify({ version: deps.version, sha256, at: deps.now() })}\n`, { mode: 0o600 });
    renameSync(join(deps.dir, ".cloudflared.json.tmp"), join(deps.dir, "cloudflared.json"));
  } finally {
    rmSync(part, { force: true });
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
  // The next look finds it (binary.ts checks the record's sum); a tunnel waiting for it is told.
  forgetCloudflared();
  return { ok: true, found: { ok: true, path: target, version: deps.version, source: "download" } };
}

let running: Promise<DownloadResult> | null = null;

/** Downloads the pinned cloudflared; a call while one runs gets that one's answer. */
export function downloadCloudflared(deps: DownloadDeps = realDeps()): Promise<DownloadResult> {
  running ??= download(deps)
    .catch((): DownloadResult => ({ ok: false, status: 500, code: "save", error: "It couldn't be saved in Sova's state folder. Try again." }))
    .finally(() => (running = null));
  return running;
}

const NO_STORE = { "Cache-Control": "no-store" };

/** POST /api/public-links/cloudflared/download: the operator's own click in their page, never a chat, the Overseer,
    a script, an extension or a peer (§app.access/your-click). */
export function mountCloudflaredDownload(app: Hono, deps?: () => DownloadDeps): void {
  app.post("/api/public-links/cloudflared/download", async (c: Context) => {
    if (!localRequest(c)) return c.json({ error: "Not found" }, 404);
    const refused = yourClickRefusal(c, "cloudflared");
    if (refused) return refused;
    const r = await downloadCloudflared(deps?.());
    return r.ok ? c.json({ ok: true, cloudflared: infoOf(r.found) }, 200, NO_STORE) : c.json({ ok: false, code: r.code, error: r.error }, r.status, NO_STORE);
  });
}
