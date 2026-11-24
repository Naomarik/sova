// A chat's usage and time that were spent on another device and came with it by Transport (§app.transport/package):
// kept apart under `<agent dir>/usage/moved/`, so this device's own totals (Costs, Time, Today, projects) never count
// them, and read only for that chat's own usage (§app.extensions/chat-usage), marked as spent elsewhere. Built the first
// time a chat asks while the folder exists: with nothing moved, nothing here runs.
//
//   moved/v1/<UTC day>/m-<chat>.jsonl        model calls (the ledger's records, as written on the source)
//   moved/perf/v1/<UTC day>/m-<chat>.jsonl   reply timings
//   moved/tools/v1/<UTC day>/m-<chat>.jsonl  tool runs
//   moved/you/<sid>.json                     your time there: {runs: [[s, e, row]], sec}
//   moved/index.json                         {chats: {<chat>: {devices: [<device id>]}}}
import fs from "node:fs";
import path from "node:path";
import type { UsageModelRow, UsageSpend } from "../../shared/usage/wire";
import { Ledger } from "./ledger";
import { PerfStore } from "./perf-store";
import type { PriceBook } from "./price-book";
import { Queries } from "./query";
import { mergeSpans } from "./time";
import { ToolRunStore } from "./tool-store";

export interface MovedYou {
  runs: [number, number, string][];
  sec: number;
}

export interface MovedOptions {
  /** `<agent dir>/usage/moved`. */
  root: string;
  /** Its ledger's snapshots (`<state root>/usage-ledger-moved`). */
  stateDir: string;
  prices: PriceBook;
  device: () => string | null;
  now?: () => number;
  log?: (line: string) => void;
}

export const movedRoot = (usageRoot: string): string => path.join(path.dirname(usageRoot), "moved");

export class MovedUsage {
  private built: { ledger: Ledger; queries: Queries; perf: PerfStore; tools: ToolRunStore } | null = null;

  constructor(private readonly o: MovedOptions) {}

  /** The stores, built once the folder exists; null while nothing ever moved here. */
  private open() {
    if (this.built) return this.built;
    if (!fs.existsSync(this.o.root)) return null;
    const now = this.o.now ? { now: this.o.now } : {};
    const ledger = new Ledger({ usageRoot: path.join(this.o.root, "v1"), stateDir: this.o.stateDir, prices: this.o.prices, ...now, ...(this.o.log ? { log: this.o.log } : {}) });
    this.o.prices.onChange((prev, next) => void ledger.repriced(prev, next));
    this.built = {
      ledger,
      queries: new Queries({ ledger, prices: this.o.prices, device: this.o.device, ...now }),
      perf: new PerfStore({ root: path.join(this.o.root, "perf", "v1"), ...now }),
      tools: new ToolRunStore({ root: path.join(this.o.root, "tools", "v1"), ...now }),
    };
    return this.built;
  }

  /** Read what's new. A no-op while nothing moved. */
  refresh(): void {
    const b = this.open();
    if (!b) return;
    b.ledger.scanAll();
    b.ledger.indexAll();
    b.perf.refresh(true);
    b.tools.refresh();
  }

  /** The sessions the moved ledger names under `sid` (itself and its helpers at any depth). */
  family(sid: string): Set<string> {
    return this.open()?.queries.family(sid) ?? new Set([sid]);
  }

  /** One conversation's moved spend and agent time, or null when none came with it. */
  forSession(sid: string): { spend: UsageSpend; models: UsageModelRow[]; agent: number } | null {
    const b = this.open();
    if (!b) return null;
    const { spend, models } = b.queries.ownSpend(sid);
    const spans: [number, number][] = [];
    for (const r of b.perf.records()) if (r.sid === sid && r.endMs > 0) spans.push([r.sentAt, r.sentAt + r.endMs]);
    for (const r of b.tools.records()) if (r.sid === sid && !r.wait) spans.push([r.start, r.end]);
    const agent = Math.round(mergeSpans(spans).reduce((n, [a, z]) => n + (z - a), 0) / 1000);
    return spend.calls || agent ? { spend, models, agent } : null;
  }

  /** Your time at a conversation, as it came from where it was spent. */
  you(sid: string): MovedYou | null {
    return readYou(this.o.root, sid);
  }

  /** The devices a chat's moved records were spent on. */
  devicesOf(chat: string): string[] {
    return readIndex(this.o.root).chats[chat]?.devices ?? [];
  }

  /** The days with moved model calls or replies or tool runs of these sessions (the cut reads them). */
  ownerDays(owners: Set<string>): string[] {
    const b = this.open();
    if (!b) return [];
    const days = new Set<string>();
    for (const o of owners) for (const d of b.ledger.owners.get(o)?.days ?? []) days.add(d);
    return [...days];
  }

  replyDays(owners: Set<string>): string[] {
    const b = this.open();
    const days = new Set<string>();
    for (const r of b?.perf.records() ?? []) if (owners.has(r.sid)) days.add(utcDay(r.ts));
    return [...days];
  }

  toolDays(owners: Set<string>): string[] {
    const b = this.open();
    const days = new Set<string>();
    for (const r of b?.tools.records() ?? []) if (owners.has(r.sid)) days.add(utcDay(r.end));
    return [...days];
  }
}

export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function readYou(root: string, sid: string): MovedYou | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, "you", `${encodeURIComponent(sid)}.json`), "utf8")) as MovedYou;
    return Array.isArray(v.runs) && typeof v.sec === "number" ? v : null;
  } catch {
    return null;
  }
}

export function readIndex(root: string): { chats: Record<string, { devices: string[] }> } {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8")) as { chats?: unknown };
    return v && typeof v.chats === "object" && v.chats ? (v as { chats: Record<string, { devices: string[] }> }) : { chats: {} };
  } catch {
    return { chats: {} };
  }
}
