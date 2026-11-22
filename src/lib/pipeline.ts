// The queue screen's words (§app.merge-queue/explainer): each stage of the pipeline as the Setup view draws it, from
// the setup's facts (shared/merge-queue-setup-map.ts); a run's plan beside what it did; a recorded change as its line.
// DOM- and Solid-free, so its tests run in the unit tier.

import type { MergeEntry, MergeEvent, MergeRun, MergeThreadInfo, RunStep, RunVerdict } from "../../shared/merge-queue";
import type { MergeQueueHealth } from "../../shared/merge-queue-health";
import type { SetupChange, SetupCheck, SetupMap } from "../../shared/merge-queue-setup-map";
import type { ReleaseRecord, ReleaseStep } from "../../shared/release";
import { duration } from "./format";

/** One recorded change to a branch or the queue (§app.merge-queue/activity). */
export type QueueEvent = MergeEvent;

export interface StageFact {
  label: string;
  value: string;
  mono?: true;
}

/** One check in the Checks stage's lanes. */
export interface CheckChip {
  id: string;
  label: string;
  /** Short, on the chip: its time limit, or the paths that set it off. */
  meta: string;
  /** Runs only when the changed files match (a dashed chip). */
  cond?: true;
  /** A tag on the chip ("retries narrowly", "per selection"). */
  tag?: string;
  rule: string;
  facts: StageFact[];
}

export interface Lane {
  label: string;
  checks: CheckChip[];
}

/** One stage of the pipeline, in order. */
export interface Stage {
  id: string;
  name: string;
  /** One line under its name. */
  line: string;
  /** On the stage's end: a time or a count. */
  end?: string;
  /** A failure here goes back to the branch's chat (↩). */
  back?: true;
  /** It runs only on some branches. */
  cond?: true;
  /** The detail panel's rule: two or three sentences. */
  rule: string;
  facts: StageFact[];
  lanes?: Lane[];
  /** Under the lanes. */
  note?: string;
  /** Who reviews (the Review stage). */
  who?: { name: string; scope: string; desc: string; ai: boolean }[];
  /** Something that needs the user's attention on this stage (unanswered private names). */
  warn?: string;
}

const argv = (a: readonly string[]) => a.join(" ");
/** A rule's reason as a sentence of its own. */
const said = (t: string) => {
  const x = t.trim();
  return x ? `${x[0]!.toUpperCase()}${x.slice(1)}${/[.!?]$/.test(x) ? "" : "."}` : "";
};
/** A check's typical time counts only over enough runs. */
const ENOUGH_RUNS = 3;
const limit = (sec: number) => (sec % 60 === 0 ? `${sec / 60}m limit` : `${sec}s limit`);
const HOW: Record<SetupMap["land"]["how"], string> = {
  local: "merged on this computer",
  "github-pr": "opened as a GitHub pull request",
  "gitlab-mr": "opened as a GitLab merge request",
  "push-branch": "pushed as a branch",
};

function checkChip(m: SetupMap, c: SetupCheck, health: MergeQueueHealth | null | undefined, rule?: SetupMap["rules"][number]): CheckChip {
  const slow = health?.slowestChecks.find((s) => s.id === c.id && s.runs >= ENOUGH_RUNS);
  const facts: StageFact[] = [
    { label: "Command", value: argv(c.run), mono: true },
    { label: "Runs when", value: rule ? `${rule.paths.join(", ")} changed. ${said(rule.why)}` : c.optional ? "Only when a folder rule or the merge thread adds it." : "On every branch." },
    ...(rule?.select?.length ? [{ label: "Selection", value: rule.select.join(" "), mono: true as const }] : []),
    { label: "Time limit", value: `${limit(c.timeoutSec).replace(" limit", "")}. Past it, the check is timed on ${m.target ?? "the main branch"} alone to tell whose it is.` },
    ...(c.cwd ? [{ label: "Folder", value: c.cwd, mono: true as const }] : []),
    ...(c.report ? [{ label: "Report", value: `${c.report.format} · ${c.report.at}` }] : []),
    ...(c.requires.length ? [{ label: "Services", value: c.requires.join(", ") }] : []),
    { label: "If it fails", value: c.rerun ? `Only ${c.rerunByName ? "the failing tests rerun, by name" : "the failing tests’ files rerun"}, to tell a flaky test from a real failure; a real one goes back to the branch’s chat.` : "The branch goes back to its chat with the output. Nothing lands." },
    ...(slow ? [{ label: "Typical", value: `${duration(slow.medianMs)} over ${slow.runs} runs` }] : []),
  ];
  return {
    id: c.id,
    label: c.label,
    meta: rule ? rule.paths.join(", ") : slow ? duration(slow.medianMs) : limit(c.timeoutSec),
    ...(rule ? { cond: true as const } : {}),
    ...(c.perSelector ? { tag: "per selection" } : c.rerun ? { tag: "narrow rerun" } : {}),
    rule: rule ? `Runs when files under ${rule.paths.join(" or ")} change. ${said(rule.why)}` : c.optional ? `Optional. It runs when a folder rule or the merge thread adds it, never on its own.` : `Runs on every branch.`,
    facts,
  };
}

