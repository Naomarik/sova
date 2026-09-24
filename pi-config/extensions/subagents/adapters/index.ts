/**
 * The worker transcript adapters Sova and the subagents extension share: pi
 * (any provider) and claude-code. Any other backend resolves to the "none"
 * adapter, so its workers show as unavailable, never as 0. Node builtins only.
 */
import { WorkerTranscriptAdapters } from "../worker-transcript.ts";
import { createPiTranscriptAdapter } from "./pi.ts";
import { createClaudeTranscriptAdapter, type ClaudeTranscriptAdapterOptions } from "../../claude-code/transcript-adapter.ts";

export interface DefaultAdapterOptions {
	claude?: ClaudeTranscriptAdapterOptions;
}

export function defaultWorkerTranscriptAdapters(options: DefaultAdapterOptions = {}): WorkerTranscriptAdapters {
	return new WorkerTranscriptAdapters([createPiTranscriptAdapter(), createClaudeTranscriptAdapter(options.claude)]);
}
