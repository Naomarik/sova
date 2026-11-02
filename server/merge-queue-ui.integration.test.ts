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
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { MergeEntry, MergeQueueView, MergeRun, WorktreeMergeProject, WorktreeQueueInfo } from "../shared/merge-queue";
import type { SessionSummary, SessionWorktreeInfo } from "../shared/protocol";
import type { ProjectSummary } from "../shared/projects";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

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
const wt = (branch: string, x: Partial<SessionWorktreeInfo> = {}): SessionWorktreeInfo => ({
  path: `/w/.worktrees/sova-${branch.split("/")[1]}`,
  branch,
  status: "active",
  how: "created",
  exists: true,
  hasAgentDir: false,
  runningWorkers: 0,
  readiness: { path: "", branch, state: "ready", landing: { state: "ready", commit: sha("d") } },
  mergeProject,
  ...x,
});

/** Every state a row can be in. */
const ALL_ROWS = [
  wt("feat/composer-drafts"),
  wt("feat/composer-shortcuts"),
  wt("fix/paste-images", { queue: qi({ id: "me_q", state: "queued", position: 2, eta: { startsInMs: 4 * 60_000, takesMs: 9 * 60_000 }, newerCommits: 1 }) }),
  wt("feat/draft-sync-tabs", { readiness: { path: "", branch: "feat/draft-sync-tabs", state: "in-progress", dirtyCount: 3 } }),
  wt("fix/draft-autosave-race", { queue: qi({ id: "me_f", state: "needs-fix", reason: "unit failed: src/lib/drafts.test.ts", run: "mr_fail" }) }),
  wt("fix/conflict-chip", {
    queue: qi({ id: "me_b", state: "behaviour-differs", conflict: { files: ["src/a.ts"], verdict: "behaviour-differs", ours: "Master retries the save twice.", theirs: "The branch never retries.", proposal: "Keep master's retry.", at: iso(3) } }),
  }),
  wt("feat/hack", { queue: qi({ id: "me_r", state: "review-flagged", review: { verdict: "blocking", text: "Leaves a workaround in land.ts with no test.", commit: sha("e"), at: iso(2) } }) }),
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
    current: RUN,
    checking: [entry({ id: "me_c", branch: "fix/worker-restore", state: "checking" })],
    waiting: [
      entry({ id: "me_w1", branch: "feat/pending-chip", state: "queued", position: 1, eta: { startsInMs: 6 * 60_000, takesMs: 9 * 60_000 } }),
      entry({ id: "me_w2", branch: "feat/replay-timeouts", state: "queued", position: 2, eta: { startsInMs: 15 * 60_000, takesMs: 22 * 60_000 }, newerCommits: 2, approval: { by: "typed", at: iso(8), commit: sha("c") } }),
    ],
    needsYou: [
      entry({ id: "me_b", branch: "fix/conflict-chip", state: "behaviour-differs", conflict: { files: ["src/a.ts"], verdict: "behaviour-differs", ours: "Master retries the save twice.", theirs: "The branch never retries.", proposal: "Keep master's retry.", at: iso(3) } }),
      entry({ id: "me_r", branch: "feat/hack", state: "review-flagged", review: { verdict: "blocking", text: "Leaves a workaround in land.ts with no test.", commit: sha("e"), at: iso(2) } }),
    ],
    needsFix: [entry({ id: "me_f", branch: "fix/draft-autosave-race", state: "needs-fix", reason: "unit failed: src/lib/drafts.test.ts", run: "mr_fail" })],
    recent: [
      {
        entry: entry({ id: "me_l", branch: "feat/composer-hints", state: "landed", landed: { sha: sha("b"), from: sha("a"), at: iso(30), pushed: "pushed" }, notes: [{ kind: "thread", text: NOTE, at: iso(29) }] }),
        run: { id: "mr_old", verdict: "passed", startedAt: iso(40), endedAt: iso(30) },
      },
    ],
    heads: { target: sha("1"), pushed: sha("1") },
    thread: { session: "/w/sessions/thread.jsonl", startedAt: iso(60) },
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
  playbook: { label: "Project verbs playbook", branch: "sova/project-verbs", target: "master", branchHash: `sha256:${"f".repeat(64)}`, proposes: "definition" },
  can: { onboard: false },
  feed: [],
};

