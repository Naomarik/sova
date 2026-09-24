// usage-status: shows Ollama Cloud, OpenAI Codex, Claude, Z.ai (GLM Coding
// Plan) and DeepSeek subscription usage in pi's footer, and a /usage overlay
// screen with the per-provider detail (plans, every window, reset times,
// balances).
//
// Takes over the footer with ctx.ui.setFooter() (a faithful copy of the built-in
// one) so the usage segment can sit on the stats line next to the token stats.
//
// The fetchers, the shared cache file and the machine-wide lock live in
// ./fetch (pi-runtime-free, also imported by Sova's server): only one
// process fetches per ~3 minutes no matter how many pis are open.

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type CacheFile, describeErrors, errMessage, refreshCache, type Window } from "./fetch";

const HOME = os.homedir();

const TICK_MS = 180_000; // per-session check cadence

// ---------------------------------------------------------------------------
// Rendering

type Color = Parameters<Theme["fg"]>[0];

/** `$4.29`; falls back to `XYZ 4.29` when Intl does not know the currency code. */
function formatMoney(total: number, currency: string): string {
	try {
		return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(total);
	} catch {
		return `${currency} ${total.toFixed(2)}`;
	}
}

function severity(usedPct: number): Color {
	if (usedPct >= 80) return "error";
	if (usedPct >= 50) return "warning";
	return "success";
}

/** Detail levels: 1 = full labels, 0 = compact. */
function buildUsage(theme: Theme, cache: CacheFile | undefined, level: number): string {
	const dim = (s: string) => theme.fg("dim", s);
	const pct = (p: number) => theme.fg(severity(p), `${Math.round(p)}%`);
	const staleMark = (err: string | undefined) => (err ? dim(level >= 1 ? " …stale" : "…") : "");
	const sep = level >= 1 ? dim(" │ ") : " ";

	if (!cache) return `${dim("⛁")} ${dim("usage loading…")}`;

	// Ollama
	let ollama: string;
	const o = cache.ollama;
	if (!o) ollama = theme.fg("error", `ollama: ${cache.errors.ollama ?? "error"}`);
	else if (o.state === "nokey") ollama = dim("ollama: no key");
	else if (o.state === "na") ollama = dim("ollama n/a");
	else if (o.state === "badkey") ollama = theme.fg("warning", "ollama: bad key");
	else ollama = `${theme.fg("muted", level >= 1 ? "ollama mo" : "oll")} ${pct(o.usedPct)}`;
	ollama += o ? staleMark(cache.errors.ollama) : "";

	// OpenAI Codex
	let openai: string;
	const x = cache.openai;
	if (!x) openai = theme.fg("error", `openai: ${cache.errors.openai ?? "error"}`);
	else if (x.state === "nologin") openai = dim("openai: not logged in");
	else if (x.state === "na") openai = dim("openai n/a");
	else if (x.state === "expired")
		openai = theme.fg("warning", level >= 1 ? "openai: auth expired (run pi /login)" : "openai: auth expired");
	else openai = `${theme.fg("muted", "openai")} ${x.windows.map((w) => `${dim(w.label)} ${pct(w.pct)}`).join(" ")}`;
	openai += x ? staleMark(cache.errors.openai) : "";

	// Claude
	let claude: string;
	const c = cache.claude;
	if (!c) claude = theme.fg("error", `claude: ${cache.errors.claude ?? "error"}`);
	else if (c.state === "nologin") claude = dim("claude: not logged in");
	else if (c.state === "expired")
		claude = theme.fg("warning", level >= 1 ? "claude: auth expired (run claude /login)" : "claude: auth expired");
	else {
		const parts: string[] = [];
		if (c.fiveHour) parts.push(`${dim("5h")} ${pct(c.fiveHour.pct)}`);
		if (c.sevenDay) parts.push(`${dim("7d")} ${pct(c.sevenDay.pct)}`);
		if (c.sevenDayOpus && level >= 1) parts.push(`${dim("opus")} ${pct(c.sevenDayOpus.pct)}`);
		claude = `${theme.fg("muted", level >= 1 ? "claude" : "cl")} ${parts.length ? parts.join(" ") : dim("n/a")}`;
	}
	claude += c ? staleMark(cache.errors.claude) : "";

	// Z.ai
	let zai: string;
	const z = cache.zai;
	if (!z) zai = theme.fg("error", `zai: ${cache.errors.zai ?? "error"}`);
	else if (z.state === "nokey") zai = dim("zai: no key");
	else if (z.state === "na") zai = dim("zai n/a");
	else if (z.state === "badkey") zai = theme.fg("warning", "zai: bad key");
	else {
		const parts: string[] = [];
		if (z.fiveHour) parts.push(`${dim(z.fiveHour.label)} ${pct(z.fiveHour.pct)}`);
		zai = `${theme.fg("muted", "zai")} ${parts.length ? parts.join(" ") : dim("n/a")}`;
	}
	zai += z ? staleMark(cache.errors.zai) : "";

	// DeepSeek
	let deepseek: string;
	const d = cache.deepseek;
	if (!d) deepseek = theme.fg("error", `deepseek: ${cache.errors.deepseek ?? "error"}`);
	else if (d.state === "nokey") deepseek = dim("deepseek: no key");
	else if (d.state === "na") deepseek = dim("deepseek n/a");
	else if (d.state === "badkey") deepseek = theme.fg("warning", "deepseek: bad key");
	else {
		const name = level >= 1 ? "deepseek" : "ds";
		const amounts = d.balances.map((b) => formatMoney(b.total, b.currency)).join(" ");
		deepseek = d.available ? `${theme.fg("muted", name)} ${amounts}` : theme.fg("warning", `${name}: no credit (${amounts})`);
	}
	deepseek += d ? staleMark(cache.errors.deepseek) : "";

	return `${dim("⛁")} ${ollama}${sep}${openai}${sep}${claude}${sep}${zai}${sep}${deepseek}`;
}

