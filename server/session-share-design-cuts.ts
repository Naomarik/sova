import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stateRoot } from "./state-root";
import type { ShareRecord } from "./session-shares";

/**
 * A snapshot's design cut (§app.session-share/lookbook): the latest finish time of a design
 * version the snapshot shows. Designs finish in their own sessions and add nothing to the chat's
 * file, so the cut entry's time would leave out nearly every design; the cut is instead when the
 * snapshot was taken (the operator's preview, pinned like the cut entry, or the server's now).
 *
 * Kept in a side file, `<stateRoot>/session-share-design-cuts.json` (0600, atomic), never in
 * session-shares.json: that file is parsed strictly (only `entryId` and `at` in a cut), and an older
 * Sova serves no link from a file it can't parse. Read tolerantly: a missing, broken or foreign
 * entry is no entry. Each entry names the cut entry it was taken with; once the share's cut is
 * another one (moved by a Sova that kept none), the entry no longer counts. With no entry that
 * counts (a link made before designs were shared, or by an older Sova), the cut is the later of
 * the cut entry's time and the share's creation. Follow live has no cut: every finished version.
 */

export const DESIGN_CUTS_FILE = "session-share-design-cuts.json";

interface DesignCut {
  entryId: string;
  at: string;
}

const file = (): string => join(stateRoot(), DESIGN_CUTS_FILE);
const ISO = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));

let cache: { path: string; cuts: Map<string, DesignCut> } | null = null;

function readCuts(): Map<string, DesignCut> {
  const path = file();
  if (cache?.path === path) return cache.cuts;
  const cuts = new Map<string, DesignCut>();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const rows = raw && typeof raw === "object" && (raw as { version?: unknown }).version === 1 ? (raw as { cuts?: unknown }).cuts : null;
    if (rows && typeof rows === "object" && !Array.isArray(rows))
      for (const [id, v] of Object.entries(rows as Record<string, unknown>)) {
        const c = v as Partial<DesignCut> | null;
        if (c && typeof c === "object" && typeof c.entryId === "string" && c.entryId && ISO(c.at)) cuts.set(id, { entryId: c.entryId, at: new Date(Date.parse(c.at)).toISOString() });
      }
  } catch {
    // None yet, or unreadable: every snapshot falls back to its own times.
  }
  cache = { path, cuts };
  return cuts;
}

function writeCuts(cuts: Map<string, DesignCut>): void {
  const path = file();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, cuts: Object.fromEntries(cuts) }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  cache = { path, cuts };
}

/** Record a snapshot's design cut, taken with its cut entry `entryId`. `keep`: the share ids that
    still exist (anything else is dropped as it is written). */
export function setDesignCut(shareId: string, entryId: string, at: string, keep?: ReadonlySet<string>): void {
  if (!ISO(at)) return;
  const cuts = new Map(readCuts());
  if (keep) for (const id of [...cuts.keys()]) if (!keep.has(id)) cuts.delete(id);
  cuts.set(shareId, { entryId, at: new Date(Date.parse(at)).toISOString() });
  try {
    writeCuts(cuts);
  } catch (err) {
    // The share stands; its designs read at the fallback cut.
    console.warn(`[session-share] design cut not kept: ${err instanceof Error ? err.message : String(err)}`);
  }
}

const later = (a: string | null | undefined, b: string | null | undefined): string | null => {
  const ta = a ? Date.parse(a) : NaN;
  const tb = b ? Date.parse(b) : NaN;
  if (!Number.isFinite(ta) && !Number.isFinite(tb)) return null;
  return new Date(Math.max(Number.isFinite(ta) ? ta : -Infinity, Number.isFinite(tb) ? tb : -Infinity)).toISOString();
};

/** A share's design cut: null while it follows live (every finished version); a snapshot's kept
    cut when it was taken with the share's current cut entry, else the later of that entry's time
    and the share's creation. */
export function designCutOf(share: Pick<ShareRecord, "id" | "mode" | "cut" | "createdAt">): string | null {
  if (share.mode === "live" || !share.cut) return null;
  const kept = readCuts().get(share.id);
  if (kept && kept.entryId === share.cut.entryId) return kept.at;
  return later(share.cut.at, share.createdAt);
}

/** Forget the cached file (tests switch state roots). */
export function resetDesignCuts(): void {
  cache = null;
}
