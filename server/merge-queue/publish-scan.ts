import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ScanHit } from "../../shared/merge-queue";
import type { Git } from "./guard";

/**
 * The scan before anything is published to a host (a request's branch, a pushed branch, a request's title and
 * description): run by the queue itself in its own process, whatever checks the project declares, and fail-closed.
 * It refuses when anything looks like a secret or one of the project's private names, and also when it can't look:
 * no private names set up yet, the names file unreadable, git failing, or a range it can't read. A publication that
 * leaked can't be taken back (a request, even a draft, is seen at once), so doubt is a refusal.
 *
 * What it reads: every commit in `range` (`<host base>..<tip>`), its message, the names of the files it adds or
 * changes, and every line it adds (a merge commit: against its first parent); then each extra text (the request's
 * title and body). A hit names where (commit, file and line, or the text's label) and what (a private name's number
 * in the list, or a secret's kind), never the matched text.
 */

export const NAMES_NOT_SET_UP = "private names not set up yet";

/** The secret patterns: scripts/merge-checks/leak-scan.mjs's, plus GitHub fine-grained and GitLab tokens. */
export const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ["GitLab token", /\bgl(?:pat|dt|rt|cbt|ptt|ft|imt|agent|oas|soat)-[A-Za-z0-9_-]{20,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["API key", /\bsk-[A-Za-z0-9]{32,}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["assigned secret", /\b(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i],
];

/** One thing that looks private, said without the matched text (shared ScanHit). `key` is an opaque hash of what
 *  matched, the file (or "message", or the text's label) and the whole line, never the commit, so a match the user
 *  marked fine (Allow) stays fine after a rebase; it can't be read back into the text. */
export type ScanFound = ScanHit;

/** `names`: false when the private names weren't set up and the scan looked for secrets only (`namesMissing` input). */
export type ScanResult =
  | { ok: true; commits: number; allowed?: number; names?: false }
  | { ok: false; why: string; hits: string[]; found?: ScanFound[]; allowed?: number; commits?: number; names?: false };

export interface ScanInput {
  repo: string;
  /** `<from>..<to>`: what the host lacks. */
  range: string;
  /** The project's private names file (store.ts namesFileOf); absent or unreadable: refused. */
  namesFile?: string | undefined;
  /** Text published beside the commits (a request's title and body). */
  texts?: { label: string; text: string }[];
  /** Secrets only, no private names (an org workspace backup has no names list). */
  secretsOnly?: boolean;
  /** At most this many commits (default 2000): more is refused, never partly scanned. */
  maxCommits?: number;
  /** No names list yet: scan for secrets anyway instead of refusing at once (the run's "Private names and secrets"
   *  step: it lands, its push waits for the interview). The result says `names: false`. */
  namesMissing?: "secrets-only";
  /** Keys of matches this project marked fine (Allow): not counted as hits; `allowed` counts them. */
  allowed?: ReadonlySet<string>;
}

/** "1 thing that looks", "3 things that look" (n absent: "some things that look"). */
export const thingsThatLook = (n: number | undefined): string => (n === 1 ? "1 thing that looks" : `${n || "some"} things that look`);

/** "looks like a GitHub token", "looks like an AWS access key": the article by the label's sound (an initialism read
 *  letter by letter: "an API key"). */
export function looksLike(label: string): string {
  const word = label.split(" ")[0] ?? "";
  // An initialism (AWS, API) is read letter by letter: "an" before a letter whose name starts with a vowel sound.
  const an = /^[A-Z]{2,}$/.test(word) ? "AEFHILMNORSX".includes(word[0]!) : /^[aeiou]/i.test(word);
  return `looks like ${an ? "an" : "a"} ${label}`;
}

/** The key of one match (ScanFound.key). */
export function foundKey(what: string, scope: string, text: string): string {
  return createHash("sha256").update(`${what}\0${scope}\0${text}`).digest("hex").slice(0, 24);
}

function readNames(file: string | undefined): { names: string[] } | { why: string } {
  if (!file) return { why: `${NAMES_NOT_SET_UP}: nothing is published until they are` };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { why: `${NAMES_NOT_SET_UP}: nothing is published until they are` };
  }
  let parsed: { privateNames?: unknown };
  try {
    parsed = JSON.parse(raw) as { privateNames?: unknown };
  } catch {
    return { why: "the private names file isn't valid JSON, so nothing can be checked: nothing is published" };
  }
  if (!Array.isArray(parsed.privateNames)) return { why: "the private names file has no privateNames list: nothing is published" };
  return { names: parsed.privateNames.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim().toLowerCase()) };
}

export async function scanPublication(git: Git, o: ScanInput): Promise<ScanResult> {
  const refuse = (why: string, hits: string[] = []): ScanResult => ({ ok: false, why, hits });
  const read = o.secretsOnly ? { names: [] as string[] } : readNames(o.namesFile);
  const noNames = "why" in read && o.namesMissing === "secrets-only" && read.why.startsWith(NAMES_NOT_SET_UP);
  if ("why" in read && !noNames) return refuse(read.why);
  const n = "why" in read ? { names: [] as string[] } : read;
  const terms = n.names;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const masked = (path: string) => terms.reduce((p, t, i) => p.replace(new RegExp(escape(t), "gi"), `[private name #${i + 1}]`), path);
  const hits: string[] = [];
  const found: ScanFound[] = [];
  const seen = new Set<string>();
  let allowed = 0;
  type At = { scope: string; commit?: string; file?: string; line?: number };
  const check = (text: string, where: string, at: At) => {
    const lower = text.toLowerCase();
    // `id`: what the key is tied to: a private name's own hash (not its place in the list, which changes), or the
    // secret's kind.
    const hit = (kind: ScanFound["kind"], what: string, id: string) => {
      const key = foundKey(id, at.scope, text);
      if (o.allowed?.has(key)) {
        allowed++;
        return;
      }
      // One hit per match: the same line again in a later commit (a merge's own diff repeats its branch's) is the same.
      const said = kind === "name" ? what : looksLike(what);
      const line = `${where} · ${said}`;
      if (seen.has(line) || seen.has(key)) return;
      seen.add(line);
      seen.add(key);
      hits.push(line);
      found.push({ key, where, kind, what: said, ...(at.commit ? { commit: at.commit } : {}), ...(at.file ? { file: at.file } : {}), ...(at.line !== undefined ? { line: at.line } : {}) });
    };
    for (const [i, t] of terms.entries()) if (lower.includes(t)) hit("name", `private name #${i + 1}`, `name:${createHash("sha256").update(t).digest("hex")}`);
    for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) hit("secret", label, `secret:${label}`);
  };
  for (const t of o.texts ?? []) t.text.split("\n").forEach((line, i) => check(line, `${t.label} line ${i + 1}`, { scope: t.label, line: i + 1 }));
  const extra = { ...(noNames ? { names: false as const } : {}) };

  const list = await git(["rev-list", "--reverse", o.range], o.repo);
  if (list.code !== 0) return refuse(`the scan couldn't list ${o.range} (${list.stderr.trim().split("\n")[0] ?? ""}): nothing is published`);
  const commits = list.stdout.split("\n").filter(Boolean);
  if (commits.length > (o.maxCommits ?? 2000)) return refuse(`${commits.length} commits to publish is more than the scan reads at once: nothing is published`);
  for (const c of commits) {
    const short = c.slice(0, 7);
    const msg = await git(["log", "-1", "--format=%B", c], o.repo);
    if (msg.code !== 0) return refuse(`the scan couldn't read commit ${short}: nothing is published`);
    msg.stdout.replace(/\n+$/, "").split("\n").forEach((line, i) => check(line, `commit ${short} · message line ${i + 1}`, { scope: "message", commit: c, line: i + 1 }));
    const p = await git(["show", "--no-color", "--no-ext-diff", "--no-renames", "--diff-merges=first-parent", "--format=", c], o.repo, { timeoutMs: 120_000 });
    if (p.code !== 0) return refuse(`the scan couldn't read commit ${short}'s changes (${p.stderr.trim().split("\n")[0] ?? "too large"}): nothing is published`);
    let file: string | null = null;
    let line = 0;
    for (const l of p.stdout.split("\n")) {
      if (l.startsWith("diff --git ")) {
        file = null;
        continue;
      }
      if (l.startsWith("+++ ")) {
        file = l === "+++ /dev/null" ? null : l.slice(6);
        if (file) check(file, `commit ${short} · ${masked(file)} · its name`, { scope: `name:${file}`, commit: c, file: masked(file) });
        continue;
      }
      if (l.startsWith("Binary files ") && l.includes(" and b/")) {
        const name = l.slice(l.indexOf(" and b/") + 7).replace(/ differ$/, "");
        check(name, `commit ${short} · ${masked(name)} · its name`, { scope: `name:${name}`, commit: c, file: masked(name) });
        continue;
      }
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (h) {
        line = Number(h[1]);
        continue;
      }
      if (!file) continue;
      if (l.startsWith("+")) {
        check(l.slice(1), `commit ${short} · ${masked(file)}:${line}`, { scope: file, commit: c, file: masked(file), line });
        line++;
      } else if (l.startsWith(" ")) line++;
    }
  }
  const counted = { ...extra, ...(allowed ? { allowed } : {}) };
  if (hits.length)
    return { ok: false, why: `the scan before publishing found ${thingsThatLook(hits.length)} private: nothing is published (${hits[0]}${hits.length > 1 ? ", …" : ""})`, hits: hits.slice(0, 50), found: found.slice(0, 50), commits: commits.length, ...counted };
  return { ok: true, commits: commits.length, ...counted };
}