// ---------------------------------------------------------------------------
// /usage screen

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const two = (n: number) => String(n).padStart(2, "0");

/** Local `Sep 25 12:00` (with `:ss` if asked). */
function localTime(ms: number, seconds = false): string {
	const d = new Date(ms);
	const hm = `${two(d.getHours())}:${two(d.getMinutes())}${seconds ? `:${two(d.getSeconds())}` : ""}`;
	return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
}

/** Reset time as local time plus a coarse countdown; both "—" when unknown. */
function formatReset(resetsAt: string | undefined, now: number): { at: string; left: string } {
	const ms = resetsAt ? Date.parse(resetsAt) : NaN;
	if (!Number.isFinite(ms)) return { at: "—", left: "—" };
	const mins = Math.floor((ms - now) / 60_000);
	let left: string;
	if (ms <= now) left = "due";
	else if (mins < 1) left = "<1m";
	else if (mins < 60) left = `in ${mins}m`;
	else if (mins < 1440) left = `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
	else left = `in ${Math.floor(mins / 1440)}d ${Math.floor((mins % 1440) / 60)}h`;
	return { at: localTime(ms), left };
}

/** "12s ago", "3m ago", "2h ago", "4d ago". */
function formatAge(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s ago`;
	if (s < 3600) return `${Math.floor(s / 60)}m ago`;
	if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
	return `${Math.floor(s / 86400)}d ago`;
}

const LABEL_W = 20;

