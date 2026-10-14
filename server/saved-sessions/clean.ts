// Cleaning a saved session (§chat.saved-sessions/cleaning): every string leaf of the kept history goes through
// one Cleaner. Known secrets are removed with no review: the share links' redactor (credential files, Sova's
// tokens, recognisable secret patterns), Sova's own share and preview links, every value in the project's
// `.env*` files, and the merge round's private names when this computer has that list. Possible secrets
// (long high-entropy strings) are collected for the saver's review, one item per distinct value, and removed
// only on a "remove" decision. Paths are made portable: each worktree root becomes its worktree token, the
// repository's top level the root token, the home folder `~`.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BundleStringSite } from "../../shared/harness";
import { ROOT_TOKEN, type SaveReviewItem, type SavedCleaning, worktreeToken } from "../../shared/session-bundle";
import { redactShareLinks } from "../link-tokens";
import { plausibleSecret, REDACTED, Redactor, serverRedactor, type SecretSource } from "../overseer-redact";
import { redactPreviewLinks } from "../preview-kept";
import { stateRoot } from "../state-root";

/** What replaces a possible secret the saver removed. */
export const POSSIBLE_REMOVED = "[removed when saved]";
/** What replaces one of the merge round's private names. */
export const PRIVATE_NAME = "[private name]";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The values of a dotenv file: each `KEY=value` line's value, quotes off, that could be a secret. */
export function envFileValues(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[1]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    if (plausibleSecret(v)) out.push(v);
  }
  return out;
}

/** Every `.env*` file directly in each of `dirs` (the repository's top level and its worktrees). */
export function envFileSources(dirs: readonly string[]): SecretSource[] {
  const out: SecretSource[] = [];
  for (const dir of new Set(dirs)) {
    let names: string[] = [];
    try {
      names = readdirSync(dir).filter((n) => /^\.env(\..+)?$/.test(n) && !/\.(example|sample|template)$/.test(n));
    } catch {
      continue;
    }
    for (const n of names) out.push({ path: join(dir, n), text: true, pick: (raw) => (typeof raw === "string" ? envFileValues(raw) : []) });
  }
  return out;
}

/** The merge round's private names on this computer (`<state root>/merge-round.json` privateNames), if any. */
export function privateNames(file = join(stateRoot(), "merge-round.json")): string[] {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(j?.privateNames) ? j.privateNames.filter((x: unknown): x is string => typeof x === "string" && x.trim().length >= 3).map((x: string) => x.trim()) : [];
  } catch {
    return [];
  }
}

