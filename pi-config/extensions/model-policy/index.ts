/**
 * model-policy: enforces the global half of `~/.pi/agent/model-policy.json` in this session.
 *
 * The file says which providers and models may be used at all (see policy.ts). Sova's Settings →
 * Models tab writes it; this extension is what makes "disabled" mean disabled inside a running pi,
 * where the built-in `/model` picker and `ctrl+p` cycling belong to pi and list everything the
 * registry has. Nothing here ever picks another model for you: a refusal names the model and the
 * switch that has to move, and the session stays where it is.
 *
 * WHERE IT CATCHES, and why there (verified against pi 0.86.1's own control flow, and end to end
 * against a real `pi --mode rpc` session pointed at a fake provider that counts requests):
 *
 *   1. `model_select` — picking a disabled model puts the previous model back and says why. If the
 *      previous model is disabled too (or there wasn't one), the session stays where it is and
 *      refuses to run. A `restore` is history replaying rather than a choice, so it is never
 *      rewritten; the session keeps its model and is refused at the next turn instead.
 *
 *   2. `input` — every message the user sends, refused before the turn starts. ALL text, not just
 *      prose: by the time this event fires, pi's interactive mode has already handled its own
 *      commands (`/model`, `/thinking`, `/new`, `/compact`, … — `interactive-mode.js` returns from
 *      `onSubmit` before any `prompt()`), and `prompt()` has already dispatched extension commands
 *      (`agent-session.js` `_tryExecuteExtensionCommand`, before `_runInputHandlers`). What is left
 *      is exactly what reaches the model: prose, `/skill:name`, `/template`, and unknown `/words`,
 *      all of which expand into a prompt AFTER this hook. Letting "anything starting with /"
 *      through would have let a skill or a prompt template run on a disabled model.
 *
 *   3. `context` — the backstop, and the last cancellable point before the provider request. A turn
 *      can start without any user input: `pi.sendMessage(…, {triggerTurn: true})`, a `turn_end` or
 *      `agent_before_settle` continuation, a retry. None of those pass through `input`. Throwing is
 *      not an option — the extension runner catches handler errors at EVERY hook
 *      (`runner.js` `emitBeforeAgentStart`, `emitContext`, `emitBeforeProviderRequest` all log and
 *      carry on) — so the stop is `ctx.abort()`, which marks the run's effect gate aborting
 *      synchronously (`agent-session.js` `abort()` → `agent.abort()`). `context` is run by
 *      `transformContext` immediately before the request is admitted
 *      (pi-agent-core `harness/execution/assistant.js`: transform, then `config.request`, which
 *      goes through `gate.admit` → `check()` → throws `AbortRequested`), so the request is never
 *      made. The turn ends as an abort, which is what the user sees, with our reason beside it.
 *
 *   4. `session_before_compact` — compaction is a provider call of its own, and it runs BEFORE
 *      `before_agent_start` on the prompt path, so it is the one request that could still reach a
 *      disabled model. It is cancelled, and the cancel is the supported one (`{cancel: true}`).
 *
 *   5. `session_before_tree` — `/tree` summarizes the branch it leaves with another request to the
 *      same model. Navigation itself is not a model call, so it is not cancelled: pi accepts an
 *      extension's summary in place of its own, and the branch move happens with nothing sent.
 *
 *   6. `cache_warming_decision` — warming keeps re-sending an earlier request's prefix on a timer,
 *      captured while the model was still allowed. Turning the model off stops it.
 *
 * Subagents are not enforced here: the subagents extension reads the same file per spawn and per
 * discovery, which covers TUI and Sova sessions alike.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { globalDenial, readPolicy } from "./policy.ts";

const STATUS_KEY = "model-policy";

/** The denial for the model this session is on, or null when it may run. */
function denialFor(ctx: ExtensionContext, policyFile?: string): string | null {
	const model = ctx.model;
	if (!model) return null; // no model yet: nothing to refuse, and pi will ask for one
	return globalDenial(readPolicy(policyFile), "pi", `${model.provider}/${model.id}`);
}

