import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, createReadStream, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { stateRoot } from "../../state-root";
import type { CloudflaredInfo, CloudflaredSource } from "../../../shared/public-links";
import { assetFor, CLOUDFLARED_VERSION, installCommand } from "./release";

/**
 * Which cloudflared Sova runs for a tunnel: `SOVA_CLOUDFLARED` (a person's own path, and the tests' stand-in; `off`,
 * the test runner's default, skips PATH) →
 * `cloudflared` on PATH, asked its version once → the copy Sova downloaded, while its file still hashes to the sum
 * release.ts pins for this platform. Found once per server lifetime; a download drops the answer.
 * Never downloads: ensureTunnel maps "not found" to `needs-cloudflared`, and only the operator's click fetches it.
 */


export type CloudflaredFound =
  | { ok: true; path: string; version: string | null; source: CloudflaredSource }
  | {
      ok: false;
      /** One sentence for the share screens. */
      reason: string;
      /** A pinned asset exists for this computer, so Download can be offered. */
      canDownload: boolean;
      /** How to install it oneself. */
      install: string;
    };

/** Every `cloudflared tunnel …` Sova starts carries it: Sova pins the build, so cloudflared never replaces itself. */
export const CLOUDFLARED_NO_AUTOUPDATE = "--no-autoupdate";

/** The oldest release Sova runs: it writes `--pidfile` after connecting and serves `/quicktunnel` (both older). */
export const CLOUDFLARED_MIN_VERSION = "2024.1.0";

/** Where the download lives, and its record (version, sha256 of the binary, when). */
export const binDir = (): string => join(stateRoot(), "bin");
export const downloadedPath = (): string => join(binDir(), "cloudflared");
export const downloadedRecordPath = (): string => join(binDir(), "cloudflared.json");

export interface DownloadedRecord {
  version: string;
  sha256: string;
  at: number;
}

export function parseDownloadedRecord(raw: unknown): DownloadedRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== "string" || typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256) || typeof r.at !== "number") return null;
  return { version: r.version, sha256: r.sha256, at: r.at };
}

export interface ResolveDeps {
  env: NodeJS.ProcessEnv;
  platform: string;
  arch: string;
  /** Runs `<path> --version`; null when it didn't run or exited non-zero. */
  version: (path: string) => Promise<string | null>;
  sha256File: (path: string) => Promise<string | null>;
  executable: (path: string) => boolean;
  readRecord: () => DownloadedRecord | null;
  downloaded: string;
}