/** The /usage overlay: boxed, clamped to `width` columns and at most `maxLines` rows. */
function renderUsageScreen(
	theme: Theme,
	cache: CacheFile | undefined,
	width: number,
	maxLines: number,
	status: { refreshing: boolean; failure?: string },
): string[] {
	const now = Date.now();
	const dim = (s: string) => theme.fg("dim", s);
	const pct = (p: number) => theme.fg(severity(p), `${Math.round(p)}%`.padStart(4));
	const label = (s: string) => `${theme.fg("muted", truncateToWidth(s, LABEL_W - 1, "…", true))} `;
	const windowRow = (name: string, w: Window) => {
		const r = formatReset(w.resetsAt, now);
		const reset = r.at === "—" ? dim("resets —") : `${dim("resets")} ${r.left.padEnd(10)} ${dim(r.at)}`;
		return `${label(name)}${pct(w.pct)}   ${reset}`;
	};
	const note = (s: string, color: Color = "dim") => theme.fg(color, s);

	const body: string[] = [];
	const stale: string[] = [];
	/** One provider: header (+ detail, + stale/error mark like the footer's staleMark), then its rows. */
	const block = (name: string, detail: string | undefined, hasData: boolean, err: string | undefined, rows: string[]) => {
		let head = theme.bold(theme.fg("accent", name));
		if (detail) head += dim(` · ${detail}`);
		if (err && hasData) {
			head += theme.fg("warning", `  stale — last fetch failed: ${err}`);
			stale.push(name);
		}
		if (!hasData) rows = [err ? note(`error: ${err}`, "error") : note("no data yet")];
		body.push(head, ...rows.map((r) => `  ${r}`), "");
	};

	if (cache) {
		const { errors } = cache;

		const o = cache.ollama;
		const oRows: string[] = [];
		if (o?.state === "ok") oRows.push(windowRow("monthly", { pct: o.usedPct }));
		else if (o?.state === "nokey") oRows.push(note("no key"));
		else if (o?.state === "badkey") oRows.push(note("bad key", "warning"));
		else if (o?.state === "na") oRows.push(note("n/a"));
		block("Ollama Cloud", undefined, Boolean(o), errors.ollama, oRows);

		const x = cache.openai;
		const xRows: string[] = [];
		if (x?.state === "ok") {
			for (const w of x.windows) xRows.push(windowRow(w.label, w));
			if (x.limitReached) xRows.push(note("limit reached", "error"));
		} else if (x?.state === "nologin") xRows.push(note("not logged in"));
		else if (x?.state === "expired") xRows.push(note("auth expired (run pi /login)", "warning"));
		else if (x?.state === "na") xRows.push(note("n/a"));
		block("OpenAI Codex", x?.state === "ok" ? x.plan : undefined, Boolean(x), errors.openai, xRows);

		const c = cache.claude;
		const cRows: string[] = [];
		if (c?.state === "ok") {
			const shown = new Set<string>();
			const add = (name: string, w: Window | undefined) => {
				if (!w) return;
				cRows.push(windowRow(name, w));
				shown.add(name);
			};
			add("5h", c.fiveHour);
			add("7d", c.sevenDay);
			add("7d opus", c.sevenDayOpus);
			for (const l of c.limits ?? []) {
				const name = l.scope ? `${l.label} (${l.scope})` : l.label;
				if (shown.has(name)) continue;
				cRows.push(windowRow(name, l) + (l.active === false ? dim("  inactive") : ""));
				shown.add(name);
			}
			if (c.extraUsage?.enabled)
				cRows.push(`${label("extra usage")}${c.extraUsage.pct !== undefined ? pct(c.extraUsage.pct) : dim("  on")}`);
			if (!cRows.length) cRows.push(note("n/a"));
		} else if (c?.state === "nologin") cRows.push(note("not logged in"));
		else if (c?.state === "expired") cRows.push(note("auth expired (run claude /login)", "warning"));
		block("Claude", undefined, Boolean(c), errors.claude, cRows);

		const z = cache.zai;
		const zRows: string[] = [];
		if (z?.state === "ok") {
			if (z.fiveHour) zRows.push(windowRow(z.fiveHour.label, z.fiveHour));
			if (z.mcp)
				zRows.push(`${label("mcp")}${theme.fg(severity(z.mcp.pct), `${z.mcp.used}/${z.mcp.limit} (${Math.round(z.mcp.pct)}%)`)}`);
		} else if (z?.state === "nokey") zRows.push(note("no key"));
		else if (z?.state === "badkey") zRows.push(note("bad key", "warning"));
		else if (z?.state === "na") zRows.push(note("n/a"));
		block("Z.ai GLM Coding Plan", z?.state === "ok" ? z.level : undefined, Boolean(z), errors.zai, zRows);

		const d = cache.deepseek;
		const dRows: string[] = [];
		if (d?.state === "ok") {
			for (const b of d.balances) {
				const detail = [
					b.granted > 0 ? `Granted ${formatMoney(b.granted, b.currency)}` : undefined,
					b.toppedUp > 0 ? `Topped up ${formatMoney(b.toppedUp, b.currency)}` : undefined,
				].filter(Boolean);
				dRows.push(`${label("balance")}${formatMoney(b.total, b.currency)}${detail.length ? `   ${dim(detail.join(" · "))}` : ""}`);
			}
			if (!d.available) dRows.push(note("no credit — API calls fail until the balance is topped up", "warning"));
		} else if (d?.state === "nokey") dRows.push(note("no key"));
		else if (d?.state === "badkey") dRows.push(note("bad key", "warning"));
		else if (d?.state === "na") dRows.push(note("n/a"));
		block("DeepSeek", undefined, Boolean(d), errors.deepseek, dRows);
		body.pop(); // trailing blank
	} else body.push(note("usage loading… (no cached data yet)"));

	const head = [theme.bold(theme.fg("accent", "Subscription usage"))];
	let updated = cache ? `${dim("updated")} ${localTime(cache.fetchedAt, true)} ${dim(`(${formatAge(now - cache.fetchedAt)})`)}` : dim("never updated");
	if (cache) {
		const failed = (["ollama", "openai", "claude", "zai", "deepseek"] as const).filter((k) => cache.errors[k]).length;
		updated += failed ? theme.fg("warning", ` · ${failed} source${failed > 1 ? "s" : ""} failing${stale.length ? ` (stale: ${stale.join(", ")})` : ""}`) : dim(" · all sources ok");
	}
	if (status.refreshing) updated += theme.fg("accent", " · refreshing…");
	head.push(updated);
	if (status.failure) head.push(theme.fg("error", `refresh failed: ${status.failure}`));
	head.push("");
	const foot = ["", dim("r refresh · q/esc close")];

	// Keep the header and key hint; cut the provider blocks to fit the height budget.
	const boxed = width >= 8;
	const chrome = boxed ? 2 : 0;
	const room = maxLines - chrome - head.length - foot.length;
	const shown = body.length <= room ? body : room > 0 ? [...body.slice(0, room - 1), dim("… more (enlarge the terminal)")] : [];
	const content = [...head, ...shown, ...foot];

	if (!boxed) return content.map((l) => truncateToWidth(l, Math.max(1, width), "…")).slice(0, Math.max(1, maxLines));
	const b = (s: string) => theme.fg("border", s);
	const inner = width - 4;
	const lines = [
		b(`╭${"─".repeat(width - 2)}╮`),
		...content.map((l) => `${b("│")} ${truncateToWidth(l, inner, "…", true)} ${b("│")}`),
		b(`╰${"─".repeat(width - 2)}╯`),
	];
	return lines.length <= maxLines ? lines : [...lines.slice(0, Math.max(0, maxLines - 1)), lines[lines.length - 1]];
}

