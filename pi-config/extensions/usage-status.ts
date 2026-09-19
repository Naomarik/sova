// usage-status: shows Ollama Cloud, OpenAI Codex and Claude subscription usage in
// pi's footer.
//
// Takes over the footer with ctx.ui.setFooter() (a faithful copy of the built-in
// one) so the usage segment can sit on the stats line next to the token stats.
//
// Refreshes are rate-limited machine-wide through a shared cache file plus an
// O_EXCL lockfile, so only one pi process fetches per ~3 minutes no matter how
// many sessions are open. Credential files are only ever read, never written.

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const HOME = os.homedir();
const PI_AUTH = path.join(HOME, ".pi/agent/auth.json"); // ollama-cloud key + openai-codex oauth
const CODEX_AUTH = path.join(HOME, ".codex/auth.json");
const CLAUDE_CREDS = path.join(HOME, ".claude/.credentials.json");
const CACHE_DIR = path.join(HOME, ".pi/agent/cache");
const CACHE_FILE = path.join(CACHE_DIR, "usage-status.json");
const LOCK_FILE = `${CACHE_FILE}.lock`;

const TICK_MS = 180_000; // per-session check cadence
const FRESH_MS = 150_000; // cache younger than this is used without fetching
const FAILURE_RETRY_MS = 60_000; // retry floor after a failed fetch
const LOCK_STALE_MS = 30_000; // lock older than this is considered abandoned
const FETCH_TIMEOUT_MS = 10_000;
const FORCE_WAIT_MS = 12_000; // /usage-refresh waits this long for another holder

// ---------------------------------------------------------------------------
// Normalized data (this is what goes into the shared cache; no secrets)

type OllamaData =
	| { state: "ok"; usedPct: number }
	| { state: "nokey" }
	| { state: "badkey" }
	| { state: "na" };

interface Window {
	pct: number;
	resetsAt?: string;
}

type ClaudeData =
	| { state: "ok"; fiveHour?: Window; sevenDay?: Window; sevenDayOpus?: Window }
	| { state: "nologin" }
	| { state: "expired" };

type OpenAiData =
	| { state: "ok"; windows: { label: string; pct: number }[] }
	| { state: "nologin" }
	| { state: "expired" }
	| { state: "na" };

interface CacheFile {
	fetchedAt: number;
	nextFetchAt: number;
	ollama?: OllamaData;
	openai?: OpenAiData;
	claude?: ClaudeData;
	errors: { ollama?: string; openai?: string; claude?: string };
}

// ---------------------------------------------------------------------------
// Fetchers

async function readJson(file: string): Promise<any | undefined> {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch {
		return undefined;
	}
}

