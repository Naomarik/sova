import { readFileSync, statSync } from "node:fs";
import type { ExtensionEntry } from "../extensions";
import { writeFileAtomic } from "./logins-stores";

/**
 * Extensions across the mesh. An extension is installed per host (its `dist` is an absolute
 * directory there, its backend a loopback process there), so the user's `extensions.json` stays
 * the user's: sync never writes it. Each host PUBLISHES its own entries; each host keeps every
 * peer's last published list and lists the peers' entries for ids it has none of itself. A peer
 * entry is only ever LISTED here (down, with the reason): never served, probed or proxied, since
 * its dist and loopback port name the peer's disk and processes and would be any directory and
 * any local service here. Using one here means installing it in this host's own manifest, which
 * then wins its id. A peer removing an entry removes it everywhere at the next exchange.
 */

export interface ExtensionList {
  hostId: string;
  now: number;
  entries: ExtensionEntry[];
}

export interface PeerExtension {
  entry: ExtensionEntry;
  /** The peer that published it. */
  from: string;
  /** Its dist is a directory on this host too (only changes the reason shown). */
  installed: boolean;
}

export interface ExtensionPeer {
  readonly id: string;
  extensions(): Promise<ExtensionList>;
}

export interface ExtensionSyncOptions {
  hostId: string;
  /** `<state root>/mesh-extensions.json`: the peers' last lists. */
  file: string;
  /** This host's own valid entries (server/extensions.ts readExtensions). */
  local: () => ExtensionEntry[];
  /** server/extensions.ts validateExtension: a peer's entry is re-checked with the same rules. */
  validate: (raw: unknown) => { entry: ExtensionEntry } | { error: string };
  peers?: () => readonly ExtensionPeer[];
  /** The ids currently in peers.json: lists of removed peers are dropped. */
  peerIds?: () => readonly string[];
  enabled?: () => boolean;
  now?: () => number;
}

type Stored = Record<string, { at: number; entries: ExtensionEntry[] }>;

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

export class ExtensionSync {
  private lists: Stored | null = null;
  private readonly peerState = new Map<string, { state: "ok" | "error"; at: number; error?: string }>();
  private readonly now: () => number;

  constructor(private readonly opts: ExtensionSyncOptions) {
    this.now = opts.now ?? Date.now;
  }

  private get enabled(): boolean {
    return this.opts.enabled?.() ?? true;
  }

  private load(): Stored {
    if (this.lists) return this.lists;
    this.lists = {};
    try {
      const raw = JSON.parse(readFileSync(this.opts.file, "utf8")) as { version?: unknown; peers?: Record<string, { at?: unknown; entries?: unknown }> };
      if (raw.version === 1 && raw.peers && typeof raw.peers === "object") {
        for (const [id, v] of Object.entries(raw.peers)) {
          if (typeof v?.at === "number" && Array.isArray(v.entries)) this.lists[id] = { at: v.at, entries: this.clean(v.entries) };
        }
      }
    } catch {
      // none yet
    }
    return this.lists;
  }

  private clean(raw: unknown[]): ExtensionEntry[] {
    const out: ExtensionEntry[] = [];
    const seen = new Set<string>();
    for (const r of raw) {
      const v = this.opts.validate(r);
      if ("entry" in v && !seen.has(v.entry.id)) {
        seen.add(v.entry.id);
        out.push(v.entry);
      }
    }
    return out;
  }

  /** What this host publishes: its own entries only (a peer's are that peer's to publish). */
  published(): ExtensionList {
    return { hostId: this.opts.hostId, now: this.now(), entries: this.enabled ? this.opts.local() : [] };
  }

  async syncWith(peer: ExtensionPeer): Promise<void> {
    if (!this.enabled) return;
    try {
      const got = await peer.extensions();
      const entries = Array.isArray(got?.entries) ? this.clean(got.entries) : [];
      const lists = this.load();
      const prev = lists[peer.id];
      lists[peer.id] = { at: this.now(), entries };
      if (JSON.stringify(prev?.entries) !== JSON.stringify(entries)) this.persist();
      this.peerState.set(peer.id, { state: "ok", at: this.now() });
    } catch (e) {
      this.peerState.set(peer.id, { state: "error", at: this.now(), error: (e as Error).message });
    }
  }

  async syncAll(): Promise<void> {
    await Promise.all((this.opts.peers?.() ?? []).map((p) => this.syncWith(p)));
  }

  private persist(): void {
    writeFileAtomic(this.opts.file, `${JSON.stringify({ version: 1, peers: this.lists }, null, 2)}\n`);
  }

  /**
   * The peers' entries this host lists, in peer-id order (the first peer to name an id keeps it),
   * leaving out ids this host has locally and peers no longer in peers.json. Off: none.
   */
  peerEntries(): PeerExtension[] {
    if (!this.enabled) return [];
    const lists = this.load();
    const current = this.opts.peerIds ? new Set(this.opts.peerIds()) : null;
    const taken = new Set(this.opts.local().map((e) => e.id));
    const out: PeerExtension[] = [];
    for (const id of Object.keys(lists).sort()) {
      if (current && !current.has(id)) continue;
      for (const entry of lists[id]!.entries) {
        if (taken.has(entry.id)) continue;
        taken.add(entry.id);
        out.push({ entry, from: id, installed: isDir(entry.dist) });
      }
    }
    return out;
  }

  peers(): Record<string, { state: "ok" | "error"; at: number; error?: string }> {
    return Object.fromEntries(this.peerState);
  }
}
