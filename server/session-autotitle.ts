import { appendFileSync, createReadStream, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { stripImageNotes } from "../shared/image-note";
import { isLinkMessage } from "../shared/link-message";
import { isTopicBatch } from "../shared/topic-message";
import { SESSION_TITLE_LABEL_MAX, type AutoTitleOutcome, type AutoTitleSkip, type DecisionFailure, type SessionSummary, type SessionTitleSettings, type WorkerChoice } from "../shared/protocol";
import { parseWakeNudge } from "../shared/wake";
import { DecisionError, extractJsonObject, failureMessage } from "./decide";
import { claudeRun, LLM_TIMEOUT_MS, parseClaudeEnvelope, piText, type LlmProviderDeps } from "./decide-llm";
import { cleanSessionTitle, readSessionTitleRecords, replaceAutoTitle, type StoredTitle, writeAutoTitle } from "./session-titles";
import { withUsageContext } from "../pi-config/extensions/llm-inflight/attribution.ts";

// Sova names sessions itself (§app.session-list/auto-titles): one short title per session from
// what it became, stored as an `auto` title in Sova's own title store — never in the .jsonl, and
// never over an explicit title automatically (a user's, the Overseer's, or any pre-provenance
// one). Four ways in: the background sweep (on by default, Settings → Summaries → Session titles),
// the section heads' button (POST /api/sessions/auto-title), Settings' Shorten long titles
// (POST /api/sessions/shorten-titles: long auto, Overseer and pre-provenance titles, never a
// typed one) and an open session's Regenerate title (the auto-title route with `redo`: any title
// of that one session). All go through `nameSession` below.

/**
 * The title rules, and the whole system prompt: no Sova or agent prompt goes with them. Judged
 * against hand-written ideal titles for 55 real sessions on deepseek-v4.1-flash: the subject the
 * whole session is about, never the summary line again, releases told apart by what landed.
 */
export const TITLE_SYSTEM_PROMPT = `You name a coding-agent chat session for a narrow sidebar list. Reply with one JSON object only: {"title": "..."}
Each row shows the title, then the session's summary line under it. The title is the label the user scans and searches for; the summary line already explains it.
- Name the subject the whole session is about: the thing built, fixed or decided. The first message usually names it in the user's words; topics show where it went. Later topics are often follow-ups: don't title a late side topic or a single step.
- Add what the summary line lacks. Never reuse its wording or its first words. Use the user's own name for the thing, or the concrete cause, mechanism, model or round.
- A subject, never a status: no merged, shipped, landed, done, restart; no counts or commit ids.
- Merges, releases, pushes: name the first one or two branches or features that landed (from the first message or topics). Never only "branches", "merge", "release", "push", "fast-forward" or "restart".
- A rerun, round or repeat of earlier work: say which one (round 2, the model it ran on).
- Use the user's nouns (feature, branch, project, tool names). No generic words: feature, work, changes, session, investigation, process.
- 2 to 5 words, at most 36 characters; count them (a number or hyphenated word counts as one word). Four words is usually enough. Sentence case noun phrase. No "X: Y", lists, parentheses, quotes or trailing period. Never name Sova.
Examples (summary line → title):
"Merging two branches into master, then a restart" → "Push badges and voice merge"
"Fixing usage monitor percentages" → "Claude meter stuck at 100%"
"Scroll position lost when switching sessions" → "Queued-message scroll jump"`;

/** The sidebar's title line holds about 32 characters; a title is a label that fits it. */
export const TITLE_MAX_CHARS = SESSION_TITLE_LABEL_MAX;
export const TITLE_WORDS = { min: 2, max: 5 } as const;
export const FIRST_MESSAGE_MAX = 600;
export const MAX_BULLETS = 2;
export const CLAUDE_TITLE_BUDGET_USD = 0.05;

// ── Input ─────────────────────────────────────────────────────────────────────────────────────

/** What a title is made from. Never the session's current title. */
export interface TitleInput {
  /** The first 3 user messages that are the user's own words (not a wake nudge or a link message). */
  userMessages: string[];
  /** The last topic-outline snapshot's `overall` line (the sidebar's summary line), if any. */
  summaryLine?: string;
  /** That snapshot's topics: each heading and its first bullets. */
  topics: { heading: string; bullets: string[] }[];
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const b of content) if (b?.type === "text" && typeof b.text === "string") return stripImageNotes(b.text, content);
  }
  return "";
}