async function fetchOllama(): Promise<OllamaData> {
	const auth = await readJson(PI_AUTH);
	const key = auth?.["ollama-cloud"]?.key;
	if (typeof key !== "string" || !key) return { state: "nokey" };

	const res = await fetch("https://ollama.com/api/usage", {
		headers: { Authorization: `Bearer ${key}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (res.status === 401 || res.status === 403) return { state: "badkey" };
	if (!res.ok) throw new Error(`ollama HTTP ${res.status}`);

	const body: any = await res.json();
	const usage = body?.limits?.monthly?.usage;
	if (typeof usage !== "number" || !Number.isFinite(usage)) return { state: "na" };
	return { state: "ok", usedPct: usage * 100 };
}

async function fetchOpenAi(): Promise<OpenAiData> {
	// pi's own oauth entry first (pi keeps it refreshed), then the Codex CLI's.
	const pi = (await readJson(PI_AUTH))?.["openai-codex"];
	let token = pi?.access;
	let accountId = pi?.accountId;
	if (typeof token !== "string" || !token) {
		const codex = (await readJson(CODEX_AUTH))?.tokens;
		token = codex?.access_token;
		accountId = codex?.account_id;
	}
	if (typeof token !== "string" || !token) return { state: "nologin" };

	const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
	if (typeof accountId === "string" && accountId) headers["ChatGPT-Account-Id"] = accountId;
	const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
		headers,
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (res.status === 401 || res.status === 403) return { state: "expired" };
	if (!res.ok) throw new Error(`openai HTTP ${res.status}`);

	const body: any = await res.json();
	const limits = body?.rate_limit;
	if (!limits || typeof limits !== "object") return { state: "na" };
	const windows: { label: string; pct: number }[] = [];
	const add = (w: any, label: string) => {
		if (w && typeof w.used_percent === "number" && Number.isFinite(w.used_percent)) windows.push({ label, pct: w.used_percent });
	};
	const secs = limits.primary_window?.limit_window_seconds;
	const near = (target: number) => typeof secs === "number" && Math.abs(secs - target) <= target * 0.05;
	add(limits.secondary_window, "5h");
	add(limits.primary_window, near(604_800) ? "7d" : near(18_000) ? "5h" : "pri");
	windows.sort((a, b) => (a.label === "5h" ? -1 : b.label === "5h" ? 1 : 0)); // 5h before 7d, like claude
	return windows.length ? { state: "ok", windows } : { state: "na" };
}

function toWindow(section: any): Window | undefined {
	if (!section || typeof section.utilization !== "number") return undefined;
	return {
		pct: section.utilization,
		resetsAt: typeof section.resets_at === "string" ? section.resets_at : undefined,
	};
}

async function fetchClaude(): Promise<ClaudeData> {
	const creds = await readJson(CLAUDE_CREDS);
	const token = creds?.claudeAiOauth?.accessToken;
	if (typeof token !== "string" || !token) return { state: "nologin" };

	const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
		headers: {
			Authorization: `Bearer ${token}`,
			"anthropic-beta": "oauth-2025-04-20",
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (res.status === 401) return { state: "expired" };
	if (!res.ok) throw new Error(`claude HTTP ${res.status}`);

	const body: any = await res.json();
	return {
		state: "ok",
		fiveHour: toWindow(body?.five_hour),
		sevenDay: toWindow(body?.seven_day),
		sevenDayOpus: toWindow(body?.seven_day_opus),
	};
}

function errMessage(err: unknown): string {
	if (err instanceof Error) {
		if (err.name === "TimeoutError" || err.name === "AbortError") return "timeout";
		return err.message;
	}
	return String(err);
}

// ---------------------------------------------------------------------------
// Shared cache + cross-process lock

function isCacheFile(v: any): v is CacheFile {
	return v && typeof v === "object" && typeof v.fetchedAt === "number" && typeof v.errors === "object";
}

async function readCache(): Promise<CacheFile | undefined> {
	const data = await readJson(CACHE_FILE); // missing or corrupt -> undefined
	if (!isCacheFile(data)) return undefined;
	if (typeof data.nextFetchAt !== "number") data.nextFetchAt = data.fetchedAt + FRESH_MS;
	// Cache written before the openai source existed: refetch once.
	if (!data.openai && !data.errors.openai) data.nextFetchAt = 0;
	return data;
}

async function writeCache(data: CacheFile): Promise<void> {
	await fs.mkdir(CACHE_DIR, { recursive: true });
	const tmp = `${CACHE_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		await fs.writeFile(tmp, JSON.stringify(data), "utf8");
		await fs.rename(tmp, CACHE_FILE);
	} catch (err) {
		await fs.unlink(tmp).catch(() => {});
		throw err;
	}
}

function pidAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err: any) {
		return err?.code === "EPERM";
	}
}

/** Returns a release function if the lock was acquired, otherwise undefined. */
async function acquireLock(): Promise<(() => Promise<void>) | undefined> {
	await fs.mkdir(CACHE_DIR, { recursive: true });
	const token = `${process.pid}-${randomBytes(6).toString("hex")}`;
	const content = JSON.stringify({ pid: process.pid, ts: Date.now(), token });

	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const fh = await fs.open(LOCK_FILE, "wx");
			try {
				await fh.writeFile(content, "utf8");
			} finally {
				await fh.close();
			}
			return async () => {
				// Only remove the lock if it is still ours.
				try {
					const current = await fs.readFile(LOCK_FILE, "utf8");
					if (current === content) await fs.unlink(LOCK_FILE);
				} catch {
					// already gone
				}
			};
		} catch (err: any) {
			if (err?.code !== "EEXIST") throw err;
		}

		if (attempt > 0 || !(await breakStaleLock())) return undefined;
	}
	return undefined;
}

