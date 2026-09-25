/**
 * TeamWidget — compact team status rows for `ctx.ui.setWidget` (component form).
 *
 * Pure presentation module, deliberately decoupled from index.ts internals:
 * the host pushes fresh, DETACHED `TeamView` data (`TeamStore.views(...)`) in
 * through `update()` from its existing throttled refresh, and clears the widget
 * key when nothing remains and on shutdown. The widget never reaches back into
 * the manager, owns no timers, listeners or polling loops, and `render(width)`
 * is a pure function of the last supplied data: every line is exactly `width`
 * cells (ellipsis plus space padding), so a long name, model id or error can
 * never overflow the terminal.
 *
 * Honesty rules (see docs/native-teams.md):
 * - status words only — no durations, no context-window percentages (window
 *   sizes are unknown) and no delivery/execution claims of any kind
 * - member states arrive failure-aware from TeamStore; unavailable members
 *   name their reason (pruned vs previous session) and last known status
 * - the legend line keeps session scope and advisory ownership on screen
 * - torn-down members (killed, before or after retention pruning) leave the
 *   widget immediately and a fully torn-down team vanishes; team_list and the
 *   /team workspace keep them as history (see `visibleTeams`)
 *
 * Batch 3a owns this file and its test; batch 3b wires it into index.ts
 * (`refresh()` → `handle.update(teamViews())`, shutdown → `handle.clear()`).
 */
import { stripVTControlCharacters } from "node:util";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type { MemberState, TeamMemberView, TeamView } from "./teams.ts";

/** Widget key the host installs/clears under (batch 3b wiring point). */
export const TEAM_WIDGET_KEY = "team";
/** One-line legend; disabling it via options never changes actual behavior. */
export const TEAM_WIDGET_LEGEND = "session-scoped teams · ownership is advisory, not a lock";

const DEFAULT_MAX_TEAMS = 2;
const DEFAULT_MAX_MEMBER_ROWS = 4;

/** Count order matches the team_list text exactly. */
const COUNT_ORDER: readonly MemberState[] = ["working", "idle", "failed", "done", "stopping", "stopped", "unavailable"];
/**
 * Member rows surface activity first: working, idle, failed, then the
 * terminal shades. The sort is stable, so equal ranks keep insertion order
 * and rows never reshuffle between refreshes.
 */
const ROW_RANK: Record<MemberState, number> = {
	working: 0,
	idle: 1,
	failed: 2,
	stopping: 3,
	done: 4,
	stopped: 5,
	unavailable: 6,
};
/** Same dot vocabulary as the /agents monitor, so both views read identically. */
const STATE_MARK: Record<MemberState, { dot: string; color: string }> = {
	working: { dot: "●", color: "success" },
	// Steerable (waiting); a failed task can never hide here — state is failure-aware.
	idle: { dot: "◐", color: "warning" },
	failed: { dot: "✗", color: "error" },
	done: { dot: "✓", color: "success" },
	stopping: { dot: "◌", color: "warning" },
	stopped: { dot: "⊘", color: "error" },
	unavailable: { dot: "○", color: "dim" },
};

/**
 * Minimal slice of Pi's Theme the widget uses. Kept structural so tests can
 * substitute identity/marker themes; the real theme satisfies it (fg colors:
 * accent, dim, success, warning, error — the same strings /agents uses).
 */
export interface TeamWidgetTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}
const IDENTITY_THEME: TeamWidgetTheme = { fg: (_color, text) => text, bold: (text) => text };

export interface TeamWidgetOptions {
	/** Teams rendered before the "… +N more teams" row (default 2). */
	maxTeams?: number;
	/** Member rows per session team before "… +N more members" (default 4). History teams always collapse to one row. */
	maxMemberRows?: number;
	/** Show the session-scope/advisory-ownership legend line (default true). */
	legend?: boolean;
}

/** Controls that never belong in a rendered row (C0, DEL, C1). \x notation only. */
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;
const TAB_SPACES = "    ";

/**
 * Single-line text for names, roles, ids, models, errors: ANSI/OSC sequences
 * are stripped, remaining control characters become spaces, tabs expand and
 * newlines collapse so supplied data can never repaint or reflow a row.
 */
function inline(text: unknown): string {
	return stripVTControlCharacters(String(text ?? ""))
		.replace(/\r\n?/g, " ")
		.replace(/\n/g, " ")
		.replace(/\t/g, TAB_SPACES)
		.replace(CONTROL_CHARS, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

/** Every published line is exactly `width` cells: ellipsis-truncated, then space-padded. */
const fitWidth = (line: string, width: number): string => truncateToWidth(line, width, "…", true);

const bounded = (value: number | undefined, fallback: number): number =>
	value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));

