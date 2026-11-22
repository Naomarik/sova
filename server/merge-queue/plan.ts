import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { CheckPick, LandHow, PlanStep, RunPlan, RunPlanInputs, RunRanWith, RunStep } from "../../shared/merge-queue";
import type { MergeCheckDecl, ProjectDef } from "../../shared/project-contract";
import { remoteOf } from "../../shared/project-contract";
import { checksOf, type PlannedCheck, planChecks } from "./checks";
import { gitProc } from "./copy";
import type { RulesRefusal } from "./rules";

/**
 * A run's plan, worked out before it starts (§app.merge-queue/plan): every step it will take and every optional one it
 * won't, each with why, and a fingerprint of everything the plan depends on (RunPlanInputs). `planOf` is pure: the same
 * facts give the same plan. `planFactsOf` reads the facts from git in the main checkout (never the merge copy): the
 * definition and review kit as they read after the merge (`git merge-tree`), the branch's changed paths, its folder
 * rules (rules.ts planRulesFor).
 */

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const short = (s: string): string => s.slice(0, 7);

/** Canonical JSON: keys sorted at every level, so the same inputs always hash the same. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

/** The plan's fingerprint: 16 hex over its canonical inputs. */
export const planFingerprint = (inputs: RunPlanInputs): string => sha(canonical(inputs)).slice(0, 16);

/** The picks' hash (id and selection, in order): "" for none. Late picks (addedAt) are never in the start's hash. */
export const picksHash = (picks: readonly Pick<CheckPick, "id" | "select">[]): string => (picks.length ? sha(canonical(picks.map((p) => [p.id, p.select ?? []]))).slice(0, 16) : "");

/** The target definition's parts the step list comes from (the check LIST is main's, q10). */
export function setupHash(def: ProjectDef | null): string {
  if (!def) return "";
  return sha(canonical({ merge: def.merge ?? null, setup: def.setup ?? [], test: def.test ?? null })).slice(0, 16);
}

/** Everything a plan is worked out from. */
export interface PlanFacts {
  /** The definition the step list comes from: the target's (a branch that fixes an invalid one: its own). */
  def: ProjectDef | null;
  target: string;
  base: string;
  commit: string;
  resolution?: string;
  release?: { id: string; checks: MergeCheckDecl[] };
  /** A tag-only release: the frozen target's checks, nothing merged or moved. */
  tryOnly?: true;
  /** The merge thread's picks at the start. */
  picks: CheckPick[];
  /** The branch's folder rules as they read after the merge (rules.ts planRulesFor). */
  rules: { hash: string; own: boolean; triggers: CheckPick[]; unknown?: string[]; refused?: RulesRefusal };
  /** The branch's changed paths against the target. */
  changed: string[];
  /** The review kit the run reviews with; `hash` null: no review step (`skip` says why). */
  review: { kit?: string; hash: string | null; own?: boolean; skip?: string };
  clean?: "operator" | "weekly" | "new";
  drafts?: { hash: string; names: string[] };
  withoutSpecs?: boolean;
  how: LandHow;
  squash?: boolean;
  /** The publish scan "Private names and secrets" (names-step.ts scanPlanned). */
  scan: { run: true } | { run: false; why: string };
  /** The push: will it go, and why not. */
  push: { will: "run" | "skip" | "if"; why?: string };
  /** The merged tree has submodules / LFS files (shapes' steps after the merge). */
  submodules?: boolean;
  lfs?: boolean;
}

