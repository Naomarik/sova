/**
 * The spec checks for a pi WORKER (and team member). Workers start with `--no-extensions`, so the mode
 * extension (and its hooks) never loads in them; the subagents spawn path loads this file instead, with
 * `-e`, into every code-writing pi worker a spec-on session spawns (beside the worker spec brief in its
 * prompt).
 *
 * - The census: after any tool call, bash included, a Git delta (the first changed file in the boundary,
 *   each new file, a new file outside the boundary no claim maps) appends the same `[spec census]` digest
 *   as the parent's (spec-guard.ts CensusHook), plus the write guard (the current spec written by hand,
 *   commits a draft's evidence names rewritten) and promote's drift warnings.
 * - The turn-end line check, as the Claude Code Stop hook's: a run that edited, committed, promoted or
 *   merged ends with an `Also changes:` line naming every foreign § its own operations and its tree's
 *   changes computed from Git (the task's own claims out); a landing (a merge, a promote, a commit that
 *   changed the current spec) also passes the landing gate (Plumbing / Deferred lines). A landing is
 *   re-prompted up to LANDING_REPROMPTS times, any other wrong line (a line on a Q&A run included) once.
 * - The ledger: each of its own git operations that moved a HEAD (or promoted) is appended to the
 *   parent's ledger (SOVA_SPEC_LEDGER), so the parent's check counts it wherever it landed.
 *
 * No prompt, command or tool of its own; the trusted tools are found as spec-mode.md's `$core` line finds
 * them. PI_SPEC_CENSUS_HOOK=0 turns the census off, PI_SPEC_CHECK=0 the line check.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { resolve } from "node:path";
import {
	appendLedger,
	bashCommands,
	CensusHook,
	CHECK_TAG,
	commandDirs,
	coreDir,
	DIGEST_TAG,
	driftNote,
	freshTally,
	gitCommits,
	gitMerges,
	headAt,
	LANDING_REPROMPTS,
	LEDGER_ENV,
	type OpLanding,
	promoteWrites,
	repromptText,
	SpecWriteGuard,
	tallyCheck,
	tallyOps,
	tallyTree,
	treeStart,
	type TreeStart,
} from "./spec-guard.ts";

const CHECK_MESSAGE = "spec-check";

export default function specWorker(pi: ExtensionAPI): void {
	const core = () => coreDir(process.env, homedir());
	const census = new CensusHook({ core });
	const writes = new SpecWriteGuard();
	let running = false;
	let reply = "";
	let reprompts = 0;
	let run: { tree?: TreeStart; ops: OpLanding[]; opening: Map<string, { top: string; before: string; kind: OpLanding["kind"] }[]>; changed: boolean; tools: boolean } = {
		ops: [],
		opening: new Map(),
		changed: false,
		tools: false,
	};

	pi.on("session_start", async () => {
		census.reset();
		running = false;
	});

	// The tree as the run finds it is the baseline, so the run's first edit is already a delta.
	pi.on("agent_start", async (_event, ctx) => {
		if (running) return;
		running = true;
		reprompts = 0;
		reply = "";
		run = { ops: [], opening: new Map(), changed: false, tools: false, tree: await treeStart(ctx.cwd).catch(() => undefined) };
		if (process.env.PI_SPEC_CENSUS_HOOK !== "0") await census.prime(ctx.cwd);
	});

	pi.on("tool_call", async (event, ctx) => {
		run.tools = true;
		if (process.env.PI_SPEC_CENSUS_HOOK !== "0") {
			await writes.before(event.toolCallId, { cwd: ctx.cwd, toolName: event.toolName, input: event.input, signal: ctx.signal });
			await census.before({ cwd: ctx.cwd, toolName: event.toolName, input: event.input, signal: ctx.signal });
		}
		const cmd = event.toolName === "bash" ? (event.input as { command?: unknown } | undefined)?.command : undefined;
		if (typeof cmd !== "string" || !(gitCommits(cmd) || gitMerges(cmd) || promoteWrites(cmd))) return;
		const kind: OpLanding["kind"] = promoteWrites(cmd) ? "promote" : gitMerges(cmd) ? "merge" : "commit";
		const opening: { top: string; before: string; kind: OpLanding["kind"] }[] = [];
		for (const dir of commandDirs(cmd, ctx.cwd)) {
			const at = await headAt(resolve(ctx.cwd, dir));
			if (at && !opening.some((o) => o.top === at.top)) opening.push({ top: at.top, before: at.head, kind });
		}
		if (opening.length) run.opening.set(event.toolCallId, opening);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!event.isError && (event.toolName === "edit" || event.toolName === "write")) run.changed = true;
		const opening = run.opening.get(event.toolCallId);
		if (opening) {
			run.opening.delete(event.toolCallId);
			for (const o of opening) {
				const at = await headAt(o.top);
				if (!at || (at.head === o.before && !(o.kind === "promote" && !event.isError))) continue;
				run.changed = true;
				const op: OpLanding = { top: o.top, before: o.before, after: at.head, kind: o.kind, actor: "self" };
				run.ops.push(op);
				const ledger = process.env[LEDGER_ENV];
				if (ledger)
					appendLedger(ledger, { v: 1, at: Date.now(), actor: { runtime: "pi", session: ctx.sessionManager.getSessionId?.() }, top: op.top, before: op.before, after: op.after, kind: op.kind });
			}
		}
		if (process.env.PI_SPEC_CENSUS_HOOK === "0") return;
		const { text: forbidden, lost } = await writes.after(event.toolCallId, { cwd: ctx.cwd, toolName: event.toolName, input: event.input, signal: ctx.signal });
		const { text: digest, failure } = await census.after({
			cwd: ctx.cwd,
			orphansSaid: lost,
			toolName: event.toolName,
			input: event.input,
			signal: ctx.signal,
			commands: bashCommands(ctx.sessionManager.getBranch()),
			sessionStart: ctx.sessionManager.getHeader()?.timestamp,
		});
		if (failure && ctx.hasUI) ctx.ui.notify(failure, "warning");
		// Workers are headless: a failure is said to the model, never only to a UI (F12).
		const text = [forbidden, driftNote(event.toolName, event.input, event.content), digest, failure ? `${DIGEST_TAG} ${failure}` : undefined].filter(Boolean).join("\n");
		if (text) return { content: [...event.content, { type: "text" as const, text }] };
	});

	pi.on("turn_end", async (event) => {
		const m = event.message as { role?: string; content?: unknown } | undefined;
		if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return;
		reply = (m.content as { type?: string; text?: string }[])
			.filter((b) => b?.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n");
	});

	pi.on("agent_before_settle", async (event) => {
		if (process.env.PI_SPEC_CHECK === "0" || event.outcome !== "completed") return;
		try {
			const t = freshTally(run.changed, run.ops.some((o) => o.kind === "promote"));
			await tallyOps(t, run.ops, (top) => (top === run.tree?.view.top ? run.tree?.defaultTip : undefined), core());
			if (run.tree && run.tools) await tallyTree(t, run.tree, core(), undefined, { commits: false, promoted: run.ops.some((o) => o.kind === "promote") });
			const { check, foreign } = tallyCheck(t, reply);
			const problems = t.errors.length ? [`${CHECK_TAG} the check itself failed: ${t.errors.join("; ")}. Check your \`Also changes:\` line against \`foreign\` by hand.`] : [];
			if ((check.ok && !t.conflicts.length && !problems.length) || reprompts >= (t.landing ? LANDING_REPROMPTS : 1)) return;
			reprompts++;
			const what = t.landing ? t.landed.join(" and ") || [...new Set(run.ops.map((o) => o.kind))].join(" and ") || "landed" : "changed files";
			const content = [...(check.ok ? [] : [repromptText(check, foreign, what)]), ...t.conflicts, ...problems].join("\n");
			return { entries: [...event.entries, { type: "custom_message" as const, customType: CHECK_MESSAGE, display: false, content }], continue: true };
		} catch (error) {
			const content = `${CHECK_TAG} the check itself failed: ${error instanceof Error ? error.message : String(error)}. Check your \`Also changes:\` line against \`foreign\` by hand.`;
			if (reprompts++ >= 1) return;
			return { entries: [...event.entries, { type: "custom_message" as const, customType: CHECK_MESSAGE, display: false, content }], continue: true };
		}
	});

	pi.on("agent_settled", async () => {
		running = false;
	});
}
