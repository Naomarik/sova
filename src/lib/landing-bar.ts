// The sidebar's landing bar (al_1): every project's merge queue and open release, reduced to ONE bar for the most
// urgent project, its step track, and the detail lines and actions its expansion shows. Pure: no Solid, no DOM. The
// shapes are the queue's (shared/merge-queue.ts) and the release's (shared/release.ts); the store that feeds this is
// lib/landing-bar-store.ts, the drawing components/LandingBar.tsx.
import { WAITING_FOR_USER, entryStateWords, type MergeEntry, type MergeQueueView, type MergeRun, type RunStep } from "../../shared/merge-queue";
import type { ReleaseRecord, ReleaseStep } from "../../shared/release";
import type { LandingQueueCut, LandingReleaseCut } from "../../shared/merge-queue";
import { mins, pausedTitle, short } from "./merge-queue";

// ---- the inputs -----------------------------------------------------------------------------------

/** The queue and release fields the bar reads: a full view (the feed's frames) or the summary read's cut. */
export type { LandingQueueCut, LandingReleaseCut };

/** One project as the bar reads it: its id (for addresses), its main checkout, its name, and the two views. */
export interface LandingProjectInput {
  id: string;
  root: string;
  name: string;
  queue: LandingQueueCut | null;
  release: LandingReleaseCut | null;
}

/** How long a landing, a publish or an opened request stays on the bar. */
export const SHOWN_MS = 60_000;

// ---- the model ------------------------------------------------------------------------------------

export type LandingTone = "accent" | "warn" | "success" | "error";
export type SegmentState = "passed" | "running" | "failed" | "waiting" | "skipped" | "held";
export interface LandingSegment {
  id: string;
  label: string;
  state: SegmentState;
  /** The gating checks segment of a release: how far the queue's run has got (0..1), while it runs. */
  progress?: number;
}
/** What the bar is about, most urgent first (a10). */
export type LandingKind = "release-needs" | "merge-needs" | "release" | "landing" | "paused" | "done";
const RANK: Record<LandingKind, number> = { "release-needs": 0, "merge-needs": 1, release: 2, landing: 3, paused: 4, done: 5 };

export interface LandingChip {
  label: string;
  tone: LandingTone | "neutral";
}
/** One line of the detail. `mono`: a machine fact (commits, step times). `href`: the line is a link. */
export interface LandingLine {
  text: string;
  mono?: true;
  tone?: LandingTone;
  href?: string;
}
/** An action in the detail: done in place (Resume Queue, Continue, Retry Step), or a link to the tab that does it. */
export type LandingAction =
  | { kind: "resume"; label: "Resume Queue"; root: string }
  | { kind: "continue"; label: "Continue"; root: string; release: string; step: string; stepLabel: string }
  | { kind: "retry"; label: "Retry Step"; root: string; release: string; step: string; stepLabel: string }
  | { kind: "link"; label: string; href: string; primary?: true };

export interface LandingProjectBar {
  /** The project's id and name. */
  project: string;
  name: string;
  kind: LandingKind;
  tone: LandingTone;
  icon: "branch" | "progress" | "alert-circle" | "check-circle" | "clock" | "stop";
  title: string;
  sub: string;
  /** The right chip ("+2 in line", "Frozen · 2 waiting"). */
  chip?: LandingChip;
  /** "1 needs you": merge entries waiting for the user while a landing runs (q9). */
  needsChip?: LandingChip;
  segments: LandingSegment[];
  /** The review step's own marker beside the track (never a segment). */
  review?: { label: string; state: SegmentState };
  lines: LandingLine[];
  actions: LandingAction[];
  /** The one-line form the detail lists other busy projects by. */
  oneLine: string;
}

export interface LandingBarModel {
  /** The bar shown: the most urgent project's. */
  top: LandingProjectBar;
  /** Every busy project, the top one first (the detail lists them, one line each). */
  all: LandingProjectBar[];
  /** "+1 project": the other busy projects. */
  moreChip?: LandingChip;
  /** The bar's accessible name: title and sub line. */
  name: string;
}

/** The reduction's answer: the bar (null: nothing to show, the bar is hidden) and the windowed keys it showed. */
export interface LandingReduction {
  bar: LandingBarModel | null;
  /** Keys of the windowed things shown now (a landing, a publish, a request opened): first-seen times the store keeps. */
  shown: string[];
  /** Keys whose window ended early (the project's next run started): never shown again. */
  retire: string[];
}

// ---- small words ----------------------------------------------------------------------------------

