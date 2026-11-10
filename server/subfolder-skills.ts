// Skills in folders below a chat's own (§chat/subfolder-skills): which offer themselves at a touch, the
// block that tells the model, the branch's record of what it was told, and the walk the Context tab lists.
// Harness-neutral: reading a skills folder is handed in (`SkillsIn`, server/harness/pi/skill-sources.ts).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HEntry } from "../shared/harness";
import { candidateDirs, resolveToolPath, skippedSegment, SUBFOLDER_SCAN_CAP, visiblePart } from "./deeper-context";

/** One skill a folder's skills folders hold, as its file says. */
export interface FolderSkill {
  name: string;
  description: string;
  /** Its SKILL.md, absolute. */
  filePath: string;
  manualOnly: boolean;
}

/** The skills one skills folder holds. */
export type SkillsIn = (skillsDir: string) => FolderSkill[];

const TAG = "sova-skills";
const HEADER = new RegExp(`^<${TAG} dir="([^"\\n]+)">`);
/** Inside one folder, in the order a chat's start takes them. */
const SKILL_FOLDERS = [".agents/skills", ".claude/skills"] as const;

const posix = (p: string) => p.split(sep).join("/");
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&amp;": "&" };
const unescapeXml = (s: string) => s.replace(/&(?:lt|gt|quot|apos|amp);/g, (m) => ENTITIES[m] ?? m);

/** The block a folder's skills go in: its folder in the header, each skill as a chat's starting list has it. */
export function skillsBlock(dir: string, skills: readonly Pick<FolderSkill, "name" | "description" | "filePath">[]): string {
  const rows = skills.flatMap((s) => ["  <skill>", `    <name>${escapeXml(s.name)}</name>`, `    <description>${escapeXml(s.description)}</description>`, `    <location>${escapeXml(s.filePath)}</location>`, "  </skill>"]);
  return [`<${TAG} dir="${dir}">`, `This folder has its own skills. Read a skill's file when the task matches its description, and resolve a relative path in it against that file's folder.`, "<available_skills>", ...rows, "</available_skills>", `</${TAG}>`].join("\n");
}

/** One offered skill read back from a block: what it told the model. */
export interface OfferedSkill {
  name: string;
  description: string;
  filePath: string;
  /** The folder the block names, relative to the chat's folder. */
  dir: string;
}

/** The trailing blocks of a tool result that are skills blocks, never its first (a tool's own output). */
function trailingBlocks(blocks: readonly { type: string; text?: string }[]): { dir: string; text: string }[] {
  const out: { dir: string; text: string }[] = [];
  for (let k = blocks.length - 1; k >= 1; k--) {
    const b = blocks[k]!;
    const text = b.type === "text" ? (b.text ?? "") : "";
    const m = HEADER.exec(text);
    if (m) out.unshift({ dir: m[1]!, text });
    else if (!text.startsWith("<sova-instructions path=")) break; // the walk markersIn makes: only the result's own trailing blocks
  }
  return out;
}

const tag = (block: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? unescapeXml(m[1]!) : "";
};

/** What a branch has offered, as its model sees it now, oldest first. */
export function offeredSkills(branch: readonly HEntry[]): OfferedSkill[] {
  const out: OfferedSkill[] = [];
  for (const e of visiblePart(branch)) {
    if (e.kind !== "tool-result") continue;
    for (const b of trailingBlocks(e.blocks)) {
      for (const m of b.text.matchAll(/<skill>([\s\S]*?)<\/skill>/g)) {
        const name = tag(m[1]!, "name");
        if (name) out.push({ name, description: tag(m[1]!, "description"), filePath: tag(m[1]!, "location"), dir: b.dir });
      }
    }
  }
  return out;
}

/** The folders a branch's blocks have offered, as its model sees it now. */
export function offeredDirs(branch: readonly HEntry[]): Set<string> {
  const out = new Set<string>();
  for (const e of visiblePart(branch)) if (e.kind === "tool-result") for (const b of trailingBlocks(e.blocks)) out.add(b.dir);
  return out;
}

/** Whether git ignores `path`, asked from the nearest repository (a submodule answers for itself). Any
    error is not ignored: a folder with no repository, or one git can't answer for, counts. */
export function gitIgnores(path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--", path], { cwd: dirname(path), stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** A folder's skills: its skills folders that exist and git doesn't ignore, the first of one name. */
export function skillsOfFolder(dir: string, read: SkillsIn, ignores: (p: string) => boolean = gitIgnores): FolderSkill[] {
  const seen = new Set<string>();
  const out: FolderSkill[] = [];
  for (const sub of SKILL_FOLDERS) {
    const skillsDir = join(dir, sub);
    if (!existsSync(skillsDir) || ignores(skillsDir)) continue;
    for (const s of read(skillsDir)) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push(s);
    }
  }
  return out;
}

