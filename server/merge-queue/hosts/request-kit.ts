import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sanitizeCliError } from "./run";
import { BODY_MAX, type HostKind, TITLE_MAX } from "./types";

/**
 * The text of a pull or merge request (a18, q13): a project's "request" skill folder, built like the review's
 * (`.sova/playbooks/review`): `PLAYBOOK.md` says how to write the title and description, `references/` holds templates
 * and examples, and `scripts/check*.mjs` check a drafted text. The repo's own GitHub/GitLab template is added when it
 * has one. Without a folder, a plain default playbook (no checks of its own).
 *
 * Who drafts is injected (`draft`): the merge thread, or the plain text. Each draft goes through Sova's own checks
 * and then the folder's; a failing check sends it back to be rewritten with the reason, up to `maxAttempts`. A check
 * that can't run (or runs too long) is the folder's trouble, not the text's: the request is refused, never opened on
 * an unchecked text.
 *
 * The checks are project code run by the server: with an argument array, the draft as JSON on stdin, the folder as
 * their working directory, a timeout, and an environment with no host sign-in (a throwaway HOME, no token variables),
 * so a check can't reach GitHub or GitLab as you.
 */

export interface RequestText {
  title: string;
  body: string;
}

/** What the request is about: the facts the drafter and the plain text are written from. */
export interface RequestInput {
  host: HostKind | null;
  branch: string;
  base: string;
  /** The chat's title: the request's title by default (a5). */
  chatTitle: string;
  /** The merge thread's note on the landing. */
  note?: string;
  /** The checks Sova ran and passed. Empty: the project has no automated tests. */
  checksPassed?: string[];
  /** The review's notes (its summary and findings). */
  reviewNotes?: string;
  /** The spec claims the landing changes ("§app.x/y: what"). */
  specsChanged?: string[];
}

export interface RequestKit {
  /** The folder (absolute), or null for the plain default. */
  folder: string | null;
  playbook: string;
  references: { name: string; text: string }[];
  /** The folder's check scripts (absolute paths), in name order. */
  checks: string[];
  /** The repo's own description template, when it has one. */
  template: { path: string; text: string } | null;
}

export interface CheckOutcome {
  name: string;
  ok: boolean;
  why?: string;
}

export const SIGNATURE = "Opened by Sova";
const FILE_MAX = 64 * 1024;
const REFERENCES_MAX = 128 * 1024;
export const CHECK_TIMEOUT_MS = 20_000;

export const DEFAULT_PLAYBOOK = `# Writing a request

Write the title and description of one pull or merge request.

- Title: what the change does, in a few words, as the chat's title says it; one line, no trailing period.
- Description: what changes and why, for a reviewer who hasn't seen the chat. Then the checks Sova ran, the
  review's notes and the specs it changes, as the facts below give them. No praise, no filler.
- When the repo has its own template (below), fill in its sections instead of inventing new ones.
- End the description with "${SIGNATURE}".
`;

/** Read a file inside `dir` (never through a link leading out), at most FILE_MAX characters; null when it isn't one. */
function readInside(dir: string, rel: string): string | null {
  const p = resolve(dir, rel);
  try {
    if (!lstatSync(p).isFile()) return null;
    const real = realpathSync(p);
    const realDir = realpathSync(dir);
    if (real !== realDir && !real.startsWith(realDir + sep)) return null;
    return readFileSync(real, "utf8").slice(0, FILE_MAX);
  } catch {
    return null;
  }
}

const listFiles = (dir: string): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
};

/** The repo's own description template for `host`, when it has one (GitHub's pull_request_template, GitLab's Default
 *  merge request template, or its only one). */
