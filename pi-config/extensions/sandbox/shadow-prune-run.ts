/**
 * The cache cleanup's child process (shadow-prune.ts `startPrune`): one run at low priority, its
 * result as one JSON line on stdout. Argument: `{agentDir, mode, settings}` as JSON.
 */
import { runChild } from "./shadow-prune.ts";

runChild(process.argv[2] ?? "{}");
