import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { LAND_HOWS, type LandHow } from "../../shared/merge-queue";

/**
 * How a project's approved branches land (al_3): merge locally (today's path, the default), a pull request on
 * GitHub, a merge request on GitLab, or the branch pushed and nothing more. Kept in two places: the project's file
 * (`merge.land`, shared with everyone running Sova on the repo) and this computer (`strategy.json` beside the queue's
 * records). This computer's choice wins; neither set reads "local", so every project already in the queue (Sova's
 * own included) stays on Merge locally until someone picks. The effective choice is pinned on each approval, so a
 * settings edit never redirects a branch already approved.
 */

export { LAND_HOWS, type LandHow };
export type RequestHow = Exclude<LandHow, "local">;
export const isLandHow = (v: unknown): v is LandHow => typeof v === "string" && (LAND_HOWS as readonly string[]).includes(v);
/** The strategies that publish the branch to origin (a request, or the push alone) instead of moving the target. */
export const publishes = (how: LandHow | undefined): how is RequestHow => !!how && how !== "local";
/** The strategies that open a request on a host. */
export const opensRequest = (how: LandHow | undefined): how is "github-pr" | "gitlab-mr" => how === "github-pr" || how === "gitlab-mr";

export const STRATEGY_FILE = "strategy.json";

export interface StrategyOverride {
  how: LandHow;
  at: string;
}

/** This computer's choice for the project whose queue records are in `dir`; null: none (or unreadable). */
export function readOverride(dir: string): StrategyOverride | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, STRATEGY_FILE), "utf8")) as Partial<StrategyOverride>;
    return isLandHow(raw.how) ? { how: raw.how, at: typeof raw.at === "string" ? raw.at : "" } : null;
  } catch {
    return null;
  }
}

/** Set (or with null, clear) this computer's choice. Atomic. */
export function writeOverride(dir: string, how: LandHow | null, at = new Date().toISOString()): void {
  const file = join(dir, STRATEGY_FILE);
  if (how === null) {
    rmSync(file, { force: true });
    return;
  }
  if (!isLandHow(how)) throw new Error(`not a way of landing: ${String(how)}`);
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ how, at })}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

export interface EffectiveHow {
  effective: LandHow;
  from: "computer" | "project" | "default";
  project?: LandHow;
  computer?: LandHow;
}

/** Effective = this computer ?? the project's file ?? local. `projectHow`: the target's `merge.land`. */
export function effectiveHow(projectHow: unknown, dir: string): EffectiveHow {
  const computer = readOverride(dir)?.how;
  const project = isLandHow(projectHow) ? projectHow : undefined;
  const effective = computer ?? project ?? "local";
  return { effective, from: computer ? "computer" : project ? "project" : "default", ...(project ? { project } : {}), ...(computer ? { computer } : {}) };
}

/** The strategy one approval lands by: the typed "open a PR/MR" (`via`) wins over the pinned effective one; an
 *  approval recorded before strategies existed (no `how`) is local. */
export function approvalHow(a: { how?: LandHow; via?: "github-pr" | "gitlab-mr" }): LandHow {
  return a.via ?? a.how ?? "local";
}

/**
 * The settings row's facts (MergeQueueSettings.how): the choice in effect and where it comes from, what origin's host
 * suggests, and, for a request strategy, whether this computer is signed in to that host. `hosts` is injectable for
 * tests (default server/merge-queue/hosts/). Never throws: a host that can't be asked reads as not signed in, with why.
 */
export async function landHowSetting(o: {
  dir: string;
  root: string;
  projectHow: unknown;
  hosts?: {
    suggest: (root: string) => Promise<{ how: LandHow; why: string; repo?: import("./hosts/types").HostRepo }>;
    adapterFor: (kind: import("./hosts/types").HostKind) => import("./hosts/types").HostAdapter;
  };
}): Promise<import("../../shared/merge-queue-settings").LandHowSetting> {
  const e = effectiveHow(o.projectHow, o.dir);
  let hosts = o.hosts;
  if (!hosts) {
    // Not hosts/index.ts: its origin reader (workspace-git.ts) pulls the org layer into the queue (projects/seam.test.ts).
    const [repoMod, gh, gl, { execFile }] = await Promise.all([import("./hosts/repo"), import("./hosts/github"), import("./hosts/gitlab"), import("node:child_process")]);
    const originOf = (r: string) => new Promise<string | null>((done) => execFile("git", ["remote", "get-url", "origin"], { cwd: r, timeout: 10_000 }, (err, out) => done(err ? null : String(out).trim() || null)));
    hosts = { suggest: async (r) => repoMod.suggestLanding(await originOf(r)), adapterFor: (k) => (k === "github" ? gh.githubAdapter() : gl.gitlabAdapter()) };
  }
  const h = hosts;
  let suggested: { how: LandHow; why: string; repo?: import("./hosts/types").HostRepo } | undefined;
  try {
    suggested = await h.suggest(o.root);
  } catch {
    suggested = undefined;
  }
  let signIn: { ok: boolean; why?: string } | undefined;
  if (opensRequest(e.effective)) {
    const kind = e.effective === "github-pr" ? "github" : "gitlab";
    const repo = suggested?.repo?.kind === kind ? suggested.repo : undefined;
    if (!repo) signIn = { ok: false, why: `origin isn't on ${kind === "github" ? "GitHub" : "GitLab"}, so a request can't be opened there` };
    else {
      try {
        const a = await h.adapterFor(kind).auth(repo);
        signIn = a.ok ? { ok: true } : { ok: false, why: a.why };
      } catch (err) {
        signIn = { ok: false, why: err instanceof Error ? err.message.split("\n")[0]! : String(err) };
      }
    }
  }
  return { ...e, ...(suggested ? { suggested: { how: suggested.how, why: suggested.why } } : {}), ...(signIn ? { signIn } : {}) };
}