/** The merge queue's pipeline, stage by stage, from its setup. */
export function queueStages(m: SetupMap, health?: MergeQueueHealth | null): Stage[] {
  const target = m.target ?? "main";
  const out: Stage[] = [];
  out.push({
    id: "approve",
    name: "Approved",
    line: "You press Land, or type “land it” in the branch’s chat. The approval pins that commit and its spec drafts.",
    rule: "Only your Land, or your own words in the branch’s chat, puts a branch in line. Branches land one at a time, in the order approved.",
    facts: [
      { label: "Trigger", value: "Your Land on a finished branch." },
      { label: "In line", value: "One branch at a time, oldest approval first." },
      { label: "Covers", value: "The fixes its chat makes for the queue’s requests, once the merge thread checks each." },
    ],
  });
  const setup = m.setup.length ? `, then setup ${m.setup.join(", ")}` : "";
  out.push({
    id: "copy",
    name: "Merge copy",
    line: `A copy beside the project is reset to ${target}’s newest head${setup}. Installed packages and build output are reused.`,
    rule: "Each run starts in the merge copy at the newest main branch. Clean Run empties it first; once a week a run starts empty by itself. Each run records what it reused.",
    facts: [
      { label: "Setup", value: m.setup.length ? m.setup.join(", ") : "No setup steps." },
      { label: "Install", value: m.install ? `When ${m.install.inputs.join(", ")} change.` : "No install step." },
      { label: "Reuse", value: m.reuse ? "Test files that passed on identical code aren’t run again." : "Every check runs in full." },
      { label: "Clean Run", value: "On demand, and weekly." },
    ],
  });
  out.push({
    id: "merge",
    name: "Merge",
    line: `The approved commit is merged onto ${target}. A conflict goes to the merge thread to judge.`,
    back: true,
    rule: `The branch is merged onto the newest ${target}, never the one it was written against. The merge thread judges a conflict: one that changes nothing it resolves; anything else goes back to the branch’s chat.`,
    facts: [
      { label: "If it conflicts", value: "The merge thread judges it. A change of behaviour goes back to the branch’s chat or waits for you." },
      { label: "Spec drafts", value: "Made official in the copy before any check runs." },
    ],
  });
  if (m.checksFrom === "none" || m.checksFrom === "unset") {
    out.push({
      id: "checks",
      name: "Checks",
      line: m.checksFrom === "none" ? "This project declares no automated tests: nothing is checked." : "No checks are set up yet.",
      rule: m.checksFrom === "none" ? "The project said it has no automated tests, so a branch lands once it merges." : "Set up the merge queue to say which checks run.",
      facts: [],
    });
  } else {
    const ruled = new Map<string, SetupMap["rules"]>();
    for (const r of m.rules) ruled.set(r.check, [...(ruled.get(r.check) ?? []), r]);
    const every = m.checks.filter((c) => !c.optional);
    const cond: CheckChip[] = [];
    for (const r of m.rules) {
      const c = m.checks.find((x) => x.id === r.check);
      if (c) cond.push({ ...checkChip(m, c, health, r), id: `${c.id}:${r.paths.join(",")}` });
    }
    const picked = m.checks.filter((c) => c.optional && !ruled.has(c.id));
    const lanes: Lane[] = [
      ...(every.length ? [{ label: "Every branch", checks: every.map((c) => checkChip(m, c, health)) }] : []),
      ...(cond.length ? [{ label: "Only when the changed files match", checks: cond }] : []),
      ...(picked.length ? [{ label: "Only when the merge thread adds it", checks: picked.map((c) => checkChip(m, c, health)) }] : []),
    ];
    out.push({
      id: "checks",
      name: "Checks",
      line: `${every.length} on every branch${m.rules.length ? `, ${m.rules.length} folder ${m.rules.length === 1 ? "rule" : "rules"} for the rest` : ""}${picked.length ? `, ${picked.length} the merge thread may add` : ""}.`,
      end: `${m.checks.length} ${m.checks.length === 1 ? "check" : "checks"}${cond.length ? ` · ${cond.length} conditional` : ""}`,
      back: true,
      rule: "Every check that applies runs here, one after another. Sova applies the folder rules itself at the start of every run, reading them from the branch being landed; the merge thread may only add checks on top.",
      facts: [
        { label: "Trigger", value: "A clean merge." },
        { label: "Folder rules", value: m.rules.length ? `${m.rules.length}, read from the branch: a branch that changes them shows it on its run.` : "None: only the checks on every branch run, plus what the merge thread adds." },
        { label: "Time limit", value: `A check past its limit is timed on ${target} alone. It finishes there: it goes back to the branch. It runs over there too: the queue pauses and asks you.` },
        { label: "If it fails", value: "The branch goes back to its chat with the output. Nothing lands." },
        ...(health?.passRate.rate != null ? [{ label: "Pass rate", value: `${health.passRate.passed} of ${health.passRate.runs} runs passed` }] : []),
      ],
      lanes,
      note: "↩ A failed check sends the branch back to its chat with the failing output. Nothing lands.",
    });
  }
  if (m.review) {
    const r = m.review;
    out.push({
      id: "review",
      name: "Review",
      line: `The review kit in ${r.kit} reads the diff${r.model ? ` with ${r.model} (unless a review model is picked in Settings)` : ""}, beside the checks.`,
      back: true,
      rule: "The branch’s own review kit runs, so a branch that changes it shows that on its run. A finding goes back to the branch’s chat; nothing lands until it’s answered.",
      facts: [
        { label: "Kit", value: r.kit, mono: true },
        { label: "Model", value: r.model ? `${r.model}${r.thinking ? ` · ${r.thinking}` : ""}, unless a review model is picked in Settings (that one runs)` : "The review model picked in Settings." },
        { label: "Passes", value: `${r.passes ?? 1} ${(r.passes ?? 1) === 1 ? "reviewer" : "reviewers in turn"}` },
        { label: "Time limit", value: `${r.timeLimitMin ?? 20}m per reviewer` },
        { label: "Tools", value: r.tools?.length ? r.tools.join(", ") : "Read-only" },
        ...(r.problem ? [{ label: "Problem", value: r.problem }] : []),
      ],
      who: [
        { name: "Reviewer", scope: "Every branch", desc: r.fixes ? "Reads the diff against the kit and may fix what it finds itself; its fix is checked and tested like a chat’s." : "Reads the diff against the kit and reports what it finds.", ai: true },
        { name: "You", scope: "Decisions", desc: "Only when a finding is yours to decide: a change of behaviour, or anything the task never decided.", ai: false },
      ],
    });
  }
  const how = HOW[m.land.how];
  out.push({
    id: "land",
    name: "Land",
    line: m.land.how === "local" ? `${target} moves to exactly the tested commit${m.land.squash ? ", as one commit" : ""}, then the main checkout.` : `The branch is ${how}; it lands there.`,
    rule: m.land.how === "local" ? `Once everything passed, ${target} fast-forwards to exactly what was tested${m.land.squash ? ": the branch as one commit" : ", a merge commit"}. The project’s main checkout follows.` : `The tested branch is ${how}, and the queue follows it there until it’s merged or closed.`,
    facts: [
      { label: "How", value: `${how[0]!.toUpperCase()}${how.slice(1)}${m.land.squash ? ", one commit" : ""}.` },
      { label: "If main moved", value: "The run starts again on the newest main; the run records why." },
    ],
  });
  if (m.push.on) {
    const names = m.push.names;
    out.push({
      id: "names",
      name: "Private names and secrets",
      line: "Before the push, the landing is scanned for the private names you listed and for secrets. A hit stops here and shows where.",
      rule: "Nothing private leaves this computer. A hit fails this step and shows each match; you ask the merge thread, send the branch back, or allow that match for this project.",
      facts: [
        { label: "Names", value: names === "none" ? "You said there are no private names." : names === "answered" ? "Your list of private names." : "Not answered yet: the merge thread asks you before the first push." },
        { label: "Secrets", value: "Keys and tokens, always." },
        { label: "On a hit", value: "Ask the Merge Thread, Send Back, or Allow." },
      ],
      ...(names === "unanswered" ? { warn: "Private names aren’t answered yet: the first push waits for you." } : {}),
    });
  }
  out.push({
    id: "push",
    name: m.push.on ? `Pushed to ${m.push.remote}` : "Not pushed",
    line: m.push.on ? `${target} goes to ${m.push.remote}, fast-forward only.` : m.push.remote ? "This project doesn’t push: landings stay on this computer." : "No remote: landings stay on this computer.",
    rule: m.push.on ? `${target} and ${m.push.remote} stay equal, so the next branch merges onto what everyone else sees. If ${m.push.remote} moved, nothing is forced.` : "Nothing is pushed from the queue.",
    facts: m.push.on ? [{ label: "Remote", value: m.push.remote!, mono: true }, { label: "If rejected", value: `Nothing is forced. The queue says so and waits.` }] : [],
  });
  return out;
}

