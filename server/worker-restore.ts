// A session's workers when no process is publishing them (§chat/subagents restored workers): the
// session isn't hosted by this server and no TUI owns it, so there is no live record. Its own
// JSONL still holds each worker's durable record (the subagents extension's registry/manifest
// entries), and each worker's transcript is read through the backend's adapter — the same
// protocol module and fold the extension restores from, so both sides agree on what a worker is.
//
// Read-only: session files and transcripts are only ever read. Every worker comes back not
// working (nothing runs it); resuming needs a runtime, so nothing here is `resumable`.

import { stat } from "node:fs/promises";
import type { WorkerInfo, WorkerStatus } from "../shared/protocol";
import {
  type FoldedWorkerManifest,
  manifestModes,
  readWorkerManifests,
  resolvedModel,
  resolveWorkerUsage,
  type WorkerTranscriptAdapters,
  type WorkerTranscriptSummary,
  type WorkerUsage,
} from "../pi-config/extensions/subagents/worker-transcript.ts";
import { modelProvider } from "./models";
import { claudeSpawnModel, type WindowResolver, withSpawnVariant, workerWindow } from "./worker-context";

type Entry = Record<string, any>;

export interface RestoredWorkers {
  /** Workers with a record on the active branch, newest activity first by the caller's sort. */
  workers: WorkerInfo[];
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

  /** `entries`: every entry of the session file (all branches); `branch`: the active one.
      `resolveWindow` names a pi model's context window; without it pi workers carry none. */
  async restore(entries: readonly Entry[], branch: readonly Entry[], resolveWindow: WindowResolver = () => null): Promise<RestoredWorkers> {
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
    for (const { m, summary, usage } of views) {
      if (m.onActiveBranch) workers.push(workerInfo(m, summary, usage, resolveWindow));
    }
    return { workers };
  }
}

/** The active branch's workers whose id isn't in `skip`, newest spawn first, from their durable
    records alone: no transcript is read, so usage is the snapshot the record saved (or
    unavailable). What the pane appends for the workers a live record couldn't list. */
export function workersFromRecords(entries: readonly Entry[], branch: readonly Entry[], skip: ReadonlySet<string>, resolveWindow: WindowResolver = () => null): WorkerInfo[] {
  const activeEntryIds = new Set(branch.map((e) => e.id).filter((id): id is string => typeof id === "string"));
  const { manifests } = readWorkerManifests(entries, { activeEntryIds });
  const out: WorkerInfo[] = [];
  // The fold keeps first-record order, which is spawn order.
  for (const m of [...manifests.values()].reverse()) {
    if (!m.onActiveBranch || skip.has(m.workerId)) continue;
    out.push(workerInfo(m, null, resolveWorkerUsage(undefined, m.usageSnapshot), resolveWindow));
  }
  return out;
}

function workerInfo(m: FoldedWorkerManifest, summary: WorkerTranscriptSummary | null, usage: WorkerUsage, resolveWindow: WindowResolver): WorkerInfo {
  const status = statusOf(m);
  // The model it ran under, as its running record names it (haiku-4.5 in every state): the
  // protocol's one rule, shared with the subagents extension.
  const model = resolvedModel(m, summary ? { summary } : undefined);
  // A claude-code transcript names the bare id; the spawn model keeps its `[1m]` variant, which
  // both the label and the window below take from it.
  const spawn = m.backend === "claude-code" ? claudeSpawnModel(m) : undefined;
  const w: WorkerInfo = { id: m.workerId, name: m.name ?? m.workerId, status, working: false, backend: m.backend };
  if (model) w.model = withSpawnVariant(model, spawn);
  const provider = m.backend === "claude-code" ? "claude code" : modelProvider(model);
  if (provider) w.provider = provider;
  const effort = m.spec?.effort ?? summary?.effort;
  if (effort) w.effort = effort;
  // The modes its newest start gave it; a record of an older pi-config says nothing.
  const modes = manifestModes(m);
  if (modes?.length) w.modes = modes;
  if (m.ref?.kind === "pi-session-file") w.sessionFile = m.ref.locator;
  const sessionId = m.ref?.kind === "claude-session-id" ? m.ref.locator : m.ref?.sessionId;
  if (sessionId) w.sessionId = sessionId;
  // Its first spawn: the transcript's start, else its first record's time (the extension's rule).
  const started = summary?.startedAt ?? m.firstAt;
  if (started !== undefined) w.startedAt = started;
  const last = summary?.lastActivityAt ?? m.at;
  if (last) w.lastActivity = last;
  if (m.endedAt !== undefined) w.endedAt = m.endedAt;
  if (m.taskOutcome) w.outcome = m.taskOutcome;
  if (m.team) w.teamId = m.team.teamId;
  const preview = summary?.lastAssistantText ?? m.spec?.taskPreview;
  if (preview) w.preview = preview.length > 200 ? `${preview.slice(0, 200)}…` : preview;
  // Model replies, when its transcript or snapshot counted them; an older record says nothing.
  // (What it spent is the usage ledger's, never counted here.)
  if (usage.source !== "none" && typeof usage.turns === "number") w.turns = usage.turns;
  // The extension's rule, so a hosted and an unhosted view agree: a worker that was idle when its
  // host went away is merely restored; one that was running (or lost, or never reported a status)
  // was cut off mid-turn.
  if (status === "restored" && m.status !== "waiting") w.interruptedAt = Math.max(summary?.lastActivityAt ?? 0, m.at);
  // Context fill as of its last reply. The window follows the model it was SPAWNED with for
  // claude-code: `model` above is the transcript's bare id, which has lost a `[1m]` variant.
  const window = workerWindow(w, resolveWindow, spawn);
  if (window) w.contextWindow = window;
  const fill = summary?.lastContextTokens;
  if (fill === null) w.context = "compacted";
  else if (typeof fill === "number") w.context = { tokens: fill, window };
  return w;
}
