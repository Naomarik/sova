// One chat's usage records cut out of this device's stores, as they were written, for Transport to carry
// (§app.transport/package): its model calls, reply timings and tool runs (this device's own and any that came
// with the chat from another), your time at each of its conversations and their message labels. Read only on
// the days its conversations were active (a reply or tool run the day before or after a call's day too), and
// only when asked.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { AttentionStore } from "./attention";
import type { Ledger } from "./ledger";
import { type MovedUsage, type MovedYou, utcDay } from "./moved";
import type { PerfStore } from "./perf-store";
import type { ToolRunStore } from "./tool-store";

/** What a cut carries (written as one JSON file in a Transport package). */
export interface ChatUsageCut {
  v: 1;
  chat: string;
  /** The device it was cut on, and every device its records were spent on. */
  device: string | null;
  devices: string[];
  /** The sessions it covers: the chat and its helpers. */
  sids: string[];
  calls: string[];
  replies: string[];
  tools: string[];
  you: Record<string, MovedYou>;
  labels: Record<string, string>;
}

export interface CutDeps {
  ledger: Ledger;
  perf: PerfStore;
  tools: ToolRunStore;
  attention: AttentionStore;
  moved: MovedUsage;
  roots: { usage: string; perf: string; tools: string; moved: string; labels: string };
  device: () => string | null;
}

const DAY_MS = 86_400_000;
const around = (days: Iterable<string>): Set<string> => {
  const out = new Set<string>();
  for (const d of days) {
    const t = Date.parse(`${d}T00:00:00Z`);
    if (!Number.isFinite(t)) continue;
    for (const k of [-1, 0, 1]) out.add(utcDay(t + k * DAY_MS));
  }
  return out;
};

/** Every line of a day folder's files (plain and sealed `.gz`) whose `field` names one of `owners`, deduplicated by key. */
function linesOf(dir: string, days: Iterable<string>, field: "owner" | "sid", owners: Set<string>, seen: Set<string>, out: string[]): void {
  for (const day of days) {
    let names: string[];
    try {
      names = fs.readdirSync(path.join(dir, day));
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (!/\.jsonl(\.gz)?$/.test(name)) continue;
      let text: string;
      try {
        const bytes = fs.readFileSync(path.join(dir, day, name));
        text = name.endsWith(".gz") ? zlib.gunzipSync(bytes).toString("utf8") : bytes.toString("utf8");
      } catch {
        continue;
      }
      const lines = text.split("\n");
      // A plain file's last piece, unterminated, is a write in progress: never carried.
      if (!name.endsWith(".gz")) lines.pop();
      for (const line of lines) {
        if (!line) continue;
        let r: { key?: unknown; owner?: unknown; sid?: unknown };
        try {
          r = JSON.parse(line) as typeof r;
        } catch {
          continue;
        }
        const who = r[field];
        if (typeof who !== "string" || !owners.has(who) || typeof r.key !== "string" || seen.has(r.key)) continue;
        seen.add(r.key);
        out.push(line);
      }
    }
  }
}

export function cutChatUsage(d: CutDeps, q: { sid: string; members: string[] }): ChatUsageCut {
  d.attention.refresh();
  d.perf.refresh();
  d.tools.refresh();
  d.moved.refresh();
  const owners = new Set<string>([q.sid, ...q.members]);
  // Helpers the ledgers name though the server has no record of them now.
  const grow = (fam: Set<string>) => fam.forEach((s) => owners.add(s));
  const familyOf = (sid: string): Set<string> => {
    const out = new Set<string>([sid]);
    const queue = [sid];
    while (queue.length) {
      const s = queue.pop()!;
      for (const c of d.ledger.children.get(s) ?? []) if (!out.has(c)) (out.add(c), queue.push(c));
    }
    return out;
  };
  grow(familyOf(q.sid));
  grow(d.moved.family(q.sid));

  const callDays = new Set<string>();
  for (const o of owners) for (const day of d.ledger.owners.get(o)?.days ?? []) callDays.add(day);
  const movedCallDays = d.moved.ownerDays(owners);
  const replyDays = new Set<string>();
  for (const r of d.perf.records()) if (owners.has(r.sid)) replyDays.add(utcDay(r.ts));
  const toolDays = new Set<string>();
  for (const r of d.tools.records()) if (owners.has(r.sid)) toolDays.add(utcDay(r.end));

  const calls: string[] = [];
  const replies: string[] = [];
  const tools: string[] = [];
  const seenCalls = new Set<string>();
  const seenReplies = new Set<string>();
  const seenTools = new Set<string>();
  linesOf(d.roots.usage, callDays, "owner", owners, seenCalls, calls);
  linesOf(path.join(d.roots.moved, "v1"), movedCallDays, "owner", owners, seenCalls, calls);
  linesOf(d.roots.perf, around([...replyDays, ...callDays]), "sid", owners, seenReplies, replies);
  linesOf(path.join(d.roots.moved, "perf", "v1"), around(d.moved.replyDays(owners)), "sid", owners, seenReplies, replies);
  linesOf(d.roots.tools, around([...toolDays, ...callDays]), "sid", owners, seenTools, tools);
  linesOf(path.join(d.roots.moved, "tools", "v1"), around(d.moved.toolDays(owners)), "sid", owners, seenTools, tools);

  const you: Record<string, MovedYou> = {};
  const live = d.attention.live();
  const gone = new Map<string, number>();
  for (const l of d.attention.gone()) if (owners.has(l.sid)) gone.set(l.sid, (gone.get(l.sid) ?? 0) + l.sec);
  const labels: Record<string, string> = {};
  for (const sid of owners) {
    const runs: [number, number, string][] = (live.get(sid)?.runs ?? []).map((r) => [r.s, r.e, r.r]);
    let sec = gone.get(sid) ?? 0;
    const there = d.moved.you(sid);
    if (there) {
      runs.push(...there.runs);
      sec += there.sec;
    }
    if (runs.length || sec) you[sid] = { runs, sec };
    try {
      const text = fs.readFileSync(path.join(d.roots.labels, `${sid}.jsonl`), "utf8");
      if (text) labels[sid] = text;
    } catch {
      // no labels for it
    }
  }
  const device = d.device();
  const devices = [...new Set([...d.moved.devicesOf(q.sid), ...(device ? [device] : [])])];
  return { v: 1, chat: q.sid, device, devices, sids: [...owners], calls, replies, tools, you, labels };
}
