/**
 * `/explain <topic>` — spawn one forked pi child that writes a self-contained
 * HTML explanation into `~/.pi/agent/explanations/<id>/`, and record it in this
 * session when it settles.
 *
 * Shape of the feature:
 *
 *   /explain <topic>   parent (here)          child (one pi process)
 *   ────────────────   ────────────────────   ──────────────────────────────
 *   command handler →  create the store dir,  marks its own session as a
 *                      build the prompt,      worker (worker-mark.ts), then
 *                      fork the session,      read/grep/bash/write, research,
 *                      append `explain-doc`   write index.html + meta.json,
 *                      {status:"running"}     then stop
 *                   ←  validate the store,
 *                      append the final
 *                      `explain-doc` (same
 *                      id, no status),
 *                      wake the parent agent
 *
 * The parent conversation is untouched: the child works in a *copy* of the
 * session (`pi --fork`), so a long research run costs the parent no context. A
 * brand-new session has no file on disk yet; the child then starts unforked and
 * works from the topic alone.
 *
 * Nothing here opens a browser. The page is read in Sova (thread row, session
 * strip, gallery), or by opening the file by hand.
 *
 * Source ownership: `store.ts` owns the on-disk contract and the session-entry
 * shape, `prompt.ts` the child's instructions, `worker.ts` the forked process,
 * `explain.ts` the run lifecycle, and this file only the pi wiring.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ExplainRuns, MAX_LIVE, wakeMessage, type ExplainHost } from "./explain.ts";
import { parentIdentity } from "./identity.ts";
import { EXPLAIN_ENTRY_TYPE, type ExplainEntryData } from "./store.ts";

const USAGE = "Usage: /explain <topic>";

export default function explainExtension(pi: ExtensionAPI): void {
	/** The most recent context, for notifications from a child's settle callback. */
	let activeCtx: ExtensionContext | undefined;

	const host: ExplainHost = {
		now: () => Date.now(),
		appendEntry: (data) => pi.appendEntry<ExplainEntryData>(EXPLAIN_ENTRY_TYPE, data),
		notify: (message, level) => {
			// Independent of the message below: a broken UI must not swallow the result.
			try {
				if (activeCtx?.hasUI) activeCtx.ui.notify(message, level);
			} catch {
				/* Session replacement can invalidate the UI. */
			}
		},
		wake: (text) => {
			try {
				pi.sendMessage(wakeMessage(text), { deliverAs: "followUp", triggerTurn: true });
			} catch {
				/* Session replacement can invalidate the message API; the entry is already recorded. */
			}
		},
	};
	const runs = new ExplainRuns(host);

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
	});
	pi.on("turn_start", async (_event, ctx) => {
		activeCtx = ctx;
	});
	pi.on("session_shutdown", async () => {
		await runs.stopAll();
	});

	pi.registerEntryRenderer<ExplainEntryData>(EXPLAIN_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (!data) return undefined;
		// Provisional entry of a run still in progress; its final entry (same id) renders as below.
		if (data.status === "running") return new Text(`${theme.fg("warning", "[explaining]")} ${data.topic} — ${theme.fg("dim", "working…")}`, 0, 0);
		const label = data.error ? theme.fg("error", "[explain failed]") : theme.fg("accent", "[explain]");
		const detail = data.error ? data.error : data.summary || data.id;
		return new Text(`${label} ${data.topic} — ${theme.fg("dim", detail)}`, 0, 0);
	});

	pi.registerCommand("explain", {
		// pi's extension commands have no argumentHint field, so the hint lives at the front of the description.
		description: "<topic> — research it in a forked subagent and write a self-contained page, viewable in Sova",
		handler: async (args: string, ctx: ExtensionContext) => {
			activeCtx = ctx;
			const topic = args.trim();
			if (!topic) {
				ctx.ui.notify(`${USAGE}\n${runs.live} of ${MAX_LIVE} explanations running.`, "warning");
				return;
			}
			const parent = parentIdentity(ctx.sessionManager);
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "";
			try {
				const started = runs.begin({
					topic,
					cwd: ctx.cwd,
					parentSessionId: parent.id,
					...(parent.file ? { parentSessionFile: parent.file } : {}),
					model,
					...(ctx.thinkingLevel ? { effort: ctx.thinkingLevel } : {}),
				});
				const how = [started.forked ? "forked" : "fresh (this session is not on disk yet)", started.webSearch ? "web search on" : "no web search"].join(", ");
				ctx.ui.notify(`Explaining "${topic}" in a subagent (${how}). It lands in ${started.dir} and is announced here.`, "info");
			} catch (error) {
				ctx.ui.notify(`/explain: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
