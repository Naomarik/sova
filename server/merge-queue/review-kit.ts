/**
 * What a review kit may declare, and which kit a review ran with (§app.merge-queue/review-kit).
 *
 * The kit is the project's review folder (`merge.review`), read from the merge copy: the branch's own kit, so a kit
 * edit takes effect on its own landing, and the run says so plainly ("this branch changed its own review"). Its
 * PLAYBOOK.md frontmatter may declare, each optional (absent: today's read-only reviewer):
 *
 *   model: provider/model     used when this computer has no review model picked for the project
 *   thinking: high            the reviewer's effort (one of shared/profiles.ts THINKING_LEVELS)
 *   passes: 2                 reviewers in turn, each a fresh chat (1..3)
 *   time-limit: 30            minutes one reviewer has (1..120; default 20)
 *   tools: shell              more than reading (comma-separated; today: shell)
 *
 * A value Sova can't take is left out and named in the review's log; the rest still applies. The project setting
 * `merge.reviewFixes` (the target's definition only) lets the reviewer fix what it finds: it then has a shell and edit
 * tools, in a folder of its own at the branch's commit, and commits its fix there.
 *
 * Every verdict records the kit's hash (git's tree hash of the folder at the commit reviewed) and the model it ran on.
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { REVIEW_KIT_TOOLS, type ReviewKitDecl, type ReviewKitTool } from "../../shared/merge-queue";
import { THINKING_LEVELS } from "../../shared/profiles";
import { parseFrontmatter } from "../playbooks";
import { gitProc } from "./copy";

export const PASSES_MAX = 3;
export const TIME_LIMIT_MAX_MIN = 120;
export const TIME_LIMIT_DEFAULT_MIN = 20;
const MODEL_REF = /^[^/\s]+\/\S+$/;

/** The reviewer's profiles: read-only (the default), with a shell, and the fixer (shell and edit tools). */
export const REVIEWER_PROFILE = "merge-reviewer";
export const REVIEWER_SHELL_PROFILE = "merge-reviewer-shell";
export const REVIEWER_FIX_PROFILE = "merge-reviewer-fix";

/** A kit's declaration from its frontmatter fields, and what Sova couldn't take (each left out). Pure. */
export function kitDeclOf(fields: Record<string, string>): { decl: ReviewKitDecl; problems: string[] } {
  const decl: ReviewKitDecl = {};
  const problems: string[] = [];
  const model = fields.model?.trim();
  if (model) {
    if (MODEL_REF.test(model) && model.length <= 200) decl.model = model;
    else problems.push(`model "${model.slice(0, 60)}" isn't "provider/model"`);
  }
  const thinking = fields.thinking?.trim() || fields.effort?.trim();
  if (thinking) {
    if ((THINKING_LEVELS as readonly string[]).includes(thinking)) decl.thinking = thinking;
    else problems.push(`thinking "${thinking.slice(0, 30)}" is one of ${THINKING_LEVELS.join(", ")}`);
  }
  const whole = (key: string, max: number, set: (n: number) => void) => {
    const raw = fields[key]?.trim();
    if (!raw) return;
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= max) set(n);
    else problems.push(`${key} "${raw.slice(0, 20)}" is a whole number from 1 to ${max}`);
  };
  whole("passes", PASSES_MAX, (n) => (decl.passes = n));
  whole("time-limit", TIME_LIMIT_MAX_MIN, (n) => (decl.timeLimitMin = n));
  const tools = fields.tools?.trim();
  if (tools) {
    const names = [...new Set(tools.split(",").map((t) => t.trim()).filter(Boolean))];
    const known = names.filter((t): t is ReviewKitTool => (REVIEW_KIT_TOOLS as readonly string[]).includes(t));
    for (const t of names) if (!known.includes(t as ReviewKitTool)) problems.push(`tool "${t.slice(0, 30)}" isn't one a reviewer can have (${REVIEW_KIT_TOOLS.join(", ")})`);
    if (known.length) decl.tools = known;
  }
  return { decl, problems };
}

