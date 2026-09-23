import { CHARS_PER_TOKEN, type GitCommit, type GitRepoSummary, type GitSummary, type SessionSetup, type SessionSetupFile } from "../../shared/protocol";
import { formatTokens } from "./context";
import { relativeTime, thousands, tildePath } from "./format";
import { changesLabel, headLabel, linesNote, placeLabel, upstreamLabel } from "./git-summary";

/**
 * The words of the setup card a new, empty session shows (SessionSetup.tsx): what pi loads into
 * the prompt, what it offers, and the repository around the folder. Pure, so each sentence can be
 * tested against the state it must NOT be said in — a partial status is never "clean", and a
 * remote session never reads as one with no skills.
 */

/** "812 B" under 1 KB, then "1.0 KB"…"9.9 KB", then whole KB: "12 KB". KB is 1024 bytes. */
export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return kb < 9.95 ? `${kb.toFixed(1)} KB` : `${thousands(Math.round(kb))} KB`;
}

/** "1 line", "240 lines", "1,204 lines". */
export function linesLabel(n: number): string {
  return `${thousands(n)} ${n === 1 ? "line" : "lines"}`;
}

/** What a file's text costs a model, as the card says it: "≈4.1k tokens". The ≈ is not decoration —
    the count comes from pi's own estimate (CHARS_PER_TOKEN), and a model's real count differs, which
    the note under each section says in words. */
export function tokenFacts(tokens: number): string {
  return `≈${formatTokens(tokens)} tokens`;
}

/** Said under a section whose figures include a token count, so the unit is never a mystery and the
    ≈ is never read as a measurement. */
export const TOKEN_NOTE = `Token counts are estimates: ${CHARS_PER_TOKEN} characters per token.`;

/** The figures a file row carries: "4.2 KB · 120 lines · ≈4.1k tokens". The token estimate is
    dropped, not zeroed, when there is none to show — the rule the repository's own rows follow. */
export function fileFacts(f: SessionSetupFile): string {
  const facts = [sizeLabel(f.bytes), linesLabel(f.lines)];
  if (typeof f.tokens === "number") facts.push(tokenFacts(f.tokens));
  return facts.join(" · ");
}

/** Whether a figure carries a token estimate at all — what decides whether the section says what the
    number means. */
export const hasTokens = (f: SessionSetupFile): boolean => typeof f.tokens === "number";
export const sumHasTokens = (s: LoadoutSum): boolean => s.tokens !== null;

/** One row of the Context group. `role` says how a system-prompt file differs from a context file. */
export interface ContextRow {
  file: SessionSetupFile;
  label: string;
  role: string | null;
}

type Loaded = Extract<SessionSetup, { state: "ok" }>;

/** Everything pi puts into the prompt, in load order, each file with the role it plays in that
    order: a replacing SYSTEM.md first (it is the prompt the rest is added to), then the context
    files, then the APPEND_SYSTEM.md sources. The single source of the Context rows AND of every
    sum below, so a total can never count a file the list doesn't show. */
function layered(s: Loaded): { file: SessionSetupFile; role: string | null }[] {
  return [
    ...(s.systemPrompt ? [{ file: s.systemPrompt, role: "replaces the system prompt" }] : []),
    ...s.context.map((f) => ({ file: f, role: null })),
    ...(s.appendSystemPrompt ?? []).map((f) => ({ file: f, role: "appended to the system prompt" })),
  ];
}

export function contextRows(s: Loaded, home: string | null): ContextRow[] {
  return layered(s).map(({ file, role }) => ({ file, label: tildePath(file.path, home), role }));
}

/** What a set of files adds up to on disk, and — when any of them was estimated — what sending
    them would cost. */
export interface LoadoutSum {
  bytes: number;
  lines: number;
  /** null: no file in this set carried an estimate, so there is no total to state. */
  tokens: number | null;
}

function sumFiles(files: readonly SessionSetupFile[]): LoadoutSum {
  const estimated = files.filter((f) => typeof f.tokens === "number");
  return {
    bytes: files.reduce((a, f) => a + f.bytes, 0),
    lines: files.reduce((a, f) => a + f.lines, 0),
    tokens: estimated.length > 0 ? estimated.reduce((a, f) => a + (f.tokens as number), 0) : null,
  };
}

/** The figures an aggregate line carries: "40 KB · 1,940 lines · ≈9.7k tokens" — the same figures,
    in the same order, as one file row, so the totals and the rows read as one column of numbers. */
export function sumFacts(s: LoadoutSum): string {
  const facts = [sizeLabel(s.bytes), linesLabel(s.lines)];
  if (s.tokens !== null) facts.push(tokenFacts(s.tokens));
  return facts.join(" · ");
}

/** Nothing to add up: empty files sum to zero, and a zero total is never shown (gitView never
    draws "+0 −0" either). */
export function isSumEmpty(s: LoadoutSum): boolean {
  return s.bytes === 0 && s.lines === 0;
}

/** Everything pi loads into the prompt, added up. */
export function contextSum(s: Loaded): LoadoutSum {
  return sumFiles(layered(s).map((l) => l.file));
}

