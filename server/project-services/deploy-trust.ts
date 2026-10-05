import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  CONTRACT_FILE,
  DefinitionError,
  deployStepsOf,
  parseDefinition,
  reviewKeys,
  type DeployDecl,
  type DeployReview,
  type DeployStanding,
  type DeployTargetDecl,
  type DeployTargetReview,
  type ProjectDef,
} from "../../shared/project-contract";
import { realGit } from "./engine";
import { servicesRoot } from "./store";
import { hashed, hostVars } from "./trust";

/**
 * Approval of a deploy recipe (§app.project-services/deploy-trust): the definition's `deploy` has a hash
 * of its own, `deployHash`, outside the definition's, so approving how a project runs locally never
 * approves how it ships, and a deploy edit never needs the services approved again. Only the operator
 * approves it, on Sova's own rendering of every resolved step, each ticked. Approvals live in
 * `<state root>/project-services/deploy-approvals.json` `{version: 1, approved: {<root>: {<deployHash>:
 * {at, targets: {<name>: <target hash>}}}}}`, outside every repo.
 */

type Git = typeof realGit;

export const deployApprovalsFile = () => join(servicesRoot(), "deploy-approvals.json");

const sha = (v: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(hashed(v, "deploy"))).digest("hex")}`;

/** The deploy recipe's hash: its canonical JSON without timeouts. */
export const deployHashOf = (d: DeployDecl): string => sha(d);
/** One target's hash (what an approval recorded of it, so a later change reads as stale). */
export const targetHashOf = (t: DeployTargetDecl): string => sha(t);

type Approvals = Record<string, Record<string, { at: string; targets: Record<string, string> }>>;

export function readDeployApprovals(file = deployApprovalsFile()): Approvals {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { version?: unknown; approved?: unknown };
    if (raw?.version !== 1 || !raw.approved || typeof raw.approved !== "object") return {};
    return raw.approved as Approvals;
  } catch {
    return {};
  }
}

export const deployApprovalOf = (root: string, hash: string, file = deployApprovalsFile()): { at: string } | null => readDeployApprovals(file)[root]?.[hash] ?? null;

export const CHANGED_SINCE_SHOWN = "The deploy recipe changed since it was shown: look again.";

/**
 * Approve `seen` for `root`: refused unless it is still the hash of `current`, and unless every key of
 * its review was ticked (`ticked`), so what is approved is each step the operator saw.
 */
export function approveDeploy(root: string, seen: string, current: DeployDecl, ticked: readonly string[], file = deployApprovalsFile()): void {
  const hash = deployHashOf(current);
  if (seen !== hash) throw new Error(CHANGED_SINCE_SHOWN);
  const keys = reviewKeys(current.targets.map((t) => ({ name: t.name, steps: deployStepsOf(t), verify: t.verify ?? null })));
  const have = new Set(ticked);
  const missing = keys.filter((k) => !have.has(k));
  if (missing.length) throw new Error(`Tick every step before approving: ${missing.length} not ticked (${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", …" : ""}).`);
  const all = readDeployApprovals(file);
  all[root] = { ...(all[root] ?? {}), [hash]: { at: new Date().toISOString(), targets: Object.fromEntries(current.targets.map((t) => [t.name, targetHashOf(t)])) } };
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: 1, approved: all }, null, 2)}\n`);
  renameSync(tmp, file);
}

/** The definition at `ref` of `root` (never a working tree): its commit, and the parse or why not. */
export async function definitionAt(root: string, ref: string, git: Git = realGit): Promise<{ commit: string | null; def: ProjectDef | null; error: string | null }> {
  const r = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], root);
  if (r.code !== 0) return { commit: null, def: null, error: `no commit ${ref}` };
  const commit = r.stdout.trim();
  const shown = await git(["show", `${commit}:${CONTRACT_FILE}`], root);
  if (shown.code !== 0) return { commit, def: null, error: `no ${CONTRACT_FILE} at ${ref}` };
  try {
    return { commit, def: parseDefinition(shown.stdout), error: null };
  } catch (err) {
    return { commit, def: null, error: err instanceof DefinitionError ? err.message : String(err) };
  }
}

