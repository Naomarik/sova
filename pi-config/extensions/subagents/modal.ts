/**
 * AgentsModal — a desktop-chat-app view of subagents.
 *
 * Three panes, left to right:
 *   Runs        one entry per agent_spawn call, newest at the bottom
 *   Subagents   the "contact list" for the selected run
 *   Transcript  the selected subagent's output
 *
 * No inline compose box: optional redirect/follow-up controls delegate to the
 * host, which owns the editor prompt and delivery to the selected backend.
 *
 * Layout guarantees:
 *   - every rendered line is exactly `width` cells (or a safe fallback when
 *     the terminal is too narrow/short for the three-pane layout)
 *   - both list panes use selected-item-aware scroll windows, so the selected
 *     run/subagent is always fully visible however long the lists get
 *   - an armed kill confirmation is cancelled by ANY key other than a second
 *     `x` (the hint line promises exactly that)
 *   - the render cache key covers every input that can change the output,
 *     including wall-clock time buckets for the relative timestamps
 */

import { stripVTControlCharacters } from "node:util";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { transcriptDisplayText } from "./codefold.ts";
import type { SteerMode, TranscriptItem, Worker } from "./contracts.ts";

export interface AgentGroup {
	id: string;
	label: string;
	createdAt: number;
	agents: Worker[];
}

export interface ModalHost {
	getGroups(): AgentGroup[];
	killAgent(id: string): void;
	killGroup(id: string): void;
	/** Host owns prompting, async re-entry guards, delivery, and error reporting. */
	steerAgent?(id: string, mode: SteerMode): void;
	requestRender(): void;
	close(): void;
}

type Pane = "runs" | "agents";

/** A pre-wrapped, pre-padded transcript row; theme colors are applied at render. */
interface CachedRow {
	text: string;
	color: string | null;
}

/** Narrowest terminal that fits the three-pane layout: 8 + 10 + 12 + 4 borders. */
const MIN_LAYOUT_WIDTH = 34;
/** Auto-cancel an armed kill confirmation after this long. */
const CONFIRM_TIMEOUT_MS = 3000;

export function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(n, hi));
}

export function pad(text: string, width: number): string {
	if (width <= 0) return "";
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "…", true);
	return text + " ".repeat(width - w);
}

/** Controls that never belong in a rendered row (C0, DEL, C1). \x notation only. */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
const TAB_WIDTH = 4;
const TAB_SPACES = " ".repeat(TAB_WIDTH);

/**
 * Single-line text for names, labels, models, ids: ANSI/OSC sequences are
 * stripped, remaining control characters become spaces, tabs expand, and
 * newlines collapse to spaces so nothing can repaint or reflow the row.
 */
