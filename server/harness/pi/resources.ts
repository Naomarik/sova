// What pi loads for a session's prompt (§app.harness/session), in the contract's shape
// (HarnessResources): a held runtime's own loader, through the driving session (session.ts), or pi's loader
// without extensions for a folder no runtime holds (server/session-setup.ts). Paths only: the contents are
// pi's business.
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import type { HarnessResources } from "../../../shared/harness";
import { skillProblemsOf, withSkillSources } from "./skill-sources";

/** The four loader reads this needs, structurally: the SDK's `ResourceLoader` and `DefaultResourceLoader`
    both satisfy it. */
type Loader = Pick<DefaultResourceLoader, "getAgentsFiles" | "getSkills" | "getSystemPromptSource" | "getAppendSystemPromptSources">;

export function resourcesOf(loader: Loader): HarnessResources {
  const { skills, diagnostics } = loader.getSkills();
  const skillProblems = skillProblemsOf(skills, diagnostics);
  return {
    context: loader.getAgentsFiles().agentsFiles.map((f) => ({ path: f.path })),
    skills: skills.map((s) => ({ name: s.name, filePath: s.filePath, description: s.description, ...(s.disableModelInvocation ? { manualOnly: true } : {}) })),
    systemPrompt: loader.getSystemPromptSource()?.path,
    appendSystemPrompt: loader.getAppendSystemPromptSources().map((s) => s.path),
    ...(skillProblems.length ? { skillProblems } : {}),
  };
}

/** pi's own loader for a folder, without extensions: a lower bound (a skill path an extension registers at
    session_start is invisible to it). */
export async function folderResources(cwd: string, agentDir: string): Promise<HarnessResources> {
  const loader = new DefaultResourceLoader({ cwd, agentDir, ...withSkillSources(cwd, { noExtensions: true }) });
  await loader.reload();
  return resourcesOf(loader);
}
