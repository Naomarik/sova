// The merge queue's screens in a real Chrome, at 1280px and 390px: the composer's worktrees control
// and its modal, the session pane's Worktrees rows, a project's Merge Queue tab, one run's page and the
// onboarding of a project not set up. The app's own build, served from a scratch build with every
// request answered here (no server, no network); each action's verb call is recorded and checked.
// A guard: none of these screens says Restart, live or not live.
// Chrome or Chromium must be installed (as the tour tests: nothing is downloaded).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import type { MergeCard, MergeEntry, MergeQueueView, MergeRun, WorktreeMergeProject, WorktreeQueueInfo } from "../shared/merge-queue";
import type { SessionSummary, SessionWorktreeInfo } from "../shared/protocol";
import type { ProjectSummary } from "../shared/projects";
import type { SetupProposal, SetupStatus } from "../shared/setup-chat";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";
import { formatHeldNote } from "../shared/topic-message";

const ROOT = join(import.meta.dirname, "..");
const ORIGIN = "http://sova.test";
let dist = "";
let browser: Browser;

before(async () => {
  // SOVA_MQ_UI_DIST=<dir>: drive a build made elsewhere (by hand, to show a tree without the change fails).
  dist = process.env.SOVA_MQ_UI_DIST || join(scratchRoot("sova-mq-ui-"), "dist");
  if (!process.env.SOVA_MQ_UI_DIST) {
    const r = spawnSync(process.execPath.includes("bun") ? "node" : process.execPath, [join(ROOT, "node_modules/vite/bin/vite.js"), "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: ROOT, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  }
  browser = await launchTourBrowser();
});
after(async () => {
  await browser?.close();
});

const T0 = Date.now();
const iso = (minAgo: number) => new Date(T0 - minAgo * 60_000).toISOString();
const sha = (c: string) => c.repeat(40);
const PID = "prj_sova0001";
const ROOT_DIR = "/w/sova";
const SETUP_BRANCH = "sova/setup-sova-1a2b3c";
const SETUP_HEAD = "5e7c0de".padEnd(40, "0");
const NO_SETUP: SetupStatus = { chat: null, setUp: { merge: false, release: false, deploy: false }, can: { open: true }, history: [] };
/** The Setup chat proposes on its branch; `trial`: the trial of its head, or none yet. */
function setupProposed(trial: "passed" | null): SetupStatus {
  const t = trial ? { id: "mr_trial1", commit: SETUP_HEAD, at: "2026-11-05T05:00:00.000Z", pass: true, state: "passed" as const, checks: [{ name: "Tests", kind: "merge" as const, state: "passed" as const, durationMs: 1200, run: "mr_trial1", step: "check:tests" }] } : null;
  const proposal = { branch: SETUP_BRANCH, target: "master", commit: SETUP_HEAD, served: false, hash: "sha256:setup", services: [], files: [{ path: ".sova/project.json", status: "M", setup: true }, { path: "docs/x.md", status: "A", setup: false }], merge: { checks: [{ id: "tests", label: "Tests", run: ["sh", "test/run.sh"], timeoutSec: 60, optional: false, requires: [] }], target: "master", push: false, land: "local" }, trial: t, land: trial ? { can: true } : { can: false, why: "This setup branch has no passing trial at 5e7c0de: run a trial of it first." } } as unknown as SetupProposal;
  return { chat: { sessionId: "s-setup", title: "Setup · sova", state: "proposed", startedAt: "2026-11-05T04:50:00.000Z", branch: SETUP_BRANCH, proposal, setUp: { merge: false, release: false, deploy: false } }, setUp: { merge: false, release: false, deploy: false }, can: { open: true }, history: [] };
}
const PATH = "/w/sessions/s1.jsonl";
const NOTE = "Changes server code; restart Sova to pick it up.";

const SESSION = {
  id: "s1",
  path: PATH,
  cwd: ROOT_DIR,
  title: "Composer drafts survive reload",
  createdAt: iso(120),
  lastActiveAt: iso(9),
  model: "mock/m1",
  context: { tokens: 1, window: 100_000 },
  live: null,
  origin: "web",
  archived: false,
  busy: false,
} as unknown as SessionSummary;

const PROJECT: ProjectSummary = { id: PID, name: "sova", root: ROOT_DIR, origin: "folder", createdAt: iso(10_000), space: { kind: "standalone" } };

const mergeProject: WorktreeMergeProject = { id: PID, root: ROOT_DIR, target: "master", checks: "declared", review: true };
const qi = (x: Partial<WorktreeQueueInfo>): WorktreeQueueInfo => ({ id: "me_x", state: "queued", commit: sha("c"), notes: [], project: PID, ...x }) as WorktreeQueueInfo;
/** A row as the server sends it: `mergeServed` only where its project's merge setup is done (or is broken, still a
 *  setup); a row may say otherwise. */
const setUpProject = (p: WorktreeMergeProject | undefined): boolean => !!p && (p.checks !== "unset" || !!p.invalid);
const wt = (branch: string, x: Partial<SessionWorktreeInfo> = {}): SessionWorktreeInfo => ({
  ...(setUpProject("mergeProject" in x ? x.mergeProject : mergeProject) ? { mergeServed: true as const } : {}),
  path: `/w/.worktrees/sova-${branch.split("/")[1]}`,
  branch,
  status: "active",
  how: "created",
  exists: true,
  hasAgentDir: false,
  runningWorkers: 0,
  readiness: { path: "", branch, state: "ready", landing: { state: "ready", commit: sha("d") } },
  mergeProject,
  // The numbers and the head they were read at (the commit a Land pins).
  mergeStats: { ahead: 3, added: 40, removed: 2, head: sha("d") } as SessionWorktreeInfo["mergeStats"],
  ...x,
});

/** A decision only the user can make (§chat.merge-queue/decision): its question, choices that fill the message box,
 *  and the queue's note held until the user's answer goes with it. */
const DECISION = {
  id: "dc_1",
  kind: "needs-you" as const,
  question: "Keep the Save button at the top, or move it under the form?",
  choices: ["Keep it at the top", "Move it under the form"],
  heldNote: { request: "rq_0123456789ab", text: "Place the Save button where the user says, then answer Fixed." },
  raisedBy: "merge-thread" as const,
  actions: [],
  at: iso(2),
};
/** Every state a row can be in. */
const ALL_ROWS = [
  wt("feat/composer-drafts", {
    // When the branch last changed: drawn after its size.
    mergeStats: { ahead: 3, added: 40, removed: 2, head: sha("d"), headAt: iso(3 * 60) } as SessionWorktreeInfo["mergeStats"],
    mergeOwner: { session: "s1", path: PATH, title: "Composer drafts survive reload" },
    mergeSummary: { commit: sha("d"), state: "ready", bullets: ["Keeps a draft through a reload", "Restores the cursor where it was"] },
  }),
  wt("feat/composer-shortcuts"),
  wt("fix/paste-images", { queue: qi({ id: "me_q", state: "queued", position: 2, eta: { startsInMs: 4 * 60_000, takesMs: 9 * 60_000 }, newerCommits: 1 }) }),
  wt("feat/draft-sync-tabs", { readiness: { path: "", branch: "feat/draft-sync-tabs", state: "in-progress", dirtyCount: 3 } }),
  // Sent back at its commit (c), and still reading at that commit: no Land until a newer commit reads finished (al_4).
  wt("fix/draft-autosave-race", {
    queue: qi({ id: "me_f", state: "needs-fix", reason: "unit failed: src/lib/drafts.test.ts", run: "mr_fail" }),
    readiness: { path: "", branch: "fix/draft-autosave-race", state: "ready", landing: { state: "ready", commit: sha("c") } },
    mergeStats: { ahead: 3, added: 40, removed: 2, head: sha("c") } as SessionWorktreeInfo["mergeStats"],
  }),
  wt("fix/conflict-chip", {
    queue: qi({ id: "me_b", state: "behaviour-differs", conflict: { files: ["src/a.ts"], verdict: "behaviour-differs", ours: "Master retries the save twice.", theirs: "The branch never retries.", proposal: "Keep master's retry.", at: iso(3) } }),
  }),
  wt("feat/hack", { queue: qi({ id: "me_r", state: "needs-user", decision: DECISION } as Partial<WorktreeQueueInfo>) }),
  wt("feat/composer-hints", { queue: qi({ id: "me_l", state: "landed", landed: { sha: sha("b"), from: sha("a"), at: iso(30), pushed: "pushed" }, notes: [{ kind: "thread", text: NOTE, at: iso(29) }] }) }),
];
const READY_ROWS = [ALL_ROWS[0]!, ALL_ROWS[1]!, ALL_ROWS[2]!, ALL_ROWS[7]!];

const entry = (x: Partial<MergeEntry>): MergeEntry => ({
  id: "me_x",
  project: PID,
  target: "master",
  branch: "feat/x",
  session: PATH,
  commit: sha("c"),
  approval: { by: "land-button", at: iso(12), commit: sha("c") },
  state: "queued",
  runs: [],
  picks: [],
  notes: [],
  createdAt: iso(12),
  updatedAt: iso(5),
  ...x,
});

const RUN: MergeRun = {
  id: "mr_now",
  entry: "me_c",
  project: PID,
  branch: "fix/worker-restore",
  base: sha("1"),
  commit: sha("2"),
  tip: sha("3"),
  checks: [{ id: "statecharts", label: "Statecharts", source: "picked", why: "statecharts/** changed" }],
  steps: [
    { id: "copy", kind: "copy", label: "Merge copy", result: "passed", ms: 4000, log: "copy.log" },
    { id: "setup", kind: "setup", label: "Setup", result: "passed", ms: 21_000, log: "setup.log" },
    { id: "merge", kind: "merge", label: "Merge onto master", result: "passed", ms: 1000, log: "merge.log" },
    { id: "check:typecheck", kind: "check", label: "Typecheck", result: "passed", ms: 48_000, source: "required", log: "t.log", counts: null },
    { id: "check:unit", kind: "check", label: "Unit tests", result: "running", ms: 60_000, source: "required", log: "u.log" },
    { id: "check:statecharts", kind: "check", label: "Statecharts", result: "pending", ms: 0, source: "picked", why: "The branch changes statecharts/merge.ts.", log: "s.log" },
    { id: "check:integration", kind: "check", label: "Integration", result: "pending", ms: 0, source: "trigger", why: "server/** changed", log: "i.log" },
    { id: "check:spec-replay", kind: "check", label: "Spec replay", result: "skipped", ms: 0, source: "trigger", detail: "skipped: no change to its paths", log: "r.log" },
  ],
  verdict: "running",
  startedAt: iso(3),
};
const FAILED: MergeRun = {
  ...RUN,
  id: "mr_fail",
  entry: "me_f",
  branch: "fix/draft-autosave-race",
  verdict: "failed",
  blame: "branch",
  why: "“saves a draft once” fails with this branch and passes on master.",
  endedAt: iso(1),
  steps: [
    { id: "copy", kind: "copy", label: "Merge copy", result: "passed", ms: 4000, log: "copy.log" },
    { id: "check:unit", kind: "check", label: "Unit tests", result: "failed", ms: 70_000, source: "required", log: "u.log", failures: [{ file: "src/lib/drafts.test.ts", name: "saves a draft once", message: "expected 1, got 2" }] },
    { id: "rerun-tip:unit", kind: "rerun-tip", label: "Unit tests again", result: "failed", ms: 9000, log: "rt.log" },
    { id: "rerun-master:unit", kind: "rerun-master", label: "Unit tests on master alone", result: "passed", ms: 9000, log: "rm.log" },
  ],
};

function viewOf(x: Partial<MergeQueueView> = {}): MergeQueueView {
  return {
    project: PID,
    root: ROOT_DIR,
    target: "master",
    batch: 1,
    state: "running",
    checks: "declared",
    review: true,
    served: true,
    current: RUN,
    checking: [entry({ id: "me_c", branch: "fix/worker-restore", state: "checking" })],
    waiting: [
      entry({ id: "me_w1", branch: "feat/pending-chip", state: "queued", position: 1, eta: { startsInMs: 6 * 60_000, takesMs: 9 * 60_000 } }),
      entry({ id: "me_w2", branch: "feat/replay-timeouts", state: "queued", position: 2, eta: { startsInMs: 15 * 60_000, takesMs: 22 * 60_000 }, newerCommits: 2, approval: { by: "typed", at: iso(8), commit: sha("c") } }),
    ],
    needsYou: [
      entry({ id: "me_b", branch: "fix/conflict-chip", state: "behaviour-differs", conflict: { files: ["src/a.ts"], verdict: "behaviour-differs", ours: "Master retries the save twice.", theirs: "The branch never retries.", proposal: "Keep master's retry.", at: iso(3) } }),
      entry({ id: "me_r", branch: "feat/hack", state: "needs-user", decision: DECISION }),
    ],
    needsFix: [entry({ id: "me_f", branch: "fix/draft-autosave-race", state: "needs-fix", reason: "unit failed: src/lib/drafts.test.ts", run: "mr_fail" })],
    recent: [
      {
        entry: entry({ id: "me_l", branch: "feat/composer-hints", state: "landed", landed: { sha: sha("b"), from: sha("a"), at: iso(30), pushed: "pushed" }, notes: [{ kind: "thread", text: NOTE, at: iso(29) }] }),
        run: { id: "mr_old", verdict: "passed", startedAt: iso(40), endedAt: iso(30) },
      },
    ],
    heads: { target: sha("1"), pushed: sha("1") },
    ready: [{ branch: "feat/ready-one", worktree: "/w/.worktrees/sova-ready-one", commit: sha("9"), ahead: 3 }],
    thread: { session: "/w/sessions/thread.jsonl", startedAt: iso(60), state: "idle" },
    at: iso(0),
    ...x,
  };
}

/** A coding session of the project, in its own worktree, and its branch facts. */
const CODING = { ...SESSION, id: "c1", path: "/w/sessions/c1.jsonl", title: "Fix the cart", project: { kind: "coding", projectId: PID, operator: true } } as unknown as SessionSummary;
const CODING_B = { ...SESSION, id: "c2", path: "/w/sessions/c2.jsonl", title: "Fix the badge", project: { kind: "coding", projectId: PID, operator: true } } as unknown as SessionSummary;
const tree = (s: SessionSummary, branch: string) => ({
  sessionId: s.id,
  path: s.path,
  title: s.title,
  startedBy: "operator",
  branch,
  base: sha("1"),
  target: "master",
  running: false,
  workers: 0,
  createdAt: iso(50),
  worktree: `/w/.worktrees/sova-${branch.split("/")[1]}`,
  head: sha("8"),
  state: "open",
  merged: false,
  ahead: 2,
  dirty: false,
});
const WORKTREES = { available: true, sessions: [tree(CODING, "sova/fix-cart"), tree(CODING_B, "sova/fix-badge")] };
/** A proposed playbook run, its branch's hash valid: Merge Branch, or Land once the queue is set up. */
const RUNTIME = {
  projectId: PID,
  standing: "registered",
  playbookState: "proposed",
  def: null,
  commit: null,
  suite: null,
  services: [],
  orphans: [],
  data: [],
  sources: [],
  drift: null,
  proof: null,
  registered: null,
  playbook: { label: "Project verbs playbook", branch: "sova/project-verbs", target: "master", branchHash: `sha256:${"f".repeat(64)}`, commit: sha("7"), proposes: "definition" },
  can: { onboard: false },
  feed: [],
};

const CONTENT: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

interface Opened {
  page: Page;
  ctx: BrowserContext;
  /** Each verb call: its name and body. */
  calls: { verb: string; body: Record<string, unknown> }[];
  /** From now on the server answers the worktree rows through `f`. */
  move(f: (rows: SessionWorktreeInfo[]) => SessionWorktreeInfo[]): void;
  /** Every frame the page sent on the chat's socket: a prompt or steer here would be a post into the chat. */
  frames: string[];
  /** Each diff read's query (GET /api/diff/summary|patch), in order. */
  diffs: { kind: "summary" | "patch"; query: URLSearchParams }[];
}

/** Sova at `width` on `hash`, every request answered: the session, its worktrees, the project, its queue. */
async function open(width: number, hash: string, o: { rows?: SessionWorktreeInfo[]; view?: MergeQueueView; cards?: MergeCard[]; items?: unknown[]; sessions?: SessionSummary[]; setup?: () => SetupStatus } = {}): Promise<Opened> {
  const phone = width < 768;
  // Reduced motion: a screenshot shows each screen's end state, never a fade half-way.
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: phone, isMobile: phone, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const calls: Opened["calls"] = [];
  /** merge.setup dry runs: each starts a run; the view's tryRun ends it, failing the first time, passing after. */
  let tries = 0;
  /** Set by a test: what the server answers from now on (a branch that moved after the page read it). */
  let moved: ((rows: SessionWorktreeInfo[]) => SessionWorktreeInfo[]) | undefined;
  let tryRun: MergeRun | undefined;
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  const ok = (verb: string, merge: unknown) => ({ v: 1, verb, project: ROOT_DIR, instance: null, slot: null, generation: null, checkout: null, branch: null, ok: true, changed: true, state: "stopped", steps: [], services: [], data: [], links: [], defHash: null, merge });
  const frames: string[] = [];
  const diffs: Opened["diffs"] = [];
  const items = o.items ?? [{ id: "u1", kind: "user", text: "Make drafts survive a reload.", at: iso(20) }];
  await page.routeWebSocket(/.*/, (ws) => {
    if (!new URL(ws.url()).pathname.startsWith("/ws/chat")) return;
    ws.onMessage((m) => frames.push(String(m)));
    ws.send(JSON.stringify({ type: "hello", items, isStreaming: false, model: "mock/m1", thinking: "off", context: null }));
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    const verb = /^\/api\/project-services\/(merge\.[a-z-]+)$/.exec(p)?.[1];
    if (verb) {
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      calls.push({ verb, body });
      if (verb === "merge.status") return route.fulfill(json(ok(verb, { view: { ...(o.view ?? viewOf()), ...(tryRun ? { tryRun } : {}) } })));
      if (verb === "merge.setup" && body.dryRun) {
        tries++;
        const run = { ...RUN, id: `mr_try${tries}`, verdict: "running" as const };
        tryRun =
          tries === 1
            ? { ...run, verdict: "failed", why: "install stopped: no lockfile found: it fails on master itself, so it is the project's setup to fix, not any branch's" }
            : { ...run, verdict: "passed", why: "the checks pass on master" };
        return route.fulfill(json(ok(verb, { run })));
      }
      if (verb === "merge.try") return route.fulfill(json(ok(verb, { trial: { run: "mr_trial1", commit: body.commit, verdict: "running" }, run: { ...RUN, id: "mr_trial1", verdict: "running" } })));
      if (verb === "merge.logs") {
        const run = body.run === "mr_fail" ? FAILED : body.run === "mr_unclear" ? UNCLEAR_RUN : RUN;
        return route.fulfill(json(ok(verb, { run, lines: [`log of ${String(body.step ?? "every step")}`, "14:06 ok"] })));
      }
      return route.fulfill(json(ok(verb, { entry: entry({}) })));
    }
    if (p === "/api/sessions") return route.fulfill(json(o.sessions ?? [SESSION, CODING, CODING_B]));
    if (p === "/api/diff/summary" || p === "/api/diff/patch") {
      diffs.push({ kind: p.endsWith("summary") ? "summary" : "patch", query: url.searchParams });
      return route.fulfill(json(p.endsWith("summary") ? { ...DIFF_SUMMARY, scope: Object.fromEntries(url.searchParams) } : { path: url.searchParams.get("file"), status: "M", patch: DIFF_PATCH, base: DIFF_SUMMARY.base, head: DIFF_SUMMARY.head }));
    }
    if (p === `/api/projects/${PID}/setup/merge`) {
      calls.push({ verb: "setup.merge", body: JSON.parse(route.request().postData() ?? "{}") });
      return route.fulfill(json({ queued: false, setup: o.setup ? o.setup() : NO_SETUP }));
    }
    if (p === `/api/projects/${PID}/setup`) {
      if (route.request().method() === "POST") {
        calls.push({ verb: "setup.open", body: JSON.parse(route.request().postData() ?? "{}") });
        return route.fulfill(json({ sessionId: SESSION.id, path: SESSION.path, reopened: false }, 201));
      }
      return route.fulfill(json(o.setup ? o.setup() : NO_SETUP));
    }
    if (p === `/api/projects/${PID}/runtime`) return route.fulfill(json(RUNTIME));
    if (p === `/api/projects/${PID}/overseer/worktrees`) return route.fulfill(json(WORKTREES));
    if (p === `/api/projects/${PID}/runtime/merge` || p === `/api/projects/${PID}/overseer/worktrees/merge`) {
      calls.push({ verb: p.endsWith("runtime/merge") ? "runtime.merge" : "worktrees.merge", body: JSON.parse(route.request().postData() ?? "{}") });
      return route.fulfill(json(p.endsWith("runtime/merge") ? RUNTIME : WORKTREES));
    }
    if (p === "/api/transcript") return route.fulfill(json({ items, context: null }));
    if (p === `/api/merge-queue/projects/${PID}/branch-summary`) {
      calls.push({ verb: "branch-summary.retry", body: JSON.parse(route.request().postData() ?? "{}") });
      return route.fulfill(json({ ok: true, state: "writing" }));
    }
    if (p === "/api/merge-queue/cards") return route.fulfill(json({ cards: url.searchParams.get("session") === SESSION.id ? (o.cards ?? []) : [] }));
    if (p === "/api/insights/session") return route.fulfill(json({ outline: null, compactions: [], teams: [], workers: [], worktrees: moved ? moved(o.rows ?? ALL_ROWS) : (o.rows ?? ALL_ROWS) }));
    if (p === "/api/projects") return route.fulfill(json({ projects: [PROJECT] }));
    if (p === `/api/projects/${PID}`) return route.fulfill(json(PROJECT));
    if (p === "/api/overseer/attention") return route.fulfill(json({ generatedAt: T0, counts: { act: 0, decide: 0, fyi: 0 }, items: [] }));
    if (p === "/api/overseer") return route.fulfill(json({ history: [], badge: { act: 0, decide: 0 }, unread: 0, proactivity: "badge", busy: false }));
    if (p === "/api/session-groups" || p === "/api/extensions") return route.fulfill(json([]));
    if (p === "/api/schedules") return route.fulfill(json({ schedules: [] }));
    if (p === "/api/settings") return route.fulfill(json({ experimental: {}, alignment: { review: false } }));
    if (p.startsWith("/api/") || p.startsWith("/ws") || p === "/sw.js") return route.fulfill(json({}, 404));
    const file = normalize(join(dist, p === "/" ? "index.html" : p));
    if (file.startsWith(dist) && existsSync(file) && statSync(file).isFile()) {
      const ext = /\.[a-z0-9]+$/.exec(file)?.[0] ?? "";
      return route.fulfill({ status: 200, contentType: CONTENT[ext] ?? "application/octet-stream", body: readFileSync(file) });
    }
    return route.fulfill({ status: 200, contentType: "text/html", body: readFileSync(join(dist, "index.html")) });
  });
  await page.goto(`${ORIGIN}/${hash}`);
  assert.equal(await page.evaluate(() => innerWidth), width);
  return { page, ctx, calls, frames, diffs, move: (f) => (moved = f) };
}

/** MQ_UI_SHOTS=<dir>: keep a screenshot of each screen (by hand, for a look). */
const shot = async (page: Page, name: string) => {
  const dir = process.env.MQ_UI_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false });
};

/** Every row action in `scope` (the rows' actions and an open confirm's two): Land's size, button-sm's height, at
 *  its label's width, never stretched or lifted to 44px, on every width and pointer. The ▾ is checked for height. */
async function rowActionsSized(scope: Locator, what: string) {
  const r = await scope.evaluate((root) => {
    const sm = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--control-sm"));
    const bad: string[] = [];
    let n = 0;
    for (const el of root.querySelectorAll<HTMLElement>(":is(.wt-queue-act, .mq-row-act, .wt-queue-confirm-act) .button")) {
      if (!el.getClientRects().length) continue;
      n++;
      const b = el.getBoundingClientRect();
      const name = el.getAttribute("aria-label") ?? el.textContent?.trim() ?? "?";
      if (Math.abs(b.height - sm) > 0.5) bad.push(`${name}: ${b.height}px tall, not ${sm}`);
      if (el.getAttribute("aria-haspopup") === "menu") continue;
      const cs = getComputedStyle(el);
      const range = document.createRange();
      range.selectNodeContents(el);
      const natural = range.getBoundingClientRect().width + [cs.paddingLeft, cs.paddingRight, cs.borderLeftWidth, cs.borderRightWidth].reduce((s, v) => s + parseFloat(v), 0);
      if (b.width > natural + 1.5) bad.push(`${name}: ${b.width}px wide, its label needs ${natural}`);
    }
    return { bad, n };
  });
  assert.ok(r.n > 0, `${what}: row actions found`);
  assert.deepEqual(r.bad, [], `${what}: every row action at Land's size`);
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000) {
  const t0 = Date.now();
  while (!(await ok())) {
    if (Date.now() - t0 >= ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
/** The words as written (chips draw uppercase; innerText would read them so). */
const words = async (l: { textContent(): Promise<string | null> }) => (await l.textContent()) ?? "";
const called = (o: Opened, verb: string) => until(`a ${verb} call`, () => o.calls.some((c) => c.verb === verb));
const lastCall = (o: Opened, verb: string) => [...o.calls].reverse().find((c) => c.verb === verb)!;
/** Land asks first: it opens the row's confirm (its actions step aside) with focus on the confirm's action, and only
    that action lands. `confirm` is the action's words: "Land 3 Commits" from the row's count. */
async function confirmLand(o: Opened, scope: Locator, branch: string, confirm: string | RegExp = /^Land (\d+ Commits?|Branch)$/) {
  const before = o.calls.filter((c) => c.verb === "merge.add").length;
  await scope.getByRole("button", { name: `Land ${branch}`, exact: true }).click();
  const ask = scope.getByRole("group", { name: `Land ${branch}`, exact: true });
  await ask.waitFor();
  assert.equal(o.calls.filter((c) => c.verb === "merge.add").length, before, "Land alone lands nothing");
  const go = ask.getByRole("button", { name: confirm });
  await until("focus on the confirm's action", () => go.evaluate((el) => el === document.activeElement));
  await go.click();
}

/** No screen of the queue says Restart, live or not live. Notes are the merge thread's own words, so they're left out. */
async function noRestartOrLive(page: Page, scope: string) {
  const text = await page.locator(scope).first().evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    for (const n of c.querySelectorAll(".wt-queue-note, .mq-note, .mq-card-note")) n.remove();
    return `${c.innerText} ${[...c.querySelectorAll("[aria-label],[title]")].map((e) => `${e.getAttribute("aria-label") ?? ""} ${e.getAttribute("title") ?? ""}`).join(" ")}`;
  });
  assert.doesNotMatch(text, /\brestart|\bnot live\b|\blive\b/i, `${scope} says Restart or live: ${text.slice(0, 400)}`);
}
const noSideScroll = async (page: Page) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "nothing scrolls sideways");

/** The chat's rows: Land typed early, the chat went on, then later messages. */
const CHAT_ITEMS = [
  { id: "u1", kind: "user", text: "land it", at: iso(40) },
  { id: "a1", kind: "assistant-text", text: "Queued.", at: iso(39), model: "mock/m1" },
  { id: "u2", kind: "user", text: "Now the badge.", at: iso(10) },
  { id: "a2", kind: "assistant-text", text: "On it.", at: iso(9), model: "mock/m1" },
];
const mc = (id: string, branch: string, x: Partial<MergeCard>): MergeCard => ({
  id,
  entry: id,
  session: SESSION.id,
  project: PID,
  root: ROOT_DIR,
  branch,
  target: "master",
  commit: sha("c"),
  approvedBy: "typed",
  state: "queued",
  notes: [],
  revisions: [{ id: `${id}:1`, kind: "approved", at: iso(40), after: "u1", state: "queued", position: 1 }],
  updatedAt: iso(1),
  ...x,
});
const LANDED_AT = iso(5);
/** Seven branches, seven cards: one landed (its approval folded above), one of every other kind. */
const CARDS: MergeCard[] = [
  mc("me_a", "feat/settle-cpu", {
    state: "landed",
    stats: { commits: 8, added: 970, removed: 45 },
    landed: { sha: sha("4"), from: sha("1"), at: LANDED_AT, pushed: "not-pushed", pushWhy: "push held: private names not set up yet" },
    newerCommits: 1,
    head: sha("5"),
    notes: [
      { kind: "thread", text: NOTE, at: LANDED_AT },
      { kind: "flaky", text: "server/a.test.ts failed, then passed on a rerun", at: LANDED_AT },
    ],
    revisions: [
      { id: "me_a:1", kind: "approved", at: iso(40), after: "u1", state: "queued", position: 1 },
      { id: "me_a:2", kind: "landed", at: LANDED_AT, after: "a2", state: "landed" },
    ],
  }),
  mc("me_b", "fix/conflict-chip", {
    state: "behaviour-differs",
    conflict: { files: ["src/a.ts"], verdict: "behaviour-differs", ours: "Master retries the save twice.", theirs: "The branch never retries.", proposal: "Keep master's retry.", at: iso(4) },
    revisions: [
      { id: "me_b:1", kind: "approved", at: iso(40), after: "u1", state: "queued", position: 2 },
      { id: "me_b:2", kind: "behaviour-differs", at: iso(4), after: "a2", state: "behaviour-differs" },
    ],
  }),
  mc("me_c", "feat/hack", {
    state: "needs-user",
    decision: DECISION,
    revisions: [{ id: "me_c:1", kind: "needs-fix", at: iso(3), after: "a2", state: "needs-user" }],
  }),
  // Back with the chat: one card in place, the try and the reason, the chat's answer, and only Remove from Queue.
  mc("me_g", "feat/save-hint", {
    state: "with-chat",
    standing: { phase: "with-chat", try: 2, of: 3, why: "Unit tests failed", answer: { kind: "cant", why: "the test needs a network", at: iso(1) } },
    revisions: [{ id: "me_g:1", kind: "approved", at: iso(39), after: "a1", state: "queued", position: 3 }],
  } as Partial<MergeCard>),
  mc("me_d", "fix/worker-restore", { state: "checking", progress: { done: 4, total: 7 }, revisions: [{ id: "me_d:1", kind: "approved", at: iso(39), after: "a1", state: "queued", position: 1 }] }),
  mc("me_e", "feat/pending-chip", { state: "queued", position: 2, eta: { startsInMs: 6 * 60_000, takesMs: 9 * 60_000 }, revisions: [{ id: "me_e:1", kind: "approved", at: iso(39), after: "a1", state: "queued", position: 2 }] }),
  mc("me_f", "fix/draft-autosave-race", {
    state: "needs-fix",
    run: "mr_fail",
    reason: "Unit tests fail with this branch and pass on master.",
    failures: [{ run: "mr_fail", step: "check:unit", label: "Unit tests", detail: "1 failed", tests: ["src/lib/drafts.test.ts › saves a draft once"] }],
    explanation: { text: "The autosave timer now fires twice when the tab regains focus.", at: iso(2) },
    revisions: [{ id: "me_f:1", kind: "needs-fix", at: iso(2), after: "a2", state: "needs-fix", run: "mr_fail" }],
  }),
];
/** Can't tell whose failure: the build fails on the merge and on master alone, naming no tests. */
const UNCLEAR_WHY = "Build failed with this branch and on master alone, and names no tests";
const UNCLEAR = [{ check: "build", label: "Build", run: "mr_unclear", step: "rerun-master:build", why: "fails with this branch and on master alone, naming no tests" }];
const UNCLEAR_RUN: MergeRun = {
  ...RUN,
  id: "mr_unclear",
  entry: "me_u",
  branch: "feat/slow-build",
  verdict: "waiting",
  why: UNCLEAR_WHY,
  endedAt: iso(1),
  steps: [
    { id: "check:build", kind: "check", label: "Build", result: "failed", ms: 50_000, source: "required", log: "b.log" },
    { id: "rerun-master:build", kind: "rerun-master", label: "Build on master alone", result: "failed", ms: 40_000, log: "bm.log" },
  ],
};
const POSTS = /"type":"(prompt|steer|follow_up)"/;

/** What Review Changes reads: one committed file and one uncommitted (untracked) one. */
const DIFF_SUMMARY = {
  repo: "/w/.worktrees/sova-ready-one",
  base: { label: "master (merge-base)", oid: sha("1") },
  head: { label: "feat/ready-one with uncommitted files" },
  files: [
    { path: "src/a.ts", status: "M", added: 3, removed: 1 },
    { path: "src/loose.ts", status: "A", added: 2, removed: 0, untracked: true, uncommitted: true },
  ],
  totals: { files: 2, added: 5, removed: 1 },
  uncommitted: 1,
  generatedAt: T0,
};
const DIFF_PATCH = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
/** An archived chat of the project, and the three ready rows: its chat known, none found, an archived one. */
const ARCHIVED = { ...SESSION, id: "c3", path: "/w/sessions/c3.jsonl", title: "Old search", archived: true } as unknown as SessionSummary;
const READY: MergeQueueView["ready"] = [
  {
    branch: "feat/ready-one",
    worktree: "/w/.worktrees/sova-ready-one",
    commit: sha("9"),
    ahead: 3,
    added: 40,
    removed: 2,
    headAt: iso(2 * 24 * 60),
    session: "c2",
    summary: { commit: sha("9"), state: "ready", bullets: ["Shows what each branch does in a few plain bullets", "Fixes the badge color on a narrow screen, so it no longer wraps onto a second line and overlaps the chat's title"] },
  },
  { branch: "feat/no-chat", worktree: "/w/.worktrees/sova-no-chat", commit: sha("8"), ahead: 1, added: 6, removed: 1, summary: { commit: sha("8"), state: "writing" } },
  { branch: "feat/search-ab-with-a-much-longer-branch-name", worktree: "/w/.worktrees/sova-search-ab", commit: sha("7"), ahead: 12, added: 310, removed: 88, session: "c3", sessionArchived: true, summary: { commit: sha("7"), state: "failed", bullets: ["Searches the archive"], stale: { commit: sha("6") } } },
];
const hashOf = (page: Page) => page.evaluate(() => location.hash);
/** One of the Merge Queue tab's own tabs, by its label (its count after it): picked, then shown. */
async function showTab(page: Page, label: string) {
  const t = page.getByRole("tablist", { name: "Merge queue" }).getByRole("tab", { name: new RegExp(`^${label}( · \\d+)?$`) });
  await t.click();
  await until(`${label} shown`, async () => (await t.getAttribute("aria-selected")) === "true");
}
/** The Merge Queue tab's Waiting, which starts closed: opened. */
async function openWaiting(page: Page) {
  const b = page.locator(".mq-tab").getByRole("button", { name: /^Waiting · / });
  await b.click();
  await until("Waiting open", async () => (await b.getAttribute("aria-expanded")) === "true");
}
const box = async (l: { boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null> }) => (await l.boundingBox())!;
/** Which edges of a tab strip fade (the design system's .tabs mask, its edge widths read from the strip), and whether
    it overflows. */
const stripFade = (strip: Locator) =>
  strip.evaluate((el) => {
    const cs = getComputedStyle(el);
    const w = (p: string) => parseFloat(cs.getPropertyValue(p)) || 0;
    return { start: w("--tabs-fade-start") > 0, end: w("--tabs-fade-end") > 0, overflows: el.scrollWidth > el.clientWidth };
  });
/** The strip's top against the top of the pane that scrolls it, and that pane's scroll. `toTop`: scroll it there first. */
const stripAtTop = (strip: Locator, toTop = false) =>
  strip.evaluate((el, toTop) => {
    let p = el.parentElement;
    while (p && !/auto|scroll/.test(getComputedStyle(p).overflowY)) p = p.parentElement;
    const pane = p ?? (document.scrollingElement as HTMLElement);
    const top = () => (p ? p.getBoundingClientRect().top : 0);
    if (toTop) pane.scrollTop += el.getBoundingClientRect().top - top();
    return { gap: el.getBoundingClientRect().top - top(), y: el.getBoundingClientRect().top, scroll: pane.scrollTop, atEnd: pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 1 };
  }, toTop);

for (const width of [1280, 390]) {
  describe(`${width}px`, () => {
    test("the composer control sits just left of N inputs and reads 2 ready; the modal lists every row", async () => {
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`, { rows: READY_ROWS });
      const { page } = o;
      const control = page.getByRole("button", { name: /^Worktrees: / });
      await control.waitFor({ timeout: 20_000 });
      assert.match(await words(control), /2 ready/);
      const inputs = page.locator(".run-status-inputs").first();
      await inputs.waitFor();
      const a = (await control.boundingBox())!;
      const b = (await inputs.boundingBox())!;
      assert.ok(a.x + a.width <= b.x + 1, `the control (${a.x}+${a.width}) is left of inputs (${b.x})`);
      assert.ok(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) < 4, "on the same row");
      await shot(page, `${width}-composer`);
      await control.click();
      const modal = page.getByRole("dialog", { name: "Worktrees" });
      await modal.waitFor();
      assert.match(await words(modal), /2 ready · 1 queued · 1 landed/);
      // Each live row carries its numbers against master; a landed one doesn't.
      assert.match(await words(modal.locator('[data-branch="feat/composer-drafts"]')), /3 commits · \+40 −2/);
      // The row's top line: its chat's title (a link), then the branch; no folder; its bullets under the facts.
      const drafts = modal.locator('[data-branch="feat/composer-drafts"]');
      assert.match(await words(drafts.locator(".mq-head-line")), /^\s*Composer drafts survive reload\s*feat\/composer-drafts\s*$/);
      assert.equal(await drafts.getByRole("link", { name: "Composer drafts survive reload" }).count(), 1);
      assert.deepEqual(await drafts.locator(".mq-summary-bullets li").allInnerTexts(), ["Keeps a draft through a reload", "Restores the cursor where it was"]);
      const wtFacts = await box(drafts.locator(".wt-queue-facts"));
      assert.ok((await box(drafts.locator(".mq-summary-bullets"))).y >= wtFacts.y + wtFacts.height - 1, "the bullets under the facts");
      assert.doesNotMatch(await words(modal.locator('[data-branch="feat/composer-hints"]')), /commits ·/);
      assert.match(await words(modal), /Queued · 2nd/);
      assert.match(await words(modal), /starts in ~4 min · takes ~9 min/);
      assert.match(await words(modal), /1 newer commit not included/);
      assert.match(await words(modal), new RegExp(NOTE.replace(/[.;]/g, "\\$&")));
      assert.equal(await modal.getByRole("link", { name: "View Merge Queue" }).getAttribute("href"), `#/projects/${PID}/merge-queue`);
      await noRestartOrLive(page, ".wt-queue-modal");
      await noSideScroll(page);
      await shot(page, `${width}-modal-ready`);
      await o.ctx.close();
    });

    test("every state in the modal, and each action calls its verb", async () => {
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`);
      const { page } = o;
      const control = page.getByRole("button", { name: /^Worktrees: / });
      await control.waitFor({ timeout: 20_000 });
      assert.match(await words(control), /2 need you/);
      await control.click();
      const modal = page.getByRole("dialog", { name: "Worktrees" });
      await modal.waitFor();
      const text = await words(modal);
      for (const word of ["Ready", "Queued · 2nd", "Uncommitted", "Needs a fix", "Behaviour differs", "Needs you", "Landed"]) assert.match(text, new RegExp(word), word);
      assert.match(text, /Master retries the save twice\./);
      assert.match(text, /Keep the Save button at the top, or move it under the form\?/);
      // A live row's size, then when the branch last changed; in full on hover. A landed row has neither.
      const sized = modal.locator('[data-branch="feat/composer-drafts"] .wt-queue-size');
      assert.equal((await words(sized)).trim(), "3 commits · +40 −2 · 3h ago");
      assert.equal(await sized.locator("time").getAttribute("datetime"), iso(3 * 60));
      assert.match((await sized.locator("time").getAttribute("title")) ?? "", /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M$/);
      assert.equal(await modal.locator('[data-state="landed"] time').count(), 0);
      await shot(page, `${width}-modal-all`);
      await rowActionsSized(modal, "the modal");

      // The branch moves after the page read it: Land still pins the commit the row showed.
      o.move((rows) => rows.map((r) => ({ ...r, mergeStats: { ahead: 4, added: 41, removed: 2, head: sha("e") } as SessionWorktreeInfo["mergeStats"] })));
      // Land asks first: the row's actions give way to the confirm, Not Yet and Escape each put them back with
      // focus on Land, and Escape never closes the modal; only the confirm's own action lands.
      const draftsRow = modal.locator('[data-branch="feat/composer-drafts"]');
      const landAsk = draftsRow.getByRole("button", { name: "Land feat/composer-drafts", exact: true });
      assert.equal((await words(landAsk)).trim(), "Land", "no ellipsis");
      await shot(page, `${width}-modal-land-idle`);
      await landAsk.click();
      const ask = draftsRow.getByRole("group", { name: "Land feat/composer-drafts", exact: true });
      await ask.waitFor();
      assert.match(await words(ask), /Land feat\/composer-drafts\?/);
      assert.match(await words(ask), /3 commits go to the merge queue; master moves once checks pass\./);
      assert.deepEqual(await ask.getByRole("button").allTextContents(), ["Not Yet", "Land 3 Commits"], "Not Yet left, the action rightmost");
      assert.equal(await draftsRow.locator(".wt-queue-act").count(), 0, "the confirm replaces the row's actions");
      await rowActionsSized(draftsRow, "the modal's confirm");
      await until("focus on Land 3 Commits", () => ask.getByRole("button", { name: "Land 3 Commits" }).evaluate((el) => el === document.activeElement));
      await shot(page, `${width}-modal-land-confirm`);
      await ask.getByRole("button", { name: "Not Yet" }).click();
      await until("the confirm closed", async () => (await ask.count()) === 0);
      await until("focus back on Land", () => landAsk.evaluate((el) => el === document.activeElement));
      await landAsk.click();
      await ask.waitFor();
      await page.keyboard.press("Escape");
      await until("Escape closed the confirm", async () => (await ask.count()) === 0);
      assert.equal(await page.getByRole("dialog", { name: "Worktrees" }).count(), 1, "Escape on the confirm leaves the modal open");
      await until("focus back on Land after Escape", () => landAsk.evaluate((el) => el === document.activeElement));
      assert.equal(o.calls.filter((c) => c.verb === "merge.add").length, 0, "nothing landed yet");
      await confirmLand(o, modal, "feat/composer-drafts", "Land 3 Commits");
      await called(o, "merge.add");
      assert.deepEqual(lastCall(o, "merge.add").body, { checkout: "/w/.worktrees/sova-composer-drafts", commit: sha("d") });

      // Escape on the open ▾ closes the menu, not the modal.
      await modal.getByRole("button", { name: "More ways to land feat/composer-shortcuts" }).click();
      await page.getByRole("menuitem", { name: "Land feat/composer-shortcuts without review" }).waitFor();
      await page.keyboard.press("Escape");
      await until("the menu closed", async () => (await page.getByRole("menuitem", { name: "Land feat/composer-shortcuts without review" }).count()) === 0 || !(await page.getByRole("menuitem", { name: "Land feat/composer-shortcuts without review" }).isVisible()));
      assert.equal(await page.getByRole("dialog", { name: "Worktrees" }).count(), 1, "the modal stays");
      await modal.getByRole("button", { name: "More ways to land feat/composer-shortcuts" }).click();
      await page.getByRole("menuitem", { name: "Land feat/composer-shortcuts without review" }).click();
      await until("a Land Without Review", () => o.calls.filter((c) => c.verb === "merge.add").length === 2);
      assert.equal(lastCall(o, "merge.add").body.withoutReview, true);

      await modal.getByRole("button", { name: "More ways to land feat/composer-shortcuts" }).click();
      await page.getByRole("menuitem", { name: "Land feat/composer-shortcuts without its specs" }).click();
      await modal.getByRole("button", { name: "Land Without Specs" }).click();
      await until("a Land Without Specs", () => o.calls.filter((c) => c.verb === "merge.add").length === 3);
      assert.equal(lastCall(o, "merge.add").body.withoutSpecs, true);

      await modal.getByRole("button", { name: "Remove fix/paste-images from the merge queue" }).click();
      await called(o, "merge.cancel");
      assert.deepEqual(lastCall(o, "merge.cancel").body, { entry: "me_q" });

      await modal.getByRole("button", { name: "Accept the resolution for fix/conflict-chip" }).click();
      await until("an accept", () => o.calls.some((c) => c.verb === "merge.answer" && c.body.answer === "accept"));
      assert.equal(lastCall(o, "merge.answer").body.entry, "me_b");

      // A decision: its question and choices, answered in the chat (no text box), and Remove from Queue.
      const hack = modal.locator('[data-branch="feat/hack"]');
      assert.match(await words(hack), /Keep the Save button at the top, or move it under the form\?/);
      assert.match(await words(hack), /Choices: Keep it at the top · Move it under the form/);
      assert.equal(await hack.getByRole("button", { name: "Answer about feat/hack in the chat" }).count(), 1);
      assert.equal(await modal.locator("textarea, input[type=text]").count(), 0, "no text box in any row");
      await hack.getByRole("button", { name: "Remove feat/hack from the merge queue" }).click();
      await until("a remove", () => o.calls.some((c) => c.verb === "merge.cancel" && c.body.entry === "me_r"));
      // Sent back: Remove from Queue only. No row anywhere offers Send Back or a re-land (al_3).
      await modal.locator('[data-branch="fix/draft-autosave-race"]').getByRole("button", { name: "Remove fix/draft-autosave-race from the merge queue" }).waitFor();
      for (const gone of [/Send Back/, /Send .* back to its chat/, /Land This Commit Again/, /Land Newest Commit/, /at its newest commit/]) assert.equal(await modal.getByRole("button", { name: gone }).count(), 0, String(gone));

      // An uncommitted row has no Land.
      assert.equal(await modal.getByRole("button", { name: "Land feat/draft-sync-tabs", exact: true }).count(), 0);
      assert.equal(await modal.locator('[data-branch="fix/draft-autosave-race"] a', { hasText: "See Why" }).getAttribute("href"), `#/projects/${PID}/merge-queue/mr_fail`);
      // Sent back: no Land and no Land menu while its chat fixes it (al_4).
      assert.equal(await modal.getByRole("button", { name: "Land fix/draft-autosave-race", exact: true }).count(), 0);
      assert.equal(await modal.getByRole("button", { name: "More ways to land fix/draft-autosave-race" }).count(), 0);
      await noRestartOrLive(page, ".wt-queue-modal");
      await noSideScroll(page);
      await page.keyboard.press("Escape");
      await until("the modal closed", async () => (await page.getByRole("dialog", { name: "Worktrees" }).count()) === 0);
      await o.ctx.close();
    });

    test("a paused queue says so in the modal, and a project not set up offers Set Up Queue", async () => {
      const paused = { ...mergeProject, paused: "the project folder has uncommitted edits" };
      const unset = { ...mergeProject, checks: "unset" as const };
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`, { rows: [wt("feat/composer-drafts", { mergeProject: paused }), wt("feat/other", { mergeProject: unset })] });
      await o.page.getByRole("button", { name: /^Worktrees: / }).click({ timeout: 20_000 });
      const modal = o.page.getByRole("dialog", { name: "Worktrees" });
      await modal.waitFor();
      assert.match(await words(modal), /The queue is paused: the project folder has uncommitted edits\./);
      assert.equal(await modal.getByRole("link", { name: "Set Up Queue" }).getAttribute("href"), `#/projects/${PID}/merge-queue`);
      await rowActionsSized(modal, "Set Up Queue");
      assert.equal(await modal.getByRole("button", { name: "Land feat/other", exact: true }).count(), 0);
      // Listed, not set up: it merges plainly (al_1 a5).
      assert.match(await words(modal.locator('[data-branch="feat/other"]')), /Ready to merge.*Say “land it” in the chat to merge it into main[.]/);
      await noRestartOrLive(o.page, ".wt-queue-modal");
      await o.ctx.close();
    });

    test("a repo off the Projects list (no mergeProject, no mergeServed): no Land, no Ready to land, no Set Up Queue; it reads Ready to merge", async () => {
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`, { rows: [wt("feat/build", { mergeProject: undefined })] });
      await o.page.getByRole("button", { name: /^Worktrees: / }).click({ timeout: 20_000 });
      const modal = o.page.getByRole("dialog", { name: "Worktrees" });
      await modal.waitFor();
      const t = await words(modal);
      assert.match(t, /Ready to merge/);
      assert.match(t, /Say “land it” in the chat to merge it into main[.]/);
      assert.doesNotMatch(t, /Ready to land|Landing specs|Set Up Queue|Land queues|merge queue/i);
      assert.equal(await modal.getByRole("button", { name: /^Land / }).count(), 0);
      await o.ctx.close();
    });

    test("a worktree of a project whose definition doesn't parse keeps Land, with the reason; Land calls the queue", async () => {
      const bad = '$.merge.checks[0].run[2]: a lone "$"';
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`, { rows: [wt("feat/fix-definition", { mergeProject: { ...mergeProject, checks: "unset", invalid: bad } })] });
      await o.page.getByRole("button", { name: /^Worktrees: / }).click({ timeout: 20_000 });
      const modal = o.page.getByRole("dialog", { name: "Worktrees" });
      await modal.waitFor();
      const t = await words(modal);
      assert.ok(t.includes(`doesn't parse: ${bad}. Fix it on the target, or land a branch that fixes it`));
      assert.equal(await modal.getByRole("link", { name: "Set Up Queue" }).count(), 0);
      await confirmLand(o, modal, "feat/fix-definition");
      await until("a land", () => o.calls.some((c) => c.verb === "merge.add" && c.body.checkout === "/w/.worktrees/sova-fix-definition"));
      await o.ctx.close();
    });

    test("the session pane's Worktrees rows: the same states and actions", async () => {
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`);
      const { page } = o;
      await page.getByRole("button", { name: /^Worktrees: / }).waitFor({ timeout: 20_000 });
      await page.getByRole("button", { name: "Session details" }).first().click();
      const section = page.locator("section", { has: page.getByRole("heading", { name: "Worktrees" }) }).last();
      await section.locator(".wt-queue-row").first().waitFor({ timeout: 10_000 });
      const text = await words(section);
      for (const word of ["Ready", "Queued · 2nd", "Uncommitted", "Needs a fix", "Behaviour differs", "Needs you", "Landed"]) assert.match(text, new RegExp(word), word);
      assert.match(text, /2 ready · 1 queued · 1 behaviour differs · 1 needs you · 1 needs a fix · 1 uncommitted · 1 landed/);
      assert.match(await words(section.locator('[data-branch="feat/composer-drafts"]')), /3 commits · \+40 −2/);
      assert.equal(await section.getByRole("button", { name: "Land fix/draft-autosave-race", exact: true }).count(), 0, "sent back: no Land (al_4)");
      assert.equal(await section.getByRole("button", { name: "More ways to land fix/draft-autosave-race" }).count(), 0, "sent back: no Land menu (al_4)");
      await section.getByRole("button", { name: "Remove fix/paste-images from the merge queue" }).click();
      await called(o, "merge.cancel");
      await confirmLand(o, section, "feat/composer-drafts", "Land 3 Commits");
      await called(o, "merge.add");
      assert.equal(await section.getByRole("link", { name: "View Merge Queue" }).getAttribute("href"), `#/projects/${PID}/merge-queue`);
      await rowActionsSized(section, "the pane");
      await noRestartOrLive(page, ".wt-queue-list");
      await shot(page, `${width}-pane`);
      await o.ctx.close();
    });

    test("the Merge Queue tab: strip, checking now, the line, needs you, sent back, recent with its note", async () => {
      const o = await open(width, `#/projects/${PID}/merge-queue`);
      const { page } = o;
      const tab = page.locator(".mq-tab");
      await tab.getByRole("group", { name: "Checking now" }).waitFor({ timeout: 20_000 });
      assert.equal(await page.getByRole("tab", { name: "Merge Queue" }).getAttribute("aria-selected"), "true");
      const text = await words(tab);
      assert.match(text, /Pushed to origin/);
      assert.match(text, /fix\/worker-restore/);
      assert.match(text, /Unit tests · check 2 of 4/);
      // Waiting starts closed: its header line only, a button over its rows.
      assert.match(text, /Waiting · 2 · the last one done in ~37 min/);
      const waiting = tab.getByRole("button", { name: /^Waiting · 2/ });
      assert.equal(await waiting.getAttribute("aria-expanded"), "false");
      assert.doesNotMatch(text, /starts in ~6 min/);
      assert.equal(await tab.locator('[data-state="queued"]').count(), 0, "no waiting row while closed");
      // The strip: every tab with its count but Landed; Ready to land shown first; no host tab on a local project.
      const strip = tab.getByRole("tablist", { name: "Merge queue" });
      assert.deepEqual(await strip.getByRole("tab").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))), ["Ready to land · 1", "Needs you · 2", "With its chat · 1", "Landed", "Queue chats · 0"]);
      assert.equal(await strip.getByRole("tab", { selected: true }).getAttribute("aria-label"), "Ready to land · 1");
      assert.equal(await strip.locator(".mq-tab-count-warn").count(), 1, "one count warns");
      assert.equal(await strip.locator('[data-tab="needs-you"] .mq-tab-count-warn').count(), 1, "Needs you's, while it has anything");
      const panel = tab.getByRole("tabpanel");
      assert.equal(await panel.getAttribute("aria-labelledby"), "mq-tab-ready");
      assert.equal(await panel.locator('[data-state="ready"]').count(), 1);
      assert.equal(await panel.getAttribute("tabindex"), null, "a panel with rows takes no focus of its own");
      // The design system's edge fade: on a phone the strip overflows and its end fades; with room, nothing does.
      assert.deepEqual(await stripFade(strip), width < 600 ? { start: false, end: true, overflows: true } : { start: false, end: false, overflows: false });
      await waiting.click();
      assert.equal(await waiting.getAttribute("aria-expanded"), "true");
      const line = tab.getByRole("region", { name: "Waiting" });
      const lt = await words(line);
      assert.match(lt, /starts in ~6 min · takes ~9 min/);
      assert.match(lt, /2 newer commits not included/);
      assert.match(lt, /typed in its chat/);
      assert.deepEqual(await line.locator("[data-state=queued]").evaluateAll((els) => els.map((e) => e.getAttribute("data-branch"))), ["feat/pending-chip", "feat/replay-timeouts"], "in line order");
      // The page's Refresh Project closes it, as a fresh visit shows it.
      await page.getByRole("button", { name: "Refresh Project" }).click();
      await until("Waiting closed by Refresh Project", async () => (await waiting.getAttribute("aria-expanded")) === "false");
      assert.equal(await tab.locator('[data-state="queued"]').count(), 0, "no waiting row after Refresh Project");
      await waiting.click();
      await until("Waiting open again", async () => (await waiting.getAttribute("aria-expanded")) === "true");
      await shot(page, `${width}-queue`);
      await tab.getByRole("button", { name: "Pause Queue" }).click();
      await called(o, "merge.pause");
      await tab.getByRole("button", { name: "Remove feat/replay-timeouts from the merge queue" }).click();
      await until("a cancel", () => o.calls.some((c) => c.verb === "merge.cancel" && c.body.entry === "me_w2"));

      // Needs you: its own address; the rows it always had.
      await showTab(page, "Needs you");
      assert.equal(await hashOf(page), `#/projects/${PID}/merge-queue/needs-you`);
      const nt = await words(panel);
      assert.match(nt, /Behaviour differs · waiting for you/);
      assert.match(nt, /Needs you · feat\/hack/);
      assert.match(nt, /Keep the Save button at the top, or move it under the form\?/);
      assert.match(nt, /isn't sent yet: it goes with your answer/);
      assert.match(nt, /Keep master's retry\./);
      assert.equal(await waiting.getAttribute("aria-expanded"), "true", "Waiting stays as it was while you change tabs");
      await rowActionsSized(panel, "the Needs you tab");
      await tab.getByRole("button", { name: "Accept the resolution for fix/conflict-chip" }).click();
      await until("an accept", () => o.calls.some((c) => c.verb === "merge.answer" && c.body.answer === "accept"));
      // A decision answered in words: Answer in Chat opens its chat; no row has a text box, a Send Back or a re-land.
      assert.equal(await tab.locator('.mq-needs[data-branch="feat/hack"]').getByRole("link", { name: "Answer about feat/hack in its chat" }).count(), 1);
      assert.equal(await tab.locator(".mq-list textarea, .mq-list input[type=text]").count(), 0, "no text box in any row");
      for (const gone of [/Send Back/, /back to its chat/, /Land This Commit Again/, /Land Newest Commit/, /at its newest commit/]) assert.equal(await tab.getByRole("button", { name: gone }).count(), 0, String(gone));
      await tab.locator('.mq-needs[data-branch="feat/hack"]').getByRole("button", { name: "Remove feat/hack from the merge queue" }).click();
      await until("a remove", () => o.calls.some((c) => c.verb === "merge.cancel" && c.body.entry === "me_r"));

      // A pick never moves the strip under the pointer: scrolled toward the strip as far as the pane goes (at its end,
      // where a shorter page would pull the strip down), a shorter tab keeps it there.
      const atTop = await stripAtTop(strip, true);
      assert.ok(atTop.scroll > 0 && (Math.abs(atTop.gap) < 1 || atTop.atEnd), `the pane scrolled to the strip: ${JSON.stringify(atTop)}`);
      // With its chat, Landed, and an empty tab saying so in one line.
      await showTab(page, "With its chat");
      const after = await stripAtTop(strip);
      assert.ok(Math.abs(after.y - atTop.y) < 1, `the strip stays put: ${atTop.y} → ${after.y}`);
      assert.equal(await hashOf(page), `#/projects/${PID}/merge-queue/with-its-chat`);
      assert.match(await words(panel), /Your Land stands: it goes back in line by itself once its chat's fix is checked\./);
      await showTab(page, "Landed");
      assert.equal(await hashOf(page), `#/projects/${PID}/merge-queue/landed`);
      assert.match(await words(panel), new RegExp(NOTE.replace(/[.;]/g, "\\$&")));
      await showTab(page, "Queue chats");
      // An empty tab: the live fact, then the absence; its panel takes focus, so Tab from the strip reaches the line.
      assert.equal((await words(panel)).trim(), "1 being checked, 2 waiting. No queue chat yet.");
      assert.equal(await panel.getAttribute("tabindex"), "0");
      await strip.getByRole("tab", { selected: true }).focus();
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "mq-tabpanel", "Tab from the strip lands on the empty panel");
      if (width < 600) {
        // The strip scrolls sideways by itself, never the page, and the tab shown is scrolled into view, clear of the
        // fade, which is now at the start only (the last tab is shown).
        assert.ok(await strip.evaluate((el) => el.scrollWidth > el.clientWidth), "the strip overflows at a phone's width");
        const picked = await box(strip.getByRole("tab", { selected: true }));
        assert.ok(picked.x >= -1 && picked.x + picked.width <= width + 1, "the tab shown is in view");
        await until("the strip scrolled to its end", async () => JSON.stringify(await stripFade(strip)) === JSON.stringify({ start: true, end: false, overflows: true }));
      }
      await noSideScroll(page);
      // The tab is in the address: Back, and a reload, keep it; Waiting is closed again after the reload.
      await page.goBack();
      await until("Back to Landed", async () => (await strip.getByRole("tab", { selected: true }).getAttribute("aria-label")) === "Landed");
      await page.reload();
      await strip.waitFor({ timeout: 20_000 });
      assert.equal(await strip.getByRole("tab", { selected: true }).getAttribute("aria-label"), "Landed");
      assert.equal(await tab.getByRole("button", { name: /^Waiting · / }).getAttribute("aria-expanded"), "false");
      // Keys move along the strip (wrapping); Enter picks.
      await strip.getByRole("tab", { selected: true }).focus();
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Enter");
      await until("With its chat by key", async () => (await hashOf(page)) === `#/projects/${PID}/merge-queue/with-its-chat`);
      // A run opened from a tab returns there: Back to Queue names it; the run's own address does too.
      const why = panel.locator('[data-branch="fix/draft-autosave-race"]').getByRole("link", { name: "See Why" });
      assert.equal(await why.getAttribute("href"), `#/projects/${PID}/merge-queue/with-its-chat/mr_fail`);
      await why.click();
      const back = page.getByRole("link", { name: "Back to Queue" });
      await back.waitFor({ timeout: 20_000 });
      assert.equal(await back.getAttribute("href"), `#/projects/${PID}/merge-queue/with-its-chat`);
      await back.click();
      await until("back on With its chat", async () => (await strip.getByRole("tab", { selected: true }).getAttribute("aria-label").catch(() => null)) === "With its chat · 1");
      assert.equal(await tab.getByRole("button", { name: /^Waiting · / }).getAttribute("aria-expanded"), "false", "closed again after a run");
      // Back from a run, the strip is at the top of the pane, over the rows the run was opened from.
      await until("the strip at the pane's top after a run", async () => Math.abs((await stripAtTop(strip)).gap) < 1);
      assert.ok((await stripAtTop(strip)).scroll > 0, "the pane scrolled to it");
      // The project's own Merge Queue tab opens Ready to land.
      assert.equal(await page.getByRole("tab", { name: "Merge Queue" }).count(), 1);
      await page.getByRole("tab", { name: "Branches" }).click();
      await until("on Branches", async () => (await hashOf(page)) === `#/projects/${PID}/branches`);
      await page.getByRole("tab", { name: "Merge Queue" }).click();
      await until("on Ready to land", async () => (await strip.getByRole("tab", { selected: true }).getAttribute("aria-label").catch(() => null)) === "Ready to land · 1");
      assert.equal(await hashOf(page), `#/projects/${PID}/merge-queue`);
      await rowActionsSized(tab, "the tab");
      // Once, in the Merge thread card; the head has Queue Settings and Pause Queue only.
      assert.equal(await tab.getByRole("link", { name: "Open Merge Thread" }).count(), 1);
      assert.equal(await tab.locator(".mq-thread-card").getByRole("link", { name: "Open Merge Thread" }).count(), 1);
      assert.equal(await tab.locator(".mq-head").getByRole("link", { name: "Open Merge Thread" }).count(), 0);
      // The head's buttons and the card's links: an even gap. A row that runs out of room wraps (at 390 the head's
      // three 44px buttons don't fit one line): neighbours on a line share its centre line ≥ 7.5px apart, and a
      // wrapped line sits ≥ 7.5px below the one above.
      for (const scope of [".mq-head .button-row", ".mq-thread-card .button-row"]) {
        const b = await tab.locator(scope).first().evaluate((row) => [...row.children].map((c) => c.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right, top: r.top, bottom: r.bottom, mid: r.top + r.height / 2 })));
        for (let i = 1; i < b.length; i++) {
          if (Math.abs(b[i]!.mid - b[i - 1]!.mid) < 1) assert.ok(b[i]!.l - b[i - 1]!.r >= 7.5, `${scope}: a gap between buttons ${i - 1} and ${i}`);
          else assert.ok(b[i]!.top - b[i - 1]!.bottom >= 7.5, `${scope}: button ${i} wraps ≥ 7.5px below button ${i - 1}`);
        }
      }
      // Ready to land: Land and its ▾, on the queue's own page.
      const ready = tab.locator('[data-branch="feat/ready-one"]');
      assert.match(await words(ready), /3 commits ahead/);
      await confirmLand(o, ready, "feat/ready-one", "Land 3 Commits");
      await until("a land from the ready list", () => o.calls.some((c) => c.verb === "merge.add" && c.body.branch === "feat/ready-one"));
      assert.equal(lastCall(o, "merge.add").body.project, ROOT_DIR);
      assert.equal(lastCall(o, "merge.add").body.commit, sha("9"), "the ready row's shown commit is pinned");
      await ready.getByRole("button", { name: "More ways to land feat/ready-one" }).click();
      await page.getByRole("menuitem", { name: "Land feat/ready-one without review" }).click();
      await until("a land without review", () => o.calls.some((c) => c.verb === "merge.add" && c.body.branch === "feat/ready-one" && c.body.withoutReview === true));
      await ready.getByRole("button", { name: "More ways to land feat/ready-one" }).click();
      await page.getByRole("menuitem", { name: "Land feat/ready-one without its specs" }).click();
      await ready.getByRole("button", { name: "Land Without Specs" }).click();
      await until("a land without specs", () => o.calls.some((c) => c.verb === "merge.add" && c.body.branch === "feat/ready-one" && c.body.withoutSpecs === true));
      await noRestartOrLive(page, ".mq-tab");
      await noSideScroll(page);
      await o.ctx.close();
    });

    test("set up: the coding rows offer Land and show their queue state; the playbook run's button is Land", async () => {
      const view = viewOf({ waiting: [entry({ id: "me_badge", branch: "sova/fix-badge", state: "queued", position: 1, eta: { startsInMs: 3 * 60_000, takesMs: 9 * 60_000 } })] });
      const o = await open(width, `#/projects/${PID}`, { view });
      const { page } = o;
      const badge = page.locator(".project-worktree", { hasText: "Fix the badge" });
      await badge.getByText("Queued · 1st").waitFor({ timeout: 20_000 });
      assert.match(await words(badge), /starts in ~3 min · takes ~9 min/);
      // The playbook run: Land, through the queue at its branch.
      const landRun = page.getByRole("button", { name: "Land sova/project-verbs" }).first();
      await landRun.waitFor();
      assert.equal(await page.getByRole("button", { name: "Merge Branch" }).count(), 0, "no Merge Branch while the queue is set up");
      assert.match(await words(page.locator(".banner", { hasText: "Project verbs playbook" }).first()), /Read it, then land it: it's checked on master first\./);
      await landRun.click();
      await until("a land of the run's branch", () => o.calls.some((c) => c.verb === "merge.add" && c.body.branch === "sova/project-verbs"));
      assert.equal(lastCall(o, "merge.add").body.project, ROOT_DIR);
      assert.equal(lastCall(o, "merge.add").body.commit, sha("7"), "the run's reviewed tip is pinned");
      // A coding row: its ⋯ holds Land (not Merge Branch); Land queues its worktree.
      const cart = page.locator(".project-worktree", { hasText: "Fix the cart" });
      await cart.getByRole("button", { name: /^Actions · / }).click();
      assert.equal(await page.getByRole("menuitem", { name: /^Merge Branch/ }).count(), 0);
      await page.getByRole("menuitem", { name: "Land sova/fix-cart on master" }).click();
      await until("a land of the coding worktree", () => o.calls.some((c) => c.verb === "merge.add" && c.body.checkout === "/w/.worktrees/sova-fix-cart"));
      assert.equal(lastCall(o, "merge.add").body.commit, sha("8"), "the row's shown head is pinned");
      // A queued row's Land says why it can't.
      await badge.getByRole("button", { name: /^Actions · / }).click();
      assert.equal(await page.getByRole("menuitem", { name: "Land sova/fix-badge on master" }).getAttribute("aria-disabled"), "true");
      await page.keyboard.press("Escape");
      assert.equal(o.calls.filter((c) => c.verb === "worktrees.merge" || c.verb === "runtime.merge").length, 0, "nothing merged directly");
      await noSideScroll(page);
      await shot(page, `${width}-project-rows-setup`);
      await o.ctx.close();
    });

    test("not set up: the coding rows and the playbook run keep Merge Branch", async () => {
      const o = await open(width, `#/projects/${PID}`, { view: viewOf({ checks: "unset", state: "idle", current: undefined, checking: [], waiting: [], needsYou: [], needsFix: [], recent: [] }) });
      const { page } = o;
      const run = page.getByRole("button", { name: "Merge Branch" }).first();
      await run.waitFor({ timeout: 20_000 });
      // The queue read has answered "unset" (not merely not read yet) before Merge Branch counts.
      await until("the queue read", () => o.calls.some((c) => c.verb === "merge.status"));
      assert.equal(await page.getByRole("button", { name: "Land sova/project-verbs" }).count(), 0);
      await run.click();
      await until("the run's Merge Branch", () => o.calls.some((c) => c.verb === "runtime.merge"));
      const cart = page.locator(".project-worktree", { hasText: "Fix the cart" });
      await cart.getByRole("button", { name: /^Actions · / }).click();
      await page.getByRole("menuitem", { name: "Merge Branch: sova/fix-cart into master" }).click();
      await until("the row's Merge Branch", () => o.calls.some((c) => c.verb === "worktrees.merge"));
      assert.equal(o.calls.filter((c) => c.verb === "merge.add").length, 0);
      await shot(page, `${width}-project-rows-unset`);
      await o.ctx.close();
    });

    test("the chat's queue cards: one per branch, Landed like the Merged card, its approval folded above", async () => {
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`, { rows: READY_ROWS, cards: CARDS, items: CHAT_ITEMS });
      const { page } = o;
      const landed = page.locator('.mq-chat-card[data-branch="feat/settle-cpu"]').last();
      await landed.waitFor({ timeout: 20_000 });
      // Seven branches, seven whole cards; the two approvals that moved on are folded lines.
      await until("seven cards", async () => (await page.locator(".transcript-card > .mq-chat-card").count()) === 7);
      const folded = page.locator(".mq-card-folded");
      assert.equal(await folded.count(), 2);
      assert.deepEqual(await folded.locator(".disclosure-label").allTextContents(), ["feat/settle-cpu · Queued 1st", "fix/conflict-chip · Queued 2nd"]);
      // The Landed card: the Merged card's head, its numbers and time, its notes, why it wasn't pushed, and Land Again.
      const t = await words(landed);
      assert.match(t, /Landed/);
      assert.match(t, /feat\/settle-cpu into master/);
      assert.match(t, /4444444/);
      assert.match(t, /8 commits · \+970 −45 · /);
      assert.match(t, /Merge thread: Changes server code; restart Sova to pick it up\./);
      assert.match(t, /Flaky: server\/a\.test\.ts failed, then passed on a rerun/);
      assert.match(t, /Push held: private names not set up yet\./);
      assert.doesNotMatch(t, /Not pushed: Push held/i, "the push reason is said once");
      assert.match(t, /1 newer commit not included/);
      assert.equal(await landed.getByRole("button", { name: "Review Changes from feat/settle-cpu" }).count(), 1);
      assert.equal(await landed.getByRole("button", { name: "Land Again feat/settle-cpu" }).count(), 1);
      assert.equal(await landed.locator(".chip-success").count(), 1, "the LANDED pill");
      // The head reads as the Merged card's: pill and title on one line; at desktop width Review Changes ends it.
      const box = async (sel: string) => (await landed.locator(sel).first().boundingBox())!;
      const pill = await box(".chip");
      const title = await box(".worktree-merge-title");
      assert.ok(Math.abs(pill.y + pill.height / 2 - (title.y + title.height / 2)) < 8, "pill and title share a line");
      if (width >= 768) {
        const review = await box(".worktree-merge-review");
        assert.ok(review.x > title.x + title.width, "Review Changes at the head's end");
        assert.ok(Math.abs(review.y + review.height / 2 - (title.y + title.height / 2)) < 12, "on the head's line");
      }
      // Where each copy stands: the folded approval right after "land it", the landed card after the last reply.
      const order = await page.evaluate(() => {
        const at = (sel: string) => [...document.querySelectorAll(".thread *")].findIndex((n) => n.matches(sel));
        return { fold: at('.mq-card-folded[data-branch="feat/settle-cpu"]'), u2: at('[aria-label^="You"]:not(:first-of-type)'), card: at('.transcript-card > .mq-chat-card[data-branch="feat/settle-cpu"]') };
      });
      assert.ok(order.fold >= 0 && order.card > order.fold, `the newest copy is below the folded one: ${JSON.stringify(order)}`);
      // Opening a folded copy shows the card read-only: no actions on an earlier copy.
      await folded.first().locator("summary").click();
      assert.equal(await folded.first().getByRole("button", { name: /^Land Again/ }).count(), 0);
      // Live cards: the steps while checking, the estimate while queued.
      assert.match(await words(page.locator('.transcript-card > .mq-chat-card[data-branch="fix/worker-restore"]')), /Checking · 4 of 7 steps/);
      assert.match(await words(page.locator('.transcript-card > .mq-chat-card[data-branch="feat/pending-chip"]')), /Queued · 2nd.*starts in ~6 min · takes ~9 min/);
      // Needs a fix: the failing check with its log, its test, and the merge thread's later explanation on the same card.
      const fix = page.locator('.transcript-card > .mq-chat-card[data-branch="fix/draft-autosave-race"]');
      const ft = await words(fix);
      assert.match(ft, /Unit tests · 1 failed/);
      assert.match(ft, /src\/lib\/drafts\.test\.ts › saves a draft once/);
      assert.match(ft, /Merge thread: The autosave timer now fires twice when the tab regains focus\./);
      assert.equal(await fix.getByRole("link", { name: "Log of Unit tests" }).getAttribute("href"), `#/projects/${PID}/merge-queue/mr_fail`);
      await noSideScroll(page);
      await noRestartOrLive(page, ".thread");
      await shot(page, `${width}-chat-cards`);
      await landed.screenshot({ path: process.env.MQ_UI_SHOTS ? join(process.env.MQ_UI_SHOTS, `${width}-landed-card.png`) : join(dist, `${width}-landed-card.png`) });
      await o.ctx.close();
    });

    test("the chat's waiting cards act on the queue and post nothing into the chat", async () => {
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`, { rows: READY_ROWS, cards: CARDS, items: CHAT_ITEMS });
      const { page } = o;
      const card = (b: string) => page.locator(`.transcript-card > .mq-chat-card[data-branch="${b}"]`);
      await card("fix/conflict-chip").waitFor({ timeout: 20_000 });
      const before = o.frames.length;
      assert.match(await words(card("fix/conflict-chip")), /Master retries the save twice\..*The branch never retries\..*Keep master's retry\./);
      await card("fix/conflict-chip").getByRole("button", { name: "Accept fix/conflict-chip" }).click();
      await until("accept", () => o.calls.some((c) => c.verb === "merge.answer" && c.body.entry === "me_b" && c.body.answer === "accept"));
      assert.equal(await page.getByRole("button", { name: /^Send Back/ }).count(), 0, "no Send Back on any card");
      // Back with the chat, in place: the try and its reason, the chat's answer, Remove from Queue only.
      const bt = await words(card("feat/save-hint"));
      assert.match(bt, /Back with the chat/);
      assert.match(bt, /try 2 of 3 · Unit tests failed/);
      assert.match(bt, /Chat: Can't: the test needs a network/);
      assert.deepEqual(await card("feat/save-hint").locator(".mq-card-actions button").allInnerTexts(), ["Remove from Queue"]);
      // A decision: the question, its choices, the queue's note held "not sent yet"; no text box on the card.
      const dt = await words(card("feat/hack"));
      assert.match(dt, /Needs you/);
      assert.match(dt, /Keep the Save button at the top, or move it under the form\?/);
      assert.match(dt, /Merge queue: Place the Save button where the user says, then answer Fixed\./);
      assert.match(dt, /Not sent yet your answer goes with it/);
      assert.equal(await card("feat/hack").locator("textarea, input").count(), 0, "no text box in a card");
      // The message box says it waits for the user's answer.
      assert.match(await words(page.locator(".mq-held-line").first()), /Merge queue · feat\/hack · not sent yet: your answer goes with it/);
      await card("feat/pending-chip").getByRole("button", { name: "Remove from Queue feat/pending-chip" }).click();
      await until("cancel", () => o.calls.some((c) => c.verb === "merge.cancel" && c.body.entry === "me_e"));
      await card("feat/settle-cpu").getByRole("button", { name: "Land Again feat/settle-cpu" }).click();
      await until("land again", () => o.calls.some((c) => c.verb === "merge.add" && c.body.branch === "feat/settle-cpu"));
      assert.deepEqual(lastCall(o, "merge.add").body, { project: ROOT_DIR, branch: "feat/settle-cpu", commit: sha("5") }, "Land Again pins the head the card showed");
      // Nothing went into the chat: no prompt, steer or follow-up frame, and the composer is untouched.
      const sent = o.frames.slice(before).filter((f) => POSTS.test(f));
      assert.deepEqual(sent, [], "a queue button posted to the chat");
      assert.equal(await page.locator("textarea[id$='composer-input']").first().inputValue(), "");
      // A choice fills the message box, and nothing is sent until the user sends.
      await card("feat/hack").getByRole("button", { name: "Move it under the form" }).click();
      await until("the choice in the message box", async () => (await page.locator("textarea[id$='composer-input']").first().inputValue()) === "Move it under the form");
      assert.deepEqual(o.frames.slice(before).filter((f) => POSTS.test(f)), [], "a choice sends nothing");
      // Sent: the user's own message, naming the decision whose held note goes with it.
      await page.locator("textarea[id$='composer-input']").first().press("Enter");
      await until("the answer sent with its decision", () => o.frames.slice(before).some((f) => POSTS.test(f) && f.includes('"decision":"dc_1"') && f.includes("Move it under the form")));
      await shot(page, `${width}-chat-waiting-card`);
      await o.ctx.close();
    });

    test("an extension's message reads as the extension's: its name, no link, no hop, never yours (§app.extensions/name-badge)", async () => {
      const items = [
        ...CHAT_ITEMS,
        { id: "u3", kind: "user", text: '[from session "Alpha Bot" (ext:alpha), hop 0]\nThe build failed.', at: iso(1) },
        { id: "mark-u3", kind: "info", at: iso(1), sessionMark: { kind: "sent", targetId: "u3", from: { sessionId: "ext:alpha", title: "Alpha Bot" }, hop: 0 } },
      ];
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`, { items });
      const { page } = o;
      const row = page.locator(".message-from-session").last();
      await row.waitFor({ timeout: 20_000 });
      const t = await words(row);
      assert.match(t, /From an extension/);
      assert.match(t, /The build failed\./);
      assert.doesNotMatch(t, /from session/, "the header line is the model's");
      const sender = page.locator(".session-sender").last();
      assert.match(await words(sender), /From Alpha Bot/);
      assert.doesNotMatch(await words(sender), /hop/);
      assert.equal(await sender.locator("a").count(), 0, "no session to link to");
      await o.ctx.close();
    });

    test("two decisions in one chat: a choice on the older one is sent as its answer, not the newest's", async () => {
      const older = mc("me_o", "feat/older", { state: "needs-user", decision: { ...DECISION, id: "dc_old", at: iso(10), question: "Older question?", choices: ["Older choice"] }, revisions: [{ id: "me_o:1", kind: "needs-fix", at: iso(10), after: "a2", state: "needs-user" }] });
      const newer = mc("me_n", "feat/newer", { state: "needs-user", decision: { ...DECISION, id: "dc_new", at: iso(2), question: "Newer question?", choices: ["Newer choice"] }, revisions: [{ id: "me_n:1", kind: "needs-fix", at: iso(2), after: "a2", state: "needs-user" }] });
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`, { rows: READY_ROWS, cards: [older, newer], items: CHAT_ITEMS });
      const { page } = o;
      const line = page.locator(".mq-held-line");
      await line.waitFor({ timeout: 20_000 });
      assert.match(await words(line), /feat\/newer/, "typed alone: the newest");
      await page.locator('.mq-chat-card[data-branch="feat/older"]').getByRole("button", { name: "Older choice" }).click();
      await until("the line names the picked one", async () => /feat\/older/.test(await words(line)));
      await page.locator("textarea[id$='composer-input']").first().press("Enter");
      await until("sent as the older decision's answer", () => o.frames.some((f) => POSTS.test(f) && f.includes('"decision":"dc_old"') && f.includes("Older choice")));
      assert.ok(!o.frames.some((f) => POSTS.test(f) && f.includes('"decision":"dc_new"')));
      await o.ctx.close();
    });

    test("a decision's answer: your words in your bubble, the queue's held note folded under them, never yours", async () => {
      const text = formatHeldNote("Move it under the form, please.", { request: "rq_0123456789ab", branch: "feat/hack", text: "Place the Save button where the user says, then answer Fixed." });
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`, { items: [...CHAT_ITEMS, { id: "u3", kind: "user", text, at: iso(1) }] });
      const { page } = o;
      const fold = page.locator(".mq-held-sent");
      await fold.waitFor({ timeout: 20_000 });
      const bubble = page.locator(".message-user", { has: fold });
      assert.equal(await bubble.locator(".message-body").first().innerText(), "Move it under the form, please.");
      assert.match(await words(fold.locator("summary")), /Merge queue · feat\/hack · sent with your answer/);
      assert.equal(await fold.evaluate((d) => (d as HTMLDetailsElement).open), false, "folded");
      await fold.locator("summary").click();
      assert.match(await words(fold), /Place the Save button where the user says, then answer Fixed\./);
      assert.doesNotMatch(await words(bubble.locator(".message-body").first()), /held note/);
      await o.ctx.close();
    });

    test("a turn the merge queue started reads as the queue's, not yours", async () => {
      // Sent with the "another session" marker named merge-queue, as the queue sends it: still the queue's row.
      const items = [
        ...CHAT_ITEMS,
        { id: "u3", kind: "user", text: "[merge-queue] fix/draft-autosave-race needs a fix: Unit tests fail with this branch.", at: iso(1) },
        { id: "mark-u3", kind: "info", at: iso(1), sessionMark: { kind: "sent", targetId: "u3", from: { sessionId: "merge-queue", title: "Merge queue" }, hop: 0 } },
      ];
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`, { items });
      const { page } = o;
      const row = page.locator("[data-from-queue]");
      await row.waitFor({ timeout: 20_000 });
      const t = await words(row);
      assert.match(t, /Merge queue/);
      assert.doesNotMatch(t, /\[merge-queue\]/);
      assert.equal(await page.locator('a[href*="merge-queue"]', { hasText: "Merge queue" }).count(), 0, "never a link to a session called merge-queue");
      assert.equal(await page.getByText("From a session").count(), 0);
      assert.match(t, /fix\/draft-autosave-race needs a fix/);
      // The composer's Inputs counts only what you typed: 2, not the queue's turn.
      const inputs = page.locator(".run-status-inputs");
      await inputs.waitFor({ timeout: 10_000 });
      assert.match(await words(inputs), /^2 inputs/);
      await o.ctx.close();
    });

    test("an invalid .sova/project.json: its error, never the onboarding; one banner for its pause; rows and the run keep Land", async () => {
      const bad = '$.merge.checks[0].run[2]: a lone "$"';
      const why = `The project's .sova/project.json is invalid: ${bad}. Fix it on the target; nothing lands until it parses`;
      const view = viewOf({ checks: "unset", invalid: bad, state: "paused", paused: { kind: "definition-invalid", why, at: iso(1) }, current: undefined, checking: [] });
      const o = await open(width, `#/projects/${PID}/merge-queue`, { view });
      const { page } = o;
      const tab = page.locator(".mq-tab");
      await tab.getByText("This project's .sova/project.json doesn't parse.").waitFor({ timeout: 20_000 });
      const t = await words(tab);
      assert.match(t, /Definition invalid/);
      assert.ok(t.includes(bad), "the parser's path and message");
      assert.equal(t.split("doesn't parse").length - 1, 1, "said once, not in the title and again in the body");
      assert.match(t, /Fix it on master, or land a branch that fixes it; nothing else lands until it parses\./);
      assert.doesNotMatch(t, /Not set up|Before the queue can land anything here/);
      assert.equal(await page.getByRole("button", { name: /^Try It on/ }).count(), 0);
      assert.equal(await tab.locator(".banner").count(), 1, "the pause isn't said twice");
      assert.match(t, /Waiting · 2/, "what's in line still shows");
      await noSideScroll(page);
      await noRestartOrLive(page, ".mq-tab");
      await shot(page, `${width}-definition-invalid`);
      // The project page: every merge goes through the queue (it takes a branch that fixes the file), so it says Land.
      await page.goto(`${ORIGIN}/#/projects/${PID}`);
      await page.getByRole("button", { name: "Land sova/project-verbs" }).first().waitFor({ timeout: 20_000 });
      const cart = page.locator(".project-worktree", { hasText: "Fix the cart" });
      await cart.getByRole("button", { name: /^Actions · / }).click();
      await page.getByRole("menuitem", { name: "Land sova/fix-cart on master" }).waitFor();
      assert.equal(await page.getByRole("menuitem", { name: /^Merge Branch/ }).count(), 0);
      await page.keyboard.press("Escape");
      await o.ctx.close();
    });

    test("can't tell whose failure: in the modal, the tab's needs-you, the run page and the chat card, with Land Anyway / Try Again posting nothing", async () => {
      const qe = entry({ id: "me_u", branch: "feat/slow-build", state: "unattributed", run: "mr_unclear", reason: UNCLEAR_WHY, unclear: UNCLEAR });
      const view = viewOf({ needsYou: [qe] });
      const row = wt("feat/slow-build", { queue: qi({ id: "me_u", state: "unattributed", run: "mr_unclear", reason: UNCLEAR_WHY, unclear: UNCLEAR }) });
      const card = mc("me_u", "feat/slow-build", {
        state: "unattributed",
        run: "mr_unclear",
        reason: UNCLEAR_WHY,
        unclear: UNCLEAR,
        revisions: [{ id: "me_u:1", kind: "unattributed", at: iso(2), after: "a2", state: "unattributed", run: "mr_unclear" }],
      });
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`, { rows: [row], view, cards: [card], items: CHAT_ITEMS });
      const { page } = o;
      const expectWhy = async (t: string) => {
        assert.match(t, /Build failed with this branch and on master alone, and names no tests\./);
        assert.match(t, /Build: fails with this branch and on master alone, naming no tests/);
      };
      // The chat card: its pill, the why, the check, and the two answers.
      const c = page.locator('.mq-chat-card[data-branch="feat/slow-build"]');
      await c.waitFor({ timeout: 20_000 });
      const ct = await words(c);
      assert.match(ct, /Can't tell whose failure/);
      await expectWhy(ct);
      assert.equal(await c.getByRole("link", { name: "Log of Build" }).getAttribute("href"), `#/projects/${PID}/merge-queue/mr_unclear`);
      await c.getByRole("button", { name: /Land Anyway/ }).click();
      await until("land anyway from the card", () => o.calls.some((x) => x.verb === "merge.answer" && x.body.answer === "land-anyway" && x.body.entry === "me_u"));
      await noRestartOrLive(page, '.mq-chat-card[data-branch="feat/slow-build"]');
      await shot(page, `${width}-unclear-card`);
      // The composer control counts it as needing you; the modal draws it with its two answers.
      const control = page.getByRole("button", { name: /^Worktrees: / });
      assert.match(await words(control), /1 needs you/);
      await control.click();
      const modal = page.getByRole("dialog", { name: "Worktrees" });
      await modal.waitFor();
      const mt = await words(modal);
      assert.match(mt, /Can't tell whose failure/);
      assert.match(mt, /1 can't tell whose failure/);
      await expectWhy(mt);
      await modal.getByRole("button", { name: "Try feat/slow-build again" }).click();
      await until("try again from the modal", () => o.calls.some((x) => x.verb === "merge.answer" && x.body.answer === "try-again" && x.body.entry === "me_u"));
      await noRestartOrLive(page, ".wt-queue-modal");
      await shot(page, `${width}-unclear-modal`);
      await page.keyboard.press("Escape");
      assert.equal(o.frames.filter((f) => POSTS.test(f)).length, 0, "nothing posted to the chat");
      // The tab's needs-you row, on the Needs you tab's own address.
      await page.goto(`${ORIGIN}/#/projects/${PID}/merge-queue/needs-you`);
      const needs = page.locator('.mq-needs[data-branch="feat/slow-build"]');
      await needs.waitFor({ timeout: 20_000 });
      const nt = await words(needs);
      assert.match(nt, /Can't tell whose failure · waiting for you/);
      await expectWhy(nt);
      await needs.getByRole("button", { name: "Land feat/slow-build anyway" }).click();
      await until("land anyway from the tab", () => o.calls.filter((x) => x.verb === "merge.answer" && x.body.answer === "land-anyway").length >= 2);
      assert.equal(await needs.getByRole("button", { name: /^Accept/ }).count(), 0);
      await noRestartOrLive(page, ".mq-tab");
      await noSideScroll(page);
      // The run page: the banner, the check and the two answers.
      await page.goto(`${ORIGIN}/#/projects/${PID}/merge-queue/mr_unclear`);
      const ban = page.locator(".mq-unattributed");
      await ban.waitFor({ timeout: 20_000 });
      const bt = await words(ban);
      assert.match(bt, /Can't tell whose failure\. Nothing landed; master didn't move\./);
      assert.match(await words(page.locator(".mq-run .cluster").first()), /Can't tell whose failure · waiting for you/);
      assert.equal(await page.getByText("Nothing has merged from this run.").count(), 0, "the banner says it, once");
      await expectWhy(bt);
      await ban.getByRole("button", { name: "Try feat/slow-build again" }).click();
      await until("try again from the run page", () => o.calls.filter((x) => x.verb === "merge.answer" && x.body.answer === "try-again").length >= 2);
      await ban.getByRole("button", { name: "Remove feat/slow-build from the merge queue" }).click();
      await until("remove from the run page", () => o.calls.some((x) => x.verb === "merge.cancel" && x.body.entry === "me_u"));
      await noRestartOrLive(page, ".mq-run");
      await noSideScroll(page);
      await shot(page, `${width}-unclear-run`);
      await o.ctx.close();
    });

    test("the strip says master is ahead of origin: Save Checks' reason, or none given", async () => {
      for (const heads of [
        { target: sha("4"), pushed: sha("1"), pushWhy: "not pushed yet: goes out with the next landing" },
        { target: sha("4"), pushed: sha("1") },
      ]) {
        const o = await open(width, `#/projects/${PID}/merge-queue`, { view: viewOf({ heads }) });
        const strip = o.page.getByRole("group", { name: "master and origin" });
        await strip.waitFor({ timeout: 20_000 });
        const t = await words(strip);
        assert.match(t, /4444444/);
        assert.match(t, /1111111/);
        assert.match(t, /Not pushed/);
        assert.match(t, /Not pushed yet: goes out with the next landing\./);
        assert.doesNotMatch(t, /Pushed(?! to origin)/, "never Pushed while ahead");
        await noSideScroll(o.page);
        await shot(o.page, `${width}-push-waits${heads.pushWhy ? "" : "-noreason"}`);
        await o.ctx.close();
      }
    });

    test("the strip says why master isn't pushed (heads.pushWhy)", async () => {
      const o = await open(width, `#/projects/${PID}/merge-queue`, { view: viewOf({ heads: { target: sha("4"), pushed: sha("1"), pushWhy: "push held: private names not set up yet" } }) });
      const strip = o.page.getByRole("group", { name: "master and origin" });
      await strip.waitFor({ timeout: 20_000 });
      const t = await words(strip);
      assert.match(t, /4444444/);
      assert.match(t, /Not pushed/);
      assert.match(t, /Push held: private names not set up yet\./);
      await shot(o.page, `${width}-push-held`);
      await o.ctx.close();
    });

    test("a project that lands on GitHub: Waiting on GitHub with its requests; a check broken on master heads Needs you and counts", async () => {
      const req = entry({ id: "me_h", branch: "feat/on-github", state: "requested", request: { how: "github-pr", host: "github", branch: "feat/on-github", base: "master", number: 12, url: "https://github.com/example/app/pull/12" } });
      const broken = { check: "unit", label: "Unit tests", why: "Unit tests is broken on master: no test ran (cannot find module)", run: "mr_broke", step: "check:unit", at: iso(5) };
      const view = viewOf({ settings: { landing: { target: "master", push: true, names: { setUp: true, count: 0 } }, checks: { mode: "declared", list: [] }, review: { on: false }, how: { effective: "github-pr", from: "project" } } as unknown as MergeQueueView["settings"], waitingOnHost: [req], heads: { target: sha("1"), pushed: sha("1"), targetBroken: [broken] } });
      const o = await open(width, `#/projects/${PID}/merge-queue/waiting-on-host`, { view });
      const { page } = o;
      const strip = page.getByRole("tablist", { name: "Merge queue" });
      await strip.waitFor({ timeout: 20_000 });
      assert.deepEqual(await strip.getByRole("tab").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label"))), ["Ready to land · 1", "Needs you · 3", "With its chat · 1", "Waiting on GitHub · 1", "Landed", "Queue chats · 0"]);
      assert.equal(await strip.getByRole("tab", { selected: true }).getAttribute("aria-label"), "Waiting on GitHub · 1");
      const panel = page.getByRole("tabpanel");
      await panel.locator('li[data-branch="feat/on-github"]').waitFor({ timeout: 20_000 });
      assert.doesNotMatch(await words(page.locator(".mq-tab")), /Waiting on the host/, "the tab names the host; no section heading of its own");
      // An address naming a tab moves nothing up or down: only the strip scrolls, sideways, to the tab shown.
      assert.deepEqual(await strip.evaluate((el) => { const moved: string[] = []; for (let n = el.parentElement; n; n = n.parentElement) if (n.scrollTop) moved.push(`${n.className}: ${n.scrollTop}`); return moved; }), [], "no page scroll");
      const shownBox = await box(strip.getByRole("tab", { selected: true }));
      const stripBox = await box(strip);
      assert.ok(shownBox.x >= stripBox.x - 1 && shownBox.x + shownBox.width <= stripBox.x + stripBox.width + 1, "the tab shown is in the strip's view");
      // The broken check first, apart from the entries, with View the Log on its run (opened from Needs you).
      await showTab(page, "Needs you");
      const rows = panel.locator(":scope > ul > li");
      assert.equal(await rows.first().getAttribute("data-state"), "target-broken");
      assert.match(await words(rows.first()), /Broken on master/);
      assert.equal(await rows.first().getByRole("link", { name: "View the log of Unit tests on master" }).getAttribute("href"), `#/projects/${PID}/merge-queue/needs-you/mr_broke`);
      await noSideScroll(page);
      await shot(page, `${width}-queue-host`);
      await o.ctx.close();
      // A local project's address for that tab shows Ready to land.
      const l = await open(width, `#/projects/${PID}/merge-queue/waiting-on-host`);
      const ls = l.page.getByRole("tablist", { name: "Merge queue" });
      await ls.waitFor({ timeout: 20_000 });
      assert.equal(await ls.getByRole("tab", { selected: true }).getAttribute("aria-label"), "Ready to land · 1");
      assert.equal(await ls.getByRole("tab", { name: /Waiting on/ }).count(), 0);
      await l.ctx.close();
    });

    test("an empty queue: Waiting is a plain line; each empty tab says the live fact first; a typed …/ready opens Ready to land", async () => {
      const view = viewOf({ current: undefined, checking: [], waiting: [], needsYou: [], needsFix: [], recent: [], ready: [] });
      const o = await open(width, `#/projects/${PID}/merge-queue/ready`, { view });
      const { page } = o;
      const tab = page.locator(".mq-tab");
      const strip = tab.getByRole("tablist", { name: "Merge queue" });
      await strip.waitFor({ timeout: 20_000 });
      // `…/ready` is Ready to land, put back as its one address with no history entry.
      assert.equal(await strip.getByRole("tab", { selected: true }).getAttribute("aria-label"), "Ready to land · 0");
      await until("the bare address", async () => (await hashOf(page)) === `#/projects/${PID}/merge-queue`);
      // Nothing in line: a plain line, no toggle, and nothing that repeats Checking now's line.
      assert.equal(await tab.getByRole("button", { name: /^Waiting/ }).count(), 0, "no Waiting toggle");
      assert.equal((await words(tab.locator(".mq-waiting-head"))).trim(), "Waiting · 0");
      assert.equal(await tab.getByText(/A branch joins when you press Land/).count(), 0);
      const panel = tab.locator(".mq-tabpanel");
      for (const [label, line] of [
        ["Ready to land", "The queue is idle. Nothing is ready to land."],
        ["Needs you", "The queue is idle. Nothing needs you."],
        ["With its chat", "The queue is idle. Nothing is with its chat."],
        ["Landed", "The queue is idle. Nothing has landed through the queue yet."],
        ["Queue chats", "The queue is idle. No queue chat yet."],
      ] as const) {
        if (label !== "Ready to land") await showTab(page, label);
        assert.equal((await words(panel)).trim(), line, label);
        assert.equal(await panel.getAttribute("tabindex"), "0", `${label}: its panel takes focus`);
      }
      await shot(page, `${width}-queue-empty`);
      await o.ctx.close();
    });

    test("paused: the banner says why, and Resume resumes", async () => {
      const o = await open(width, `#/projects/${PID}/merge-queue`, { view: viewOf({ state: "paused", current: undefined, paused: { kind: "master-moved", why: "master moved to 9f9f9f9 outside the queue; the run was voided.", at: iso(1) } }) });
      const { page } = o;
      const banner = page.locator(".mq-tab .banner");
      await banner.waitFor({ timeout: 20_000 });
      assert.match(await words(banner), /Paused: the target moved outside the queue\./);
      assert.match(await words(banner), /Master moved to 9f9f9f9 outside the queue; the run was voided\./);
      await banner.getByRole("button", { name: "Resume" }).click();
      await called(o, "merge.resume");
      await noRestartOrLive(page, ".mq-tab");
      await shot(page, `${width}-paused`);
      await o.ctx.close();
    });

    test("the run page: every step with its source, why, time and log; View Logs; whose failure", async () => {
      const o = await open(width, `#/projects/${PID}/merge-queue/mr_now`);
      const { page } = o;
      const steps = page.locator(".mq-steps");
      await steps.waitFor({ timeout: 20_000 });
      const text = await words(page.locator(".mq-run"));
      for (const s of ["Merge copy", "Setup", "Typecheck", "Unit tests", "Statecharts", "Integration", "Spec replay"]) assert.match(text, new RegExp(s), s);
      assert.match(text, /Required/);
      assert.match(text, /Triggered/);
      assert.match(text, /Added by merge thread/);
      assert.match(text, /The branch changes statecharts\/merge\.ts\./);
      assert.match(text, /skipped: no change to its paths/);
      assert.match(text, /Nothing has merged from this run\./);
      // Back to Queue is the arrow before the page's path; the actions are View Logs and Open Merge Thread, one line.
      const back = page.locator(".mq-crumbs").getByRole("link", { name: "Back to Queue" });
      assert.equal(await back.getAttribute("href"), `#/projects/${PID}/merge-queue`);
      assert.equal(await page.locator(".mq-run-actions").getByRole("link", { name: "Back to Queue" }).count(), 0);
      const acts = await page.locator(".mq-run-actions").evaluate((row) => [...row.children].map((c) => c.getBoundingClientRect().top));
      assert.ok(acts.every((t) => Math.abs(t - acts[0]!) < 1), `the run's actions on one line (${acts})`);
      // A tag stays on its step name's line, held to its last word: it drops under only when that word and it
      // can't share a line of the name's column at all (a long tag at phone width).
      const tagLines = await page.locator(".mq-run-steps .mq-step-tail").evaluateAll((tails) =>
        tails.map((t) => {
          const chip = t.querySelector(".chip")!.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(t.firstChild!);
          const word = range.getBoundingClientRect();
          const room = t.closest(".mq-step-name")!.getBoundingClientRect().width;
          const gap = parseFloat(getComputedStyle(t).columnGap) || 0;
          return { word: word.top + word.height / 2, chip: chip.top + chip.height / 2, fits: word.width + gap + chip.width <= room, w: t.textContent };
        }),
      );
      assert.ok(tagLines.some((l) => l.fits), "tagged steps found");
      for (const l of tagLines) if (l.fits) assert.ok(Math.abs(l.word - l.chip) < 6, `${l.w}: its tag on its name's last line`);
      await page.getByRole("button", { name: "Show the log of Setup" }).click();
      await until("the setup log", async () => /log of setup/.test(await words(page.locator(".mq-steps"))));
      assert.equal(lastCall(o, "merge.logs").body.step, "setup");
      await page.getByRole("button", { name: "View Logs" }).click();
      await until("every log", async () => /log of every step/.test(await words(page.locator(".mq-run"))));
      await noRestartOrLive(page, ".mq-run");
      await noSideScroll(page);
      await shot(page, `${width}-run`);
      await o.ctx.close();

      const f = await open(width, `#/projects/${PID}/merge-queue/mr_fail`);
      await f.page.getByRole("group", { name: "Whose failure is it?" }).waitFor({ timeout: 20_000 });
      const ft = await words(f.page.locator(".mq-run"));
      assert.match(ft, /broke Unit tests\. It didn't land; master didn't move\./);
      assert.match(ft, /No: it passes on the target/);
      assert.match(ft, /saves a draft once/);
      await noRestartOrLive(f.page, ".mq-run");
      await shot(f.page, `${width}-run-failed`);
      await f.ctx.close();
    });

    test("not set up: what the queue does and Set Up with a Chat, never the old form; the Setup chat's proposal offers Run Trial until a trial of its head passed, then Merge Branch", async () => {
      let status: SetupStatus = NO_SETUP;
      const o = await open(width, `#/projects/${PID}/merge-queue`, { view: viewOf({ checks: "unset", served: false, state: "idle", current: undefined, waiting: [], needsYou: [], needsFix: [], recent: [] }), setup: () => status });
      const { page } = o;
      await page.getByText("No merge queue settings are set up for this project").waitFor({ timeout: 20_000 });
      assert.match(await words(page.locator(".mq-tab")), /Every branch you approve is merged onto master in a separate copy and checked there; master then moves to exactly that commit\. Once it is set up, branches land here only through the queue\./);
      for (const gone of ["Initialize", "Try It on Master", "Save Checks", "Try the Merge Copy"]) assert.equal(await page.getByRole("button", { name: gone }).count(), 0, `no ${gone}`);
      assert.equal(await page.getByRole("textbox", { name: "Command" }).count(), 0, "no check form");
      // Set Up with a Chat opens the project's Setup chat and goes to it.
      await page.getByRole("button", { name: "Set Up with a Chat", exact: true }).click();
      await until("the setup chat opened", () => o.calls.some((c) => c.verb === "setup.open"));
      assert.equal(lastCall(o, "setup.open").body.from, "merge-queue");
      assert.equal(lastCall(o, "setup.open").body.fresh, undefined);
      await until("on its chat", async () => (await hashOf(page)).includes(encodeURIComponent(SESSION.path)));
      assert.equal(o.calls.filter((c) => c.verb === "merge.setup").length, 0, "the page never calls merge.setup");
      // The chat proposes: no trial of its head yet, so Run Trial, not Merge Branch.
      status = setupProposed(null);
      await page.goto(`${ORIGIN}/#/projects/${PID}/merge-queue`);
      const card = page.getByRole("group", { name: "Setup proposal" });
      await card.waitFor({ timeout: 20_000 });
      assert.equal(await card.getByRole("button", { name: /^(Merge Branch|Land) / }).count(), 0, "no Merge Branch before a passing trial");
      assert.match(await words(card), /Run a trial of 5e7c0de first: it lands only once its own checks pass\./);
      await card.getByRole("button", { name: `Run Trial of ${SETUP_BRANCH}` }).click();
      await until("a trial", () => o.calls.some((c) => c.verb === "merge.try"));
      assert.deepEqual({ branch: lastCall(o, "merge.try").body.branch, commit: lastCall(o, "merge.try").body.commit }, { branch: SETUP_BRANCH, commit: SETUP_HEAD });
      // The trial of that head passed: Merge Branch, pinned to the head and the proposal's hash.
      status = setupProposed("passed");
      await page.reload();
      await card.waitFor({ timeout: 20_000 });
      assert.match(await words(card), /Trial of 5e7c0de: passed/);
      assert.match(await words(card), /Changes 2 files against master; 1 outside the setup, which Merge Branch brings in too\./);
      assert.equal(await card.getByText("Outside the setup", { exact: true }).count(), 1, "one file marked outside the setup");
      await card.getByRole("button", { name: `Merge Branch ${SETUP_BRANCH}` }).click();
      await until("Merge Branch", () => o.calls.some((c) => c.verb === "setup.merge"));
      assert.deepEqual(lastCall(o, "setup.merge").body, { hash: "sha256:setup", commit: SETUP_HEAD });
      assert.equal(o.calls.filter((c) => c.verb === "runtime.merge").length, 0, "the Setup proposal merges through /setup/merge");
      await page.getByText("Merged the setup into master.").first().waitFor();
      await shot(page, `${width}-setup-proposal`);
      await noSideScroll(page);
      await o.ctx.close();
    });

    test("Merge Queue rows: a tap opens the branch's chat; its buttons and the chat's name keep their own action; Review Changes opens over the tab", async () => {
      // The branch's chat reads it Ready to land (its readiness); the chip says what its chat reads.
      const codingB = { ...CODING_B, readiness: { trees: [{ path: "/w/.worktrees/sova-ready-one", branch: "feat/ready-one", state: "ready", landing: { state: "ready", commit: sha("9") } }], since: 0 } } as unknown as SessionSummary;
      const o = await open(width, `#/projects/${PID}/merge-queue`, { view: viewOf({ ready: READY }), sessions: [SESSION, CODING, codingB, ARCHIVED] });
      const { page } = o;
      const tab = page.locator(".mq-tab");
      const ready = tab.locator('[data-branch="feat/ready-one"]');
      await ready.waitFor({ timeout: 20_000 });
      const start = await hashOf(page);
      // The top line: the chat's title (a link), then the branch in small mono; no folder, no "Chat" label. The chip
      // first in the facts, with the commit and the numbers; the branch's bullets under them.
      const head = ready.locator(".mq-head-line");
      assert.match(await words(head), /^\s*Fix the badge\s*feat\/ready-one\s*$/);
      assert.equal((await words(ready.locator(".mq-branch"))).trim(), "feat/ready-one");
      assert.equal(await ready.locator(".mq-folder").count(), 0, "no worktree folder");
      assert.doesNotMatch(await words(ready), /\bChat\b/);
      const facts = ready.locator(".mq-facts");
      assert.equal((await words(facts.locator(":scope > *").first())).trim(), "Ready to land", "its chat's reading, not a fixed Ready");
      assert.match(await words(facts), /9999999\s*3 commits ahead · \+40 −2 · 2d ago/);
      // The date: relative, in full on hover and for a screen reader.
      const when = facts.locator("time");
      assert.equal(await when.getAttribute("datetime"), READY![0]!.headAt);
      assert.match((await when.getAttribute("title")) ?? "", /^[A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M$/);
      assert.match((await when.getAttribute("aria-label")) ?? "", /^last commit [A-Z][a-z]{2} \d/);
      // No chat: a neutral chip saying so; an archived chat with no reading: "No reading". No date read: none shown.
      const noChat = tab.locator('[data-branch="feat/no-chat"] .mq-facts');
      assert.equal((await words(noChat.locator(":scope > *").first())).trim(), "No chat");
      assert.equal(await noChat.locator("time").count(), 0);
      assert.equal((await words(tab.locator('[data-branch="feat/search-ab-with-a-much-longer-branch-name"] .mq-facts > *').first())).trim(), "No reading");
      const chat = ready.getByRole("link", { name: "Fix the badge" });
      assert.equal(await chat.getAttribute("href"), `#/s/${encodeURIComponent(CODING_B.path)}`);
      // Its bullets, under the facts, in order; the long one wraps, never scrolls sideways.
      const bullets = ready.locator(".mq-summary-bullets li");
      assert.equal(await bullets.count(), 2);
      assert.equal((await words(bullets.first())).trim(), "Shows what each branch does in a few plain bullets");
      const factsBox = await box(facts);
      assert.ok((await box(bullets.first())).y >= factsBox.y + factsBox.height - 1, "the bullets under the facts line");
      assert.equal(await ready.locator(".mq-summary [role=status]").count(), 0);
      // Writing: "Summarizing…", busy to a screen reader.
      const writing = tab.locator('[data-branch="feat/no-chat"] .mq-summary-line[aria-busy="true"]');
      assert.equal((await words(writing)).trim(), "Summarizing…");
      // An archived chat still opens, marked; no chat found says so and isn't a target.
      const archived = tab.locator('[data-branch="feat/search-ab-with-a-much-longer-branch-name"]');
      assert.match(await words(archived.locator(".mq-head-line")), /Old search\s*feat\/search-ab-with-a-much-longer-branch-name\s*archived/);
      // A failure: the line and Try Again (only then), over the earlier commit's bullets, marked.
      assert.match(await words(archived.locator(".mq-summary")), /Couldn't summarize this branch\.\s*Try Again\s*From an earlier commit\s*Searches the archive/);
      assert.equal(await ready.getByRole("button", { name: /Try summarizing/ }).count(), 0, "no rewrite on a summary that worked");
      await archived.getByRole("button", { name: "Try summarizing feat/search-ab-with-a-much-longer-branch-name again" }).click();
      await until("a retry", () => o.calls.some((c) => c.verb === "branch-summary.retry" && c.body.commit === sha("7") && c.body.branch === "feat/search-ab-with-a-much-longer-branch-name"));
      assert.equal(await hashOf(page), start, "Try Again doesn't open the chat");
      const none = tab.locator('[data-branch="feat/no-chat"]');
      assert.match(await words(none), /No chat found for this worktree/);
      assert.equal(await none.evaluate((el) => el.classList.contains("mq-tap")), false);
      await none.locator(".mq-facts").click();
      assert.equal(await hashOf(page), start, "a row with no chat opens nothing");
      // The queued rows' chat links open the chat by its route (they used to point where nothing resolved them).
      await openWaiting(page);
      const waitingChat = tab.locator('[data-branch="feat/pending-chip"] .mq-chat-link');
      assert.equal(await waitingChat.getAttribute("href"), `#/s/${encodeURIComponent(PATH)}`);
      assert.equal(await words(waitingChat), SESSION.title);

      // Review Changes: the viewer over the tab, on the queue's own comparison, with no chat named; Close gives focus back.
      const review = ready.getByRole("button", { name: "Review Changes on feat/ready-one" });
      await review.click();
      const viewer = page.locator(".changes-dialog");
      await viewer.waitFor();
      await until("the summary read", () => o.diffs.some((d) => d.kind === "summary"));
      const q = o.diffs.find((d) => d.kind === "summary")!.query;
      assert.deepEqual(Object.fromEntries(q), { kind: "queue", project: PID, branch: "feat/ready-one" });
      await until("the counts", async () => /1 uncommitted/.test(await words(viewer.locator(".changes-meta"))));
      assert.equal(await viewer.locator(".changes-uncommitted").count(), 1, "the uncommitted file is marked");
      assert.equal(await hashOf(page), start, "Review Changes doesn't open the chat");
      await shot(page, `${width}-queue-review`);
      await viewer.getByRole("button", { name: "Close" }).click();
      await until("the viewer closed", async () => (await viewer.count()) === 0);
      await until("focus back on Review Changes", () => review.evaluate((el) => el === document.activeElement));
      // Every row of the tab has it: checking and waiting above the tabs, then each tab's (ready, needs you, with its
      // chat, landed).
      const reviews = async (branches: string[]) => {
        for (const b of branches) assert.equal(await tab.getByRole("button", { name: `Review Changes on ${b}` }).count(), 1, b);
      };
      await reviews(["fix/worker-restore", "feat/pending-chip", "feat/replay-timeouts", "feat/ready-one", "feat/no-chat"]);
      await showTab(page, "Needs you");
      await reviews(["fix/conflict-chip", "feat/hack"]);
      await showTab(page, "With its chat");
      await reviews(["fix/draft-autosave-race"]);
      await showTab(page, "Landed");
      await reviews(["feat/composer-hints"]);
      await tab.getByRole("button", { name: "Review Changes on feat/composer-hints" }).click();
      await until("a landed row's read", () => o.diffs.some((d) => d.kind === "summary" && d.query.get("entry") === "me_l"));
      await page.keyboard.press("Escape");
      await until("the viewer closed", async () => (await viewer.count()) === 0);
      await showTab(page, "Ready to land");
      assert.equal(await hashOf(page), start, "back on Ready to land's address");

      // Land: its confirm, then queued, nothing opened; a tap on the confirm's words opens nothing either.
      await ready.getByRole("button", { name: "Land feat/ready-one", exact: true }).click();
      const readyAsk = ready.getByRole("group", { name: "Land feat/ready-one", exact: true });
      await readyAsk.locator(".wt-queue-confirm-line").click();
      assert.equal(await hashOf(page), start, "a tap on the confirm doesn't open the chat");
      await shot(page, `${width}-queue-land-confirm`);
      await rowActionsSized(ready, "the tab's confirm");
      await readyAsk.getByRole("button", { name: "Land 3 Commits" }).click();
      await until("a land", () => o.calls.some((c) => c.verb === "merge.add" && c.body.branch === "feat/ready-one"));
      assert.equal(await hashOf(page), start, "Land doesn't open the chat");

      // A phone: no sideways scroll; the actions on their own line, Review Changes left of Land, at Land's size.
      await noSideScroll(page);
      const r = await box(review);
      const land = await box(ready.getByRole("button", { name: "Land feat/ready-one", exact: true }));
      const chatLine = await box(ready.locator(".mq-summary"));
      // Unfolded: the actions a column at the row's top right, Review Changes over Land; folded, one line.
      // Land and its ▾ keep their own size: never taller than Review Changes, never stretched to its width.
      const split = await box(ready.locator(".wt-queue-split"));
      assert.ok(Math.abs(land.height - r.height) <= 0.5 && Math.abs(split.height - r.height) <= 0.5, `Land as tall as Review Changes (${land.height}, ${split.height}, ${r.height})`);
      await rowActionsSized(tab, "the tab's rows");
      if (width >= 768) {
        assert.ok(r.y < land.y && Math.abs(r.x + r.width - (split.x + split.width)) < 2, "Review Changes over Land, one column, right edges together");
        assert.ok(split.width < r.width - 8, `the split at its own width, not stretched (${split.width} vs ${r.width})`);
      } else assert.ok(r.x < land.x, "Review Changes before Land");
      if (width < 600) {
        assert.ok(r.y >= chatLine.y + chatLine.height - 1 && Math.abs(r.y - land.y) < 2, "the actions on their own line, together");
        const row = await box(ready);
        assert.ok(land.x + land.width > row.x + row.width - 64, "Land at the row's right");
        assert.ok(r.x < row.x + 24, "Review Changes at the row's left");
        // No outer card frame on a phone.
        assert.equal(await tab.evaluate((el) => getComputedStyle(el).borderTopWidth), "0px");
      }
      await shot(page, `${width}-queue-rows`);

      // A tap anywhere else on the row opens its chat; the chat's name is a real link to the same place.
      await ready.locator(".mq-facts").click();
      await until("the chat opened", async () => (await hashOf(page)) === `#/s/${encodeURIComponent(CODING_B.path)}`);
      await o.ctx.close();
    });

    test("the Worktrees modal: Review Changes on its rows, the viewer over the modal; Escape closes only the viewer", async () => {
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`);
      const { page } = o;
      await page.getByRole("button", { name: /^Worktrees: / }).click({ timeout: 20_000 });
      const modal = page.getByRole("dialog", { name: "Worktrees" });
      await modal.waitFor();
      // Every live row has it: ready, queued, uncommitted, needs a fix, waiting for you.
      for (const b of ["feat/composer-drafts", "fix/paste-images", "feat/draft-sync-tabs", "fix/draft-autosave-race", "fix/conflict-chip", "feat/hack"])
        assert.equal(await modal.getByRole("button", { name: `Review Changes on ${b}` }).count(), 1, b);
      const row = modal.locator('[data-branch="feat/composer-drafts"]');
      assert.equal(await row.locator(".wt-queue-path").count(), 0, "no worktree folder");
      const review = row.getByRole("button", { name: "Review Changes on feat/composer-drafts" });
      if (width < 600) {
        const r = await box(review);
        const land = await box(row.getByRole("button", { name: "Land feat/composer-drafts", exact: true }));
        assert.ok(Math.abs(r.height - land.height) <= 0.5, `Review Changes as tall as Land (${r.height}, ${land.height})`);
        assert.ok(r.x < land.x && Math.abs(r.y - land.y) < 2, "Review Changes left of Land on one line");
      }
      await shot(page, `${width}-modal-review-row`);
      await review.click();
      const viewer = page.locator(".changes-dialog");
      await viewer.waitFor();
      await until("the summary read", () => o.diffs.some((d) => d.kind === "summary"));
      const q = o.diffs.find((d) => d.kind === "summary")!.query;
      assert.equal(q.get("kind"), "worktree");
      assert.equal(q.get("session"), PATH);
      assert.equal(q.get("path"), "/w/.worktrees/sova-composer-drafts");
      assert.equal(q.get("uncommitted"), "1", "uncommitted files ride along");
      await shot(page, `${width}-modal-review`);
      await page.keyboard.press("Escape");
      await until("the viewer closed", async () => (await viewer.count()) === 0);
      assert.equal(await page.getByRole("dialog", { name: "Worktrees" }).count(), 1, "the modal stays");
      await until("focus back on Review Changes", () => review.evaluate((el) => el === document.activeElement));
      await noSideScroll(page);
      await page.keyboard.press("Escape");
      await until("the modal closed", async () => (await page.getByRole("dialog", { name: "Worktrees" }).count()) === 0);
      await o.ctx.close();
    });
  });
}

// ---- the queue's own chats (al_7): the Merge thread card, the running review, History, reviewer links ----------

const REVIEWER_PATH = "/w/sessions/rev2.jsonl";
const CHATS: NonNullable<MergeQueueView["chats"]> = [
  { kind: "thread", session: "01a0mergethread", path: "/w/sessions/thread.jsonl", startedAt: iso(600), current: true, memory: "uniichat" },
  { kind: "reviewer", session: "rev2", path: REVIEWER_PATH, startedAt: iso(2), running: true, run: "mr_now", branch: "feat/composer-drafts", attempt: 2 },
  { kind: "reviewer", session: "rev1", path: "/w/sessions/rev1.jsonl", startedAt: iso(20), endedAt: iso(3), run: "mr_now", branch: "feat/composer-drafts", attempt: 1, verdict: "failed", why: "no verdict within 20 min" },
  { kind: "reviewer", session: "revold", path: "/w/sessions/revold.jsonl", startedAt: iso(45), endedAt: iso(41), run: "mr_old", branch: "feat/composer-hints", attempt: 1, verdict: "ok" },
  { kind: "thread", session: "01a0oldthread", path: "/w/sessions/oldthread.jsonl", startedAt: iso(5000), endedAt: iso(600), why: "you started a fresh one", memory: "uniichat" },
];
const ASKED = {
  thread: { session: "01a0mergethread", path: "/w/sessions/thread.jsonl", startedAt: iso(600), memory: "uniichat", state: "asking" as const, lastEvent: { kind: "names", at: iso(4) }, ask: { id: "ak_1", question: "What else must never reach the public repo?", at: iso(4), entry: "me_l", branch: "feat/composer-hints", askedIn: { session: SESSION.id, path: PATH } } },
  reviewing: { run: "mr_now", branch: "feat/composer-drafts", session: "rev2", path: REVIEWER_PATH, attempt: 2, startedAt: iso(2) },
  chats: CHATS,
};

for (const width of [1280, 390]) {
  describe(`${width}px: the queue's own chats`, () => {
    test("the Merge thread card asks through the branch's chat; the head opens the running review; Start Fresh confirms", async () => {
      const o = await open(width, `#/projects/${PID}/merge-queue`, { view: viewOf(ASKED) });
      const { page } = o;
      const card = page.getByRole("generic", { name: "Merge thread" }).first();
      await page.locator(".mq-thread-card").waitFor({ timeout: 20_000 });
      const text = await words(page.locator(".mq-thread-card"));
      for (const w of ["Merge thread", "Asking you", "UniiChat", "started", "Asked for private names", "The merge thread is asking you something.", "What else must never reach the public repo?", "Waiting on you · asked in"]) assert.ok(text.includes(w), `${w} in: ${text}`);
      assert.ok((await page.locator(".mq-thread-card").getByRole("link", { name: SESSION.title }).getAttribute("href"))!.endsWith(`/s/${encodeURIComponent(PATH)}`), "asked in: the branch's chat");
      const running = page.locator("a.mq-reviewing");
      assert.equal((await words(running)).trim(), "Review running · feat/composer-drafts (attempt 2) · Open");
      assert.ok((await running.getAttribute("href"))!.includes(encodeURIComponent(REVIEWER_PATH)));
      const box = (await running.boundingBox())!;
      assert.ok(box.x >= 0 && box.x + box.width <= width + 1, `the head button fits at ${width}px`);
      await shot(page, `${width}-thread-card`);
      void card;
      await page.locator(".mq-thread-card").getByRole("button", { name: "Start Fresh…" }).click();
      const confirm = page.getByRole("group", { name: "Start a fresh merge thread" });
      assert.match(await words(confirm), /stays readable in Queue chats/);
      assert.equal(o.calls.filter((c) => c.verb === "merge.fresh").length, 0, "nothing until the confirm");
      await confirm.getByRole("button", { name: "Start Fresh", exact: true }).click();
      await called(o, "merge.fresh");
      await o.ctx.close();
    });

    test("Queue chats: every chat, filters, each row opens its chat; Clear and Clear All… call merge.clear; never the current thread or a running review", async () => {
      const o = await open(width, `#/projects/${PID}/merge-queue/queue-chats`, { view: viewOf(ASKED) });
      const { page } = o;
      const history = page.locator(".mq-history");
      await history.waitFor({ timeout: 20_000 });
      assert.equal(await page.getByRole("tab", { selected: true, name: /^Queue chats/ }).getAttribute("aria-label"), "Queue chats · 5");
      await history.scrollIntoViewIfNeeded();
      assert.equal(await history.locator("li").count(), 5);
      assert.equal(await history.locator('li[data-session="01a0mergethread"]').getByRole("button", { name: /^Clear/ }).count(), 0, "the current thread has no Clear");
      assert.equal(await history.locator('li[data-session="rev2"]').getByRole("button", { name: /^Clear/ }).count(), 0, "a running review has no Clear");
      assert.ok((await history.locator('li[data-session="revold"] a').getAttribute("href"))!.includes(encodeURIComponent("/w/sessions/revold.jsonl")));
      await history.getByRole("button", { name: "Reviews" }).click();
      assert.equal(await history.locator("li").count(), 3);
      await history.getByRole("button", { name: "Merge threads" }).click();
      assert.equal(await history.locator("li").count(), 2);
      assert.match(await words(history.locator('li[data-session="01a0oldthread"]')), /ended: you started a fresh one/);
      await shot(page, `${width}-history`);
      await history.locator('li[data-session="01a0oldthread"]').getByRole("button", { name: /^Clear/ }).click();
      await called(o, "merge.clear");
      assert.deepEqual(o.calls.find((c) => c.verb === "merge.clear")!.body.chat, "01a0oldthread");
      await history.getByRole("button", { name: "Clear All…" }).click();
      const confirm = page.getByRole("group", { name: "Clear the queue's chats" });
      assert.match(await words(confirm), /Deletes 3 chats for good\. Runs keep their verdicts and findings/);
      await confirm.getByRole("button", { name: "Clear All", exact: true }).click();
      await until("Clear All", () => o.calls.filter((c) => c.verb === "merge.clear").length === 2);
      assert.equal(o.calls.filter((c) => c.verb === "merge.clear")[1]!.body.chat, "all");
      await o.ctx.close();
    });

    test("runs link their reviewer chats: Landed's row, and the run page per attempt", async () => {
      const o = await open(width, `#/projects/${PID}/merge-queue/landed`, { view: viewOf(ASKED) });
      const { page } = o;
      const recent = page.locator('[data-state="landed"][data-branch="feat/composer-hints"]');
      await recent.waitFor({ timeout: 20_000 });
      assert.match(await words(recent.locator(".mq-reviewers")), /Review: ok · Open Reviewer Chat/);
      assert.ok((await recent.getByRole("link", { name: "Open Reviewer Chat" }).getAttribute("href"))!.includes(encodeURIComponent("/w/sessions/revold.jsonl")));
      await o.ctx.close();
      const r = await open(width, `#/projects/${PID}/merge-queue/mr_now`, { view: viewOf(ASKED) });
      const links = r.page.locator(".mq-reviewers").first();
      await links.waitFor({ timeout: 20_000 });
      const t = await words(links);
      assert.match(t, /Review \(attempt 1\): no verdict · Open Reviewer Chat/);
      assert.match(t, /Review running \(attempt 2\) · Open Reviewer Chat/);
      assert.equal(await links.getByRole("link", { name: "Open Reviewer Chat" }).count(), 2);
      await shot(r.page, `${width}-run-reviewers`);
      await r.ctx.close();
    });

    test("a question with no chat to ask: the tab shows it with one button, Answer in Merge Thread, and no text box (q15)", async () => {
      const view = viewOf({ ...ASKED, thread: { ...ASKED.thread, ask: { ...ASKED.thread.ask, askedIn: undefined, onTab: true as const } } });
      const o = await open(width, `#/projects/${PID}/merge-queue`, { view });
      const { page } = o;
      const ask = page.locator(".mq-thread-ask");
      await ask.waitFor({ timeout: 20_000 });
      const answer = ask.getByRole("link", { name: "Answer in Merge Thread" });
      assert.equal(await answer.count(), 1);
      assert.equal(await ask.locator("button, a").count(), 1, "one button only");
      assert.equal(await ask.locator("textarea, input").count(), 0, "no Your answer box");
      assert.equal(await page.getByRole("button", { name: "Send Answer" }).count(), 0);
      assert.equal(await answer.getAttribute("href"), await page.locator(".mq-thread-card").getByRole("link", { name: "Open Merge Thread" }).getAttribute("href"), "it opens the merge thread's chat");
      assert.equal(o.calls.filter((c) => c.verb === "merge.reply").length, 0);
      await shot(page, `${width}-thread-asking-tab`);
      await o.ctx.close();
    });

    test("the merge thread's own chat holds its tab question above the message box; the answer names it", async () => {
      const view = viewOf({ ...ASKED, thread: { ...ASKED.thread, session: SESSION.id, path: PATH, ask: { ...ASKED.thread.ask, askedIn: undefined, onTab: true as const } } });
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`, { view, sessions: [{ ...SESSION, queueChat: { role: "thread" } } as SessionSummary] });
      const { page } = o;
      const line = page.locator(".mq-held-line");
      await line.waitFor({ timeout: 20_000 });
      assert.match(await words(line), /Merge thread asks: What else must never reach the public repo\? · not sent yet: your answer goes with it/);
      const box = page.locator("textarea[id$='composer-input']").first();
      await box.fill("The lab's hostnames.");
      await box.press("Enter");
      await until("the answer names the question", () => o.frames.some((f) => POSTS.test(f) && f.includes('"decision":"ak_1"')));
      await o.ctx.close();
    });

    test("the branch's own Worktrees row: Open Reviewer Chat while its review runs", async () => {
      const rows = ALL_ROWS.map((w) => (w.queue && w.branch === "fix/paste-images" ? { ...w, queue: { ...w.queue, reviewer: { session: "rev2", path: REVIEWER_PATH, state: "running" as const } } } : w));
      const o = await open(width, `#/s/${encodeURIComponent(PATH)}`, { rows });
      const { page } = o;
      await page.getByRole("button", { name: /^Worktrees: / }).waitFor({ timeout: 20_000 });
      await page.getByRole("button", { name: "Session details" }).first().click();
      const section = page.locator("section", { has: page.getByRole("heading", { name: "Worktrees" }) }).last();
      const row = section.locator('[data-branch="fix/paste-images"]');
      await row.waitFor({ timeout: 10_000 });
      assert.match(await words(row.locator(".wt-queue-reviewer")), /Review running · Open Reviewer Chat/);
      assert.ok((await row.getByRole("link", { name: "Open Reviewer Chat" }).getAttribute("href"))!.endsWith(`/s/${encodeURIComponent(REVIEWER_PATH)}`));
      await row.scrollIntoViewIfNeeded();
      await shot(page, `${width}-worktree-reviewer`);
      await o.ctx.close();
    });
  });
}