export function repoTemplate(root: string, host: HostKind | null): { path: string; text: string } | null {
  const candidates: string[] = [];
  if (host !== "gitlab") {
    for (const d of [".github", ".", "docs"]) for (const f of listFiles(join(root, d))) if (/^pull_request_template\.md$/i.test(f)) candidates.push(join(d, f));
  }
  if (host !== "github") {
    const dir = join(".gitlab", "merge_request_templates");
    const md = listFiles(join(root, dir)).filter((f) => /\.md$/i.test(f));
    const def = md.find((f) => /^default\.md$/i.test(f)) ?? (md.length === 1 ? md[0] : undefined);
    if (def) candidates.push(join(dir, def));
  }
  for (const c of candidates) {
    const text = readInside(root, c);
    if (text?.trim()) return { path: c.replace(/^\.\//, ""), text };
  }
  return null;
}

/**
 * The kit for one project: its request folder (`folder`, relative to `root`, from the project's `merge.request`), or
 * the plain default when `folder` is null. → an error when the folder is named but isn't there or leads outside the
 * repo (a named folder is never silently skipped).
 */
export function loadRequestKit(root: string, folder: string | null, host: HostKind | null): RequestKit | { error: string } {
  const template = repoTemplate(root, host);
  if (!folder) return { folder: null, playbook: DEFAULT_PLAYBOOK, references: [], checks: [], template };
  if (isAbsolute(folder) || folder.split(/[\\/]/).includes("..")) return { error: `The request folder ${folder} must be a path inside the project` };
  const abs = resolve(root, folder);
  let real: string;
  try {
    real = realpathSync(abs);
    const realRoot = realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + sep)) return { error: `The request folder ${folder} leads outside the project` };
    if (!lstatSync(real).isDirectory()) return { error: `The request folder ${folder} isn't a folder` };
  } catch {
    return { error: `The request folder ${folder} isn't in the project` };
  }
  const playbook = readInside(real, "PLAYBOOK.md");
  if (!playbook?.trim()) return { error: `The request folder ${folder} has no PLAYBOOK.md` };
  const references: { name: string; text: string }[] = [];
  let budget = REFERENCES_MAX;
  for (const name of listFiles(join(real, "references"))) {
    const text = readInside(real, join("references", name));
    if (text === null || budget <= 0) continue;
    references.push({ name, text: text.slice(0, budget) });
    budget -= text.length;
  }
  const checks = listFiles(join(real, "scripts"))
    .filter((f) => /^check.*\.(?:mjs|js)$/.test(f))
    .filter((f) => readInside(real, join("scripts", f)) !== null)
    .map((f) => join(real, "scripts", f));
  return { folder: real, playbook, references, checks, template };
}

