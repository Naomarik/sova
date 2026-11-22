// The queue screen's Setup view (§app.merge-queue/explainer): a project's merge setup as the facts its diagram draws —
// checks, which run when and why (the folder rules), the review, how it lands and pushes, the private names step —
// read from one definition. The same reading of the main branch and of the Setup chat's working copy gives the
// Proposal view's side by side and its list of changes; consecutive versions on the main branch give Setup history.
// Pure: no I/O, no DOM. The server reads the files (server/merge-queue/setup-map.ts); the page draws the words.

import type { LandHow } from "./merge-queue";
import type { MergeCheckDecl, MergeRuleDecl, ProjectDef } from "./project-contract";

/** What the review kit declares (server/merge-queue/review-kit.ts readKitDecl), as the Setup view lists it. */
export interface SetupReview {
  /** The kit's folder, relative to the repository. */
  kit: string;
  model?: string;
  thinking?: string;
  passes?: number;
  timeLimitMin?: number;
  tools?: string[];
  /** merge.reviewFixes: the reviewer may fix what it finds itself (through the same path as a chat's fix). */
  fixes: boolean;
  problem?: string;
}

export interface SetupCheck {
  id: string;
  label: string;
  run: string[];
  timeoutSec: number;
  /** Runs only when a folder rule or the merge thread adds it. */
  optional: boolean;
  requires: string[];
  needsSelect?: true;
  perSelector?: true;
  /** Its failures name test files, rerun narrowly to tell a flaky test from a real failure. */
  rerun: boolean;
  /** The folder it runs in, relative to the repository (absent: the root). */
  cwd?: string;
  /** The test report it writes, read for blame: "JUnit XML" or "TAP", and where. */
  report?: { format: "JUnit XML" | "TAP"; at: string };
  /** One failing test reruns by name (else only its file). */
  rerunByName?: true;
}

/** Where private names stand for a pushing project: the interview answered (a list kept), answered "none", or not yet. */
export type NamesState = "answered" | "none" | "unanswered";

export interface SetupRelease {
  tag: string;
  scheme: string;
  channels: string[];
  commit: boolean;
  /** Release-only checks, after every landing check. */
  checks: { id: string; label: string }[];
  /** The release playbook's steps, in order, by phase. */
  steps: { id: string; label: string; phase: string; held?: true; artifact?: true; about?: string; minutes?: number }[];
  quietMin: number;
  problem?: string;
}

export interface SetupMap {
  /** Which definition: the main branch's (in force) or the Setup chat's working copy (proposed). */
  of: "main" | "proposal";
  /** The commit read (for a proposal, its branch's head; `dirty`: uncommitted edits are in it too). */
  commit: string | null;
  dirty?: true;
  branch?: string;
  /** setupHash of the merge section: one setup version. */
  hash: string;
  /** The definition doesn't parse: what's wrong (nothing else is read). */
  problem?: string;
  target?: string;
  /** The merge section's check list: declared, "none" (no automated tests), the test command's one check, or unset. */
  checksFrom: "declared" | "none" | "test-command" | "unset";
  checks: SetupCheck[];
  rules: MergeRuleDecl[];
  setup: string[];
  install: { inputs: string[] } | null;
  review: SetupReview | null;
  land: { how: LandHow; squash: boolean };
  push: { on: boolean; remote: string | null; names: NamesState | null };
  /** false: every check runs in full (no passes reused from identical code). */
  reuse: boolean;
  release: SetupRelease | null;
}

/** What the server adds that the definition alone doesn't say. */
export interface SetupFacts {
  of: SetupMap["of"];
  /** The branch the queue lands on when the definition names none (the main checkout's). */
  target?: string;
  commit: string | null;
  dirty?: boolean;
  branch?: string;
  /** The review kit's declaration, read from that copy (null: no kit). */
  review?: Omit<SetupReview, "kit" | "fixes"> | null;
  /** The push remote's name when the project has one (null: no remote). */
  remote: string | null;
  names: NamesState | null;
  release?: { steps: SetupRelease["steps"]; problem?: string } | null;
  /** The definition's parse error, when the text didn't parse. */
  problem?: string;
}