/** The kit's declaration, read from its PLAYBOOK.md in `dir`; no file: the default (nothing declared). */
export async function readKitDecl(dir: string): Promise<{ decl: ReviewKitDecl; problems: string[] }> {
  let text: string;
  try {
    text = await readFile(join(dir, "PLAYBOOK.md"), "utf8");
  } catch {
    return { decl: {}, problems: [] };
  }
  return kitDeclOf(parseFrontmatter(text).fields);
}

/** The kit's declaration as it is at `rev` (its PLAYBOOK.md there); none there: the default. */
export async function kitDeclAt(cwd: string, rev: string, kit: string): Promise<ReviewKitDecl> {
  const r = await gitProc(cwd, ["show", `${rev}:${kit.replace(/\/+$/, "")}/PLAYBOOK.md`]);
  return r.code === 0 ? kitDeclOf(parseFrontmatter(r.out).fields).decl : {};
}

/** The profile a reviewer starts on: the fixer when the project lets it fix, a shell when the kit asks, else read-only. */
export function reviewerProfileOf(decl: ReviewKitDecl, fixes: boolean): string {
  if (fixes) return REVIEWER_FIX_PROFILE;
  return decl.tools?.includes("shell") ? REVIEWER_SHELL_PROFILE : REVIEWER_PROFILE;
}

/** Whether the reviewer works in a folder of its own (anything that can run or write), never the merge copy the checks
 *  run in. */
export const ownFolder = (decl: ReviewKitDecl, fixes: boolean): boolean => fixes || !!decl.tools?.includes("shell");

/** git's tree hash of the kit's folder at `rev`; null when there is no such folder there. */
export async function kitHashAt(cwd: string, rev: string, kit: string): Promise<string | null> {
  const r = await gitProc(cwd, ["rev-parse", "--verify", "--quiet", `${rev}:${kit.replace(/\/+$/, "")}`]);
  const h = r.out.trim();
  return r.code === 0 && /^[0-9a-f]{40,64}$/.test(h) ? h : null;
}

/** The kit's files `rev` changed against `base` (git's status letter, path); empty: the kit is the target's. */
export async function kitChangedBy(cwd: string, base: string, rev: string, kit: string): Promise<{ status: string; path: string }[]> {
  const r = await gitProc(cwd, ["diff", "--no-renames", "--name-status", base, rev, "--", kit]);
  if (r.code !== 0) return [];
  return r.out
    .split("\n")
    .map((l) => /^([A-Z])\t(.+)$/.exec(l.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ status: m[1]!, path: m[2]! }));
}

/** The kit's diff `base..rev`, for the review step's log, at most `max` characters. */
export async function kitDiff(cwd: string, base: string, rev: string, kit: string, max = 20_000): Promise<string> {
  const r = await gitProc(cwd, ["diff", "--no-renames", "--no-color", base, rev, "--", kit]);
  if (r.code !== 0) return "";
  return r.out.length > max ? `${r.out.slice(0, max)}\n… (${r.out.length - max} more characters)\n` : r.out;
}

/** "this branch changed its own review", with the files, in one line. */
export function ownReviewWords(changed: readonly { status: string; path: string }[]): string {
  const names = changed.map((c) => `${c.status} ${c.path}`);
  return `this branch changed its own review: ${names.slice(0, 5).join(", ")}${names.length > 5 ? ` +${names.length - 5} more` : ""}`;
}

/** The fix the reviewer committed in its own folder: its HEAD when it is a newer commit on top of `commit`. */
export async function reviewerFixIn(folder: string, commit: string): Promise<{ commit: string } | { none: string } | null> {
  const head = (await gitProc(folder, ["rev-parse", "--verify", "--quiet", "HEAD"])).out.trim();
  if (!head || head === commit) return null;
  if ((await gitProc(folder, ["merge-base", "--is-ancestor", commit, head])).code !== 0) return { none: `its folder's HEAD ${head.slice(0, 7)} isn't on top of ${commit.slice(0, 7)} (a rebase or a reset): no fix taken` };
  return { commit: head };
}
