// A chat's usage and time across a Transport (§app.transport/package): cut on the source from this device's own
// stores (the usage helper reads them, server/usage-helper/cut.ts), and brought in on the destination apart from
// its own stores, under `<agent dir>/usage/moved/` (server/usage-helper/moved.ts). There they count in that chat's
// figures only, marked as spent on the devices they came from; this device's Costs, Time and Today never change.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readDeviceId, usageRoot } from "../pi-config/extensions/llm-inflight/usage-record";
import type { ChatUsageCut } from "./usage-helper/cut";
import { type MovedYou, movedFile, movedRoot, ORIGIN_RE, readIndex, readYou, utcDay } from "./usage-helper/moved";
import { askUsage } from "./usage-helper/client";
import { membersOf } from "./chat-usage-routes";
import { agentRoot, chatStateRoot } from "./state-root";

export type { ChatUsageCut };

const CHAT_ID = /^[\w-]{1,100}$/;

const atomic = (file: string, text: string, mode?: number) => {
  writeFileSync(`${file}.tmp`, text, mode ? { mode } : {});
  renameSync(`${file}.tmp`, file);
};

/**
 * This device's usage origin: the id its usage records are known by when a chat travels. Its host.json id when it
 * has one; otherwise one made once and kept in `<agent dir>/sova/usage-origin.json`, so a device with no
 * organization (and no host.json) still knows its own records when a chat comes back.
 */
export function usageOrigin(agentDir = agentRoot()): string {
  const host = readDeviceId(agentDir);
  if (host && ORIGIN_RE.test(host)) return host;
  const file = join(agentDir, "sova", "usage-origin.json");
  try {
    const id = (JSON.parse(readFileSync(file, "utf8")) as { id?: unknown }).id;
    if (typeof id === "string" && ORIGIN_RE.test(id)) return id;
  } catch {
    // none yet
  }
  const id = `u_${randomBytes(4).toString("hex")}`;
  mkdirSync(join(agentDir, "sova"), { recursive: true });
  atomic(file, `${JSON.stringify({ id })}\n`);
  return id;
}

/** The chat's records as written, for its package: the helper's answer's bytes (one JSON object, ChatUsageCut). */
export async function cutChatUsage(chatId: string): Promise<Buffer> {
  if (!CHAT_ID.test(chatId)) throw new Error("Not a chat id.");
  const a = await askUsage("chat-cut", { sid: chatId, members: membersOf(chatId).map((m) => m.sid), origin: usageOrigin() });
  if (a.status !== 200) throw new Error(`The usage helper couldn't cut this chat's usage (${a.status}): ${a.body.toString("utf8").slice(0, 200)}`);
  return a.body;
}

export interface ImportedUsage {
  calls: number;
  replies: number;
  tools: number;
  /** Records this device spent itself (a chat coming back): already in its own stores, so not brought in again. */
  own: number;
  you: number;
  labels: number;
}

export interface ImportOptions {
  /** The device the chat came from, as this device calls it (the Transport's peer label): the name its cost shows with. */
  from?: string;
  agentDir?: string;
  labelsDir?: string;
}

/**
 * Bring a cut in on this device. Each origin's records go to `usage/moved/<store>/<UTC day>/m-<chat>-<origin>.jsonl`;
 * this device's own origin is left out (its own stores have them), and the stores' keys make a second import of the
 * same cut count once. Your time joins `usage/moved/you/<sid>.json` by origin; message labels become the session's
 * file when it has none here. The sending device is named `from`; earlier ones by the names the cut carries.
 * Throws on a cut that isn't one, before writing anything.
 */