const PROJECTS_HREF = "#/projects";
const enc = encodeURIComponent;
export const queueHref = (pid: string, run?: string): string => `${PROJECTS_HREF}/${pid}/merge-queue${run ? `/${run}` : ""}`;
export const releasesHref = (pid: string): string => `${PROJECTS_HREF}/${pid}/releases`;
export const chatIdHref = (id: string): string => `#/sid/${enc(id)}`;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const stripDot = (s: string) => s.replace(/\.\s*$/, "");
/** m:ss for a countdown or an elapsed time. */
export function clockOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}
const ago = (iso: string | null | undefined, now: number): string | null => {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const m = Math.floor(Math.max(0, now - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)}h ago`;
};
const at = (iso: string | null | undefined): number => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

// ---- a merge run's step track (a2, t3) ------------------------------------------------------------

const RESULT: Record<RunStep["result"], SegmentState> = { passed: "passed", running: "running", failed: "failed", pending: "waiting", skipped: "skipped" };

/** A rerun step's suffix names the step it reruns: `rerun-tip:unit` → `check:unit`, `rerun-master:setup:db` → `setup:db`. */
const rerunTarget = (s: RunStep): string | null => {
  const m = /^rerun-(?:tip|master):(.+)$/.exec(s.id);
  if (!m) return null;
  const rest = m[1]!;
  return rest.startsWith("setup:") || rest === "copy" ? rest : `check:${rest}`;
};

/** The run's segments: one per check and per fixed step, in order; reruns fold into their step's segment (it runs
    again), review and notice are never segments, and checks not started yet follow from the run's check list. */
export function runSegments(run: Pick<MergeRun, "steps" | "checks">, o: { landsLocally?: boolean; push?: boolean } = {}): LandingSegment[] {
  const segs = foldedSteps(run);
  // The fixed steps before the checks in their order: one the run hasn't recorded reads skipped once a later step
  // started, else waiting.
  const pre = segs.filter((s) => PRE_RANK[kindOf(run, s.id)] !== undefined);
  const rest = segs.filter((s) => PRE_RANK[kindOf(run, s.id)] === undefined);
  const started = new Set(pre.map((s) => kindOf(run, s.id)));
  const maxRank = Math.max(-1, ...pre.map((s) => PRE_RANK[kindOf(run, s.id)]!), ...(rest.length && rest.some((s) => s.state !== "waiting") ? [99] : []));
  for (const k of PRE_KINDS) if (!started.has(k)) pre.push({ id: k, label: FIXED_LABEL[k], state: PRE_RANK[k]! < maxRank ? "skipped" : "waiting" });
  pre.sort((a, b) => PRE_RANK[kindOf(run, a.id)]! - PRE_RANK[kindOf(run, b.id)]!);
  // After the checks: master moved, the main checkout, the push (a run that lands locally only; none without origin).
  const post: LandingSegment[] = [];
  if (o.landsLocally !== false)
    for (const k of POST_KINDS)
      if (!rest.some((s) => kindOf(run, s.id) === k)) post.push({ id: k, label: FIXED_LABEL[k], state: k === "push" && o.push === false ? "skipped" : "waiting" });
  return [...pre, ...rest, ...post];
}

const PRE_KINDS = ["copy", "merge", "setup", "install", "docs"] as const;
const POST_KINDS = ["land", "main-checkout", "push"] as const;
const PRE_RANK: Partial<Record<string, number>> = { copy: 0, merge: 1, setup: 2, install: 3, docs: 4 };
const FIXED_LABEL: Record<(typeof PRE_KINDS)[number] | (typeof POST_KINDS)[number], string> = { copy: "Merge copy", merge: "Merge", setup: "Setup", install: "Install dependencies", docs: "Spec docs", land: "Land", "main-checkout": "Main checkout", push: "Push" };
/** A segment's step kind: the recorded step's, else the fixed step it stands for. */
const kindOf = (run: Pick<MergeRun, "steps">, id: string): string => run.steps.find((s) => s.id === id)?.kind ?? (id.startsWith("check:") ? "check" : id);

/** The run's recorded steps as segments, reruns folded in, then the checks not started yet. */
function foldedSteps(run: Pick<MergeRun, "steps" | "checks">): LandingSegment[] {
  const segs: LandingSegment[] = [];
  const byId = new Map<string, LandingSegment>();
  /** Each segment's own result (its step, then a rerun on the merge), and whether a rerun of it runs now. */
  const own = new Map<LandingSegment, SegmentState>();
  const rerunning = new Set<LandingSegment>();
  let lastFailed: LandingSegment | null = null;
  for (const s of run.steps) {
    if (s.kind === "review" || s.kind === "notice") continue;
    if (s.kind === "rerun-tip" || s.kind === "rerun-master") {
      const t = rerunTarget(s);
      const seg = (t && byId.get(t)) || lastFailed;
      if (!seg) continue;
      // A rerun running pulses its step again; a rerun on the merge decides the step (passed: flaky); one on the
      // target alone only says whose failure, never the step's result.
      if (s.result === "running") rerunning.add(seg);
      else if (s.kind === "rerun-tip" && (s.result === "passed" || s.result === "failed")) own.set(seg, RESULT[s.result]);
      continue;
    }
    const seg: LandingSegment = { id: s.id, label: s.label, state: RESULT[s.result] };
    segs.push(seg);
    byId.set(s.id, seg);
    own.set(seg, seg.state);
    if (seg.state === "failed") lastFailed = seg;
  }
  for (const seg of segs) seg.state = rerunning.has(seg) ? "running" : (own.get(seg) ?? seg.state);
  for (const c of run.checks) {
    const id = `check:${c.id}`;
    if (byId.has(id)) continue;
    const seg: LandingSegment = { id, label: c.label, state: "waiting" };
    segs.push(seg);
    byId.set(id, seg);
  }
  return segs;
}

/** The run's checks, in order: every check step and every check in the run's list (a check added mid-run counts). */
function runChecks(run: Pick<MergeRun, "steps" | "checks">): { id: string; label: string; step?: RunStep }[] {
  const out: { id: string; label: string; step?: RunStep }[] = [];
  const seen = new Set<string>();
  for (const s of run.steps)
    if (s.kind === "check") {
      const id = s.id.replace(/^check:/, "");
      seen.add(id);
      out.push({ id, label: s.label, step: s });
    }
  for (const c of run.checks) if (!seen.has(c.id)) out.push({ id: c.id, label: c.label });
  return out;
}

/** What the run is doing now, in the sub line's words: "check 4 of 11 · test:int · ~3 min left", or the step. */
export function runNow(run: Pick<MergeRun, "steps" | "checks" | "startedAt">, eta: MergeEntry["eta"] | undefined, now: number): string {
  const checks = runChecks(run);
  const running = run.steps.filter((s) => s.result === "running" && s.kind !== "review" && s.kind !== "notice");
  // A rerun running counts as its check.
  const cur = running[running.length - 1];
  const left = eta && eta.takesMs > 0 ? eta.takesMs - (now - at(run.startedAt)) : NaN;
  const tail = Number.isFinite(left) && left > 0 ? ` · ~${mins(left)} left` : "";
  if (cur) {
    const t = cur.kind === "check" ? cur.id.replace(/^check:/, "") : cur.kind === "rerun-tip" || cur.kind === "rerun-master" ? rerunTarget(cur)?.replace(/^check:/, "") : null;
    const i = t ? checks.findIndex((c) => c.id === t) : -1;
    if (i >= 0) return `check ${i + 1} of ${checks.length} · ${checks[i]!.label}${tail}`;
    return `${cur.label}${tail}`;
  }
  const next = checks.findIndex((c) => !c.step || c.step.result === "pending");
  if (next >= 0 && run.steps.some((s) => s.kind === "check")) return `check ${next + 1} of ${checks.length} · ${checks[next]!.label}${tail}`;
  return `Starting${tail}`;
}

/** The review's marker beside the track: running, or its verdict. */
function reviewMarker(run: Pick<MergeRun, "steps">, reviewing: boolean): LandingProjectBar["review"] {
  const r = [...run.steps].reverse().find((s) => s.kind === "review");
  if (reviewing || r?.result === "running") return { label: "Review running", state: "running" };
  if (!r) return undefined;
  if (r.result === "passed") return { label: "Review passed", state: "passed" };
  if (r.result === "failed") return { label: "Review flagged", state: "failed" };
  if (r.result === "skipped") return undefined;
  return { label: "Review waiting", state: "waiting" };
}

/** Elapsed on the step running now: "test:int · 2:14". */
function currentStepLine(run: Pick<MergeRun, "steps">, now: number): string | null {
  const cur = [...run.steps].reverse().find((s) => s.result === "running" && s.kind !== "review");
  if (!cur) return null;
  const t = at(cur.startedAt);
  return Number.isFinite(t) ? `${cur.label} · ${clockOf(now - t)}` : cur.label;
}

// ---- the merge queue's parts ----------------------------------------------------------------------

const needsYouOf = (q: LandingQueueCut): MergeEntry[] => q.needsYou.filter((e) => WAITING_FOR_USER.includes(e.state));
const conflictsOf = (q: LandingQueueCut): MergeEntry[] => q.needsYou.filter((e) => e.state === "conflict");

/** One needs-you entry, in the Merge Queue tab's words: branch, then one line of why. */
const needsLine = (e: MergeEntry, pid: string): LandingLine => ({ text: `${e.branch} · ${stripDot(entryStateWords(e))}${e.reason ? `: ${stripDot(e.reason)}` : ""}`, tone: "warn", href: queueHref(pid, e.run) });

/** The buttons an entry that waits for the user offers: each opens the Merge Queue tab at the entry (q3). */
function needsActions(e: MergeEntry, pid: string): LandingAction[] {
  const href = queueHref(pid, e.run);
  switch (e.state) {
    case "behaviour-differs":
      return [{ kind: "link", label: "Accept", href, primary: true }, { kind: "link", label: "Send Back", href }];
    case "review-flagged":
    case "unattributed":
      return [{ kind: "link", label: "Land Anyway", href, primary: true }, { kind: "link", label: "Send Back", href }];
    case "drafts-changed":
      return [{ kind: "link", label: "Land", href, primary: true }];
    default:
      return [];
  }
}

const waitingChip = (q: LandingQueueCut): LandingChip | undefined => (q.waiting.length ? { label: `+${q.waiting.length} in line`, tone: "neutral" } : undefined);

/** Next branches in line with their estimates (a3). */
function nextLines(q: LandingQueueCut): LandingLine[] {
  return q.waiting.slice(0, 3).map((e) => ({ text: `Next: ${e.branch}${e.eta && e.eta.startsInMs > 0 ? ` · starts in ~${mins(e.eta.startsInMs)}` : ""}` }));
}

function landingBar(p: LandingProjectInput, q: LandingQueueCut, run: MergeRun, now: number): LandingProjectBar {
  const entry = q.checking.find((e) => e.id === run.entry);
  const needs = needsYouOf(q);
  const lines: LandingLine[] = [
    { text: `${q.target} ${short(run.base)} + ${run.branch} → ${short(run.tip ?? run.mergeSha ?? run.commit)}`, mono: true },
    ...(currentStepLine(run, now) ? [{ text: currentStepLine(run, now)!, mono: true as const }] : []),
    ...(reviewLine(q, run) ? [reviewLine(q, run)!] : []),
    ...nextLines(q),
    ...needs.map((e) => needsLine(e, p.id)),
    ...conflictsOf(q).map((e) => ({ text: `${e.branch} · conflict being judged` })),
  ];
  const actions: LandingAction[] = [
    ...(entry?.session ? [{ kind: "link" as const, label: "Open Branch Chat", href: chatIdHref(entry.session) }] : []),
    { kind: "link", label: "View Checks", href: queueHref(p.id, run.id) },
    { kind: "link", label: "Open Queue", href: queueHref(p.id) },
  ];
  return {
    project: p.id,
    name: p.name,
    kind: "landing",
    tone: "accent",
    icon: "branch",
    title: `Landing ${run.branch}`,
    sub: runNow(run, entry?.eta, now),
    chip: waitingChip(q),
    ...(needs.length ? { needsChip: { label: `${needs.length} need${needs.length === 1 ? "s" : ""} you`, tone: "warn" as const } } : {}),
    segments: runSegments(run, { landsLocally: (entry?.approval.how ?? "local") === "local" && !entry?.approval.via, push: q.heads.hasOrigin !== false }),
    review: reviewMarker(run, q.reviewing?.run === run.id),
    lines,
    actions,
    oneLine: `${p.name} · Landing ${run.branch}`,
  };
}

function reviewLine(q: LandingQueueCut, run: MergeRun): LandingLine | null {
  const m = reviewMarker(run, q.reviewing?.run === run.id);
  if (!m) return null;
  const attempt = q.reviewing?.run === run.id && q.reviewing.attempt > 1 ? ` · attempt ${q.reviewing.attempt}` : "";
  return { text: `${m.label}${attempt}`, ...(q.reviewing?.run === run.id ? { href: chatIdHref(q.reviewing.session) } : {}) };
}

function mergeNeedsBar(p: LandingProjectInput, q: LandingQueueCut, needs: MergeEntry[]): LandingProjectBar {
  const e = needs[0]!;
  const rest = needs.length - 1;
  return {
    project: p.id,
    name: p.name,
    kind: "merge-needs",
    tone: "warn",
    icon: "alert-circle",
    title: stripDot(entryStateWords(e)),
    sub: `${e.branch}${e.reason ? ` · ${stripDot(e.reason)}` : ""}`,
    ...(rest > 0 ? { chip: { label: `+${rest} more`, tone: "warn" as const } } : {}),
    segments: [],
    // The face says the first one already: the detail lists the others.
    lines: [...needs.slice(1).map((x) => needsLine(x, p.id)), ...conflictsOf(q).map((x) => ({ text: `${x.branch} · conflict being judged` })), ...nextLines(q)],
    actions: [...needsActions(e, p.id), ...(e.session ? [{ kind: "link" as const, label: "Open Branch Chat", href: chatIdHref(e.session) }] : []), { kind: "link", label: "Open Queue", href: queueHref(p.id) }],
    oneLine: `${p.name} · ${e.branch} · ${stripDot(entryStateWords(e))}`,
  };
}

export const INVALID_TITLE = "Queue settings are broken: nothing runs until they are fixed";

function pausedBar(p: LandingProjectInput, q: LandingQueueCut): LandingProjectBar {
  const invalid = q.paused?.kind === "definition-invalid" || !!q.invalid;
  const title = invalid ? INVALID_TITLE : stripDot(pausedTitle(q));
  const why = invalid ? (q.invalid ?? q.paused?.why ?? "") : (q.paused?.why ?? "");
  return {
    project: p.id,
    name: p.name,
    kind: "paused",
    tone: invalid ? "error" : "warn",
    icon: invalid ? "alert-circle" : "stop",
    title,
    sub: why ? stripDot(why) : q.waiting.length ? `${plural(q.waiting.length, "branch", "branches")} in line` : "Nothing in line",
    chip: waitingChip(q),
    segments: [],
    // The reason is the sub line already; the detail adds the rest only when the face cuts it.
    lines: [...nextLines(q), ...needsYouOf(q).map((e) => needsLine(e, p.id))],
    // A definition that doesn't parse can't be resumed: it runs again once it is fixed.
    actions: [...(invalid ? [] : [{ kind: "resume" as const, label: "Resume Queue" as const, root: p.root }]), { kind: "link", label: "Open Queue", href: queueHref(p.id) }],
    oneLine: `${p.name} · ${title}`,
  };
}

/** A landing (or a request opened, a branch pushed) shown for its minute. */
function doneBar(p: LandingProjectInput, q: LandingQueueCut, now: number, seen: ReadonlyMap<string, number>, shown: string[]): LandingProjectBar | null {
  const inWindow = (key: string, t: number) => {
    const first = seen.get(key);
    const start = first === undefined ? t : Math.min(t, first);
    return Number.isFinite(start) && now - start < SHOWN_MS && now - start > -SHOWN_MS;
  };
  const l = q.recent[0];
  const landedAt = at(l?.entry.landed?.at);
  const host = (q.waitingOnHost ?? []).find((e) => (e.state === "requested" || e.state === "pushed") && inWindow(`host:${e.id}:${e.state}`, at(e.updatedAt)));
  const landedShown = l?.entry.landed && inWindow(`landed:${l.entry.id}`, landedAt);
  // The newer of the two takes the bar.
  if (host && (!landedShown || at(host.updatedAt) > landedAt)) {
    shown.push(`host:${host.id}:${host.state}`);
    const r = host.request;
    const title =
      host.state === "pushed" || r?.how === "push-branch"
        ? `Pushed ${host.branch}`
        : r?.how === "gitlab-mr"
          ? `Merge request opened${r.number ? ` · !${r.number}` : ""}`
          : `Pull request opened${r?.number ? ` · #${r.number}` : ""}`;
    return {
      project: p.id,
      name: p.name,
      kind: "done",
      tone: "success",
      icon: "check-circle",
      title,
      // A pushed branch names itself in the title already.
      sub: host.state === "pushed" ? `on origin · opens into ${r?.base ?? host.target}` : `${host.branch} → ${r?.base ?? host.target}`,
      segments: [],
      lines: [],
      actions: [...(r?.url ? [{ kind: "link" as const, label: "Open on Host", href: r.url }] : []), { kind: "link", label: "Open Queue", href: queueHref(p.id) }],
      oneLine: `${p.name} · ${title}`,
    };
  }
  if (!l || !landedShown || !l.entry.landed) return null;
  shown.push(`landed:${l.entry.id}`);
  const ld = l.entry.landed;
  const sha = short(ld.sha);
  const notPushed = ld.pushed === "not-pushed";
  const sub =
    ld.pushed === "pushed"
      ? `as ${sha} · pushed`
      : notPushed
        ? `as ${sha} · not pushed: ${stripDot(ld.pushWhy ?? q.heads.pushWhy ?? "origin wasn't updated")}`
        : ld.pushed === "no-remote"
          ? `as ${sha} · on this machine only`
          : `as ${sha} · pushing`;
  const notes = l.entry.notes.filter((n) => n.kind === "thread" || n.kind === "operator");
  return {
    project: p.id,
    name: p.name,
    kind: "done",
    tone: notPushed ? "warn" : "success",
    icon: "check-circle",
    title: `Landed ${l.entry.branch}`,
    sub,
    segments: [],
    // The merge thread's note, word for word.
    lines: notes.map((n) => ({ text: n.text })),
    actions: [...(l.run ? [{ kind: "link" as const, label: "View Checks", href: queueHref(p.id, l.run.id) }] : []), { kind: "link", label: "Open Queue", href: queueHref(p.id) }],
    oneLine: `${p.name} · Landed ${l.entry.branch}`,
  };
}

// ---- a release (a7–a9) ----------------------------------------------------------------------------

const RSTATE: Record<ReleaseStep["state"], SegmentState> = { waiting: "waiting", running: "running", done: "passed", failed: "failed", skipped: "skipped", held: "held" };
/** The release's plan as the bar draws it: every step in plan order, withdraw steps never. */
export const releasePlan = (r: Pick<ReleaseRecord, "steps">): ReleaseStep[] => r.steps.filter((s) => s.phase !== "withdraw");
const releaseName = (r: Pick<ReleaseRecord, "tag" | "version">): string | null => r.tag ?? (r.version ? `v${r.version}` : null);

/** The queue's run for a release's gating checks, when it is the one running. */
function checksRun(r: ReleaseRecord, q: LandingQueueCut | null): MergeRun | null {
  const run = q?.current;
  if (!run) return null;
  const step = r.steps.find((s) => s.id === "checks");
  if (step?.run === run.id || (r.entry && run.entry === r.entry)) return run;
  return null;
}

function releaseSegments(r: ReleaseRecord, run: MergeRun | null): LandingSegment[] {
  return releasePlan(r).map((s) => {
    const seg: LandingSegment = { id: s.id, label: s.label, state: RSTATE[s.state] };
    if (s.id === "checks" && run && s.state === "running") {
      // Its checks' progress: the steps around them are quick and say nothing about how far it got.
      const segs = runSegments(run, { landsLocally: false }).filter((x) => x.id.startsWith("check:"));
      const done = segs.filter((x) => x.state === "passed" || x.state === "failed" || x.state === "skipped").length;
      if (segs.length) seg.progress = done / segs.length;
    }
    return seg;
  });
}

/** The step the release is at: the first running, held or failed, else the first waiting. */
const currentStep = (plan: ReleaseStep[]): ReleaseStep | undefined =>
  plan.find((s) => s.state === "running" || s.state === "held" || s.state === "failed") ?? plan.find((s) => s.state === "waiting");

function frozenChip(q: LandingQueueCut | null): LandingChip {
  const n = q?.waiting.length ?? 0;
  return { label: n ? `Frozen · ${n} waiting` : "Frozen", tone: "neutral" };
}

function releaseLines(rv: LandingReleaseCut, r: ReleaseRecord, now: number): LandingLine[] {
  const lines: LandingLine[] = [{ text: `${rv.target} ${short(r.base)}${r.commit && r.commit !== r.base ? ` → ${short(r.commit)}` : ""}`, mono: true }];
  const last = ago(r.lastReportAt, now);
  if (last) lines.push({ text: `Last report from the release chat ${last}` });
  for (const s of releasePlan(r)) if (s.summary) lines.push({ text: `${s.label}: ${s.summary}`, ...(s.state === "failed" ? { tone: "warn" as const } : {}) });
  if (r.state !== "publishing" && rv.gates && rv.gates.why.length) for (const w of rv.gates.why) lines.push({ text: `Publish isn't offered yet: ${stripDot(w)}` });
  return lines;
}

