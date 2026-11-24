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
  /** The chat's own tree: the branch, and the commit when known, its folder must be checked out at. */
  checkout?: { branch: string; head?: string };
  checks: AgentCheck[];
  /** Sova's own folders on this device (state root, agent dir, chat homes): never written. */
  sovaFolders?: string[];
  /** After arrival: the chat is on this device now, so there is no link to report over. */
  arrived?: boolean;
  /** The user's home on this device: the only place to look for an existing copy. */
  home?: string;
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
    `- Its repository: ${f.remotes.length ? f.remotes.join(", ") : "no remote recorded"}`,
    `- Look for an existing copy only under this device's home (${f.home ?? "$HOME"}), never elsewhere on the disk. With no remote that works and no copy there, ask the user (align) where to get it and end your turn.`,
    ...(f.branches.length ? [`- Arriving with the chat: ${f.branches.join(", ")}`] : []),
    ...(f.checkout
      ? [
          `- When you clone it, check out ${f.checkout.branch}${f.checkout.head ? ` at commit ${f.checkout.head}` : ""} and leave the tracked files exactly as they are: Sova puts the chat's own unfinished changes on top when it arrives. If that branch${f.checkout.head ? " or commit" : ""} isn't on the remote, leave the clone on its default branch and say so.`,
        ]
      : []),
    "",
    "## What you may do alone",
    "Anything inside the project's folder and the user's own account on this device: clone the repository into its folder, install its dependencies and tool versions in the user's home (a version manager, a toolchain, the package manager its lockfile names), run its setup, build and tests, and edit its private files (the local config git ignores) so they hold this computer's values: database strings, paths and ports. With a `.sova/project.json`, use `project_verbs` (doctor, create, up, test) rather than starting anything by hand.",
    "",
    "## What you ask first",
    "Ask the user (with align, then end your turn) before anything that needs admin rights (sudo, system packages, system services), anything that costs money, a secret you can't find (never invent one; ask where it is), and deleting or overwriting anything already on this device (a folder at that path, a database, a config file). Never commit, push, merge or switch branches.",
    ...(f.sovaFolders?.length
      ? ["", `Never write into Sova's own folders (${f.sovaFolders.join(", ")}): to put a tool on the PATH, use the user's own bin folder or shell profile, never Sova's.`]
      : []),
    "",
    "## Reporting",
    f.arrived
      ? "The chat has arrived on this device already, and you have no link to it: say what you changed in your reply, then end your turn."
      : `You are linked to the chat on ${f.source}. Send it at most three messages with link_send: one when you start, one when you have to ask the user something, and one when you are done (what you installed and changed, and anything it should know here). Never answer a message from it that only acknowledges, thanks or repeats: act on one only when it asks you something or tells you something about getting this device ready, and then answer once. When everything above is fixed, end your turn: Sova runs the checks again, ends the link, and carries the transport on by itself. If something is still missing, the transport waits as Needs you until you or the user fix it.`,
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
    "Point each at this computer (paths, database strings, ports), without changing anything else in them, then say in your reply what you changed and end your turn.",
  ].join("\n");
}
