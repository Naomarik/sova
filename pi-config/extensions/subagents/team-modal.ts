/**
 * TeamModal — a three-pane team workspace, the /agents monitor's sibling.
 *
 * Three panes, left to right:
 *   Teams     one entry per team (session teams and read-only branch history)
 *   Members   the roster of the selected team: role, exact worker ID, status
 *   Activity  the selected member's retained transcript (live workers), its
 *             unavailable reason plus last known state (pruned members and
 *             teams restored from history), or the team's objective
 *
 * Follow-up/redirect composition and stopping are delegated to the host, which
 * owns the editor prompt, async re-entry guards, delivery through the shared
 * steerWorker/killWorker path, and error reporting. There is no team-wide stop
 * (deferred by review decision 4): `x x` stops exactly the selected member.
 *
 * Layout guarantees match AgentsModal:
 *   - every rendered line is exactly `width` cells (or a safe fallback when
 *     the terminal is too narrow/short for the three-pane layout)
 *   - both list panes use selected-item-aware scroll windows
 *   - an armed stop confirmation is cancelled by ANY key other than a second
 *     `x` (the hint line promises exactly that), and expires on its own
 *   - the render cache key covers every input that can change the output,
 *     including roster availability flips, unread badges and time buckets
 *
 * TeamView data is detached and rebuilt by the host on every access; members
 * are identified by their exact worker ID, and a member whose worker leaves
 * the manager stays visible as unavailable with a reason instead of vanishing.
 */

import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	bodyText,
	clamp,
	formatTokens,
	inline,
	pad,
	relativeTime,
	transcriptLabel,
	windowStart,
} from "./modal.ts";
import { transcriptDisplayText } from "./codefold.ts";
import type { SteerMode, Worker } from "./contracts.ts";
import type { MemberState, TeamMemberView, TeamView } from "./teams.ts";

export interface TeamHost {
	/** Fresh detached team views, including unavailable/pruned members with a reason. */
	getTeams(): TeamView[];
	/** Live worker for a retained member; undefined once the manager evicts it. */
	getWorker(workerId: string): Worker | undefined;
	/** Host owns prompting, async re-entry guards, delivery, and error reporting. */
	steerMember?(workerId: string, mode: SteerMode): void;
	stopMember(workerId: string): void;
	requestRender(): void;
	close(): void;
}

type Pane = "teams" | "members";

/** A pre-wrapped, pre-padded transcript row; theme colors are applied at render. */
interface CachedRow {
	text: string;
	color: string | null;
}

/** Narrowest terminal that fits the three-pane layout: 8 + 10 + 12 + 4 borders. */
const MIN_LAYOUT_WIDTH = 34;
/** Auto-cancel an armed stop confirmation after this long. */
const CONFIRM_TIMEOUT_MS = 3000;

export class TeamModal {
	private focus: Pane = "members";
	private teamIndex = 0;
	private memberIndex = 0;
	private selectedTeamId?: string;
	private selectedMemberId?: string;
	/** Until the user picks a team themselves, the newest team stays selected. */
	private teamPinned = false;
	private scroll = 0;
	private autoScroll = true;
	/** First visible ROW (2 rows per item) in each list pane. */
	private teamScroll = 0;
	private memberScroll = 0;
	private confirmStop: string | null = null;
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
	private readonly host: TeamHost;

	constructor(tui: any, theme: any, host: TeamHost) {
		this.tui = tui;
		this.theme = theme;
		this.host = host;
	}

	// ── selection ────────────────────────────────────────────────────────────

	private teams(): TeamView[] {
		return this.host.getTeams();
	}

	private currentTeam(): TeamView | undefined {
		const teams = this.teams();
		// IDs survive history re-reads and additions. If an ID disappears, choose
		// the item at its former index (the successor), or the last predecessor.
		const retained = teams.findIndex((t) => t.id === this.selectedTeamId);
		if (!this.teamPinned) this.teamIndex = teams.length - 1;
		else if (retained >= 0) this.teamIndex = retained;
		this.teamIndex = clamp(this.teamIndex, 0, Math.max(0, teams.length - 1));
		const team = teams[this.teamIndex];
		if (team?.id !== this.selectedTeamId) {
			this.selectedTeamId = team?.id;
			this.selectedMemberId = undefined;
			this.memberIndex = 0;
			this.resetSelectionState();
		}
		return team;
	}

