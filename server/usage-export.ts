// A chat's usage and time across a Transport (§app.transport/package): cut on the source from this device's own
// stores (the usage helper reads them, server/usage-helper/cut.ts), and brought in on the destination apart from
// its own stores, under `<agent dir>/usage/moved/` (server/usage-helper/moved.ts). There they count in that chat's
// figures only, marked as spent on the devices they came from; this device's Costs, Time and Today never change.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readDeviceId, usageRoot } from "../pi-config/extensions/llm-inflight/usage-record";
import type { ChatUsageCut } from "./usage-helper/cut";
import { movedRoot, readIndex, readYou, utcDay } from "./usage-helper/moved";
import { askUsage } from "./usage-helper/client";
import { membersOf } from "./chat-usage-routes";
import { agentRoot, chatStateRoot } from "./state-root";

export type { ChatUsageCut };

const CHAT_ID = /^[\w-]{1,100}$/;

/** The chat's records as written, for its package: the helper's answer's bytes (one JSON object, ChatUsageCut). */
export async function cutChatUsage(chatId: string): Promise<Buffer> {
  if (!CHAT_ID.test(chatId)) throw new Error("Not a chat id.");
  const a = await askUsage("chat-cut", { sid: chatId, members: membersOf(chatId).map((m) => m.sid) });
  if (a.status !== 200) throw new Error(`The usage helper couldn't cut this chat's usage (${a.status}): ${a.body.toString("utf8").slice(0, 200)}`);
  return a.body;
}

export interface ImportedUsage {
  calls: number;
  replies: number;
  tools: number;
  /** Records this device wrote itself (a chat coming back): already in its own stores, so not brought in twice. */
  own: number;
  you: number;
  labels: number;
}

const atomic = (file: string, text: string, mode?: number) => {
  writeFileSync(`${file}.tmp`, text, mode ? { mode } : {});
  renameSync(`${file}.tmp`, file);
};

/**
 * Bring a cut in on this device. Records go to `usage/moved/<store>/<UTC day>/m-<chat>.jsonl`, each in its own
 * day's folder; a record this device wrote itself is left out (its own store has it), and the stores' keys make a
 * second import of the same cut count once. Your time joins `usage/moved/you/<sid>.json`; message labels become
 * the session's file when it has none here. Throws on a cut that isn't one, before writing anything.
 */
export function importChatUsage(bytes: Buffer | string, agentDir = agentRoot(), labelsDir = join(chatStateRoot(), "message-labels")): ImportedUsage {
  const cut = JSON.parse(typeof bytes === "string" ? bytes : bytes.toString("utf8")) as ChatUsageCut;
  if (!cut || cut.v !== 1 || typeof cut.chat !== "string" || !CHAT_ID.test(cut.chat) || !Array.isArray(cut.calls) || !Array.isArray(cut.replies) || !Array.isArray(cut.tools)) throw new Error("Not a chat's usage cut.");
  const here = readDeviceId(agentDir);
  const root = movedRoot(usageRoot(agentDir));
  const out: ImportedUsage = { calls: 0, replies: 0, tools: 0, own: 0, you: 0, labels: 0 };
  const file = `m-${cut.chat}.jsonl`;
  const put = (store: string[], lines: unknown[], dayOf: (r: Record<string, unknown>) => number | undefined, count: "calls" | "replies" | "tools") => {
    const byDay = new Map<string, string[]>();
    for (const line of lines) {
      if (typeof line !== "string" || !line || line.includes("\n")) continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (here && r.device === here) {
        out.own++;
        continue;
      }
      const t = dayOf(r);
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
      appendFileSync(join(dir, file), `${list.join("\n")}\n`);
    }
  };
  put(["v1"], cut.calls, (r) => r.ts as number, "calls");
  put(["perf", "v1"], cut.replies, (r) => r.ts as number, "replies");
  put(["tools", "v1"], cut.tools, (r) => r.end as number, "tools");
  // Your time there, joined with any that came before (a chat moved more than once), each run once.
  const sids = Array.isArray(cut.sids) ? cut.sids.filter((s): s is string => typeof s === "string" && CHAT_ID.test(s)) : [];
  for (const [sid, y] of Object.entries(cut.you ?? {})) {
    if (!CHAT_ID.test(sid) || !y || !Array.isArray(y.runs)) continue;
    mkdirSync(join(root, "you"), { recursive: true });
    const had = readYou(root, sid);
    const runs = new Map<string, [number, number, string]>();
    for (const r of [...(had?.runs ?? []), ...y.runs]) if (Array.isArray(r) && typeof r[0] === "number" && typeof r[1] === "number") runs.set(`${r[0]}:${r[1]}`, [r[0], r[1], String(r[2] ?? "other")]);
    atomic(join(root, "you", `${encodeURIComponent(sid)}.json`), JSON.stringify({ runs: [...runs.values()], sec: Math.max(had?.sec ?? 0, Number(y.sec) || 0) }));
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
  // Where they were spent: the chat's devices, this one left out.
  const index = readIndex(root);
  const devices = new Set([...(index.chats[cut.chat]?.devices ?? []), ...(Array.isArray(cut.devices) ? cut.devices : [])].filter((d): d is string => typeof d === "string" && d !== here));
  if (devices.size || out.calls || out.replies || out.tools || out.you) {
    mkdirSync(root, { recursive: true });
    index.chats[cut.chat] = { devices: [...devices] };
    atomic(join(root, "index.json"), JSON.stringify(index));
  }
  return out;
}

/** Whether anything ever moved here (tests, diagnostics). */
export const hasMovedUsage = (agentDir = agentRoot()): boolean => existsSync(movedRoot(usageRoot(agentDir)));
export const readMovedIndex = (agentDir = agentRoot()) => readIndex(movedRoot(usageRoot(agentDir)));
// Imported for its type only by callers that read a cut file themselves.
export const readCut = (file: string): ChatUsageCut => JSON.parse(readFileSync(file, "utf8")) as ChatUsageCut;
