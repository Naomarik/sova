/**
 * /compact-handoff [focus | cancel]: a background fork of the session writes a handoff note, the
 * note is saved, the session compacts, and the note comes back hidden right after the summary —
 * after this compaction and every later one on the branch (plain /compact, threshold, overflow).
 *
 * The fork: `../subagents/fork/` (copy, cache identity, read-only policy, runner), the same core
 * /explain uses; nothing of its cache logic lives here. The fork works in a copy of the session,
 * so its turn never enters the session: only the run's `compact-handoff-run` row (run.ts) is
 * appended, at start and at the end. The note is its final reply's `<handoff>` block.
 *
 * Compacting: the session stays usable while the fork writes. When the fork settles with a note,
 * the note is saved at once, and the session compacts now if it is idle with nothing queued,
 * else on its next `agent_settled`, deferred a tick like claude-code's auto-compact
 * (provider/auto-compact.ts): pi emits the extension's `agent_settled` before its session
 * listeners, and a host (Sova) hands a queued prompt off on that session event. Every prompt bumps
 * a per-session counter; a counter that moved since the settle means a prompt won the race, and
 * `session_before_compact` cancels our own compaction for the same reason. Either way the
 * compaction waits for the next idle moment.
 *
 * The note is written by this process with node fs, never by the agent's tools: a sandbox makes
 * the agent dir read-only to tools, and a remote session's tools write on the far host.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { ClaudeForkPoint } from "../claude-code/provider/fork-point.ts";
import {
	claudeForkPointFor,
	startBackgroundFork,
	type BackgroundForkHandle,
	type BackgroundForkHandlers,
	type BackgroundForkResult,
	type BackgroundForkSpec,
} from "../subagents/fork/background.ts";
import { copyForFork, forkable, sweepStale } from "../subagents/fork/copy.ts";
import type { ForkPolicy } from "../subagents/fork/mirror.ts";
import { rpcScopedModel } from "../subagents/runner.ts";
import {
	agentDir as defaultAgentDir,
	type BranchEntry,
	extractHandoff,
	forkTask,
	HANDOFF_ENTRY,
	type HandoffEntryData,
	handoffPath,
	isNothingNote,
	latestHandoff,
	NOTE_MESSAGE,
	noteFile,
	noteInKeptTail,
	restoreText,
	runsRoot,
	writeNoteFile,
} from "./handoff.ts";
import { readRunData, RUN_ENTRY, type RunEntryData, runLine, stillRunning } from "./run.ts";

/** What pi's compact() throws when an extension or an abort (a user's Stop) cancels it. */
const CANCELLED = "Compaction cancelled";
/** Worker name: the fork is recognizable in `ps` output and its own session list. */
export const WORKER_NAME = "compact-handoff";
/** The fork may read (files, search, a read-only shell line) and nothing else: no writes, no web. */
export const HANDOFF_POLICY: ForkPolicy = { label: "The handoff writer" };
/** A failed run's directory is kept this long for diagnosis, then swept by the next run. */
const STALE_RUN_MS = 24 * 60 * 60 * 1000;
const MAX_ERROR = 300;

export interface CompactHandoffOptions {
	/** The agent dir the note files go under; default PI_CODING_AGENT_DIR as pi resolves it. */
	agentDir?: () => string;
	now?: () => number;
	/** Test seam; defaults to the shared background fork. */
	start?(spec: BackgroundForkSpec, handlers: BackgroundForkHandlers): BackgroundForkHandle;
	/** Test seam; defaults to the core's claudeForkPointFor. */
	claudeForkPoint?(model: string | undefined, parentSessionId: string): ClaudeForkPoint | undefined;
}

interface Run {
	id: string;
	sessionId: string;
	focus: string;
	/** `<agent dir>/compact-handoffs/.runs/<id>`: the session copy and the fork's own session. */
	dir: string;
	ctx: ExtensionContext;
	handle?: BackgroundForkHandle;
	settled: boolean;
	cancelled: boolean;
	/** The session is closing: write nothing; the next prompt settles the row as interrupted. */
	closing: boolean;
}

/** A saved note whose compaction waits for the session's next idle moment. */
interface Waiting {
	data: HandoffEntryData;
	focus: string;
}

function oneLine(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > MAX_ERROR ? `${line.slice(0, MAX_ERROR - 1)}…` : line;
}

