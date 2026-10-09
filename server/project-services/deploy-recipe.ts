import {
  CONTRACT_FILE,
  DefinitionError,
  deployStepsOf,
  parseDefinition,
  type DeployDecl,
  type DeployReview,
  type DeployStanding,
  type DeployTargetDecl,
  type DeployTargetReview,
  type ProjectDef,
} from "../../shared/project-contract";
import { realGit } from "./engine";
import { deployHashOf } from "./def-hash";
import { hostVars } from "./store";

/**
 * A deploy recipe as it reads at a ref, and as Sova renders it on this host (§app.project-services/deploy-plan,
 * §app.project-runtime/run-report): every resolved step of each target, in the order it runs.
 */

type Git = typeof realGit;

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

// ---- the rendering ----------------------------------------------------------------------------------------

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

/** A target as Sova renders it: every step's argv resolved on this host, in the order they run. Pure. */
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

/** The whole recipe, rendered on this host. */
export function deployReview(root: string, d: DeployDecl, mainBranch: string): DeployReview {
  const host = hostVars(root);
  const targets = d.targets.map((t) => targetReview(t, host, mainBranch));
  return { deployHash: deployHashOf(d), targets };
}

/** The main checkout's branch (the default branch a target ships from). */
export async function mainBranchOf(root: string, git: Git = realGit): Promise<string> {
  const r = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : "main";
}

/** The recipe at `ref` (a playbook's branch tip), rendered, or null when it declares none. */
export async function deployReviewAt(root: string, ref: string, git: Git = realGit): Promise<DeployReview | null> {
  const at = await definitionAt(root, ref, git);
  if (!at.def?.deploy) return null;
  return deployReview(root, at.def.deploy, await mainBranchOf(root, git));
}

// ---- standing (§app.project-runtime/deploy-standing) ---------------------------------------------------

/** A target's standing: `declared` while main's deploy declares it, `none` for one with history that main no longer declares. Pure. */
export function targetStanding(d: DeployDecl | undefined, name: string): DeployStanding {
  return d?.targets.some((x) => x.name === name) ? "declared" : "none";
}
