/**
 * Mode switcher: normal ↔ delegate, plus independently toggleable minor modes.
 *
 * delegate re-instructs
 * the main agent (per turn, in before_agent_start) to act as a pure orchestrator that routes work
 * to background workers by four profiles — Planning & specs, Investigation, Routine and Complex
 * implementation — each a configurable backend · model · effort with an optional fallback
 * (delegate.ts, ~/.pi/agent/mode-delegate.json, re-read at every turn boundary). routing.ts
 * decides which tuple each profile uses from discovery and the model policy; prompt.ts holds the
 * text.
 *
 * Minor modes (minor.ts) are extra prompt biases on top of either major mode;
 * "align" makes the agent agree on what to build before building it, and record each
 * agreement with the `align` tool (align-tool.ts), in the loadout only while align is on.
 * The tool results' snapshots are the state, folded along the branch (align.ts); a hidden
 * note on each user prompt lists what is open, a settling run that planned in prose gets one
 * nudge, and the TUI shows a widget and an overlay viewer (align-ui.ts). "vis" puts a list
 * of the drawable kinds in the prompt, and each kind's rules come from the `vis_guide` tool
 * (vis-guide-tool.ts), in the loadout only while vis is on.
 *
 * Surface: a "Mode" category in the ctrl+p command palette (palette.ts, registered
 * through command-palette/contracts.ts; bare /mode opens it), scriptable /mode
 * <args>, alt+m shortcut, always-on footer status, `--mode` / `--minor` launch
 * flags, and a transcript marker on every switch.
 *
 * The active state (mode, strict, minor modes) is **per session**: it is snapshotted into
 * every "mode" transcript entry, so it restores on /resume, /reload, /fork and /tree and
 * never leaks into another session. ~/.pi/agent/mode.json holds the shortcuts and the
 * default a new session starts from; `/mode default` (and the palette's "save as default")
 * is the only thing here that writes it. The Delegate routing is global and never snapshotted:
 * nothing here writes mode-delegate.json (nor does Sova any more: Settings → Subagents edits the
 * routing per subagent profile; the file only seeds that library and is its fallback).
 *
 * The spec minor mode's writer (spec.ts, ~/.pi/agent/mode-spec.json, now only a seed and fallback
 * for the spec writer of a Settings → Subagents profile) is global the same way: while spec is on, under either major mode, it is re-read at every
 * turn boundary, routed like a Delegate profile and probed through the same discovery.
 */
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, type KeyId } from "@earendil-works/pi-tui";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { registerPaletteCategory, requestPaletteOpen } from "../command-palette/contracts.ts";
import {
	ALIGN_ENTRY_TYPE,
	ALIGN_NUDGE_MESSAGE,
	ALIGN_NUDGE_TEXT,
	ALIGN_STATE_MESSAGE,
	ALIGN_TOOL,
	ALIGN_WIDGET_KEY,
	alignCounts,
	alignStateNote,
	docLine,
	foldAlignments,
	legacyLine,
	looksLikeUncapturedPlan,
	openDocsOf,
	reviewRequestMessage,
	toMarkdown,
	widgetText,
	type AlignDocument,
	type AlignReviewerSlot,
	type AlignReviewPhase,
	type LegacyAlignDoc,
	type LegacyAlignEntryData,
} from "./align.ts";
import { registerAlignTool, type AlignToolHost } from "./align-tool.ts";
import { reviewStartText } from "./review-prompt.ts";
import { ALIGN_OVERLAY_OPTIONS, alignWidget, createAlignViewer, type AlignViewer } from "./align-ui.ts";
import { registerVisGuideTool, VIS_GUIDE_TOOL } from "./vis-guide-tool.ts";

/** remote/workers.ts: a session on a target announces itself; asking makes it announce again. */
const REMOTE_SESSION_EVENT = "remote:session";
const REMOTE_DISCOVER_EVENT = "remote:discover";
import { policyDenial, readPolicy } from "../subagents/policy.ts";
import { DELEGATE_PROFILE_INFO, DELEGATE_PROFILES, delegateKey, type DelegateBackend } from "./delegate.ts";
import { WorkerProbe } from "./discovery.ts";
import { MODE_WORKER_DISCOVER_EVENT, MODE_WORKER_EVENT, WORKER_ROLE_DISCOVER_EVENT, WORKER_ROLE_EVENT, type ModeWorkerEvent } from "./events.ts";
import {
	CODEMODE_TOOL,
	isMinorMode,
	MINOR_MODES,
	MINOR_SURFACES,
	normalizeMinorModes,
	parseMinorFlag,
	SCRIPT_ONLY_EXPOSURES,
	visToolsWanted,
	webMinorRefusal,
	workerMinorModes,
	type MinorMode,
} from "./minor.ts";

/** The session a context belongs to, or undefined when it has none to name. */
function sessionIdOf(ctx: ExtensionContext): string | undefined {
	try {
		return ctx.sessionManager.getSessionId();
	} catch {
		return undefined;
	}
}
import { ALIGN_SETTINGS_FILE, alignSettingsReader, resolveAlign, type AlignStyle } from "./align-settings.ts";
import { MODE_CATEGORY_ID, modeCategoryItems } from "./palette.ts";
import { applyModeSection, buildAlignStyleNote, buildModeNote, buildSpecWriterPrompt, composePrompt, composeWorkerPrompt, DEFAULT_ROUTES, statusLabel } from "./prompt.ts";
import { backendsOf, describeChoice, routeAll, routeNotice, routeWriter, slotNotice, usable, type Discovery, type ProfileRoute, type SlotRoute } from "./routing.ts";
import { SPEC_WRITER_LABEL, specBackends, specKey } from "./spec.ts";
import { OFF_PROFILE_ID, pickEntryFor, profilesReader, resolveSubagents, restorePick, type ResolvedSubagents } from "../subagents/subagent-profiles.ts";
import { bashCommands, CensusHook, driftNote, LANDED_FILE_ENV, SpecWriteGuard, writeLanded } from "./spec-guard.ts";
import {
	activeOf,
	DEFAULT_ALIGN_VIEWER_SHORTCUT,
	DEFAULT_MODE_SHORTCUT,
	hasMinor,
	loadState,
	MODE_DISCOVER_EVENT,
	MODE_ENTRY_TYPE,
	MODE_HEAD_TYPE,
	MODE_NOTE_TYPE,
	MODE_STATE_EVENT,
	MODES,
	parseMode,
	restoreActive,
	restoreHead,
	saveState,
	toggleMode,
	withMinor,
	type Mode,
	type ModeActive,
	type ModeHeadRecord,
	type ModeNoteDetails,
	type ModeState,
} from "./state.ts";

const STATE_FILE = join(getAgentDir(), "mode.json");
/** The trusted spec tools, where spec-mode.md's `$core` line resolves them (install.sh links them there). */
const SPEC_CORE = join(getAgentDir(), "extensions", "spec", "core");
/** The spec check's hidden re-prompt on a merge/promote turn. */

/**
 * How long one backend's discovery stands before a Delegate turn refreshes it in the background:
 * a model list for 10 minutes; a failed discovery (CLI missing, timed out) for 1 minute, so a fix
 * shows up soon without spawning the CLI every turn; a backend that wasn't loaded is asked again
 * at the very next turn — asking costs one event, no process.
 */
const DISCOVERY_TTL_MS = { models: 10 * 60 * 1000, error: 60 * 1000, missing: 0 } as const;

const discoveryTtl = (discovery: Discovery): number =>
	"models" in discovery ? DISCOVERY_TTL_MS.models : discovery.missing ? DISCOVERY_TTL_MS.missing : DISCOVERY_TTL_MS.error;

/** Tools removed from the orchestrator while strict delegate is on. */
const STRICT_REMOVED_TOOLS = new Set(["edit", "write"]);
/** The launch flag behind adversarial review (§chat.alignment-review/flag); Sova passes it per hosted session. */
export const REVIEW_FLAG = "adversarial-review";
/**
 * The align mode's Visuals as the caller fixed them for this session (§chat.alignment/visuals): Sova
 * passes `on` or `off` from the chat's launch record; without it (the TUI) the session reads
 * mode-align.json, and the chat's profile override, at its start.
 */
export const VISUALS_FLAG = "align-visuals";

/**
 * What changed in this switch. Old entries carry only `mode`; `active` is absent before per-session state.
 * `head`: the minor modes the prompt's mode section was built with, only while they differ from
 * `active.minorModes` (restoreHead in state.ts).
 */
type ModeMarker = ({ mode: Mode } | { minor: MinorMode; on: boolean } | { strict: boolean }) & { active?: ModeActive; head?: MinorMode[] };