export interface SkillAttachOptions {
  /** The path (absolute or as the tool got it) the call touched. */
  path: string;
  /** Reads a skills folder. */
  read: SkillsIn;
  /** The folders the branch has offered (read only when a candidate has skills). */
  offered: () => ReadonlySet<string>;
  /** Folders attached in this turn, not yet on the branch; the call's own are added. */
  inFlight: Set<string>;
  /** A skills folder's answer from git, kept for this chat: it is asked once per folder. */
  ignored: Map<string, boolean>;
  /** A file the chat's starting list already has (it isn't offered again). */
  startingFile?: (abs: string) => boolean;
  /** A name this chat switched off. */
  off?: (name: string) => boolean;
  /** A file the chat may not be shown. */
  allow?: (abs: string) => boolean;
}

/** The text blocks to append to a tool result, outermost first; none when nothing new is offered. */
export function skillBlocksToAttach(cwd: string, o: SkillAttachOptions): string[] {
  const out: string[] = [];
  const ignores = (p: string) => {
    let hit = o.ignored.get(p);
    if (hit === undefined) o.ignored.set(p, (hit = gitIgnores(p)));
    return hit;
  };
  for (const dir of candidateDirs(cwd, resolveToolPath(cwd, o.path))) {
    if (!SKILL_FOLDERS.some((s) => existsSync(join(dir, s)))) continue;
    const rel = posix(relative(resolve(cwd), dir));
    if (o.inFlight.has(rel) || o.offered().has(rel)) continue;
    const skills = skillsOfFolder(dir, o.read, ignores).filter((s) => !s.manualOnly && !o.startingFile?.(s.filePath) && !o.off?.(s.name) && (!o.allow || o.allow(s.filePath)));
    if (!skills.length) continue;
    o.inFlight.add(rel);
    out.push(skillsBlock(rel, skills));
  }
  return out;
}

export interface SubfolderSkill extends FolderSkill {
  /** Its folder, relative to the chat's (`services/samba`). */
  dir: string;
}

/** Every skill of a folder below `cwd`, outermost first; `incomplete` when the walk stopped at `cap`
    folders. Hidden and dependency folders aren't walked, as for instruction files. */
export function listSubfolderSkills(cwd: string, read: SkillsIn, opts: { cap?: number; ignores?: (p: string) => boolean } = {}): { skills: SubfolderSkill[]; incomplete: boolean } {
  const cap = opts.cap ?? SUBFOLDER_SCAN_CAP;
  const root = resolve(cwd);
  const skills: SubfolderSkill[] = [];
  const queue: string[] = [root];
  let seen = 0;
  let incomplete = false;
  while (queue.length) {
    const dir = queue.shift()!;
    if (dir !== root && SKILL_FOLDERS.some((s) => existsSync(join(dir, s)))) {
      for (const s of skillsOfFolder(dir, read, opts.ignores)) skills.push({ ...s, dir: posix(relative(root, dir)) });
    }
    let names: string[];
    try {
      names = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && !skippedSegment(d.name)).map((d) => d.name).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      if (++seen > cap) {
        incomplete = true;
        queue.length = 0;
        break;
      }
      queue.push(join(dir, n));
    }
  }
  return { skills, incomplete };
}

/** The skill `/skill:name` means when no starting skill has that name: the one offered earliest on the
    branch, else the outermost one below `cwd` (§chat.subfolder-skills/command). */
export function nestedSkillFile(cwd: string, name: string, branch: readonly HEntry[], read: SkillsIn): string | null {
  const offered = offeredSkills(branch).find((s) => s.name === name);
  if (offered) return offered.filePath;
  return listSubfolderSkills(cwd, read).skills.find((s) => s.name === name)?.filePath ?? null;
}

/** Whether `file` is a skill a folder below `cwd` lists: the rule the Context tab's rows open by. */
export function isSubfolderSkillFile(cwd: string, file: string, read: SkillsIn): boolean {
  if (!isAbsolute(file) || !file.endsWith(".md")) return false;
  for (const sub of SKILL_FOLDERS) {
    const at = file.indexOf(`/${sub}/`);
    if (at < 0) continue;
    const dir = file.slice(0, at);
    if (candidateDirs(cwd, join(dir, "x")).includes(dir) && skillsOfFolder(dir, read).some((s) => s.filePath === file)) return true;
  }
  return false;
}
