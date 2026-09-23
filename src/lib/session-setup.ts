import type { GitSummary, SessionSetup, SessionSetupFile } from "../../shared/protocol";
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

/** The figures a file row carries: "4.2 KB · 120 lines". */
export function fileFacts(f: SessionSetupFile): string {
  return `${sizeLabel(f.bytes)} · ${linesLabel(f.lines)}`;
}

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

/** What a set of files adds up to on disk. */
export interface LoadoutSum {
  bytes: number;
  lines: number;
}

function sumFiles(files: readonly SessionSetupFile[]): LoadoutSum {
  return files.reduce((a, f) => ({ bytes: a.bytes + f.bytes, lines: a.lines + f.lines }), { bytes: 0, lines: 0 });
}

/** The figures an aggregate line carries: "40 KB · 1,940 lines" — the same two figures, in the
    same order, as one file row, so the totals and the rows read as one column of numbers. */
export function sumFacts(s: LoadoutSum): string {
  return `${sizeLabel(s.bytes)} · ${linesLabel(s.lines)}`;
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

/** The qualifier under the Skills label. Sova's own loader can't see a path an extension adds, so
    a list it built says so rather than passing for the whole set. */
export function skillsNote(s: Loaded): string {
  const base = "Offered to this session. A skill loads when it is used.";
  return s.fromRuntime ? base : `${base} ${NOT_FROM_RUNTIME}`;
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
      commit: { oid: string; subject: string; ago: string } | null;
      /** Shown in place of `commit` when there is none. */
      noCommit: string | null;
    }
  | { kind: "line"; text: string };

export function gitView(g: GitSummary, home: string | null, now: number): GitView {
  if (g.state === "none") return { kind: "line", text: `${placeLabel(g, home)} isn't inside a git repository.` };
  if (g.state === "unavailable") return { kind: "line", text: g.reason };
  const c = g.lastCommit;
  return {
    kind: "repo",
    head: headLabel(g),
    upstream: g.upstream ? upstreamLabel(g) : null,
    changes: changesLabel(g),
    lines: g.added + g.removed > 0 ? { added: g.added, removed: g.removed } : null,
    note: linesNote(g) ?? (g.statusPartial ? "Git status was cut short, so these counts are lower bounds." : null),
    commit: c ? { oid: c.oid.slice(0, 7), subject: c.subject, ago: agoLabel(c.at, now) } : null,
    // headLabel already says "no commits yet" for an unborn branch.
    noCommit: c || g.unborn ? null : "The last commit couldn't be read.",
  };
}