export function inline(text: unknown): string {
	return stripVTControlCharacters(String(text ?? ""))
		.replace(/\r\n?/g, " ")
		.replace(/\n/g, " ")
		.replace(/\t/g, TAB_SPACES)
		.replace(CONTROL_CHARS, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

/**
 * Multi-line text for transcript bodies: same stripping, but newlines are
 * preserved (wrapTextWithAnsi splits on them) and space runs are left intact.
 */
export function bodyText(text: unknown): string {
	return stripVTControlCharacters(String(text ?? ""))
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t/g, TAB_SPACES)
		.replace(CONTROL_CHARS, " ");
}

export function relativeTime(ts: number): string {
	const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	return `${Math.round(seconds / 3600)}h`;
}

export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

/**
 * True when a subagent's task failed — the process may still be alive in
 * `waiting` (steerable), so status alone must not decide this.
 */
function failedOutcome(agent: Worker): boolean {
	if (agent.status === "error" || agent.status === "killed") return true;
	return agent.taskOutcome === "error" || agent.taskOutcome === "aborted";
}

/**
 * First visible row for a 2-rows-per-item list, keeping `selected` fully
 * on screen with minimal movement and never splitting an item's row pair.
 */
export function windowStart(itemCount: number, selected: number, visibleRows: number, current: number): number {
	if (itemCount === 0 || visibleRows <= 0) return 0;
	const total = itemCount * 2;
	const maxStart = Math.max(0, total - visibleRows);
	const selTop = clamp(selected, 0, itemCount - 1) * 2;
	let start = clamp(current, 0, maxStart);
	if (visibleRows <= 1) {
		start = Math.min(selTop, maxStart);
	} else {
		if (selTop < start) start = selTop;
		if (selTop + 2 > start + visibleRows) start = selTop + 2 - visibleRows;
	}
	start -= start % 2; // keep item boundaries
	return clamp(start, 0, maxStart);
}

/** Label and theme color for one transcript item kind (shared with TeamModal). */
export function transcriptLabel(kind: TranscriptItem["kind"], toolName?: string): { label: string; color: string } {
	switch (kind) {
		case "task":
			return { label: "▸ TASK", color: "accent" };
		case "steer":
			return { label: "▸ NEW INSTRUCTIONS", color: "warning" };
		case "assistant":
			return { label: "", color: "toolOutput" };
		case "tool":
			return { label: `→ ${toolName ? inline(toolName) : "tool"}`, color: "muted" };
		case "tool-result":
			return { label: "  ↳ failed", color: "error" };
		case "error":
			return { label: "✗ error", color: "error" };
		default:
			return { label: "", color: "dim" };
	}
}

export class AgentsModal {
	private focus: Pane = "agents";
	private groupIndex = 0;
	private agentIndex = 0;
	private selectedGroupId?: string;
	private selectedAgentId?: string;
	/** Until the user picks a run themselves, the newest run stays selected. */
	private groupPinned = false;
	private scroll = 0;
	private autoScroll = true;
	/** First visible ROW (2 rows per item) in each list pane. */
	private runScroll = 0;
	private agentScroll = 0;
	private confirmKill: string | null = null;
	private confirmTimer: ReturnType<typeof setTimeout> | null = null;
	private cachedLines?: string[];
	private cachedKey?: string;
	/** Transcript wrap cache, independent of the per-frame cache. */
	private wraps = new WeakMap<object, { key: string; rows: CachedRow[] }>();
	/** Folded code blocks are expanded (`o` toggles; collapsed by default). */
	private expanded = false;
	private wrapHits = 0;
	private wrapMisses = 0;

	private readonly tui: any;
	private readonly theme: any;
	private readonly host: ModalHost;

	constructor(tui: any, theme: any, host: ModalHost) {
		this.tui = tui;
		this.theme = theme;
		this.host = host;
	}

	// ── selection ────────────────────────────────────────────────────────────

	private groups(): AgentGroup[] {
		return this.host.getGroups();
	}

	private currentGroup(): AgentGroup | undefined {
		const groups = this.groups();
		// IDs survive retention splices. If an ID disappears, choose the item at
		// its former index (the successor), or the last remaining predecessor.
		const retained = groups.findIndex((g) => g.id === this.selectedGroupId);
		if (!this.groupPinned) this.groupIndex = groups.length - 1;
		else if (retained >= 0) this.groupIndex = retained;
		this.groupIndex = clamp(this.groupIndex, 0, Math.max(0, groups.length - 1));
		const group = groups[this.groupIndex];
		if (group?.id !== this.selectedGroupId) {
			this.selectedGroupId = group?.id;
			this.selectedAgentId = undefined;
			this.agentIndex = 0;
			this.resetSelectionState();
		}
		return group;
	}

	private currentAgents(): Worker[] {
		return this.currentGroup()?.agents ?? [];
	}

	private currentAgent(): Worker | undefined {
		const agents = this.currentAgents();
		const retained = agents.findIndex((a) => a.id === this.selectedAgentId);
		if (retained >= 0) this.agentIndex = retained;
		this.agentIndex = clamp(this.agentIndex, 0, Math.max(0, agents.length - 1));
		const agent = agents[this.agentIndex];
		if (agent?.id !== this.selectedAgentId) {
			this.selectedAgentId = agent?.id;
			this.resetSelectionState();
		}
		return agent;
	}

	// ── input ────────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.host.close();
			return;
		}

		// Reconcile retention before navigation or actions, even without a render.
		this.currentAgent();

		// The hint says "any other key cancels" — make that true for EVERY key
		// except a second `x`: handled keys, scroll keys, and stray letters all
		// cancel an armed confirmation before anything else happens.
		const wasArmed = this.confirmKill !== null;
		const isX = data === "x";
		if (wasArmed && !isX) this.clearConfirm();

		if (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right")) {
			this.focus = this.focus === "runs" ? "agents" : "runs";
			this.redraw();
			return;
		}

		const up = matchesKey(data, "up") || data === "k";
		const down = matchesKey(data, "down") || data === "j";
		if (up || down) {
			if (this.focus === "runs") {
				const groups = this.groups();
				this.groupPinned = true;
				this.groupIndex = clamp(this.groupIndex + (down ? 1 : -1), 0, Math.max(0, groups.length - 1));
				// Selecting the newest run again re-enables follow mode.
				if (this.groupIndex === groups.length - 1) this.groupPinned = false;
				this.selectedGroupId = groups[this.groupIndex]?.id;
				this.selectedAgentId = undefined;
				this.agentIndex = 0;
			} else {
				const agents = this.currentAgents();
				this.agentIndex = clamp(this.agentIndex + (down ? 1 : -1), 0, Math.max(0, agents.length - 1));
				this.selectedAgentId = agents[this.agentIndex]?.id;
			}
			this.onSelectionChanged();
			return;
		}

		if (matchesKey(data, "pageUp")) {
			this.autoScroll = false;
			this.scroll = Math.max(0, this.scroll - 10);
			this.redraw();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.autoScroll = false;
			this.scroll += 10;
			this.redraw();
			return;
		}
		if (matchesKey(data, "home")) {
			this.autoScroll = false;
			this.scroll = 0;
			this.redraw();
			return;
		}
		if (matchesKey(data, "end")) {
			this.autoScroll = true;
			this.redraw();
			return;
		}

		if (data === "o") {
			// Accordion: expand/collapse every folded code block in the transcript.
			this.expanded = !this.expanded;
			this.redraw();
			return;
		}

		if (matchesKey(data, "r") || matchesKey(data, "f")) {
			const agent = this.steerableAgent();
			// Redraw before transferring input ownership to a host-owned prompt.
			if (wasArmed) this.redraw();
			if (agent) this.host.steerAgent?.(agent.id, matchesKey(data, "r") ? "redirect" : "followUp");
			return;
		}

		if (isX) {
			let token: string | null = null;
			let fire: () => void = () => {};
			if (this.focus === "runs") {
				const group = this.currentGroup();
				if (group && group.agents.some((a) => !a.isFinished())) {
					token = `group:${group.id}`;
					fire = () => this.host.killGroup(group.id);
				}
			} else {
				const agent = this.currentAgent();
				if (agent && !agent.isFinished()) {
					token = `agent:${agent.id}`;
					fire = () => this.host.killAgent(agent.id);
				}
			}
			if (!token) {
				// Nothing killable under the cursor: drop any stale confirmation
				// instead of leaving "press x again" on screen.
				if (this.confirmKill !== null) {
					this.clearConfirm();
					this.redraw();
				}
				return;
			}
			this.armOrFire(token, fire);
			return;
		}

		// Unhandled key: it still cancels an armed confirmation (cleared above).
		if (wasArmed) this.redraw();
	}

	private steerableAgent(): Worker | undefined {
		if (this.focus !== "agents" || !this.host.steerAgent) return undefined;
		const agent = this.currentAgent();
		// A fatal failure reports "error" while teardown is still running, so ask
		// the worker; a live "error" worker of a backend without isStopping stays
		// steerable and the runner remains the authority on rejection.
		return agent && !agent.isFinished() && agent.status !== "stopping" && !agent.isStopping?.() ? agent : undefined;
	}

	/** Two-press confirm, so a stray keystroke never kills anything. */
	private armOrFire(token: string, fire: () => void): void {
		if (this.confirmKill === token) {
			this.clearConfirm();
			fire();
		} else {
			this.confirmKill = token;
			if (this.confirmTimer) clearTimeout(this.confirmTimer);
			this.confirmTimer = setTimeout(() => {
				this.confirmKill = null;
				this.redraw();
			}, CONFIRM_TIMEOUT_MS);
		}
		this.redraw();
	}

	private clearConfirm(): void {
		this.confirmKill = null;
		if (this.confirmTimer) {
			clearTimeout(this.confirmTimer);
			this.confirmTimer = null;
		}
	}

	private resetSelectionState(): void {
		this.clearConfirm();
		this.scroll = 0;
		this.autoScroll = true;
		this.invalidate();
	}

	private onSelectionChanged(): void {
		this.resetSelectionState();
		const agent = this.currentAgent();
		if (agent) agent.unreadCount = 0;
		this.redraw();
	}

	private redraw(): void {
		this.invalidate();
		this.host.requestRender();
	}

	invalidate(): void {
		this.cachedLines = undefined;
		this.cachedKey = undefined;
	}

	dispose(): void {
		// A disposed modal must not keep an armed kill confirmation on screen
		// (or a timer pointing at a dead host).
		this.clearConfirm();
	}

	/** Wrap-cache counters (tests/telemetry; the frame cache has its own key). */
	wrapStats(): { hits: number; misses: number } {
		return { hits: this.wrapHits, misses: this.wrapMisses };
	}

	// ── layout ───────────────────────────────────────────────────────────────

	/**
	 * Body height such that body + 4 chrome lines (top, separator, hint,
	 * bottom) stays within a 90%-of-rows overlay budget, capped like before.
	 */
	private bodyHeight(): number {
		const rows =
			typeof this.tui?.height === "number" && this.tui.height > 0
				? this.tui.height
				: typeof this.tui?.terminal?.rows === "number" && this.tui.terminal.rows > 0
					? this.tui.terminal.rows
					: 40;
		return Math.min(34, Math.floor(rows * 0.9) - 4);
	}

	/** Split `width` into pane widths; guaranteed to sum to width - 4. */
	private layout(width: number): { runsW: number; listW: number; paneW: number } {
		const borders = 4;
		const minRuns = 8;
		const minList = 10;
		const minPane = 12;
		let runsW = clamp(Math.floor(width * 0.18), minRuns, 24);
		let listW = clamp(Math.floor(width * 0.24), minList, 30);
		let paneW = width - borders - runsW - listW;
		if (paneW < minPane) {
			// The transcript pane matters most: shrink the lists, never borders.
			let need = minPane - paneW;
			const takeList = Math.min(listW - minList, need);
			listW -= takeList;
			need -= takeList;
			const takeRuns = Math.min(runsW - minRuns, need);
			runsW -= takeRuns;
			paneW = width - borders - runsW - listW;
		}
		return { runsW, listW, paneW };
	}

	private windowStart(itemCount: number, selected: number, visibleRows: number, current: number): number {
		return windowStart(itemCount, selected, visibleRows, current);
	}

	// ── render ───────────────────────────────────────────────────────────────

	render(width: number): string[] {
		const groups = this.groups();
		const group = this.currentGroup();
		const agents = this.currentAgents();
		const agent = this.currentAgent();
		if (agent) agent.unreadCount = 0;

		const height = this.bodyHeight();
		if (width < MIN_LAYOUT_WIDTH || height < 1) {
			return this.renderFallback(width);
		}

		const { runsW, listW, paneW } = this.layout(width);
		const listVisible = height - (height % 2); // whole items (2 rows each)

		this.runScroll = this.windowStart(groups.length, this.groupIndex, listVisible, this.runScroll);
		this.agentScroll = this.windowStart(agents.length, this.agentIndex, listVisible, this.agentScroll);

		// Content signature gates BOTH caches: transcript.length alone stopped being a
		// sufficient proxy once the runner started trimming in place (length-preserving
		// splices), which would leave the frame cache serving stale transcript lines.
		const signature = agent ? this.transcriptSignature(agent) : "";
		const key = [
			width,
			height,
			this.focus,
			this.groupIndex,
			this.agentIndex,
			this.scroll,
			this.autoScroll ? 1 : 0,
			this.expanded ? 1 : 0,
			this.runScroll,
			this.agentScroll,
			this.confirmKill ?? "",
			this.steerableAgent()?.id ?? "",
			Math.floor(Date.now() / 1000), // relative timestamps tick
			signature,
			groups
				.map(
					(g) =>
						`${g.id}:${g.agents.length}:${g.agents.filter((a) => !a.isFinished()).length}:${
							g.agents.filter((a) => failedOutcome(a)).length
						}`,
				)
				.join(","),
			agents
				.map(
					(a) =>
						`${a.id}:${a.name}:${a.backend ?? "pi"}:${a.model ?? ""}:${a.status}:${a.taskOutcome ?? ""}:${a.transcript.length}:${a.usage?.turns ?? 0}:${a.unreadCount}:${
							a.sessionId ?? ""
						}`,
				)
				.join(","),
		].join("|");
		if (this.cachedLines && this.cachedKey === key) return this.cachedLines;

		const th = this.theme;
		const b = (s: string) => th.fg("border", s);
		const title = (text: string, w: number, active: boolean) => th.fg(active ? "accent" : "dim", pad(text, w));

		const live = agents.filter((a) => !a.isFinished()).length;
		const lines: string[] = [];
		lines.push(
			b("╭") +
				title(` Runs (${groups.length})`, runsW, this.focus === "runs") +
				b("┬") +
				title(
					` ${group ? inline(group.label) : "no run"} · ${live}/${agents.length} live`,
					listW,
					this.focus === "agents",
				) +
				b("┬") +
				title(
					` ${agent ? `[${inline(agent.backend ?? "pi")}] ${inline(agent.name)} · ${agent.model ? inline(agent.model) : "default model"}` : "no subagent"}`,
					paneW,
					true,
				) +
				b("╮"),
		);

		const runFirst = this.runScroll / 2;
		const listFirst = this.agentScroll / 2;
		const runRows = this.buildRunRows(
			listVisible > 0 ? groups.slice(runFirst, runFirst + Math.ceil(listVisible / 2)) : [],
			runsW,
			this.focus === "runs",
			this.groupIndex - runFirst,
			groups.length === 0,
		);
		const listRows = this.buildAgentRows(
			listVisible > 0 ? agents.slice(listFirst, listFirst + Math.ceil(listVisible / 2)) : [],
			listW,
			this.focus === "agents",
			this.agentIndex - listFirst,
			agents.length === 0,
		);
		const paneRows = this.buildTranscriptRows(agent, paneW, height, signature);

		for (let i = 0; i < height; i++) {
			lines.push(
				b("│") +
					(runRows[i] ?? pad("", runsW)) +
					b("│") +
					(listRows[i] ?? pad("", listW)) +
					b("│") +
					(paneRows[i] ?? pad("", paneW)) +
					b("│"),
			);
		}

		lines.push(b("├") + b("─".repeat(runsW)) + b("┴") + b("─".repeat(listW)) + b("┴") + b("─".repeat(paneW)) + b("┤"));
		lines.push(b("│") + pad(this.hintLine(runsW + listW + paneW + 2), runsW + listW + paneW + 2) + b("│"));
		lines.push(b(`╰${"─".repeat(runsW + listW + paneW + 2)}╯`));

		this.cachedLines = lines;
		this.cachedKey = key;
		return lines;
	}

	/** Too narrow or too short for the layout: one safe line, never wider than `width`. */
	private renderFallback(width: number): string[] {
		const th = this.theme;
		const groups = this.groups();
		const live = groups.reduce((n, g) => n + g.agents.filter((a) => !a.isFinished()).length, 0);
		const reason = width < MIN_LAYOUT_WIDTH ? `needs ≥${MIN_LAYOUT_WIDTH} cols` : "needs more rows";
		return [pad(th.fg("dim", ` subagents: ${groups.length} run(s), ${live} live — ${reason}`), Math.max(1, width))];
	}

	/**
	 * Bottom hint. `inner` is the usable width: the [paused] marker is budgeted
	 * for FIRST and appended after an ANSI-safe truncation of the base hint, so
	 * scroll-paused state can never be truncated off the end of a narrow row.
	 */
	private hintLine(inner: number): string {
		const th = this.theme;
		if (this.confirmKill?.startsWith("group:")) {
			return th.fg("error", " press x again to kill EVERY live subagent in this run · any other key cancels");
		}
		if (this.confirmKill?.startsWith("agent:")) {
			return th.fg("error", ` press x again to kill ${inline(this.confirmKill.slice(6))} · any other key cancels`);
		}
		const scope = this.focus === "runs" ? "run" : "subagent";
		const fold = this.expanded ? "o collapse code" : "o expand code";
		const steer = this.steerableAgent() ? "r redirect · f follow-up · " : "";
		const base = th.fg(
			"dim",
			` ${steer}Tab/←→ pane · ↑↓/jk select · PgUp/PgDn scroll · End follow · ${fold} · x kill ${scope} · Esc close`,
		);
		if (this.autoScroll) return base;
		const marker = th.fg("warning", " · [paused]");
		const budget = Math.max(0, inner - visibleWidth(marker));
		return truncateToWidth(base, budget, "", true) + marker;
	}

	private listRow(line1: string, line2: string, width: number, highlighted: boolean): string[] {
		if (!highlighted) return [pad(line1, width), pad(line2, width)];
		return [this.theme.bg("selectedBg", pad(line1, width)), this.theme.bg("selectedBg", pad(line2, width))];
	}

	private buildRunRows(
		items: AgentGroup[],
		width: number,
		focused: boolean,
		selectedOffset: number,
		showEmpty: boolean,
	): string[] {
		const th = this.theme;
		const rows: string[] = [];
		if (items.length === 0) {
			if (showEmpty) rows.push(pad("", width), pad(th.fg("dim", "  no runs yet"), width));
			return rows;
		}
		for (let i = 0; i < items.length; i++) {
			const group = items[i];
			const selected = i === selectedOffset;
			const live = group.agents.filter((a) => !a.isFinished()).length;
			const failed = group.agents.filter((a) => failedOutcome(a)).length;
			// Live runs pulse, dead-but-failed runs show a red ✗ (a clean exit with
			// a failed task must not masquerade as success), clean runs hollow out.
			const dot = live > 0 ? th.fg("success", "●") : failed > 0 ? th.fg("error", "✗") : th.fg("dim", "○");
			const marker = selected && !focused ? "›" : " ";
			const line1 = ` ${marker} ${dot} ${th.bold(inline(group.label))}`;
			const line2 = `   ${th.fg("dim", `${group.agents.length}× · ${relativeTime(group.createdAt)}`)}`;
			rows.push(...this.listRow(line1, line2, width, selected && focused));
		}
		return rows;
	}

	private buildAgentRows(
		items: Worker[],
		width: number,
		focused: boolean,
		selectedOffset: number,
		showEmpty: boolean,
	): string[] {
		const th = this.theme;
		const rows: string[] = [];
		if (items.length === 0) {
			if (showEmpty) rows.push(pad("", width), pad(th.fg("dim", "  no subagents"), width));
			return rows;
		}
		for (let i = 0; i < items.length; i++) {
			const agent = items[i];
			const selected = i === selectedOffset;
			const unread = agent.unreadCount > 0 && !selected ? th.fg("accent", ` ●${agent.unreadCount}`) : "";
			const marker = selected && !focused ? "›" : " ";
			const line1 = ` ${marker} ${this.dotFor(agent)} ${th.bold(inline(agent.name))}${unread}`;
			const outcome = agent.taskOutcome;
			const outcomeText = outcome && outcome !== "success" ? ` (${inline(outcome)})` : "";
			const line2 = `   ${th.fg(
				"dim",
				`${inline(agent.id)} · ${inline(agent.status)}${outcomeText} · ${relativeTime(agent.lastActivity)}`,
			)}`;
			rows.push(...this.listRow(line1, line2, width, selected && focused));
		}
		return rows;
	}

	/** Per-subagent dot: failure-aware, so `waiting` never hides a failed task. */
	private dotFor(agent: Worker): string {
		const th = this.theme;
		const failed = agent.taskOutcome === "error" || agent.taskOutcome === "aborted";
		switch (agent.status) {
			case "running":
				return th.fg("success", "●");
			case "stopping":
				return th.fg("warning", "◌");
			case "waiting":
				// Alive and steerable, but the task itself may have failed.
				return failed ? th.fg("error", "✗") : th.fg("warning", "◐");
			case "done":
				return failed ? th.fg("error", "✗") : th.fg("success", "✓");
			case "error":
				return th.fg("error", "✗");
			case "killed":
				return th.fg("error", "⊘");
			default:
				return th.fg("dim", "○");
		}
	}

	private buildTranscriptRows(
		agent: Worker | undefined,
		width: number,
		height: number,
		signature: string,
	): string[] {
		const th = this.theme;
		if (!agent) return [pad("", width), pad(th.fg("dim", "  Spawn one with the agent_spawn tool."), width)];

		// Wrapped item rows come from the wrap cache; only the usage/session tail
		// is rebuilt per render, so a 2 MiB transcript is never re-wrapped on every
		// frame invalidation or clock tick.
		const all: string[] = this.wrappedTranscript(agent, width, signature).map((r) =>
			r.color === null ? r.text : th.fg(r.color, r.text),
		);

		const usage = agent.usage;
		const stats: string[] = [];
		if (usage?.turns) stats.push(`${usage.turns} turns`);
		if (usage?.input) stats.push(`↑${formatTokens(usage.input)}`);
		if (usage?.output) stats.push(`↓${formatTokens(usage.output)}`);
		if (usage?.cost) stats.push(`$${usage.cost.toFixed(4)}`);
		if (agent.steerCount) stats.push(`${agent.steerCount} steer`);
		if (stats.length) all.push(pad(` ${th.fg("dim", stats.join(" "))}`, width));
		if (agent.sessionId) all.push(pad(` ${th.fg("dim", `session ${inline(agent.sessionId)}`)}`, width));

		const maxScroll = Math.max(0, all.length - height);
		if (this.autoScroll) this.scroll = maxScroll;
		else this.scroll = clamp(this.scroll, 0, maxScroll);

		return all.slice(this.scroll, this.scroll + height);
	}

	/**
	 * Wrap-cache key. Prefers a runner-provided monotonic `transcriptRevision`
	 * (bumped on every push and trim) when present; otherwise a content
	 * signature that also catches in-place trim-marker rewrites: item count,
	 * first/last anchors, and total text volume.
	 */
	private transcriptSignature(agent: Worker): string {
		const revision = (agent as { transcriptRevision?: number }).transcriptRevision;
		if (typeof revision === "number") return `rev${revision}`;
		const items = agent.transcript;
		const first = items[0];
		const last = items[items.length - 1];
		let volume = 0;
		for (const item of items) volume += item.text?.length ?? 0;
		return `${items.length}:${first?.ts ?? -1}:${last?.ts ?? -1}:${last?.text?.length ?? -1}:${volume}`;
	}

	private wrappedTranscript(agent: Worker, width: number, signature: string): CachedRow[] {
		const key = `${signature}@${width}${this.expanded ? "+" : "-"}`;
		const cached = this.wraps.get(agent);
		if (cached && cached.key === key) {
			this.wrapHits++;
			return cached.rows;
		}
		const rows: CachedRow[] = [];
		const inner = Math.max(4, width - 2);
		for (const item of agent.transcript) {
			const { label, color } = this.decorate(item.kind, item.toolName);
			if (label) rows.push({ text: pad(` ${label}`, width), color });
			const indent = item.kind === "tool" ? "   " : "";
			const text = transcriptDisplayText(item, this.expanded, inner - indent.length);
			const body = `${indent}${bodyText(text)}`;
			for (const wrapped of wrapTextWithAnsi(body, inner)) {
				rows.push({ text: pad(` ${wrapped}`, width), color: item.kind === "assistant" ? null : color });
			}
			rows.push({ text: pad("", width), color: null });
		}
		this.wraps.set(agent, { key, rows });
		this.wrapMisses++;
		return rows;
	}

	private decorate(kind: TranscriptItem["kind"], toolName?: string): { label: string; color: string } {
		return transcriptLabel(kind, toolName);
	}
}