/** The plan of these facts, and the exact check list the run runs (RunInput.planned). Pure. */
export function planOf(f: PlanFacts, at: string): { plan: RunPlan; planned: PlannedCheck[] } {
  const def = f.def;
  const declared = checksOf(def);
  const planned = planChecks(def, f.picks, f.release?.checks ?? [], f.rules.triggers);
  const flags = [
    ...(f.withoutSpecs ? ["without-specs"] : []),
    ...(f.review.hash === null && f.review.skip ? [`review:${f.review.skip}`] : []),
    ...(f.drafts && !f.withoutSpecs ? [`drafts:${f.drafts.hash}`] : []),
    ...(f.release ? [`release:${f.release.id}`] : []),
    `how:${f.how}${f.squash ? ":squash" : ""}`,
    `push:${f.push.will}${f.push.why ? `:${f.push.why}` : ""}`,
    `scan:${f.scan.run ? "run" : f.scan.why}`,
    ...(f.tryOnly ? ["tag-only"] : []),
    ...(f.submodules ? ["submodules"] : []),
    ...(f.lfs ? ["lfs"] : []),
  ].sort();
  const inputs: RunPlanInputs = {
    commit: f.commit,
    base: f.base,
    ...(f.resolution ? { resolution: f.resolution } : {}),
    scope: f.release ? "release" : "merge",
    setup: setupHash(def),
    rules: f.rules.hash,
    ...(f.rules.own ? { ownRules: true as const } : {}),
    review: f.review.hash,
    ...(f.review.own ? { ownReview: true as const } : {}),
    picks: picksHash(f.picks),
    clean: !!f.clean,
    changed: sha(f.changed.join("\n")).slice(0, 16),
    flags,
  };
  const steps: PlanStep[] = [];
  const add = (s: PlanStep) => steps.push(s);
  add({ id: "copy", kind: "copy", label: "Merge copy", will: "run", why: f.clean ? `a clean run (${f.clean === "operator" ? "asked for" : f.clean === "weekly" ? "the weekly one" : "a new copy"}): nothing reused` : "the merge copy is reused: installed packages and build output stay" });
  if (f.tryOnly) add({ id: "merge", kind: "merge", label: "Merge", will: "skip", why: `a tag-only release: ${f.target} itself is checked, nothing merged` });
  else add({ id: "merge", kind: "merge", label: f.resolution ? "Take the conflict resolution" : f.squash ? `Squash ${short(f.commit)} onto ${f.target}` : `Merge ${short(f.commit)} onto ${f.target}`, will: "run" });
  if (f.submodules) add({ id: "submodules", kind: "copy", label: "Submodules", will: "run", why: "the project has submodules" });
  if (f.lfs) add({ id: "lfs", kind: "copy", label: "Large files (LFS)", will: "run", why: "the project keeps files in LFS" });
  // Branch rules the run refuses (rules.ts rulesRefusal): the run stops right here, failed, with these words, and never
  // runs the checks those rules name (§app.merge-queue/rules).
  const refused = f.rules.refused;
  const refusedCheck = (id: string) => !!refused?.checks.some((x) => id === x || id.startsWith(`${x}+`));
  if (refused) add({ id: "rules", kind: "check", label: "Folder rules", will: "refused", why: refused.why });
  for (const s of def?.setup ?? []) add({ id: `setup:${s.id}`, kind: "setup", label: `Setup: ${s.id}`, will: f.clean ? "run" : "if", why: f.clean ? "run afresh on a clean run" : "only if its command or inputs changed since the last run" });
  const inst = def?.merge?.install;
  if (inst) {
    const hits = f.changed.filter((p) => inst.inputs.includes(p));
    add({ id: "install", kind: "install", label: "Install dependencies (offline)", will: hits.length ? "run" : "skip", why: hits.length ? `${hits.join(", ")} changed` : `no change to ${inst.inputs.join(", ") || "its inputs"}` });
  }
  if (f.withoutSpecs) add({ id: "docs", kind: "docs", label: "Spec drafts made official", will: "skip", why: "landed without its specs" });
  else if (f.drafts?.names.length) add({ id: "docs", kind: "docs", label: "Spec drafts made official", will: "run", why: `${f.drafts.names.length} draft${f.drafts.names.length === 1 ? "" : "s"}: ${f.drafts.names.slice(0, 3).join(", ")}${f.drafts.names.length > 3 ? ", …" : ""}` });
  else add({ id: "docs", kind: "docs", label: "Spec drafts made official", will: "skip", why: "no spec drafts" });
  if (declared === "none" && !planned.length) add({ id: "checks", kind: "check", label: "Checks", will: "skip", why: "the project declares no automated tests: it lands after a clean merge" });
  for (const c of planned)
    if (refusedCheck(c.id)) add({ id: `check:${c.id}`, kind: "check", label: c.label, will: "skip", why: refused!.why, ...(c.select?.length ? { select: [...c.select] } : {}) });
    else add({ id: `check:${c.id}`, kind: "check", label: c.label, will: "run", source: c.source, ...(c.why ? { why: c.source === "trigger" ? `Triggered: ${c.why}` : c.why } : {}), ...(c.select?.length ? { select: [...c.select] } : {}) });
  // Optional checks this run leaves out, each with why (§app.merge-queue/checks).
  const decls = declared === "declared" ? (def!.merge!.checks as MergeCheckDecl[]) : [];
  const leftOut = decls.filter((x) => x.optional && !planned.some((p) => p.id === x.id || p.id.startsWith(`${x.id}+`)));
  for (const d of leftOut) add({ id: `check:${d.id}`, kind: "check", label: d.label, will: "skip", why: refusedCheck(d.id) ? refused!.why : "optional: the merge thread didn't pick it, and no folder rule set it off" });
  for (const u of f.rules.unknown ?? []) add({ id: `rule:${steps.length}`, kind: "check", label: "Folder rule", will: "skip", why: u });
  if (f.review.hash === null) add({ id: "review", kind: "review", label: "Review", will: "skip", why: f.review.skip ?? "no review kit" });
  else add({ id: "review", kind: "review", label: "Review", will: "run", why: `review kit ${f.review.kit ?? ""}${f.review.own ? "; this branch changed its own review" : ""}`.trim() });
  // The scan is the run's last step, after the checks and the review, before anything lands (names-step.ts).
  add({ id: "scan", kind: "scan", label: "Private names and secrets", will: f.scan.run ? "run" : "skip", ...(f.scan.run ? {} : { why: f.scan.why }) });
  if (f.tryOnly) add({ id: "land", kind: "land", label: `Land on ${f.target}`, will: "skip", why: `a tag-only release moves nothing` });
  else if (f.how === "local") {
    add({ id: "land", kind: "land", label: `Land on ${f.target}`, will: "run", why: f.squash ? `${f.target} moves to one commit holding the branch's change` : `${f.target} fast-forwards to the tested commit` });
    add({ id: "main-checkout", kind: "main-checkout", label: "Main folder moved too", will: "run" });
  } else add({ id: "land", kind: "land", label: f.how === "push-branch" ? "Push the branch" : "Open the request", will: "run", why: "the host lands it" });
  if (f.how === "local") add({ id: "push", kind: "push", label: "Push", will: f.push.will, ...(f.push.why ? { why: f.push.why } : {}) });
  const plan: RunPlan = { fingerprint: planFingerprint(inputs), inputs, steps, at };
  return { plan, planned };
}

