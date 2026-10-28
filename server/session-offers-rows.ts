import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GoAhead, NotYet } from "../pi-config/extensions/worktrees/landing.ts";
import type { LandingRecord } from "../shared/session-offers";
import { stateRoot } from "./state-root";

/**
 * The Merge Captain's landing rows (§chat.offers/landing-rows): the helpers that read git and the round's driver
 * to tell a go-ahead row's progress, and where an answer was given. Pure but for the reads `git` and the driver's
 * state file; server/session-offers.ts keeps the records.
 */

export type Git = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

/** How many clean master merges a go-ahead row's branch may move by and still read Landing (the driver's CARRY_MAX). */
export const CARRY_MAX = 20;

const line = async (git: Git, args: string[], cwd: string): Promise<string | undefined> => {
  const r = await git(args, cwd).catch(() => ({ code: 1, stdout: "" }));
  const out = r.stdout.trim();
  return r.code === 0 && out ? out : undefined;
};

/**
 * The commit `merge` was made from when it is a clean merge of `base` into it (round.mjs cleanMergeParent, the
 * driver's rule): exactly two parents, the second already on `base`, and its tree exactly what
 * `git merge-tree --write-tree` makes of them. Undefined otherwise.
 */
export async function cleanMergeParent(git: Git, cwd: string, merge: string, base: string): Promise<string | undefined> {
  const ids = (await line(git, ["rev-list", "--parents", "-n", "1", merge], cwd))?.split(/\s+/) ?? [];
  if (ids.length !== 3) return undefined;
  const [, first, second] = ids as [string, string, string];
  if ((await git(["merge-base", "--is-ancestor", second, `refs/heads/${base}`], cwd).catch(() => ({ code: 1 }))).code !== 0) return undefined;
  const tree = await line(git, ["rev-parse", "--verify", "-q", `${merge}^{tree}`], cwd);
  const made = (await line(git, ["merge-tree", "--write-tree", "--no-messages", first, second], cwd))?.split("\n")[0]?.trim();
  return tree && made === tree ? first : undefined;
}

/** When the round's driver last recorded a check of `branch` (ms epoch), from its state file; undefined: none. */
export function driverCheckAt(branch: string, root = stateRoot()): number | undefined {
  try {
    const st = JSON.parse(readFileSync(join(root, "playbooks", "merge-round", "state.json"), "utf8")) as { branches?: Record<string, { check?: { at?: unknown } }> };
    const at = st?.branches?.[branch]?.check?.at;
    return typeof at === "number" && Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A go-ahead row's progress (§chat.offers/landing-rows): "landed" once its commit is in `base`; "landing" once its
 * branch moved on only by clean merges of `base` (the check's own merge), or the driver recorded a check of it at
 * or after the answer; undefined while neither holds (or git can't tell).
 */
export async function rowProgress(git: Git, cwd: string, row: { branch: string; head: string; answeredAt: number }, base: string | undefined, checkAt: number | undefined): Promise<"landing" | "landed" | undefined> {
  if (!base) return undefined;
  if ((await git(["merge-base", "--is-ancestor", row.head, `refs/heads/${base}`], cwd).catch(() => ({ code: 1 }))).code === 0) return "landed";
  if (checkAt !== undefined && checkAt >= row.answeredAt) return "landing";
  const now = await line(git, ["rev-parse", "--verify", "-q", `refs/heads/${row.branch}^{commit}`], cwd);
  if (!now || now === row.head) return undefined;
  let sha = now;
  for (let i = 0; i < CARRY_MAX; i++) {
    const parent = await cleanMergeParent(git, cwd, sha, base);
    if (!parent) return undefined;
    if (parent === row.head) return "landing";
    sha = parent;
  }
  return undefined;
}

/** A landing answer as the cards read it: its kind, when, who recorded it and the session it was given in. */
export interface LandingAnswer {
  kind: LandingRecord;
  at: string;
  /** The session it was given in, when known. */
  in?: string;
  /** Who recorded a go-ahead. */
  by?: GoAhead["by"];
}

/** landing.ts answerAt's hit, as the cards read it. */
export function landingAnswerOf(hit: { kind: "go-ahead"; goAhead: GoAhead } | { kind: "not-yet"; notYet: NotYet } | undefined): LandingAnswer | undefined {
  if (!hit) return undefined;
  if (hit.kind === "not-yet") return { kind: "not-yet", at: hit.notYet.at, ...(hit.notYet.in ? { in: hit.notYet.in } : {}) };
  const g = hit.goAhead;
  // A go-ahead typed in the owner's chat was given in the branch's own session.
  const given = g.in ?? (g.by === "owner-chat" ? g.session : undefined);
  return { kind: g.withoutSpecs ? "go-ahead-without-specs" : "go-ahead", at: g.at, by: g.by, ...(given ? { in: given } : {}) };
}

/**
 * Where an answer settled on a card was given (§chat.offers/landing-rows): "this chat" for the card's own session,
 * the other place's title when it is the one `others` names, and undefined when it can't be told. A go-ahead in the
 * captain's chat with no session recorded is the captain's: `captain` names it, as the card sees it.
 */
export function whereOf(a: LandingAnswer, here: string, others: Record<string, string>, captain?: { id: string; title: string }): string | undefined {
  const given = a.in ?? (a.by === "captain-chat" ? captain?.id : undefined);
  if (!given) return undefined;
  if (given === here) return "this chat";
  return others[given] ?? (captain && given === captain.id ? captain.title : undefined);
}
