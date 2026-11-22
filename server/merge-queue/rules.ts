/**
 * The project's folder rules (`merge.rules` in .sova/project.json): which extra checks a branch's changed paths set
 * off, each with its reason. Sova applies them itself at the start of every run (source "trigger"); the merge thread
 * only adds picks on top. The rules are read from the branch being landed (its merged tree), so a rule edit takes
 * effect on its own landing; the check list itself stays the target's. Pure, but `branchRulesOf` reads one file.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CheckPick, RunRules } from "../../shared/merge-queue";
import type { MergeCheckDecl, MergeRuleDecl, ProjectDef } from "../../shared/project-contract";
import { parseDefinition } from "../../shared/project-contract";
import { NO_BACKGROUND_CLEANUP } from "../git-no-background";
import { gitProc } from "./copy";

/** A glob as a RegExp: `**` any depth (including none), `*` within one folder, `?` one character. */
export function globRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          re += "(?:.*/)?";
        } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export const globMatches = (globs: readonly string[], path: string): boolean => globs.some((g) => globRe(g).test(path));

/** One rule as one line: "statecharts/**, scripts/statecharts*.mjs → statecharts". */
export function ruleWords(r: MergeRuleDecl): string {
  const paths = r.paths.length > 3 ? `${r.paths.slice(0, 3).join(", ")}, +${r.paths.length - 3} more` : r.paths.join(", ");
  return `${paths} → ${r.check}${r.select?.length ? ` (${r.select.join(", ")})` : ""}`;
}

/**
 * The checks `rules` set off for `changed`, as picks with source "trigger", in rule order. One per check: the reasons of
 * every rule that hit it are joined (each with up to 3 of the paths it matched) and their selections joined; a rule
 * with no selection asks for the whole check, which then runs whole. A check that declares `perSelector` runs once
 * per distinct selection instead. A rule naming a check `checks` lacks sets nothing off (`unknown` lists it), and so
 * does one with no selection for a check `checks` says needs one (`needsSelect` on the target's check, whatever the
 * branch's own copy of the check says; `refused` lists it).
 */
export function ruleTriggers(rules: readonly MergeRuleDecl[], changed: readonly string[], checks: readonly Pick<MergeCheckDecl, "id" | "label" | "perSelector" | "needsSelect">[]): { picks: CheckPick[]; unknown: MergeRuleDecl[]; refused: MergeRuleDecl[] } {
  const byKey = new Map<string, CheckPick & { whole?: true }>();
  const unknown: MergeRuleDecl[] = [];
  const refused: MergeRuleDecl[] = [];
  for (const rule of rules) {
    const hits = changed.filter((p) => globMatches(rule.paths, p));
    if (!hits.length) continue;
    const c = checks.find((x) => x.id === rule.check);
    if (!c) {
      unknown.push(rule);
      continue;
    }
    if (c.needsSelect && !rule.select?.length) {
      refused.push(rule);
      continue;
    }
    const why = `${rule.why} (${hits.slice(0, 3).join(", ")}${hits.length > 3 ? `, +${hits.length - 3} more` : ""})`;
    const select = rule.select ?? [];
    const key = c.perSelector ? `${c.id}\0${select.join("\0")}` : c.id;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { id: c.id, label: c.label, source: "trigger", why, ...(select.length ? { select: [...select] } : { whole: true as const }) });
      continue;
    }
    prev.why = `${prev.why}; ${why}`;
    if (prev.whole) continue;
    if (!select.length) {
      delete prev.select;
      prev.whole = true;
    } else prev.select = [...new Set([...(prev.select ?? []), ...select])];
  }
  return { picks: [...byKey.values()].map(({ whole: _w, ...p }) => ({ ...p, ...(p.why && p.why.length > 300 ? { why: `${p.why.slice(0, 299)}…` } : {}) })), unknown, refused };
}

