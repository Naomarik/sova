// A Lookbook run's design skills: which folders holding SKILL.md its Creative Director and designers use, and the
// designers' one way to read them. The project's own skills (found in the run's folder by the harness's loader) are
// always in; a folder the user named for the run joins it. The designers have no file tools: `design_skill` reads only
// inside the skill folders their own design record names, by their real paths, text files only, a size at a time.
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DesignSkill, DesignSkillMissing } from "../../shared/design";
import { folderResources } from "../harness/pi/resources";
import { piSkillsIn } from "../harness/pi/skill-sources";
import { agentRoot } from "../state-root";

export const DESIGN_SKILL_TOOL = "design_skill";

export const SKILL_LIMITS = Object.freeze({
  /** The most skills one run carries. */
  perRun: 20,
  /** The most names the main chat may pass for one run. */
  named: 10,
  /** One read's most bytes. */
  readBytes: 200_000,
  /** A listing's most files, and how deep it goes. */
  listFiles: 300,
  listDepth: 6,
  /** What one design is reckoned to read of its skills, in tokens, at most: the estimate's allowance. */
  readTokens: 40_000,
});

/** The file types a designer may read: text a page can take tokens and rules from. */
export const SKILL_TEXT_TYPES: ReadonlySet<string> = new Set([".md", ".markdown", ".css", ".html", ".htm", ".json", ".svg", ".txt"]);

/** The folder a run's project skills belong to: the nearest folder above `cwd` holding .git, else `cwd` itself. */
function projectTop(cwd: string): string {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
}

const real = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
const inside = (p: string, root: string): boolean => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

type Listed = { name: string; filePath: string; description?: string };
export interface SkillLister {
  /** Every skill the harness loads for a folder, project and personal alike. */
  all(cwd: string): Promise<readonly Listed[]>;
}
const harnessLister: SkillLister = { all: async (cwd) => (await folderResources(cwd, agentRoot())).skills };

const skillOf = (s: Listed, from: DesignSkill["from"]): DesignSkill => ({ name: s.name, description: (s.description ?? "").trim(), dir: dirname(s.filePath), from });

/** The skill a folder holds, read by the harness's rules; one whose front matter can't be read still counts by its folder's name. */
function folderSkill(dir: string): DesignSkill | null {
  const file = join(dir, "SKILL.md");
  try {
    if (!statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  const found = piSkillsIn(dir).find((s) => s.filePath === file);
  return { name: found?.name || basename(dir), description: (found?.description ?? "").trim(), dir, from: "named" };
}

const expandHome = (p: string): string => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const looksLikePath = (s: string): boolean => s.startsWith("/") || s === "~" || s.startsWith("~/");

/** One name the user gave, as a skill: a path to a folder holding SKILL.md (or to the SKILL.md itself), or a skill's name. */
function namedSkill(asked: string, all: readonly Listed[]): DesignSkill | DesignSkillMissing {
  if (looksLikePath(asked)) {
    let p = resolve(expandHome(asked));
    if (basename(p) === "SKILL.md") p = dirname(p);
    if (!isAbsolute(p) || !existsSync(p)) return { asked, reason: "There is no such folder." };
    try {
      if (!statSync(p).isDirectory()) return { asked, reason: "That isn't a folder." };
    } catch {
      return { asked, reason: "That folder can't be read." };
    }
    return folderSkill(p) ?? { asked, reason: "That folder holds no SKILL.md." };
  }
  const want = asked.trim().toLowerCase();
  const hit = all.find((s) => s.name.toLowerCase() === want) ?? all.find((s) => basename(dirname(s.filePath)).toLowerCase() === want);
  return hit ? skillOf(hit, "named") : { asked, reason: "No skill by that name was found." };
}

/** A run's skills: the project's own, then each one the user named, once each by real folder. */
export async function runSkills(cwd: string, named: readonly string[] = [], lister: SkillLister = harnessLister): Promise<{ skills: DesignSkill[]; missing: DesignSkillMissing[] }> {
  let all: readonly Listed[] = [];
  try {
    all = await lister.all(cwd);
  } catch (err) {
    console.warn(`[design] the skills of ${cwd} weren't read: ${err instanceof Error ? err.message : String(err)}`);
  }
  const top = real(projectTop(cwd)) ?? resolve(cwd);
  const skills: DesignSkill[] = [];
  const missing: DesignSkillMissing[] = [];
  const seen = new Set<string>();
  const add = (s: DesignSkill): void => {
    const key = real(s.dir) ?? s.dir;
    if (seen.has(key) || skills.length >= SKILL_LIMITS.perRun) return;
    seen.add(key);
    skills.push(s);
  };
  for (const s of all) {
    const dir = real(dirname(s.filePath));
    if (dir && inside(dir, top)) add(skillOf(s, "project"));
  }
  const asked = [...new Set(named.map((n) => n.trim()).filter(Boolean))].slice(0, SKILL_LIMITS.named);
  for (const n of asked) {
    const r = namedSkill(n, all);
    if ("reason" in r) missing.push(r);
    else add(r);
  }
  return { skills, missing };
}

/** The names a tool call passed, kept to strings. */
export const skillNamesOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0 && x.length <= 1024) : []);

