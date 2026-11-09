// Where a chat's skills come from, pi's half (§chat/skill-sources; the plain work is server/skill-sources.ts):
// the Claude folders added to a loader's options, a dropped skill rescued, and one skills folder read by
// pi's own rules. All of it pi's public API, leaning on what quirks P41 and P42 hold.
import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createSyntheticSourceInfo, loadSkillsFromDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { HarnessSkillProblem } from "../../../shared/harness";
import { claudeSkillPaths, quotedFrontMatter } from "../../skill-sources";
import type { FolderSkill } from "../../subfolder-skills";
import type { PiLoaderOptions, PiResourceDiagnostic, PiSkill } from "./extension-types";

/** A dropped SKILL.md's front matter as it reads once its risky values are quoted, or null: it can't be
    read that way either, or it isn't why the file was dropped. */
function quotedFront(filePath: string): Record<string, unknown> | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    parseFrontmatter(raw);
    return null; // YAML reads it: dropped for another reason (no description)
  } catch {
    // the case rescue is for
  }
  const fixed = quotedFrontMatter(raw);
  if (!fixed) return null;
  try {
    return parseFrontmatter(fixed).frontmatter as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** A SKILL.md pi's loader dropped because a plain value holds a YAML character, as the skill it means. */
export function rescuedSkill(filePath: string): PiSkill | null {
  const front = quotedFront(filePath);
  if (!front || typeof front.description !== "string" || !front.description.trim()) return null;
  const baseDir = dirname(filePath);
  return {
    name: typeof front.name === "string" && front.name ? front.name : basename(baseDir),
    description: front.description,
    filePath,
    baseDir,
    sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", baseDir }),
    disableModelInvocation: front["disable-model-invocation"] === true,
  };
}

/** A loader's skills result with each rescuable dropped skill back in it, losing to any of its name. */
export function withRescued(base: { skills: PiSkill[]; diagnostics: PiResourceDiagnostic[] }): { skills: PiSkill[]; diagnostics: PiResourceDiagnostic[] } {
  const skills = [...base.skills];
  const rescued = new Map<string, PiSkill>();
  for (const d of base.diagnostics) {
    if (d.type !== "warning" || !d.path || basename(d.path) !== "SKILL.md" || skills.some((s) => s.filePath === d.path) || rescued.has(d.path)) continue;
    const skill = rescuedSkill(d.path);
    if (skill) rescued.set(d.path, skill);
  }
  if (!rescued.size) return base;
  const diagnostics = base.diagnostics.filter((d) => !(d.type === "warning" && d.path && rescued.has(d.path)));
  for (const skill of rescued.values()) {
    const winner = skills.find((s) => s.name === skill.name);
    if (winner) diagnostics.push({ type: "collision", message: `name "${skill.name}" collision`, path: skill.filePath, collision: { resourceType: "skill", name: skill.name, winnerPath: winner.filePath, loserPath: skill.filePath } });
    else skills.push(skill);
  }
  return { skills, diagnostics };
}

/** `loader` with Claude's skill folders for `cwd` added after pi's own places, and dropped skills rescued
    before any override of its own. A loader with noSkills stays as it is: pi loads additional paths even
    then (quirk P42). */
export function withSkillSources(cwd: string, loader: PiLoaderOptions): PiLoaderOptions {
  if (loader.noSkills) return loader;
  const own = loader.skillsOverride;
  return {
    ...loader,
    additionalSkillPaths: [...(loader.additionalSkillPaths ?? []), ...claudeSkillPaths(cwd)],
    skillsOverride: (base) => {
      const rescued = withRescued(base);
      return own ? own(rescued) : rescued;
    },
  };
}

/** One skills folder by pi's own rules, rescue included. */
export function piSkillsIn(skillsDir: string): FolderSkill[] {
  return withRescued(loadSkillsFromDir({ dir: skillsDir, source: "project" })).skills.map((s) => ({ name: s.name, description: s.description, filePath: s.filePath, manualOnly: s.disableModelInvocation === true }));
}

/** The names a skill's front matter lists under `arguments` (a list, or words in a string), rescue
    included. None when it lists none or can't be read. */
export function skillArgumentNames(raw: string): string[] {
  let front: Record<string, unknown>;
  try {
    front = parseFrontmatter(raw).frontmatter as Record<string, unknown>;
  } catch {
    const fixed = quotedFrontMatter(raw);
    if (!fixed) return [];
    try {
      front = parseFrontmatter(fixed).frontmatter as Record<string, unknown>;
    } catch {
      return [];
    }
  }
  const a = front.arguments;
  if (Array.isArray(a)) return a.filter((x): x is string => typeof x === "string");
  return typeof a === "string" ? a.split(/\s+/).filter(Boolean) : [];
}

/** Whether pi's own /skill: expansion reads this file: its stripFrontmatter throws on what YAML refuses. */
export function piCanExpand(raw: string): boolean {
  try {
    parseFrontmatter(raw);
    return true;
  } catch {
    return false;
  }
}

/** The skills a loader dropped or passed over, by the loader's diagnostics: a warning about a file that
    still loaded names nothing, nor does a path pi couldn't find (Sova only adds what exists). */
export function skillProblemsOf(skills: readonly PiSkill[], diagnostics: readonly PiResourceDiagnostic[]): HarnessSkillProblem[] {
  const loaded = new Set(skills.map((s) => s.filePath));
  const out = new Map<string, HarnessSkillProblem>();
  for (const d of diagnostics) {
    if (d.type === "collision" && d.collision?.resourceType === "skill") {
      out.set(d.collision.loserPath, { name: d.collision.name, path: d.collision.loserPath, reason: "same-name", winnerPath: d.collision.winnerPath });
    } else if (d.type === "warning" && d.path && basename(d.path) === "SKILL.md" && !loaded.has(d.path) && !out.has(d.path)) {
      out.set(d.path, { name: basename(dirname(d.path)), path: d.path, reason: reasonOf(d.message) });
    }
  }
  return [...out.values()];
}

const reasonOf = (message: string): HarnessSkillProblem["reason"] => (message === "description is required" ? "no-description" : /ENOENT|EACCES|failed to read|permission/i.test(message) ? "unreadable" : "front-matter");