const CONTENT: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

interface Opened {
  page: Page;
  ctx: BrowserContext;
  /** Each verb call: its name and body. */
  calls: { verb: string; body: Record<string, unknown> }[];
}

/** Sova at `width` on `hash`, every request answered: the session, its worktrees, the project, its queue. */
async function open(width: number, hash: string, o: { rows?: SessionWorktreeInfo[]; view?: MergeQueueView } = {}): Promise<Opened> {
  const phone = width < 768;
  // Reduced motion: a screenshot shows each screen's end state, never a fade half-way.
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: phone, isMobile: phone, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const calls: Opened["calls"] = [];
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  const ok = (verb: string, merge: unknown) => ({ v: 1, verb, project: ROOT_DIR, instance: null, slot: null, generation: null, checkout: null, branch: null, ok: true, changed: true, state: "stopped", steps: [], services: [], data: [], links: [], defHash: null, merge });
  await page.routeWebSocket(/.*/, (ws) => {
    if (!new URL(ws.url()).pathname.startsWith("/ws/chat")) return;
    ws.send(JSON.stringify({ type: "hello", items: [{ id: "u1", kind: "user", text: "Make drafts survive a reload.", at: iso(20) }], isStreaming: false, model: "mock/m1", thinking: "off", context: null }));
  });
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    const verb = /^\/api\/project-services\/(merge\.[a-z-]+)$/.exec(p)?.[1];
    if (verb) {
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      calls.push({ verb, body });
      if (verb === "merge.status") return route.fulfill(json(ok(verb, { view: o.view ?? viewOf() })));
      if (verb === "merge.logs") {
        const run = body.run === "mr_fail" ? FAILED : RUN;
        return route.fulfill(json(ok(verb, { run, lines: [`log of ${String(body.step ?? "every step")}`, "14:06 ok"] })));
      }
      return route.fulfill(json(ok(verb, { entry: entry({}) })));
    }
    if (p === "/api/sessions") return route.fulfill(json([SESSION, CODING, CODING_B]));
    if (p === `/api/projects/${PID}/runtime`) return route.fulfill(json(RUNTIME));
    if (p === `/api/projects/${PID}/overseer/worktrees`) return route.fulfill(json(WORKTREES));
    if (p === `/api/projects/${PID}/runtime/merge` || p === `/api/projects/${PID}/overseer/worktrees/merge`) {
      calls.push({ verb: p.endsWith("runtime/merge") ? "runtime.merge" : "worktrees.merge", body: JSON.parse(route.request().postData() ?? "{}") });
      return route.fulfill(json(p.endsWith("runtime/merge") ? RUNTIME : WORKTREES));
    }
    if (p === "/api/transcript") return route.fulfill(json({ items: [], context: null }));
    if (p === "/api/insights/session") return route.fulfill(json({ outline: null, compactions: [], teams: [], workers: [], worktrees: o.rows ?? ALL_ROWS }));
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
  return { page, ctx, calls };
}

/** MQ_UI_SHOTS=<dir>: keep a screenshot of each screen (by hand, for a look). */
const shot = async (page: Page, name: string) => {
  const dir = process.env.MQ_UI_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: false });
};

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

