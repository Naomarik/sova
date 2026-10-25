// What a hosted session's playbook extension (server/harness/pi/playbook.ts) asks the server: which
// playbook this session's schedule runs (checked against the keeper's store), and the entry whole for
// a re-prime after a compaction mid-run (§chat.schedules/delivery, §chat.schedules/playbook-read).
import type { PlaybookHost } from "./harness/pi/playbook";
import { deliveredHint } from "./playbook-tools";
import { playbookPayload } from "./playbook-payload";
import { scheduleKeeper } from "./schedules";

export const playbookHost: PlaybookHost = {
  bundleFor: (sessionId, hint) => scheduleKeeper()?.bundleFor(sessionId, hint) ?? Promise.resolve(null),
  async reprime(ctx) {
    const bundle = await scheduleKeeper()?.bundleFor(ctx.sessionId, deliveredHint(ctx));
    if (!bundle) return null;
    const p = playbookPayload(bundle, null);
    return { block: p.block, playbook: bundle.id, sha: p.sha };
  },
};