/** A user message that is not the user's own words: the derived title's rule (sessions-index.ts). */
const notUsers = (text: string): boolean => parseWakeNudge(text) !== null || isLinkMessage(text) || isTopicBatch(text);

/** One topic-outline entry's data as a title input: its summary line and topics, or null when it has none. */
export function outlineOf(data: unknown): Pick<TitleInput, "summaryLine" | "topics"> | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { now?: unknown; overall?: unknown; topics?: unknown };
  // The index's rule (scanOutline): a snapshot counts when its "now" line reads.
  if (typeof d.now !== "string" || !d.now.trim()) return null;
  const summaryLine = typeof d.overall === "string" && d.overall.trim() ? oneLine(d.overall) : undefined;
  const topics: TitleInput["topics"] = [];
  if (Array.isArray(d.topics)) {
    for (const t of d.topics) {
      const heading = typeof t?.heading === "string" ? oneLine(t.heading) : "";
      if (!heading) continue;
      const bullets = Array.isArray(t.summary) ? t.summary.filter((b: unknown): b is string => typeof b === "string" && !!b.trim()).slice(0, MAX_BULLETS).map(oneLine) : [];
      topics.push({ heading, bullets });
    }
  }
  return { ...(summaryLine ? { summaryLine } : {}), topics };
}

/**
 * Read a session file for its title input: its first 3 user messages and its LAST readable
 * topic-outline snapshot. Line by line, never the whole file in memory; a line that isn't JSON is
 * skipped. Reads only — the file is never opened for writing.
 */
export async function readTitleInput(path: string): Promise<TitleInput> {
  const out: TitleInput = { userMessages: [], topics: [] };
  const rl = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    const user = out.userMessages.length < 3 && line.includes('"role":"user"');
    const outline = line.includes('"topic-outline"');
    if (!user && !outline) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (user && e?.type === "message" && e.message?.role === "user") {
      const text = oneLine(userText(e.message.content));
      if (text && !notUsers(text)) out.userMessages.push(text);
    } else if (outline && e?.type === "custom" && e.customType === "topic-outline") {
      const o = outlineOf(e.data);
      if (o) {
        out.summaryLine = o.summaryLine;
        out.topics = o.topics;
      }
    }
  }
  return out;
}

/**
 * The user message of the title call. With a summary line: the summary line, labelled as what the
 * row already shows (so the title won't repeat it), the topics in order with their first bullets,
 * then the first message (≤600 characters). Without one: the first 3 user messages. Pure; its
 * argument has no field for the current title, so none can reach the model.
 */
export function buildTitlePrompt(input: TitleInput): string {
  if (input.summaryLine) {
    const lines = ["SUMMARY LINE (already shown under the title; do not repeat it):", input.summaryLine];
    if (input.topics.length) {
      lines.push("", "TOPICS (in order):");
      for (const t of input.topics) {
        lines.push(`- ${t.heading}`);
        for (const b of t.bullets) lines.push(`  - ${b}`);
      }
    }
    lines.push("", "FIRST MESSAGE (what the user came for; the session may have moved on):", cut(input.userMessages[0] ?? "", FIRST_MESSAGE_MAX));
    return lines.join("\n");
  }
  const lines = ["FIRST MESSAGES:"];
  input.userMessages.slice(0, 3).forEach((m, i) => lines.push(`${i + 1}. ${cut(m, FIRST_MESSAGE_MAX)}`));
  return lines.join("\n");
}

/**
 * A model's `title` as the store will keep it, or null: a string that, with wrapping quotes and a
 * trailing period dropped and cleaned like a typed title, is 2–5 words and ≤36 characters. Pure.
 */