	private currentMembers(): TeamMemberView[] {
		return this.currentTeam()?.members ?? [];
	}

	private currentMember(): TeamMemberView | undefined {
		const members = this.currentMembers();
		const retained = members.findIndex((m) => m.workerId === this.selectedMemberId);
		if (retained >= 0) this.memberIndex = retained;
		this.memberIndex = clamp(this.memberIndex, 0, Math.max(0, members.length - 1));
		const member = members[this.memberIndex];
		if (member?.workerId !== this.selectedMemberId) {
			this.selectedMemberId = member?.workerId;
			this.resetSelectionState();
		}
		return member;
	}

	/** Live worker behind a member, if the manager still retains it right now. */
	private memberWorker(member: TeamMemberView | undefined): Worker | undefined {
		return member?.available ? this.host.getWorker(member.workerId) : undefined;
	}

	// ── input ────────────────────────────────────────────────────────────────

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q") {
			this.host.close();
			return;
		}

		// Reconcile availability before navigation or actions, even without a render.
		this.currentMember();

		// The hint says "any other key cancels" — make that true for EVERY key
		// except a second `x`: handled keys, scroll keys, and stray letters all
		// cancel an armed confirmation before anything else happens.
		const wasArmed = this.confirmStop !== null;
		const isX = data === "x";
		if (wasArmed && !isX) this.clearConfirm();

		if (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right")) {
			this.focus = this.focus === "teams" ? "members" : "teams";
			this.redraw();
			return;
		}

		const up = matchesKey(data, "up") || data === "k";
		const down = matchesKey(data, "down") || data === "j";
		if (up || down) {
			if (this.focus === "teams") {
				const teams = this.teams();
				this.teamPinned = true;
				this.teamIndex = clamp(this.teamIndex + (down ? 1 : -1), 0, Math.max(0, teams.length - 1));
				// Selecting the newest team again re-enables follow mode.
				if (this.teamIndex === teams.length - 1) this.teamPinned = false;
				this.selectedTeamId = teams[this.teamIndex]?.id;
				this.selectedMemberId = undefined;
				this.memberIndex = 0;
			} else {
				const members = this.currentMembers();
				this.memberIndex = clamp(this.memberIndex + (down ? 1 : -1), 0, Math.max(0, members.length - 1));
				this.selectedMemberId = members[this.memberIndex]?.workerId;
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
			const target = this.steerableMember();
			// Redraw before transferring input ownership to a host-owned prompt.
			if (wasArmed) this.redraw();
			if (target) this.host.steerMember?.(target, matchesKey(data, "r") ? "redirect" : "followUp");
			return;
		}

		if (isX) {
			// Exact-member stop only; a team-wide stop is a conscious later addition,
			// so the teams pane never arms anything.
			const target = this.focus === "members" ? this.stoppableMember() : undefined;
			if (!target) {
				// Nothing stoppable under the cursor: drop any stale confirmation
				// instead of leaving "press x again" on screen.
				if (this.confirmStop !== null) {
					this.clearConfirm();
					this.redraw();
				}
				return;
			}
			this.armOrFire(target, () => this.host.stopMember(target));
			return;
		}

		// Unhandled key: it still cancels an armed confirmation (cleared above).
		if (wasArmed) this.redraw();
	}

	private steerableMember(): string | undefined {
		if (this.focus !== "members" || !this.host.steerMember) return undefined;
		const member = this.currentMember();
		const worker = this.memberWorker(member);
		// A fatal failure reports "error" while teardown is still running, so ask
		// the worker; a live "error" worker of a backend without isStopping stays
		// steerable and the runner remains the authority on rejection.
		return member && worker && !worker.isFinished() && worker.status !== "stopping" && !worker.isStopping?.()
			? member.workerId
			: undefined;
	}

	private stoppableMember(): string | undefined {
		const member = this.currentMember();
		const worker = this.memberWorker(member);
		return member && worker && !worker.isFinished() ? member.workerId : undefined;
	}

	/** Two-press confirm, so a stray keystroke never stops anything. */
	private armOrFire(workerId: string, fire: () => void): void {
		if (this.confirmStop === workerId) {
			this.clearConfirm();
			fire();
		} else {
			this.confirmStop = workerId;
			if (this.confirmTimer) clearTimeout(this.confirmTimer);
			this.confirmTimer = setTimeout(() => {
				this.confirmStop = null;
				this.redraw();
			}, CONFIRM_TIMEOUT_MS);
		}
		this.redraw();
	}

	private clearConfirm(): void {
		this.confirmStop = null;
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
		const worker = this.memberWorker(this.currentMember());
		if (worker) worker.unreadCount = 0;
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
		// A disposed modal must not keep an armed stop confirmation on screen
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
	 * bottom) stays within a 90%-of-rows overlay budget, capped like the monitor.
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
	private layout(width: number): { teamsW: number; membersW: number; paneW: number } {
		const borders = 4;
		const minTeams = 8;
		const minMembers = 10;
		const minPane = 12;
		let teamsW = clamp(Math.floor(width * 0.18), minTeams, 24);
		let membersW = clamp(Math.floor(width * 0.24), minMembers, 34);
		let paneW = width - borders - teamsW - membersW;
		if (paneW < minPane) {
			// The activity pane matters most: shrink the lists, never borders.
			let need = minPane - paneW;
			const takeMembers = Math.min(membersW - minMembers, need);
			membersW -= takeMembers;
			need -= takeMembers;
			const takeTeams = Math.min(teamsW - minTeams, need);
			teamsW -= takeTeams;
			paneW = width - borders - teamsW - membersW;
		}
		return { teamsW, membersW, paneW };
	}

	// ── render ───────────────────────────────────────────────────────────────

	render(width: number): string[] {
		const teams = this.teams();
		const team = this.currentTeam();
		const members = this.currentMembers();
		const member = this.currentMember();
		const worker = this.memberWorker(member);
		if (worker) worker.unreadCount = 0;

		const height = this.bodyHeight();
		if (width < MIN_LAYOUT_WIDTH || height < 1) {
			return this.renderFallback(width);
		}

		const { teamsW, membersW, paneW } = this.layout(width);
		const listVisible = height - (height % 2); // whole items (2 rows each)

		this.teamScroll = windowStart(teams.length, this.teamIndex, listVisible, this.teamScroll);
		this.memberScroll = windowStart(members.length, this.memberIndex, listVisible, this.memberScroll);

		// Content signature gates BOTH caches: views are rebuilt by the host on
		// every access, so identity cannot be trusted; everything visible must be
		// covered here. Per-member worker presence/unread is included so an
		// availability flip (prune between reads) busts the frame.
		const signature = worker ? this.transcriptSignature(worker) : "";
		const lastAction = team && member ? [...team.actions].reverse().find((a) => a.workerId === member.workerId) : undefined;
		const key = [
			width,
			height,
			this.focus,
			this.teamIndex,
			this.memberIndex,
			this.scroll,
			this.autoScroll ? 1 : 0,
			this.expanded ? 1 : 0,
			this.teamScroll,
			this.memberScroll,
			this.confirmStop ?? "",
			this.steerableMember() ?? "",
			Math.floor(Date.now() / 1000), // relative timestamps tick
			signature,
			worker ? `${worker.unreadCount}:${worker.usage?.turns ?? 0}:${worker.steerCount ?? 0}:${worker.sessionId ?? ""}` : "",
			lastAction ? `${lastAction.seq}:${lastAction.state}:${lastAction.reason?.length ?? 0}` : "",
			teams
				.map(
					(t) =>
						`${t.id}:${t.origin}:${t.members.length}:${t.actions.length}:${t.members
							.map((m) => {
								const w = this.memberWorker(m);
								return `${m.workerId}:${m.state}:${m.status ?? ""}:${m.taskOutcome ?? ""}:${m.available ? 1 : 0}:${
									m.error?.length ?? 0
								}:${w ? 1 : 0}:${w?.unreadCount ?? 0}`;
							})
							.join(",")}`,
				)
				.join(";"),
		].join("|");
		if (this.cachedLines && this.cachedKey === key) return this.cachedLines;

		const th = this.theme;
		const b = (s: string) => th.fg("border", s);
		const title = (text: string, w: number, active: boolean) => th.fg(active ? "accent" : "dim", pad(text, w));

		const counts = team ? (["working", "idle", "failed", "done", "stopping", "stopped", "unavailable"] as const)
			.filter((k) => team.counts[k])
			.map((k) => `${team.counts[k]} ${k}`)
			.join(" · ") : "";
		const lines: string[] = [];
		lines.push(
			b("╭") +
				title(` Teams (${teams.length})`, teamsW, this.focus === "teams") +
				b("┬") +
				title(
					` ${team ? `${inline(team.name)} · ${team.id}${team.origin === "history" ? " · history" : ""}${counts ? ` · ${counts}` : ""}` : "no team"}`,
					membersW,
					this.focus === "members",
				) +
				b("┬") +
				title(
					` ${member ? `${inline(member.role)} [${inline(member.backend)}] ${inline(member.workerId)} · ${member.model ? inline(member.model) : "default model"}${worker || !member.available ? "" : " · unavailable"}` : "no member"}`,
					paneW,
					true,
				) +
				b("╮"),
		);

		const teamFirst = this.teamScroll / 2;
		const memberFirst = this.memberScroll / 2;
		const teamRows = this.buildTeamRows(
			listVisible > 0 ? teams.slice(teamFirst, teamFirst + Math.ceil(listVisible / 2)) : [],
			teamsW,
			this.focus === "teams",
			this.teamIndex - teamFirst,
			teams.length === 0,
		);
		const memberRows = this.buildMemberRows(
			listVisible > 0 ? members.slice(memberFirst, memberFirst + Math.ceil(listVisible / 2)) : [],
			membersW,
			this.focus === "members",
			this.memberIndex - memberFirst,
			team !== undefined && members.length === 0,
			teams.length === 0,
		);
		const paneRows = this.buildActivityRows(team, member, worker, paneW, height, signature, lastAction);

		for (let i = 0; i < height; i++) {
			lines.push(
				b("│") +
					(teamRows[i] ?? pad("", teamsW)) +
					b("│") +
					(memberRows[i] ?? pad("", membersW)) +
					b("│") +
					(paneRows[i] ?? pad("", paneW)) +
					b("│"),
			);
		}

		lines.push(b("├") + b("─".repeat(teamsW)) + b("┴") + b("─".repeat(membersW)) + b("┴") + b("─".repeat(paneW)) + b("┤"));
		lines.push(b("│") + pad(this.hintLine(teamsW + membersW + paneW + 2), teamsW + membersW + paneW + 2) + b("│"));
		lines.push(b(`╰${"─".repeat(teamsW + membersW + paneW + 2)}╯`));

		this.cachedLines = lines;
		this.cachedKey = key;
		return lines;
	}

	/** Too narrow or too short for the layout: one safe line, never wider than `width`. */
	private renderFallback(width: number): string[] {
		const th = this.theme;
		const teams = this.teams();
		const working = teams.reduce((n, t) => n + t.counts.working, 0);
		const reason = width < MIN_LAYOUT_WIDTH ? `needs ≥${MIN_LAYOUT_WIDTH} cols` : "needs more rows";
		return [pad(th.fg("dim", ` teams: ${teams.length} team(s), ${working} working — ${reason}`), Math.max(1, width))];
	}

	/**
	 * Bottom hint. `inner` is the usable width: the [paused] marker is budgeted
	 * for FIRST and appended after an ANSI-safe truncation of the base hint, so
	 * scroll-paused state can never be truncated off the end of a narrow row.
	 */
	private hintLine(inner: number): string {
		const th = this.theme;
		if (this.confirmStop !== null) {
			const member = this.currentMembers().find((m) => m.workerId === this.confirmStop);
			const label = member ? `${inline(member.role)} (${inline(member.workerId)})` : inline(this.confirmStop);
			return th.fg("error", ` press x again to stop ${label} · any other key cancels`);
		}
		const fold = this.expanded ? "o collapse code" : "o expand code";
		const steer = this.steerableMember() ? "r redirect · f follow-up · " : "";
		const base = th.fg(
			"dim",
			this.focus === "teams"
				? ` Tab/←→ pane · ↑↓/jk select team · PgUp/PgDn scroll · End follow · ${fold} · Esc close`
				: ` ${steer}Tab/←→ pane · ↑↓/jk select · PgUp/PgDn scroll · End follow · ${fold} · x stop member · Esc close`,
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

	/** Team dot: any activity pulses, failure is red, a fully idle team is half, finished green, history hollow. */
	private teamDot(team: TeamView): string {
		const th = this.theme;
		const c = team.counts;
		if (c.working + c.stopping > 0) return th.fg("success", "●");
		if (c.failed > 0) return th.fg("error", "✗");
		if (c.idle > 0) return th.fg("warning", "◐");
		if (c.done > 0) return th.fg("success", "✓");
		if (c.stopped > 0) return th.fg("error", "⊘");
		return th.fg("dim", "○");
	}

	private buildTeamRows(
		items: TeamView[],
		width: number,
		focused: boolean,
		selectedOffset: number,
		showEmpty: boolean,
	): string[] {
		const th = this.theme;
		const rows: string[] = [];
		if (items.length === 0) {
			if (showEmpty) rows.push(pad("", width), pad(th.fg("dim", "  no teams yet"), width));
			return rows;
		}
		for (let i = 0; i < items.length; i++) {
			const team = items[i];
			const selected = i === selectedOffset;
			const marker = selected && !focused ? "›" : " ";
			const line1 = ` ${marker} ${this.teamDot(team)} ${th.bold(inline(team.name))}`;
			const line2 = `   ${th.fg("dim", `${team.members.length}× · ${team.origin === "history" ? "history · " : ""}${relativeTime(team.createdAt)}`)}`;
			rows.push(...this.listRow(line1, line2, width, selected && focused));
		}
		return rows;
	}

	/** Member dot per failure-aware team state; mirrors the monitor's vocabulary. */
	private memberDot(state: MemberState): string {
		const th = this.theme;
		switch (state) {
			case "working":
				return th.fg("success", "●");
			case "idle":
				return th.fg("warning", "◐");
			case "failed":
				return th.fg("error", "✗");
			case "done":
				return th.fg("success", "✓");
			case "stopping":
				return th.fg("warning", "◌");
			case "stopped":
				return th.fg("error", "⊘");
			default:
				return th.fg("dim", "○");
		}
	}

	private buildMemberRows(
		items: TeamMemberView[],
		width: number,
		focused: boolean,
		selectedOffset: number,
		showEmpty: boolean,
		noTeam: boolean,
	): string[] {
		const th = this.theme;
		const rows: string[] = [];
		if (items.length === 0) {
			if (showEmpty) rows.push(pad("", width), pad(th.fg("dim", "  no members"), width));
			else if (noTeam) rows.push(pad("", width), pad(th.fg("dim", "  no team"), width));
			return rows;
		}
		for (let i = 0; i < items.length; i++) {
			const member = items[i];
			const selected = i === selectedOffset;
			const worker = this.memberWorker(member);
			const unread = worker && worker.unreadCount > 0 && !selected ? th.fg("accent", ` ●${worker.unreadCount}`) : "";
			const marker = selected && !focused ? "›" : " ";
			const line1 = ` ${marker} ${this.memberDot(member.state)} ${th.bold(inline(member.role))}${unread} ${th.fg("dim", inline(member.workerId))}`;
			// Availability leads (short forms survive truncation; the activity pane
			// shows the full reason): status detail is repeated there in full too.
			const statusText = member.status ? ` (${inline(member.status)}${member.taskOutcome ? `/${member.taskOutcome}` : ""})` : "";
			const unavailable = member.availability === "pruned" ? " · pruned" : member.availability === "previous-session" ? " · history" : "";
			const line2 = `   ${th.fg("dim", `${member.state}${unavailable}${statusText} · owns: ${member.ownedPaths.map(inline).join(", ") || "none declared"}`)}`;
			rows.push(...this.listRow(line1, line2, width, selected && focused));
		}
		return rows;
	}

	private buildActivityRows(
		team: TeamView | undefined,
		member: TeamMemberView | undefined,
		worker: Worker | undefined,
		width: number,
		height: number,
		signature: string,
		lastAction: TeamView["actions"][number] | undefined,
	): string[] {
		const th = this.theme;
		if (!team) {
			return [pad("", width), pad(th.fg("dim", "  Create one with the team_create tool."), width)];
		}
		if (!member) {
			// A team with no members (only possible for restored history): show what
			// the team is about instead of a blank pane.
			const all: string[] = [pad(` ${th.fg("accent", `${inline(team.name)} (${team.id})`)}`, width), pad("", width)];
			const inner = Math.max(4, width - 2);
			for (const wrapped of wrapTextWithAnsi(bodyText(team.objective), inner)) all.push(pad(` ${wrapped}`, width));
			return all;
		}
		if (!worker) {
			// Pruned, previous-session, or evicted between reads: honest unavailable view.
			const all: string[] = [
				pad(` ${th.fg("warning", `${inline(member.role)} (${inline(member.workerId)}) — unavailable`)}`, width),
				pad("", width),
			];
			const inner = Math.max(4, width - 2);
			for (const wrapped of wrapTextWithAnsi(bodyText(member.reason ?? "Not retained by the manager."), inner)) {
				all.push(pad(` ${th.fg("dim", wrapped)}`, width));
			}
			if (member.status) {
				all.push(pad("", width));
				all.push(pad(` ${th.fg("dim", `Last known: ${inline(member.status)}${member.taskOutcome ? ` · task ${member.taskOutcome}` : ""}`)}`, width));
			}
			if (member.error) for (const wrapped of wrapTextWithAnsi(bodyText(member.error), inner)) all.push(pad(` ${th.fg("error", wrapped)}`, width));
			return all.slice(0, height);
		}

		// Wrapped item rows come from the wrap cache; only the usage/action/session
		// tail is rebuilt per render, so a large transcript is never re-wrapped on
		// every frame invalidation or clock tick.
		const all: string[] = this.wrappedTranscript(worker, width, signature).map((r) =>
			r.color === null ? r.text : th.fg(r.color, r.text),
		);

		const usage = worker.usage;
		const stats: string[] = [];
		if (usage?.turns) stats.push(`${usage.turns} turns`);
		if (usage?.input) stats.push(`↑${formatTokens(usage.input)}`);
		if (usage?.output) stats.push(`↓${formatTokens(usage.output)}`);
		if (usage?.cost) stats.push(`$${usage.cost.toFixed(4)}`);
		if (worker.steerCount) stats.push(`${worker.steerCount} steer`);
		if (stats.length) all.push(pad(` ${th.fg("dim", stats.join(" "))}`, width));
		if (lastAction) {
			// Action states never claim delivery or execution beyond SteerResult.
			const text = ` #${lastAction.seq} ${lastAction.source} ${lastAction.kind}: ${lastAction.state}${lastAction.reason ? ` — ${lastAction.reason}` : ""}`;
			all.push(pad(` ${th.fg(lastAction.state === "failed" || lastAction.state === "unknown" ? "warning" : "dim", inline(text))}`, width));
		}
		if (worker.sessionId) all.push(pad(` ${th.fg("dim", `session ${inline(worker.sessionId)}`)}`, width));

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
	private transcriptSignature(worker: Worker): string {
		const revision = (worker as { transcriptRevision?: number }).transcriptRevision;
		if (typeof revision === "number") return `rev${revision}`;
		const items = worker.transcript;
		const first = items[0];
		const last = items[items.length - 1];
		let volume = 0;
		for (const item of items) volume += item.text?.length ?? 0;
		return `${items.length}:${first?.ts ?? -1}:${last?.ts ?? -1}:${last?.text?.length ?? -1}:${volume}`;
	}

	private wrappedTranscript(worker: Worker, width: number, signature: string): CachedRow[] {
		const key = `${signature}@${width}${this.expanded ? "+" : "-"}`;
		const cached = this.wraps.get(worker);
		if (cached && cached.key === key) {
			this.wrapHits++;
			return cached.rows;
		}
		const rows: CachedRow[] = [];
		const inner = Math.max(4, width - 2);
		for (const item of worker.transcript) {
			const { label, color } = transcriptLabel(item.kind, item.toolName);
			if (label) rows.push({ text: pad(` ${label}`, width), color });
			const indent = item.kind === "tool" ? "   " : "";
			const text = transcriptDisplayText(item, this.expanded, inner - indent.length);
			const body = `${indent}${bodyText(text)}`;
			for (const wrapped of wrapTextWithAnsi(body, inner)) {
				rows.push({ text: pad(` ${wrapped}`, width), color: item.kind === "assistant" ? null : color });
			}
			rows.push({ text: pad("", width), color: null });
		}
		this.wraps.set(worker, { key, rows });
		this.wrapMisses++;
		return rows;
	}
}