/** The drafter's brief: the playbook, its references, the repo's template and the facts. */
export function requestBrief(kit: RequestKit, input: RequestInput): string {
  const parts = [kit.playbook.trim()];
  for (const r of kit.references) parts.push(`## Reference: ${r.name}\n\n${r.text.trim()}`);
  if (kit.template) parts.push(`## The repo's own template (${kit.template.path}): fill in its sections\n\n${kit.template.text.trim()}`);
  parts.push(
    [
      "## The facts",
      `- Branch: ${input.branch} into ${input.base}${input.host ? ` (${input.host === "github" ? "a GitHub pull request" : "a GitLab merge request"})` : ""}`,
      `- Chat title: ${input.chatTitle}`,
      input.note ? `- The merge thread's note: ${input.note}` : "",
      `- Sova's checks: ${input.checksPassed?.length ? input.checksPassed.join(", ") : "none (the project has no automated tests)"}`,
      input.reviewNotes ? `- Review: ${input.reviewNotes}` : "",
      input.specsChanged?.length ? `- Specs it changes:\n${input.specsChanged.map((s) => `  - ${s}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  parts.push(`Answer with the title (one line) and the description (Markdown), ending "${SIGNATURE}".`);
  return parts.join("\n\n");
}

/** Sova's text without a drafter: the chat's title, then what Sova knows, ending "Opened by Sova". */
export function plainRequestText(input: RequestInput): RequestText {
  const sections = [
    `## What this changes\n\n${input.note?.trim() || `The work on ${input.branch}.`}`,
    `## Sova's checks\n\n${input.checksPassed?.length ? input.checksPassed.map((c) => `- ${c}: passed`).join("\n") : "No automated tests (the project's setting)."}`,
    `## Review\n\n${input.reviewNotes?.trim() || "No notes."}`,
    ...(input.specsChanged?.length ? [`## Specs\n\n${input.specsChanged.map((s) => `- ${s}`).join("\n")}`] : []),
  ];
  return { title: oneLine(input.chatTitle) || input.branch, body: `${sections.join("\n\n")}\n\n---\n${SIGNATURE}\n` };
}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, TITLE_MAX);

/** The body with "Opened by Sova" as its last line. */
export function signed(body: string): string {
  const b = body.replace(/\s+$/, "");
  return b.endsWith(SIGNATURE) ? `${b}\n` : `${b}\n\n${SIGNATURE}\n`;
}

/** Sova's own checks of any text: a title of one line, both present, within the hosts' limits. */
export function sovaTextChecks(t: RequestText): CheckOutcome {
  if (typeof t.title !== "string" || !t.title.trim()) return { name: "Sova", ok: false, why: "the title is empty" };
  if (/[\r\n]/.test(t.title.trim())) return { name: "Sova", ok: false, why: "the title must be one line" };
  if (t.title.length > TITLE_MAX) return { name: "Sova", ok: false, why: `the title is longer than ${TITLE_MAX} characters` };
  if (typeof t.body !== "string" || !t.body.trim()) return { name: "Sova", ok: false, why: "the description is empty" };
  if (t.body.length > BODY_MAX) return { name: "Sova", ok: false, why: `the description is longer than ${BODY_MAX} characters` };
  return { name: "Sova", ok: true };
}

/** The environment a check runs in: no host sign-in reachable (a throwaway HOME and config dir, no token variable). */
function checkEnv(home: string): NodeJS.ProcessEnv {
  const keep = ["PATH", "LANG", "LC_ALL", "TZ"];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return { ...env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), TMPDIR: home, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GLAB_NO_PROMPT: "true", NO_COLOR: "1" };
}

type RunCheck = (script: string, input: string, opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string; timedOut?: true; failedToStart?: string }>;

const runCheckScript: RunCheck = (script, input, opts) =>
  new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(process.execPath, [script], { cwd: opts.cwd, env: opts.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      done({ code: 127, stdout: "", stderr: "", failedToStart: String((err as Error).message ?? err) });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout!.on("data", (b: Buffer) => (stdout = (stdout + b.toString("utf8")).slice(0, 64 * 1024)));
    child.stderr!.on("data", (b: Buffer) => (stderr = (stderr + b.toString("utf8")).slice(0, 64 * 1024)));
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ code: 127, stdout, stderr, failedToStart: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ code: timedOut ? 124 : (code ?? 1), stdout, stderr, ...(timedOut ? { timedOut: true as const } : {}) });
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(input);
  });

/**
 * Run Sova's checks, then each of the folder's, on one text. A check passes with exit 0; any other exit fails the
 * text, its reason the first lines it wrote (stderr, else stdout). `broken`: a check that couldn't run or ran past its
 * time, which stops the drafting (fail closed).
 */