/** Removes the lock if abandoned. Returns true if it was removed. */
async function breakStaleLock(): Promise<boolean> {
	let raw: string;
	let mtimeMs: number;
	try {
		raw = await fs.readFile(LOCK_FILE, "utf8");
		mtimeMs = (await fs.stat(LOCK_FILE)).mtimeMs;
	} catch (err: any) {
		return err?.code === "ENOENT"; // vanished meanwhile -> retry
	}

	let info: any;
	try {
		info = JSON.parse(raw);
	} catch {
		info = undefined; // half-written or garbage: rely on mtime only
	}
	const ts = typeof info?.ts === "number" ? info.ts : mtimeMs;
	const abandoned = Date.now() - ts > LOCK_STALE_MS || (info && !pidAlive(info.pid));
	if (!abandoned) return false;

	// Move it aside atomically so only one process wins, then make sure we
	// moved the stale lock and not a fresh one created in between.
	const aside = `${LOCK_FILE}.stale.${process.pid}.${randomBytes(4).toString("hex")}`;
	try {
		await fs.rename(LOCK_FILE, aside);
	} catch {
		return false;
	}
	try {
		const moved = await fs.readFile(aside, "utf8");
		if (moved !== raw) {
			// Someone else's fresh lock: put it back without clobbering.
			await fs.link(aside, LOCK_FILE).catch(() => {});
			return false;
		}
		return true;
	} finally {
		await fs.unlink(aside).catch(() => {});
	}
}

async function fetchAll(prev: CacheFile | undefined): Promise<CacheFile> {
	const [o, x, c] = await Promise.allSettled([fetchOllama(), fetchOpenAi(), fetchClaude()]);
	const now = Date.now();
	const errors: CacheFile["errors"] = {};
	let ollama = prev?.ollama;
	let openai = prev?.openai;
	let claude = prev?.claude;
	if (o.status === "fulfilled") ollama = o.value;
	else errors.ollama = errMessage(o.reason);
	if (x.status === "fulfilled") openai = x.value;
	else errors.openai = errMessage(x.reason);
	if (c.status === "fulfilled") claude = c.value;
	else errors.claude = errMessage(c.reason);

	const failed = Boolean(errors.ollama || errors.openai || errors.claude);
	return {
		fetchedAt: now,
		nextFetchAt: now + (failed ? FAILURE_RETRY_MS : FRESH_MS),
		ollama,
		openai,
		claude,
		errors,
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Rendering

type Color = Parameters<Theme["fg"]>[0];

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

	return `${dim("⛁")} ${ollama}${sep}${openai}${sep}${claude}`;
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
		const cached = await readCache();
		if (cached) lastCache = cached;
		if (!force && cached && Date.now() < cached.nextFetchAt) return show(gen);

		const release = await acquireLock();
		if (!release) {
			// Another session is fetching: don't fetch, just wait (file reads
			// only) for it to publish a newer cache, and adopt that.
			show(gen);
			const since = cached?.fetchedAt ?? 0;
			const deadline = Date.now() + FORCE_WAIT_MS;
			while (Date.now() < deadline && gen === generation) {
				await sleep(250);
				const after = await readCache();
				if (after && after.fetchedAt > since) {
					lastCache = after;
					return show(gen);
				}
			}
			if (force) throw new Error("another session holds the refresh lock; showing cached data");
			return; // try again on the next tick
		}

		try {
			// Double-check: another process may have refreshed before we got the lock.
			const latest = (await readCache()) ?? lastCache;
			if (!force && latest && Date.now() < latest.nextFetchAt) {
				lastCache = latest;
				return;
			}
			const next = await fetchAll(latest);
			lastCache = next;
			await writeCache(next);
			if (force && (next.errors.ollama || next.errors.openai || next.errors.claude)) {
				const msgs = [
					next.errors.ollama && `ollama: ${next.errors.ollama}`,
					next.errors.openai && `openai: ${next.errors.openai}`,
					next.errors.claude && `claude: ${next.errors.claude}`,
				];
				throw new Error(msgs.filter(Boolean).join("; "));
			}
		} finally {
			await release();
			show(gen);
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
		description: "Force-refresh Ollama Cloud / Claude usage in the footer",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !activeCtx) return;
			try {
				await refresh(true);
			} catch (err) {
				ctx.ui.notify(`usage-refresh: ${errMessage(err)}`, "error");
			}
		},
	});
}