/** Everything this session is offered, added up — offered, not loaded: see skillsNote. */
export function skillsSum(s: Loaded): LoadoutSum {
  return sumFiles(s.skills);
}

/** What this session costs at rest: the files pi loads into the prompt, plus the skills it offers.
    The card's one aggregate line, above the two sections that add up to it. */
export function systemContextSum(s: Loaded): LoadoutSum {
  return sumFiles([...layered(s).map((l) => l.file), ...s.skills]);
}

export const contextHeading = (n: number) => `Context · ${n}`;
export const skillsHeading = (n: number) => `Skills · ${n}`;

/** The aggregate line's label, and the one sentence saying what it adds up — on hover, since the
    split into the two sections is already on screen below it. */
export const SYSTEM_CONTEXT_LABEL = "System context";
export const SYSTEM_CONTEXT_TITLE = "Everything pi loads into the prompt, plus the skills it offers.";

export const CONTEXT_NOTE = "Loaded into the prompt.";
export const CONTEXT_NONE = "No context files. pi loads AGENTS.md or CLAUDE.md when a folder has one.";
const NOT_FROM_RUNTIME = "Skills an extension adds aren't listed.";

/** The note under Context. It carries what the token figures mean exactly when there are some. */
export function contextNote(s: Loaded): string {
  return sumHasTokens(contextSum(s)) ? `${CONTEXT_NOTE} ${TOKEN_NOTE}` : CONTEXT_NOTE;
}

/** The qualifier under the Skills label. Sova's own loader can't see a path an extension adds, so
    a list it built says so rather than passing for the whole set — and a list with token figures
    says what they mean. */
export function skillsNote(s: Loaded): string {
  const base = "Offered to this session. A skill loads when it is used.";
  return [base, s.fromRuntime ? null : NOT_FROM_RUNTIME, sumHasTokens(skillsSum(s)) ? TOKEN_NOTE : null].filter(Boolean).join(" ");
}

/** In place of an empty Skills list — with the same caveat, since an empty list Sova built itself
    may be missing exactly the skills an extension adds. */
export function skillsNone(s: Loaded): string {
  const base = "No skills offered to this session.";
  return s.fromRuntime ? base : `${base} ${NOT_FROM_RUNTIME}`;
}

/** The one line a remote session gets in place of Context and Skills. */
export function remoteNote(target: string): string {
  return `Skills and context files are read on ${target}, so they aren't listed here.`;
}

/** What stands in the card's loadout slot: the Context and Skills groups for a local read, or one
    line — a remote session's loadout lives on its target, and an unreadable folder has a reason. */
export type LoadoutView = { kind: "groups"; setup: Loaded } | { kind: "line"; text: string };

export function loadoutView(s: SessionSetup): LoadoutView {
  if (s.state === "ok") return { kind: "groups", setup: s };
  if (s.state === "remote") return { kind: "line", text: remoteNote(s.where.target) };
  return { kind: "line", text: s.reason };
}

/** A ms-epoch time as the relative words the rest of the app uses ("2h ago", "Mar 4"). */
export function agoLabel(ms: number, now: number): string {
  return Number.isFinite(ms) ? relativeTime(new Date(ms).toISOString(), now) : "";
}

/** The Repository group, as a person reads it. `lines` is null when there is no sum to show. */
export type GitView =
  | {
      kind: "repo";
      head: string;
      upstream: string | null;
      changes: string;
      lines: { added: number; removed: number } | null;
      /** Why the sum or the tallies are short, or null when both are whole. */
      note: string | null;
      /** The repository's recent commits, newest first — up to RECENT_COMMITS of them, fewer when
          that is all there is. Empty in an unborn repository and when git log went unread. */
      commits: { oid: string; subject: string; ago: string }[];
      /** Shown in place of the commits when there are none. */
      noCommit: string | null;
    }
  | { kind: "line"; text: string };

/** The commits a summary carries: `commits`, which this server always sends; else — the wire's
    older shape, a client rebuilt against a server not yet restarted — the one `lastCommit` is, so
    the card draws a log of one rather than nothing. A transitional read, not a permanent contract. */
function commitsOf(g: GitRepoSummary): GitCommit[] {
  if (g.commits) return g.commits;
  return g.lastCommit ? [g.lastCommit] : [];
}

export function gitView(g: GitSummary, home: string | null, now: number): GitView {
  if (g.state === "none") return { kind: "line", text: `${placeLabel(g, home)} isn't inside a git repository.` };
  if (g.state === "unavailable") return { kind: "line", text: g.reason };
  const commits = commitsOf(g);
  return {
    kind: "repo",
    head: headLabel(g),
    upstream: g.upstream ? upstreamLabel(g) : null,
    changes: changesLabel(g),
    lines: g.added + g.removed > 0 ? { added: g.added, removed: g.removed } : null,
    note: linesNote(g) ?? (g.statusPartial ? "Git status was cut short, so these counts are lower bounds." : null),
    commits: commits.map((c) => ({ oid: c.oid.slice(0, 7), subject: c.subject, ago: agoLabel(c.at, now) })),
    // headLabel already says "no commits yet" for an unborn branch.
    noCommit: commits.length > 0 || g.unborn ? null : "The last commits couldn't be read.",
  };
}
