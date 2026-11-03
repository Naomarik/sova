// The Releases tab's client side: one call per user action, each a catalogue verb
// (`POST /api/project-services/release.*`, the project verbs in shared/commands/projects.ts). The
// browser is the operator; every refusal is a result, never thrown. Every action bumps
// `releaseChanged`, and the session feed's `release` frame carries the newest view.
import { createSignal } from "solid-js";
import type { ReleaseView } from "../../shared/release";
import { runReleaseVerb } from "./api";

export { runReleaseVerb };

const [changed, setChanged] = createSignal(0);
/** Bumped after every release action: readers read the view again. */
export const releaseChanged = changed;
export const noteReleaseChanged = () => setChanged((n) => n + 1);

const [feed, setFeed] = createSignal<{ project: string; view: ReleaseView } | null>(null);
/** The newest view the session feed pushed (`release`), for that project's tab and cards. */
export const releaseFeed = feed;
export const noteReleaseFeed = (msg: { project: string; view: ReleaseView }): void => void setFeed({ project: msg.project, view: msg.view });

/** The project's releases as release.status answers them. */
export async function readReleases(project: string): Promise<ReleaseView> {
  const r = await runReleaseVerb(project, "release.status");
  const v = r.release?.view;
  if (!v) throw new Error(r.error?.message ?? "Release status gave no answer.");
  return v;
}

/** A refusal's words, or null when it went through. */
export const releaseRefusal = (r: { ok: boolean; error?: { message: string } }): string | null => (r.ok ? null : (r.error?.message ?? "It was refused."));

/**
 * Plan Deploy of vX (§app.release hand-off): the Releases tab asks the Deploy card on the Overview to plan one
 * target at a release's commit. The card takes it once, plans it, and clears it.
 */
export interface DeployHandOff {
  projectId: string;
  target: string;
  commit: string;
  version: string;
}
const [handOff, setHandOff] = createSignal<DeployHandOff | null>(null);
export const deployHandOff = handOff;
export const askDeployPlan = (h: DeployHandOff) => setHandOff(h);
export const takeDeployHandOff = (projectId: string): DeployHandOff | null => {
  const h = handOff();
  if (!h || h.projectId !== projectId) return null;
  setHandOff(null);
  return h;
};