/** No screen of the queue says Restart, live or not live. Notes are the merge thread's own words, so they're left out. */
async function noRestartOrLive(page: Page, scope: string) {
  const text = await page.locator(scope).first().evaluate((el) => {
    const c = el.cloneNode(true) as HTMLElement;
    for (const n of c.querySelectorAll(".wt-queue-note, .mq-note")) n.remove();
    return `${c.innerText} ${[...c.querySelectorAll("[aria-label],[title]")].map((e) => `${e.getAttribute("aria-label") ?? ""} ${e.getAttribute("title") ?? ""}`).join(" ")}`;
  });
  assert.doesNotMatch(text, /\brestart|\bnot live\b|\blive\b/i, `${scope} says Restart or live: ${text.slice(0, 400)}`);
}
const noSideScroll = async (page: Page) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "nothing scrolls sideways");

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
      for (const word of ["Ready", "Queued · 2nd", "Uncommitted", "Needs a fix", "Behaviour differs", "Review flagged", "Landed"]) assert.match(text, new RegExp(word), word);
      assert.match(text, /Master retries the save twice\./);
      assert.match(text, /Leaves a workaround in land\.ts/);
      await shot(page, `${width}-modal-all`);

      await modal.getByRole("button", { name: "Land feat/composer-drafts", exact: true }).click();
      await called(o, "merge.add");
      assert.deepEqual(lastCall(o, "merge.add").body, { checkout: "/w/.worktrees/sova-composer-drafts" });

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

      await modal.getByRole("button", { name: "Cancel landing fix/paste-images" }).click();
      await called(o, "merge.cancel");
      assert.deepEqual(lastCall(o, "merge.cancel").body, { entry: "me_q" });

      await modal.getByRole("button", { name: "Accept the resolution for fix/conflict-chip" }).click();
      await until("an accept", () => o.calls.some((c) => c.verb === "merge.answer" && c.body.answer === "accept"));
      assert.equal(lastCall(o, "merge.answer").body.entry, "me_b");

      await modal.getByRole("button", { name: "Land feat/hack anyway" }).click();
      await until("a land-anyway", () => o.calls.some((c) => c.verb === "merge.answer" && c.body.answer === "land-anyway"));

      await modal.getByRole("button", { name: "Send feat/hack back to its chat" }).click();
      await until("a send-back", () => o.calls.some((c) => c.verb === "merge.answer" && c.body.answer === "send-back" && c.body.entry === "me_r"));

      // An uncommitted row has no Land.
      assert.equal(await modal.getByRole("button", { name: "Land feat/draft-sync-tabs", exact: true }).count(), 0);
      assert.equal(await modal.locator('[data-branch="fix/draft-autosave-race"] a', { hasText: "See Why" }).getAttribute("href"), `#/projects/${PID}/merge-queue/mr_fail`);
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
      assert.equal(await modal.getByRole("button", { name: "Land feat/other", exact: true }).count(), 0);
      await noRestartOrLive(o.page, ".wt-queue-modal");
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
      for (const word of ["Ready", "Queued · 2nd", "Uncommitted", "Needs a fix", "Behaviour differs", "Review flagged", "Landed"]) assert.match(text, new RegExp(word), word);
      assert.match(text, /2 ready · 1 queued · 1 behaviour differs · 1 review flagged · 1 needs a fix · 1 uncommitted · 1 landed/);
      await section.getByRole("button", { name: "Cancel landing fix/paste-images" }).click();
      await called(o, "merge.cancel");
      await section.getByRole("button", { name: "Land feat/composer-drafts", exact: true }).click();
      await called(o, "merge.add");
      assert.equal(await section.getByRole("link", { name: "View Merge Queue" }).getAttribute("href"), `#/projects/${PID}/merge-queue`);
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
      assert.match(text, /Waiting · 2 · the last one done in ~37 min/);
      assert.match(text, /starts in ~6 min · takes ~9 min/);
      assert.match(text, /2 newer commits not included/);
      assert.match(text, /typed in its chat/);
      assert.match(text, /Behaviour differs · waiting for you/);
      assert.match(text, /Review flagged · waiting for you/);
      assert.match(text, /Keep master's retry\./);
      assert.match(text, /Sent back to its chat/);
      assert.match(text, new RegExp(NOTE.replace(/[.;]/g, "\\$&")));
      await shot(page, `${width}-queue`);
      await tab.getByRole("button", { name: "Pause Queue" }).click();
      await called(o, "merge.pause");
      await tab.getByRole("button", { name: "Cancel landing feat/replay-timeouts" }).click();
      await until("a cancel", () => o.calls.some((c) => c.verb === "merge.cancel" && c.body.entry === "me_w2"));
      await tab.getByRole("button", { name: "Accept the resolution for fix/conflict-chip" }).click();
      await until("an accept", () => o.calls.some((c) => c.verb === "merge.answer" && c.body.answer === "accept"));
      await tab.getByRole("button", { name: "Send fix/conflict-chip back to its chat" }).click();
      await until("a send-back", () => o.calls.some((c) => c.verb === "merge.answer" && c.body.answer === "send-back" && c.body.entry === "me_b"));
      await tab.getByRole("button", { name: "Land feat/hack anyway" }).click();
      await until("a land-anyway", () => o.calls.some((c) => c.verb === "merge.answer" && c.body.answer === "land-anyway"));
      assert.equal(await tab.getByRole("link", { name: "Open Merge Thread" }).count(), 1);
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
      // A coding row: its ⋯ holds Land (not Merge Branch); Land queues its worktree.
      const cart = page.locator(".project-worktree", { hasText: "Fix the cart" });
      await cart.getByRole("button", { name: /^Actions · / }).click();
      assert.equal(await page.getByRole("menuitem", { name: /^Merge Branch/ }).count(), 0);
      await page.getByRole("menuitem", { name: "Land sova/fix-cart on master" }).click();
      await until("a land of the coding worktree", () => o.calls.some((c) => c.verb === "merge.add" && c.body.checkout === "/w/.worktrees/sova-fix-cart"));
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

    test("onboarding: a project not set up says what should pass; Try It on Master, then Save Checks", async () => {
      const o = await open(width, `#/projects/${PID}/merge-queue`, { view: viewOf({ checks: "unset", state: "idle", current: undefined, waiting: [], needsYou: [], needsFix: [], recent: [] }) });
      const { page } = o;
      await page.getByText("Before the queue can land anything here, tell us what should pass.").waitFor({ timeout: 20_000 });
      await page.getByRole("textbox", { name: "Command" }).fill("npm test");
      assert.match(await words(page.locator(".mq-onboard")), /We run npm test there\./);
      await page.getByRole("button", { name: "Try It on Master" }).click();
      await until("a try", () => o.calls.some((c) => c.verb === "merge.setup" && c.body.dryRun === true));
      assert.equal(lastCall(o, "merge.setup").body.command, "npm test");
      assert.equal(lastCall(o, "merge.setup").body.project, ROOT_DIR);
      await page.getByRole("button", { name: "Save Checks" }).click();
      await until("a save", () => o.calls.some((c) => c.verb === "merge.setup" && !c.body.dryRun));
      await shot(page, `${width}-onboard`);
      await noRestartOrLive(page, ".mq-onboard");
      // List its checks: one per line; a line without a name is named back, and nothing is tried.
      await page.getByText("List its checks").click();
      await page.getByRole("textbox", { name: "Checks" }).fill("Typecheck: npm run typecheck\nnpm test");
      const tries = o.calls.filter((c) => c.verb === "merge.setup").length;
      await page.getByRole("button", { name: "Try It on Master" }).click();
      await page.getByText("Line 2 needs a name, a colon, then its command.").waitFor();
      assert.equal(o.calls.filter((c) => c.verb === "merge.setup").length, tries, "nothing tried");
      await page.getByRole("textbox", { name: "Checks" }).fill("Typecheck: npm run typecheck\nUnit tests: npm test");
      await page.getByRole("button", { name: "Try It on Master" }).click();
      await until("a list try", () => o.calls.some((c) => c.verb === "merge.setup" && Array.isArray(c.body.checks)));
      assert.deepEqual(lastCall(o, "merge.setup").body.checks, [{ label: "Typecheck", run: "npm run typecheck" }, { label: "Unit tests", run: "npm test" }]);
      assert.equal(lastCall(o, "merge.setup").body.dryRun, true);
      await page.getByText("This project has no automated tests").click();
      assert.match(await words(page.locator(".mq-onboard")), /master moves to that merged commit/);
      await page.getByRole("button", { name: "Try the Merge Copy" }).click();
      await until("a none try", () => o.calls.some((c) => c.verb === "merge.setup" && c.body.none === true && c.body.dryRun === true));
      await noSideScroll(page);
      await o.ctx.close();
    });
  });
}
