import { readFileSync } from "node:fs";
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

export type ScanResult = { ok: true; commits: number } | { ok: false; why: string; hits: string[] };

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
  const n = o.secretsOnly ? { names: [] as string[] } : readNames(o.namesFile);
  if ("why" in n) return refuse(n.why);
  const terms = n.names;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const masked = (path: string) => terms.reduce((p, t, i) => p.replace(new RegExp(escape(t), "gi"), `[private name #${i + 1}]`), path);
  const hits: string[] = [];
  const check = (text: string, where: string) => {
    const lower = text.toLowerCase();
    for (const [i, t] of terms.entries()) if (lower.includes(t)) hits.push(`${where} · private name #${i + 1}`);
    for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) hits.push(`${where} · looks like a ${label}`);
  };
  for (const t of o.texts ?? []) t.text.split("\n").forEach((line, i) => check(line, `${t.label} line ${i + 1}`));

  const list = await git(["rev-list", "--reverse", o.range], o.repo);
  if (list.code !== 0) return refuse(`the scan couldn't list ${o.range} (${list.stderr.trim().split("\n")[0] ?? ""}): nothing is published`);
  const commits = list.stdout.split("\n").filter(Boolean);
  if (commits.length > (o.maxCommits ?? 2000)) return refuse(`${commits.length} commits to publish is more than the scan reads at once: nothing is published`);
  for (const c of commits) {
    const short = c.slice(0, 7);
    const msg = await git(["log", "-1", "--format=%B", c], o.repo);
    if (msg.code !== 0) return refuse(`the scan couldn't read commit ${short}: nothing is published`);
    msg.stdout.replace(/\n+$/, "").split("\n").forEach((line, i) => check(line, `commit ${short} · message line ${i + 1}`));
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
        if (file) check(file, `commit ${short} · ${masked(file)} · its name`);
        continue;
      }
      if (l.startsWith("Binary files ") && l.includes(" and b/")) {
        const name = l.slice(l.indexOf(" and b/") + 7).replace(/ differ$/, "");
        check(name, `commit ${short} · ${masked(name)} · its name`);
        continue;
      }
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (h) {
        line = Number(h[1]);
        continue;
      }
      if (!file) continue;
      if (l.startsWith("+")) {
        check(l.slice(1), `commit ${short} · ${masked(file)}:${line}`);
        line++;
      } else if (l.startsWith(" ")) line++;
    }
  }
  const unique = [...new Set(hits)];
  if (unique.length) return refuse(`the scan before publishing found ${unique.length} thing${unique.length === 1 ? "" : "s"} that look private: nothing is published (${unique[0]}${unique.length > 1 ? ", …" : ""})`, unique.slice(0, 50));
  return { ok: true, commits: commits.length };
}
