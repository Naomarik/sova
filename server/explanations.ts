import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExplanationInfo } from "../shared/protocol";

// The /explain store: ~/.pi/agent/explanations/<id>/{index.html,meta.json}, written by the
// forked explainer subagent (pi-config/extensions/explain). Read-only here — nothing in this
// server writes or prunes the store; explanations are kept forever. Every meta.json is
// untrusted JSON: a corrupt, partial or foreign entry is skipped, never thrown.

/** Store dir names, and the ids accepted by /explain/:id. Blocks "..", "/" and empty. */
export const ID_RE = /^[A-Za-z0-9_-]+$/;

export const isExplanationId = (id: unknown): id is string => typeof id === "string" && ID_RE.test(id);

/**
 * Resolved per call, not at module load, so tests can redirect it. Deliberately NOT the SDK's
 * getAgentDir(): that honors PI_CODING_AGENT_DIR only, while the explain extension
 * (pi-config/extensions/explain/store.ts agentDir) prefers PI_AGENT_DIR. We must read exactly
 * where the writer writes, so this mirrors the extension's resolution order.
 */
export const explanationsDir = (): string =>
  join(process.env.PI_AGENT_DIR?.trim() || process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"), "explanations");

const entryDir = (id: string): string => join(explanationsDir(), id);

/** meta.json → ExplanationInfo. Requires id (matching its dir), topic and createdAt; summary and
    parentSessionId fall back to "" so a half-written meta still lists instead of vanishing, and
    `model` stays absent when the store predates it. `cwd` is not part of the wire shape. */
function decodeMeta(dir: string, raw: unknown): ExplanationInfo | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const id = str(m.id) || dir;
  if (id !== dir || !isExplanationId(id)) return null;
  const topic = str(m.topic);
  const createdAt = str(m.createdAt);
  if (!topic || !createdAt) return null;
  const info: ExplanationInfo = { id, topic, summary: str(m.summary), createdAt, parentSessionId: str(m.parentSessionId) };
  // Absent, not "": the field is missing from stores written before the extension recorded it,
  // and "unknown model" should not read as a model named "".
  const model = str(m.model);
  if (model) info.model = model;
  return info;
}

/**
 * A store entry counts only once its page is there. Load-bearing, not belt-and-braces: the
 * explainer CHILD writes index.html and meta.json itself and is only *instructed* to write the
 * page first, so a child that inverts the order and then dies leaves a meta.json with nothing to
 * serve. (The parent's own writes can't: validateStore returns on a missing or empty index.html
 * before it reaches writeMeta.) Zero bytes is not a page either — the extension treats that as
 * fatal too. Everything we list is openable.
 */
export async function hasPage(id: string): Promise<boolean> {
  try {
    const st = await stat(join(entryDir(id), "index.html"));
    return st.isFile() && st.size > 0;
  } catch {
    return false;
  }
}

async function readMeta(dir: string): Promise<ExplanationInfo | null> {
  let meta: ExplanationInfo | null;
  try {
    meta = decodeMeta(dir, JSON.parse(await readFile(join(entryDir(dir), "meta.json"), "utf8")));
  } catch {
    return null; // missing, unreadable or malformed: not an explanation
  }
  return meta && (await hasPage(dir)) ? meta : null;
}

/** Newest first (createdAt desc, id as the tie-break so the order is stable). */
export function sortExplanations(list: ExplanationInfo[]): ExplanationInfo[] {
  return list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id < b.id ? 1 : -1));
}

/**
 * Every readable, openable entry in the store, newest first. With `sessionId`, only the ones parented to
 * that session. A missing store dir is an empty list.
 */
export async function listExplanations(sessionId?: string): Promise<ExplanationInfo[]> {
  let names: string[];
  try {
    names = (await readdir(explanationsDir(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const metas = await Promise.all(names.filter((n) => ID_RE.test(n)).map(readMeta));
  const out = metas.filter((m): m is ExplanationInfo => m !== null);
  return sortExplanations(sessionId ? out.filter((m) => m.parentSessionId === sessionId) : out);
}

/** The stored page, for serving at /explain/:id. null when the id is invalid or unknown. */
export async function readExplanationPage(id: string): Promise<string | null> {
  if (!isExplanationId(id)) return null;
  try {
    return await readFile(join(entryDir(id), "index.html"), "utf8");
  } catch {
    return null;
  }
}