export function importChatUsage(bytes: Buffer | string, o: ImportOptions = {}): ImportedUsage {
  const agentDir = o.agentDir ?? agentRoot();
  const labelsDir = o.labelsDir ?? join(chatStateRoot(), "message-labels");
  const cut = JSON.parse(typeof bytes === "string" ? bytes : bytes.toString("utf8")) as ChatUsageCut;
  const groups = (v: unknown): v is Record<string, unknown[]> => !!v && typeof v === "object" && !Array.isArray(v) && Object.entries(v).every(([k, l]) => ORIGIN_RE.test(k) && Array.isArray(l));
  if (!cut || cut.v !== 2 || typeof cut.chat !== "string" || !CHAT_ID.test(cut.chat) || typeof cut.origin !== "string" || !ORIGIN_RE.test(cut.origin) || !groups(cut.calls) || !groups(cut.replies) || !groups(cut.tools)) throw new Error("Not a chat's usage cut.");
  const here = usageOrigin(agentDir);
  const root = movedRoot(usageRoot(agentDir));
  const out: ImportedUsage = { calls: 0, replies: 0, tools: 0, own: 0, you: 0, labels: 0 };
  const origins = new Set<string>();
  const put = (store: string[], byOrigin: Record<string, unknown[]>, dayOf: (r: Record<string, unknown>) => unknown, count: "calls" | "replies" | "tools") => {
    for (const [origin, lines] of Object.entries(byOrigin)) {
      if (origin === here) {
        out.own += lines.length;
        continue;
      }
      const byDay = new Map<string, string[]>();
      for (const line of lines) {
        if (typeof line !== "string" || !line || line.includes("\n")) continue;
        let t: unknown;
        try {
          t = dayOf(JSON.parse(line) as Record<string, unknown>);
        } catch {
          continue;
        }
        if (typeof t !== "number" || !Number.isFinite(t)) continue;
        const day = utcDay(t);
        let list = byDay.get(day);
        if (!list) byDay.set(day, (list = []));
        list.push(line);
        out[count]++;
      }
      for (const [day, list] of byDay) {
        const dir = join(root, ...store, day);
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, movedFile(cut.chat, origin)), `${list.join("\n")}\n`);
      }
      if (byDay.size) origins.add(origin);
    }
  };
  put(["v1"], cut.calls, (r) => r.ts, "calls");
  put(["perf", "v1"], cut.replies, (r) => r.ts, "replies");
  put(["tools", "v1"], cut.tools, (r) => r.end, "tools");
  // Your time there, by origin, joined with any that came before (a chat moved more than once), each run once.
  const sids = Array.isArray(cut.sids) ? cut.sids.filter((s): s is string => typeof s === "string" && CHAT_ID.test(s)) : [];
  for (const [sid, by] of Object.entries(cut.you ?? {})) {
    if (!CHAT_ID.test(sid) || !by || typeof by !== "object") continue;
    const had = readYou(root, sid) ?? {};
    let changed = false;
    for (const [origin, y] of Object.entries(by)) {
      if (origin === here || !ORIGIN_RE.test(origin) || !y || !Array.isArray(y.runs)) continue;
      const runs = new Map<string, [number, number, string]>();
      for (const r of [...(had[origin]?.runs ?? []), ...y.runs]) if (Array.isArray(r) && typeof r[0] === "number" && typeof r[1] === "number") runs.set(`${r[0]}:${r[1]}`, [r[0], r[1], String(r[2] ?? "other")]);
      had[origin] = { runs: [...runs.values()], sec: Math.max(had[origin]?.sec ?? 0, Number(y.sec) || 0) } satisfies MovedYou;
      origins.add(origin);
      changed = true;
    }
    if (!changed) continue;
    mkdirSync(join(root, "you"), { recursive: true });
    atomic(join(root, "you", `${encodeURIComponent(sid)}.json`), JSON.stringify({ byOrigin: had }));
    out.you++;
  }
  for (const [sid, text] of Object.entries(cut.labels ?? {})) {
    if (!CHAT_ID.test(sid) || typeof text !== "string" || !sids.includes(sid)) continue;
    const at = join(labelsDir, `${sid}.jsonl`);
    if (existsSync(at)) continue;
    mkdirSync(labelsDir, { recursive: true });
    atomic(at, text);
    out.labels++;
  }
  // Where they were spent, by name: the sender as this device calls it, earlier devices as the sender called them.
  if (origins.size) {
    const index = readIndex(root);
    for (const [origin, name] of Object.entries(cut.names ?? {})) if (ORIGIN_RE.test(origin) && typeof name === "string" && name && !index.names[origin]) index.names[origin] = name.slice(0, 120);
    if (o.from) index.names[cut.origin] = o.from.slice(0, 120);
    else index.names[cut.origin] ??= cut.origin;
    index.chats[cut.chat] = { origins: [...new Set([...(index.chats[cut.chat]?.origins ?? []), ...origins])].filter((x) => x !== here) };
    mkdirSync(root, { recursive: true });
    atomic(join(root, "index.json"), JSON.stringify(index));
  }
  return out;
}

/** Whether anything ever moved here (tests, diagnostics). */
export const hasMovedUsage = (agentDir = agentRoot()): boolean => existsSync(movedRoot(usageRoot(agentDir)));
export const readMovedIndex = (agentDir = agentRoot()) => readIndex(movedRoot(usageRoot(agentDir)));
