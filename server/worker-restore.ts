// A session's workers when no process is publishing them (§chat/subagents restored workers): the
// session isn't hosted by this server and no TUI owns it, so there is no live record. Its own
// JSONL still holds each worker's durable record (the subagents extension's registry/manifest
// entries), and each worker's transcript is read through the backend's adapter — the same
// protocol module and fold the extension restores from, so both sides agree on what a worker is.
//
// Read-only: session files and transcripts are only ever read. Every worker comes back not
// working (nothing runs it); resuming needs a runtime, so nothing here is `resumable`.

import { stat } from "node:fs/promises";
import type { TokenUsage, TokenUsageTotal, WorkerInfo, WorkerStatus } from "../shared/protocol";
import {
  type FoldedWorkerManifest,
  readWorkerManifests,
  resolveWorkerUsage,
  type WorkerTranscriptAdapters,
  type WorkerTranscriptSummary,
  type WorkerUsage,
} from "../pi-config/extensions/subagents/worker-transcript.ts";
import { modelProvider } from "./models";

type Entry = Record<string, any>;

export interface RestoredWorkers {
  /** Workers with a record on the active branch, newest activity first by the caller's sort. */
  workers: WorkerInfo[];
  /** Lifetime Σ over every worker on every branch whose usage could be read; absent when none. */
  usageTotal?: TokenUsageTotal;
}

/** An ended worker keeps its ending; anything that was alive when its host went away is restored. */
function statusOf(m: FoldedWorkerManifest): WorkerStatus {
  return m.status === "done" || m.status === "error" || m.status === "killed" ? m.status : "restored";
}

/** A transcript read, reused while its file is unchanged (the insight is polled every 3s). */
interface Cached { mtimeMs: number; size: number; summary: WorkerTranscriptSummary }
const MAX_CACHED = 512;

export class WorkerRestorer {
  private readonly cache = new Map<string, Cached>();
  constructor(private readonly adapters: () => WorkerTranscriptAdapters) {}

  /** The transcript summary for one manifest, or why there is none. Never throws. */
  private async summary(m: FoldedWorkerManifest): Promise<WorkerTranscriptSummary | null> {
    if (!m.ref) return null;
    const adapter = this.adapters().get(m.backend);
    if (!adapter.capabilities().read) return null;
    try {
      const { file } = adapter.locate(m.ref);
      if (!file) return null;
      const st = await stat(file);
      const key = `${m.backend}\n${file}`;
      const hit = this.cache.get(key);
      if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.summary;
      const summary = await adapter.read(m.ref, { items: "none" });
      if (!summary.found) return null;
      this.cache.delete(key);
      this.cache.set(key, { mtimeMs: st.mtimeMs, size: st.size, summary });
      while (this.cache.size > MAX_CACHED) {
        const oldest = this.cache.keys().next().value;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      return summary;
    } catch {
      return null; // unreadable right now: the snapshot, if any, stands in
    }
  }

  /** `entries`: every entry of the session file (all branches); `branch`: the active one. */
  async restore(entries: readonly Entry[], branch: readonly Entry[]): Promise<RestoredWorkers> {
    const activeEntryIds = new Set(branch.map((e) => e.id).filter((id): id is string => typeof id === "string"));
    const { manifests } = readWorkerManifests(entries, { activeEntryIds });
    if (manifests.size === 0) return { workers: [] };
    const views = await Promise.all(
      [...manifests.values()].map(async (m) => {
        const summary = await this.summary(m);
        return { m, summary, usage: resolveWorkerUsage(summary?.usage, m.usageSnapshot) };
      }),
    );
    const workers: WorkerInfo[] = [];
    const counted: WorkerUsage[] = [];
    let asOf: number | undefined;
    for (const { m, summary, usage } of views) {
      const snapshotAt = usage.source === "snapshot" ? usage.asOf : usage.costSource === "snapshot" ? usage.costAsOf : undefined;
      if (usage.source !== "none") {
        counted.push(usage);
        if (snapshotAt !== undefined) asOf = Math.min(asOf ?? Infinity, snapshotAt);
      }
      if (!m.onActiveBranch) continue;
      workers.push(workerInfo(m, summary, usage, snapshotAt));
    }
    return { workers, ...(counted.length > 0 ? { usageTotal: totalOf(counted, asOf) } : {}) };
  }
}

function tokens(u: WorkerUsage): TokenUsage {
  return {
    input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
    ...(u.cost !== undefined && u.cost > 0 ? { cost: u.cost } : {}),
  };
}

function totalOf(usages: WorkerUsage[], asOf: number | undefined): TokenUsageTotal {
  const t: TokenUsageTotal = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, workers: usages.length };
  let cost = 0;
  for (const u of usages) {
    t.input += u.input; t.output += u.output; t.cacheRead += u.cacheRead; t.cacheWrite += u.cacheWrite;
    cost += u.cost ?? 0;
  }
  if (cost > 0) t.cost = cost;
  if (asOf !== undefined) t.asOf = asOf;
  return t;
}

function workerInfo(m: FoldedWorkerManifest, summary: WorkerTranscriptSummary | null, usage: WorkerUsage, snapshotAt: number | undefined): WorkerInfo {
  const status = statusOf(m);
  const model = summary?.model ?? m.spec?.model;
  const w: WorkerInfo = { id: m.workerId, name: m.name ?? m.workerId, status, working: false, backend: m.backend };
  if (model) w.model = model;
  const provider = m.backend === "claude-code" ? "claude code" : modelProvider(model);
  if (provider) w.provider = provider;
  const effort = summary?.effort ?? m.spec?.effort;
  if (effort) w.effort = effort;
  if (m.ref?.kind === "pi-session-file") w.sessionFile = m.ref.locator;
  const sessionId = m.ref?.kind === "claude-session-id" ? m.ref.locator : m.ref?.sessionId;
  if (sessionId) w.sessionId = sessionId;
  if (summary?.startedAt !== undefined) w.startedAt = summary.startedAt;
  const last = summary?.lastActivityAt ?? m.at;
  if (last) w.lastActivity = last;
  if (m.endedAt !== undefined) w.endedAt = m.endedAt;
  if (m.taskOutcome) w.outcome = m.taskOutcome;
  if (m.team) w.teamId = m.team.teamId;
  const preview = summary?.lastAssistantText ?? m.spec?.taskPreview;
  if (preview) w.preview = preview.length > 200 ? `${preview.slice(0, 200)}…` : preview;
  if (usage.source === "none") w.usageSource = "unavailable";
  else {
    w.usageSource = usage.source;
    w.usage = tokens(usage);
    if (snapshotAt !== undefined) w.usageAsOf = snapshotAt;
  }
  // The extension's rule, so a hosted and an unhosted view agree: a worker that was idle when its
  // host went away is merely restored; one that was running (or lost, or never reported a status)
  // was cut off mid-turn.
  if (status === "restored" && m.status !== "waiting") w.interruptedAt = Math.max(summary?.lastActivityAt ?? 0, m.at);
  return w;
}