function releaseActions(p: LandingProjectInput, r: ReleaseRecord, extra: LandingAction[] = []): LandingAction[] {
  return [...extra, ...(r.thread ? [{ kind: "link" as const, label: "Open Release Chat", href: chatIdHref(r.thread.session) }] : []), { kind: "link", label: "Open Releases", href: releasesHref(p.id) }];
}

/** A release that needs the user: the first reason, in a8's words; null when none. */
function releaseNeeds(rv: LandingReleaseCut, r: ReleaseRecord, now: number): { title: string; sub?: string; act?: LandingAction["kind"]; step?: ReleaseStep } | null {
  const plan = releasePlan(r);
  const name = releaseName(r);
  const failed = plan.find((s) => s.state === "failed");
  if (r.publish?.error) return { title: `Publish failed: ${stripDot(r.publish.error)}` };
  if (failed) return { title: `${failed.label} failed`, act: "retry", step: failed, ...(failed.summary ? { sub: failed.summary } : {}) };
  const held = plan.find((s) => s.state === "held");
  if (held) return { title: `${held.label} is held for you`, act: "continue", step: held, ...(held.summary ? { sub: held.summary } : {}) };
  if (r.state === "ready") {
    const until = at(r.power?.heldUntil);
    const sub = Number.isFinite(until) && until > now ? `Publishes in ${clockOf(until - now)}` : "Publish it from the Releases tab";
    return { title: `Ready to publish${name ? ` · ${name}` : ""}`, sub };
  }
  if (rv.quiet) return { title: `No word from the release chat for ${rv.quiet.minutes} min` };
  return null;
}

