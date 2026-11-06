import { closeSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { stateRoot } from "./state-root";
import { projectKey } from "./merge-queue/store";
import { mergeThreadTitle, releaseChatTitle, reviewerTitle, withdrawChatTitle, type SovaNamedKind } from "../shared/fixed-names";

/**
 * The name Sova gave one of its own chats, rebuilt from what Sova recorded when it started it, for a chat started
 * before Sova kept that name (server/sova-chat-names.ts). The same formatters as the start paths
 * (shared/fixed-names.ts), fed from Sova's own records, never from the chat's stored title:
 * - a merge thread: the queue's thread record (`merge-queue/threads.json`, current and earlier threads), its
 *   project and start time;
 * - a reviewer: the queue's chat record (`merge-queue/chats.json`: branch, attempt, run), the run's commit
 *   (`runs/<run>/run.json`), else the commit its own first message names ("Commit under review: <sha>");
 * - a release chat: the release record whose chat it is (`project-services/release/<key>/rl_*.json`): its tag as
 *   now (Sova's retitle), or "Withdraw <tag>" for the chat a withdrawal started after it.
 * Null when no record names the chat (a record cleared or pruned, a state root moved), or the reviewer's commit is
 * nowhere to be read. Reads small files only; read-only.
 */
export function rebuildSovaName(kind: SovaNamedKind, id: string, path: string, createdAt?: string): string | null {
  try {
    if (kind === "merge-thread") return threadName(id);
    if (kind === "merge-reviewer") return reviewerName(id, path);
    return releaseName(id, createdAt);
  } catch {
    return null;
  }
}

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
};
const queueBase = () => join(stateRoot(), "merge-queue");

type ThreadRow = { sessionId?: string; startedAt?: number; history?: { sessionId?: string; startedAt?: number }[] };
function threadName(id: string): string | null {
  const raw = readJson<{ version?: number; threads?: Record<string, ThreadRow> }>(join(queueBase(), "threads.json"));
  for (const [root, t] of Object.entries(raw?.version === 1 ? (raw.threads ?? {}) : {})) {
    for (const r of [t, ...(t?.history ?? [])]) if (r?.sessionId === id && typeof r.startedAt === "number") return mergeThreadTitle(root, r.startedAt);
  }
  return null;
}

type ReviewerRow = { session?: string; run?: string; branch?: string; attempt?: number };
function reviewerName(id: string, path: string): string | null {
  const raw = readJson<{ version?: number; projects?: Record<string, { reviewers?: ReviewerRow[] }> }>(join(queueBase(), "chats.json"));
  for (const [root, p] of Object.entries(raw?.version === 1 ? (raw.projects ?? {}) : {})) {
    const r = p?.reviewers?.find((x) => x.session === id);
    if (!r || typeof r.branch !== "string" || typeof r.attempt !== "number") continue;
    const run = typeof r.run === "string" && /^mr_[\w-]+$/.test(r.run) ? readJson<{ commit?: unknown }>(join(queueBase(), projectKey(root), "runs", r.run, "run.json")) : null;
    const commit = typeof run?.commit === "string" && run.commit ? run.commit : commitInFirstMessage(path);
    return commit ? reviewerTitle({ branch: r.branch, commit, attempt: r.attempt }) : null;
  }
  return null;
}

/** The commit a reviewer's first message names (review-step.ts reviewerText), from the file's head. */
function commitInFirstMessage(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return /Commit under review: ([0-9a-f]{7,40})\b/.exec(buf.subarray(0, n).toString("utf8"))?.[1] ?? null;
  } finally {
    closeSync(fd);
  }
}

type ReleaseRow = { project?: string; tag?: string | null; thread?: { session?: string } | null; withdrawn?: { at?: string } };
function releaseName(id: string, createdAt?: string): string | null {
  const dir = join(stateRoot(), "project-services", "release");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(dir).filter((d) => /^[0-9a-f]{16}$/.test(d));
  } catch {
    return null;
  }
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(join(dir, d)).filter((f) => /^rl_[0-9a-z]+\.json$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const rec = readJson<ReleaseRow>(join(dir, d, f));
      if (!rec || rec.thread?.session !== id || typeof rec.project !== "string") continue;
      // A withdrawal that couldn't wake the release chat started one of its own, which took the record's place.
      const withdrawChat = !!rec.tag && !!rec.withdrawn?.at && !!createdAt && createdAt >= rec.withdrawn.at;
      return withdrawChat ? withdrawChatTitle(rec.tag!) : releaseChatTitle({ tag: rec.tag ?? null, project: rec.project });
    }
  }
  return null;
}
