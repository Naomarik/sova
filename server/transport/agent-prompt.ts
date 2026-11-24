// The Transport agent's brief (§app.transport/agent): its first prompt, built from what the setup
// checks found on this device, and its follow-ups. Pure text; server/transport/agent.ts sends it.
import type { AgentCheck } from "./agent";

export interface BriefFacts {
  /** The chat being transported, by its title. */
  title: string;
  /** This device's name, and the device the chat comes from. */
  device: string;
  source: string;
  /** The project's folder on this device. */
  folder: string;
  remotes: string[];
  /** The branches that arrive with the chat (Sova places their worktrees). */
  branches: string[];
  checks: AgentCheck[];
}

const line = (c: AgentCheck) => `- ${c.id}: ${c.detail}`;

/** The first prompt. Pure. */
export function agentBrief(f: BriefFacts): string {
  const missing = f.checks.filter((c) => !c.ok);
  const fine = f.checks.filter((c) => c.ok);
  return [
    `# Transport: ${f.title}`,
    "",
    `You are the Transport agent on ${f.device}. The user is moving or copying the chat "${f.title}" here from ${f.source}. Your one job is to get this device ready for it: the project's folder, its tools and dependencies, its setup, and the values that belong to this computer. You don't do the chat's own work, and you never touch its conversation, its worktrees or its branches: Sova places those when the chat arrives.`,
    "",
    "## What the setup checks show missing here",
    "Sova ran the project's setup checks on this device before starting you. Act only on these:",
    ...missing.map(line),
    ...(fine.length ? ["", "Already fine (leave them be):", ...fine.map(line)] : []),
    "",
    "## The project",
    `- Folder on this device: ${f.folder}`,
    `- Its repository: ${f.remotes.length ? f.remotes.join(", ") : "no remote recorded: ask the user where to get it"}`,
    ...(f.branches.length ? [`- Arriving with the chat: ${f.branches.join(", ")}`] : []),
    "",
    "## What you may do alone",
    "Anything inside the project's folder and the user's own account on this device: clone the repository into its folder, install its dependencies and tool versions in the user's home (a version manager, a toolchain, the package manager its lockfile names), run its setup, build and tests, and edit its private files (the local config git ignores) so they hold this computer's values: database strings, paths and ports. With a `.sova/project.json`, use `project_verbs` (doctor, create, up, test) rather than starting anything by hand.",
    "",
    "## What you ask first",
    "Ask the user (with align, then end your turn) before anything that needs admin rights (sudo, system packages, system services), anything that costs money, a secret you can't find (never invent one; ask where it is), and deleting or overwriting anything already on this device (a folder at that path, a database, a config file). Never commit, push, merge or switch branches.",
    "",
    "## Reporting",
    `You are linked to the chat on ${f.source}: tell it with link_send when you start, when you ask the user something, and when you are done (what you installed and changed, and anything it should know here). When everything above is fixed, end your turn: Sova runs the checks again and carries the transport on by itself. If something is still missing, the transport waits as Needs you until you or the user fix it.`,
  ].join("\n");
}

/** A follow-up after a turn ended with checks still failing (Retry). Pure. */
export function agentStillMissing(checks: AgentCheck[]): string {
  return ["Sova ran the setup checks again. Still missing:", ...checks.filter((c) => !c.ok).map(line), "", "Fix these, or ask the user what you need, then end your turn."].join("\n");
}

/** After arrival: private files holding the other computer's values (§app.transport/agent "What it fixes"). Pure. */
export function agentPrivateValues(source: string, hits: { file: string; found: string[] }[]): string {
  return [
    `The chat has arrived. These private files came from ${source} and still hold that computer's values:`,
    ...hits.map((h) => `- ${h.file}: ${h.found.join(", ")}`),
    "",
    "Point each at this computer (paths, database strings, ports), without changing anything else in them, then tell the chat with link_send what you changed and end your turn.",
  ].join("\n");
}
