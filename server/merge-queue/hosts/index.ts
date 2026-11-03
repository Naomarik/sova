import { remoteOf } from "../../workspace-git";
import { githubAdapter } from "./github";
import { gitlabAdapter } from "./gitlab";
import { type LandingSuggestion, suggestLanding } from "./repo";
import { type CliRunner, realCli } from "./run";
import type { HostAdapter, HostKind } from "./types";

/** The host side of the merge queue's ways of landing: one adapter per host, the same calls for each (types.ts). */

export function adapterFor(kind: HostKind, run: CliRunner = realCli): HostAdapter {
  return kind === "github" ? githubAdapter(run) : gitlabAdapter(run);
}

/** The way of landing the project's origin suggests (a2): a suggestion only, never applied by itself. */
export async function suggestLandingFor(root: string, run: CliRunner = realCli): Promise<LandingSuggestion> {
  return suggestLanding(await remoteOf(root), { run });
}

export { githubAdapter, gitlabAdapter };
export { type LandingSuggestion, glabKnowsHost, remoteParts, repoOf, suggestLanding } from "./repo";
export { type CliResult, type CliRunner, hostCliEnv, realCli, sanitizeCliError } from "./run";
export * from "./types";
export * from "./request-kit";
export { GH_PR_FIELDS, ghChecks, ghFacts } from "./github";
export { glabChecks, glabFacts } from "./gitlab";