/** A short, stable hash of any JSON value (FNV-1a over its canonical text), 8 hex digits. */
export function shortHash(v: unknown): string {
  const text = canonical(v);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const checkOf = (c: MergeCheckDecl): SetupCheck => {
  const cwd = c.cwd;
  const report = c.report ? ("junit" in c.report ? { format: "JUnit XML" as const, at: c.report.junit } : { format: "TAP" as const, at: c.report.tap }) : undefined;
  return {
    id: c.id,
    label: c.label,
    run: [...c.run],
    timeoutSec: c.timeout,
    optional: !!c.optional,
    requires: [...c.requires],
    rerun: c.rerun,
    ...(c.needsSelect ? { needsSelect: true as const } : {}),
    ...(c.perSelector ? { perSelector: true as const } : {}),
    ...(cwd ? { cwd } : {}),
    ...(report ? { report } : {}),
    ...(c.rerunTest ? { rerunByName: true as const } : {}),
  };
};

/** One definition (null: none, or one that didn't parse: `facts.problem`) as the Setup view's facts. */
export function setupMapOf(def: ProjectDef | null, facts: SetupFacts): SetupMap {
  const m = def?.merge;
  const decl = m as (typeof m & { squash?: boolean; reviewFixes?: boolean }) | undefined;
  const checksFrom: SetupMap["checksFrom"] = Array.isArray(m?.checks) ? "declared" : m?.checks === "none" ? "none" : def?.test ? "test-command" : "unset";
  const checks: SetupCheck[] =
    checksFrom === "declared"
      ? (m!.checks as MergeCheckDecl[]).map(checkOf)
      : checksFrom === "test-command"
        ? [{ id: "test", label: "Tests", run: [...def!.test!.run], timeoutSec: def!.test!.timeout, optional: false, requires: [...def!.test!.requires], rerun: false }]
        : [];
  const rules = (m?.rules ?? []).map((r) => ({ paths: [...r.paths], check: r.check, ...(r.select ? { select: [...r.select] } : {}), why: r.why }));
  const review: SetupReview | null = m?.review && facts.review !== null ? { kit: m.review, ...(facts.review ?? {}), fixes: !!decl?.reviewFixes } : null;
  const pushOn = m?.push !== false && !!facts.remote;
  const rel = def?.release;
  const release: SetupRelease | null = rel
    ? {
        tag: rel.tag,
        scheme: rel.scheme,
        channels: [...rel.channels],
        commit: rel.commit,
        checks: rel.checks.map((c) => ({ id: c.id, label: c.label })),
        steps: facts.release?.steps ?? [],
        quietMin: rel.quietMin,
        ...(facts.release?.problem ? { problem: facts.release.problem } : {}),
      }
    : null;
  const map: Omit<SetupMap, "hash"> = {
    of: facts.of,
    commit: facts.commit,
    ...(facts.dirty ? { dirty: true as const } : {}),
    ...(facts.branch ? { branch: facts.branch } : {}),
    ...(facts.problem ? { problem: facts.problem } : {}),
    ...(m?.target || facts.target ? { target: m?.target ?? facts.target } : {}),
    checksFrom,
    checks,
    rules,
    setup: (def?.setup ?? []).map((s) => s.id),
    install: m?.install ? { inputs: [...m.install.inputs] } : null,
    review,
    land: { how: m?.land ?? "local", squash: !!decl?.squash },
    push: { on: pushOn, remote: facts.remote, names: pushOn ? facts.names : null },
    reuse: m?.reuse !== false,
    release,
  };
  return { ...map, hash: setupHash(map) };
}

/** The setup version's hash: what the queue does, never where it was read from. */
export function setupHash(m: Omit<SetupMap, "hash">): string {
  const { of: _of, commit: _c, dirty: _d, branch: _b, push, ...rest } = m;
  return shortHash({ ...rest, push: { on: push.on, remote: push.remote } });
}

/** One difference between two setups, in the Proposal view's and Setup history's words. */
export interface SetupChange {
  tag: "add" | "change" | "remove";
  /** What part of the pipeline it touches (the diagram marks that stage). */
  stage: "checks" | "rules" | "review" | "land" | "push" | "copy" | "release";
  /** The thing, named ("Check e2e · Browser tests", "Rule src/** → e2e"). */
  name: string;
  /** One line: what is different. */
  detail: string;
}

const words = (a: readonly string[]) => a.join(" ");
const ruleKey = (r: MergeRuleDecl) => `${r.paths.join(",")}→${r.check}${r.select?.length ? `[${r.select.join(" ")}]` : ""}`;
const ruleName = (r: MergeRuleDecl) => `${r.paths.join(", ")} → ${r.check}${r.select?.length ? ` (${r.select.join(" ")})` : ""}`;
const howWords: Record<LandHow, string> = { local: "merged on this computer", "github-pr": "a GitHub pull request", "gitlab-mr": "a GitLab merge request", "push-branch": "its branch pushed" };

/** What changes from `a` to `b`, in pipeline order. Same hash: nothing. */
export function setupChanges(a: SetupMap, b: SetupMap): SetupChange[] {
  if (a.hash === b.hash) return [];
  const out: SetupChange[] = [];
  if (a.checksFrom !== b.checksFrom && (a.checksFrom === "none" || b.checksFrom === "none" || a.checksFrom === "unset" || b.checksFrom === "unset"))
    out.push({ tag: "change", stage: "checks", name: "Check list", detail: `${fromWords(a.checksFrom)} → ${fromWords(b.checksFrom)}` });
  const before = new Map(a.checks.map((c) => [c.id, c]));
  const after = new Map(b.checks.map((c) => [c.id, c]));
  for (const c of b.checks) {
    const was = before.get(c.id);
    if (!was) {
      out.push({ tag: "add", stage: "checks", name: `Check ${c.label}`, detail: `${c.optional ? "Optional: runs when a rule or the merge thread adds it" : "Runs on every branch"} · ${words(c.run)}` });
      continue;
    }
    const diffs: string[] = [];
    if (words(was.run) !== words(c.run)) diffs.push(`command ${words(was.run)} → ${words(c.run)}`);
    if (was.timeoutSec !== c.timeoutSec) diffs.push(`time limit ${minutes(was.timeoutSec)} → ${minutes(c.timeoutSec)}`);
    if (was.optional !== c.optional) diffs.push(c.optional ? "now optional (only when a rule or the thread adds it)" : "now runs on every branch");
    if (was.label !== c.label) diffs.push(`named ${was.label} → ${c.label}`);
    if ((was.cwd ?? "") !== (c.cwd ?? "")) diffs.push(`runs in ${was.cwd ?? "the root"} → ${c.cwd ?? "the root"}`);
    if (was.rerun !== c.rerun) diffs.push(c.rerun ? "failing tests now rerun narrowly" : "no narrow rerun");
    if (!!was.needsSelect !== !!c.needsSelect) diffs.push(c.needsSelect ? "a pick must now name its selection" : "a pick needs no selection");
    if (words(was.requires) !== words(c.requires)) diffs.push(`services ${was.requires.join(", ") || "none"} → ${c.requires.join(", ") || "none"}`);
    if (diffs.length) out.push({ tag: "change", stage: "checks", name: `Check ${c.label}`, detail: diffs.join("; ") });
  }
  for (const c of a.checks) if (!after.has(c.id)) out.push({ tag: "remove", stage: "checks", name: `Check ${c.label}`, detail: `No longer runs · ${words(c.run)}` });
  const ra = new Map(a.rules.map((r) => [ruleKey(r), r]));
  const rb = new Map(b.rules.map((r) => [ruleKey(r), r]));
  for (const [k, r] of rb) {
    const was = ra.get(k);
    if (!was) out.push({ tag: "add", stage: "rules", name: `Rule ${ruleName(r)}`, detail: r.why });
    else if (was.why !== r.why) out.push({ tag: "change", stage: "rules", name: `Rule ${ruleName(r)}`, detail: `reason: ${r.why}` });
  }
  for (const [k, r] of ra) if (!rb.has(k)) out.push({ tag: "remove", stage: "rules", name: `Rule ${ruleName(r)}`, detail: r.why });
  if (!a.review !== !b.review) out.push({ tag: b.review ? "add" : "remove", stage: "review", name: "Review", detail: b.review ? `The review kit in ${b.review.kit} reads every branch` : "No review step" });
  else if (a.review && b.review) {
    const d: string[] = [];
    if (a.review.kit !== b.review.kit) d.push(`kit ${a.review.kit} → ${b.review.kit}`);
    if ((a.review.model ?? "") !== (b.review.model ?? "")) d.push(`model ${a.review.model ?? "default"} → ${b.review.model ?? "default"}`);
    if ((a.review.thinking ?? "") !== (b.review.thinking ?? "")) d.push(`effort ${a.review.thinking ?? "default"} → ${b.review.thinking ?? "default"}`);
    if ((a.review.passes ?? 1) !== (b.review.passes ?? 1)) d.push(`${a.review.passes ?? 1} → ${b.review.passes ?? 1} passes`);
    if ((a.review.timeLimitMin ?? 0) !== (b.review.timeLimitMin ?? 0)) d.push(`time limit ${a.review.timeLimitMin ?? 20}m → ${b.review.timeLimitMin ?? 20}m`);
    if (words(a.review.tools ?? []) !== words(b.review.tools ?? [])) d.push(`tools ${a.review.tools?.join(", ") || "read-only"} → ${b.review.tools?.join(", ") || "read-only"}`);
    if (a.review.fixes !== b.review.fixes) d.push(b.review.fixes ? "the reviewer may fix what it finds" : "the reviewer only reports");
    if (d.length) out.push({ tag: "change", stage: "review", name: "Review", detail: d.join("; ") });
  }
  if (a.land.how !== b.land.how || a.land.squash !== b.land.squash)
    out.push({ tag: "change", stage: "land", name: "How it lands", detail: `${howWords[a.land.how]}${a.land.squash ? " as one commit" : ""} → ${howWords[b.land.how]}${b.land.squash ? " as one commit" : ""}` });
  if (a.push.on !== b.push.on || a.push.remote !== b.push.remote)
    out.push({ tag: "change", stage: "push", name: "Push", detail: `${a.push.on ? `pushed to ${a.push.remote}` : "not pushed"} → ${b.push.on ? `pushed to ${b.push.remote}` : "not pushed"}` });
  if (words(a.setup) !== words(b.setup) || words(a.install?.inputs ?? []) !== words(b.install?.inputs ?? []) || a.reuse !== b.reuse) {
    const d: string[] = [];
    if (words(a.setup) !== words(b.setup)) d.push(`setup steps ${a.setup.join(", ") || "none"} → ${b.setup.join(", ") || "none"}`);
    if (words(a.install?.inputs ?? []) !== words(b.install?.inputs ?? [])) d.push(b.install ? `installs when ${b.install.inputs.join(", ")} change` : "no install step");
    if (a.reuse !== b.reuse) d.push(b.reuse ? "passes on identical code are reused" : "every check runs in full");
    out.push({ tag: "change", stage: "copy", name: "Merge copy", detail: d.join("; ") });
  }
  if (!a.release !== !b.release) out.push({ tag: b.release ? "add" : "remove", stage: "release", name: "Releases", detail: b.release ? `Tagged ${b.release.tag}` : "No release setup" });
  else if (a.release && b.release) {
    const d: string[] = [];
    if (a.release.tag !== b.release.tag) d.push(`tag ${a.release.tag} → ${b.release.tag}`);
    const ca = a.release.checks.map((c) => c.id).join(","),
      cb = b.release.checks.map((c) => c.id).join(",");
    if (ca !== cb) d.push(`release checks ${ca || "none"} → ${cb || "none"}`);
    const sa = a.release.steps.map((s) => s.id).join(","),
      sb = b.release.steps.map((s) => s.id).join(",");
    if (sa !== sb) d.push(`steps ${a.release.steps.map((s) => s.label).join(", ") || "none"} → ${b.release.steps.map((s) => s.label).join(", ") || "none"}`);
    if (words(a.release.channels) !== words(b.release.channels)) d.push(`channels ${a.release.channels.join(", ") || "none"} → ${b.release.channels.join(", ") || "none"}`);
    if (d.length) out.push({ tag: "change", stage: "release", name: "Releases", detail: d.join("; ") });
  }
  return out;
}

const fromWords = (f: SetupMap["checksFrom"]): string => (f === "declared" ? "declared checks" : f === "none" ? "no automated tests" : f === "test-command" ? "the test command" : "not set up");
const minutes = (s: number): string => (s % 60 === 0 ? `${s / 60}m` : `${s}s`);

/** One version of the setup on the main branch: the commit that brought it in. */
export interface SetupVersion {
  /** 1 for the oldest version read; the newest is the one in force. */
  n: number;
  commit: string;
  at: string;
  subject: string;
  hash: string;
  changes: SetupChange[];
}

/** GET /api/merge-queue/projects/:project/setup-map: the setup in force, and the Setup chat's proposal while it has one. */
export interface SetupMapAnswer {
  main: SetupMap;
  /** The Setup chat's working copy, read live (uncommitted edits too); null: no Setup chat, or it changes nothing. */
  proposal: SetupMap | null;
  /** The Setup chat: whether it's working now (the proposal is still being written). */
  chat: { session: string; path?: string; state: "idle" | "working" | "waiting" | "proposed"; branch?: string } | null;
  /** setupChanges(main, proposal). */
  changes: SetupChange[];
  /** The version in force: its number and since when (from Setup history), when known. */
  version?: { n: number; at: string; earlier: number };
}

/** GET /api/merge-queue/projects/:project/setup-history: newest first. */
export interface SetupHistoryAnswer {
  versions: SetupVersion[];
  /** More versions are older than the ones read. */
  more: boolean;
}
