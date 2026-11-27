import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { NetworkKind } from "../../shared/networks";
import { stateRoot } from "../state-root";
import { writeFileAtomic } from "../sync/logins-stores";
import { normalizeRange, rangeRefusal } from "./ranges";

// The trusted networks (§app.access/networks), kept until Stop Trusting: `<state root>/trusted-networks.json`,
// mode 0600, written atomically. A range is the entry's identity; the interface it was trusted on, when
// it was a listed network, is a hint for following the VPN as it comes and goes.

export interface TrustedEntry {
  range: string;
  iface?: string;
  kind?: NetworkKind;
  label?: string;
  addedAt: string;
}

export const trustedFile = (): string => join(stateRoot(), "trusted-networks.json");

/** The entries on file; a missing or damaged file is none (a damaged one is never trusted partly). An entry the
    rules refuse now (a hand edit naming a public range) is dropped. */
export function readTrusted(): TrustedEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(trustedFile(), "utf8"));
  } catch {
    return [];
  }
  const list = (raw as { networks?: unknown })?.networks;
  if (!Array.isArray(list)) return [];
  const out: TrustedEntry[] = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const r = (e as { range?: unknown }).range;
    const range = typeof r === "string" ? normalizeRange(r) : null;
    if (!range || rangeRefusal(range) || out.some((o) => o.range === range)) continue;
    const { iface, kind, label, addedAt } = e as Record<string, unknown>;
    out.push({
      range,
      ...(typeof iface === "string" && iface ? { iface } : {}),
      ...(typeof kind === "string" ? { kind: kind as NetworkKind } : {}),
      ...(typeof label === "string" && label ? { label } : {}),
      addedAt: typeof addedAt === "string" ? addedAt : new Date(0).toISOString(),
    });
  }
  return out;
}

function write(entries: TrustedEntry[]): void {
  const file = trustedFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify({ networks: entries }, null, 2)}\n`);
}

/** Add (or replace, by range) an entry; the range must already be checked. */
export function addTrusted(entry: Omit<TrustedEntry, "addedAt">): TrustedEntry[] {
  const range = normalizeRange(entry.range);
  if (!range || rangeRefusal(range)) throw new Error(`not a range that can be trusted: ${entry.range}`);
  const next = readTrusted().filter((e) => e.range !== range);
  next.push({ ...entry, range, addedAt: new Date().toISOString() });
  write(next);
  return next;
}

/** Remove the entry for a range; false when there was none. */
export function removeTrusted(rangeText: string): boolean {
  const range = normalizeRange(rangeText);
  const was = readTrusted();
  const next = was.filter((e) => e.range !== range);
  if (next.length === was.length) return false;
  write(next);
  return true;
}