export default function modeExtension(pi: ExtensionAPI): void {
	/** The file: shortcuts (read once, at registration) and the default a new session starts from. */
	let config: ModeState = loadState(STATE_FILE);
	/** This session's active state. Resolved per session in session_start / session_tree; never global. */
	let active: ModeActive = activeOf(config);
	/**
	 * The prompt head: the minor modes this session's `mode` section was built with. It is fixed by the
	 * first run after the session starts or compacts (undefined until then, when it follows `active`),
	 * and a later minor toggle leaves it alone, so the cached prefix survives: the switch reaches the
	 * model as a hidden note (MODE_NOTE_TYPE) at the next run instead. Restored from the branch.
	 */
	let head: MinorMode[] | undefined;
	/** The minor modes the model was last told are on: the head plus the notes since. */
	let told: MinorMode[] = [];
	/** Modes whose whole guide a note since the last compaction carried (a later "on" points back to it). */
	let guides: MinorMode[] = [];
	/** From a run's first agent_start to agent_settled: its continuations keep the mode it started with. */
	let running = false;
	/**
	 * This chat's subagent profile pick (its newest `subagent-profile` entry), undefined while it
	 * follows the default. Re-read from the branch at every turn boundary, since Sova writes the
	 * entry into a held chat directly.
	 */
	let pick: string | undefined;
	/** The library and this device's default, re-read (one stat each) whenever consulted; seeded on first read. */
	const readProfiles = profilesReader(getAgentDir());
	/**
	 * What this chat's subagents get now: its pick, else this device's default, else the legacy files
	 * (mode-delegate.json, mode-spec.json). Delegate's routing is null under Off: the agent picks.
	 */
	const subagents = (): ResolvedSubagents => {
		const s = readProfiles();
		return resolveSubagents(getAgentDir(), pick, s.profiles, s.default);
	};
	const readDelegate = () => subagents().delegate;
	const readSpec = () => subagents().spec;
	/**
	 * The `adversarial-review` flag, read once at session_start (the first point a caller's value is
	 * visible) and kept: a live pi.getFlag throws once this runtime is replaced, and a probe that
	 * settles after a session replacement still asks what it covers.
	 */
	let reviewFlag = false;
	const reviewOn = (): boolean => reviewFlag;
	/** mode-align.json, re-read (one stat) whenever consulted. */
	const readAlignSettings = alignSettingsReader(join(getAgentDir(), ALIGN_SETTINGS_FILE));
	/** The writing style and Visuals this chat would use now: its profile's override, else the host's file. */
	const alignNow = () => resolveAlign(readAlignSettings(), subagents().alignment);
	/**
	 * This session's Visuals (§chat.alignment/visuals), fixed at session_start: the caller's flag, else
	 * alignNow(). A worker never has them (it has no align either).
	 */
	let alignVisuals = false;
	/**
	 * The writing style the head's align block was built with, fixed with the head (fixHead) or
	 * restored with it; undefined while the head isn't, when the block follows the style now.
	 */
	let headStyle: AlignStyle | undefined;
	/** The writing style the model was last told: the head's, then each style note's (§chat.alignment/style). */
	let toldStyle: AlignStyle | undefined;
	const alignOptions = (style: AlignStyle) => ({ style, visuals: alignVisuals });
	/** The reviewer route a probe should cover: flag on, align on, not a worker, and the profile names one. */
	const probedReviewer = () => (reviewOn() && hasMinor(active, "align") && !workerRole ? subagents().reviewer : null);
	/** Re-read this chat's pick from its branch. */
	function refreshPick(ctx: ExtensionContext): void {
		try {
			pick = restorePick(ctx.sessionManager.getBranch() as never);
		} catch {
			// No branch to read (a context without a session): keep the last pick.
		}
	}
	/** Which worker each profile uses now: the routing, assessed against discovery and the policy. */
	let routes: readonly ProfileRoute[] = DEFAULT_ROUTES;
	/** Which worker writes the spec now, while spec is on and a writer is set; null otherwise. */
	let writerRoute: SlotRoute | null = null;
	let toldWriter: string | undefined;
	const writerInstruction = () => writerRoute ? buildSpecWriterPrompt(writerRoute) : "Spec writer: no worker is configured; write draft claims and evidence yourself.";
	/** Last discovery per backend; absent = never probed (its tuples read as unverified). */
	let discoveries: Partial<Record<DelegateBackend, Discovery>> = {};
	/** When each backend's discovery landed. */
	const discoveredAt: Partial<Record<DelegateBackend, number>> = {};
	/** The routing (probeScope key) the last applied probe ran for; a turn with a different one probes again. */
	let probedKey: string | undefined;
	/**
	 * The probe in flight, by the routing it runs for. A second request for the same routing joins it
	 * (keeping the strongest notify ask) instead of restarting it: restarting dropped the first
	 * probe's result, and with it the fallback notice a switch into delegate had asked for.
	 */
	let inflight: { key: string; notify: boolean; done: Promise<void> } | undefined;
	const probe = new WorkerProbe(pi);
	/** Active-tools list captured before strict mode hid edit/write. */
	let toolsSnapshot: string[] | undefined;
	/** Serializes concurrent probes so a rapid toggle cannot apply a stale result. */
	let probeGeneration = 0;
	/** This branch's alignments (align minor mode), folded from the align tool's results. */
	let alignDocs: AlignDocument[] = [];
	/** An older session's markdown alignment doc (align-doc entry), read-only. */
	let legacyAlign: LegacyAlignDoc | null = null;
	/** This run (until it settles): align calls made, the last reply's text, and whether it was nudged. */
	let runAlignCalls = 0;
	let lastReplyText = "";
	let nudged = false;
	/** This run was started by a user prompt that asked a question (options offered back answer it). */
	let runUserAsked = false;
	/** The open overlay viewer, refreshed live on each align call; undefined when closed. */
	let liveViewer: AlignViewer | undefined;
	/** The latest context seen, for refreshing the widget from the tool (which has no UI of its own). */
	let lastCtx: ExtensionContext | undefined;
	let viewerOpen = false;
	const viewerShortcut = config.viewerShortcut ?? DEFAULT_ALIGN_VIEWER_SHORTCUT;
	/** The viewer key is skipped when it would shadow the mode or align toggle; reported once at session start. */
	const viewerShortcutClash = viewerShortcut === (config.shortcut ?? DEFAULT_MODE_SHORTCUT) || viewerShortcut === config.minorShortcuts?.align;
	const viewerKeyHint = viewerShortcutClash ? "/align" : viewerShortcut;

	/**
	 * This session is a subagent worker (events.ts: the worker marker answered). Only a worker on its
	 * worktree's own agent dir loads this extension (§chat.worktrees/worktree-config); it takes its modes
	 * from the launch flags alone, worker-scope minors only, and gets the worker form of their prompt.
	 */
	let workerRole = false;
	pi.events?.on(WORKER_ROLE_EVENT, (data: unknown) => {
		if ((data as { version?: unknown } | null)?.version === 1) workerRole = true;
	});
	pi.events?.emit(WORKER_ROLE_DISCOVER_EVENT, { version: 1 });

	pi.registerFlag("major", { description: "Start in a mode: normal | delegate", type: "string" });
	// Adversarial review of alignments (§chat.alignment-review/flag). Its value is visible from
	// session_start on (a caller's flags are applied after every factory ran); off is today, exactly.
	pi.registerFlag(REVIEW_FLAG, { description: "Adversarial review of alignments", type: "boolean", default: false });
	// The align mode's Visuals for this session (§chat.alignment/visuals): on | off; absent, mode-align.json.
	pi.registerFlag(VISUALS_FLAG, { description: "Align visuals for this session: on | off (default: mode-align.json)", type: "string" });
	pi.registerFlag("minor", {
		description: `Start with minor modes on (comma-separated): ${MINOR_MODES.join(" | ")}, or none`,
		type: "string",
	});

	function renderStatus(ctx: ExtensionContext): void {
		const { text, tone } = statusLabel(active.mode, routes, active.strict, active.minorModes, writerRoute);
		ctx.ui.setStatus("mode", ctx.ui.theme.fg(tone, text));
	}

	/**
	 * pi's base prompt options, live. A turn the user starts builds its prompt in before_agent_start,
	 * where this extension writes its block into the turn's sections. A turn an extension's message
	 * starts (`sendMessage(…, {triggerTurn: true})`: a subagent settling, a team question) skips that
	 * hook, and pi's own refresh before the turn's second request rebuilds the prompt from these base
	 * options, which know nothing of extension sections — so the mode section was patched out
	 * mid-turn and back in at the next user prompt, and every switch restarted the claude-code CLI.
	 * Keeping the block in the base options makes the prompt the same whoever started the turn.
	 *
	 * Only a command context exposes the getter (`ctx.getSystemPromptOptions`): `/mode` and `/align`
	 * adopt it, and Sova runs the quiet `/mode sync` at every chat open. Until one arrives (a session
	 * restored and driven only by the TUI shortcut or palette), the old behaviour stands.
	 */
	let hostPromptOptions: (() => { sections?: Record<string, string> }) | undefined;

	function adoptHost(ctx: ExtensionContext): void {
		const get = (ctx as { getSystemPromptOptions?: unknown }).getSystemPromptOptions;
		if (typeof get === "function") hostPromptOptions = get as () => { sections?: Record<string, string> };
	}

	/**
	 * What this session's workers get of its modes (§chat.mode-menu/workers), for the subagents
	 * extension to append at spawn. Emitted on every resolve and switch, and on request.
	 */
	function publishWorkerModes(): void {
		const prompt = composeWorkerPrompt(active);
		const event: ModeWorkerEvent = { version: 1, minorModes: workerMinorModes(active.minorModes), ...(prompt === undefined ? {} : { prompt }) };
		try {
			pi.events?.emit(MODE_WORKER_EVENT, event);
		} catch {
			// Best-effort: without it, workers get no mode text.
		}
	}
	pi.events?.on(MODE_WORKER_DISCOVER_EVENT, (data: unknown) => {
		if ((data as { version?: unknown } | null)?.version === 1) publishWorkerModes();
	});

	/**
	 * Write this state's block (or the given one, the one a turn was just built with) into the host's
	 * base sections. pi replaces the base object when tools change, so this is re-run at every run
	 * start and after every switch, not once. A getter whose runner was replaced is dropped.
	 */
	function syncHostSection(block: string | undefined = modeBlock()): void {
		if (hostPromptOptions === undefined) return;
		let sections: Record<string, string> | undefined;
		try {
			sections = hostPromptOptions().sections;
		} catch {
			hostPromptOptions = undefined;
			return;
		}
		if (sections) applyModeSection(sections, block);
	}

	const headMinors = (): MinorMode[] => head ?? active.minorModes;

	/**
	 * The `mode` section: the major mode as it is now, the minor blocks as the head has them. In a
	 * worker, the worker form of the head's worker-scope minors (never Delegate or a writer).
	 */
	const modeBlock = (): string | undefined =>
		workerRole
			? composeWorkerPrompt({ minorModes: headMinors() })
			: composePrompt(active, routes, writerRoute, headMinors(), alignOptions(headStyle ?? alignNow().style));

	/** A run is about to send the prompt: a head not sent since the start or the last compaction is the active set from now on. */
	function fixHead(): void {
		if (head !== undefined) return;
		head = [...active.minorModes];
		told = [...head];
		guides = [];
		toldWriter = head.includes("spec") ? writerInstruction() : undefined;
		// A head rebuilt on reopen keeps the style the branch recorded for it (restoreActiveState). A new
		// one built in a style other than Default records it (MODE_HEAD_TYPE); a Default head records nothing.
		if (headStyle === undefined) {
			headStyle = alignNow().style;
			if (!workerRole && head.includes("align") && headStyle !== "default") {
				try {
					pi.appendEntry<ModeHeadRecord>(MODE_HEAD_TYPE, { v: 1, style: headStyle });
				} catch {
					// Best-effort: without it, a reopen reads this head as Default.
				}
			}
		}
		toldStyle ??= headStyle;
	}

	/** The hidden note for what the model hasn't been told yet, now counted as told; undefined when there is nothing. */
	function takeNote(): { customType: string; content: string; display: false; details: ModeNoteDetails } | undefined {
		if (head === undefined) return undefined;
		const style = alignNow().style;
		const note = workerRole
			? buildModeNote(workerMinorModes(told), workerMinorModes(active.minorModes), { head: workerMinorModes(head), guides }, null, true)
			: buildModeNote(told, active.minorModes, { head, guides }, writerRoute, false, alignOptions(style));
		const instruction = writerInstruction();
		const routeNote = !workerRole && active.minorModes.includes("spec") && !head.includes("spec") && !note?.guides.includes("spec") && toldWriter !== instruction
			? `Spec writer routing now applies instead of any earlier writer routing.\n\n${instruction}` : undefined;
		// The writing style (§chat.alignment/style): an align block this note carries is written in the style
		// now; with align's block already in context, a style changed since it was told gets one note of its own.
		const alignGuide = note?.guides.includes("align") ?? false;
		const was = toldStyle ?? headStyle ?? "default";
		const styleNote = !workerRole && hasMinor(active, "align") && !alignGuide && was !== style ? buildAlignStyleNote(was, style) : undefined;
		if (!note && !routeNote && !styleNote) return undefined;
		if (active.minorModes.includes("spec")) toldWriter = instruction;
		const toldAlignStyle = alignGuide || styleNote !== undefined;
		if (toldAlignStyle) toldStyle = style;
		told = [...active.minorModes];
		guides = normalizeMinorModes([...guides, ...(note?.guides ?? [])]);
		const details: ModeNoteDetails = { v: 1, minorModes: [...told], guides: note?.guides ?? [] };
		if (toldAlignStyle) Object.assign(details, { style, headStyle: headStyle ?? style });
		return { customType: MODE_NOTE_TYPE, content: [note?.text, routeNote, styleNote].filter(Boolean).join("\n\n"), display: false, details };
	}

	/**
	 * Route every profile of the routing (in delegate) and the spec writer (while spec is on) as they
	 * are NOW (files and policy re-read) against the last discovery. Synchronous and cheap: what a
	 * turn boundary runs. Normal mode never reads the Delegate file; spec off never reads the writer's.
	 */
	function recomputeRoutes(): void {
		const policy = readPolicy();
		const denial = (choice: { backend: DelegateBackend; model: string }) => policyDenial(policy, choice.backend, choice.model);
		if (active.mode === "delegate") {
			const delegate = readDelegate();
			// Off: no worker lines at all; the prompt asks the agent to choose (buildDelegatePrompt).
			routes = delegate ? routeAll(delegate, discoveries, denial) : [];
		}
		// The head's spec block carries the writer paragraph too, so spec turned off keeps it there.
		// A worker spawns nothing, so it is never offered a writer.
		writerRoute = (hasMinor(active, "spec") || headMinors().includes("spec")) && !workerRole ? routeWriter(readSpec(), discoveries, denial) : null;
	}

	/**
	 * What a probe covers now: the Delegate routing while in delegate, the spec writer while spec is
	 * on and one is set. `key` identifies it; no backends means nothing to probe.
	 */
	function probeScope(): { key: string; backends: DelegateBackend[] } {
		const delegate = active.mode === "delegate" ? (readDelegate() ?? undefined) : undefined;
		const spec = hasMinor(active, "spec") && !workerRole ? readSpec() : undefined;
		const reviewer = probedReviewer();
		const backends = new Set<DelegateBackend>([
			...(delegate ? backendsOf(delegate) : []),
			...(spec ? specBackends(spec) : []),
			...(reviewer ? specBackends({ version: 1, writer: reviewer }) : []),
		]);
		const key = [delegate ? delegateKey(delegate) : null, spec ? specKey(spec) : null];
		return { key: JSON.stringify(reviewer ? [...key, specKey({ version: 1, writer: reviewer })] : key), backends: [...backends] };
	}

	const probeWanted = (): boolean => probeScope().backends.length > 0;

	function applyStrictTools(): void {
		if (toolsSnapshot === undefined) toolsSnapshot = pi.getActiveTools();
		pi.setActiveTools(toolsSnapshot.filter((name) => !STRICT_REMOVED_TOOLS.has(name)));
	}

	function restoreTools(): void {
		if (toolsSnapshot === undefined) return;
		pi.setActiveTools(toolsSnapshot);
		toolsSnapshot = undefined;
	}

	/**
	 * Discover every backend the current routing names, then re-route and refresh the status.
	 * Resolves once the probe is applied (or dropped as stale); never rejects.
	 */
	function refreshRouting(ctx: ExtensionContext, notifyDegraded: boolean): Promise<void> {
		const { key, backends } = probeScope();
		if (inflight && inflight.key === key) {
			inflight.notify ||= notifyDegraded;
			return inflight.done;
		}
		const generation = ++probeGeneration;
		// A changed routing supersedes the probe in flight; a notice that one was owed is carried over.
		const run: { key: string; notify: boolean; done: Promise<void> } = { key, notify: notifyDegraded || !!inflight?.notify, done: Promise.resolve() };
		run.done = (async () => {
			const found = await Promise.all(backends.map(async (backend) => [backend, await probe.discover(ctx, backend)] as const));
			if (inflight === run) inflight = undefined;
			// A newer probe, or leaving delegate and spec, owns the result.
			if (generation !== probeGeneration || !probeWanted()) return;
			const now = Date.now();
			for (const [backend, discovery] of found) {
				discoveries = { ...discoveries, [backend]: discovery };
				discoveredAt[backend] = now;
			}
			probedKey = key;
			recomputeRoutes();
			syncHostSection();
			renderStatus(ctx);
			if (!run.notify) return;
			const notices = active.mode === "delegate" ? routes.map(routeNotice).filter((line): line is string => line !== undefined) : [];
			if (notices.length > 0) ctx.ui.notify(`Delegate routing:\n${notices.join("\n")}`, "warning");
			const writerNotice = writerRoute ? slotNotice(SPEC_WRITER_LABEL, writerRoute, "the agent") : undefined;
			if (writerNotice) ctx.ui.notify(writerNotice, "warning");
		})();
		inflight = run;
		return run.done;
	}

	/** Does this turn need a fresh probe: a routing not probed yet, or a backend whose discovery has aged out? */
	function routingStale(): boolean {
		const { key, backends } = probeScope();
		if (key !== probedKey) return true;
		const now = Date.now();
		return backends.some((backend) => {
			const discovery = discoveries[backend];
			return discovery === undefined || now - (discoveredAt[backend] ?? 0) >= discoveryTtl(discovery);
		});
	}

	/** Nothing left to probe (neither delegate nor a spec writer): forget the probe in flight so its result is dropped and the next entry starts fresh. */
	function dropProbe(): void {
		++probeGeneration;
		inflight = undefined;
	}

	/**
	 * One transcript entry per switch: the legacy marker the renderers read, plus the full
	 * post-switch snapshot this session restores from. Best-effort: a failed append only costs
	 * the pin (the session then follows the default again), never the turn.
	 */
	function appendSwitch(marker: { mode: Mode } | { minor: MinorMode; on: boolean } | { strict: boolean }): void {
		const data: ModeMarker = { ...marker, active: activeOf(active) };
		if (head !== undefined && head.join(",") !== active.minorModes.join(",")) data.head = [...head];
		try {
			pi.appendEntry<ModeMarker>(MODE_ENTRY_TYPE, data);
		} catch {
			// Appending is impossible before session_start; nothing else here depends on it.
		}
	}

	/** This session's active triple on the bus (state.ts MODE_STATE_EVENT). */
	function publishActive(): void {
		pi.events?.emit(MODE_STATE_EVENT, activeOf(active));
	}
	pi.events?.on(MODE_DISCOVER_EVENT, () => publishActive());

	async function setMode(next: Mode, ctx: ExtensionContext): Promise<void> {
		if (next === active.mode) {
			renderStatus(ctx);
			return;
		}
		active = { ...active, mode: next };
		publishActive();
		appendSwitch({ mode: next });
		publishWorkerModes();
		if (next === "delegate") {
			if (active.strict) applyStrictTools();
			recomputeRoutes();
			syncHostSection();
			renderStatus(ctx);
			ctx.ui.notify("Mode: delegate", "info");
			await refreshRouting(ctx, true);
		} else {
			restoreTools();
			recomputeRoutes();
			syncHostSection();
			renderStatus(ctx);
			ctx.ui.notify("Mode: normal", "info");
			// The spec writer, if one is set, is still probed; otherwise nothing is.
			if (probeWanted()) void refreshRouting(ctx, false);
			else dropProbe();
		}
	}

	function setMinor(minor: MinorMode, on: boolean, ctx: ExtensionContext): void {
		if (hasMinor(active, minor) === on) {
			renderStatus(ctx);
			return;
		}
		// A web-only mode (memory) is turned on only by Sova's server, applying a switch for this session.
		const refused = on ? webMinorRefusal(minor, sessionIdOf(ctx)) : undefined;
		if (refused) {
			ctx.ui.notify(`Minor mode ${minor} not turned on: ${refused}`, "warning");
			renderStatus(ctx);
			return;
		}
		active = withMinor(active, minor, on);
		publishActive();
		appendSwitch({ minor, on });
		publishWorkerModes();
		if (minor === "spec") recomputeRoutes();
		syncHostSection();
		renderStatus(ctx);
		if (minor === "align") {
			syncAlignTool();
			syncAlignWidget(ctx);
		}
		// Between runs the tool follows at once; a run under way keeps its tools, and agent_settled syncs.
		if (minor === "codemode" && !running) syncCodemodeTool();
		if ((minor === "vis" || minor === "align") && !running) syncVisGuideTool();
		ctx.ui.notify(`Minor mode: ${minor} ${on ? "on" : "off"}`, "info");
		// Spec on probes its writer's backends (and announces a writer that can't run); off, and
		// outside delegate, there is nothing left to probe.
		if (minor === "spec") {
			if (probeWanted()) void refreshRouting(ctx, on);
			else dropProbe();
		}
	}

	/** One-line summary of an active state, for the notifications and the `default:` status line. */
	function activeSummary(a: ModeActive): string {
		return [a.mode, ...(a.strict ? ["strict"] : []), ...a.minorModes].join(" · ");
	}

	/**
	 * The only session-side write of mode.json: make this session's triple what new sessions start
	 * from. The file is re-read first so a concurrent session's shortcuts or default are not clobbered.
	 */
	function saveDefault(ctx: ExtensionContext): void {
		try {
			const next: ModeState = { ...loadState(STATE_FILE), mode: active.mode, strict: active.strict, minorModes: [...active.minorModes] };
			saveState(STATE_FILE, next);
			config = next;
			ctx.ui.notify(`Default mode saved: ${activeSummary(active)} (new sessions start here)`, "info");
		} catch (error) {
			ctx.ui.notify(`Could not write ${STATE_FILE}: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	/**
	 * Resolve this session's active state: a snapshot on the branch wins, else the launch flags on
	 * top of the default (first start only), else the default as it is now. Adopting the default
	 * appends nothing, so merely opening a session never writes to its transcript.
	 */
	function restoreActiveState(reason: string | undefined, ctx: ExtensionContext): void {
		config = loadState(STATE_FILE);
		let next = activeOf(config);
		let restored: ModeActive | undefined;
		try {
			// A worker ignores the branch: a fork copied the parent's own snapshots onto it.
			restored = workerRole ? undefined : restoreActive(ctx.sessionManager.getBranch());
		} catch {
			restored = undefined; // An unreadable branch just means "no pin yet".
		}
		if (workerRole) {
			// Normal, not strict, and only the worker-scope minors of --minor; never mode.json's default.
			next = { mode: "normal", strict: false, minorModes: workerMinorModes(parseMinorFlag(pi.getFlag("minor"))?.minorModes ?? []) };
		} else if (restored !== undefined) {
			next = restored;
		} else if (reason === undefined || reason === "startup") {
			// One-shot launch overrides on top of the default; never written to the file or the session.
			const flag = parseMode(pi.getFlag("major"));
			if (flag !== undefined) next = { ...next, mode: flag };
			const minorFlag = parseMinorFlag(pi.getFlag("minor"));
			if (minorFlag) {
				// A web-only mode can't be started from a flag: it is dropped, with a warning.
				const webOnly = minorFlag.minorModes.filter((minor) => MINOR_SURFACES[minor] === "web");
				next = { ...next, minorModes: minorFlag.minorModes.filter((minor) => MINOR_SURFACES[minor] !== "web") };
				if (webOnly.length > 0) {
					try {
						ctx.ui.notify(`--minor ${webOnly.join(", ")}: ${webOnly.map((minor) => webMinorRefusal(minor, undefined)).join("; ")}`, "warning");
					} catch {
						// The warning is best-effort.
					}
				}
				if (minorFlag.unknown.length > 0) {
					try {
						ctx.ui.notify(`Unknown minor mode in --minor: ${minorFlag.unknown.join(", ")} (known: ${MINOR_MODES.join(", ")})`, "warning");
					} catch {
						// The warning is best-effort.
					}
				}
			}
		}
		active = next;
		publishActive();
		publishWorkerModes();
		let restoredHead: ReturnType<typeof restoreHead> = { head: undefined, told: undefined, guides: [] };
		try {
			// A worker's head is its own too: the copied snapshots and notes are the parent's.
			if (!workerRole) restoredHead = restoreHead(ctx.sessionManager.getBranch());
		} catch {
			// An unreadable branch: the head follows the active set until the next run fixes it.
		}
		head = restoredHead.head;
		told = restoredHead.told ?? [...(head ?? [])];
		guides = restoredHead.guides;
		// The style the head was built with, as the branch records it since the last compaction (a style
		// note, else the head's own record, else Default once a prompt went out; a head no entry records is
		// rebuilt with it at the next fixHead), so a style changed since goes out as a note (§chat.alignment/style);
		// a head still to be fixed follows the style now until then.
		headStyle = restoredHead.headStyle;
		toldStyle = restoredHead.style?.told ?? headStyle;
		// A restore can land on a different strict flag than the tools currently reflect.
		if (active.mode === "delegate" && active.strict) applyStrictTools();
		else restoreTools();
		syncAlignTool();
		syncVisGuideTool();
		syncCodemodeTool();
		recomputeRoutes();
		syncHostSection();
		renderStatus(ctx);
		if (probeWanted()) void refreshRouting(ctx, false);
		else dropProbe();
	}

	// ── Alignments (align minor mode) ─────────────────────────────────────────────

	/**
	 * The align tool is in the loadout exactly while align is on. The strict snapshot (the loadout
	 * before strict hid edit/write) follows too, so leaving strict doesn't bring back a stale set.
	 */
	function syncAlignTool(): void {
		syncTool(ALIGN_TOOL, hasMinor(active, "align"));
	}

	/**
	 * The vis_guide tool is in the loadout exactly while the vis tools are wanted (visToolsWanted: vis on,
	 * or align on in a session started with Visuals, §chat.alignment/visuals), synced where Sova's
	 * vis_check is (at session start, right after a switch made between runs, when a user's prompt starts
	 * a run, and when a run settles), so a toggle changes the tool set once, for both.
	 */
	function syncVisGuideTool(): void {
		syncTool(VIS_GUIDE_TOOL, visToolsWanted(active.minorModes, alignVisuals));
	}

	/**
	 * pi's codemode tool is in the loadout exactly while codemode is on (§chat.mode-menu/codemode), synced
	 * where vis_guide is and right after a switch made between runs. Off removes it even when something
	 * else activated it (defaultTools, the transcript's restored tool set), except while a registered tool
	 * is reachable only from scripts (MCP's codemode/deferred exposure). Nothing to do where the tool isn't
	 * registered (an SDK runtime without the factory). Every chat alike, a Claude Code one included.
	 */
	function syncCodemodeTool(): void {
		let tools: { name: string; exposure?: string }[];
		try {
			tools = pi.getAllTools() as { name: string; exposure?: string }[];
		} catch {
			return; // Before the session exists; session_start syncs it.
		}
		if (!tools.some((tool) => tool.name === CODEMODE_TOOL)) return;
		const want = hasMinor(active, "codemode") && !workerRole;
		if (!want && tools.some((tool) => tool.exposure !== undefined && SCRIPT_ONLY_EXPOSURES.has(tool.exposure))) return;
		syncTool(CODEMODE_TOOL, want);
	}

	function syncTool(tool: string, want: boolean): void {
		try {
			const fix = (tools: string[]) => (want ? (tools.includes(tool) ? tools : [...tools, tool]) : tools.filter((t) => t !== tool));
			const current = pi.getActiveTools();
			const next = fix(current);
			if (next.length !== current.length) pi.setActiveTools(next);
			if (toolsSnapshot !== undefined) toolsSnapshot = fix(toolsSnapshot);
		} catch {
			// Before the session exists there is no loadout to change; session_start syncs it.
		}
	}

	/** Widget above the editor while align is on and an alignment is open; cleared otherwise. Best-effort. */
	function syncAlignWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		try {
			if (!hasMinor(active, "align") || openDocsOf(alignDocs).length === 0) {
				ctx.ui.setWidget(ALIGN_WIDGET_KEY, undefined);
				return;
			}
			ctx.ui.setWidget(ALIGN_WIDGET_KEY, (_tui, theme) =>
				alignWidget(theme, () => ({ text: widgetText(alignDocs, viewerKeyHint), open: alignCounts(alignDocs).open > 0 })),
			);
		} catch {
			// Alignment UI is best-effort; never take the session down.
		}
	}

	function refreshAlignViews(ctx: ExtensionContext): void {
		liveViewer?.setState({ docs: alignDocs, legacy: legacyAlign });
		syncAlignWidget(ctx);
	}

	function restoreAlign(ctx: ExtensionContext): void {
		try {
			const fold = foldAlignments(ctx.sessionManager.getBranch());
			alignDocs = fold.docs;
			legacyAlign = fold.legacy;
		} catch {
			alignDocs = [];
			legacyAlign = null;
		}
		refreshAlignViews(ctx);
	}

	function alignSummaryLine(): string {
		const open = openDocsOf(alignDocs);
		if (open.length > 0) return open.map(docLine).join("; ");
		if (alignDocs.length > 0) return `none open (${alignDocs.length} finished)`;
		return legacyAlign ? `older doc, read-only: ${legacyLine(legacyAlign)}` : "(none)";
	}

	/** Open alignments first, then the finished ones. */
	const viewOrder = (): AlignDocument[] => [...openDocsOf(alignDocs), ...alignDocs.filter((d) => !openDocsOf(alignDocs).includes(d))];

	async function openAlignViewer(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI) return;
		if (alignDocs.length === 0 && legacyAlign === null) {
			ctx.ui.notify("No alignments yet (turn align on and ask for work)", "info");
			return;
		}
		if (ctx.mode !== "tui") {
			const text = alignDocs.length > 0 ? viewOrder().map(toMarkdown).join("\n\n---\n\n") : (legacyAlign?.markdown ?? "");
			ctx.ui.notify(`alignments: ${alignSummaryLine()}\n\n${text}`, "info");
			return;
		}
		if (viewerOpen) return;
		viewerOpen = true;
		try {
			await ctx.ui.custom<undefined>(
				(tui, theme, _keybindings, done) => {
					liveViewer = createAlignViewer({
						theme,
						markdownTheme: getMarkdownTheme(),
						getState: () => ({ docs: alignDocs, legacy: legacyAlign }),
						height: () => Math.max(5, tui.terminal.rows - 4),
						requestRender: () => tui.requestRender(),
						close: () => done(undefined),
						keyHint: viewerKeyHint,
					});
					return liveViewer;
				},
				{ overlay: true, overlayOptions: ALIGN_OVERLAY_OPTIONS },
			);
		} catch {
			// The overlay must never take the session down.
		} finally {
			liveViewer = undefined;
			viewerOpen = false;
		}
	}

	/** Every open alignment (else every one; else an older session's doc) as markdown, to `.pi/align.md` or `arg`. */
	function exportAlign(arg: string, ctx: ExtensionContext): void {
		const open = openDocsOf(alignDocs);
		const docs = open.length > 0 ? open : alignDocs;
		const text = docs.length > 0 ? docs.map(toMarkdown).join("\n\n---\n\n") : legacyAlign?.markdown;
		if (text === undefined) {
			ctx.ui.notify("No alignments to export", "warning");
			return;
		}
		const target = resolve(ctx.cwd, arg === "" ? join(CONFIG_DIR_NAME, "align.md") : arg);
		try {
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, `${text}\n`);
			ctx.ui.notify(`Alignments written to ${target}`, "info");
		} catch (error) {
			ctx.ui.notify(`Could not write ${target}: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	}

	/**
	 * The session's target while its tools run remotely: the remote extension announces it on
	 * `pi.events` (remote/workers.ts REMOTE_SESSION_EVENT) and re-announces on request, so load order
	 * never matters. align import reads the local disk and is refused while this is set.
	 */
	let remoteTarget: string | undefined;
	pi.events?.on(REMOTE_SESSION_EVENT, (data: unknown) => {
		const target = (data as { target?: unknown } | undefined)?.target;
		if (typeof target === "string" && target !== "") remoteTarget = target;
	});
	pi.events?.emit(REMOTE_DISCOVER_EVENT, { version: 1 });

	/**
	 * The chat's reviewer now (§chat.alignment-review/route): its profile's reviewer assessed like the
	 * spec writer against the last discovery and the policy. null when the profile names none.
	 */
	function reviewerSlot(): AlignReviewerSlot | null {
		const reviewer = subagents().reviewer;
		if (!reviewer) return null;
		const policy = readPolicy();
		const route = routeWriter({ version: 1, writer: reviewer }, discoveries, (choice) => policyDenial(policy, choice.backend, choice.model))!;
		const why = [route.primary.reason, route.fallback?.reason].filter(Boolean).join("; ");
		return {
			use: route.use,
			via: route.via,
			retry: route.via === "primary" && route.fallback && usable(route.fallback) ? route.fallback.choice : null,
			...(route.via === "fallback" ? { reason: route.primary.reason ?? "primary unavailable" } : {}),
			...(route.via === "none" ? { reason: `${why || "primary unavailable"}${route.fallback ? "" : "; no fallback is set"}` } : {}),
		};
	}
	const alignHost: AlignToolHost = {
		docs: () => alignDocs,
		changed: (doc) => {
			alignDocs = [...alignDocs.filter((d) => d.id !== doc.id), doc];
			if (lastCtx) refreshAlignViews(lastCtx);
		},
		remoteTarget: () => remoteTarget,
		review: () => (reviewOn() ? { reviewer: reviewerSlot, startText: reviewStartText } : undefined),
		style: () => alignNow().style,
		specOn: () => hasMinor(active, "spec"),
	};
	registerAlignTool(pi, alignHost);
	/** The align tool's form now registered: review ops, visual fields (re-registered when either changes). */
	let alignForm = { review: false, visual: false };
	/** The align tool's form follows this session's flags (pi replaces a tool registered again under its name). */
	function syncAlignForm(): void {
		const want = { review: reviewOn(), visual: alignVisuals };
		if (want.review === alignForm.review && want.visual === alignForm.visual) return;
		alignForm = want;
		registerAlignTool(pi, alignHost, want);
	}
	/** Whether /review is registered (once, at the first session_start with the flag on). */
	let reviewRegistered = false;
	function registerReview(): void {
		if (reviewRegistered || !reviewOn()) return;
		reviewRegistered = true;
		pi.registerCommand("review", {
			description: "Ask for an alignment's adversarial review: /review plan|implementation [al_N]",
			getArgumentCompletions: (argumentPrefix) => {
				const items = ["plan", "implementation"].filter((value) => value.startsWith(argumentPrefix.trim())).map((value) => ({ value, label: value }));
				return items.length > 0 ? items : null;
			},
			handler: async (args, ctx) => {
				const m = /^(plan|implementation|diff)(?:\s+(al_[1-9]\d*))?$/.exec(args.trim());
				if (!m) {
					ctx.ui.notify("Usage: /review plan|implementation [al_N]", "warning");
					return;
				}
				if (!hasMinor(active, "align")) {
					ctx.ui.notify("Review needs the align minor mode on (/align on)", "warning");
					return;
				}
				// "implementation" is the user's word for the diff phase; the message carries the id.
				const phase: AlignReviewPhase = m[1] === "plan" ? "plan" : "diff";
				const open = openDocsOf(alignDocs);
				const id = m[2] ?? (open.length === 1 ? open[0]!.id : undefined);
				if (!id) {
					ctx.ui.notify(open.length === 0 ? "No open alignment to review" : `Name the alignment: /review ${m[1]} ${open.map((d) => d.id).join(" | ")}`, "warning");
					return;
				}
				if (!alignDocs.some((d) => d.id === id)) {
					ctx.ui.notify(`No alignment ${id} on this branch`, "warning");
					return;
				}
				pi.sendUserMessage(reviewRequestMessage(id, phase), ctx.isIdle() ? undefined : { deliverAs: "followUp" });
			},
		});
	}
	registerVisGuideTool(pi);

	/** One line per profile: the configured tuple(s) and, in delegate, what is actually in use. */
	function routingLines(): string[] {
		const settings = readDelegate();
		if (!settings) return ["  none: the subagent profile is Off, so the agent picks each worker"];
		if (active.mode === "delegate") recomputeRoutes();
		return DELEGATE_PROFILES.map((profile) => {
			const { primary, fallback } = settings.profiles[profile];
			const configured = `${describeChoice(primary)}${fallback ? `, fallback ${describeChoice(fallback)}` : ", no fallback"}`;
			const route = routes.find((r) => r.profile === profile);
			const using =
				active.mode !== "delegate" || !route
					? ""
					: route.via === "primary"
						? route.primary.availability === "unverified" ? " — using primary (not verified)" : " — using primary"
						: route.via === "fallback"
							? ` — using FALLBACK (${route.primary.reason})`
							: " — none available: will ask";
			return `  ${DELEGATE_PROFILE_INFO[profile].label}: ${configured}${using}`;
		});
	}

	/** The spec writer: what is configured and, while spec is on, what is actually in use. */
	function writerLine(): string {
		const { writer } = readSpec();
		if (!writer) return "spec writer: none — the session writes the spec itself";
		if (hasMinor(active, "spec")) recomputeRoutes();
		const configured = `${describeChoice(writer.primary)}${writer.fallback ? `, fallback ${describeChoice(writer.fallback)}` : ", no fallback"}`;
		const route = writerRoute;
		const using =
			!hasMinor(active, "spec") || !route
				? ""
				: route.via === "primary"
					? route.primary.availability === "unverified" ? " — using primary (not verified)" : " — using primary"
					: route.via === "fallback"
						? ` — using FALLBACK (${route.primary.reason})`
						: " — none available: will ask";
		return `spec writer: ${configured}${using}`;
	}

	function statusLines(): string[] {
		const fileDefault = loadState(STATE_FILE);
		return [
			`mode: ${active.mode}`,
			`default: ${activeSummary(activeOf(fileDefault))} (new sessions; /mode default sets it)`,
			`subagent profile: ${profileLine()}`,
			"delegate routing:",
			...routingLines(),
			writerLine(),
			`strict: ${active.strict ? "on" : "off"}`,
			`minor: ${active.minorModes.length > 0 ? active.minorModes.join(", ") : "(none)"}`,
			`shortcut: ${fileDefault.shortcut ?? DEFAULT_MODE_SHORTCUT}`,
			`alignments: ${alignSummaryLine()}`,
			`state file: ${STATE_FILE}`,
		];
	}

	/** Which subagent profile this chat uses, and where that came from. */
	function profileLine(): string {
		const r = subagents();
		const from = r.source === "pick" ? "this chat's pick" : r.source === "default" ? "the default" : "the legacy settings files";
		return `${r.name} (${from})${r.note ? ` — ${r.note}` : ""}`;
	}

	/**
	 * `/mode subagents <id|off>`: pin this chat's subagent profile (its hidden `subagent-profile`
	 * entry, the shape Sova writes too). Takes an id or a name; nothing else moves.
	 */
	function setSubagentProfile(arg: string, ctx: ExtensionContext): void {
		const { profiles: state } = readProfiles();
		if (state.state !== "ok") {
			ctx.ui.notify(`Subagent profiles can't be used now: ${state.state === "malformed" ? `${state.file} is malformed` : "no profiles file"}.`, "warning");
			return;
		}
		const wanted = arg.toLowerCase();
		const id = wanted === OFF_PROFILE_ID ? OFF_PROFILE_ID : state.value.profiles.find((p) => p.id === arg || p.name.toLowerCase() === wanted)?.id;
		if (!id) {
			ctx.ui.notify(`No subagent profile "${arg}". Profiles: off, ${state.value.profiles.map((p) => p.id).join(", ")}`, "warning");
			return;
		}
		refreshPick(ctx);
		const entry = pickEntryFor(ctx.sessionManager.getBranch() as never, id);
		if (entry) pi.appendEntry(entry.customType, entry.data);
		pick = id;
		recomputeRoutes();
		syncHostSection();
		renderStatus(ctx);
		if (probeWanted()) void refreshRouting(ctx, true);
		ctx.ui.notify(`Subagent profile: ${profileLine()}`, "info");
	}

	const usage = `Usage: /mode [${MODES.join("|")}|status|default|sync|strict on|strict off|subagents <profile>|${MINOR_MODES.map((minor) => `${minor} [on|off]`).join("|")}]`;

	// The ctrl+p "Mode" category; the palette asks for fresh rows on every open.
	registerPaletteCategory(pi.events, {
		version: 1,
		id: MODE_CATEGORY_ID,
		label: "Mode",
		description: "Major mode and minor-mode toggles",
		items: (ctx) =>
			modeCategoryItems(() => active, {
				setMode: (next) => setMode(next, ctx),
				setMinor: (minor, on) => setMinor(minor, on, ctx),
				openAlignViewer: () => openAlignViewer(ctx),
				saveDefault: () => saveDefault(ctx),
			}),
	});

	const ALIGN_ARGS = ["status", "export", "on", "off"];
	pi.registerCommand("align", {
		description: "Open the alignments viewer; or: status | export [path] | on | off",
		getArgumentCompletions: (argumentPrefix) => {
			const items = ALIGN_ARGS.filter((value) => value.startsWith(argumentPrefix.trim())).map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			adoptHost(ctx);
			syncHostSection();
			const arg = args.trim();
			if (arg === "") {
				await openAlignViewer(ctx);
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(`alignments: ${alignSummaryLine()}`, "info");
				return;
			}
			if (arg === "on" || arg === "off") {
				setMinor("align", arg === "on", ctx);
				return;
			}
			const exportArg = /^export(?:\s+(.+))?$/.exec(arg);
			if (exportArg) {
				exportAlign(exportArg[1]?.trim() ?? "", ctx);
				return;
			}
			ctx.ui.notify(`Unknown argument "${arg}". Usage: /align [status|export [path]|on|off]`, "warning");
		},
	});

	pi.registerCommand("mode", {
		description: "Open the mode selector, or set a mode with an argument",
		getArgumentCompletions: (argumentPrefix) => {
			const minorItems = MINOR_MODES.flatMap((minor) => [minor, `${minor} on`, `${minor} off`]);
			const items = [...MODES, "status", "default", "sync", "strict on", "strict off", "subagents", ...minorItems]
				.filter((value) => value.startsWith(argumentPrefix.trim()))
				.map((value) => ({ value, label: value }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			// Any /mode call, even one that changes nothing (`/mode sync`, Sova's at chat open), is the
			// moment the host's base sections become reachable: adopt and bring them in step now.
			adoptHost(ctx);
			syncHostSection();
			const arg = args.trim();
			// Only that: no entry, no notice, no status change. The session's mode is already restored
			// (session_start); this puts its block into the host's base sections and keeps it there.
			if (arg === "sync") {
				// …and republishes what workers get, for a subagents extension that missed the last one.
				publishWorkerModes();
				return;
			}
			if (arg === "") {
				if (ctx.mode === "tui") {
					const opened = requestPaletteOpen(pi.events, ctx, [MODE_CATEGORY_ID]);
					if (opened) {
						await opened;
						return;
					}
				}
				// No palette to open (non-TUI, palette not loaded, or already open): never toggle blindly.
				ctx.ui.notify(`${statusLines().join("\n")}\n${usage}`, "warning");
				return;
			}
			const mode = parseMode(arg);
			if (mode !== undefined) {
				await setMode(mode, ctx);
				return;
			}
			if (arg === "status") {
				ctx.ui.notify(statusLines().join("\n"), "info");
				return;
			}
			if (arg === "default") {
				saveDefault(ctx);
				return;
			}
			const subagentsArg = /^subagents\s+(.+)$/.exec(arg);
			if (subagentsArg) {
				setSubagentProfile(subagentsArg[1]!.trim(), ctx);
				return;
			}
			const strictToggle = /^strict\s+(on|off)$/.exec(arg);
			if (strictToggle) {
				const strict = strictToggle[1] === "on";
				const changed = strict !== active.strict;
				if (changed) {
					active = { ...active, strict };
					publishActive();
					appendSwitch({ strict });
					if (active.mode === "delegate") {
						if (strict) applyStrictTools();
						else restoreTools();
					}
					syncHostSection();
				}
				const appliedNow = changed && active.mode === "delegate";
				ctx.ui.notify(
					`Strict mode ${strict ? "on" : "off"}${appliedNow ? ` (edit/write ${strict ? "removed from" : "restored to"} the orchestrator)` : ""}`,
					"info",
				);
				renderStatus(ctx);
				return;
			}
			const minorToggle = /^([a-z-]+)(?:\s+(on|off))?$/.exec(arg);
			if (minorToggle && isMinorMode(minorToggle[1])) {
				const minor = minorToggle[1];
				const on = minorToggle[2] === undefined ? !hasMinor(active, minor) : minorToggle[2] === "on";
				setMinor(minor, on, ctx);
				return;
			}
			ctx.ui.notify(`Unknown argument "${arg}". ${usage}`, "warning");
		},
	});

	pi.registerShortcut((config.shortcut ?? DEFAULT_MODE_SHORTCUT) as KeyId, {
		description: "Toggle normal / delegate mode",
		handler: async (ctx) => setMode(toggleMode(active.mode), ctx),
	});

	for (const minor of MINOR_MODES) {
		const shortcut = config.minorShortcuts?.[minor];
		if (shortcut === undefined || MINOR_SURFACES[minor] === "web") continue;
		pi.registerShortcut(shortcut as KeyId, {
			description: `Toggle the ${minor} minor mode`,
			handler: async (ctx) => setMinor(minor, !hasMinor(active, minor), ctx),
		});
	}

	if (!viewerShortcutClash) {
		pi.registerShortcut(viewerShortcut as KeyId, {
			description: "Open the alignments viewer",
			handler: async (ctx) => openAlignViewer(ctx),
		});
	}

	// What this run recorded, for the settle nudge: an align call counts only when it succeeded and
	// changed a document or recorded an exemption. A refused call or a bare get records nothing.
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== ALIGN_TOOL || event.isError) return;
		const details = (event.result as { details?: { doc?: unknown; exempt?: unknown } } | undefined)?.details;
		if (details?.doc !== undefined || details?.exempt !== undefined) runAlignCalls++;
	});

	// The run's last reply: every assistant message replaces it, text or not, so the nudge never
	// judges an earlier turn's words when the final message has none.
	pi.on("turn_end", async (event, ctx) => {
		lastCtx = ctx;
		const m = event.message as { role?: string; content?: unknown } | undefined;
		if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return;
		const blocks = m.content as { type?: string; text?: string }[];
		lastReplyText = blocks
			.filter((b) => b?.type === "text" && typeof b.text === "string")
			.map((b) => b.text)
			.join("\n");
	});

	/**
	 * One nudge per run: a run about to settle with align on, no align call, and a final reply that
	 * reads like a plan asking the user to decide gets a hidden message and one more request.
	 */
	pi.on("agent_before_settle", async (event) => {
		if (!hasMinor(active, "align") || nudged || runAlignCalls > 0 || event.outcome !== "completed") return;
		if (!looksLikeUncapturedPlan(lastReplyText, { userAsked: runUserAsked })) return;
		nudged = true;
		return {
			entries: [
				...event.entries,
				{ type: "custom_message" as const, customType: ALIGN_NUDGE_MESSAGE, display: false, content: ALIGN_NUDGE_TEXT },
			],
			continue: true,
		};
	});

	pi.on("agent_settled", async () => {
		running = false;
		runAlignCalls = 0;
		lastReplyText = "";
		runUserAsked = false;
		nudged = false;
		syncVisGuideTool();
		syncCodemodeTool();
	});

	// A compaction summarizes the align results away, and the next run may be one no user prompt
	// starts (a worker's report), which gets no note: write the exact open state once, hidden, right
	// after the summary, where every later request reads it.
	pi.on("session_compact", async () => {
		const note = hasMinor(active, "align") ? alignStateNote(alignDocs, true) : undefined;
		if (note) pi.sendMessage({ customType: ALIGN_STATE_MESSAGE, content: note, display: false });
		// The cached prefix is gone with the history, so the next run rebuilds the head from the modes
		// active then, and the notes the summary replaced are no longer needed. A run already under way
		// keeps its own prompt to its end (pi copies the options per run), with the notes it had.
		head = undefined;
		told = [];
		guides = [];
		headStyle = undefined;
		toldStyle = undefined;
		syncHostSection();
	});

	// Notes from before the last compaction that it kept (its recent tail) repeat what the rebuilt head
	// now says: drop them from every request once that head is fixed. Same result every request, so the
	// prefix stays stable; while a run that compacted still goes on, its prompt is the old one and they stay.
	pi.on("context", async (event) => {
		if (head === undefined) return;
		const messages = event.messages as { role?: string; customType?: string; timestamp?: number }[];
		let cut: number | undefined;
		for (let i = messages.length - 1; i >= 0 && cut === undefined; i--) {
			if (messages[i]?.role === "compactionSummary") cut = messages[i]?.timestamp;
		}
		if (cut === undefined) return;
		const kept = event.messages.filter((_m, i) => !(messages[i]?.role === "custom" && messages[i]?.customType === MODE_NOTE_TYPE && (messages[i]?.timestamp ?? 0) < cut!));
		return kept.length === event.messages.length ? undefined : { messages: kept };
	});

	// Branch navigation (/tree, /fork) changes which mode and which doc are current.
	pi.on("session_tree", async (_event, ctx) => {
		refreshPick(ctx);
		restoreActiveState("tree", ctx);
		restoreAlign(ctx);
	});

	// ── Spec on: the mechanical checks (spec-guard.ts) ──
	// After any tool call, bash included, the census runs on a Git delta: the first changed file in the
	// spec boundary and each new file get a `[spec census]` digest appended to that tool result, with the
	// write guard's and promote's drift notes. Silent without a spec, Git or the tools, and in a remote
	// session; a census that can't run says so once per cause. PI_SPEC_CENSUS_HOOK=0 turns it off.
	const specCensus = new CensusHook({ core: () => SPEC_CORE });
	const specWrites = new SpecWriteGuard();
	const specOn = () => hasMinor(active, "spec") && remoteTarget === undefined;
	/**
	 * Notes for calls a codemode script made, by the script's own call id: a nested result reaches only the
	 * script, so what the census or the guard told it is told again on the script's result, the one the
	 * model reads (§chat.mode-menu/codemode).
	 */
	const hoistedNotes = new Map<string, string[]>();
	pi.on("tool_call", async (event, ctx) => {
		if (!specOn() || process.env.PI_SPEC_CENSUS_HOOK === "0") return;
		await specWrites.before(event.toolCallId, { cwd: ctx.cwd, toolName: event.toolName, input: event.input, signal: ctx.signal });
		await specCensus.before({ id: event.toolCallId, cwd: ctx.cwd, toolName: event.toolName, input: event.input, signal: ctx.signal });
	});

	// A call blocked or aborted before it ran gets no tool_result: it stops counting as running.
	pi.on("tool_execution_end", async (event) => {
		specCensus.close(event.toolCallId);
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!specOn() || process.env.PI_SPEC_CENSUS_HOOK === "0") return;
		const { text: forbidden, lost } = await specWrites.after(event.toolCallId, { cwd: ctx.cwd, toolName: event.toolName, input: event.input, signal: ctx.signal });
		const { text: census, failure } = await specCensus.after({
			id: event.toolCallId,
			cwd: ctx.cwd,
			orphansSaid: lost,
			toolName: event.toolName,
			input: event.input,
			signal: ctx.signal,
			commands: bashCommands(ctx.sessionManager.getBranch()),
			sessionStart: ctx.sessionManager.getHeader()?.timestamp,
		});
		// A worker on its worktree's own agent dir: its census state, for its parent's landed line.
		writeLanded(process.env[LANDED_FILE_ENV], specCensus.snapshot());
		// A failure reaches the model (F12): a census it expected and didn't get must not read as "all clear".
		const text = [forbidden, driftNote(event.toolName, event.input, event.content), census, failure].filter(Boolean).join("\n");
		const parent = (event as { parentToolCallId?: unknown }).parentToolCallId;
		if (typeof parent === "string" && text) hoistedNotes.set(parent, [...(hoistedNotes.get(parent) ?? []), text]);
		const hoisted = hoistedNotes.get(event.toolCallId);
		hoistedNotes.delete(event.toolCallId);
		// The script's calls' notes, each line once, then the result's own.
		const all = [[...new Set((hoisted ?? []).flatMap((t) => t.split("\n")))].join("\n"), text].filter(Boolean).join("\n");
		if (!all) return;
		// Replacing the content alone would drop a structured result (bash's, which a script reads): keep it.
		const structured = (event as { structuredContent?: unknown }).structuredContent;
		return { content: [...event.content, { type: "text" as const, text: all }], ...(structured !== undefined ? { structuredContent: structured as never } : {}) };
	});

	pi.on("session_shutdown", async () => {
		// A probe still in flight belongs to this session's ctx, dead from here on: its result is
		// dropped, never applied (renderStatus on a stale ctx throws, unhandled, in the server's warm-up).
		dropProbe();
		alignDocs = [];
		legacyAlign = null;
		liveViewer = undefined;
		viewerOpen = false;
	});

	// The behaviour change itself: put the mode blocks into this turn's system prompt, the minor ones
	// as the head has them (a minor switch since then rides a hidden note instead). pi >= 0.86 exposes
	// mutable prompt sections and diffs them against what the model already has; a change there is a
	// tail patch only on models that take mid-conversation system messages, and elsewhere rewrites the
	// head (and restarts a Claude Code CLI), which is why a minor toggle no longer touches it. Older
	// hosts without sections (pi < 0.86) still take the whole-prompt append.
	//
	// Delegate's routing is re-read here, at every turn boundary: a routing or policy change reaches
	// a session already in delegate from its next prompt. A changed routing (or stale discovery)
	// re-probes in the background; until that lands, tuples of undiscovered backends are unverified
	// and stay in use — spawn is the final check, and the prompt's retry rule covers a miss. The spec
	// writer is re-read and probed the same way whenever spec is on, in either major mode.
	pi.on("before_agent_start", async (event, ctx) => {
		// Only a user prompt reaches here: the run it starts answers a question when it ends in one.
		runUserAsked = /\?\s*$/.test(event.prompt ?? "");
		refreshPick(ctx);
		if (active.mode === "delegate" || hasMinor(active, "spec")) {
			const { key } = probeScope();
			recomputeRoutes();
			// Announce only a routing the user changed; a timed refresh or the start-up probe joined
			// here stays quiet unless whoever started it asked (a switch into delegate does).
			if (probeWanted() && routingStale()) void refreshRouting(ctx, probedKey !== undefined && key !== probedKey);
			try {
				renderStatus(ctx);
			} catch {
				// Status is best-effort here.
			}
		}
		// The first run since the start or a compaction fixes the head; a later one tells the model,
		// in a hidden note beside this prompt, about minor modes switched since.
		fixHead();
		syncVisGuideTool();
		syncCodemodeTool();
		const modeNote = takeNote();
		if (modeNote) pi.sendMessage(modeNote, { deliverAs: "nextTurn" });
		const block = modeBlock();
		// The same block into the base options, so a later request of this run, or a run an
		// extension's message starts, is built with it too (see hostPromptOptions).
		syncHostSection(block);
		// The open alignments ride the user's prompt as a hidden message, never the system prompt:
		// a prompt change restarts a Claude Code session's CLI.
		const note = hasMinor(active, "align") ? alignStateNote(alignDocs) : undefined;
		const message = note ? { message: { customType: ALIGN_STATE_MESSAGE, content: note, display: false } } : {};
		const sections = (event.systemPromptOptions as { sections?: Record<string, string> } | undefined)?.sections;
		if (sections) {
			applyModeSection(sections, block);
			return note ? message : undefined;
		}
		if (block === undefined) return note ? message : undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${block}`, ...message };
	});

	// Every run, whoever started it, and after pi may have rebuilt its base options (a tool
	// change): the base sections carry the current block before the run's first request. A run an
	// extension's message started (no before_agent_start) gets its mode note here, steered in ahead of
	// its first request; a continuation of a run (after a compaction or a nudge) keeps the run's mode.
	pi.on("agent_start", async (_event, ctx) => {
		if (!running) {
			refreshPick(ctx);
			recomputeRoutes();
			running = true;
			hoistedNotes.clear();
			if (specOn() && process.env.PI_SPEC_CENSUS_HOOK !== "0") await specCensus.prime(ctx.cwd);
			fixHead();
			const modeNote = takeNote();
			if (modeNote) pi.sendMessage(modeNote);
		}
		syncHostSection();
	});

	pi.on("session_start", async (event, ctx) => {
		lastCtx = ctx;
		running = false;
		specCensus.reset();
		toldWriter = undefined;
		reviewFlag = pi.getFlag(REVIEW_FLAG) === true;
		registerReview();
		refreshPick(ctx);
		// Visuals are fixed here for the session's life: the caller's flag, else the file and the profile now.
		const visualsFlag = pi.getFlag(VISUALS_FLAG);
		alignVisuals = workerRole ? false : visualsFlag === "on" ? true : visualsFlag === "off" ? false : alignNow().visuals;
		syncAlignForm();
		restoreActiveState(event?.reason, ctx);
		restoreAlign(ctx);
		if (viewerShortcutClash && ctx.hasUI) {
			ctx.ui.notify(`Align viewer key ${viewerShortcut} clashes with a mode toggle; use /align (set "viewerShortcut" in mode.json)`, "warning");
		}
	});

	// The footer can recreate its status line on these events; re-assert ours.
	pi.on("model_select", async (_event, ctx) => renderStatus(ctx));
	pi.on("thinking_level_select", async (_event, ctx) => renderStatus(ctx));

	// A visible marker in the transcript where the behaviour changed.
	// `active` rides along on every marker for restore; the renderer shows only what changed.
	pi.registerEntryRenderer<ModeMarker>(MODE_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data;
		if (data && "minor" in data) return new Text(theme.fg("dim", `── ${data.minor} ${data.on ? "on" : "off"} ──`), 0, 0);
		if (data && "strict" in data) return new Text(theme.fg("dim", `── strict ${data.strict ? "on" : "off"} ──`), 0, 0);
		const mode = data?.mode ?? "normal";
		return new Text(theme.fg("dim", `── mode → ${mode} ──`), 0, 0);
	});

	// An older session's markdown alignment doc: one dim marker per revision, read-only.
	pi.registerEntryRenderer<LegacyAlignEntryData>(ALIGN_ENTRY_TYPE, (entry, _options, theme) => {
		const doc = entry.data?.doc;
		if (!doc) return new Text(theme.fg("dim", "── alignment cleared ──"), 0, 0);
		return new Text(theme.fg("dim", `── alignment ${legacyLine(doc)} ──`), 0, 0);
	});
}