export function validateTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let t = raw.replace(/\s+/g, " ").trim();
  const quoted = /^(["'“‘`])(.*)(["'”’`])$/.exec(t);
  if (quoted) t = quoted[2]!.trim();
  t = t.replace(/\.$/, "").trim();
  const clean = cleanSessionTitle(t);
  if (!clean || clean.length > TITLE_MAX_CHARS) return null;
  const words = countWords(clean);
  return words >= TITLE_WORDS.min && words <= TITLE_WORDS.max ? clean : null;
}

const countWords = (t: string) => t.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/**
 * The one corrective ask after a reply with no usable title: the same input, then why the answer
 * was refused (its length in words and characters, or that no title came back). Pure.
 */
export function retryTitlePrompt(prompt: string, raw: unknown): string {
  const t = typeof raw === "string" ? oneLine(raw) : "";
  const why = t ? `"${cut(t, 80)}" is ${countWords(t)} words and ${t.length} characters` : "no title came back";
  return `${prompt}\n\nYOUR LAST ANSWER WAS NOT USABLE: ${why}. Reply again with one JSON object {"title": "..."}: 2 to 5 words, at most 36 characters.`;
}

// ── The model call ────────────────────────────────────────────────────────────────────────────

/** Claude Code's argv for a title: the rules as the whole system prompt, no tools, no settings, no MCP, NO --json-schema. Pure. */
export function titleClaudeArgs(choice: WorkerChoice): string[] {
  return [
    "-p",
    "--model", choice.model,
    "--tools", "",
    "--setting-sources", "",
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--no-session-persistence",
    "--output-format", "json",
    "--max-budget-usd", CLAUDE_TITLE_BUDGET_USD.toFixed(2),
    "--system-prompt", TITLE_SYSTEM_PROMPT,
    ...(choice.effort ? ["--effort", choice.effort] : []),
  ];
}

export interface TitleDeps extends LlmProviderDeps {
  /** Why this model can't run at all right now (policy, registry, auth, CLI), or null. */
  problem?: (choice: WorkerChoice) => Promise<string | null>;
  /** Every request as it leaves: the provider payload (pi) or the argv and stdin (Claude Code). */
  trace?: (entry: { model: string; payload: unknown }) => void;
}

/**
 * One pi title ask's deadline. A title reply takes about 1–3 s (p99 under 9 s over 440 calls on
 * deepseek-v4.1-flash); a rare provider stall ran past 45 s, so a stalled ask is cut here and asked
 * once more (titleFromChain), in less time than the old single 45 s wait. Claude Code keeps
 * LLM_TIMEOUT_MS: its CLI start-up alone takes seconds.
 */
export const TITLE_PI_TIMEOUT_MS = 20_000;

/** One title model, one ask: the parsed `title` field of its JSON reply (unvalidated). */
export async function callTitleModel(choice: WorkerChoice, prompt: string, deps: TitleDeps): Promise<unknown> {
  const timeoutMs = deps.timeoutMs ?? (choice.backend === "pi" ? TITLE_PI_TIMEOUT_MS : LLM_TIMEOUT_MS);
  const fail = (failure: DecisionFailure, message: string) => new DecisionError(failure, message.slice(0, 300));
  const denied = deps.denial?.(choice);
  if (denied) throw fail("unavailable", denied);
  let text: string;
  if (choice.backend === "pi") {
    const traced: LlmProviderDeps = deps.trace ? { ...deps, onPayload: (payload) => deps.trace!({ model: `pi/${choice.model}`, payload }) } : deps;
    text = (await piText(choice, { systemPrompt: TITLE_SYSTEM_PROMPT, prompt, maxTokens: (reasoning) => (reasoning ? 4096 : 2048) }, traced, timeoutMs, fail)).text;
    return (extractJsonObject(text) as { title?: unknown } | null)?.title;
  }
  const argv = titleClaudeArgs(choice);
  deps.trace?.({ model: `claude-code/${choice.model}`, payload: { argv, stdin: prompt } });
  const stdout = await claudeRun(argv, prompt, deps, timeoutMs, fail);
  return ((parseClaudeEnvelope(stdout, fail).json as { title?: unknown } | null) ?? {}).title;
}

/** Failures that mean "stop asking for a while", not "this session's input was odd". */
const BACKOFF: readonly DecisionFailure[] = ["quota", "rate-limit", "auth"];

export type ChainResult = { title: string } | { failure: "no-model" | "failed"; detail: string; backoff: boolean };

/**
 * The primary, then the fallback. Each is asked at most twice: a reply with no usable title (empty,
 * no JSON, or a title the validator refuses) is asked once more with the reason (retryTitlePrompt),
 * a timed-out ask once more as it was; any other error is not retried. A model that can't run at all (deps.problem) is skipped without a
 * call. `backoff` when every model that was tried failed for quota, a rate limit or auth.
 */
export async function titleFromChain(settings: Pick<SessionTitleSettings, "primary" | "fallback">, prompt: string, deps: TitleDeps): Promise<ChainResult> {
  const slots = settings.fallback ? [settings.primary, settings.fallback] : [settings.primary];
  const why: string[] = [];
  let tried = 0;
  let backoffs = 0;
  for (const choice of slots) {
    const label = `${choice.backend === "pi" ? "pi" : "Claude Code"} · ${choice.model}`;
    const problem = await deps.problem?.(choice);
    if (problem) {
      why.push(`${label}: ${problem}`);
      continue;
    }
    tried++;
    try {
      let title: string | null = null;
      let ask = prompt;
      for (let attempt = 0; attempt < 2 && !title; attempt++) {
        let raw: unknown;
        try {
          raw = await callTitleModel(choice, ask, deps);
        } catch (err) {
          // An empty or unparsable reply gets the corrective ask, a timed-out one the same ask
          // again; any other failure (quota, rate limit, auth, unavailable) is not retried.
          const failure = err instanceof DecisionError ? err.failure : undefined;
          if (attempt > 0 || (failure !== "malformed-answer" && failure !== "timeout")) throw err;
          if (failure === "timeout") continue;
        }
        title = validateTitle(raw);
        ask = retryTitlePrompt(prompt, raw);
      }
      if (title) return { title };
      why.push(`${label}: no usable title in the reply`);
    } catch (err) {
      if (err instanceof DecisionError && BACKOFF.includes(err.failure)) backoffs++;
      why.push(`${label}: ${failureMessage(err)}`);
    }
  }
  if (tried === 0) return { failure: "no-model", detail: why.join("; "), backoff: false };
  return { failure: "failed", detail: why.join("; "), backoff: backoffs === tried };
}

// ── One session ───────────────────────────────────────────────────────────────────────────────

export interface NameDeps extends TitleDeps {
  settings: () => SessionTitleSettings;
  summary: (path: string) => Promise<SessionSummary | null>;
  input?: (path: string) => Promise<TitleInput>;
  /** The session's stored title entry right now (a fresh read), for the redo and shorten writes. */
  stored?: (id: string) => StoredTitle | undefined;
  now?: () => number;
}

/**
 * How a session is being named. "sweep": no stored title at all, from its summary line. "button":
 * no explicit title (may redo an auto one). "shorten": a stored title longer than TITLE_MAX_CHARS
 * set by the namer, the Overseer or before provenance — never a typed one. "regenerate": an open
 * session's own button, any title at all (the press is the explicit request).
 */
export type NameMode = "button" | "sweep" | "shorten" | "regenerate";

/** May Shorten long titles rename this stored title? Long, and never typed by hand. Pure. */
export function shortenable(t: StoredTitle | undefined): boolean {
  return !!t && t.title.length > TITLE_MAX_CHARS && (t.by !== "user" || t.legacy === true);
}

/** Why the button won't name this session, before any model call, or null. Pure. */
export function buttonSkip(s: SessionSummary | null): AutoTitleSkip | null {
  if (!s) return "not-found";
  if (s.workerSession || s.overseer || s.projectOverseer) return "not-listed";
  if (s.titleBy && s.titleBy !== "auto") return "explicit";
  // An older server's summary has no titleBy: any override counts as explicit there.
  if (!s.titleBy && s.originalTitle !== undefined) return "explicit";
  return null;
}

export type NameResult = { outcome: "named"; title: string } | { outcome: "would-name" } | { outcome: "skipped"; reason: AutoTitleSkip; detail?: string; backoff?: boolean };

/**
 * Name one session (NameMode). "button", "shorten" and "regenerate" need no summary line (then
 * the first 3 user messages are the input); "sweep" names from its summary line. The sweep's and
 * the button's write re-reads the store and is refused when an explicit title appeared meanwhile
 * (writeAutoTitle); "shorten" and "regenerate" read the stored entry before the call and write
 * only if it is unchanged at write time (replaceAutoTitle). A refused write reports `explicit`.
 */
export async function nameSession(path: string, mode: NameMode, deps: NameDeps, opts: { dryRun?: boolean } = {}): Promise<NameResult> {
  if (!existsSync(path)) return { outcome: "skipped", reason: "not-found" };
  const s = await deps.summary(path);
  if (!s) return { outcome: "skipped", reason: "not-found" };
  const replacing = mode === "shorten" || mode === "regenerate";
  // Read when the call starts: the write goes through only over exactly this entry.
  const seen = replacing ? (deps.stored ?? ((id: string) => readSessionTitleRecords()[id]))(s.id) : undefined;
  if (mode === "regenerate") {
    if (s.workerSession || s.overseer || s.projectOverseer) return { outcome: "skipped", reason: "not-listed" };
  } else if (mode === "shorten") {
    if (s.workerSession || s.overseer || s.projectOverseer) return { outcome: "skipped", reason: "not-listed" };
    if (seen?.by === "user" && !seen.legacy) return { outcome: "skipped", reason: "explicit", detail: "typed by hand" };
    if (!shortenable(seen)) return { outcome: "skipped", reason: "short" };
  } else {
    const skip = buttonSkip(s);
    if (skip) return { outcome: "skipped", reason: skip };
    if (mode === "sweep" && s.titleBy) return { outcome: "skipped", reason: "explicit", detail: "already named" };
  }
  const input = await (deps.input ?? readTitleInput)(path);
  if (input.userMessages.length === 0) return { outcome: "skipped", reason: "no-input" };
  if (mode === "sweep" && !input.summaryLine) return { outcome: "skipped", reason: "no-input", detail: "no summary line" };
  if (opts.dryRun) return { outcome: "would-name" };
  // The title's model call is the session's one-shot in the usage ledger.
  const result = await withUsageContext({ owner: s!.id, ...(s!.cwd ? { cwd: s!.cwd } : {}), purpose: "title", kind: "oneshot" }, () =>
    titleFromChain(deps.settings(), buildTitlePrompt(input), deps),
  );
  if ("failure" in result) return { outcome: "skipped", reason: result.failure, detail: result.detail, backoff: result.backoff };
  const written = replacing
    ? replaceAutoTitle(s.id, result.title, seen, { now: deps.now?.() })
    : writeAutoTitle(s.id, result.title, { redo: mode === "button", now: deps.now?.() });
  if (!written) return { outcome: "skipped", reason: "explicit", ...(replacing ? { detail: "the title changed while it was being named" } : {}) };
  return { outcome: "named", title: result.title };
}

/** `items` through `fn`, at most `limit` at a time, results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** POST /api/sessions/auto-title: every path, 4 at a time, in request order. `mode` "regenerate" is its `redo` form. */
export async function autoTitlePaths(
  paths: readonly (string | null)[],
  raw: readonly string[],
  deps: NameDeps,
  dryRun = false,
  mode: "button" | "shorten" | "regenerate" = "button",
): Promise<AutoTitleOutcome[]> {
  return mapLimit(paths, 4, async (path, i): Promise<AutoTitleOutcome> => {
    const reported = raw[i]!;
    if (!path) return { path: reported, outcome: "skipped", reason: "not-found" };
    const r = await nameSession(path, mode, deps, { dryRun });
    if (r.outcome === "skipped") return { path: reported, outcome: "skipped", reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) };
    return { path: reported, ...r };
  });
}

