import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, createReadStream } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import type { MergeRun } from "../../shared/merge-queue";
import {
  type AnyVerb,
  type ErrorCode,
  isReleaseVerb,
  isTagName,
  ordered,
  type ProjectDef,
  RELEASE_READ_VERBS,
  RELEASE_THREAD_VERBS,
  type ReleaseDecl,
  releaseTagOf,
  type ReleaseVerb,
  type VerbResult,
  versionOfTag,
  versionProblem,
} from "../../shared/project-contract";
import {
  isReleaseOpen,
  NOTES_MAX,
  parseFacts,
  parseReleaseManifest,
  planOf,
  RELEASE_ID,
  RELEASE_MANIFEST_FILE,
  REPORTED_STATES,
  type ReleaseFacts,
  type ReleaseGates,
  type ReleaseHistoryItem,
  type ReleaseManifest,
  type ReleaseRecord,
  type ReleaseReport,
  type ReleaseStep,
  type ReleaseView,
  SOVA_STEP_IDS,
  STEP_DETAIL_MAX,
  STEP_SUMMARY_MAX,
  type StepState,
} from "../../shared/release";
import { NO_BACKGROUND_CLEANUP } from "../git-no-background";
import { type Git, isAncestor, realGit as queueGit, revParse } from "../merge-queue/guard";
import type { ProjectQueue, ReleaseQueueEvent } from "../merge-queue/queue";
import { MergeFailure } from "../merge-queue/queue";
import { changelogSection } from "../updates/check";
import { callerTag, type Caller } from "./engine";

/**
 * Release (al_1): a project's numbered versions, cut by its release playbook's chat and held by Sova where it can't
 * be undone. The record per release, the verbs and who may call each (t16, t17, q3, q12), the facts Sova checks itself
 * (q10: facts win), the queue's hold (q9) and Publish / Abandon / Withdraw through the queue (a6, a8, t23, t24).
 *
 * The release chat works in its own worktree (`release/<id>`, cut from the frozen target) and reports each step
 * through its own project_verbs tool; Sova adds the release commit to the merge queue itself when the `commit` step is
 * reported done, follows that entry's run as the `checks` step, and lands it without a push. Publish is one queue call
 * that tags, moves the channels and pushes master with both, or tags locally for a project that doesn't push.
 */

export class ReleaseFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Refusals, in the operator's and the chats' words. */
export const FROM_CHAT = "a chat's script never acts as the operator on a release: the operator does it on the Releases tab";
export const REPORTS_FROM_THREAD = "reports come from the release chat's own tool, never the operator's route";
export const SESSION_NEVER = "a coding session never starts or asks for a release: tell the operator in your report";
export const NOT_INITIALIZED = "releases aren't set up for this project: Set Up Releases on its Releases tab (the release section of .sova/project.json and its playbook's release.json)";
export const ASK_INSTEAD = "ask for it instead: release.request {why} raises it for the operator";

const OPERATOR_ACTS: readonly ReleaseVerb[] = ["release.start", "release.continue", "release.retry", "release.publish", "release.abandon", "release.withdraw"];
const CONFIRMED: readonly ReleaseVerb[] = ["release.publish", "release.abandon", "release.withdraw"];

export interface ReleaseRequestRecord {
  id: string;
  project: string;
  why: string;
  by: string;
  at: string;
}

/** The release chat's start and wake (live: Sova's own routes; tests: stand-ins). */
export interface ReleaseThreadDeps {
  start(input: { root: string; checkout: string; text: string; title: string }): Promise<{ id: string; path: string } | { error: string }>;
  wake(path: string, text: string): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface ReleaserDeps {
  /** `<state root>/project-services/release`. */
  dir: string;
  /** The project's queue (loaded). */
  queue(root: string): Promise<ProjectQueue>;
  /** The project root holding a path, when it is a project. */
  rootOf(path: string): Promise<string | null>;
  /** The definition at a ref (the queue target's tip). */
  definitionAt(root: string, ref: string): Promise<{ def: ProjectDef | null; error: string | null }>;
  thread: ReleaseThreadDeps;
  git?: Git;
  now?: () => number;
  /** The project's id (Needs you links), when registered. */
  projectIdOf?: (root: string) => string | null;
  /** The release view changed (the WS feed). */
  publish?: (view: ReleaseView) => void;
  /** Needs you may have changed. */
  attention?: () => void;
  /** Deploy targets whose last verified deploy is at `sha` (the history's "deployed to"), and the project's targets. */
  deployedTo?: (root: string, sha: string) => string[];
  /** Minutes without a report before the quiet item (default: the settings' quietMin; SOVA_RELEASE_QUIET_MS in tests). */
  quietMs?: (settings: ReleaseDecl) => number;
  log?: (line: string) => void;
}

interface Req {
  project?: string;
  release?: string;
  tag?: string;
  step?: string;
  state?: string;
  summary?: string;
  detail?: string;
  facts?: string[];
  text?: string;
  why?: string;
  commit?: string;
  lines?: number;
  confirm?: boolean;
  dismiss?: boolean;
}

const KEYS: Record<keyof Req, "string" | "strings" | "number" | "boolean"> = {
  project: "string",
  release: "string",
  tag: "string",
  step: "string",
  state: "string",
  summary: "string",
  detail: "string",
  facts: "strings",
  text: "string",
  why: "string",
  commit: "string",
  lines: "number",
  confirm: "boolean",
  dismiss: "boolean",
};

function parse(body: unknown): Req {
  if (body === undefined || body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) throw new ReleaseFailure("invalid-request", "the body is a JSON object");
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    const want = KEYS[k as keyof Req];
    if (!want) continue;
    const ok =
      want === "strings"
        ? Array.isArray(v) && v.length <= 20 && v.every((x) => typeof x === "string" && x.length > 0 && x.length <= 1000)
        : want === "number"
          ? typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 5000
          : want === "string"
            ? typeof v === "string" && v.length <= (k === "text" ? NOTES_MAX : k === "detail" ? STEP_DETAIL_MAX : 4000)
            : typeof v === "boolean";
    if (!ok) throw new ReleaseFailure("invalid-request", `"${k}" must be ${want === "strings" ? "a list of key=value items" : want === "number" ? "a whole number (1–5000)" : `a ${want}${k === "text" ? ` (at most ${NOTES_MAX} characters)` : ""}`}`);
    out[k] = v;
  }
  return out as Req;
}

const short = (s: string | null | undefined) => (s ?? "").slice(0, 7);
const projectKey = (root: string): string => createHash("sha256").update(root).digest("hex").slice(0, 16);
const newReleaseId = () => `rl_${Date.now().toString(36)}${randomBytes(4).toString("hex")}`;

function writeAtomic(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 1)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}
function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The caller's own project when it is scoped (a chat, an overseer of one project, the Project Assistant). */
const scopeOf = (c: Caller): string | null | undefined => (c.kind === "session" || c.kind === "project-overseer" || c.kind === "assistant" ? c.root : undefined);
const viaAct = (c: Caller): boolean => (c.kind === "project-overseer" || c.kind === "assistant") && (c as { releaseAct?: true }).releaseAct === true;
const fromChat = (c: Caller): boolean => c.kind === "operator" && (c as { fromChat?: true }).fromChat === true;

/**
 * Who may call which release verb (CONTRACT §5, t17). `isThread`: the caller is this project's open release's chat.
 */