// ---- the designer's reader -----------------------------------------------------------------------

export type SkillRoot = { name: string; dir: string };

/** Why a read is refused, in words the model can act on. */
export class SkillReadRefused extends Error {}

function rootOf(roots: readonly SkillRoot[], skill: string): { root: SkillRoot; realDir: string } {
  const root = roots.find((r) => r.name === skill) ?? roots.find((r) => r.name.toLowerCase() === skill.trim().toLowerCase());
  if (!root) throw new SkillReadRefused(`No skill "${skill}" is yours to read. Yours: ${roots.map((r) => r.name).join(", ") || "none"}.`);
  const realDir = real(root.dir);
  if (!realDir) throw new SkillReadRefused(`The skill "${root.name}" can no longer be found.`);
  return { root, realDir };
}

/** Every root's real folder: a symlink inside one skill may point into another of the design's skills, never elsewhere. */
const realRoots = (roots: readonly SkillRoot[]): string[] => roots.map((r) => real(r.dir)).filter((d): d is string => !!d);

/** A skill's files, relative to its folder, with their sizes; only what stays inside the design's skill folders. */
export function listSkillFiles(roots: readonly SkillRoot[], skill: string): { skill: string; files: { path: string; bytes: number; text: boolean }[]; more: boolean } {
  const { root, realDir } = rootOf(roots, skill);
  const allowed = realRoots(roots);
  const files: { path: string; bytes: number; text: boolean }[] = [];
  let more = false;
  const walk = (dir: string, rel: string, depth: number, seen: Set<string>): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of entries) {
      if (files.length >= SKILL_LIMITS.listFiles) return void (more = true);
      if (name === ".git" || name === "node_modules") continue;
      const path = join(dir, name);
      const target = real(path);
      if (!target || !allowed.some((a) => inside(target, a))) continue;
      let st;
      try {
        st = statSync(target);
      } catch {
        continue;
      }
      const relPath = rel ? `${rel}/${name}` : name;
      if (st.isDirectory()) {
        if (depth < SKILL_LIMITS.listDepth && !seen.has(target)) walk(target, relPath, depth + 1, new Set([...seen, target]));
      } else if (st.isFile()) files.push({ path: relPath, bytes: st.size, text: SKILL_TEXT_TYPES.has(extname(target).toLowerCase()) });
    }
  };
  walk(realDir, "", 0, new Set([realDir]));
  return { skill: root.name, files, more };
}

/** One text file of a skill, by its path inside the skill's folder. Refused: an absolute path, any `..`, a symlink out of the
    design's skill folders, a type that isn't text, or a file over the size a read may take. */