// ---------------------------------------------------------------------------
// Footer: a faithful copy of pi's built-in footer (modes/interactive/components/
// footer.js) with the usage segment injected into the stats line.

const INFO_TTL_MS = 2_000;

/** Same thresholds as pi's footer `formatTokens`. */
function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string): string {
	const rel = path.relative(path.resolve(HOME), path.resolve(cwd));
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${path.sep}${rel}`;
}

function sanitizeStatusText(text: string): string {
	return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function readJsonSync(file: string): any | undefined {
	try {
		return JSON.parse(fsSync.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/** Branch from .git/HEAD (following worktree `gitdir:` files); "detached" like pi. */
function readGitBranch(cwd: string): string | null {
	let dir = path.resolve(cwd);
	for (;;) {
		const dotGit = path.join(dir, ".git");
		try {
			let gitDir = dotGit;
			if (fsSync.statSync(dotGit).isFile()) {
				const m = /^gitdir:\s*(.+)$/m.exec(fsSync.readFileSync(dotGit, "utf8"));
				if (!m) return null;
				gitDir = path.resolve(dir, m[1].trim());
			}
			const head = fsSync.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
			const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
			return ref ? ref[1] : "detached";
		} catch (err: any) {
			if (err?.code !== "ENOENT") return null;
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

/** compaction.enabled from global + (trusted) project settings, default true, as pi's SettingsManager. */
function readAutoCompact(cwd: string, projectTrusted: boolean): boolean {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(HOME, ".pi/agent");
	const global = readJsonSync(path.join(agentDir, "settings.json"))?.compaction?.enabled;
	const project = projectTrusted ? readJsonSync(path.join(cwd, ".pi/settings.json"))?.compaction?.enabled : undefined;
	const enabled = typeof project === "boolean" ? project : global;
	return typeof enabled === "boolean" ? enabled : true;
}

/** Mirrors ModelRuntime.isUsingSubscription plus pi's kimi-coding special case. */
function isUsingSubscription(ctx: ExtensionContext, model: NonNullable<ExtensionContext["model"]>): boolean {
	if (model.provider === "kimi-coding") return true;
	try {
		return (
			ctx.modelRegistry.isUsingOAuth(model) &&
			(ctx.modelRegistry.getProvider(model.provider) as any)?.auth?.oauth?.isSubscription === true
		);
	} catch {
		return false;
	}
}

function ttl<T>(load: () => T): () => T {
	let at = 0;
	let value: T;
	return () => {
		if (Date.now() - at > INFO_TTL_MS) {
			value = load();
			at = Date.now();
		}
		return value;
	};
}

type FooterFactory = NonNullable<Parameters<ExtensionContext["ui"]["setFooter"]>[0]>;
type FooterData = Parameters<FooterFactory>[2];

function renderFooter(
	ctx: ExtensionContext,
	theme: Theme,
	footerData: FooterData | undefined,
	info: { branch: () => string | null; autoCompact: () => boolean },
	cache: CacheFile | undefined,
	width: number,
): string[] {
	const dim = (s: string) => theme.fg("dim", s);
	const sm = ctx.sessionManager;

	// Cumulative usage over ALL session entries (not just post-compaction).
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const add = (u: any) => {
		totals.input += u.input ?? 0;
		totals.output += u.output ?? 0;
		totals.cacheRead += u.cacheRead ?? 0;
		totals.cacheWrite += u.cacheWrite ?? 0;
		totals.cost += u.cost?.total ?? 0;
	};
	let latestCacheHitRate: number | undefined;
	for (const entry of sm.getEntries() as any[]) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const u = entry.message.usage;
			add(u);
			const prompt = u.input + u.cacheRead + u.cacheWrite;
			latestCacheHitRate = prompt > 0 ? (u.cacheRead / prompt) * 100 : undefined;
		} else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
			add(entry.message.usage);
		} else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
			add(entry.usage);
		}
	}

	const model = ctx.model;
	const contextUsage = ctx.getContextUsage();
	const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? 0;
	const contextPercentValue = contextUsage?.percent ?? 0;
	const contextPercent = contextUsage?.percent != null ? contextPercentValue.toFixed(1) : "?";

	// Line 1: pwd (branch) • session
	let pwd = formatCwd(ctx.cwd);
	const branch = footerData ? footerData.getGitBranch() : info.branch();
	if (branch) pwd = `${pwd} (${branch})`;
	const sessionName = sm.getSessionName();
	if (sessionName) pwd = `${pwd} • ${sessionName}`;

	// Line 2 left: stats. Plain segments are dimmed individually so the
	// self-colored ones (context %) never break, or get broken by, a dim wrap.
	const stats: string[] = [];
	if (totals.input) stats.push(dim(`↑${formatTokens(totals.input)}`));
	if (totals.output) stats.push(dim(`↓${formatTokens(totals.output)}`));
	if (totals.cacheRead) stats.push(dim(`R${formatTokens(totals.cacheRead)}`));
	if (totals.cacheWrite) stats.push(dim(`W${formatTokens(totals.cacheWrite)}`));
	if ((totals.cacheRead > 0 || totals.cacheWrite > 0) && latestCacheHitRate !== undefined)
		stats.push(dim(`CH${latestCacheHitRate.toFixed(1)}%`));
	const sub = model ? isUsingSubscription(ctx, model) : false;
	if (totals.cost || sub) stats.push(dim(`$${totals.cost.toFixed(3)}${sub ? " (sub)" : ""}`));
	const auto = info.autoCompact() ? " (auto)" : "";
	const ctxText = `${contextPercent === "?" ? "?" : `${contextPercent}%`}/${formatTokens(contextWindow)}${auto}`;
	stats.push(
		contextPercentValue > 90
			? theme.fg("error", ctxText)
			: contextPercentValue > 70
				? theme.fg("warning", ctxText)
				: dim(ctxText),
	);
	if (process.env.PI_EXPERIMENTAL === "1") stats.push(`${dim("•")} ${theme.bold(theme.fg("warning", "xp"))}`);
	let statsLeft = stats.join(" ");

	// Line 2 right: (provider) model • thinking
	const modelName = model?.id || "no-model";
	let rightNoProvider = modelName;
	if (model?.reasoning) {
		const level = ctx.thinkingLevel || "off";
		rightNoProvider = level === "off" ? `${modelName} • thinking off` : `${modelName} • ${level}`;
	}
	const providerCount = footerData?.getAvailableProviderCount() ?? 0;
	const rightWithProvider = providerCount > 1 && model ? `(${model.provider}) ${rightNoProvider}` : undefined;

	const GAP = 2;
	const statsW = visibleWidth(statsLeft);
	const layout = (usage: string, right: string) => {
		const pad = " ".repeat(width - statsW - GAP - visibleWidth(usage) - visibleWidth(right));
		return statsLeft + " ".repeat(GAP) + usage + pad + dim(right);
	};
	const fits = (usage: string, right: string) =>
		statsW + GAP + visibleWidth(usage) + GAP + visibleWidth(right) <= width;

	// Degrade: full labels → compact labels → drop provider.
	const right = rightWithProvider ?? rightNoProvider;
	const candidates: [number, string][] = [
		[1, right],
		[0, right],
		[0, rightNoProvider],
	];
	let statsLine: string | undefined;
	for (const [level, r] of candidates) {
		const usage = buildUsage(theme, cache, level);
		if (fits(usage, r)) {
			statsLine = layout(usage, r);
			break;
		}
	}
	if (statsLine === undefined) {
		// Squeeze the compact usage into whatever room is left before the model.
		const room = width - statsW - GAP - GAP - visibleWidth(rightNoProvider);
		if (room >= 8) statsLine = layout(truncateToWidth(buildUsage(theme, cache, 0), room, dim("…")), rightNoProvider);
	}
	if (statsLine === undefined) {
		// Built-in behavior: truncate stats first, then the right side.
		let leftW = statsW;
		if (leftW > width) {
			statsLeft = truncateToWidth(statsLeft, width, dim("..."));
			leftW = visibleWidth(statsLeft);
		}
		const avail = width - leftW - GAP;
		if (avail > 0) {
			const right = truncateToWidth(rightNoProvider, avail, "");
			statsLine = statsLeft + " ".repeat(Math.max(0, width - leftW - visibleWidth(right))) + dim(right);
		} else statsLine = statsLeft;
	}

	const lines = [truncateToWidth(dim(pwd), width, dim("...")), statsLine];

	// Line 3: other extensions' setStatus() texts, as the built-in footer does.
	const statuses = footerData?.getExtensionStatuses();
	if (statuses && statuses.size > 0) {
		const line = Array.from(statuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => sanitizeStatusText(text))
			.join(" ");
		lines.push(truncateToWidth(line, width, dim("...")));
	}
	return lines;
}

/** Footer factory; reads live ctx data and the latest usage cache on every render. */
function createFooter(ctx: ExtensionContext, getCache: () => CacheFile | undefined, onTui?: (tui: TUI, disposed: boolean) => void): FooterFactory {
	return (tui, theme, footerData) => {
		onTui?.(tui, false);
		const info = {
			branch: ttl(() => readGitBranch(ctx.cwd)),
			autoCompact: ttl(() => readAutoCompact(ctx.cwd, ctx.isProjectTrusted())),
		};
		const unsubscribe = footerData?.onBranchChange(() => tui.requestRender());
		let lastLines: string[] = [];
		return {
			render(width: number): string[] {
				try {
					lastLines = renderFooter(ctx, theme, footerData, info, getCache(), width);
				} catch {
					// ctx went stale mid-teardown: keep the previous frame
				}
				return lastLines;
			},
			invalidate() {},
			dispose() {
				unsubscribe?.();
				onTui?.(tui, true);
			},
		};
	};
}

// ---------------------------------------------------------------------------
// Extension

export default function (pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let activeCtx: ExtensionContext | undefined;
	let footerTui: TUI | undefined;
	let generation = 0;
	let lastCache: CacheFile | undefined;
	let inflight: Promise<void> | undefined;

	const show = (gen: number) => {
		if (activeCtx && gen === generation) footerTui?.requestRender();
	};
	/**
	 * Render from the shared cache, fetching only if it is stale and we win
	 * the lock. With force, bypass freshness but still take the lock.
	 * Throws only for `force` so the command can report it.
	 */
	async function refreshOnce(force: boolean): Promise<void> {
		const gen = generation;
		const result = await refreshCache(force, lastCache, {
			onCache: (cache) => (lastCache = cache),
			onShow: () => show(gen),
			cancelled: () => gen !== generation,
		});
		if (force && result?.fetched) {
			const failed = describeErrors(result.errors);
			if (failed) throw new Error(failed);
		}
	}

	function refresh(force = false): Promise<void> {
		if (inflight && !force) return inflight;
		const run = (inflight ?? Promise.resolve()).then(() => refreshOnce(force));
		const tracked = run
			.catch(() => {})
			.finally(() => {
				if (inflight === tracked) inflight = undefined;
			});
		inflight = tracked;
		return force ? run : tracked;
	}

	/** Force refresh as /usage-refresh does; reports and returns the failure, if any. */
	async function forceRefresh(ctx: ExtensionContext): Promise<string | undefined> {
		try {
			await refresh(true);
			return undefined;
		} catch (err) {
			ctx.ui.notify(`usage-refresh: ${errMessage(err)}`, "error");
			return errMessage(err);
		}
	}

	function stop(): void {
		generation++;
		if (timer) clearInterval(timer);
		timer = undefined;
		if (activeCtx) {
			try {
				activeCtx.ui.setFooter(undefined);
			} catch {
				// UI may already be torn down
			}
		}
		activeCtx = undefined;
	}

	pi.on("session_start", async (_event, ctx) => {
		stop();
		if (ctx.mode !== "tui") return;
		activeCtx = ctx;
		ctx.ui.setFooter(
			createFooter(
				ctx,
				() => lastCache,
				(tui, disposed) => {
					if (!disposed) footerTui = tui;
					else if (footerTui === tui) footerTui = undefined;
				},
			),
		);
		void refresh();
		timer = setInterval(() => void refresh(), TICK_MS);
		timer.unref?.();
	});

	pi.on("agent_settled", async () => {
		if (activeCtx) void refresh();
	});

	pi.on("session_shutdown", async () => {
		stop();
	});

	pi.registerCommand("usage-refresh", {
		description: "Force-refresh Ollama Cloud / OpenAI Codex / Claude / Z.ai / DeepSeek usage (footer and /usage screen)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !activeCtx) return;
			await forceRefresh(ctx);
		},
	});

	pi.registerCommand("usage", {
		description: "Show Ollama Cloud / OpenAI Codex / Claude / Z.ai / DeepSeek usage detail with reset times and balances",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("The /usage screen requires Pi's interactive TUI.", "warning");
				return;
			}
			await ctx.ui.custom<null>(
				(tui, theme, _keys, done) => {
					const status: { refreshing: boolean; failure?: string } = { refreshing: false };
					let closed = false;
					const rerender = () => {
						if (!closed) tui.requestRender();
					};
					const rows = () => {
						const r = tui.terminal?.rows;
						return typeof r === "number" && r > 0 ? r : 40;
					};
					// Adopt a newer shared cache (fetches only if it is stale and we win the lock).
					void refresh().then(rerender);
					return {
						// Reads the live cache on every render, so refreshes show in place.
						render: (width: number) => renderUsageScreen(theme, lastCache, width, Math.floor(rows() * 0.9), status),
						handleInput(data: string) {
							if (matchesKey(data, "q") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
								closed = true;
								done(null);
							} else if (matchesKey(data, "r") && !status.refreshing) {
								status.refreshing = true;
								status.failure = undefined;
								rerender();
								void forceRefresh(ctx).then((failure) => {
									status.refreshing = false;
									status.failure = failure;
									rerender();
								});
							}
						},
						invalidate() {},
						dispose() {
							closed = true;
						},
					};
				},
				{ overlay: true, overlayOptions: { anchor: "center", width: "80%", maxHeight: "90%" } },
			);
		},
	});
}