function openReleaseBar(p: LandingProjectInput, rv: LandingReleaseCut, r: ReleaseRecord, q: LandingQueueCut | null, now: number): LandingProjectBar {
  const plan = releasePlan(r);
  const run = checksRun(r, q);
  const name = releaseName(r);
  const cur = currentStep(plan);
  const idx = cur ? plan.indexOf(cur) + 1 : plan.length;
  let sub = `Step ${idx} of ${plan.length}${cur ? ` · ${cur.label}` : ""}`;
  if (cur?.id === "checks" && run) {
    const entry = q?.checking.find((e) => e.id === run.entry);
    sub += ` · ${runNow(run, entry?.eta, now)}`;
  }
  const needs = releaseNeeds(rv, r, now);
  const base = {
    project: p.id,
    name: p.name,
    chip: frozenChip(q),
    segments: releaseSegments(r, run),
    ...(run ? { review: reviewMarker(run, q?.reviewing?.run === run.id) } : {}),
    lines: releaseLines(rv, r, now),
  };
  if (needs) {
    const step = needs.step;
    const act: LandingAction[] =
      step && needs.act === "retry"
        ? [{ kind: "retry", label: "Retry Step", root: p.root, release: r.id, step: step.id, stepLabel: step.label }]
        : step && needs.act === "continue"
          ? [{ kind: "continue", label: "Continue", root: p.root, release: r.id, step: step.id, stepLabel: step.label }]
          : [];
    return {
      ...base,
      kind: "release-needs",
      tone: "warn",
      icon: "alert-circle",
      title: needs.title,
      sub: needs.sub ?? sub,
      actions: releaseActions(p, r, act),
      oneLine: `${p.name} · ${needs.title}`,
    };
  }
  const title = name ? `Releasing ${name}` : "Releasing a new version";
  return {
    ...base,
    kind: "release",
    tone: "accent",
    icon: "progress",
    title,
    sub,
    actions: releaseActions(p, r, run ? [{ kind: "link", label: "View Checks", href: queueHref(p.id, run.id) }] : []),
    oneLine: `${p.name} · ${title}`,
  };
}