/**
 * Approve the deploy recipe `seen` as it reads at `ref` (main's HEAD by default, or a playbook's branch tip):
 * refused when there is none there, when it is no longer the hash shown, or when a step was not ticked.
 */
export async function approveDeployAtRef(root: string, seen: string, ref: string, ticked: readonly string[], git: Git = realGit): Promise<{ hash: string; commit: string }> {
  const at = await definitionAt(root, ref, git);
  if (!at.def || !at.commit) throw new Error(at.error ? `There is no deploy recipe to approve at ${ref}: ${at.error}.` : `There is no deploy recipe to approve at ${ref}.`);
  if (!at.def.deploy) throw new Error(`The definition at ${ref} declares no deploy.`);
  approveDeploy(root, seen, at.def.deploy, ticked);
  return { hash: seen, commit: at.commit };
}

// ---- the review (what the operator ticks) -------------------------------------------------------------

const TOKEN = /\$\$|\$\{([^}]*)\}/g;

/** `t` with each `${host.NAME}` this host sets replaced by its value; the others, and the deploy's own variables, kept. */
export function resolveHost(t: string, host: Readonly<Record<string, string>>): { text: string; unset: string[] } {
  const unset: string[] = [];
  const text = t.replace(TOKEN, (m, key: string | undefined) => {
    if (m === "$$") return "$";
    if (key?.startsWith("host.")) {
      const v = host[key.slice(5)];
      if (v !== undefined && v !== "") return v;
      unset.push(key.slice(5));
    }
    return m;
  });
  return { text, unset };
}

/** A target as the operator ticks it: every step's argv resolved on this host, in the order they run. Pure. */
export function targetReview(t: DeployTargetDecl, host: Readonly<Record<string, string>>, mainBranch: string): DeployTargetReview {
  const steps = deployStepsOf(t).map((s) => {
    const parts = s.run.map((a) => resolveHost(a, host));
    return { key: s.key, list: s.list, id: s.id, argv: parts.map((p) => p.text), unset: [...new Set(parts.flatMap((p) => p.unset))] };
  });
  const verify = t.verify ? (() => {
    const r = resolveHost(t.verify.http, host);
    return { url: r.text, expect: t.verify.expect, unset: r.unset };
  })() : null;
  return {
    name: t.name,
    about: t.about,
    branch: t.branch ?? mainBranch,
    steps,
    credentials: t.credentials.map((c) => ({ name: c.name, kind: c.kind })),
    verify,
    rollback: typeof t.rollback === "string" ? t.rollback : "steps" in t.rollback ? "steps" : { none: t.rollback.none },
    tests: t.requires.tests,
  };
}

/** The whole recipe's review on this host. */
export function deployReview(root: string, d: DeployDecl, mainBranch: string): DeployReview {
  const host = hostVars(root);
  const targets = d.targets.map((t) => targetReview(t, host, mainBranch));
  return { deployHash: deployHashOf(d), targets, keys: reviewKeys(targets) };
}

/** The main checkout's branch (the default branch a target ships from). */
export async function mainBranchOf(root: string, git: Git = realGit): Promise<string> {
  const r = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : "main";
}

/** The review of the recipe at `ref` (a playbook's branch tip), or null when it declares none. */
export async function deployReviewAt(root: string, ref: string, git: Git = realGit): Promise<DeployReview | null> {
  const at = await definitionAt(root, ref, git);
  if (!at.def?.deploy) return null;
  return deployReview(root, at.def.deploy, await mainBranchOf(root, git));
}

// ---- standing (§app.project-runtime/deploy-standing) ---------------------------------------------------

/**
 * Each target's standing, by one rule: `approved` while this deploy hash is approved here; `stale` when an
 * earlier approval here covered the target (it changed since, or another target did); `awaiting-approval`
 * when none ever did; `none` for a target main no longer declares. Pure.
 */
export function targetStanding(root: string, d: DeployDecl | undefined, name: string, approvals: Approvals): DeployStanding {
  const t = d?.targets.find((x) => x.name === name);
  if (!d || !t) return "none";
  const mine = approvals[root] ?? {};
  if (mine[deployHashOf(d)]) return "approved";
  return Object.values(mine).some((a) => a.targets && name in a.targets) ? "stale" : "awaiting-approval";
}