const isExecutable = (p: string): boolean => {
  try {
    if (!statSync(p).isFile()) return false;
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const runVersion = (path: string): Promise<string | null> =>
  new Promise((ok) => {
    execFile(path, ["--version"], { timeout: 5000, maxBuffer: 64 * 1024, env: { ...process.env, NO_AUTOUPDATE: "true" } }, (err, stdout, stderr) => ok(err ? null : `${stdout}${stderr}`.trim()));
  });

const hashFile = (path: string): Promise<string | null> =>
  new Promise((ok) => {
    const h = createHash("sha256");
    createReadStream(path)
      .on("data", (b) => h.update(b))
      .on("end", () => ok(h.digest("hex")))
      .on("error", () => ok(null));
  });

const readRecordFile = (): DownloadedRecord | null => {
  try {
    return parseDownloadedRecord(JSON.parse(readFileSync(downloadedRecordPath(), "utf8")));
  } catch {
    return null;
  }
};

export const defaultResolveDeps = (): ResolveDeps => ({
  env: process.env,
  platform: process.platform,
  arch: process.arch,
  version: runVersion,
  sha256File: hashFile,
  executable: isExecutable,
  readRecord: readRecordFile,
  downloaded: downloadedPath(),
});

/** `cloudflared version 2026.10.7 (built …)` → "2026.10.7"; null for anything else (a dev build). */
export function parseVersion(out: string): string | null {
  return /\bversion\s+(\d{4}\.\d{1,2}\.\d+)\b/.exec(out)?.[1] ?? null;
}

/** -1, 0 or 1, by year.month.patch. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The PATH directories, then the usual install places a service's short PATH leaves out. */
export function searchDirs(env: NodeJS.ProcessEnv, platform: string): string[] {
  const dirs = (env.PATH ?? "").split(delimiter).filter((d) => d && isAbsolute(d));
  const extra = platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : ["/usr/local/bin", "/usr/bin"];
  for (const d of extra) if (!dirs.includes(d)) dirs.push(d);
  return dirs;
}

const notFound = (deps: ResolveDeps, reason: string): CloudflaredFound => ({ ok: false, reason, canDownload: assetFor(deps.platform, deps.arch) !== null, install: installCommand(deps.platform) });

/** The finding, uncached (the tests' door). */
export async function findCloudflared(deps: ResolveDeps = defaultResolveDeps()): Promise<CloudflaredFound> {
  const named = deps.env.SOVA_CLOUDFLARED?.trim();
  // `off` (the test runner's default): nothing on PATH counts, so a test never runs an installed cloudflared.
  const offPath = named === "off";
  if (named && !offPath) {
    if (!isAbsolute(named) || !deps.executable(named)) return notFound(deps, `SOVA_CLOUDFLARED names ${named}, which isn't a program Sova can run.`);
    return { ok: true, path: named, version: null, source: "env" };
  }
  let tooOld: string | null = null;
  for (const dir of offPath ? [] : searchDirs(deps.env, deps.platform)) {
    const p = join(dir, "cloudflared");
    if (!deps.executable(p)) continue;
    const out = await deps.version(p);
    if (out === null) continue;
    const version = parseVersion(out);
    if (version && compareVersions(version, CLOUDFLARED_MIN_VERSION) < 0) {
      tooOld ??= `The cloudflared at ${p} is version ${version}; Sova needs ${CLOUDFLARED_MIN_VERSION} or later.`;
      continue;
    }
    return { ok: true, path: p, version, source: "path" };
  }
  // Checked against the sum this Sova pins, never the record beside it: whoever could swap the file could swap
  // that too. A copy of an older pin (Sova updated since) no longer counts, and Download is offered again.
  const record = deps.readRecord();
  const pinned = assetFor(deps.platform, deps.arch);
  const want = pinned ? (pinned.member?.sha256 ?? pinned.sha256) : null;
  if (record && want && record.version === CLOUDFLARED_VERSION && deps.executable(deps.downloaded) && (await deps.sha256File(deps.downloaded)) === want) {
    return { ok: true, path: deps.downloaded, version: record.version, source: "download" };
  }
  return notFound(deps, tooOld ?? "cloudflared isn't installed on this computer.");
}

let cached: Promise<CloudflaredFound> | null = null;
let known: CloudflaredFound | null = null;
const listeners = new Set<() => void>();

/** Which cloudflared to run, found once per server lifetime (concurrent callers share one look). */
export function resolveCloudflared(): Promise<CloudflaredFound> {
  if (!cached) {
    const look = findCloudflared().then((f) => {
      if (cached === look) known = f;
      return f;
    });
    cached = look;
  }
  return cached;
}

/** The last answer, memory only (null before the first look or after a forget). */
export const cloudflaredKnown = (): CloudflaredFound | null => known;

/** What GET /api/public-links tells the page, memory only: null before the first look. */
export const cloudflaredInfo = (): CloudflaredInfo | null => (known ? infoOf(known) : null);

/** A finding as the page sees it: never the path. */
export function infoOf(f: CloudflaredFound): CloudflaredInfo {
  return f.ok
    ? { found: true, source: f.source, version: f.version, canDownload: false, install: installCommand() }
    : { found: false, source: null, version: null, reason: f.reason, canDownload: f.canDownload, install: f.install };
}

/** Drops the answer, so the next resolve looks again (a download just put one in place). */
export function forgetCloudflared(): void {
  cached = null;
  known = null;
  for (const cb of listeners) cb();
}

/** Told when the answer is dropped (a download finished): a waiting tunnel may start now. */
export function onCloudflaredChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
