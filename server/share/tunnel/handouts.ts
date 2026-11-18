import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrokenLinks, RegistryLinkKind } from "../../../shared/public-links";
import { REGISTRY_LIMITS } from "../../../shared/public-links";
import { stateRoot } from "../../state-root";

/**
 * When each link's full URL last left Sova (§mesh.public/broken-links): in a mint's answer that
 * carried a public URL, in an outreach send, or by a Copy Link click the page reports. Keyed by
 * the link's token hash (every link store keeps one). A live link is broken when it last left
 * before its tunnel's current address began (the tunnel's epoch); one that never left with a full
 * URL can't be broken. Recorded only under Cloudflare Free, where an address can change.
 *
 * <stateRoot>/public-links-handouts.json: `{version: 1, at: {<hash>: <ms>}}`, 0600, atomic; pruned
 * of links no longer live on each write. Read once, then kept in memory.
 */

const file = () => join(stateRoot(), "public-links-handouts.json");

let cache: { root: string; at: Map<string, number> } | null = null;

function load(): Map<string, number> {
  const root = stateRoot();
  if (cache?.root === root) return cache.at;
  const at = new Map<string, number>();
  try {
    const raw = JSON.parse(readFileSync(file(), "utf8")) as { version?: unknown; at?: unknown };
    if (raw?.version === 1 && raw.at && typeof raw.at === "object") {
      for (const [h, t] of Object.entries(raw.at as Record<string, unknown>)) {
        if (REGISTRY_LIMITS.hash.test(h) && typeof t === "number" && Number.isFinite(t)) at.set(h, t);
      }
    }
  } catch {
    // none yet, or unreadable: nothing was handed out that we know of
  }
  cache = { root, at };
  return at;
}

function save(at: Map<string, number>): void {
  try {
    const path = file();
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, at: Object.fromEntries(at) })}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    console.warn(`[share] link hand-outs not saved: ${(err as NodeJS.ErrnoException)?.code ?? (err as Error)?.name ?? "error"}`);
  }
}

/** A token's hash, as the stores keep it. */
export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

/** Record that these links' full URLs left Sova now. `live`: the hashes still live, to prune by
    (absent: no pruning). Never throws. */
export function noteHandouts(hashes: readonly string[], now = Date.now(), live?: ReadonlySet<string>): void {
  const good = hashes.filter((h) => REGISTRY_LIMITS.hash.test(h));
  if (!good.length) return;
  const at = load();
  for (const h of good) at.set(h, now);
  if (live) for (const h of [...at.keys()]) if (!live.has(h) && !good.includes(h)) at.delete(h);
  save(at);
}

/** When this link last left Sova with a full URL, or null (never, as far as Sova knows). */
export const handedAt = (hash: string): number | null => load().get(hash) ?? null;

/** Broken iff it left before the address it rode began (`epoch`). Pure. */
export const isBroken = (handed: number | null, epoch: number | null): boolean => handed !== null && epoch !== null && handed < epoch;

/** A live link as the broken-links notice needs it; `describe` gives its row (null: leave it out). */
export interface LiveLink {
  h: string;
  kind: RegistryLinkKind;
}

/** The notice for one tunnel: its live links handed out before `epoch`, described by `describe`.
    Undefined when none is broken (or the tunnel has no epoch). */
export function brokenLinks(live: readonly LiveLink[], epoch: number | null, describe: (l: LiveLink) => BrokenLinks["links"][number] | null): BrokenLinks | undefined {
  if (epoch === null) return undefined;
  const links: BrokenLinks["links"] = [];
  for (const l of live) {
    if (!isBroken(handedAt(l.h), epoch)) continue;
    const row = describe(l);
    if (row) links.push(row);
  }
  return links.length ? { since: epoch, links } : undefined;
}

/** Tests: forget the in-memory copy. */
export function resetHandoutsCache(): void {
  cache = null;
}