/** Shannon entropy in bits per character. */
export function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const CANDIDATE = /[A-Za-z0-9+/_=.-]{24,}/g;
/** A pi session file: `<…>/--<folder spelled with dashes>--/<file>.jsonl`. */
const SESSION_FILE = /(?:[~/][^\s"'`]*\/)?--[^\s/"'`]+--\/[^\s/"'`]+\.jsonl/g;
const PROSE_WHY = "said to be a secret";
export const SESSION_FILE_PLACEHOLDER = "[a session file on the saver's computer]";
/** "password is X", "pwd: X", "my token = X": a secret's name, then its value. */
const PROSE_SECRET = /(\b(?:password|passwd|pwd|passphrase|passcode|secret|token|api[ _-]?key|pin)\b(?:\s+(?:is|was|are|=|:)|\s*[:=])\s*["'`]?)([^\s"'`]{4,})/gi;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Why `s` looks like it could be a secret, or null. Hashes, ids, paths and words are left alone. */
export function possibleSecretWhy(s: string): string | null {
  const t = s.replace(/^[.\-_/=]+|[.\-_/]+$/g, "");
  if (t.length < 24) return null;
  if (/^[0-9a-f]+$/i.test(t)) return null; // commit shas, digests, ids
  if (UUID.test(t)) return null;
  if (t.includes("{{sova:")) return null;
  if (!/[0-9]/.test(t) || !/[A-Za-z]/.test(t)) return null;
  // A path or a dotted name reads as words between separators; a token doesn't.
  const parts = t.split(/[/._-]+/).filter(Boolean);
  if (parts.length > 2 && parts.every((p) => p.length < 16)) return null;
  const h = entropy(t);
  if (h < 4) return null;
  if (!/[A-Z]/.test(t) && !/[a-z]/.test(t)) return null;
  return t.length >= 40 ? "long high-entropy string" : "high-entropy string";
}

export interface PathRoot {
  /** The absolute folder. */
  path: string;
  /** What replaces it. */
  token: string;
  branch?: string;
}

/** The roots in the order they are replaced: longest first, so a worktree inside the top level wins. */
export function pathRoots(top: string, worktrees: readonly { path: string; branch: string }[], home = homedir()): PathRoot[] {
  const roots: PathRoot[] = [
    ...worktrees.filter((w) => w.path && w.path !== top).map((w) => ({ path: w.path, token: worktreeToken(w.branch), branch: w.branch })),
    { path: top, token: ROOT_TOKEN },
  ];
  if (home && home !== "/" && !roots.some((r) => r.path === home)) roots.push({ path: home, token: "~" });
  return roots.filter((r) => r.path.startsWith("/") && r.path.length > 1).sort((a, b) => b.path.length - a.path.length);
}

const ABSOLUTE = /(?<![\w~}.:/-])\/(?:[\w.@+-]+\/)+[\w.@+-]*/g;

export interface CleanerOptions {
  roots: PathRoot[];
  /** Folders whose `.env*` values are known secrets. */
  envDirs: string[];
  /** Decisions on possible secrets by review id; absent = keep (and list it). */
  decisions?: Readonly<Record<string, "keep" | "remove">>;
  /** The known-secret redactor (default: the server's). */
  redactor?: Pick<Redactor, "redact">;
  privateNames?: readonly string[];
  /** Share and preview link redaction (default: the server's kept tokens and labels). */
  links?: (text: string) => string;
}

const reviewId = (value: string) => `s_${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
const SITE_WORDS: Record<BundleStringSite["where"], string> = {
  user: "You",
  assistant: "Agent",
  "tool-call": "tool call",
  "tool-result": "tool result",
  note: "message",
  summary: "summary",
  setting: "setting",
};
export const siteWords = (site: BundleStringSite): string =>
  site.tool && (site.where === "tool-call" || site.where === "tool-result") ? `${site.tool} ${site.where === "tool-call" ? "call" : "result"}` : SITE_WORDS[site.where];

/** One pass of cleaning: call `clean` on every string; read the counts and review items after. */
export class Cleaner {
  readonly counts = { secretsRemoved: 0, possibleKept: 0, possibleRemoved: 0, pathsRewritten: 0, absolutePathsLeft: 0 };
  /** Possible secrets, one per distinct value, first sighting kept. */
  readonly review = new Map<string, SaveReviewItem>();
  private readonly env: Redactor;
  private readonly redactor: Pick<Redactor, "redact">;
  private readonly names: RegExp | null;
  private readonly links: (text: string) => string;
  private readonly rootRes: { re: RegExp; token: string }[];
  private readonly encodedHome: RegExp | null;

  constructor(private readonly o: CleanerOptions) {
    this.env = new Redactor(envFileSources(o.envDirs), {}).refresh();
    this.redactor = o.redactor ?? serverRedactor();
    const names = (o.privateNames ?? privateNames()).filter(Boolean);
    this.names = names.length ? new RegExp(names.sort((a, b) => b.length - a.length).map(escape).join("|"), "gi") : null;
    this.links = o.links ?? ((t) => redactPreviewLinks(redactShareLinks(t)));
    const home = o.roots.find((r) => r.token === "~")?.path;
    this.encodedHome = home ? new RegExp(`${escape(home.replace(/[/\\:]/g, "-"))}(?=[-/\\s"'\`]|$)`, "g") : null;
    this.rootRes = o.roots.map((r) => ({ re: new RegExp(`${escape(r.path)}(?=[/\\s"'\`:;,)\\]}>|]|$)`, "g"), token: r.token }));
  }

  clean = (text: string, site: BundleStringSite): string => {
    if (!text) return text;
    let out = text;
    // Known secrets: always, no review.
    const before = count(out, REDACTED);
    out = this.redactor.redact(out);
    out = this.env.redact(out);
    this.counts.secretsRemoved += Math.max(0, count(out, REDACTED) - before);
    if (this.names) {
      const n = out.match(this.names)?.length ?? 0;
      if (n) {
        out = out.replace(this.names, PRIVATE_NAME);
        this.counts.secretsRemoved += n;
      }
    }
    const linked = this.links(out);
    if (linked !== out) {
      this.counts.secretsRemoved++;
      out = linked;
    }
    // Possible secrets: listed, removed only when the saver said so.
    out = out.replace(CANDIDATE, (m, offset: number, whole: string) => {
      // The value itself, without the punctuation around it (a sentence's full stop): one item per value,
      // whichever pass found it first.
      const lead = /^[.\-_/=]*/.exec(m)![0].length;
      const core = m.slice(lead).replace(/[.\-_/]+$/, "");
      const why = possibleSecretWhy(core);
      if (!why || core.startsWith("[")) return m;
      return m.slice(0, lead) + this.possible(core, why, site, offset + lead, whole) + m.slice(lead + core.length);
    });

    // A secret said in prose ("my password is hunter2!"): the value after a secret's name, listed for review.
    out = out.replace(PROSE_SECRET, (m, head: string, value: string, offset: number, whole: string) => {
      const v = value.replace(/[.,;:!?)\]"'`]+$/, "");
      if (v.length < 4 || v === REDACTED || v.startsWith("[") || /^(?:the|a|an|set|not|in|on|stored|required|empty|missing|wrong|correct|changed|here|there|it|this|that)$/i.test(v)) return m;
      return head + this.possible(v, PROSE_WHY, site, offset + head.length, whole) + value.slice(v.length);
    });
    // A pi session file of this computer (a worker's transcript): its folder name spells the folder it ran in
    // (`--home-<user>-…--`), and it means nothing elsewhere.
    out = out.replace(SESSION_FILE, () => {
      this.counts.pathsRewritten++;
      return SESSION_FILE_PLACEHOLDER;
    });
    // Paths: made portable.
    for (const r of this.rootRes) {
      out = out.replace(r.re, () => {
        this.counts.pathsRewritten++;
        return r.token;
      });
    }
    // A path spelled with dashes (pi's folder names): the home folder's spelling goes too.
    if (this.encodedHome) out = out.replace(this.encodedHome, () => {
      this.counts.pathsRewritten++;
      return "-~";
    });
    this.counts.absolutePathsLeft += out.match(ABSOLUTE)?.length ?? 0;
    return out;
  };

  /** One possible secret at `offset` in `whole`: listed once per value; its replacement if the saver removed it. */
  private possible(m: string, why: string, site: BundleStringSite, offset: number, whole: string): string {
    const id = reviewId(m);
    const decision = this.o.decisions?.[id];
    // The same value found by both passes: one item, with the more specific why.
    const seen = this.review.get(id);
    if (seen && why === PROSE_WHY) seen.why = why;
    if (!seen) {
      const from = Math.max(0, offset - 40);
      const to = Math.min(whole.length, offset + m.length + 40);
      const shown = m.length > 24 ? `${m.slice(0, 6)}…${m.slice(-4)}` : m;
      this.review.set(id, {
        id,
        kind: "possible-secret",
        where: siteWords(site),
        ...(site.at ? { at: site.at } : {}),
        excerpt: `${from > 0 ? "…" : ""}${whole.slice(from, offset)}[[${shown}]]${whole.slice(offset + m.length, to)}${to < whole.length ? "…" : ""}`.replace(/\s+/g, " "),
        why,
        bytes: Buffer.byteLength(m),
      });
    }
    if (decision === "remove") {
      this.counts.possibleRemoved++;
      return POSSIBLE_REMOVED;
    }
    this.counts.possibleKept++;
    return m;
  }

  /** The counts as the card and the report give them (images and the export's own counts filled by the caller). */
  cleaning(extra: Pick<SavedCleaning, "imagesKept" | "imagesRemoved" | "thinkingDropped" | "toolOutputsTrimmed">): SavedCleaning {
    // Each distinct value counts once in the report, whatever the number of sightings.
    let kept = 0;
    let removed = 0;
    for (const id of this.review.keys()) {
      const d = this.o.decisions?.[id];
      if (d === "remove") removed++;
      else if (d === "keep") kept++;
    }
    return { ...this.counts, possibleKept: kept, possibleRemoved: removed, ...extra };
  }
}

function count(s: string, needle: string): number {
  let n = 0;
  for (let i = s.indexOf(needle); i >= 0; i = s.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** Tokens back to this computer's paths (on continue): the root token to the top level, a worktree token to
    that branch's worktree here when one is set up, else the top level. `~` stays: it means the reader's home. */
export function restorer(top: string, worktreeOf: (branch: string) => string | null): (text: string) => string {
  return (text) => {
    if (!text.includes("{{sova:")) return text;
    return text.replace(/\{\{sova:(root|worktree:([^}]+))\}\}/g, (_m, what: string, branch?: string) => (what === "root" ? top : (worktreeOf(branch!) ?? top)));
  };
}
