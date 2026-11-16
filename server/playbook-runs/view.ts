// The card as the page draws it: a draft drawn now from the playbook and this
// computer; a started run from the plan Start froze, never drawn again.
import type { PlaybookRunView } from "../../shared/playbook-run";
import { liveEnv, loadPlaybook } from "./env";
import { runCard } from "./plan";
import type { PlaybookRunRecord } from "./store";

/** A card whose playbook can't be read now: what the run says of itself, and why. */
function bare(r: PlaybookRunRecord, error: string): PlaybookRunView {
  return {
    id: r.id,
    revision: r.revision,
    playbook: { source: r.playbook.source, id: r.playbook.id, title: r.playbook.title, dir: r.playbook.dir },
    state: r.state,
    choices: [],
    roles: [],
    teams: [],
    steps: [],
    cycle: null,
    howItRuns: "",
    commands: [],
    helpers: { total: 0, limit: 24 },
    startBlocked: error,
    error,
    ...(r.started ? { started: r.started } : {}),
    ...(r.startError ? { startError: r.startError } : {}),
  };
}

export async function runView(r: PlaybookRunRecord): Promise<PlaybookRunView> {
  if (r.plan && r.started) return { ...r.plan.view, id: r.id, revision: r.revision, state: r.state, started: r.started, startBlocked: "This run has started." };
  const loaded = await loadPlaybook(r.playbook, r.cwd).catch(() => null);
  if (!loaded) return bare(r, "The playbook is gone.");
  if (!loaded.spec) return bare(r, loaded.error ? `The playbook's description can't be read: ${loaded.error}` : "The playbook has no description.");
  const env = await liveEnv(loaded.spec, loaded.info, r.started?.chat.path ?? r.shownIn?.path, r.cwd);
  return runCard(r, loaded.spec, env).view;
}