/** At most this many sessions per Shorten long titles call; a second press does the rest. */
export const SHORTEN_MAX_PER_CALL = 200;

/**
 * Shorten long titles' picks: this host's listed sessions whose stored title is shortenable (long,
 * and not typed by hand), most recently active first, at most SHORTEN_MAX_PER_CALL. Subagents' own
 * sessions and Overseer files are left out; archived ones are not. Pure.
 */
export function shortenPicks(listed: readonly SessionSummary[], records: Readonly<Record<string, StoredTitle>>): SessionSummary[] {
  return listed
    .filter((s) => !s.workerSession && !s.overseer && !s.projectOverseer && shortenable(records[s.id]))
    .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
    .slice(0, SHORTEN_MAX_PER_CALL);
}

// ── The sweep ─────────────────────────────────────────────────────────────────────────────────

export const SWEEP_MAX_PER_RUN = 10;
export const SWEEP_CONCURRENCY = 2;
export const SWEEP_BACKOFF_MS = 30 * 60_000;
/** After a nudge, the run waits this much past the quiet period, so the session has settled. */
const NUDGE_SLACK_MS = 5_000;

/** Is this listed session one the sweep may name now? Pure. */
export function sweepEligible(s: SessionSummary, now: number, quietMs: number): boolean {
  if (s.titleBy || s.originalTitle !== undefined) return false; // any stored title: named once, or explicit
  if (s.archived || !s.outlineGist) return false;
  if (s.workerSession || s.overseer || s.projectOverseer || s.draftPreview !== undefined) return false;
  const last = Date.parse(s.lastActiveAt);
  return Number.isFinite(last) && now - last >= quietMs;
}