/** The last release, published: its after steps still running, a failed after step (needs you), or its minute. */
function publishedBar(p: LandingProjectInput, rv: LandingReleaseCut, r: ReleaseRecord, now: number, seen: ReadonlyMap<string, number>, shown: string[]): LandingProjectBar | null {
  if (r.state !== "published") return null;
  const name = releaseName(r) ?? "the release";
  const after = r.steps.filter((s) => s.phase === "after");
  const failed = after.find((s) => s.state === "failed");
  const running = after.find((s) => s.state === "running") ?? after.find((s) => s.state === "held");
  const pubAt = at(r.publish?.at);
  const segments = releaseSegments(r, null);
  const sub = r.publish?.pushed === "pushed" ? "pushed to origin" : "on this machine only";
  const base = { project: p.id, name: p.name, segments, lines: releaseLines(rv, r, now) };
  if (failed)
    return {
      ...base,
      kind: "release-needs",
      tone: "warn",
      icon: "alert-circle",
      title: `${failed.label} failed`,
      sub: failed.summary ?? `Published ${name}, ${sub}`,
      actions: releaseActions(p, r, [{ kind: "retry", label: "Retry Step", root: p.root, release: r.id, step: failed.id, stepLabel: failed.label }]),
      oneLine: `${p.name} · ${failed.label} failed`,
    };
  if (running) {
    const held = running.state === "held";
    return {
      ...base,
      kind: held ? "release-needs" : "release",
      tone: held ? "warn" : "accent",
      icon: held ? "alert-circle" : "progress",
      title: held ? `${running.label} is held for you` : `Published, finishing · ${running.label}`,
      sub: `${name} · ${sub}`,
      actions: releaseActions(p, r, held ? [{ kind: "continue", label: "Continue", root: p.root, release: r.id, step: running.id, stepLabel: running.label }] : []),
      oneLine: `${p.name} · Published, finishing · ${running.label}`,
    };
  }
  const key = `published:${r.id}`;
  const first = seen.get(key);
  const start = first === undefined ? pubAt : Math.min(pubAt, first);
  if (!Number.isFinite(start) || now - start >= SHOWN_MS) return null;
  shown.push(key);
  return {
    ...base,
    kind: "done",
    tone: "success",
    icon: "check-circle",
    title: `Published ${name}`,
    sub,
    actions: releaseActions(p, r),
    oneLine: `${p.name} · Published ${name}`,
  };
}

