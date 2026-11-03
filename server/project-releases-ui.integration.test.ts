// A project's Releases screens in a real Chrome, at 1280px and 390px: the Releases tab not set up (Set Up Releases),
// a release in progress (its steps, Continue, Retry Step, Publish held by its gates, then Publish with its confirm, the
// release power's countdown with Cancel, Abandon with a reason), the history with channel badges and Withdraw, and on
// the Overview the Releases card, the Deploy row's "Runs vX" and the Plan Deploy of vX hand-off. The app's own build,
// served from a scratch build with every request answered here (no server, no network); each verb call is recorded.
// Chrome or Chromium must be installed (as the tour tests: nothing is downloaded).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { ReleaseHistoryItem, ReleaseRecord, ReleaseStep, ReleaseView } from "../shared/release";
import type { DeployTargetView } from "../shared/project-contract";
import type { ProjectSummary } from "../shared/projects";
import { launchTourBrowser } from "./tours/browser";
import { scratchRoot } from "./test-scratch";

const ROOT = join(import.meta.dirname, "..");
const ORIGIN = "http://sova.test";
let dist = "";
let browser: Browser;

before(async () => {
  // SOVA_REL_UI_DIST=<dir>: drive a build made elsewhere (by hand, to show a tree without the change fails).
  dist = process.env.SOVA_REL_UI_DIST || join(scratchRoot("sova-rel-ui-"), "dist");
  if (!process.env.SOVA_REL_UI_DIST) {
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
const PID = "prj_rel00001";
const ROOT_DIR = "/w/notes";
const PROJECT: ProjectSummary = { id: PID, name: "Notes", root: ROOT_DIR, origin: "folder", createdAt: iso(10_000), space: { kind: "standalone" } };

const step = (id: string, label: string, state: ReleaseStep["state"], x: Partial<ReleaseStep> = {}): ReleaseStep => ({ id, label, phase: "prepare", state, ...x });
const record = (x: Partial<ReleaseRecord> = {}): ReleaseRecord =>
  ({
    id: "rl_abc123",
    project: ROOT_DIR,
    state: "preparing",
    version: "0.10.0",
    tag: "v0.10.0",
    channels: ["stable"],
    base: sha("b"),
    commit: sha("c"),
    entry: "mq_rel1",
    thread: { session: "s-rel" },
    steps: [
      step("version", "Pick the version", "done", { summary: "0.10.0: 3 features since v0.9.0", by: "thread", at: iso(20) }),
      step("notes", "Draft the notes", "done", { summary: "Notes drafted from 12 landings", detail: "## v0.10.0\n- Releases tab", at: iso(18) }),
      step("bump", "Bump the files", "failed", { summary: "package.json not found", at: iso(15) }),
      step("commit", "Make the release commit", "waiting"),
      step("checks", "Gating checks", "waiting", { phase: "sova" }),
      step("try-live", "Try it on the live server", "held", { phase: "check", held: true, summary: "Running on the live server; say go on" }),
      step("publish", "Publish", "waiting", { phase: "sova" }),
      step("gh-release", "GitHub release page", "waiting", { phase: "after" }),
      step("unlist", "Mark the page withdrawn", "waiting", { phase: "withdraw" }),
    ],
    notes: "## v0.10.0\n- Releases tab",
    artifacts: [],
    startedAt: iso(25),
    startedBy: "operator",
    lastReportAt: iso(15),
    manifest: { v: 1, steps: [] },
    settings: {} as ReleaseRecord["settings"],
    ...x,
  }) as ReleaseRecord;
const hist = (tag: string, x: Partial<ReleaseHistoryItem> = {}): ReleaseHistoryItem => ({ tag, version: tag.slice(1), sha: sha(tag.at(-1)!), date: iso(60 * 24 * 7), notes: `## ${tag}\n- things`, channels: [], deployedTo: [], ...x });
const HISTORY = [hist("v0.9.0", { channels: ["stable"], deployedTo: ["prod"], sha: sha("9") }), hist("v0.8.1", { withdrawn: { at: iso(60 * 24 * 9), why: "broke the login" }, sha: sha("8") }), hist("v0.8.0", { sha: sha("7") })];
const view = (x: Partial<ReleaseView> = {}): ReleaseView => ({
  project: ROOT_DIR,
  initialized: true,
  settings: null,
  open: null,
  last: null,
  history: HISTORY,
  latest: "v0.9.0",
  landingsSince: 479,
  target: "master",
  remote: true,
  gates: null,
  quiet: null,
  deployTargets: ["prod"],
  ...x,
});
const TARGET: DeployTargetView = { name: "prod", about: "the public site", standing: "declared", last: null, verifiedCommit: sha("9"), rollback: "redeploy-previous", request: null };

const CONTENT: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".webmanifest": "application/manifest+json" };

interface Opened {
  page: Page;
  ctx: BrowserContext;
  calls: { verb: string; body: Record<string, unknown> }[];
  /** From now on release.status answers `v`. */
  set(v: ReleaseView): void;
}

async function open(width: number, hash: string, first: ReleaseView, o: { runtime?: Record<string, unknown>; onboard409?: string } = {}): Promise<Opened> {
  const phone = width < 768;
  const ctx = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: phone, isMobile: phone, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const calls: Opened["calls"] = [];
  let current = first;
  const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
  const ok = (verb: string, extra: Record<string, unknown>) => ({ v: 1, verb, project: ROOT_DIR, instance: null, slot: null, generation: null, checkout: null, branch: null, ok: true, changed: true, state: "stopped", steps: [], services: [], data: [], links: [], defHash: null, ...extra });
  await page.routeWebSocket(/.*/, () => {});
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== ORIGIN) return route.abort();
    const p = url.pathname;
    const body = () => JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
    const verb = /^\/api\/project-services\/((?:release|deploy)\.[a-z-]+)$/.exec(p)?.[1];
    if (verb) {
      calls.push({ verb, body: body() });
      if (verb === "release.status") return route.fulfill(json(ok(verb, { release: { view: current } })));
      if (verb.startsWith("release.")) return route.fulfill(json(ok(verb, { release: { view: current } })));
      if (verb === "deploy.status") return route.fulfill(json(ok(verb, { deploy: { deployHash: "d".repeat(64), targets: [TARGET] } })));
      if (verb === "deploy.plan") {
        const b = body();
        return route.fulfill(json(ok(verb, { deploy: { deployHash: "d".repeat(64), plan: { planId: "pl_1", target: "prod", commit: String(b.commit ?? sha("e")), deployHash: "d".repeat(64), checks: [{ id: "pushed", ok: true, detail: "on origin" }], steps: [{ id: "up", argv: ["./deploy.sh"] }], verify: null, expiresAt: new Date(T0 + 15 * 60_000).toISOString() } } })));
      }
      return route.fulfill(json(ok(verb, {})));
    }
    if (p === `/api/projects/${PID}/verbs/onboard`) {
      calls.push({ verb: "onboard", body: body() });
      if (o.onboard409) return route.fulfill(json({ error: o.onboard409 }, 409));
      return route.fulfill(json({ sessionId: "s-maker", path: "/w/sessions/maker.jsonl", worktree: { path: "/w/.worktrees/notes-release-setup", branch: "sova/release-setup" } }));
    }
    const held = new RegExp(`^/api/projects/${PID}/held/([^/]+)/cancel$`).exec(p);
    if (held) {
      calls.push({ verb: "held.cancel", body: { hold: decodeURIComponent(held[1]!) } });
      return route.fulfill(json({ ok: true }));
    }
    if (p === `/api/projects/${PID}/runtime` && o.runtime) return route.fulfill(json(o.runtime));
    if (p === "/api/project-services/merge.status") return route.fulfill(json(ok("merge.status", { merge: { view: { served: false, checks: "unset", target: "master", root: ROOT_DIR } } })));
    if (p === "/api/sessions") return route.fulfill(json([]));
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
  return { page, ctx, calls, set: (v) => (current = v) };
}

/** REL_UI_SHOTS=<dir>: keep a screenshot of each screen (by hand, for a look). */
const shot = async (page: Page, name: string) => {
  const dir = process.env.REL_UI_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: join(dir, `${name}.png`), fullPage: true });
};
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 10_000) {
  const t0 = Date.now();
  while (!(await ok())) {
    if (Date.now() - t0 >= ms) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const called = (o: Opened, verb: string) => until(`a ${verb} call`, () => o.calls.some((c) => c.verb === verb));
const lastCall = (o: Opened, verb: string) => [...o.calls].reverse().find((c) => c.verb === verb)!;
const noSideScroll = async (page: Page) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, "nothing scrolls sideways");
const TAB = `#/projects/${PID}/releases`;

describe("the Releases tab", () => {
  test("sits after Merge Queue; a project not set up says how, and Set Up Releases starts the maker", async () => {
    const o = await open(1280, TAB, view({ initialized: false, history: [], latest: null, landingsSince: null }));
    try {
      await o.page.getByRole("tab", { name: "Releases" }).waitFor();
      const tabs = await o.page.getByRole("tab").allTextContents();
      assert.equal(tabs.indexOf("Releases"), tabs.indexOf("Merge Queue") + 1, tabs.join(","));
      assert.equal(await o.page.getByRole("tab", { name: "Releases" }).getAttribute("aria-selected"), "true");
      await o.page.getByText("Releases aren't set up for this project").waitFor();
      assert.equal(await o.page.getByRole("button", { name: "Start Release" }).count(), 0, "nothing starts a release before it is set up");
      await shot(o.page, "not-set-up");
      await o.page.getByRole("button", { name: "Set Up Releases" }).click();
      await called(o, "onboard");
      assert.deepEqual(lastCall(o, "onboard").body, { playbook: "release-maker" });
      await o.page.getByRole("link", { name: "Open the Chat" }).waitFor();
    } finally {
      await o.ctx.close();
    }
  });

  test("history from tags: channel badges, where each runs, the withdrawn one with its reason; Withdraw asks why first", async () => {
    const o = await open(1280, TAB, view());
    try {
      const strip = o.page.getByRole("group", { name: "Latest release" });
      await strip.getByText("479 landings since v0.9.0").waitFor();
      const v09 = o.page.locator('[data-tag="v0.9.0"]');
      await v09.getByText("stable", { exact: true }).waitFor();
      await v09.getByText("Runs on prod").waitFor();
      const v081 = o.page.locator('[data-tag="v0.8.1"]');
      assert.equal(await v081.getAttribute("data-state"), "withdrawn");
      await v081.getByText(/Withdrawn .*: broke the login/).waitFor();
      assert.equal(await v081.getByRole("button", { name: /Withdraw/ }).count(), 0, "a withdrawn release has no Withdraw");
      await o.page.getByRole("button", { name: "Start Release" }).waitFor();
      await v09.getByRole("button", { name: "Withdraw v0.9.0" }).click();
      const confirm = o.page.getByRole("group", { name: "Confirm withdrawing v0.9.0" });
      await confirm.getByText(/stable moves back to v0\.8\.0 on origin too\. v0\.9\.0 itself stays/).waitFor();
      const go = confirm.getByRole("button", { name: "Withdraw v0.9.0" });
      assert.equal(await go.getAttribute("aria-disabled"), "true", "Withdraw waits for a reason");
      await go.dispatchEvent("click");
      assert.equal(o.calls.some((c) => c.verb === "release.withdraw"), false);
      await confirm.getByLabel(/Why/).fill("crashes on start");
      await go.click();
      await called(o, "release.withdraw");
      assert.deepEqual(lastCall(o, "release.withdraw").body, { project: ROOT_DIR, tag: "v0.9.0", why: "crashes on start", confirm: true });
    } finally {
      await o.ctx.close();
    }
  });

  for (const width of [1280, 390]) {
    test(`a release in progress at ${width}px: its steps and states, Continue, Retry Step, Publish held by its gates, Abandon with a reason`, async () => {
      const r = record();
      const o = await open(width, TAB, view({ open: r, gates: { checksPassed: false, stepsDone: false, notes: true, why: ["the gating checks haven't passed yet", "steps not done: bump, commit"] } }));
      try {
        const card = o.page.getByRole("group", { name: "Release in progress" });
        await card.waitFor();
        const states = await card.locator("[data-step]").evaluateAll((els) => els.map((e) => `${e.getAttribute("data-step")}:${e.getAttribute("data-state")}`));
        assert.deepEqual(states, ["version:done", "notes:done", "bump:failed", "commit:waiting", "checks:waiting", "try-live:held", "publish:waiting", "gh-release:waiting"], "after-withdraw steps wait until a withdraw");
        await card.getByText("Step 3 of 8 · Bump the files failed · 2 done").waitFor();
        await card.getByText("Other landings wait in the queue until v0.10.0 is published or abandoned.").waitFor();
        await card.getByText("Not ready to publish: the gating checks haven't passed yet; steps not done: bump, commit.").waitFor();
        assert.equal(await card.getByRole("button", { name: /^Publish/ }).count(), 0);
        // A step's detail opens in place.
        await card.getByRole("button", { name: "Show the detail of Draft the notes" }).click();
        await card.getByLabel("Detail of Draft the notes", { exact: true }).waitFor();
        await card.getByRole("button", { name: "Retry Bump the files" }).click();
        await called(o, "release.retry");
        assert.deepEqual(lastCall(o, "release.retry").body, { project: ROOT_DIR, release: "rl_abc123", step: "bump" });
        await card.getByRole("button", { name: "Continue after Try it on the live server" }).click();
        await called(o, "release.continue");
        assert.deepEqual(lastCall(o, "release.continue").body, { project: ROOT_DIR, release: "rl_abc123", step: "try-live" });
        await card.getByRole("link", { name: "Open Release Chat" }).waitFor();
        if (width < 768) await noSideScroll(o.page);
        await shot(o.page, `in-progress-${width}`);
        // Abandon asks why, and says nothing is published.
        await card.getByRole("button", { name: "Abandon Release" }).click();
        const ask = o.page.getByRole("group", { name: "Confirm abandoning v0.10.0" });
        await ask.getByText(/nothing is published\. If its release commit already landed, it's reverted as a landing on the target\./).waitFor();
        await ask.getByLabel(/Why/).fill("wrong base");
        await ask.getByRole("button", { name: "Abandon Release" }).click();
        await called(o, "release.abandon");
        assert.deepEqual(lastCall(o, "release.abandon").body, { project: ROOT_DIR, release: "rl_abc123", why: "wrong base", confirm: true });
      } finally {
        await o.ctx.close();
      }
    });
  }

  test("a ready release: Publish confirms what goes out first; the release power's countdown carries Cancel", async () => {
    const steps = record().steps.map((s) => (s.phase === "after" || s.phase === "withdraw" || s.id === "publish" ? s : { ...s, state: "done" as const }));
    const ready = record({ state: "ready", steps, power: { heldUntil: new Date(Date.now() + 4 * 60_000 + 30_000).toISOString(), act: "hold_42" } });
    const o = await open(1280, TAB, view({ open: ready, gates: { checksPassed: true, stepsDone: true, notes: true, why: [] } }));
    try {
      const card = o.page.getByRole("group", { name: "Release in progress" });
      await card.getByText(/^Publishes in 4:[0-9]{2}\./).waitFor();
      await card.getByRole("button", { name: "Cancel: Publishing v0.10.0" }).click();
      await called(o, "held.cancel");
      assert.deepEqual(lastCall(o, "held.cancel").body, { hold: "hold_42" });
      await card.getByRole("button", { name: "Publish v0.10.0" }).click();
      const ask = o.page.getByRole("group", { name: "Confirm publishing v0.10.0" });
      await ask.getByText(/^Publishing pushes master, v0\.10\.0, stable to origin in one step/).waitFor();
      assert.equal(o.calls.some((c) => c.verb === "release.publish"), false, "nothing is published before the confirm");
      await shot(o.page, "publish-confirm");
      await ask.getByRole("button", { name: "Publish Now" }).click();
      await called(o, "release.publish");
      assert.deepEqual(lastCall(o, "release.publish").body, { project: ROOT_DIR, release: "rl_abc123", confirm: true });
    } finally {
      await o.ctx.close();
    }
  });

  test("a local-only project's Publish says nothing is pushed", async () => {
    const ready = record({ state: "ready" });
    const o = await open(1280, TAB, view({ remote: false, open: ready, gates: { checksPassed: true, stepsDone: true, notes: true, why: [] } }));
    try {
      await o.page.getByRole("group", { name: "Latest release" }).getByText(/on this machine only/).waitFor();
      await o.page.getByRole("button", { name: "Publish v0.10.0" }).click();
      const line = await o.page.getByRole("group", { name: "Confirm publishing v0.10.0" }).textContent();
      assert.match(line ?? "", /Publishing tags v0\.10\.0 on this machine and moves stable to it\. Nothing is pushed\./);
      assert.doesNotMatch(line ?? "", /origin/);
    } finally {
      await o.ctx.close();
    }
  });

  test("published: its after-publish steps stay with Retry Step, and Plan Deploy of vX plans that commit on the Overview's Deploy card", async () => {
    const steps = record().steps.map((s) => (s.phase === "withdraw" ? s : s.phase === "after" ? { ...s, state: "failed" as const, summary: "gh: not logged in" } : { ...s, state: "done" as const }));
    const published = record({ state: "published", steps, publish: { at: iso(1), by: "operator", pushed: "pushed" as never, channelsFrom: { stable: sha("9") } } });
    const o = await open(1280, TAB, view({ last: published, history: [hist("v0.10.0", { sha: sha("c"), channels: ["stable"] }), ...HISTORY] }));
    try {
      const card = o.page.getByRole("group", { name: "Release in progress" });
      await card.getByText("Published, finishing").waitFor();
      await card.getByRole("button", { name: "Retry GitHub release page" }).waitFor();
      await card.getByRole("button", { name: "Plan Deploy of v0.10.0" }).click();
      await o.page.waitForURL(`${ORIGIN}/#/projects/${PID}`);
      await called(o, "deploy.plan");
      assert.deepEqual(lastCall(o, "deploy.plan").body, { project: ROOT_DIR, target: "prod", commit: sha("c") });
      const deploy = o.page.locator("section", { has: o.page.getByRole("heading", { name: "Deploy", exact: true }) });
      await deploy.getByText(/Planning release v0\.10\.0/).waitFor();
      await deploy.getByRole("button", { name: `Deploy ${sha("c").slice(0, 7)}` }).waitFor();
      // The Overview's Releases card.
      const rel = o.page.locator("section", { has: o.page.getByRole("heading", { name: "Releases", exact: true }) });
      await rel.getByText("Latest v0.9.0 · 479 landings since").waitFor();
      await shot(o.page, "overview-handoff");
    } finally {
      await o.ctx.close();
    }
  });

  test("the Overview's Deploy row says which release the target runs", async () => {
    const o = await open(390, `#/projects/${PID}`, view());
    try {
      const deploy = o.page.locator("section", { has: o.page.getByRole("heading", { name: "Deploy", exact: true }) });
      await deploy.getByText(/Runs\s*v0\.9\.0/).waitFor();
      await noSideScroll(o.page);
    } finally {
      await o.ctx.close();
    }
  });
});

describe("the Releases tab's latest release", () => {
  test("Plan Deploy of vX sits on the latest release, never on a newer withdrawn one", async () => {
    const history = [hist("v0.3.0", { withdrawn: { at: iso(30), why: "bad build" }, sha: sha("3") }), hist("v0.2.0", { channels: ["stable"], sha: sha("2") }), hist("v0.1.0", { sha: sha("1") })];
    const o = await open(1280, TAB, view({ history, latest: "v0.2.0" }));
    try {
      await o.page.locator('[data-tag="v0.2.0"]').getByRole("button", { name: "Plan Deploy of v0.2.0" }).waitFor();
      assert.equal(await o.page.locator('[data-tag="v0.3.0"]').getByRole("button", { name: /Plan Deploy/ }).count(), 0);
    } finally {
      await o.ctx.close();
    }
  });
});

const runtimeWith = (state: string, extra: Record<string, unknown> = {}) => ({
  projectId: PID, standing: "registered", playbookState: state, def: null, commit: null, suite: null, services: [], orphans: [], data: [], sources: [], drift: null, proof: null, registered: null,
  playbook: { sessionId: "s-maker", playbookId: "release-maker", label: "Release maker", proposes: "release", startedBy: "operator", startedAt: iso(5), path: "/w/sessions/maker.jsonl", branch: "sova/release-setup", target: "master", ...extra },
  can: { onboard: true }, feed: [],
});

describe("Set Up Releases while its run is live or proposed", () => {
  test("a live run: the tab says the setup chat is running, with Open Chat, and offers no second Set Up Releases", async () => {
    const o = await open(1280, TAB, view({ initialized: false, history: [], latest: null, landingsSince: null }), { runtime: runtimeWith("running") });
    try {
      const run = o.page.getByRole("group", { name: "Set Up Releases run" });
      await run.getByText("Setup chat running").waitFor();
      await run.getByRole("link", { name: "Open Chat" }).waitFor();
      assert.equal(await o.page.getByRole("button", { name: "Set Up Releases" }).count(), 0);
    } finally {
      await o.ctx.close();
    }
  });

  test("a proposed run: the tab shows its release setup and its Land", async () => {
    const review = { release: { hash: `sha256:${"a".repeat(64)}`, settings: { playbook: ".sova/playbooks/release", tag: "v${version}", scheme: "semver", channels: ["stable"], commit: true, checks: [], quietMin: 30 }, steps: [{ id: "version", label: "Pick the version", phase: "prepare" }, { id: "commit", label: "Make the release commit", phase: "prepare" }], files: ["PLAYBOOK.md", "release.json"] } };
    const o = await open(1280, TAB, view({ initialized: false, history: [], latest: null, landingsSince: null }), { runtime: runtimeWith("proposed", { branchHash: `sha256:${"a".repeat(64)}`, commit: sha("e"), review }) });
    try {
      const pr = o.page.getByRole("group", { name: "Set Up Releases proposal" });
      await pr.getByText(/proposes a release setup for Notes on sova\/release-setup/).waitFor();
      await pr.getByText("Pick the version").waitFor();
      await pr.getByRole("button", { name: /Land|Merge Branch/ }).waitFor();
      assert.equal(await o.page.getByRole("button", { name: "Set Up Releases" }).count(), 0);
      await shot(o.page, "setup-proposed");
    } finally {
      await o.ctx.close();
    }
  });
});

test("Set Up Releases refused because another setup chat is still open: its words as sent, with Open Chat", async () => {
  const why = 'The last setup run, "Release maker", ended with no change but its chat is still open: open that chat to carry on, or archive it to start over.';
  const idle = { ...runtimeWith("idle"), playbook: { ...runtimeWith("idle").playbook, result: "no-change" } };
  const o = await open(1280, TAB, view({ initialized: false, history: [], latest: null, landingsSince: null }), { runtime: idle, onboard409: why });
  try {
    await o.page.getByRole("button", { name: "Set Up Releases" }).click();
    await called(o, "onboard");
    const note = o.page.locator(".rel-setup-held").filter({ hasText: why });
    await note.waitFor();
    assert.match((await note.getByRole("link", { name: "Open Chat" }).getAttribute("href")) ?? "", /maker\.jsonl/);
  } finally {
    await o.ctx.close();
  }
});