const noun = (n: number, one: string): string => (n === 1 ? one : `${one}s`);

/**
 * A member the operator/parent deliberately tore down: `stopped` (runner
 * status `killed`) while retained, or pruned with last known status `killed`.
 * Crashed workers are `failed`, not torn down, and stay visible; `stopping`
 * stays visible until the process is really gone.
 */
export function isTornDown(member: TeamMemberView): boolean {
	return member.state === "stopped" || (member.availability === "pruned" && member.status === "killed");
}

/**
 * The widget is an always-on "what is live" surface, so it drops torn-down
 * members from rows and header counts, and drops a session team entirely once
 * every member is torn down (whichever path got there: agent_kill of a run,
 * group or single member, or /team stop). Partially torn-down teams keep
 * their other rows. Store views are untouched: team_list and /team still
 * report stopped members and torn-down teams as history. History teams and
 * teams with no members yet pass through unchanged.
 */
export function visibleTeams(teams: readonly TeamView[]): TeamView[] {
	const visible: TeamView[] = [];
	// Ejected members released their seat: hidden like torn-down ones, but already out of `counts`.
	const hidden = (member: TeamMemberView) => member.ejectedAt !== undefined || isTornDown(member);
	for (const team of teams) {
		if (team.origin === "history" || !team.members.some(hidden)) {
			visible.push(team);
			continue;
		}
		const members = team.members.filter((member) => !hidden(member));
		if (members.length === 0) continue;
		const counts = { ...team.counts };
		for (const member of team.members)
			if (member.ejectedAt === undefined && isTornDown(member)) counts[member.state] = Math.max(0, (counts[member.state] ?? 0) - 1);
		visible.push({ ...team, members, counts });
	}
	return visible;
}

/**
 * The setWidget component. `update()` replaces the data wholesale; `render`
 * caches per width until the next update/invalidate. There is intentionally
 * no `handleInput`: keyboard control belongs to the /team workspace.
 */
export class TeamWidget {
	private teams: readonly TeamView[] = [];
	private readonly theme: TeamWidgetTheme;
	private readonly maxTeams: number;
	private readonly maxMemberRows: number;
	private readonly legend: boolean;
	private cache: { width: number; lines: string[] } | undefined;

	constructor(theme: TeamWidgetTheme = IDENTITY_THEME, options: TeamWidgetOptions = {}) {
		this.theme = theme;
		this.maxTeams = bounded(options.maxTeams, DEFAULT_MAX_TEAMS);
		this.maxMemberRows = bounded(options.maxMemberRows, DEFAULT_MAX_MEMBER_ROWS);
		this.legend = options.legend ?? true;
	}

	/**
	 * Replace the rendered data. Views must be detached, fresh snapshots; the
	 * widget treats them as read-only and never observes them itself.
	 */
	update(teams: readonly TeamView[]): void {
		this.teams = visibleTeams(teams);
		this.cache = undefined;
	}

	invalidate(): void {
		this.cache = undefined;
	}

	/** No timers, listeners or handles; just drop the data and cache. */
	dispose(): void {
		this.teams = [];
		this.cache = undefined;
	}

	render(width: number): string[] {
		const w = Math.floor(width);
		if (!Number.isFinite(w) || w <= 0 || this.teams.length === 0) return [];
		if (this.cache?.width === w) return this.cache.lines;
		const lines = this.buildRows().map((row) => fitWidth(row, w));
		this.cache = { width: w, lines };
		return lines;
	}

	private buildRows(): string[] {
		const rows: string[] = [];
		const shown = this.teams.slice(0, this.maxTeams);
		for (const team of shown) {
			rows.push(this.headerRow(team));
			if (team.origin === "history") {
				rows.push(this.historyRow(team));
				continue;
			}
			const ranked = [...team.members].sort(
				(a, b) => (ROW_RANK[a.state] ?? ROW_RANK.unavailable) - (ROW_RANK[b.state] ?? ROW_RANK.unavailable),
			);
			const listed = ranked.slice(0, this.maxMemberRows);
			for (const member of listed) rows.push(this.memberRow(member));
			const hidden = ranked.length - listed.length;
			if (hidden > 0) rows.push(`  ${this.theme.fg("dim", `… +${hidden} more ${noun(hidden, "member")}`)}`);
		}
		const extraTeams = this.teams.length - shown.length;
		if (extraTeams > 0) rows.push(this.theme.fg("dim", `… +${extraTeams} more ${noun(extraTeams, "team")}`));
		if (this.legend) rows.push(this.theme.fg("dim", TEAM_WIDGET_LEGEND));
		return rows;
	}