// ---- one project, then every project --------------------------------------------------------------

/** One project's bar, or null when nothing there wants showing. */
export function projectBar(p: LandingProjectInput, now: number, seen: ReadonlyMap<string, number>, out: { shown: string[]; retire: string[] }): LandingProjectBar | null {
  const q = p.queue && p.queue.served !== false ? p.queue : null;
  const rv = p.release;
  const open = rv?.open ?? null;
  // A release takes its project's bar (q4); its own needs-you takes over everything (q9).
  if (open) return openReleaseBar(p, rv!, open, q, now);
  const run = q?.current && q.current.verdict === "running" ? q.current : null;
  if (q && run) {
    // The next run started: the landing before it goes at once.
    const l = q.recent[0];
    if (l) out.retire.push(`landed:${l.entry.id}`);
    for (const e of q.waitingOnHost ?? []) out.retire.push(`host:${e.id}:${e.state}`);
  }
  const lastRel = rv?.last ? publishedBar(p, rv, rv.last, now, seen, out.shown) : null;
  if (lastRel && lastRel.kind === "release-needs") return lastRel;
  if (q) {
    const needs = needsYouOf(q);
    if (!run && needs.length) return mergeNeedsBar(p, q, needs);
    if (lastRel && lastRel.kind === "release") return lastRel;
    if (run) return landingBar(p, q, run, now);
    if (q.state === "paused" || q.invalid) return pausedBar(p, q);
    const done = doneBar(p, q, now, seen, out.shown);
    if (lastRel && (!done || at(rv?.last?.publish?.at) >= at(q.recent[0]?.entry.landed?.at))) return lastRel;
    return done;
  }
  return lastRel;
}