export function authorizeRelease(verb: ReleaseVerb, caller: Caller, root: string, req: { confirm?: boolean; dismiss?: boolean }, isThread: boolean): void {
  if (caller.kind === "conform" || caller.kind === "system") throw new ReleaseFailure("forbidden", `${caller.kind === "conform" ? "conformance" : "Sova on its own"} never releases`);
  const scope = scopeOf(caller);
  if (scope !== undefined && scope !== root) throw new ReleaseFailure("forbidden", `this caller acts only on its own project${scope ? ` (${scope})` : ""}`);
  if (RELEASE_READ_VERBS.includes(verb)) return;
  if (RELEASE_THREAD_VERBS.includes(verb)) {
    if (caller.kind === "session" && isThread) return;
    if (caller.kind === "operator") throw new ReleaseFailure("forbidden", REPORTS_FROM_THREAD);
    if (caller.kind === "session") throw new ReleaseFailure("forbidden", "only the release's own chat reports its steps");
    throw new ReleaseFailure("forbidden", "only the release's own chat reports its steps; an overseer reads them with release.status");
  }
  if (verb === "release.request") {
    if (caller.kind === "session") throw new ReleaseFailure("forbidden", isThread ? "the release chat never asks for another release" : SESSION_NEVER);
    if (caller.kind === "operator") {
      if (fromChat(caller)) throw new ReleaseFailure("forbidden", FROM_CHAT);
      if (req.dismiss) return;
      throw new ReleaseFailure("invalid-request", "you start a release yourself (release.start); release.request {dismiss: true} closes a request");
    }
    return;
  }
  // The operator's acts.
  if (caller.kind === "operator") {
    if (fromChat(caller)) throw new ReleaseFailure("forbidden", FROM_CHAT);
    if (CONFIRMED.includes(verb) && !req.confirm) throw new ReleaseFailure("needs-confirm", `${verb} needs confirm: true (it ${verb === "release.publish" ? "makes the version public" : verb === "release.withdraw" ? "moves the channels back" : "reverts the release commit"})`);
    return;
  }
  if (caller.kind === "session") {
    if (isThread && verb === "release.abandon") throw new ReleaseFailure("forbidden", "the release chat may ask the operator to abandon (say why in your report), never abandon itself");
    throw new ReleaseFailure("forbidden", isThread ? "that is the operator's: say what you need in your report" : SESSION_NEVER);
  }
  // Overseers and the Project Assistant: start and publish only through the release power's act; the rest is the operator's.
  if ((verb === "release.start" || verb === "release.publish") && viaAct(caller)) return;
  if (verb === "release.start" || verb === "release.publish") throw new ReleaseFailure("forbidden", caller.kind === "overseer" ? `${verb} is the operator's or a project overseer's with the release power; ${ASK_INSTEAD}` : `${verb} needs the release power (its act); ${ASK_INSTEAD}`);
  throw new ReleaseFailure("forbidden", `${verb} is the operator's alone`);
}

/** Where a release chat's worktree goes: beside the project, in the `.worktrees` folder Sova's worktrees use. */
export const releaseCheckoutOf = (root: string, id: string): string => join(dirname(root), ".worktrees", `${basename(root)}-release-${id}`);
export const releaseBranchOf = (id: string): string => `release/${id}`;

