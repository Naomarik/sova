/**
 * The worker transcript adapters Sova and the subagents extension share: pi
 * (any provider) and claude-code. Any other backend resolves to the "none"
 * adapter, so its workers show as unavailable, never as 0. Node builtins only.
 */
import { WorkerTranscriptAdapters, parseJsonLines, type WorkerUsage } from "../worker-transcript.ts";
import { createPiTranscriptAdapter, piUsageAccumulator, type PiUsageOptions } from "./pi.ts";
import { claudeUsageAccumulator, createClaudeTranscriptAdapter, type ClaudeTranscriptAdapterOptions } from "../../claude-code/transcript-adapter.ts";

export interface DefaultAdapterOptions {
	claude?: ClaudeTranscriptAdapterOptions;
}

export function defaultWorkerTranscriptAdapters(options: DefaultAdapterOptions = {}): WorkerTranscriptAdapters {
	return new WorkerTranscriptAdapters([createPiTranscriptAdapter(), createClaudeTranscriptAdapter(options.claude)]);
}

/**
 * A running usage total over JSONL text, for a caller that tails a file: a
 * "snapshot" restarts the tally (the file was read from the top), an "append"
 * adds to it. Returns the cumulative usage after that text. Deduplicating and
 * stateful, so a repeated line or one straddling two appends counts once.
 */
export type WorkerUsageTally = (text: string, part: "snapshot" | "append") => WorkerUsage;

export function workerUsageTally(backend: "pi" | "claude-code", options: PiUsageOptions = {}): WorkerUsageTally {
	const acc = backend === "claude-code" ? claudeUsageAccumulator() : piUsageAccumulator(options);
	return (text, part) => {
		if (part === "snapshot") acc.reset();
		acc.add(parseJsonLines(text));
		return acc.usage();
	};
}