/** The release pipeline, from the release section and its playbook's steps (shared/release.ts planOf's order). */
export function releaseStages(m: SetupMap): Stage[] {
  const r = m.release;
  if (!r) return [];
  const target = m.target ?? "main";
  const phase = (p: string) => r.steps.filter((s) => s.phase === p);
  const step = (s: (typeof r.steps)[number]): Stage => ({
    id: `step:${s.id}`,
    name: s.label,
    line: s.about ?? (s.held ? "Waits for your Continue." : "A step of the release playbook."),
    ...(s.minutes ? { end: `${s.minutes}m` } : s.held ? { end: "waits for you" } : {}),
    rule: `${s.about ?? s.label}.${s.held ? " It ends held until you press Continue." : ""}${s.artifact ? " It reports the artifact it built." : ""}`,
    facts: [{ label: "Phase", value: s.phase }, ...(s.held ? [{ label: "Held", value: "Until your Continue." }] : [])],
  });
  return [
    {
      id: "start",
      name: "Start",
      line: `You press Start Release. ${target} is frozen: only the release lands until it’s published or abandoned.`,
      end: "by you",
      rule: "A release is a deliberate act: nothing ships because a branch landed.",
      facts: [
        { label: "Tag", value: r.tag, mono: true },
        { label: "Version", value: r.scheme },
      ],
    },
    ...phase("prepare").map(step),
    {
      id: "checks",
      name: "Gating checks",
      line: `Every landing check runs on the release${r.checks.length ? `, then ${r.checks.map((c) => c.label).join(", ")}` : ""}. Nothing is skipped.`,
      rule: "A branch may skip a check its files don’t need; a release runs every one.",
      facts: [{ label: "Release checks", value: r.checks.length ? r.checks.map((c) => c.label).join(", ") : "None beyond the landing checks." }],
    },
    ...phase("check").map(step),
    {
      id: "publish",
      name: "Publish",
      line: `You press Publish: the tag ${r.tag} is made${m.push.on ? ` and pushed to ${m.push.remote}` : ""}${r.channels.length ? `, ${r.channels.join(", ")} move` : ""}.`,
      end: "by you",
      rule: "Without your Publish, nothing is tagged or pushed.",
      facts: [{ label: "Channels", value: r.channels.length ? r.channels.join(", ") : "None." }, { label: "Release commit", value: r.commit ? "Yes" : "Tag only" }],
    },
    ...phase("after").map(step),
  ];
}

