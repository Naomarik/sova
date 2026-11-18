// What a hosted session's playbook extension (server/harness/pi/playbook.ts) asks the server: which
// playbook this session runs (a schedule's, checked against the keeper's store, or a playbook run's it
// conducts, from the run store), and the entry whole for a re-prime after a compaction mid-run
// (§chat.schedules/delivery, §chat.schedules/playbook-read).
import type { BundleRef } from "../shared/playbook-delivery";
import type { PlaybookHost } from "./harness/pi/playbook";
import { deliveredHint } from "./playbook-tools";
import { playbookPayload } from "./playbook-payload";
import { conductedBy } from "./playbook-runs/store";
import { scheduleKeeper } from "./schedules";

/** The playbook of a run this session conducts, as a bundle. */
function runBundle(sessionId: string, hint?: { id: string; dir?: string }): BundleRef | null {
  const r = conductedBy(sessionId, hint);
  return r ? { id: r.playbook.id, dir: r.playbook.dir, entry: r.playbook.entry } : null;
}

async function bundleFor(sessionId: string, hint?: { id: string; dir?: string }): Promise<BundleRef | null> {
  return (await (scheduleKeeper()?.bundleFor(sessionId, hint) ?? Promise.resolve(null))) ?? runBundle(sessionId, hint);
}

export const playbookHost: PlaybookHost = {
  bundleFor,
  async reprime(ctx) {
    const bundle = await bundleFor(ctx.sessionId, deliveredHint(ctx));
    if (!bundle) return null;
    const p = playbookPayload(bundle, null);
    return { block: p.block, playbook: bundle.id, sha: p.sha };
  },
};
