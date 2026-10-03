/**
 * A fork's Claude Code side: where a fork of a claude-code-cli conversation picks up, so its
 * first request is the prefix the source's last turn cached instead of the whole history folded
 * into one new message (claude-code `provider/fork-point.ts`).
 *
 *  - a background fork's child is another process: the parent reads its fork point
 *    (`claudeForkPointFor` in background.ts) and hands it over in the child's environment;
 *  - a UI fork is hosted in the same process as its source: `seedClaudeFork` seeds the fork's own
 *    session with the source's point, taken at the fork's first turn only if the source's CLI is
 *    still exactly there.
 *
 * Builtins only (fork-point.ts reads the provider's process-global registry; it never loads the
 * provider): Sova's server imports this file.
 */
import { parentForkPoint, seedForkPoint } from "../../claude-code/provider/fork-point.ts";

/** Seed `forkId` with `sourceId`'s live, idle Claude CLI session, if it has one here. True when seeded. */
export function seedClaudeFork(sourceId: string, forkId: string): boolean {
	const point = parentForkPoint(sourceId);
	return point ? seedForkPoint(forkId, point, sourceId) : false;
}