export interface SweepDeps {
  settings: () => SessionTitleSettings;
  list: () => Promise<SessionSummary[]>;
  name: (s: SessionSummary) => Promise<NameResult>;
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * The background sweep: every `intervalMinutes`, plus a nudge when a summary line changes, while
 * the switch is on. At most 10 sessions a run, 2 at a time, most recently active first. A session
 * whose answer was no usable title waits until its summary line changes (this process only); a
 * run whose models all fail for quota, a rate limit or auth stops and pauses the sweep 30 minutes.
 * Silent: it writes titles and nothing else.
 */
export class AutoTitleSweep {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nudgeTimer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<number> | undefined;
  private pausedUntil = 0;
  /** id → the summary line it failed on. */
  private readonly declined = new Map<string, string>();
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly deps: SweepDeps) {
    this.now = deps.now ?? Date.now;
  }

  start(): void {
    this.stopped = false;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.nudgeTimer);
  }

  /** The settings changed: re-arm with the new interval, and run at once if the switch is on. */
  reschedule(): void {
    if (this.stopped) return;
    this.arm();
    if (this.deps.settings().enabled) void this.run();
  }

  /** A summary line changed: run once that session will have been quiet long enough. Debounced. */
  nudge(): void {
    if (this.stopped || !this.deps.settings().enabled) return;
    clearTimeout(this.nudgeTimer);
    this.nudgeTimer = setTimeout(() => void this.run(), this.deps.settings().quietMinutes * 60_000 + NUDGE_SLACK_MS);
    this.nudgeTimer.unref?.();
  }

  private arm(): void {
    clearTimeout(this.timer);
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.run().finally(() => this.arm());
    }, this.deps.settings().intervalMinutes * 60_000);
    this.timer.unref?.();
  }

  /** One run; resolves with how many sessions it named. A run while one is going joins it. */
  run(): Promise<number> {
    if (this.running) return this.running;
    this.running = this.runOnce().finally(() => (this.running = undefined));
    return this.running;
  }

  private async runOnce(): Promise<number> {
    const settings = this.deps.settings();
    const now = this.now();
    if (!settings.enabled || now < this.pausedUntil) return 0;
    let listed: SessionSummary[];
    try {
      listed = await this.deps.list();
    } catch {
      return 0;
    }
    const quietMs = settings.quietMinutes * 60_000;
    const picks = listed
      .filter((s) => sweepEligible(s, now, quietMs) && this.declined.get(s.id) !== s.outlineGist)
      .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
      .slice(0, SWEEP_MAX_PER_RUN);
    let named = 0;
    let stop = false;
    await mapLimit(picks, SWEEP_CONCURRENCY, async (s) => {
      if (stop || this.stopped || !this.deps.settings().enabled) return;
      let r: NameResult;
      try {
        r = await this.deps.name(s);
      } catch (err) {
        this.deps.log?.(`[auto-title] ${s.id}: ${failureMessage(err)}`);
        return;
      }
      if (r.outcome === "named") named++;
      else if (r.outcome === "skipped" && r.reason === "failed") {
        if (r.backoff) {
          stop = true;
          this.pausedUntil = this.now() + SWEEP_BACKOFF_MS;
          this.deps.log?.(`[auto-title] pausing 30 min: ${r.detail ?? ""}`);
        } else if (s.outlineGist) this.declined.set(s.id, s.outlineGist);
      } else if (r.outcome === "skipped" && r.reason === "no-model") stop = true;
    });
    if (named) this.deps.log?.(`[auto-title] named ${named} session${named === 1 ? "" : "s"}`);
    return named;
  }
}

/** `SOVA_AUTOTITLE_TRACE=<file>`: append every title request as it leaves, one JSON line each (testing aid). */
export function traceToFile(file: string | undefined): TitleDeps["trace"] {
  if (!file) return undefined;
  return (entry) => {
    try {
      appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    } catch {
      /* best effort */
    }
  };
}