/** What changed between the target's rules and the branch's, one line each; [] when they are the same. */
export function rulesChange(target: readonly MergeRuleDecl[], branch: readonly MergeRuleDecl[]): string[] {
  const key = (r: MergeRuleDecl) => JSON.stringify([[...r.paths].sort(), r.check, r.select ?? [], r.why]);
  const t = new Map(target.map((r) => [key(r), r]));
  const b = new Map(branch.map((r) => [key(r), r]));
  const out: string[] = [];
  for (const [k, r] of b) if (!t.has(k)) out.push(`added: ${ruleWords(r)}: ${r.why}`);
  for (const [k, r] of t) if (!b.has(k)) out.push(`removed: ${ruleWords(r)}: ${r.why}`);
  return out;
}

/** The rules a run applies, from the text of the branch's .sova/project.json (as it reads after the merge): null text
 *  is no file (no rules apply). `refused`: the branch's definition doesn't read; the run sends it back with this. */
export function rulesFromText(text: string | null, targetDef: ProjectDef | null): { rules: MergeRuleDecl[]; info: RunRules; refused?: string } {
  const target = targetDef?.merge?.rules ?? [];
  if (text === null) {
    const info: RunRules = { from: "branch", count: 0, why: "the branch has no .sova/project.json: no folder rules apply" };
    const gone = rulesChange(target, []);
    return { rules: [], info: { ...info, ...(gone.length ? { changed: gone.slice(0, 20), ...(gone.length > 20 ? { more: gone.length - 20 } : {}) } : {}) } };
  }
  let branch: MergeRuleDecl[];
  try {
    branch = parseDefinition(text).merge?.rules ?? [];
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    return { rules: [], info: { from: "branch", count: 0, why: `the branch's .sova/project.json is refused: ${msg}` }, refused: msg };
  }
  const changed = rulesChange(target, branch);
  return { rules: branch, info: { from: "branch", count: branch.length, ...(changed.length ? { changed: changed.slice(0, 20), ...(changed.length > 20 ? { more: changed.length - 20 } : {}) } : {}) } };
}

/** rulesFromText over the merge copy's .sova/project.json (the copy at the merge). */
export function branchRulesOf(copy: string, targetDef: ProjectDef | null): ReturnType<typeof rulesFromText> {
  let text: string | null;
  try {
    text = readFileSync(join(copy, ".sova", "project.json"), "utf8");
  } catch {
    text = null;
  }
  return rulesFromText(text, targetDef);
}

/** A short hash of the rules a run applies (the plan's fingerprint input): same rules → same hash. */
export const rulesHash = (rules: readonly MergeRuleDecl[]): string => createHash("sha256").update(JSON.stringify(rules.map((r) => [r.paths, r.check, r.select ?? [], r.why]))).digest("hex").slice(0, 16);

const PROJECT_FILE = ".sova/project.json";

/** The project file's text at `rev` (a commit or a tree) in `root`'s repository; null when it has none. */
async function showAt(root: string, rev: string): Promise<string | null> {
  const r = await gitProc(root, ["show", `${rev}:${PROJECT_FILE}`], { timeoutMs: 30_000 });
  return r.code === 0 ? r.out : null;
}

/**
 * The rules a run of `commit` onto `base` will apply and what they set off, worked out before the run (in `root`, the
 * main checkout): the tree the merge makes (`git merge-tree --write-tree`, the same tree the run's merge copy gets),
 * its .sova/project.json, and the branch's changed paths against the target (base → that tree, what the run's
 * SOVA_MERGE_CHANGED lists). A merge that conflicts has no rules to read (the run stops at the conflict). Never throws:
 * `error` says what couldn't be read, and `info.why` says it plainly (the run then reads its copy as usual).
 */