export function readSkillFile(roots: readonly SkillRoot[], skill: string, file: string): { skill: string; path: string; text: string } {
  const { root, realDir } = rootOf(roots, skill);
  const asked = file.trim();
  if (!asked) throw new SkillReadRefused("Name a file inside the skill, such as SKILL.md.");
  if (asked.includes("\0") || isAbsolute(asked) || /^[a-zA-Z]:/.test(asked) || asked.startsWith("~")) throw new SkillReadRefused("Give the file's path inside the skill's folder, not an absolute path.");
  if (asked.split(/[\\/]+/).includes("..")) throw new SkillReadRefused("A path may not go up out of the skill's folder (..).");
  const target = real(join(realDir, asked));
  if (!target) throw new SkillReadRefused(`The skill "${root.name}" has no file ${asked}. Call ${DESIGN_SKILL_TOOL} with only the skill to list its files.`);
  if (!realRoots(roots).some((a) => inside(target, a))) throw new SkillReadRefused(`${asked} leads outside the skill's folder, so it can't be read.`);
  let st;
  try {
    st = lstatSync(target);
  } catch {
    throw new SkillReadRefused(`${asked} can't be read.`);
  }
  if (!st.isFile()) throw new SkillReadRefused(`${asked} isn't a file. Call ${DESIGN_SKILL_TOOL} with only the skill to list its files.`);
  if (!SKILL_TEXT_TYPES.has(extname(target).toLowerCase())) throw new SkillReadRefused(`${asked} isn't a text file this reader opens (${[...SKILL_TEXT_TYPES].join(", ")}).`);
  if (st.size > SKILL_LIMITS.readBytes) throw new SkillReadRefused(`${asked} is ${st.size} bytes, over the ${SKILL_LIMITS.readBytes} a read may take.`);
  // At most the cap and one byte more, whatever the file has grown to since its size was read.
  const buf = Buffer.alloc(Math.min(st.size, SKILL_LIMITS.readBytes) + 1);
  const fd = openSync(target, "r");
  let got = 0;
  try {
    for (let n = 1; n > 0 && got < buf.length; got += n) n = readSync(fd, buf, got, buf.length - got, got);
  } finally {
    closeSync(fd);
  }
  if (got > SKILL_LIMITS.readBytes) throw new SkillReadRefused(`${asked} is over the ${SKILL_LIMITS.readBytes} bytes a read may take.`);
  return { skill: root.name, path: relative(realDir, target) || asked, text: buf.subarray(0, got).toString("utf8") };
}

// ---- what the sessions are told -------------------------------------------------------------------

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** The skills block of a designer's first message: what each is and how to read it. Empty with none. */
export function designerSkillsBlock(skills: readonly Pick<DesignSkill, "name" | "description">[]): string {
  if (!skills.length) return "";
  const lines = skills.map((s) => `- ${s.name}${s.description ? `: ${oneLine(s.description, 300)}` : ""}`);
  return [
    "DESIGN SKILLS:",
    `This project has design skills, the house rules for its pages. Read them before you write: ${DESIGN_SKILL_TOOL} with {"skill": name} lists a skill's files, and with {"skill": name, "file": path} returns one of them (start with SKILL.md). The brief may suggest which parts to read first; you may read any part.`,
    ...lines,
    "The page stays sealed: copy the tokens, colors, fonts and rules you need into the page itself. Nothing in a skill loads into the page, and only Google Fonts load from the web.",
  ].join("\n");
}

/** The skills part of the Creative Director's first message for a run: its skills by name, where each lives, and what to do. */
export function coordinatorSkillsBlock(skills: readonly DesignSkill[], missing: readonly DesignSkillMissing[]): string {
  if (!skills.length && !missing.length) return "Design skills: none for this run.";
  const parts: string[] = [];
  if (skills.length) {
    parts.push(
      `Design skills for this run (read each SKILL.md with read; the designers can read them too, with their own reader):\n${skills.map((s) => `- ${s.name} (${s.from === "project" ? "this project's" : "named by the user"}): ${join(s.dir, "SKILL.md")}${s.description ? `\n  ${oneLine(s.description, 300)}` : ""}`).join("\n")}`,
      "In the Full Prompt, suggest which parts of each skill the designers should read first. Suggest only: they may read any part.",
    );
  }
  if (missing.length) parts.push(`Skills the user named that weren't found:\n${missing.map((m) => `- ${m.asked}: ${m.reason}`).join("\n")}\nAsk about each one as a question on the brief; never guess which skill they meant.`);
  return parts.join("\n\n");
}

/** About how many tokens one design reads of its run's skills: each SKILL.md and a part as long again, within the allowance. */
export function skillReadTokens(skills: readonly Pick<DesignSkill, "dir">[] | undefined): number {
  if (!skills?.length) return 0;
  let bytes = 0;
  for (const s of skills) {
    try {
      bytes += statSync(join(s.dir, "SKILL.md")).size;
    } catch {
      // gone: nothing to read
    }
  }
  // Each read's text is sent again with every later step of the turn: twice what it read is the fair middle.
  return Math.min(SKILL_LIMITS.readTokens, Math.ceil((bytes * 2 * 2) / 4) + 1_000 * skills.length);
}