/**
 * Late picks (q9) join a saved plan: each a step marked with its arrival time, and `late` the grown plan's picks and
 * fingerprint. The start's fingerprint never changes. Pure; `null` when nothing new arrived.
 */
export function withLatePicks(plan: RunPlan, checks: readonly (CheckPick & { addedAt?: string })[], allPicks: readonly Pick<CheckPick, "id" | "select">[]): RunPlan | null {
  const late = checks.filter((c) => c.addedAt && !plan.steps.some((s) => s.id === `check:${c.id}` && s.will === "run"));
  if (!late.length) return null;
  const steps = [...plan.steps];
  for (const c of late) {
    const i = steps.findIndex((s) => s.id === `check:${c.id}`);
    const step: PlanStep = { id: `check:${c.id}`, kind: "check", label: c.label, will: "run", source: c.source, late: c.addedAt!, why: c.why ? `added after the start: ${c.why}` : "added after the start", ...(c.select?.length ? { select: [...c.select] } : {}) };
    if (i >= 0) steps[i] = step;
    else {
      // Before the steps after the checks (review, land, scan, push), after the last check.
      const after = steps.map((s) => s.kind).lastIndexOf("check");
      steps.splice(after + 1, 0, step);
    }
  }
  const picks = picksHash(allPicks);
  return { ...plan, steps, late: { picks, fingerprint: planFingerprint({ ...plan.inputs, picks }) } };
}

// ---- reading the facts (git, in the main checkout) -------------------------------------------------

/** The tree the merge of `commit` onto `base` makes (`git merge-tree`): null when git can't say. A conflict still
 *  answers its tree (the run stops at the conflict anyway). */
export async function mergedTree(root: string, base: string, commit: string): Promise<string | null> {
  const r = await gitProc(root, ["merge-tree", "--write-tree", "--no-messages", base, commit], { timeoutMs: 60_000 });
  const tree = r.out.trim().split("\n")[0]?.trim() ?? "";
  return /^[0-9a-f]{40,64}$/.test(tree) ? tree : null;
}

/** Does the tree hold submodules (.gitmodules) or LFS files (filter=lfs in .gitattributes)? */
export async function treeShapes(root: string, tree: string): Promise<{ submodules: boolean; lfs: boolean }> {
  const has = async (path: string) => (await gitProc(root, ["cat-file", "-e", `${tree}:${path}`], { timeoutMs: 30_000 })).code === 0;
  const attrs = await gitProc(root, ["show", `${tree}:.gitattributes`], { timeoutMs: 30_000 });
  return { submodules: await has(".gitmodules"), lfs: attrs.code === 0 && /filter=lfs/.test(attrs.out) };
}