export async function planRulesFor(o: { root: string; base: string; commit: string; target: string; targetDef: ProjectDef | null }): Promise<{ rules: MergeRuleDecl[]; info: RunRules; refused?: string; refusal?: RulesRefusal; changed: string[]; triggers: CheckPick[]; unknown: MergeRuleDecl[]; unknownWords: string[]; hash: string; tree?: string; error?: string }> {
  const decls = Array.isArray(o.targetDef?.merge?.checks) ? o.targetDef!.merge!.checks : [];
  const failed = (error: string) => ({ rules: [], info: { from: "branch" as const, count: 0, why: `couldn't read the branch's rules before the run (${error.slice(0, 200)}): the run reads them from its merge copy` }, changed: [], triggers: [], unknown: [], unknownWords: [], hash: "", error });
  try {
    const mt = await gitProc(o.root, [...NO_BACKGROUND_CLEANUP, "merge-tree", "--write-tree", "--no-messages", o.base, o.commit], { timeoutMs: 60_000 });
    const tree = mt.out.trim().split("\n")[0]?.trim() ?? "";
    if (mt.code === 1) return failed("the branch conflicts with the target");
    if (mt.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tree)) return failed(mt.out.trim().split("\n")[0] || `git merge-tree exit ${mt.code}`);
    const diff = await gitProc(o.root, ["diff", "--name-only", o.base, tree], { timeoutMs: 60_000 });
    if (diff.code !== 0) return failed(diff.out.trim().split("\n")[0] || "git diff failed");
    const changed = diff.out.split("\n").map((l) => l.trim()).filter(Boolean);
    const r = rulesFromText(await showAt(o.root, tree), o.targetDef);
    const t = ruleTriggers(r.rules, changed, decls);
    const refusal = rulesRefusal(r, t, o.target);
    return { ...r, info: withUnknown(r.info, t, o.target), ...(refusal ? { refusal } : {}), changed, triggers: t.picks, unknown: t.unknown, unknownWords: [...new Set(t.unknown.map((u) => notDeclaredWords(u, o.target)))], hash: rulesHash(r.rules), tree };
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

/** The run's rules info with the rules that matched but set nothing off: a check the target doesn't declare yet, or
 *  one the target says needs a selection the rule doesn't give. */
export function withUnknown(info: RunRules, t: { unknown: readonly MergeRuleDecl[]; refused: readonly MergeRuleDecl[] }, target: string): RunRules {
  const lines = [
    ...t.unknown.map((u) => notDeclaredWords(u, target)),
    ...t.refused.map((u) => `${u.check} runs with a selection on ${target} and this rule names none (${ruleWords(u)})`),
  ];
  return lines.length ? { ...info, unknown: [...new Set(lines)] } : info;
}

const notDeclaredWords = (u: MergeRuleDecl, target: string): string => `${u.check} isn't declared on ${target} yet (${ruleWords(u)})`;

/** Why the branch's folder rules are refused, and the checks the refused rules name (none when its definition doesn't
 *  read: no rule of it applies). */
export interface RulesRefusal {
  why: string;
  checks: string[];
}

/**
 * Whether a run refuses the branch's folder rules (§app.merge-queue/rules), from rulesFromText's reading and
 * ruleTriggers' answer: its .sova/project.json doesn't read, or a rule this change hits names, with no selection, a
 * check the target runs only with one. The run fails with `why`; the plan (§app.merge-queue/plan) shows the same words
 * on its Folder rules step, so the two never disagree. Null: nothing is refused.
 */
export function rulesRefusal(r: { refused?: string }, t: { refused: readonly MergeRuleDecl[] }, target: string): RulesRefusal | null {
  if (r.refused) return { why: `your branch's .sova/project.json is refused: ${r.refused}`, checks: [] };
  if (!t.refused.length) return null;
  return { why: `your branch's folder rules are refused: ${t.refused.map((x) => `${ruleWords(x)}: "${x.check}" runs with a selection on ${target} and this rule names none`).join("; ")}`, checks: [...new Set(t.refused.map((x) => x.check))] };
}
