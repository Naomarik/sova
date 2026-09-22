// Remote-target sessions on the frontend (spec/05-new-session-dialog.md §5 "Remote"). A remote session's local
// cwd is a placeholder that mirrors the remote folder: <home>/.pi/agent/sova/targets/<name><remoteCwd> — and,
// for sessions stored before the rename, the legacy <home>/.pi/agent/pi-web/targets/<name><remoteCwd>. Both
// spellings classify as remote here; a pre-rebrand placeholder must never reappear as a local folder. So the
// existing /api/cwds recents already carry the remote ones. Kept free of the api module so it's testable.

import type { TargetInfo } from "../../shared/protocol";
import { tildePath } from "./format";

export type { TargetInfo };

/** New spelling first, then the legacy pre-rebrand root. Either marks a placeholder cwd. */
const MARKS = ["/.pi/agent/sova/targets/", "/.pi/agent/pi-web/targets/"] as const;

/** Unreachable per the last probe ("offline", or "error"): listed, marked, and browsing says why. */
export const targetDown = (t: TargetInfo) => !!t.status && t.status !== "ok" && t.status !== "unknown";

export interface RemotePlace {
  target: string;
  /** Absolute path on the target. Never run through tildePath: the target's $HOME isn't ours. */
  remoteCwd: string;
}

/** The target and remote folder a placeholder cwd stands for, or null for an ordinary local folder. */
export function splitRemoteCwd(cwd: string): RemotePlace | null {
  for (const MARK of MARKS) {
    const i = cwd.indexOf(MARK);
    if (i < 0) continue;
    const rest = cwd.slice(i + MARK.length);
    const slash = rest.indexOf("/");
    const target = slash < 0 ? rest : rest.slice(0, slash);
    if (!target) continue;
    const tail = slash < 0 ? "" : rest.slice(slash).replace(/\/+$/, "");
    return { target, remoteCwd: tail || "/" };
  }
  return null;
}

export const isRemoteCwd = (cwd: string) => splitRemoteCwd(cwd) !== null;

/** Where a session runs: the summary's own fields win; the placeholder cwd is the fallback. */
export function remotePlaceOf(s: { cwd: string; target?: string; remoteCwd?: string }): RemotePlace | null {
  if (s.target && s.remoteCwd) return { target: s.target, remoteCwd: s.remoteCwd };
  return splitRemoteCwd(s.cwd);
}

/** "acme-prod:/home/deploy/site" — the one-line label for a remote folder. */
export const remoteLabel = (p: RemotePlace) => `${p.target}:${p.remoteCwd}`;

/** A session's folder for display: "target:/remote/path" for a remote one, else the local path with "~". */
export function cwdLabel(s: { cwd: string; target?: string; remoteCwd?: string }, home: string | null): string {
  const r = remotePlaceOf(s);
  return r ? remoteLabel(r) : tildePath(s.cwd, home);
}

/** Recent remote folders, most recent first, from the local recents list (which is already ordered). */
export function remoteRecents(cwds: readonly string[], target?: string): RemotePlace[] {
  const out: RemotePlace[] = [];
  const seen = new Set<string>();
  for (const c of cwds) {
    const p = splitRemoteCwd(c);
    if (!p || (target && p.target !== target)) continue;
    const key = remoteLabel(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

/** The local recents without the remote placeholders (those belong on the Remote tab). */
export const localOnly = (cwds: readonly string[]) => cwds.filter((c) => !splitRemoteCwd(c));

/** Parent of an absolute POSIX path; null at "/". Pure string work: the target's filesystem isn't ours to stat. */
export function remoteParent(path: string): string | null {
  if (path === "/" || !path.startsWith("/")) return null;
  return path.replace(/\/+$/, "").replace(/\/[^/]*$/, "") || "/";
}

/** Breadcrumb segments of a remote path, always from "/" (no "~": the target's $HOME isn't ours). */
export function remoteCrumbs(path: string): { label: string; path: string }[] {
  const out = [{ label: "/", path: "/" }];
  let acc = "";
  for (const seg of path.split("/").filter(Boolean)) {
    acc = `${acc}/${seg}`;
    out.push({ label: seg, path: acc });
  }
  return out;
}