/** One row of a run's plan: a step it will take, or one it won't, each with why. */
export interface PlanRow {
  id: string;
  name: string;
  note: string;
  skip?: true;
  /** Runs only if something happens (a lockfile changed, a check failed). */
  maybe?: true;
  late?: true;
  /** The run stops here, failed (the branch's folder rules are refused); `note` says why. */
  refused?: true;
}

const SOURCE_NOTE: Record<string, string> = { required: "Runs on every branch.", picked: "Added by the merge thread.", release: "A release check.", trigger: "A folder rule matched." };

/** The plan beside what ran: the run's saved plan when it has one, else what its steps say. */
export function planRows(r: MergeRun): { rows: PlanRow[]; fingerprint?: string; sameAs?: string; grew?: string } {
  const p = r.plan;
  if (p) {
    const rows: PlanRow[] = p.steps.map((s) => ({
      id: s.id,
      name: s.label,
      note: s.why ?? (s.source ? (SOURCE_NOTE[s.source] ?? "") : ""),
      ...(s.will === "skip" ? { skip: true as const } : {}),
      ...(s.will === "if" ? { maybe: true as const } : {}),
      ...(s.will === "refused" ? { refused: true as const } : {}),
      ...(s.late ? { late: true as const } : {}),
    }));
    return { rows, fingerprint: p.fingerprint, ...(p.sameAs ? { sameAs: p.sameAs } : {}), ...(p.late ? { grew: p.late.fingerprint } : {}) };
  }
  return { rows: r.steps.filter((s) => s.kind !== "notice").map((s) => ({ id: s.id, name: s.label, note: s.why ?? (s.source ? (SOURCE_NOTE[s.source] ?? "") : ""), ...(s.result === "skipped" ? { skip: true as const } : {}) })) };
}

