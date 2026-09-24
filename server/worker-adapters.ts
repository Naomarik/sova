// The worker-transcript adapters the server reads restored workers with (worker-restore.ts): the
// same builtins-only readers the subagents extension registers, one per backend (pi with any
// provider, claude-code). A backend with no reader gets the protocol's "none" adapter, so its
// workers read as unavailable, never as 0.

import { defaultWorkerTranscriptAdapters } from "../pi-config/extensions/subagents/adapters/index.ts";
import type { WorkerTranscriptAdapters } from "../pi-config/extensions/subagents/worker-transcript.ts";

let shared: WorkerTranscriptAdapters | null = null;

export function defaultAdapters(): WorkerTranscriptAdapters {
  shared ??= defaultWorkerTranscriptAdapters();
  return shared;
}
