// A key for each chat process (§app.command-audit/keys): it says which chat a call came from, and
// nothing more. It opens nothing: the operator token is still what lets a call in (server/auth.ts).
//
// Issued at each process launch (server/chat-host.ts), passed as SOVA_CALLER_KEY. Only its sha256
// is kept, in memory and under `<state root>/caller-keys/<unit>.json` (dir 0700, file 0600), so a
// restarted server still knows the keys of the chats it takes back. A key names its chat only while
// the supervisor tracks that chat with that unit (the liveness check chat-host registers): every
// way a process ends untracks it, so no exit path needs a hook of its own. After a whole take-back,
// prune() deletes the files of every key whose process isn't tracked.
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "./state-root";

/** The header a caller sends its key in, beside x-sova-token. */
export const CALLER_HEADER = "x-sova-caller";

/** Who a call came from: its chat while the key's process runs, an installed extension whose own key
    let it in (server/extension-keys.ts), any other key, or none at all. */
export type Caller = `chat:${string}` | `ext:${string}` | "unattributed" | "no-key";

interface KeyRecord {
  hash: string;
  chatId: string;
  unit: string;
  issuedAt: string;
}

const KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;
const hashOf = (key: string): string => createHash("sha256").update(key).digest("hex");

export class CallerKeys {
  private byHash: Map<string, KeyRecord> | null = null;
  private readonly byUnit = new Map<string, string>();
  /** The keys this server life issued: a prune never touches them (a process still starting is not
      tracked yet; once it ends its key names nobody anyway). */
  private readonly issuedHere = new Set<string>();
  private live: (chatId: string, unit: string) => boolean = () => false;

  constructor(private readonly dir: () => string = () => join(stateRoot(), "caller-keys")) {}

  /** How the server knows a process still runs (the router: its supervisor tracks chatId on unit). */
  setLiveness(fn: (chatId: string, unit: string) => boolean): void {
    this.live = fn;
  }

  private file(unit: string): string {
    return join(this.dir(), `${encodeURIComponent(unit)}.json`);
  }

  /** The keys an earlier server issued, read once, at the first issue or lookup. */
  private loaded(): Map<string, KeyRecord> {
    if (this.byHash) return this.byHash;
    this.byHash = new Map();
    let names: string[] = [];
    try {
      names = readdirSync(this.dir());
    } catch {
      return this.byHash;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const r = JSON.parse(readFileSync(join(this.dir(), name), "utf8")) as KeyRecord;
        if (typeof r.hash !== "string" || typeof r.chatId !== "string" || typeof r.unit !== "string") continue;
        this.byHash.set(r.hash, r);
        this.byUnit.set(r.unit, r.hash);
      } catch {
        // a damaged file names nobody
      }
    }
    return this.byHash;
  }

  /** A new key for the process about to start on `unit`; that unit's earlier key names nobody from now on. */
  issue(chatId: string, unit: string): string {
    const keys = this.loaded();
    const key = randomBytes(32).toString("base64url");
    const rec: KeyRecord = { hash: hashOf(key), chatId, unit, issuedAt: new Date().toISOString() };
    const before = this.byUnit.get(unit);
    if (before) keys.delete(before);
    keys.set(rec.hash, rec);
    this.byUnit.set(unit, rec.hash);
    this.issuedHere.add(rec.hash);
    if (before) this.issuedHere.delete(before);
    try {
      mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
      const tmp = `${this.file(unit)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
      renameSync(tmp, this.file(unit));
    } catch (err) {
      // Attribution only: a key this server can't keep still names its chat until the server restarts.
      console.warn(`[caller-keys] ${unit}: ${err instanceof Error ? err.message : String(err)}`);
    }
    return key;
  }

  /** Who `key` names now. */
  callerOf(key: string | undefined): Caller {
    if (key === undefined) return "no-key";
    const k = key.trim();
    if (!KEY_RE.test(k)) return "unattributed";
    const rec = this.loaded().get(hashOf(k));
    if (!rec) return "unattributed";
    let alive = false;
    try {
      alive = this.live(rec.chatId, rec.unit);
    } catch {
      alive = false;
    }
    return alive ? `chat:${rec.chatId}` : "unattributed";
  }

  /** After a whole take-back: forget every key an earlier server issued whose process isn't running.
      The units it kept. A file that can't be removed is logged and left; nothing here throws. */
  prune(): string[] {
    const keys = this.loaded();
    const kept: string[] = [];
    for (const [hash, rec] of [...keys]) {
      if (this.issuedHere.has(hash)) {
        kept.push(rec.unit);
        continue;
      }
      let alive = false;
      try {
        alive = this.live(rec.chatId, rec.unit);
      } catch {
        alive = true; // unsure: keep it, the next start prunes again
      }
      if (alive) {
        kept.push(rec.unit);
        continue;
      }
      keys.delete(hash);
      if (this.byUnit.get(rec.unit) === hash) this.byUnit.delete(rec.unit);
      try {
        rmSync(this.file(rec.unit), { force: true });
      } catch (err) {
        console.warn(`[caller-keys] ${rec.unit}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return kept;
  }
}

/** The server's one set of keys. */
export const callerKeys = new CallerKeys();