export class Releaser {
  private readonly git: Git;
  private chains = new Map<string, Promise<unknown>>();
  private quietSeen = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ReleaserDeps) {
    this.git = deps.git ?? queueGit;
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private iso(): string {
    return new Date(this.now()).toISOString();
  }
  private log(line: string): void {
    (this.deps.log ?? ((l) => console.log(l)))(`[release] ${line}`);
  }

  // ---- the store --------------------------------------------------------------------------------

  private projectDir(root: string): string {
    return join(this.deps.dir, projectKey(root));
  }
  private recordFile(root: string, id: string): string {
    return join(this.projectDir(root), `${id}.json`);
  }
  records(root: string): ReleaseRecord[] {
    let names: string[] = [];
    try {
      names = readdirSync(this.projectDir(root)).filter((f) => /^rl_[0-9a-z]+\.json$/.test(f));
    } catch {}
    return names
      .map((n) => readJson<ReleaseRecord>(join(this.projectDir(root), n)))
      .filter((r): r is ReleaseRecord => !!r && r.project === root)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }
  record(root: string, id: string): ReleaseRecord | null {
    if (!RELEASE_ID.test(id)) return null;
    return readJson<ReleaseRecord>(this.recordFile(root, id));
  }
  openRecord(root: string): ReleaseRecord | null {
    return this.records(root).find((r) => isReleaseOpen(r.state)) ?? null;
  }
  private save(rec: ReleaseRecord): void {
    writeAtomic(this.recordFile(rec.project, rec.id), rec);
  }
  private requestsFile(): string {
    return join(this.deps.dir, "requests.json");
  }
  requests(): ReleaseRequestRecord[] {
    return readJson<ReleaseRequestRecord[]>(this.requestsFile()) ?? [];
  }

  /** Every project root with a release record (the stall timer, attention). */
  roots(): string[] {
    const out = new Set<string>();
    let dirs: string[] = [];
    try {
      dirs = readdirSync(this.deps.dir).filter((d) => /^[0-9a-f]{16}$/.test(d));
    } catch {}
    for (const d of dirs) {
      try {
        for (const f of readdirSync(join(this.deps.dir, d))) {
          if (!/^rl_.*\.json$/.test(f)) continue;
          const r = readJson<ReleaseRecord>(join(this.deps.dir, d, f));
          if (r?.project) out.add(r.project);
          break;
        }
      } catch {}
    }
    for (const q of this.requests()) out.add(q.project);
    return [...out];
  }

  /** Serialize every change per project. */
  private serial<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(root) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    this.chains.set(root, p.catch(() => {}));
    return p;
  }

  // ---- the verbs --------------------------------------------------------------------------------

  /** Whether `caller` is the chat of `root`'s open release. */
  isThread(root: string, caller: Caller): boolean {
    if (caller.kind !== "session") return false;
    const open = this.openRecord(root);
    if (open?.thread?.session === caller.id) return true;
    // A published (or withdrawn) release's chat still reports its after (or withdraw) steps.
    const last = this.lastRecord(root);
    return !!last && last.thread?.session === caller.id && (last.state === "published" || last.state === "withdrawn");
  }

  private lastRecord(root: string): ReleaseRecord | null {
    const done = this.records(root).filter((r) => !isReleaseOpen(r.state));
    return done[done.length - 1] ?? null;
  }

  /** One release verb for `caller`: every outcome is a result. */
  async run(verb: string, body: unknown, caller: Caller): Promise<VerbResult> {
    let root: string | null = null;
    let changed = false;
    let report: ReleaseReport | undefined;
    try {
      if (!isReleaseVerb(verb)) throw new ReleaseFailure("invalid-request", `unknown verb "${verb}"`);
      const req = parse(body);
      root = await this.rootOfReq(req, caller);
      const thread = this.isThread(root, caller);
      authorizeRelease(verb, caller, root, req, thread);
      const r = await this.serial(root, () => this.dispatch(verb, req, root!, caller));
      changed = r.changed;
      report = r.report;
      if (changed) this.changed(root);
      return this.result(verb, root, true, changed, report);
    } catch (err) {
      const f = err instanceof ReleaseFailure ? err : err instanceof MergeFailure ? new ReleaseFailure(err.code, err.message) : new ReleaseFailure("busy", err instanceof Error ? err.message : String(err));
      const record = (err as { record?: ReleaseRecord }).record;
      if (record) report = { release: record };
      if (changed && root) this.changed(root);
      return this.result((isReleaseVerb(verb) ? verb : "release.status") as AnyVerb, root, false, changed, report, { code: f.code, message: f.message });
    }
  }

  private result(verb: AnyVerb, root: string | null, ok: boolean, changed: boolean, release: ReleaseReport | undefined, error?: VerbResult["error"]): VerbResult {
    return ordered({
      v: 1,
      verb,
      project: root,
      instance: null,
      slot: null,
      generation: null,
      checkout: null,
      branch: null,
      ok,
      changed,
      state: "absent",
      steps: [],
      services: [],
      data: [],
      links: [],
      ...(release ? { release } : {}),
      ...(error ? { error } : {}),
      defHash: null,
      at: this.iso(),
    });
  }

  private async rootOfReq(req: Req, caller: Caller): Promise<string> {
    const named = req.project?.trim();
    if (named) {
      if (!isAbsolute(named)) throw new ReleaseFailure("invalid-request", "project is an absolute path inside the project");
      const r = await this.deps.rootOf(named);
      if (!r) throw new ReleaseFailure("not-found", `${named} is not inside a project`);
      return r;
    }
    const own = scopeOf(caller);
    if (own) return own;
    throw new ReleaseFailure("invalid-request", "name the project (an absolute path inside it)");
  }

  private async dispatch(verb: ReleaseVerb, req: Req, root: string, caller: Caller): Promise<{ changed: boolean; report: ReleaseReport }> {
    switch (verb) {
      case "release.status":
        return { changed: false, report: { view: await this.view(root) } };
      case "release.logs":
        return { changed: false, report: { lines: await this.logs(root, req) } };
      case "release.request":
        return this.request(root, req, caller);
      case "release.start":
        return this.start(root, req, caller);
      case "release.step":
        return this.step(root, req);
      case "release.notes":
        return this.notes(root, req);
      case "release.continue":
        return this.continueStep(root, req);
      case "release.retry":
        return this.retry(root, req);
      case "release.publish":
        return this.publish(root, req, caller);
      case "release.abandon":
        return this.abandon(root, req);
      case "release.withdraw":
        return this.withdraw(root, req);
    }
  }

  private mustRecord(root: string, id: string | undefined, open = true): ReleaseRecord {
    const rec = id ? this.record(root, id) : this.openRecord(root);
    if (!rec || rec.project !== root) throw new ReleaseFailure("not-found", id ? `no release ${id} in this project` : "this project has no release open");
    if (open && !isReleaseOpen(rec.state)) throw new ReleaseFailure("release-refused", `release ${rec.version ?? rec.id} is ${rec.state}`);
    return rec;
  }

  // ---- settings and manifest ----------------------------------------------------------------------

  /** The release section and manifest, read from the queue target's tip (as merge is). */
  async settingsAt(root: string): Promise<{ target: string; head: string | null; def: ProjectDef | null; settings: ReleaseDecl | null; manifest: ReleaseManifest | null; problem?: string }> {
    const q = await this.deps.queue(root);
    const head = await q.targetHead();
    if (!head) return { target: q.target, head: null, def: null, settings: null, manifest: null, problem: `${q.target} has no commit` };
    const at = await this.deps.definitionAt(root, head);
    if (!at.def) {
      const missing = !at.error || /^no \.sova\/project\.json/.test(at.error) || /^no commit/.test(at.error);
      return { target: q.target, head, def: null, settings: null, manifest: null, ...(missing ? {} : { problem: `.sova/project.json is invalid: ${at.error}` }) };
    }
    const settings = at.def.release ?? null;
    if (!settings) return { target: q.target, head, def: at.def, settings: null, manifest: null };
    const file = `${settings.playbook.replace(/\/+$/, "")}/${RELEASE_MANIFEST_FILE}`;
    const shown = await this.git(["show", `${head}:${file}`], root);
    if (shown.code !== 0) return { target: q.target, head, def: at.def, settings, manifest: null, problem: `${file} isn't on ${q.target}: the release playbook's manifest is missing` };
    try {
      return { target: q.target, head, def: at.def, settings, manifest: parseReleaseManifest(shown.stdout) };
    } catch (err) {
      return { target: q.target, head, def: at.def, settings, manifest: null, problem: `${file}: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ---- start ----------------------------------------------------------------------------------------

  private async start(root: string, req: Req, caller: Caller): Promise<{ changed: boolean; report: ReleaseReport }> {
    const s = await this.settingsAt(root);
    if (!s.settings) throw new ReleaseFailure("release-refused", s.problem ?? NOT_INITIALIZED);
    if (!s.manifest) throw new ReleaseFailure("release-refused", s.problem ?? "the release playbook's manifest is missing");
    const open = this.openRecord(root);
    if (open) throw new ReleaseFailure("release-refused", `release ${open.version ?? open.id} is already open (${open.state})`);
    const q = await this.deps.queue(root);
    if (req.commit && s.settings.commit) throw new ReleaseFailure("invalid-request", "commit names a landed commit for a tag-only release; this project makes a release commit");
    if (req.commit) {
      const sha = await revParse(this.git, root, req.commit);
      if (!sha || sha !== s.head) throw new ReleaseFailure("release-refused", `a tag-only release is of ${q.target}'s tip (${short(s.head)}): ${req.commit} isn't it`);
    }
    const id = newReleaseId();
    const { base } = await q.freezeForRelease({ id, version: null, state: "preparing", checks: s.settings.checks });
    const at = this.iso();
    const rec: ReleaseRecord = {
      id,
      project: root,
      state: "preparing",
      version: null,
      tag: null,
      channels: [...s.settings.channels],
      base,
      commit: s.settings.commit ? null : base,
      entry: null,
      thread: null,
      steps: planOf(s.manifest),
      notes: null,
      artifacts: [],
      startedAt: at,
      startedBy: caller.kind === "operator" ? "operator" : "power",
      lastReportAt: null,
      manifest: s.manifest,
      settings: structuredClone(s.settings),
    };
    this.save(rec);
    // The release chat, in a worktree of its own cut from the frozen target.
    const checkout = releaseCheckoutOf(root, id);
    const branch = releaseBranchOf(id);
    const wt = await this.git([...NO_BACKGROUND_CLEANUP, "worktree", "add", "-b", branch, checkout, base], root);
    if (wt.code !== 0) return this.failStart(rec, q, `couldn't make the release worktree: ${(wt.stderr || wt.stdout).trim().split("\n")[0]}`);
    const started = await this.deps.thread.start({ root, checkout, text: this.firstMessage(rec, checkout, branch), title: `Release (${basename(root)})` });
    if ("error" in started) return this.failStart(rec, q, `the release chat couldn't start: ${started.error}`);
    rec.thread = { session: started.id, path: started.path, checkout, branch };
    rec.lastReportAt = at;
    this.save(rec);
    this.log(`${root}: started ${id} at ${short(base)} (${rec.startedBy})`);
    return { changed: true, report: { release: rec, view: await this.view(root) } };
  }

  private async failStart(rec: ReleaseRecord, q: ProjectQueue, why: string): Promise<never> {
    rec.state = "abandoned";
    rec.abandoned = { at: this.iso(), why, revert: null };
    this.save(rec);
    await q.abandonRelease({ release: rec.id, why }).catch(() => {});
    this.changed(rec.project);
    throw new ReleaseFailure("start-failed", why);
  }

  private firstMessage(rec: ReleaseRecord, checkout: string, branch: string): string {
    const plan = rec.steps.map((s) => `- ${s.id} (${s.phase}${s.held ? ", held for the operator" : ""}${s.artifact ? ", reports an artifact" : ""}): ${s.label}`).join("\n");
    return [
      `Release ${rec.id} of ${rec.project} started. You are its release chat: follow Sova's release method (playbooks/release) and this project's playbook (${rec.settings.playbook}); the project's playbook wins where they differ, Sova's gates always apply.`,
      `Work in ${checkout} (branch ${branch}, cut from ${short(rec.base)}, the frozen ${rec.settings.commit ? "target" : "release commit"}). Never push, tag or move a branch yourself: Sova does it at Publish.`,
      `The plan:\n${plan}`,
      `Report each step through project_verbs: release.step {release: "${rec.id}", step, state: running|done|failed|skipped|held, summary, detail?, facts?} (facts: version=…, commit=…, branch=…, url=…, artifact=<path>, sha256=…, size=…), and the notes with release.notes {release: "${rec.id}", text}. The version step reports version=; ${rec.settings.commit ? `the commit step reports commit=<sha> branch=${branch}: Sova then puts it in the merge queue and runs the gating checks` : "this release is tag-only: the gating checks start when the last prepare step is done"}. Sova checks the facts it can see; where they disagree, the fact wins.`,
      "Stop after each held step and wait: the operator's Continue wakes you.",
    ].join("\n\n");
  }

  // ---- steps --------------------------------------------------------------------------------------

  private async step(root: string, req: Req): Promise<{ changed: boolean; report: ReleaseReport }> {
    const rec = this.mustRecord(root, req.release, false);
    if (!req.step) throw new ReleaseFailure("invalid-request", "name the step");
    if ((SOVA_STEP_IDS as readonly string[]).includes(req.step)) throw new ReleaseFailure("release-refused", `${req.step} is Sova's own step: you never report it`);
    const st = rec.steps.find((s) => s.id === req.step);
    if (!st) throw new ReleaseFailure("release-refused", `${req.step} isn't a step of this release's plan (${rec.steps.filter((s) => s.phase !== "sova").map((s) => s.id).join(", ")})`);
    const state = req.state as StepState;
    if (!REPORTED_STATES.includes(state)) throw new ReleaseFailure("invalid-request", `state is one of ${REPORTED_STATES.join(", ")}`);
    const summary = (req.summary ?? "").trim();
    if (!summary) throw new ReleaseFailure("invalid-request", "give a one-line summary");
    if (summary.length > STEP_SUMMARY_MAX) throw new ReleaseFailure("invalid-request", `the summary is at most ${STEP_SUMMARY_MAX} characters`);
    let facts: ReleaseFacts = {};
    try {
      facts = parseFacts(req.facts ?? []);
    } catch (err) {
      throw new ReleaseFailure("invalid-request", err instanceof Error ? err.message : String(err));
    }
    // Order: each phase only in its time.
    const checks = rec.steps.find((s) => s.id === "checks")!;
    const phaseWhy =
      st.phase === "prepare"
        ? rec.state !== "preparing" || checks.state !== "waiting"
          ? "the gating checks began: prepare steps are over (abandon and start again to change them)"
          : null
        : st.phase === "check"
          ? !isReleaseOpen(rec.state) || checks.state !== "done"
            ? "check steps run once the gating checks passed and the release commit landed"
            : null
          : st.phase === "after"
            ? rec.state !== "published" && rec.state !== "withdrawn"
              ? "after-publish steps run once the release is published"
              : null
            : rec.state !== "withdrawn"
              ? "withdraw steps run once the release is withdrawn"
              : null;
    if (phaseWhy) throw new ReleaseFailure("release-refused", phaseWhy);
    if (st.state === "done" && state !== "done") throw new ReleaseFailure("release-refused", `${st.id} is done already`);
    if (st.held && st.state === "held" && state === "done") throw new ReleaseFailure("release-refused", `${st.id} is held for the operator's Continue`);
    st.summary = summary;
    if (req.detail !== undefined) st.detail = req.detail.slice(0, STEP_DETAIL_MAX);
    if (Object.keys(facts).length) st.facts = facts;
    st.by = "thread";
    st.at = this.iso();
    delete st.fact;
    st.state = state === "done" && st.held ? "held" : state;
    rec.lastReportAt = this.iso();
    this.quietSeen.delete(rec.id);
    // Sova's facts.
    let refused: string | null = null;
    if (state === "done") {
      const check = await this.checkFacts(rec, st, facts);
      if (!check.ok) {
        st.state = "failed";
        st.fact = check;
        refused = check.why;
      } else if (check.why) st.fact = check;
    }
    if (!refused && state === "done") await this.afterDone(rec, st);
    this.save(rec);
    if (refused) {
      this.changed(root);
      throw Object.assign(new ReleaseFailure("release-refused", `Sova's facts disagree: ${refused}`), { record: rec });
    }
    return { changed: true, report: { release: rec } };
  }

  /** Sova's check of a done step's facts (q10: the fact wins). */
  private async checkFacts(rec: ReleaseRecord, st: ReleaseStep, facts: ReleaseFacts): Promise<{ ok: boolean; why: string }> {
    const root = rec.project;
    if (st.id === "version" || facts.version) {
      const v = facts.version;
      if (!v) return { ok: false, why: "the version step reports version=<the version>" };
      const p = versionProblem(rec.settings.scheme, v);
      if (p) return { ok: false, why: p };
      const tag = releaseTagOf(rec.settings.tag, v);
      if (!isTagName(tag)) return { ok: false, why: `${tag} isn't a valid tag name` };
      if (await revParse(this.git, root, `refs/tags/${tag}`)) return { ok: false, why: `${tag} already exists: a numbered version is used once` };
      if (rec.settings.channels.includes(tag)) return { ok: false, why: `${tag} is a channel's name` };
      const other = this.records(root).find((r) => r.id !== rec.id && r.tag === tag && r.state !== "abandoned");
      if (other) return { ok: false, why: `${tag} belongs to release ${other.id}` };
    }
    if (st.id === "commit" && rec.settings.commit) {
      const c = facts.commit;
      if (!c) return { ok: false, why: "the commit step reports commit=<the release commit's sha>" };
      const sha = await revParse(this.git, root, c);
      if (!sha) return { ok: false, why: `no commit ${c} in the repository` };
      if (sha === rec.base) return { ok: false, why: `${short(c)} is the release's base: make the release commit first` };
      if (!(await isAncestor(this.git, root, rec.base, sha))) return { ok: false, why: `${short(sha)} isn't cut from the release's base ${short(rec.base)}` };
      const branch = facts.branch ?? rec.thread?.branch ?? releaseBranchOf(rec.id);
      const tip = await revParse(this.git, root, `refs/heads/${branch}`);
      if (!tip || !(await isAncestor(this.git, root, sha, tip))) return { ok: false, why: `${short(sha)} isn't on ${branch}` };
      if (!rec.version) return { ok: false, why: "report the version step (version=…) before the release commit" };
      facts.commit = sha;
      facts.branch = branch;
    }
    if (st.artifact || facts.artifact) {
      const a = facts.artifact;
      if (!a) return { ok: false, why: `${st.id} reports the artifact it built: artifact=<path> (sha256=, size=)` };
      if (!isAbsolute(a.path)) return { ok: false, why: "artifact is an absolute path" };
      const inside = [root, rec.thread?.checkout].filter((d): d is string => !!d).find((d) => !relative(d, a.path).startsWith("..") && !isAbsolute(relative(d, a.path)));
      if (inside) {
        const ign = await this.git(["check-ignore", "-q", a.path], inside);
        if (ign.code !== 0) return { ok: false, why: `${a.path} is inside the repository and not ignored: artifacts are never committed` };
        const tracked = await this.git(["ls-files", "--error-unmatch", a.path], inside);
        if (tracked.code === 0) return { ok: false, why: `${a.path} is committed: artifacts are never committed` };
      }
      if (existsSync(a.path)) {
        const st2 = statSync(a.path);
        if (a.size !== undefined && st2.isFile() && st2.size !== a.size) return { ok: false, why: `${a.path} is ${st2.size} bytes, not ${a.size}` };
        if (a.sha256 && st2.isFile()) {
          const sum = await sha256Of(a.path);
          if (sum !== a.sha256) return { ok: false, why: `${a.path}'s sha256 is ${sum.slice(0, 12)}…, not the one reported` };
        }
        return { ok: true, why: "artifact found where reported" };
      }
      return { ok: true, why: "artifact path not readable by Sova: taken as reported" };
    }
    return { ok: true, why: "" };
  }

  /** What a done step sets off: the version known, the release entry, the checks of a tag-only release. */
  private async afterDone(rec: ReleaseRecord, st: ReleaseStep): Promise<void> {
    const q = await this.deps.queue(rec.project);
    if (st.facts?.version && (st.id === "version" || !rec.version)) {
      rec.version = st.facts.version;
      rec.tag = releaseTagOf(rec.settings.tag, rec.version);
      await q.updateReleaseHold(rec.id, { version: rec.version });
    }
    if (st.facts?.artifact && !rec.artifacts.some((a) => a.path === st.facts!.artifact!.path)) rec.artifacts.push(st.facts.artifact);
    if (st.phase === "prepare" && rec.settings.commit && st.id === "commit" && st.facts?.commit) {
      const e = await q.addReleaseEntry({ release: rec.id, branch: st.facts.branch ?? releaseBranchOf(rec.id), commit: st.facts.commit, kind: "release", ...(rec.thread?.session ? { session: rec.thread.session } : {}), ...(rec.thread?.checkout ? { worktree: rec.thread.checkout } : {}) });
      rec.entry = e.id;
      this.toChecking(rec, q);
    } else if (st.phase === "prepare" && !rec.settings.commit && this.prepareDone(rec)) {
      // Tag-only: the gating checks run on the frozen target itself, as a release entry at its tip.
      if (!rec.version) return;
      const branch = releaseBranchOf(rec.id);
      await this.git(["update-ref", `refs/heads/${branch}`, rec.base], rec.project);
      const e = await q.addReleaseEntry({ release: rec.id, branch, commit: rec.base, kind: "release", ...(rec.thread?.session ? { session: rec.thread.session } : {}) });
      rec.entry = e.id;
      this.toChecking(rec, q);
    }
    if (st.phase === "check") this.settle(rec);
  }

  private toChecking(rec: ReleaseRecord, q: ProjectQueue): void {
    rec.state = "checking";
    const c = rec.steps.find((s) => s.id === "checks")!;
    c.state = "running";
    c.by = "sova";
    c.at = this.iso();
    c.summary = "in the merge queue";
    void q.updateReleaseHold(rec.id, { state: "checking" });
  }

  private prepareDone(rec: ReleaseRecord): boolean {
    return rec.steps.filter((s) => s.phase === "prepare").every((s) => s.state === "done" || s.state === "skipped");
  }

  /** The gates of Publish (q12: never past a failed gating check; no overrides). */
  gatesOf(rec: ReleaseRecord): ReleaseGates {
    const why: string[] = [];
    const checks = rec.steps.find((s) => s.id === "checks");
    const checksPassed = checks?.state === "done";
    if (!checksPassed) why.push(checks?.state === "failed" ? "a gating check failed" : "the gating checks haven't passed yet");
    const pending = rec.steps.filter((s) => (s.phase === "prepare" || s.phase === "check") && s.state !== "done" && s.state !== "skipped");
    const stepsDone = !pending.length;
    if (!stepsDone) why.push(`steps not done: ${pending.map((s) => `${s.id} (${s.state})`).join(", ")}`);
    const notes = !!rec.notes?.trim();
    if (!notes) why.push("no release notes yet");
    if (!rec.version || !rec.tag) why.push("no version yet");
    if (!rec.commit) why.push("no release commit on the target yet");
    return { checksPassed, stepsDone, notes, why };
  }

  /** checking → ready once every gate passes (and back while one doesn't). */
  private settle(rec: ReleaseRecord): void {
    if (rec.state !== "checking" && rec.state !== "ready") return;
    const ok = !this.gatesOf(rec).why.length;
    const next = ok ? "ready" : "checking";
    if (next !== rec.state) {
      rec.state = next;
      void this.deps.queue(rec.project).then((q) => q.updateReleaseHold(rec.id, { state: next })).catch(() => {});
      if (ok) this.wake(rec, `Release ${rec.version}: every gate passed; it waits for Publish. Nothing to do until then.`);
    }
  }

  private async notes(root: string, req: Req): Promise<{ changed: boolean; report: ReleaseReport }> {
    const rec = this.mustRecord(root, req.release);
    const text = (req.text ?? "").trim();
    if (!text) throw new ReleaseFailure("invalid-request", "give the notes as text");
    if (rec.state === "publishing") throw new ReleaseFailure("release-refused", "Publish is running");
    rec.notes = text;
    rec.lastReportAt = this.iso();
    this.quietSeen.delete(rec.id);
    this.settle(rec);
    this.save(rec);
    return { changed: true, report: { release: rec } };
  }

  private async continueStep(root: string, req: Req): Promise<{ changed: boolean; report: ReleaseReport }> {
    const rec = this.mustRecord(root, req.release, false);
    const st = rec.steps.find((s) => s.id === req.step);
    if (!st) throw new ReleaseFailure("not-found", `no step ${req.step ?? "(none named)"}`);
    if (st.state !== "held") throw new ReleaseFailure("release-refused", `${st.id} isn't held (${st.state})`);
    st.state = "done";
    st.by = "operator";
    st.at = this.iso();
    this.settle(rec);
    this.save(rec);
    this.wake(rec, `The operator continued ${st.id}: go on with the next step.`);
    return { changed: true, report: { release: rec } };
  }

  private async retry(root: string, req: Req): Promise<{ changed: boolean; report: ReleaseReport }> {
    const rec = this.mustRecord(root, req.release, false);
    const st = rec.steps.find((s) => s.id === req.step);
    if (!st) throw new ReleaseFailure("not-found", `no step ${req.step ?? "(none named)"}`);
    if (st.state !== "failed") throw new ReleaseFailure("release-refused", `${st.id} hasn't failed (${st.state})`);
    if (st.id === "checks") {
      const q = await this.deps.queue(root);
      await q.retryReleaseEntry(rec.id);
      st.state = "running";
      st.by = "operator";
      st.at = this.iso();
      st.summary = "running again in the merge queue";
      delete st.fact;
      rec.state = "checking";
    } else if (st.id === "publish") {
      st.state = "waiting";
      st.by = "operator";
      st.at = this.iso();
      delete st.fact;
    } else {
      // A prepare step after the checks began can't be redone: the release commit is what the checks test.
      if (st.phase === "prepare" && rec.steps.find((s) => s.id === "checks")!.state !== "waiting") throw new ReleaseFailure("release-refused", "the gating checks began: abandon the release to redo a prepare step");
      st.state = "waiting";
      st.by = "operator";
      st.at = this.iso();
      delete st.fact;
      this.wake(rec, `The operator asked to retry ${st.id}: run it again and report it.`);
    }
    this.save(rec);
    return { changed: true, report: { release: rec } };
  }

  // ---- publish, abandon, withdraw ----------------------------------------------------------------

  private async publish(root: string, req: Req, caller: Caller): Promise<{ changed: boolean; report: ReleaseReport }> {
    const rec = this.mustRecord(root, req.release);
    if (rec.state === "publishing") throw new ReleaseFailure("busy", "Publish is already running");
    const gates = this.gatesOf(rec);
    if (gates.why.length) throw new ReleaseFailure("release-refused", `not ready to publish: ${gates.why.join("; ")}`);
    const q = await this.deps.queue(root);
    const head = await q.targetHead();
    if (head !== rec.commit) throw new ReleaseFailure("release-refused", `${q.target} is at ${short(head)}, not the release commit ${short(rec.commit)}`);
    const pub = rec.steps.find((s) => s.id === "publish")!;
    rec.state = "publishing";
    pub.state = "running";
    pub.by = "sova";
    pub.at = this.iso();
    this.save(rec);
    const by = caller.kind === "operator" ? "operator" : "power";
    try {
      const r = await q.publishRelease({ release: rec.id, tag: rec.tag!, channels: rec.channels, commit: rec.commit!, notes: rec.notes ?? rec.tag! });
      rec.state = "published";
      rec.publish = { at: this.iso(), by, pushed: r.pushed, channelsFrom: r.channelsFrom };
      pub.state = "done";
      pub.summary = `${rec.tag} at ${short(rec.commit)}${rec.channels.length ? `, ${rec.channels.join(", ")} moved` : ""}; ${r.pushed === "pushed" ? "pushed with master" : r.pushed === "no-remote" ? "tagged on this machine (no remote)" : `not pushed (${r.why ?? "the project doesn't push"})`}`;
      pub.at = this.iso();
      delete rec.power;
      this.save(rec);
      this.log(`${root}: published ${rec.tag} (${by}, ${r.pushed})`);
      const after = rec.steps.filter((s) => s.phase === "after");
      this.wake(rec, after.length ? `Published ${rec.tag}. Run the after-publish steps now (${after.map((s) => s.id).join(", ")}) and report each.` : `Published ${rec.tag}. Nothing more to do.`);
      return { changed: true, report: { release: rec, view: await this.view(root) } };
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      rec.state = "ready";
      pub.state = "failed";
      pub.summary = `Publish failed: ${why}`.slice(0, STEP_SUMMARY_MAX);
      pub.at = this.iso();
      rec.publish = { at: this.iso(), by, pushed: "not-pushed", channelsFrom: {}, error: why };
      this.save(rec);
      this.changed(root);
      throw new ReleaseFailure(err instanceof MergeFailure && err.code !== "busy" ? err.code : "release-refused", `Publish failed, nothing changed: ${why}`);
    }
  }

  private async abandon(root: string, req: Req): Promise<{ changed: boolean; report: ReleaseReport }> {
    const rec = this.mustRecord(root, req.release);
    if (rec.state === "publishing") throw new ReleaseFailure("busy", "Publish is running");
    const why = (req.why ?? "").trim() || "abandoned by the operator";
    const q = await this.deps.queue(root);
    const r = await q.abandonRelease({ release: rec.id, why });
    rec.state = "abandoned";
    rec.abandoned = { at: this.iso(), why, revert: r.revert };
    delete rec.power;
    for (const s of rec.steps) if (s.state === "running" || s.state === "held") s.state = "skipped";
    this.save(rec);
    this.wake(rec, `The operator abandoned release ${rec.version ?? rec.id}: ${why}. Stop; do nothing more for it.`);
    this.log(`${root}: abandoned ${rec.id}${r.revert ? ` (revert ${r.revert})` : ""}`);
    return { changed: true, report: { release: rec, view: await this.view(root) } };
  }

  private async withdraw(root: string, req: Req): Promise<{ changed: boolean; report: ReleaseReport }> {
    const why = (req.why ?? "").trim();
    if (!why) throw new ReleaseFailure("invalid-request", "say why (it is added to the release's notes)");
    const s = await this.settingsAt(root);
    const settings = s.settings;
    if (!settings) throw new ReleaseFailure("release-refused", NOT_INITIALIZED);
    const rec = req.release ? this.mustRecord(root, req.release, false) : req.tag ? (this.records(root).find((r) => r.tag === req.tag) ?? null) : null;
    const tag = rec?.tag ?? req.tag;
    if (!tag) throw new ReleaseFailure("invalid-request", "name the release (release or tag)");
    if (rec && rec.state !== "published") throw new ReleaseFailure("release-refused", `release ${rec.tag ?? rec.id} is ${rec.state}: only a published release is withdrawn`);
    const history = await this.history(root, settings);
    const item = history.find((h) => h.tag === tag);
    if (!item) throw new ReleaseFailure("not-found", `no numbered release ${tag}`);
    if (item.withdrawn) throw new ReleaseFailure("release-refused", `${tag} is withdrawn already`);
    // Each channel at it goes back to the newest older release that isn't withdrawn (none: the channel is removed).
    const older = history.filter((h) => h.tag !== tag && !h.withdrawn && this.olderThan(h, item, settings));
    const back = older[0] ?? null;
    const channels: Record<string, string | null> = {};
    for (const ch of new Set([...settings.channels, ...(rec?.channels ?? [])])) {
      const at = await revParse(this.git, root, `refs/tags/${ch}`);
      if (at === item.sha) channels[ch] = back?.sha ?? null;
    }
    const q = await this.deps.queue(root);
    const r = await q.withdrawRelease({ tag, sha: item.sha, channels, why });
    const at = this.iso();
    if (rec) {
      rec.state = "withdrawn";
      rec.withdrawn = { at, why, channelsTo: channels };
      rec.notes = `${rec.notes ?? ""}\n\nWithdrawn ${at.slice(0, 10)}: ${why}`.trim();
      this.save(rec);
      const steps = rec.steps.filter((x) => x.phase === "withdraw");
      if (steps.length) {
        const woke = rec.thread?.path ? await this.deps.thread.wake(rec.thread.path, `Release ${tag} was withdrawn: ${why}. Run the withdraw steps now (${steps.map((x) => x.id).join(", ")}) and report each.`).catch(() => ({ ok: false as const, error: "wake failed" })) : { ok: false as const, error: "no chat" };
        if (!woke.ok && rec.thread?.checkout && existsSync(rec.thread.checkout)) {
          const st = await this.deps.thread.start({ root, checkout: rec.thread.checkout, text: `Release ${rec.id} (${tag}) of ${root} was withdrawn: ${why}. Run its withdraw steps (${steps.map((x) => x.id).join(", ")}) following the project's release playbook, and report each with release.step {release: "${rec.id}", …}.`, title: `Withdraw ${tag}` });
          if (!("error" in st)) {
            rec.thread = { ...rec.thread, session: st.id, path: st.path };
            this.save(rec);
          }
        }
      }
    }
    this.writeWithdrawn(root, tag, { at, why, ...(rec ? { record: rec.id } : {}) });
    this.log(`${root}: withdrew ${tag} (${r.pushed})`);
    return { changed: true, report: { ...(rec ? { release: rec } : {}), view: await this.view(root) } };
  }

  private withdrawnFile(root: string): string {
    return join(this.projectDir(root), "withdrawn.json");
  }
  /** The withdrawn releases Sova knows of here (the marker tag `withdrawn/<tag>` says so to other copies). */
  withdrawnOf(root: string): Record<string, { at: string; why: string; record?: string }> {
    return readJson(this.withdrawnFile(root)) ?? {};
  }
  private writeWithdrawn(root: string, tag: string, w: { at: string; why: string; record?: string }): void {
    const all = this.withdrawnOf(root);
    all[tag] = w;
    writeAtomic(this.withdrawnFile(root), all);
  }

  private olderThan(a: ReleaseHistoryItem, b: ReleaseHistoryItem, settings: ReleaseDecl): boolean {
    if (settings.scheme === "semver") {
      const c = semverCompare(a.version, b.version);
      if (c !== 0) return c < 0;
    }
    return a.date < b.date;
  }

  /** The release power's publish is held (its waiting period, Cancel in Needs you): kept on the record. */
  notePowerHold(root: string, id: string, h: { heldUntil: string; act: string }): void {
    void this.serial(root, async () => {
      const rec = this.record(root, id);
      if (!rec || !isReleaseOpen(rec.state)) return;
      rec.power = h;
      this.save(rec);
      this.changed(root);
    });
  }

  // ---- request ------------------------------------------------------------------------------------

  private async request(root: string, req: Req, caller: Caller): Promise<{ changed: boolean; report: ReleaseReport }> {
    const all = this.requests();
    if (caller.kind === "operator" && req.dismiss) {
      const left = all.filter((q) => q.project !== root);
      if (left.length === all.length) return { changed: false, report: { view: await this.view(root) } };
      writeAtomic(this.requestsFile(), left);
      return { changed: true, report: { view: await this.view(root) } };
    }
    const why = (req.why ?? "").trim();
    if (!why) throw new ReleaseFailure("invalid-request", "say why (one line the operator reads)");
    const s = await this.settingsAt(root);
    if (!s.settings) throw new ReleaseFailure("release-refused", NOT_INITIALIZED);
    const q: ReleaseRequestRecord = { id: `rq_${randomBytes(6).toString("hex")}`, project: root, why: why.slice(0, 300), by: callerTag(caller), at: this.iso() };
    writeAtomic(this.requestsFile(), [...all.filter((x) => x.project !== root), q]);
    return { changed: true, report: { view: await this.view(root) } };
  }

  // ---- the queue's word ----------------------------------------------------------------------------

  /** A release entry moved in the queue (queue.ts releaseEvent). Never throws. */
  onQueueEvent(ev: ReleaseQueueEvent, root: string): void {
    void this.serial(root, async () => {
      const rec = this.record(root, ev.release);
      if (!rec) return;
      if (ev.kind === "revert") {
        if (ev.what === "landed" && rec.abandoned) {
          rec.abandoned = { ...rec.abandoned, why: rec.abandoned.why };
          this.save(rec);
        }
        return;
      }
      if (!isReleaseOpen(rec.state) || rec.state === "publishing") return;
      const c = rec.steps.find((s) => s.id === "checks")!;
      c.by = "sova";
      c.at = this.iso();
      if (ev.run) c.run = ev.run;
      if (ev.what === "checking") {
        c.state = "running";
        c.summary = "the gating checks are running";
        rec.state = "checking";
      } else if (ev.what === "landed") {
        c.state = "done";
        c.summary = `passed; ${short(ev.entry.landed?.sha)} is on ${ev.entry.target} (not pushed until Publish)`;
        rec.commit = ev.entry.landed?.sha ?? ev.entry.commit;
        rec.state = "checking";
        this.settle(rec);
        const checkSteps = rec.steps.filter((s) => s.phase === "check");
        if ((rec.state as string) !== "ready") this.wake(rec, checkSteps.length ? `The gating checks passed and ${short(rec.commit)} is on ${ev.entry.target}. Run the check steps now (${checkSteps.map((s) => s.id).join(", ")}).` : `The gating checks passed. What is left before Publish: ${this.gatesOf(rec).why.join("; ")}.`);
      } else if (ev.what === "failed" || ev.what === "waiting") {
        c.state = "failed";
        c.summary = `${ev.what === "waiting" ? "can't tell whose failure" : "failed"}: ${ev.why ?? "a gating check"}`.slice(0, STEP_SUMMARY_MAX);
        rec.state = "checking";
        this.wake(rec, `The gating checks failed: ${ev.why ?? "see the run"}. Say what failed in your report; the operator may Retry Step or abandon.`);
      } else if (ev.what === "cancelled") {
        if (c.state !== "done") {
          c.state = "failed";
          c.summary = "its queue entry was cancelled";
        }
      }
      this.save(rec);
      this.changed(root);
    }).catch((err) => this.log(`queue event failed: ${err instanceof Error ? err.message : err}`));
  }

  // ---- reading --------------------------------------------------------------------------------------

  /** The project's numbered releases, newest first, from its tags (and Sova's records and withdrawn markers). */
  async history(root: string, settings: ReleaseDecl): Promise<ReleaseHistoryItem[]> {
    const r = await this.git(["for-each-ref", "--format=%(refname:strip=2)%00%(objectname)%00%(*objectname)%00%(creatordate:iso-strict)%00%(contents)%00%00", "refs/tags/"], root);
    if (r.code !== 0) return [];
    const tags = new Map<string, { sha: string; date: string; body: string }>();
    for (const chunk of r.stdout.split("\0\0\n")) {
      const [name, obj, peeled, date, body] = chunk.replace(/^\n/, "").split("\0");
      if (!name || !obj) continue;
      tags.set(name, { sha: peeled || obj, date: date ?? "", body: (body ?? "").trim() });
    }
    const records = this.records(root);
    const known = this.withdrawnOf(root);
    const channels = settings.channels;
    const out: ReleaseHistoryItem[] = [];
    for (const [name, t] of tags) {
      if (name.startsWith("withdrawn/") || channels.includes(name)) continue;
      const version = versionOfTag(settings.tag, name);
      if (!version || (settings.scheme !== "none" && versionProblem(settings.scheme, version))) continue;
      const marker = tags.get(`withdrawn/${name}`);
      const w = known[name] ?? (marker ? { at: marker.date, why: marker.body.split("\n")[0] ?? "" } : null);
      const rec = records.find((x) => x.tag === name && x.state !== "abandoned");
      let notes: string | null = null;
      const log = await this.git(["show", `${t.sha}:CHANGELOG.md`], root);
      if (log.code === 0) notes = changelogSection(log.stdout, name) ?? changelogSection(log.stdout, version);
      if (!notes) notes = t.body.replace(/-----BEGIN PGP SIGNATURE-----[\s\S]*$/, "").trim() || null;
      out.push({
        tag: name,
        version,
        sha: t.sha,
        date: t.date,
        notes,
        channels: channels.filter((c) => tags.get(c)?.sha === t.sha),
        ...(w ? { withdrawn: { at: w.at, why: w.why } } : {}),
        ...(rec ? { record: rec.id } : {}),
        deployedTo: this.deps.deployedTo?.(root, t.sha) ?? [],
      });
    }
    return out.sort((a, b) => (settings.scheme === "semver" ? semverCompare(b.version, a.version) || b.date.localeCompare(a.date) : b.date.localeCompare(a.date)));
  }

  async view(root: string): Promise<ReleaseView> {
    const s = await this.settingsAt(root);
    const q = await this.deps.queue(root);
    const open = this.openRecord(root);
    const last = this.lastRecord(root);
    const history = s.settings ? await this.history(root, s.settings) : [];
    const latest = history.find((h) => !h.withdrawn)?.tag ?? null;
    const latestSha = latest ? history.find((h) => h.tag === latest)!.sha : null;
    const count = latestSha && s.head ? await this.git(["rev-list", "--count", `${latestSha}..${s.head}`], root) : null;
    const pushes = s.def?.merge?.push !== false && (await this.git(["remote"], root)).stdout.split("\n").includes("origin");
    return {
      project: root,
      initialized: !!s.settings,
      settings: s.settings,
      ...(s.problem ? { problem: s.problem } : {}),
      open,
      last,
      deployTargets: (s.def?.deploy?.targets ?? []).map((t) => t.name),
      history,
      latest,
      landingsSince: count && count.code === 0 ? Number(count.stdout.trim()) || 0 : null,
      target: q.target,
      remote: pushes,
      gates: open ? this.gatesOf(open) : null,
      quiet: open ? this.quietOf(open) : null,
    };
  }

  private quietMs(rec: ReleaseRecord): number {
    const env = Number(process.env.SOVA_RELEASE_QUIET_MS);
    if (Number.isFinite(env) && env > 0) return env;
    return this.deps.quietMs?.(rec.settings) ?? rec.settings.quietMin * 60_000;
  }

  /** The release chat has been quiet past quietMin while the queue is frozen (t23). Held and ready releases wait on the
   *  operator, not the chat: never quiet. */
  quietOf(rec: ReleaseRecord): { minutes: number } | null {
    if (rec.state !== "preparing" && rec.state !== "checking") return null;
    if (rec.steps.some((s) => s.state === "held") || rec.steps.find((s) => s.id === "checks")?.state === "running") return null;
    const since = Date.parse(rec.lastReportAt ?? rec.startedAt) || 0;
    const ms = this.now() - since;
    return ms > this.quietMs(rec) ? { minutes: Math.floor(ms / 60_000) } : null;
  }

  private async logs(root: string, req: Req): Promise<string[]> {
    const rec = req.release ? this.mustRecord(root, req.release, false) : (this.openRecord(root) ?? this.lastRecord(root));
    if (!rec) throw new ReleaseFailure("not-found", "this project has no release yet");
    const n = req.lines ?? 200;
    const st = req.step ? rec.steps.find((s) => s.id === req.step) : null;
    if (req.step && !st) throw new ReleaseFailure("not-found", `no step ${req.step}`);
    if (st && st.id !== "checks") return (st.detail ?? st.summary ?? "").split("\n").slice(-n);
    if (st?.id === "checks" || !st) {
      const run = rec.steps.find((s) => s.id === "checks")?.run;
      if (st && !run) return ["the gating checks haven't run yet"];
      if (run) {
        const q = await this.deps.queue(root);
        const r: MergeRun | null = q.store.readRun(run);
        if (r) return r.steps.map((x) => `${x.label}: ${x.result}${x.detail ? ` (${x.detail})` : ""}`).slice(-n);
      }
    }
    return rec.steps.map((s) => `${s.id}: ${s.state}${s.summary ? ` · ${s.summary}` : ""}${s.fact && !s.fact.ok ? ` · fact: ${s.fact.why}` : ""}`).slice(-n);
  }

  // ---- telling ---------------------------------------------------------------------------------------

  private wake(rec: ReleaseRecord, text: string): void {
    const path = rec.thread?.path;
    if (!path) return;
    void this.deps.thread.wake(path, text).then(
      (r) => (r.ok ? undefined : this.log(`wake of ${rec.id}'s chat failed: ${r.error}`)),
      (err) => this.log(`wake of ${rec.id}'s chat failed: ${err instanceof Error ? err.message : err}`),
    );
  }

  private changed(root: string): void {
    this.deps.attention?.();
    if (!this.deps.publish) return;
    void this.view(root)
      .then((v) => this.deps.publish?.(v))
      .catch((err) => this.log(`view failed: ${err instanceof Error ? err.message : err}`));
  }

  /** The stall watch (t23): a release that went quiet changes Needs you once. */
  startWatch(): void {
    if (this.timer) return;
    const ms = Number(process.env.SOVA_RELEASE_STALL_POLL_MS) || 60_000;
    this.timer = setInterval(() => this.checkQuiet(), ms);
    this.timer.unref?.();
  }
  stopWatch(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
  checkQuiet(): void {
    for (const root of this.roots()) {
      const rec = this.openRecord(root);
      if (!rec) continue;
      const quiet = !!this.quietOf(rec);
      if (quiet && !this.quietSeen.has(rec.id)) {
        this.quietSeen.add(rec.id);
        this.changed(root);
      } else if (!quiet && this.quietSeen.delete(rec.id)) this.changed(root);
    }
  }

  /** What needs the operator about releases (CONTRACT §8), per project root. */
  attentionFacts(): ReleaseAttention[] {
    const out: ReleaseAttention[] = [];
    for (const root of this.roots()) {
      const rec = this.openRecord(root);
      if (rec) {
        const name = rec.version ?? rec.id;
        const since = (iso: string | null | undefined) => Date.parse(iso ?? rec.startedAt) || 0;
        const powerHeld = !!rec.power && Date.parse(rec.power.heldUntil) > this.now();
        if (rec.state === "ready" && !powerHeld) out.push({ root, release: rec.id, kind: "release-ready", since: since(rec.steps.find((s) => s.id === "checks")?.at), detail: `Ready to publish · ${rec.tag ?? name}` });
        for (const s of rec.steps) if (s.state === "held") out.push({ root, release: rec.id, kind: "release-held", since: since(s.at), detail: `${name}: ${s.label} is held for you${s.summary ? `: ${s.summary}` : ""}` });
        for (const s of rec.steps) if (s.state === "failed") out.push({ root, release: rec.id, kind: "release-failed", since: since(s.at), detail: `${name}: ${s.label} failed${s.summary ? `: ${s.summary}` : ""}` });
        const quiet = this.quietOf(rec);
        if (quiet) out.push({ root, release: rec.id, kind: "release-quiet", since: since(rec.lastReportAt), detail: `No word from the release chat for ${quiet.minutes} min`, ...(rec.thread?.path ? { path: rec.thread.path } : {}) });
      }
      const last = this.lastRecord(root);
      if (last && (last.state === "published" || last.state === "withdrawn")) for (const s of last.steps) if (s.state === "failed" && (s.phase === "after" || s.phase === "withdraw")) out.push({ root, release: last.id, kind: "release-failed", since: Date.parse(s.at ?? "") || 0, detail: `${last.tag ?? last.id}: ${s.label} failed${s.summary ? `: ${s.summary}` : ""}` });
    }
    for (const q of this.requests()) out.push({ root: q.project, release: q.id, kind: "release-request", since: Date.parse(q.at) || 0, detail: `${q.by.startsWith("assistant") ? "The Project Assistant" : "The overseer"} asks you to release: ${q.why}` });
    return out;
  }
}

export interface ReleaseAttention {
  root: string;
  release: string;
  kind: "release-ready" | "release-request" | "release-quiet" | "release-held" | "release-failed";
  since: number;
  detail: string;
  /** The release chat's session file (Open Chat). */
  path?: string;
}

/** Semantic versions compared (pre-releases before their release); 0 when either isn't one. */
export function semverCompare(a: string, b: string): number {
  const m = (v: string) => /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v);
  const x = m(a);
  const y = m(b);
  if (!x || !y) return 0;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) - Number(y[i]);
  if (x[4] && !y[4]) return -1;
  if (!x[4] && y[4]) return 1;
  return (x[4] ?? "").localeCompare(y[4] ?? "");
}

function sha256Of(file: string): Promise<string> {
  return new Promise((done, fail) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("data", (d) => h.update(d))
      .on("end", () => done(h.digest("hex")))
      .on("error", fail);
  });
}