export default function modelPolicy(pi: ExtensionAPI, options: { policyFile?: string } = {}) {
	/** Set while we put a model back, so our own setModel can't re-enter the handler's revert. */
	let reverting = false;
	/** One notification per agent run: `context` fires per provider request, and a stopped run
	 *  that says the same thing three times is noise, not candour. */
	let saidThisRun = false;

	/** Footer marker: a session that can't run should say so before you type, not after. */
	const showState = (ctx: ExtensionContext) => {
		const denial = denialFor(ctx, options.policyFile);
		ctx.ui.setStatus(STATUS_KEY, denial ? "model off" : undefined);
		return denial;
	};

	pi.on("session_start", async (_event, ctx) => {
		saidThisRun = false;
		const denial = showState(ctx);
		if (denial) ctx.ui.notify(denial, "warning");
	});

	pi.on("model_select", async (event, ctx) => {
		if (reverting) return;
		const policy = readPolicy(options.policyFile);
		const ref = `${event.model.provider}/${event.model.id}`;
		const denial = globalDenial(policy, "pi", ref);
		if (!denial) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const previous = event.previousModel;
		const previousAllowed =
			previous && !globalDenial(policy, "pi", `${previous.provider}/${previous.id}`) ? previous : undefined;
		// A restore is the session's own history replaying, not a choice: never rewrite it.
		if (event.source !== "restore" && previousAllowed) {
			reverting = true;
			try {
				const ok = await pi.setModel(previousAllowed);
				ctx.ui.notify(
					ok
						? `${denial} Staying on ${previousAllowed.provider}/${previousAllowed.id}.`
						: `${denial} ${previousAllowed.provider}/${previousAllowed.id} could not be restored either.`,
					"error",
				);
				ctx.ui.setStatus(STATUS_KEY, ok ? undefined : "model off");
			} finally {
				reverting = false;
			}
			return;
		}
		ctx.ui.notify(`${denial} This session won't send until you switch.`, "error");
		ctx.ui.setStatus(STATUS_KEY, "model off");
	});

	// Every message the user sends. Pi's own commands and extension commands were dispatched before
	// this event, so everything arriving here is on its way to the model — prose, a skill command,
	// a prompt template, or an unknown slash word that will be sent verbatim.
	pi.on("input", async (_event, ctx) => {
		const denial = denialFor(ctx, options.policyFile);
		if (!denial) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, "model off");
		ctx.ui.notify(`${denial} Your message wasn't sent.`, "error");
		return { action: "handled" as const };
	});

	pi.on("agent_start", async () => {
		saidThisRun = false;
	});

	// The backstop: the last point at which a request can still be stopped, for every turn that
	// never passed through `input`.
	pi.on("context", async (_event, ctx) => {
		const denial = denialFor(ctx, options.policyFile);
		if (!denial) return;
		ctx.ui.setStatus(STATUS_KEY, "model off");
		if (!saidThisRun) {
			saidThisRun = true;
			ctx.ui.notify(`${denial} The turn was stopped before anything was sent.`, "error");
		}
		ctx.abort();
		return; // the messages are untouched: we are stopping the run, not editing it
	});

	// Compaction is its own request to the same model, and on the prompt path it runs before any
	// other hook — the one call that could still reach a disabled model.
	pi.on("session_before_compact", async (_event, ctx) => {
		const denial = denialFor(ctx, options.policyFile);
		if (!denial) return;
		ctx.ui.setStatus(STATUS_KEY, "model off");
		ctx.ui.notify(`${denial} Compaction was cancelled.`, "error");
		return { cancel: true };
	});

	// /tree navigation summarizes the branch it leaves, with a request to the same model. Moving
	// between branches is not itself a model call, so this one is not cancelled: pi takes a summary
	// from an extension in place of its own (`fromExtension`), which keeps navigation working with
	// no request made. Saying what the entry is beats a summary we'd have to invent.
	pi.on("session_before_tree", async (_event, ctx) => {
		const denial = denialFor(ctx, options.policyFile);
		if (!denial) return;
		ctx.ui.notify(`${denial} This branch wasn't summarized.`, "warning");
		return {
			summary: {
				summary: "Branch summary skipped: this session's model is turned off in Settings → Models.",
				details: {},
			},
		};
	});

	// Warming re-sends a captured prefix on a timer; a model turned off mid-session must stop
	// receiving it. "stop" ends warming until the next real request.
	pi.on("cache_warming_decision", async (_event, ctx) => {
		return denialFor(ctx, options.policyFile) ? { action: "stop" as const } : undefined;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
