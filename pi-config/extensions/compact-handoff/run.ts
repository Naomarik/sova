/**
 * The run's row: the hidden `compact-handoff-run` custom entry the extension appends when the
 * fork starts (`running`) and again, same `id`, when the run ends. Per id the newest wins, in the
 * TUI (index.ts renderer) and in Sova (server/transcript.ts reads the same shape). Never model
 * context. Builtins only.
 */

/** The session's custom entry for one /compact-handoff run. */
export const RUN_ENTRY = "compact-handoff-run";

export type RunStatus = "running" | "saved" | "failed" | "cancelled" | "interrupted";

/** `{v: 1, id, status, at, focus?, path?, error?}`: `path` with `saved`, `error` with `failed`. */
export interface RunEntryData {
	v: 1;
	id: string;
	status: RunStatus;
	/** ISO time of this entry. */
	at: string;
	focus?: string;
	path?: string;
	error?: string;
}

const STATUSES: readonly RunStatus[] = ["running", "saved", "failed", "cancelled", "interrupted"];

/** The entry's data, or undefined when it is not one this version wrote. */
export function readRunData(data: unknown): RunEntryData | undefined {
	const d = data as Partial<RunEntryData> | undefined;
	if (!d || d.v !== 1 || typeof d.id !== "string" || !d.id || typeof d.at !== "string" || !STATUSES.includes(d.status as RunStatus)) return undefined;
	return {
		v: 1,
		id: d.id,
		status: d.status as RunStatus,
		at: d.at,
		...(typeof d.focus === "string" && d.focus ? { focus: d.focus } : {}),
		...(typeof d.path === "string" && d.path ? { path: d.path } : {}),
		...(typeof d.error === "string" && d.error ? { error: d.error } : {}),
	};
}

/** The ids whose newest entry on the branch is still `running`, oldest first, with that entry. */
export function stillRunning(branch: readonly { type: string; customType?: string; data?: unknown }[]): RunEntryData[] {
	const latest = new Map<string, RunEntryData>();
	for (const entry of branch) {
		if (entry.type !== "custom" || entry.customType !== RUN_ENTRY) continue;
		const data = readRunData(entry.data);
		if (!data) continue;
		latest.delete(data.id); // Re-insert, so the order is each id's newest entry.
		latest.set(data.id, data);
	}
	return [...latest.values()].filter((data) => data.status === "running");
}

/** The row's one line, as the TUI and Sova both word it. */
export function runLine(data: RunEntryData): string {
	switch (data.status) {
		case "running":
			return `Writing a handoff note${data.focus ? `: ${data.focus}` : ""}`;
		case "saved":
			return `Handoff note saved${data.path ? `: ${data.path}` : ""}`;
		case "failed":
			return `Handoff note failed${data.error ? `: ${data.error}` : ""}`;
		case "cancelled":
			return "Handoff cancelled";
		case "interrupted":
			return "Handoff interrupted: the session stopped before the note was written";
	}
}