/** A run step as the timeline draws it. */
export type MarkState = "done" | "failed" | "running" | "waiting" | "skipped";
export const stepState = (s: Pick<RunStep, "result">): MarkState => (s.result === "passed" ? "done" : s.result === "failed" ? "failed" : s.result === "running" ? "running" : s.result === "skipped" ? "skipped" : "waiting");
export const releaseStepState = (s: Pick<ReleaseStep, "state">): MarkState => (s.state === "done" ? "done" : s.state === "failed" ? "failed" : s.state === "running" ? "running" : s.state === "skipped" ? "skipped" : "waiting");

/** A run's place in the Runs list: the words of its chip and its filter. */
export function runChip(v: RunVerdict): { label: string; tone: "accent" | "success" | "warn" | "error" | "neutral"; filter: "queue" | "landed" | "back" | "other" } {
  switch (v) {
    case "running":
      return { label: "Landing", tone: "accent", filter: "queue" };
    case "passed":
      return { label: "Landed", tone: "success", filter: "landed" };
    case "failed":
      return { label: "Sent back", tone: "warn", filter: "back" };
    case "conflict":
      return { label: "Conflict", tone: "warn", filter: "back" };
    case "waiting":
      return { label: "Waits for you", tone: "warn", filter: "queue" };
    case "machine":
      return { label: "Setup failed", tone: "error", filter: "other" };
    case "void":
      return { label: "Restarted", tone: "neutral", filter: "other" };
    case "cancelled":
      return { label: "Cancelled", tone: "neutral", filter: "other" };
  }
}

/** Who made a recorded change, as its row names them. */
export const BY_WORD: Record<QueueEvent["by"], string> = { user: "You", queue: "Queue", thread: "Merge thread", chat: "Branch chat", reviewer: "Reviewer", release: "Release" };