	private headerRow(team: TeamView): string {
		const counts =
			COUNT_ORDER.filter((key) => (team.counts[key] ?? 0) > 0)
				.map((key) => `${team.counts[key]} ${key}`)
				.join(" · ") || "no members";
		const scope = team.origin === "history" ? " [history]" : "";
		return `${this.theme.fg("accent", "◆")} ${this.theme.bold(inline(team.name))}${this.theme.fg(
			"dim",
			` (${inline(team.id)})${scope} · ${counts}`,
		)}`;
	}

	private historyRow(team: TeamView): string {
		const n = team.members.length;
		return `  ${this.theme.fg(
			"dim",
			`${n || "no"} ${noun(n, "member")} — workers stopped with their session (history only, never live)`,
		)}`;
	}

	private memberRow(member: TeamMemberView): string {
		const th = this.theme;
		const mark = STATE_MARK[member.state] ?? STATE_MARK.unavailable;
		let stateText: string = member.state;
		if (member.state === "failed" && member.taskOutcome) stateText += `/${inline(member.taskOutcome)}`;
		if (member.availability === "pruned") {
			stateText += " (pruned";
			if (member.status) stateText += `, last ${inline(member.status)}${member.taskOutcome ? `/${inline(member.taskOutcome)}` : ""}`;
			stateText += ")";
		} else if (member.availability === "previous-session") {
			stateText += " (previous session)";
		}
		const meta: string[] = [stateText];
		if (member.model) meta.push(inline(member.model));
		if (member.ownedPaths.length) meta.push(`owns: ${member.ownedPaths.map(inline).join(", ")}`);
		if (member.error) meta.push(`error: ${inline(member.error)}`);
		const role = inline(member.role);
		const name = member.available ? th.bold(role) : th.fg("dim", role);
		return `  ${th.fg(mark.color, mark.dot)} ${name} ${th.fg(
			"dim",
			`[${inline(member.backend)}] ${inline(member.workerId)} · ${meta.join(" · ")}`,
		)}`;
	}
}

/** Structural slice of ExtensionContext["ui"] the attachment needs. */
export interface TeamWidgetUi {
	setWidget(
		key: string,
		content: ((tui: unknown, theme: TeamWidgetTheme) => TeamWidget) | undefined,
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
}

export interface TeamWidgetAttachOptions extends TeamWidgetOptions {
	/** Widget placement relative to the editor (Pi default: aboveEditor). */
	placement?: "aboveEditor" | "belowEditor";
}

export interface TeamWidgetHandle {
	/** Push fresh detached views; [] or only torn-down teams (or clear()) removes the widget. */
	update(teams: readonly TeamView[]): void;
	/** Remove the widget now (no live members left, session shutdown). */
	clear(): void;
	/** The live component once the TUI ran the factory; undefined before/after clear. */
	component(): TeamWidget | undefined;
}

/**
 * Install the widget above the editor via the setWidget component form. The
 * widget appears on the first non-empty update, refreshes in place while the
 * host pushes views, and is removed again with `clear()` or `update([])`.
 * Never schedules work; the host's refresh and shutdown own the cadence.
 */
export function attachTeamWidget(ui: TeamWidgetUi, options: TeamWidgetAttachOptions = {}): TeamWidgetHandle {
	let component: TeamWidget | undefined;
	let installed = false;
	let current: readonly TeamView[] = [];
	const install = () => {
		ui.setWidget(
			TEAM_WIDGET_KEY,
			// The TUI may invoke the factory lazily, so it reads the latest views.
			(_tui, theme) => {
				component = new TeamWidget(theme, options);
				component.update(current);
				return component;
			},
			options.placement ? { placement: options.placement } : undefined,
		);
	};
	const handle: TeamWidgetHandle = {
		update(teams) {
			// Filter before the emptiness check so a fully torn-down roster
			// removes the widget key instead of leaving an empty component.
			current = visibleTeams(teams);
			if (current.length === 0) {
				handle.clear();
				return;
			}
			if (installed) component?.update(current);
			else {
				installed = true;
				install();
			}
		},
		clear() {
			current = [];
			component = undefined;
			if (!installed) return;
			installed = false;
			ui.setWidget(TEAM_WIDGET_KEY, undefined);
		},
		component: () => component,
	};
	return handle;
}