/** Every project reduced to the bar (a10): the most urgent project's bar, the rest listed in its detail. */
export function reduceLanding(projects: readonly LandingProjectInput[], now: number, seen: ReadonlyMap<string, number> = new Map()): LandingReduction {
  const out = { shown: [] as string[], retire: [] as string[] };
  const bars: LandingProjectBar[] = [];
  for (const p of projects) {
    const b = projectBar(p, now, seen, out);
    // Each line once: the detail never repeats the face's title or sub line.
    if (b) bars.push({ ...b, lines: b.lines.filter((l) => stripDot(l.text) !== b.title && stripDot(l.text) !== b.sub) });
  }
  // Stable: equal kinds keep the projects' own order.
  const all = bars.map((b, i) => ({ b, i })).sort((x, y) => RANK[x.b.kind] - RANK[y.b.kind] || x.i - y.i).map((x) => x.b);
  const top = all[0];
  if (!top) return { bar: null, ...out };
  const more = all.length - 1;
  return {
    bar: {
      top,
      all,
      ...(more > 0 ? { moreChip: { label: `+${plural(more, "project")}`, tone: "neutral" as const } } : {}),
      name: [top.title, top.sub, top.needsChip?.label, top.chip?.label, more > 0 ? `+${plural(more, "project")}` : null].filter(Boolean).join(". "),
    },
    ...out,
  };
}