/** A recorded change's title: what kind of change, in words. */
export function eventTitle(e: QueueEvent): string {
  switch (e.kind) {
    case "approved":
      return "Approved";
    case "waiting":
      return "Waiting in line";
    case "run-started":
      return "Run started";
    case "run-restarted":
      return e.count > 1 ? `Run restarted (${e.count}×)` : "Run restarted";
    case "run-ended":
      return "Run ended";
    case "step-ended":
      return "Step ended";
    case "picked":
      return e.late ? "Check added after the start" : "Check added";
    case "sent-back":
      return "Sent back to its chat";
    case "answered":
      return "Its chat answered";
    case "ruled":
      return `Merge thread: ${ACT_WORD[e.act] ?? e.act}`;
    case "decision":
      return e.answered ? "You answered" : "Waiting for you";
    case "paused":
      return e.self ? "Queue paused itself" : "Queue paused";
    case "resumed":
      return "Queue resumed";
    case "landed":
      return "Landed";
    case "pushed":
      return "Pushed";
    case "push-held":
      return "Push held";
    case "cancelled":
      return "Removed from the queue";
    case "thread-health":
      return e.what === "fresh-thread" ? "Fresh merge thread started" : e.what === "fresh-failed" ? "Fresh merge thread failed" : e.what === "waited-long" ? "Waited long on the merge thread" : "Merge thread unreachable";
    case "clean-run":
      return "Clean Run";
    case "flaky":
      return "Flaky test";
    case "names":
      return "Private names and secrets";
    case "review":
      return e.what === "kit-changed" ? "This branch changed its own review" : e.what === "fixed" ? "Reviewer fixed it" : e.what === "verdict" ? "Review verdict" : "Review started";
    case "note":
      return "Note";
    default:
      return String((e as { kind: string }).kind).replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
}

/** The tone of a recorded change's mark. */
export function eventState(e: QueueEvent): MarkState {
  if (e.kind === "sent-back" || e.kind === "paused" || e.kind === "push-held" || (e.kind === "run-ended" && e.verdict !== "passed") || (e.kind === "names" && (e.what === "hits" || e.what === "push-scan-hit")) || (e.kind === "thread-health" && e.what !== "fresh-thread")) return "failed";
  if ((e.kind === "decision" && !e.answered) || e.kind === "waiting" || e.kind === "run-restarted") return "waiting";
  return "done";
}

/** What the merge thread's decision was, in words. */
export const ACT_WORD: Record<string, string> = { extend: "added a check", resolve: "resolved a conflict", rule: "ruled", "fix-checked": "checked a fix", "fix-refused": "refused a fix", review: "judged the review", note: "noted", ask: "asked you", hold: "held the queue", retry: "put it back in line", names: "private names" };

/** A branch's story: its recorded changes, oldest first, grouped into attempts (one per run). */
export interface Attempt {
  run?: string;
  label: string;
  events: QueueEvent[];
}
export function attemptsOf(events: readonly QueueEvent[]): Attempt[] {
  const sorted = [...events].filter((e) => e.kind !== "step-ended").sort((a, b) => a.seq - b.seq);
  const out: Attempt[] = [];
  let cur: Attempt | null = null;
  let n = 0;
  for (const e of sorted) {
    if (e.kind === "run-started") {
      n++;
      cur = { ...(e.run ? { run: e.run } : {}), label: `Attempt ${n}`, events: [] };
      out.push(cur);
    } else if (!cur) {
      cur = { label: "Before its first run", events: [] };
      out.push(cur);
    }
    cur.events.push(e);
  }
  return out;
}

/** The Proposal view's diagram: each stage name, marked where a change touches it. */
export function changedStages(changes: readonly SetupChange[]): Set<string> {
  const s = new Set<string>();
  for (const c of changes) s.add(c.stage === "rules" ? "checks" : c.stage);
  return s;
}

/** The tag word of a change. */
export const CHANGE_WORD: Record<SetupChange["tag"], string> = { add: "Add", change: "Change", remove: "Remove" };

/** A release's chip, in the Releases list. */
export function releaseChip(r: Pick<ReleaseRecord, "state">): { label: string; tone: "accent" | "success" | "warn" | "error" | "neutral" | "info" } {
  switch (r.state) {
    case "preparing":
      return { label: "Preparing", tone: "accent" };
    case "checking":
      return { label: "Checking", tone: "accent" };
    case "ready":
      return { label: "Ready to publish", tone: "info" };
    case "publishing":
      return { label: "Publishing", tone: "accent" };
    case "published":
      return { label: "Released", tone: "success" };
    case "abandoned":
      return { label: "Abandoned", tone: "neutral" };
    case "withdrawn":
      return { label: "Withdrawn", tone: "warn" };
  }
}

// ---- facts the screen reads from the queue's newer fields -----------------------------------------------------
// The names step's scan, the merge thread's health, a wait on it and the review kit a run used are added to
// shared/merge-queue.ts by their own work; the screen reads each through one accessor, by the shape it draws.

/** The Private names and secrets step's facts: where each hit is and what kind, never the matched text. */
export interface ScanSeen {
  state: "clean" | "hits" | "unanswered" | "unreadable";
  commits?: number;
  hits?: { key: string; where: string; what: string; kind: string }[];
  allowed?: number;
  why?: string;
}
export const scanOf = (s: RunStep): ScanSeen | undefined => (s as RunStep & { scan?: ScanSeen }).scan;

/** A fix or conflict waiting on the merge thread. */
export interface ThreadWaitSeen {
  what: "fix" | "conflict";
  since: string;
  fresh?: { at: string; ok?: boolean; error?: string };
}
export const threadWaitOf = (e: MergeEntry): ThreadWaitSeen | undefined => (e as MergeEntry & { threadWait?: ThreadWaitSeen }).threadWait;

/** How the merge thread answers. */
export interface ThreadHealthSeen {
  state: "ok" | "waiting" | "slow" | "failed";
  waiting?: { what: "fix" | "conflict"; since: string; entry: string; branch: string };
  deadlineMin: number;
  failures: { at: string; kind: string; error: string }[];
  restarts: { at: string; why: string; ok: boolean }[];
}
export const threadHealthOf = (t: MergeThreadInfo | undefined): ThreadHealthSeen | undefined => (t as (MergeThreadInfo & { health?: ThreadHealthSeen }) | undefined)?.health;

/** The review kit files the branch changed itself (the run's review stamp). */
export const ownReviewOf = (r: MergeRun): { path: string }[] => (r as MergeRun & { review?: { changed?: { path: string }[] } }).review?.changed ?? [];