export default function compactHandoff(pi: ExtensionAPI, options: CompactHandoffOptions = {}): void {
	const dirOf = options.agentDir ?? (() => defaultAgentDir());
	const now = options.now ?? Date.now;
	const start = options.start ?? startBackgroundFork;
	const forkPointOf = options.claudeForkPoint ?? claudeForkPointFor;
	/** The fork under way, per pi session: from the command until it settles. */
	const runs = new Map<string, Run>();
	/** Saved notes waiting to compact, per pi session. */
	const waiting = new Map<string, Waiting>();
	/** Prompts seen, per pi session: any movement means a turn is on its way. */
	const prompts = new Map<string, number>();
	/** The prompt count our compaction was started at, until pi asks before compacting. */
	const started = new Map<string, number>();
	/** Sessions whose compaction we cancelled ourselves. */
	const vetoed = new Set<string>();

	const idOf = (ctx: ExtensionContext): string => ctx.sessionManager.getSessionId();
	const promptsOf = (sessionId: string): number => prompts.get(sessionId) ?? 0;
	const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void => {
		try { ctx.ui?.notify?.(message, level); } catch { /* a replaced session can invalidate the UI */ }
	};
	const bump = (_event: unknown, ctx: ExtensionContext): void => {
		try { const id = idOf(ctx); prompts.set(id, promptsOf(id) + 1); } catch { /* no session to count */ }
	};
	const record = (data: RunEntryData): void => {
		try { pi.appendEntry<RunEntryData>(RUN_ENTRY, data); } catch { /* a lost row costs only the thread line */ }
	};
	const stamp = (): string => new Date(now()).toISOString();
	/** The run's session is still the one this extension writes to. */
	const current = (run: Run): boolean => {
		if (run.closing) return false;
		try { return idOf(run.ctx) === run.sessionId; } catch { return false; }
	};
	const removeDir = (dir: string): void => {
		try { rmSync(dir, { recursive: true, force: true }); } catch { /* the sweep takes it later */ }
	};

	/**
	 * Settle the running rows no fork of THIS process is behind (a restart, /reload or crash
	 * stopped them), once per session and only when the session is written anyway: its first
	 * prompt, or /compact-handoff. Opening a session never writes.
	 */
	let reconciledFor: string | undefined;
	const reconcile = (ctx: ExtensionContext): void => {
		try {
			const sessionId = idOf(ctx);
			if (reconciledFor === sessionId) return;
			reconciledFor = sessionId;
			const live = runs.get(sessionId)?.id;
			for (const data of stillRunning(ctx.sessionManager.getBranch() as BranchEntry[])) {
				if (data.id === live) continue;
				record({ v: 1, id: data.id, status: "interrupted", at: stamp(), ...(data.focus ? { focus: data.focus } : {}) });
			}
		} catch { /* best effort: an unsettled row only keeps reading as running */ }
	};

	pi.on("input", (event, ctx) => { bump(event, ctx); return { action: "continue" }; });
	pi.on("before_agent_start", (event, ctx) => { bump(event, ctx); reconcile(ctx); });
	pi.on("agent_start", bump);

	pi.registerEntryRenderer<RunEntryData>(RUN_ENTRY, (entry, _options, theme) => {
		const data = readRunData(entry.data);
		if (!data) return undefined;
		const tag =
			data.status === "running" ? theme.fg("warning", "[compact-handoff]")
			: data.status === "failed" ? theme.fg("error", "[compact-handoff failed]")
			: data.status === "interrupted" || data.status === "cancelled" ? theme.fg("warning", "[compact-handoff]")
			: theme.fg("accent", "[compact-handoff]");
		return new Text(`${tag} ${theme.fg("dim", runLine(data))}`, 0, 0);
	});

	pi.on("session_before_compact", (event, ctx) => {
		const sessionId = idOf(ctx);
		const at = started.get(sessionId);
		if (at === undefined || event.reason !== "manual") return undefined;
		started.delete(sessionId);
		if (promptsOf(sessionId) === at) return undefined;
		vetoed.add(sessionId);
		return { cancel: true };
	});

	/** Save the note: the file first, then the entry that carries it along the branch. Throws when the file can't be written. */
	const save = (run: Run, note: string): HandoffEntryData => {
		const at = stamp();
		const leafId = run.ctx.sessionManager.getLeafId();
		const file = handoffPath(dirOf(), run.sessionId);
		writeNoteFile(file, noteFile({ sessionId: run.sessionId, cwd: run.ctx.cwd, at, leafId, focus: run.focus }, note));
		const data: HandoffEntryData = { v: 1, path: file, note, at, leafId };
		pi.appendEntry(HANDOFF_ENTRY, data);
		return data;
	};

	const compactNow = (ctx: ExtensionContext, sessionId: string, wait: Waiting, at: number): void => {
		waiting.delete(sessionId);
		const instructions = [
			wait.focus,
			isNothingNote(wait.data.note) ? "" : `A handoff note written just before this compaction is saved at ${wait.data.path} and is added back right after this summary.`,
		].filter(Boolean).join("\n\n");
		started.set(sessionId, at);
		ctx.compact({
			customInstructions: instructions,
			onComplete: () => { started.delete(sessionId); },
			onError: (error) => {
				started.delete(sessionId);
				if (vetoed.delete(sessionId)) {
					// A prompt won the race: try again at the next idle moment.
					waiting.set(sessionId, wait);
					return;
				}
				// The user's Stop is their choice, not news; the note stays saved either way.
				if (error.message !== CANCELLED) notify(ctx, `/compact-handoff: compaction failed (${error.message}). The note is saved at ${wait.data.path}.`, "warning");
			},
		});
	};

	const fail = (run: Run, reason: string): void => {
		record({ v: 1, id: run.id, status: "failed", at: stamp(), error: reason, ...(run.focus ? { focus: run.focus } : {}) });
		notify(run.ctx, `/compact-handoff: ${reason}, so nothing was saved or compacted.`, "warning");
		// The run dir stays for diagnosis; the sweep removes it after a day.
	};

	const settle = (run: Run, result: BackgroundForkResult): void => {
		if (run.settled) return;
		run.settled = true;
		if (runs.get(run.sessionId) === run) runs.delete(run.sessionId);
		void run.handle?.stop().catch(() => {});
		if (!current(run)) return;
		if (run.cancelled) {
			record({ v: 1, id: run.id, status: "cancelled", at: stamp(), ...(run.focus ? { focus: run.focus } : {}) });
			removeDir(run.dir);
			notify(run.ctx, "/compact-handoff cancelled: nothing was saved or compacted.");
			return;
		}
		if (result.outcome !== "success") return fail(run, `the fork ${result.outcome === "aborted" ? "was stopped" : "failed"}${result.error ? ` (${oneLine(result.error)})` : ""}`);
		const note = extractHandoff(result.finalOutput);
		if (!note) return fail(run, "the fork's reply had no <handoff> note");
		let data: HandoffEntryData;
		try {
			data = save(run, note);
		} catch (error) {
			return fail(run, `the note could not be saved (${oneLine((error as Error).message)})`);
		}
		record({ v: 1, id: run.id, status: "saved", at: data.at, path: data.path, ...(run.focus ? { focus: run.focus } : {}) });
		removeDir(run.dir);
		const wait: Waiting = { data, focus: run.focus };
		const ctx = run.ctx;
		if (ctx.isIdle() && !ctx.hasPendingMessages()) return compactNow(ctx, run.sessionId, wait, promptsOf(run.sessionId));
		waiting.set(run.sessionId, wait);
		notify(ctx, `/compact-handoff: the note is saved at ${data.path}; the session compacts when it is next idle.`);
	};

	const cancel = async (ctx: ExtensionContext, sessionId: string): Promise<void> => {
		const run = runs.get(sessionId);
		if (run) {
			run.cancelled = true;
			run.ctx = ctx;
			await run.handle?.stop().catch(() => {});
			// stop() settles a running fork; this only covers a handle that never reported.
			settle(run, { outcome: "aborted", finalOutput: "" });
			return;
		}
		const wait = waiting.get(sessionId);
		if (wait) {
			waiting.delete(sessionId);
			notify(ctx, `/compact-handoff will not compact. The note stays saved at ${wait.data.path} and comes back after the next compaction.`);
			return;
		}
		notify(ctx, "No /compact-handoff is under way in this session.", "warning");
	};

	pi.registerCommand("compact-handoff", {
		description: "[focus | cancel] — a background fork writes a handoff note; compact, and add the note back after the summary",
		handler: async (args, ctx) => {
			const sessionId = idOf(ctx);
			const focus = (args ?? "").trim();
			if (focus === "cancel") return cancel(ctx, sessionId);
			if (runs.has(sessionId) || waiting.has(sessionId)) {
				notify(ctx, "A /compact-handoff is already under way in this session (/compact-handoff cancel stops it).", "warning");
				return;
			}
			if (!ctx.isIdle() || ctx.hasPendingMessages()) {
				notify(ctx, "/compact-handoff waits for an idle session: let the turn, compaction or queued messages finish, then run it again.", "warning");
				return;
			}
			reconcile(ctx);
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!forkable(sessionFile)) {
				notify(ctx, "/compact-handoff: this session has no conversation on disk yet, so there is nothing to hand off.", "warning");
				return;
			}
			const id = randomUUID();
			const root = runsRoot(dirOf());
			const dir = join(root, id);
			const copy = join(dir, "copy.jsonl");
			try {
				mkdirSync(root, { recursive: true, mode: 0o700 });
				sweepStale(root, STALE_RUN_MS, now(), (name) => [...runs.values()].some((r) => r.id === name));
				mkdirSync(dir, { mode: 0o700 });
				if (!copyForFork(sessionFile, copy)) throw new Error("the session file has no complete line to copy");
			} catch (error) {
				removeDir(dir);
				notify(ctx, `/compact-handoff could not start its fork (${oneLine((error as Error).message)}); nothing was done.`, "error");
				return;
			}
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			// A Claude CLI parent: its live CLI session is where the fork picks up, not a folded replay.
			const claudeFork = forkPointOf(model, sessionId);
			const run: Run = { id, sessionId, focus, dir, ctx, settled: false, cancelled: false, closing: false };
			runs.set(sessionId, run);
			try {
				run.handle = start(
					{
						id,
						name: WORKER_NAME,
						task: forkTask(focus),
						cwd: ctx.cwd,
						...(model ? { model } : {}),
						...(ctx.thinkingLevel ? { effort: ctx.thinkingLevel } : {}),
						forkSession: copy,
						sessionDir: join(dir, "sessions"),
						policy: HANDOFF_POLICY,
						...(claudeFork ? { claudeFork } : {}),
					},
					{ onSettled: (result) => settle(run, result) },
				);
			} catch (error) {
				runs.delete(sessionId);
				removeDir(dir);
				notify(ctx, `/compact-handoff could not start its fork (${oneLine((error as Error).message)}); nothing was done.`, "error");
				return;
			}
			if (!run.settled) record({ v: 1, id, status: "running", at: stamp(), ...(focus ? { focus } : {}) });
			const fold = rpcScopedModel(model) && !claudeFork
				? " The Claude Code session is not live and idle, so the fork replays the history without the prompt cache."
				: "";
			notify(ctx, `/compact-handoff: a background fork is writing the handoff note; the session compacts when it lands. /compact-handoff cancel stops it.${fold}`);
		},
	});

	pi.on("agent_settled", (_event, ctx) => {
		let sessionId: string;
		try { sessionId = idOf(ctx); } catch { return; }
		if (!waiting.has(sessionId)) return;
		const settledAt = promptsOf(sessionId);
		setTimeout(() => {
			// A context whose session was replaced in the meantime throws when used.
			try {
				const wait = waiting.get(sessionId);
				if (!wait || promptsOf(sessionId) !== settledAt || !ctx.isIdle() || ctx.hasPendingMessages()) return;
				compactNow(ctx, sessionId, wait, settledAt);
			} catch { /* the session moved on */ }
		}, 0);
	});

	pi.on("session_shutdown", async () => {
		const live = [...runs.values()];
		runs.clear();
		waiting.clear();
		for (const run of live) run.closing = true;
		// Nothing is written while a session closes; the next prompt settles their rows as interrupted.
		await Promise.all(live.map((run) => run.handle?.stop().catch(() => {})));
	});

	// After any compaction: the newest note on this branch, hidden, right after the summary. No
	// turn: idle, it is appended at once; during a run pi appends it at the run's next turn boundary.
	pi.on("session_compact", (event, ctx) => {
		// Any compaction brings the note back, so one still waiting has nothing left to do.
		try { waiting.delete(idOf(ctx)); } catch { /* no session */ }
		const branch = ctx.sessionManager.getBranch() as BranchEntry[];
		const data = latestHandoff(branch);
		// A "nothing" note is the newest word: it adds nothing, and no older note comes back in its place.
		if (!data || isNothingNote(data.note)) return;
		const kept = noteInKeptTail(branch, event.compactionEntry.firstKeptEntryId, event.compactionEntry.id, data.note);
		pi.sendMessage(
			{ customType: NOTE_MESSAGE, display: false, content: restoreText(data, now(), kept), details: { v: 1, path: data.path, at: data.at } },
			{ triggerTurn: false },
		);
	});
}