// ---- what a run ran with --------------------------------------------------------------------------

/** Tool names whose version a run records, when its commands name them (never a project's own script). */
export const VERSIONED_TOOLS = ["node", "bun", "deno", "pnpm", "npm", "yarn", "npx", "python", "python3", "pip", "uv", "poetry", "go", "cargo", "rustc", "java", "mvn", "gradle", "clojure", "lein", "ruby", "bundle", "php", "composer", "dotnet", "make", "cmake", "mise", "tsc"];

/** The allow-listed tools a definition's commands start with, plus git, in a stable order. */
export function toolsOf(def: ProjectDef | null, planned: readonly PlannedCheck[]): string[] {
  const argvs = [...(def?.setup ?? []).map((s) => s.run), ...(def?.merge?.install ? [def.merge.install.run] : []), ...planned.map((c) => c.run)];
  const names = new Set<string>(["git"]);
  for (const a of argvs) {
    const first = a[0] ?? "";
    // A path (./scripts/x, bin/x) is the project's own: never run for a version.
    if (!first || first.includes("/")) continue;
    if (VERSIONED_TOOLS.includes(first)) names.add(first);
  }
  return [...names].sort((a, b) => (a === "git" ? -1 : b === "git" ? 1 : a.localeCompare(b)));
}

/** A tool's absolute path on the server's PATH (never a relative one), or null. */
export function onPath(name: string, path = process.env.PATH ?? ""): string | null {
  for (const dir of path.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const f = join(dir, name);
    try {
      accessSync(f, constants.X_OK);
      return f;
    } catch {}
  }
  return null;
}

const versionCache = new Map<string, { at: number; v: Promise<string | null> }>();
/** `<tool> --version`'s first line, as the server resolves the tool (from `cwd`, the run's own records folder, never
 *  the merge copy, whose tool config the branch controls). Cached for 10 minutes. */
export function toolVersion(name: string, cwd: string, now = Date.now()): Promise<string | null> {
  const hit = versionCache.get(name);
  if (hit && now - hit.at < 600_000) return hit.v;
  const bin = onPath(name);
  const v = !bin
    ? Promise.resolve(null)
    : new Promise<string | null>((resolve) => {
        execFile(bin, [name === "go" ? "version" : "--version"], { cwd, timeout: 5000, maxBuffer: 64 * 1024, env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" } }, (err, stdout, stderr) => {
          const line = `${stdout || stderr || ""}`.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
          resolve(err && !line ? null : line.slice(0, 120) || null);
        });
      });
  versionCache.set(name, { at: now, v });
  return v;
}

/** The settings in force for a run, in words. */
export function settingsOf(f: PlanFacts, planned: readonly PlannedCheck[]): RunRanWith["settings"] {
  const how = f.how === "local" ? (f.squash ? "merge locally, one commit" : "merge locally") : f.how === "github-pr" ? "a pull request on GitHub" : f.how === "gitlab-mr" ? "a merge request on GitLab" : "push the branch only";
  return [
    { name: "How it lands", value: how },
    { name: "Remote", value: remoteOf(f.def) },
    { name: "Push", value: f.push.will === "skip" ? `no (${f.push.why ?? "off"})` : f.push.will === "if" ? `held (${f.push.why ?? "waits"})` : "yes" },
    { name: "Merge copy", value: f.clean ? `clean run (${f.clean})` : "reused" },
    { name: "Review", value: f.review.hash === null ? `off (${f.review.skip ?? "no kit"})` : `${f.review.kit ?? "kit"}${f.review.own ? " (the branch's own)" : ""}` },
    { name: "Folder rules", value: f.rules.hash ? (f.rules.own ? "the branch's own (changed)" : "the branch's") : "none" },
    ...planned.map((c) => ({ name: `Time limit · ${c.label}`, value: `${c.timeoutSec} s` })),
  ];
}

/** What the steps say the run reused (setup steps skipped as unchanged; test files whose earlier passes stood). */
export function reuseOf(steps: readonly RunStep[]): Pick<RunRanWith, "setup" | "checksReused"> {
  const setup = steps.filter((s) => s.kind === "setup" && s.id.startsWith("setup:")).map((s) => ({ id: s.id.slice("setup:".length), reused: s.result === "skipped" }));
  const reused = steps.filter((s) => s.kind === "check" && (s.reused ?? 0) > 0).map((s) => ({ id: s.id.replace(/^check:/, ""), files: s.reused! }));
  return { setup, ...(reused.length ? { checksReused: reused } : {}) };
}