export async function checkRequestText(kit: RequestKit, text: RequestText, input: RequestInput, opts: { run?: RunCheck; timeoutMs?: number } = {}): Promise<{ checks: CheckOutcome[]; broken?: string }> {
  const own = sovaTextChecks(text);
  if (!own.ok) return { checks: [own] };
  const checks: CheckOutcome[] = [own];
  if (!kit.folder || !kit.checks.length) return { checks };
  const home = mkdtempSync(join(tmpdir(), "sova-request-check-"));
  try {
    const stdin = JSON.stringify({ title: text.title, body: text.body, host: input.host, branch: input.branch, base: input.base });
    for (const script of kit.checks) {
      const name = basename(script);
      const r = await (opts.run ?? runCheckScript)(script, stdin, { cwd: kit.folder, env: checkEnv(home), timeoutMs: opts.timeoutMs ?? CHECK_TIMEOUT_MS });
      if (r.failedToStart) return { checks, broken: `The request folder's check ${name} couldn't run: ${sanitizeCliError(r.failedToStart)}` };
      if (r.timedOut) return { checks, broken: `The request folder's check ${name} ran past ${Math.round((opts.timeoutMs ?? CHECK_TIMEOUT_MS) / 1000)} s` };
      if (r.code === 0) checks.push({ name, ok: true });
      else {
        checks.push({ name, ok: false, why: sanitizeCliError(r.stderr || r.stdout, `${name} exited with ${r.code}`) });
        return { checks };
      }
    }
    return { checks };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** What a drafter gets back when its text failed a check: the text and the reason, to rewrite it. */
export interface Rejection {
  text: RequestText;
  failed: CheckOutcome;
}

export type Drafter = (brief: string, rejection: Rejection | null) => Promise<RequestText>;

export type DraftOutcome = { ok: true; title: string; body: string; checks: CheckOutcome[]; attempts: number; rejections: Rejection[] } | { ok: false; why: string; checks: CheckOutcome[]; rejections: Rejection[]; /** The last text the checks failed, for the user to edit and publish anyway (q10); absent when no text was checked (a broken check, a failed drafter). */ text?: RequestText };

/**
 * Draft the request's text until it passes every check: `draft` writes it from the brief (and, after a failure, the
 * failed text and the reason), "Opened by Sova" is kept as its last line, and the checks run. → the text that passed,
 * or why there is none (every attempt failed, a check couldn't run, the drafter failed). The caller shows the text to
 * the user before anything is published (q10).
 */
export async function draftRequest(o: { kit: RequestKit; input: RequestInput; draft?: Drafter; maxAttempts?: number; run?: RunCheck; timeoutMs?: number }): Promise<DraftOutcome> {
  const draft: Drafter = o.draft ?? (async () => plainRequestText(o.input));
  const brief = requestBrief(o.kit, o.input);
  // The plain text never changes between attempts: one is enough.
  const max = o.draft ? Math.max(1, o.maxAttempts ?? 3) : 1;
  const rejections: Rejection[] = [];
  let last: CheckOutcome[] = [];
  for (let attempt = 1; attempt <= max; attempt++) {
    let text: RequestText;
    try {
      const t = await draft(brief, rejections.at(-1) ?? null);
      text = { title: typeof t?.title === "string" ? t.title.trim() : "", body: typeof t?.body === "string" ? signed(t.body) : "" };
    } catch (err) {
      return { ok: false, why: `Writing the request's text failed: ${sanitizeCliError(String((err as Error)?.message ?? err))}`, checks: last, rejections };
    }
    const r = await checkRequestText(o.kit, text, o.input, { ...(o.run ? { run: o.run } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}) });
    last = r.checks;
    if (r.broken) return { ok: false, why: r.broken, checks: r.checks, rejections };
    const failed = r.checks.find((c) => !c.ok);
    if (!failed) return { ok: true, title: text.title, body: text.body, checks: r.checks, attempts: attempt, rejections };
    rejections.push({ text, failed });
  }
  const f = rejections.at(-1)!.failed;
  return { ok: false, why: `The request's text failed ${f.name === "Sova" ? "Sova's check" : `the check ${f.name}`} ${max} time${max === 1 ? "" : "s"}: ${f.why ?? "no reason given"}`, checks: last, rejections, text: rejections.at(-1)!.text };
}

/** The folder as the project names it (for messages): relative to the root. */
export const kitLabel = (root: string, kit: RequestKit): string => (kit.folder ? relative(realpathSync(root), kit.folder) || "." : "the plain default");
