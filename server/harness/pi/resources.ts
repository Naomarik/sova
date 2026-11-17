// What pi loads for a session's prompt (§app.harness/session), in the contract's shape
// (HarnessResources): a held runtime's own loader, through the driving session (session.ts), or pi's loader
// without extensions for a folder no runtime holds (server/session-setup.ts). Paths only: the contents are
// pi's business.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { HarnessResources } from "../../../shared/harness";
import { contextFileKeeper, projectFileKeeper } from "../../context-scope";
import type { PiLoaderOptions } from "./extension-types";
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
  const settingsManager = settingsWithoutLock(cwd, agentDir);
  const loader = new DefaultResourceLoader({ cwd, agentDir, ...(settingsManager ? { settingsManager } : {}), ...withContextScope(withSkillSources(cwd, { noExtensions: true }), cwd, agentDir) });
  await loader.reload();
  return resourcesOf(loader);
}

/**
 * The loader with a chat's context-file scope laid under its own overrides (server/context-scope.ts, P44, P45): pi's
 * context files are first cut to those a chat in `scopeCwd` may start with, and its skills to those that are real
 * files of the chat's project (a skill found in the project through a link out of it is dropped, its diagnostics with
 * it, so no rescue brings it back); only those lists reach the caller's `agentsFilesOverride` and `skillsOverride` (a
 * loadout's switches, a project overseer's confinement, the skill rescue), whose base they are. Every loader a chat's
 * runtime or a folder's read builds passes through here, so no caller can skip it. `scopeCwd` is the runtime's own
 * folder, or the stored one for a chat opened in the home folder because its folder is gone.
 */
export function withContextScope(loader: PiLoaderOptions, scopeCwd: string, agentDir: string): PiLoaderOptions {
  const home = homedir();
  const keep = contextFileKeeper(scopeCwd, { home, agentDir });
  const real = projectFileKeeper(scopeCwd, { home, agentDir });
  const ownFiles = loader.agentsFilesOverride;
  const ownSkills = loader.skillsOverride;
  return {
    ...loader,
    agentsFilesOverride: (base) => {
      const scoped = { ...base, agentsFiles: base.agentsFiles.filter((f) => keep(f.path)) };
      return ownFiles ? ownFiles(scoped) : scoped;
    },
    skillsOverride: (base) => {
      const scoped = { skills: base.skills.filter((s) => real(s.filePath)), diagnostics: base.diagnostics.filter((d) => !d.path || real(d.path)) };
      return ownSkills ? ownSkills(scoped) : scoped;
    },
  };
}

/** Reads of pi's settings files that skipped pi's lock, for tests. */
export const settingsReads = { unlocked: 0, locked: 0 };

/**
 * pi's two settings files for a folder (its settings folder's and the folder's own), each read once without pi's
 * lock: pi takes it to read too, a mkdir and an rmdir that wait on a busy disk, several per load. Undefined when a
 * file is there but can't be read cleanly (unreadable, or not JSON: say, read halfway through pi writing it), and
 * pi then reads them itself, locked, as before. A load never writes settings; this one refuses to.
 */
export function settingsWithoutLock(cwd: string, agentDir: string): SettingsManager | undefined {
  const files = { global: join(resolve(agentDir), "settings.json"), project: join(resolve(cwd), CONFIG_DIR_NAME, "settings.json") };
  const text: { global?: string; project?: string } = {};
  for (const scope of ["global", "project"] as const) {
    let t: string;
    try {
      t = readFileSync(files[scope], "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      settingsReads.locked++;
      return undefined;
    }
    try {
      JSON.parse(t.replace(/^\uFEFF/, ""));
    } catch {
      settingsReads.locked++;
      return undefined;
    }
    text[scope] = t;
  }
  settingsReads.unlocked++;
  return SettingsManager.fromStorage({
    withLock(scope, fn) {
      if (fn(text[scope]) !== undefined) throw new Error("A folder's resource load never writes pi's settings.");
    },
  });
}
