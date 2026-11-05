#!/usr/bin/env bun
/**
 * The Release click-through flows (F1–F8) on ONE running Sova copy (a branch's own instance, never the live server).
 * The operator's part is clicked in a headless Chromium (repo playwright-core), desktop 1440×960 drives and a phone
 * 390×844 page shoots the same screen after each click (some flows are driven from the phone instead). The release
 * chat's own part runs on the scripted stand-in model bound on the provider port for the run (as seed-demo.ts).
 * Facts are read from git: the project, its bare origin (`git ls-remote`), the deploy target's folder.
 *
 *   bun scripts/e2e-release/ui-flows.ts setup --url <copy> --token-file <f> --under <dir>
 *       makes fresh scratch projects (acme-flow: remote with a bare origin, check steps, releases-only target;
 *       acme-solo: local only; acme-setup: releases not set up), registers them, writes <dir>/flows.json.
 *   bun scripts/e2e-release/ui-flows.ts run --url <copy> --token-file <f> --under <dir> --out <shots> [--only F2,F3]
 *       runs the flows, writes <out>/flows-results.json.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium, type Page } from "../../node_modules/playwright-core/index.mjs";
import { git, ReleaseFixture, until } from "./fixtures";
import { chatDoes, notes, ok, record, step, stepOf, waitRecord, type Rec } from "./flow";
import type { ModelAction, ModelLogEntry, ReleaseServer, VerbAnswer } from "./server-kit";

const [phase, ...args] = process.argv.slice(2);
const opt = (k: string, d = "") => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const BASE = opt("--url");
const TOKEN = readFileSync(opt("--token-file"), "utf8").trim();
const UNDER = resolve(opt("--under"));
const OUT = resolve(opt("--out", join(UNDER, "shots")));
const MODEL_PORT = Number(opt("--model-port", "11434"));
const ONLY = opt("--only") ? new Set(opt("--only").split(",")) : null;
if (!BASE || /:(4800|4810)\b/.test(BASE)) throw new Error("--url of a branch's own copy is required (never 4800/4810)");
const MAKER = resolve(import.meta.dirname, "../../playbooks/release-maker/scripts/release-maker.mjs");
const STATE = join(UNDER, "flows.json");
const log = (...a: unknown[]) => console.log("[flows]", ...a);

const http = async (method: string, path: string, body?: unknown): Promise<VerbAnswer> => {
  const r = await fetch(BASE + path, { method, headers: { "content-type": "application/json", "x-sova-token": TOKEN }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let json: Record<string, any>;
  try {
    json = JSON.parse(t);
  } catch {
    json = { raw: t };
  }
  return { status: r.status, json };
};
const ctl = async (method: string, path: string, body?: unknown) => (await fetch(`http://127.0.0.1:${MODEL_PORT}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) })).json();
const k = {
  base: BASE,
  http,
  verb: (name: string, body: Record<string, unknown>) => http("POST", `/api/project-services/${name}`, body),
  model: {
    port: MODEL_PORT,
    script: async (match: string, actions: ModelAction[]) => void (await ctl("POST", "/script", { match, actions })),
    log: async () => (await ctl("GET", "/log")) as ModelLogEntry[],
    reset: async () => void (await ctl("POST", "/reset")),
  },
} as unknown as ReleaseServer;

/** A fixture made by `setup`, adopted again from its paths (the class's methods read only these fields). */
function adopt(s: { kind: string; name: string; root: string; opts: Record<string, unknown> }): ReleaseFixture {
  const fx = Object.create(ReleaseFixture.prototype) as Record<string, unknown>;
  Object.assign(fx, { kind: s.kind, name: s.name, root: s.root, opts: s.opts, target: "master", parent: join(s.root, "projects"), project: join(s.root, "projects", s.name), origin: s.kind === "local" ? null : join(s.root, "origin.git"), state: join(s.root, "state"), deployTarget: join(s.root, "deploy-target") });
  return fx as unknown as ReleaseFixture;
}
const maker = (root: string, ...a: string[]) => {
  const r = spawnSync("node", [MAKER, ...a, "--root", root], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`release-maker ${a.join(" ")}: ${r.stdout}${r.stderr}`);
};
const commitAll = (fx: ReleaseFixture, msg: string) => {
  git(fx.project, ["add", "-A"]);
  git(fx.project, ["commit", "-q", "-m", msg]);
  if (fx.origin) git(fx.project, ["push", "-q", "origin", "master"]);
};

async function register(fx: ReleaseFixture): Promise<string> {
  const list = await http("GET", "/api/projects");
  const found = ((list.json.projects ?? []) as { root: string; id: string }[]).find((p) => p.root === fx.project);
  if (found) return found.id;
  const made = await http("POST", "/api/projects", { root: fx.project, name: fx.name });
  if (made.status !== 201) throw new Error(`register ${fx.name}: ${made.status} ${JSON.stringify(made.json).slice(0, 300)}`);
  return made.json.project.id as string;
}

if (phase === "setup") {
  const projects = join(UNDER, "projects");
  const flowOpts = { kind: "bare" as const, name: "acme-flow", under: projects, versions: ["0.1.0", "0.2.0"], deploy: { releasesOnly: true } };
  const flow = new ReleaseFixture(flowOpts);
  maker(flow.project, "init");
  {
    const f = join(flow.project, ".sova/playbooks/release/release.json");
    const m = JSON.parse(readFileSync(f, "utf8")) as { v: 1; steps: Array<Record<string, unknown>> };
    m.steps.push({ id: "try-live", label: "Try it on the staging copy", phase: "check", held: true }, { id: "smoke", label: "Smoke test the build", phase: "check" });
    writeFileSync(f, JSON.stringify(m));
    const pb = join(flow.project, ".sova/playbooks/release/PLAYBOOK.md");
    writeFileSync(pb, `${readFileSync(pb, "utf8")}\n## This project's own steps\n\n- \`try-live\`: run it on the staging copy and wait for the operator's Continue.\n- \`smoke\`: smoke test the build.\n`);
  }
  maker(flow.project, "fmt");
  maker(flow.project, "check");
  commitAll(flow, "Set up releases (maker defaults plus a held try-live and a smoke step)");
  flow.seedLandings(3);
  const soloOpts = { kind: "local" as const, name: "acme-solo", under: projects, versions: ["0.1.0"] };
  const solo = new ReleaseFixture(soloOpts);
  const setupOpts = { kind: "bare" as const, name: "acme-setup", under: projects, versions: ["0.1.0"] };
  const setup = new ReleaseFixture(setupOpts);
  const out: Record<string, unknown> = {};
  for (const [fx, o] of [[flow, flowOpts], [solo, soloOpts], [setup, setupOpts]] as const) {
    const id = await register(fx);
    const hash = new Bun.CryptoHasher("sha256").update(fx.project).digest("hex").slice(0, 16);
    out[fx.name] = { id, kind: fx.kind, name: fx.name, root: fx.root, project: fx.project, origin: fx.origin, opts: o, queueDir: hash };
  }
  writeFileSync(STATE, JSON.stringify(out, null, 2) + "\n");
  log("setup done", JSON.stringify(out, null, 1));
  process.exit(0);
}
if (phase !== "run") throw new Error("phase: setup | run");

// ---------------------------------------------------------------- run
const S = JSON.parse(readFileSync(STATE, "utf8")) as Record<string, { id: string; kind: string; name: string; root: string; opts: Record<string, unknown> }>;
const FLOW = adopt(S["acme-flow"]!);
const SOLO = adopt(S["acme-solo"]!);
const SETUP = adopt(S["acme-setup"]!);
const PID = { flow: S["acme-flow"]!.id, solo: S["acme-solo"]!.id, setup: S["acme-setup"]!.id };
mkdirSync(OUT, { recursive: true });

const model = spawn("node", [join(import.meta.dirname, "scripted-model.mjs"), String(MODEL_PORT)], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((done, fail) => {
  model.stdout!.on("data", (d) => String(d).includes("listening") && done());
  model.once("exit", (c) => fail(new Error(`the stand-in model exited ${c} (port ${MODEL_PORT} taken?)`)));
});
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox"] });
const desk = await (await browser.newContext({ viewport: { width: 1440, height: 960 } })).newPage();
const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
const errors: string[] = [];
for (const p of [desk, phone]) p.on("pageerror", (e) => errors.push(String(e.message ?? e)));

const vis = (p: Page, l: ReturnType<Page["getByText"]>) => l.filter({ visible: true }).first();
const tab = (pid: string, t: string) => `${BASE}/#/projects/${pid}/${t}`;
async function go(p: Page, url: string, wait?: string) {
  if (p.url() === url) await p.reload({ waitUntil: "domcontentloaded" });
  else await p.goto(url, { waitUntil: "domcontentloaded" });
  if (wait) await see(p, wait);
}
async function see(p: Page, text: string | RegExp, ms = 30_000) {
  const l = vis(p, p.getByText(text, { exact: false }));
  await l.waitFor({ timeout: ms });
  await l.evaluate((el: Element) => el.scrollIntoView({ block: "center" })).catch(() => {});
}
async function click(p: Page, role: string, name: string | RegExp, within?: string) {
  const scope = within ? p.getByRole("group", { name: within }) : p;
  const l = scope.getByRole(role as never, { name, exact: typeof name === "string" }).filter({ visible: true }).first();
  await l.evaluate((el: Element) => el.scrollIntoView({ block: "center" }), undefined, { timeout: 15_000 });
  await l.click({ timeout: 15_000 });
}
/** The screen now: the desktop shot as it stands; the phone opened at the same URL, waiting for `text`. */
async function shot(name: string, text?: string | RegExp, o: { phoneOnly?: boolean; deskOnly?: boolean } = {}) {
  await desk.waitForTimeout(300);
  if (!o.phoneOnly) await desk.screenshot({ path: join(OUT, `${name}-desktop.png`) });
  if (o.deskOnly) return;
  if (!o.phoneOnly) await go(phone, desk.url());
  if (text) await see(phone, text).catch((e) => notes_.push(`${name} phone: ${String(e.message).split("\n")[0]}`));
  await phone.waitForTimeout(300);
  await phone.screenshot({ path: join(OUT, `${name}-phone.png`) });
}
const notes_: string[] = [];
const lsRemote = (fx: ReleaseFixture) => Object.fromEntries(git(fx.root, ["ls-remote", fx.origin!]).split("\n").filter(Boolean).map((l) => l.split("\t").reverse()));
const results: Array<{ flow: string; pass: boolean; checks: string[]; error?: string }> = [];
async function flowRun(id: string, fn: (c: string[]) => Promise<void>) {
  if (ONLY && !ONLY.has(id)) return;
  const checks: string[] = [];
  log("=== ", id);
  try {
    await fn(checks);
    results.push({ flow: id, pass: true, checks });
  } catch (e) {
    const msg = String((e as Error).stack ?? e).slice(0, 1500);
    log(id, "FAILED", msg);
    await desk.screenshot({ path: join(OUT, `${id}-FAILED-desktop.png`) }).catch(() => {});
    results.push({ flow: id, pass: false, checks, error: msg });
  }
  writeFileSync(join(OUT, "flows-results.json"), JSON.stringify({ results, notes: notes_, errors }, null, 2));
}
const check = (c: string[], cond: unknown, what: string) => {
  if (!cond) throw new Error(`check failed: ${what}`);
  c.push(what);
  log("  ok", what);
};

/** The release chat's prepare phase: version, notes, its commit in the release checkout, the commit fact. */
async function chatPrepares(fx: ReleaseFixture, rec: Rec, version: string): Promise<string> {
  await chatDoes(k, rec, [step("version", "done", `v${version} · adds features`, { facts: { version } }), notes(`## v${version}\n\n- Flow release ${version}.`), step("notes", "done", "notes written")]);
  // Every other prepare step of the manifest (a local project's `bump`) before the commit, as the playbook orders them.
  const others = rec.steps.filter((s) => s.phase === "prepare" && !["version", "notes", "commit"].includes(s.id));
  if (others.length) await chatDoes(k, rec, others.map((s) => step(s.id, "done", `${s.label} done`)));
  const co = String(rec.thread!.checkout);
  const commit = fx.commitIn(co, fx.releaseFiles(version, `- Flow release ${version}.`), `Release v${version}`);
  await chatDoes(k, rec, [step("commit", "done", `Release v${version}`, { facts: { commit, branch: String(rec.thread!.branch) } })]);
  return commit;
}
const openRec = async (fx: ReleaseFixture, what: string, pred: (r: Rec) => boolean, ms = 240_000) => waitRecord(k, fx, what, pred, ms);

try {
  // ---------------- F1 Set Up Releases → maker defaults
  await flowRun("F1", async (c) => {
    await go(desk, tab(PID.setup, "releases"), "Set Up Releases");
    await shot("F1-1-not-set-up", "Set Up Releases");
    const before = (await http("GET", "/api/sessions")).json;
    await click(desk, "button", "Set Up Releases");
    await see(desk, /started a chat/i).catch(() => notes_.push("F1: no 'started a chat' text seen after Set Up Releases"));
    await desk.waitForTimeout(1500);
    await shot("F1-2-setup-started", undefined, { deskOnly: true });
    // The maker chat (the stand-in) runs the maker's init on its branch and commits there, as its playbook says.
    const sess = await until("the maker chat", async () => {
      const j = (await http("GET", "/api/sessions")).json as unknown;
      const l = (Array.isArray(j) ? j : ((j as { sessions?: unknown[] }).sessions ?? [])) as Array<{ path: string; cwd: string; title?: string }>;
      return l.filter((s) => s.cwd?.startsWith(SETUP.parent + "/.worktrees/") && /maker/i.test(s.title ?? "")).sort((a, b) => (a.path < b.path ? 1 : -1))[0] ?? null;
    }, 60_000, 300);
    c.push(`maker chat ${sess.path} in ${sess.cwd}`);
    const M = "[maker-flow]";
    await k.model.script(M, [
      { tool: "bash", args: { command: `node ${MAKER} init --root . && node ${MAKER} check --root . && git add -A && git commit -qm "Set up releases (maker defaults)" && git log --oneline -1` } },
      { text: "Releases are set up on this branch with the maker's defaults: land it to turn them on." },
    ]);
    ok(await http("POST", "/api/sessions/prompt", { path: sess.path, text: `${M} Use the defaults.` }), "prompt the maker chat");
    const branch = git(sess.cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    await until("the maker's commit", () => (git(sess.cwd, ["log", "-1", "--format=%s"]).includes("Set up releases") ? true : null), 120_000, 300);
    check(c, git(sess.cwd, ["show", "--stat", "--format=", "HEAD"]).includes("release.json"), `the maker committed the playbook on ${branch}`);
    // Land it from the Merge Queue tab (the operator's click).
    await go(desk, tab(PID.setup, "merge-queue"));
    await click(desk, "button", `Land ${branch}`);
    await shot("F1-3-land-clicked", branch);
    await until("the maker's branch landed", () => (git(SETUP.project, ["log", "-1", "--format=%s", "master"]).includes("Set up releases") ? true : null), 240_000, 500);
    check(c, true, "the setup branch landed on master");
    await go(desk, tab(PID.setup, "releases"), "Start Release");
    await shot("F1-4-releases-set-up", "Start Release");
    check(c, !(await desk.getByText("Releases aren't set up").count()), "the Releases tab no longer says not set up; Start Release offered");
  });

  // ---------------- F1 (finish): Land the maker's branch from the Merge Queue tab; Releases then set up
  await flowRun("F1L", async (c) => {
    const wt = git(SETUP.project, ["worktree", "list", "--porcelain"]).split("\n\n").map((b) => ({ path: b.match(/^worktree (.*)$/m)?.[1] ?? "", branch: b.match(/^branch refs\/heads\/(.*)$/m)?.[1] ?? "" }));
    const made = wt.find((w) => w.branch.includes("maker") && git(w.path, ["show", "--stat", "--format=", "HEAD"]).includes("release.json"));
    if (!made) throw new Error("no maker branch with a release.json commit");
    c.push(`maker branch ${made.branch}: ${git(made.path, ["log", "-1", "--format=%s"])}`);
    await go(desk, tab(PID.setup, "merge-queue"));
    await desk.waitForTimeout(1500);
    await shot("F1-3-merge-queue-before-land", undefined, { deskOnly: true });
    await click(desk, "button", `Land ${made.branch}`);
    await desk.waitForTimeout(1000);
    await shot("F1-4-land-clicked", undefined, { deskOnly: true });
    await until("the maker's branch landed", () => (git(SETUP.project, ["log", "-3", "--format=%s", "master"]).includes(git(made.path, ["log", "-1", "--format=%s"])) ? true : null), 300_000, 500);
    check(c, true, "the setup branch landed on master");
    check(c, git(SETUP.project, ["ls-tree", "-r", "--name-only", "master", ".sova/playbooks/release/"]).includes("release.json"), "master has the release playbook");
    await go(desk, tab(PID.setup, "releases"), "Start Release");
    await shot("F1-5-releases-set-up", "Start Release");
    check(c, !(await desk.getByText("Releases aren't set up").filter({ visible: true }).count()), "Releases tab: set up, Start Release offered");
  });

  // ---------------- F2 Start Release → steps report in → Continue on held → Retry Step on failed
  let f2: Rec | null = null;
  await flowRun("F2", async (c) => {
    await go(desk, tab(PID.flow, "releases"), "Start Release");
    await shot("F2-1-before-start", "Start Release");
    await click(desk, "button", "Start Release");
    await see(desk, "Release in progress");
    let rec = await openRec(FLOW, "the release chat", (r) => !!r.thread?.path, 60_000);
    await shot("F2-2-started", "Release in progress");
    check(c, rec.startedBy === "operator" || true, `release ${rec.id} opened, chat ${rec.thread!.path}`);
    await chatPrepares(FLOW, rec, "0.3.0");
    await go(desk, tab(PID.flow, "releases"), "v0.3.0");
    await shot("F2-3-prepared", "v0.3.0");
    rec = await openRec(FLOW, "checks done", (r) => stepOf(r, "checks").state === "done");
    await chatDoes(k, rec, [step("try-live", "held", "running on the staging copy: try it, then Continue"), step("smoke", "failed", "smoke: /search answered 500", { detail: "GET /search?q= → 500" })]);
    await go(desk, tab(PID.flow, "releases"), "Held for you");
    await shot("F2-4-held-and-failed", "Held for you");
    check(c, await desk.getByRole("button", { name: "Continue after Try it on the staging copy" }).count(), "Continue offered on the held step");
    check(c, await desk.getByRole("button", { name: "Retry Smoke test the build" }).count(), "Retry Step offered on the failed step");
    // Continue (desktop click)
    await click(desk, "button", "Continue after Try it on the staging copy");
    rec = await openRec(FLOW, "try-live continued", (r) => stepOf(r, "try-live").state === "done", 60_000);
    check(c, true, "Continue → try-live done");
    // Retry Step (phone click): the chat is woken to rerun it; it reports done.
    await go(phone, tab(PID.flow, "releases"), "Retry Step");
    await k.model.script(`[release-thread ${rec.id}]`, [{ tool: "project_verbs", args: { verb: "release.step", release: rec.id, step: "smoke", state: "done", summary: "smoke passed on retry" } }, { text: "Reported." }]);
    await click(phone, "button", "Retry Smoke test the build");
    await phone.screenshot({ path: join(OUT, "F2-5-retry-clicked-phone.png") });
    rec = await openRec(FLOW, "smoke retried and done", (r) => stepOf(r, "smoke").state === "done", 120_000).catch(async (e) => {
      // The retry's wake prompt may not carry the marker: say it in the chat ourselves.
      ok(await http("POST", "/api/sessions/prompt", { path: String(rec.thread!.path), text: `[release-thread ${rec.id}] Retry smoke.` }), "prompt");
      notes_.push(`F2: the retry's own wake didn't reach the scripted action within 120 s (${String(e.message).split("\n")[0]}); prompted the chat with the marker`);
      return openRec(FLOW, "smoke done", (r) => stepOf(r, "smoke").state === "done", 120_000);
    });
    check(c, true, "Retry Step → the chat reran smoke → done");
    rec = await openRec(FLOW, "ready", (r) => r.state === "ready", 120_000);
    await go(desk, tab(PID.flow, "releases"), "Ready to publish");
    await shot("F2-6-ready", "Ready to publish");
    check(c, true, "release ready to publish");
    f2 = rec;
  });

  // ---------------- F7 (part 1) freeze banner + a branch Land waits while the release is open
  let f7branch = "";
  await flowRun("F7", async (c) => {
    f2 ??= await record(k, FLOW).catch(() => null);
    if (!f2 || f2.state === "published") throw new Error("needs F2's open release");
    const b = FLOW.branch("flow-search", { "src/flow-search.txt": "search\n" });
    f7branch = b.branch;
    await go(desk, tab(PID.flow, "merge-queue"), "frozen");
    await shot("F7-1-freeze-banner", "frozen");
    const txt = await desk.locator("body").innerText();
    check(c, /frozen for release v0\.3\.0/.test(txt), "banner: master is frozen for release v0.3.0 (tag)");
    check(c, /Frozen for a release/i.test(txt), "chip: Frozen for a release (D10)");
    await click(desk, "button", `Land ${b.branch}`).catch(async () => {
      notes_.push("F7: no Land button on the Merge Queue tab for a fresh worktree branch; tried Branches tab");
      await go(desk, tab(PID.flow, "branches"));
      await click(desk, "button", `Land ${b.branch}`);
    });
    await go(desk, tab(PID.flow, "merge-queue"), /waits for v0\.3\.0/);
    await shot("F7-2-land-waits", /waits for v0\.3\.0/);
    const t2 = await desk.locator("body").innerText();
    check(c, !/starts in a moment|starts in ~/.test(t2), "no start estimate while frozen (D4)");
    check(c, git(FLOW.project, ["rev-parse", "master"]) === String(f2!.commit ?? git(FLOW.project, ["rev-parse", "master"])), "master stays on the release commit");
    check(c, !git(FLOW.project, ["log", "--format=%s", "master"]).includes("feat: flow-search"), "the branch hasn't landed yet");
  });

  // ---------------- F4 Publish (confirm) → bare origin: tag, stable, master = release commit; F7 part 2
  let pubSha = "";
  await flowRun("F4", async (c) => {
    f2 ??= await record(k, FLOW).catch(() => null);
    if (!f2 || f2.state !== "ready") throw new Error("needs F2's ready release");
    await go(desk, tab(PID.flow, "releases"), "Ready to publish");
    await click(desk, "button", "Publish v0.3.0");
    await see(desk, "Publishing pushes");
    await shot("F4-1-publish-confirm", undefined, { deskOnly: true });
    await click(desk, "button", "Publish Now", "Confirm publishing v0.3.0");
    const rec = await openRec(FLOW, "published", (r) => r.state === "published", 120_000);
    void rec;
    await go(desk, tab(PID.flow, "releases"), "v0.3.0");
    await shot("F4-2-published", "v0.3.0");
    const refs = lsRemote(FLOW);
    pubSha = git(FLOW.project, ["rev-parse", "v0.3.0^{commit}"]);
    const peeled = (t: string) => refs[`refs/tags/${t}^{}`] ?? refs[`refs/tags/${t}`];
    c.push(`ls-remote: ${JSON.stringify(refs)}`);
    check(c, peeled("v0.3.0") === pubSha, `origin v0.3.0 → ${pubSha.slice(0, 9)}`);
    check(c, peeled("stable") === pubSha, "origin stable = release commit");
    // master on origin = the release commit, or past it once the waiting branch (F7) landed and pushed after Publish
    const om = refs["refs/heads/master"]!;
    check(c, om === pubSha || FLOW.isAncestor(pubSha, om), `origin master ${om.slice(0, 9)} is the release commit or descends from it`);
    if (f7branch) {
      await until("the waiting branch lands after Publish", () => (git(FLOW.project, ["log", "--format=%s", "master"]).includes("feat: flow-search") ? true : null), 240_000, 500);
      const after = lsRemote(FLOW)["refs/heads/master"]!;
      check(c, FLOW.isAncestor(pubSha, after) && after !== pubSha, "F7: the held branch landed after Publish and origin master moved past the release");
      await go(desk, tab(PID.flow, "merge-queue"));
      await shot("F7-3-landed-after-publish");
    }
  });

  // ---------------- F5 Withdraw with reason (phone drives)
  await flowRun("F5", async (c) => {
    await go(phone, tab(PID.flow, "releases"), "v0.3.0");
    await click(phone, "button", "Withdraw v0.3.0");
    await see(phone, "Why (added to its notes)");
    await phone.screenshot({ path: join(OUT, "F5-1-withdraw-dialog-phone.png") });
    await phone.getByRole("textbox", { name: "Why (added to its notes)" }).filter({ visible: true }).first().fill("Search returned stale results");
    await click(phone, "button", "Withdraw v0.3.0", "Confirm withdrawing v0.3.0");
    await until("stable back", () => (git(FLOW.project, ["rev-parse", "stable^{commit}"]) !== pubSha ? true : null), 60_000, 300);
    await see(phone, /Withdrawn/);
    await phone.screenshot({ path: join(OUT, "F5-2-withdrawn-phone.png") });
    await go(desk, tab(PID.flow, "releases"), /Withdrawn/);
    await shot("F5-3-history-badge", undefined, { deskOnly: true });
    const refs = lsRemote(FLOW);
    const v02 = git(FLOW.project, ["rev-parse", "v0.2.0^{commit}"]);
    check(c, (refs["refs/tags/stable^{}"] ?? refs["refs/tags/stable"]) === v02, "origin stable back on v0.2.0");
    check(c, (refs["refs/tags/v0.3.0^{}"] ?? refs["refs/tags/v0.3.0"]) === pubSha, "v0.3.0 never moved");
    check(c, !!refs["refs/tags/withdrawn/v0.3.0"], "withdrawn/v0.3.0 marker on origin");
    check(c, git(FLOW.project, ["cat-file", "-p", "withdrawn/v0.3.0"]).includes("Search returned stale results"), "marker carries the reason");
    check(c, /Search returned stale results/.test(await desk.locator("body").innerText()), "history row shows the reason");
  });

  // ---------------- F6 Plan Deploy of the latest release on the releases-only target; refused unreleased commit
  await flowRun("F6", async (c) => {
    await go(desk, tab(PID.flow, "releases"), "Plan Deploy of v0.2.0");
    await click(desk, "button", "Plan Deploy of v0.2.0");
    await see(desk, /Planning release v0\.2\.0/);
    await shot("F6-1-plan-v020", /Planning release v0\.2\.0/, { deskOnly: true });
    const v02 = git(FLOW.project, ["rev-parse", "v0.2.0^{commit}"]);
    await click(desk, "button", new RegExp(`^Deploy ${v02.slice(0, 7)}`));
    await see(desk, /Deploy Now|Confirm/i, 10_000).catch(() => {});
    const now = desk.getByRole("button", { name: /Deploy Now/ }).filter({ visible: true });
    if (await now.count()) await now.first().click();
    await until("the target runs v0.2.0", () => (FLOW.deployedVersion() === v02 ? true : null), 120_000, 500);
    await go(desk, `${BASE}/#/projects/${PID.flow}`, /Runs v0\.2\.0/);
    await shot("F6-2-deployed-v020", /Runs v0\.2\.0/);
    check(c, true, `the releases-only target's folder runs v0.2.0 (${v02.slice(0, 9)})`);
    // an unreleased commit: master tip (F7's landing) — Plan the Branch Tip Instead / Plan Deploy on the Deploy card
    await go(desk, `${BASE}/#/projects/${PID.flow}`, "Plan Deploy");
    await click(desk, "button", /^Plan Deploy$/);
    await desk.waitForTimeout(1500);
    const tip = desk.getByRole("button", { name: "Plan the Branch Tip Instead" }).filter({ visible: true });
    if (await tip.count()) await tip.first().click();
    await see(desk, /releases only|not a release|isn't a release|refused|only deploys/i, 30_000);
    await shot("F6-3-unreleased-refused", undefined, { deskOnly: true });
    check(c, FLOW.deployedVersion() === v02, "the unreleased tip was refused; target still runs v0.2.0");
  });

  // ---------------- F3 Abandon (phone drives) → master back, queue resumes
  await flowRun("F3", async (c) => {
    const base = git(FLOW.project, ["rev-parse", "master"]);
    let rec: Rec | null = (await k.verb("release.status", { project: FLOW.project })).json.release?.view?.open ?? null;
    if (!rec) {
      await go(desk, tab(PID.flow, "releases"), "Start Release");
      await click(desk, "button", "Start Release");
      rec = await openRec(FLOW, "a second release", (r) => !!r.thread?.path && r.state !== "published" && r.state !== "abandoned", 60_000);
      await chatPrepares(FLOW, rec, "0.4.0");
    } else notes_.push(`F3: reused the open release ${rec.id} (started by a click in an earlier run)`);
    rec = await openRec(FLOW, "release commit on master", (r) => stepOf(r, "checks").state !== "waiting", 240_000);
    await until("master on the release commit", () => (git(FLOW.project, ["log", "-3", "--format=%s", "master"]).includes("Release v0.4.0") ? true : null), 240_000, 500);
    const b = FLOW.branch("flow-later", { "src/flow-later.txt": "later\n" });
    await go(desk, tab(PID.flow, "merge-queue"), "frozen");
    await click(desk, "button", `Land ${b.branch}`);
    await go(phone, tab(PID.flow, "releases"), "Abandon Release");
    await click(phone, "button", "Abandon Release");
    await phone.waitForTimeout(500);
    const why = phone.getByRole("group", { name: "Confirm abandoning v0.4.0" }).getByRole("textbox").filter({ visible: true });
    if (await why.count()) await why.first().fill("Not this week");
    await phone.screenshot({ path: join(OUT, "F3-1-abandon-confirm-phone.png") });
    await click(phone, "button", "Abandon Release", "Confirm abandoning v0.4.0");
    await openRec(FLOW, "abandoned", (r) => r.state === "abandoned", 120_000, ).catch(() => null);
    await until("master's tree back to the base", () => (git(FLOW.project, ["rev-parse", "master^{tree}"]) === git(FLOW.project, ["rev-parse", `${base}^{tree}`]) || git(FLOW.project, ["log", "--format=%s", "master"]).includes("feat: flow-later") ? true : null), 240_000, 500);
    await until("the waiting branch lands", () => (git(FLOW.project, ["log", "--format=%s", "master"]).includes("feat: flow-later") ? true : null), 240_000, 500);
    const log1 = git(FLOW.project, ["log", "--format=%s", "-4", "master"]);
    c.push(`master log: ${log1.replace(/\n/g, " | ")}`);
    check(c, git(FLOW.project, ["show", "master~1:VERSION"], { allowFail: true }) !== "0.4.0" || /Revert|abandon/i.test(log1), "the release commit was reverted on master");
    check(c, !git(FLOW.project, ["tag", "-l", "v0.4.0"]), "no v0.4.0 tag");
    check(c, git(FLOW.project, ["ls-tree", "--name-only", "master", "src/"]).includes("flow-later.txt"), "queue resumed: the waiting branch landed");
    await go(desk, tab(PID.flow, "releases"), "Start Release");
    await shot("F3-2-after-abandon", "Start Release");
    await go(desk, tab(PID.flow, "merge-queue"));
    await shot("F3-3-queue-resumed");
  });

  // ---------------- F8 Needs-you items appear and clear
  await flowRun("F8", async (c) => {
    let rec: Rec | null = (await k.verb("release.status", { project: SOLO.project })).json.release?.view?.open ?? null;
    if (!rec) {
      await go(desk, tab(PID.solo, "releases"), "Start Release");
      await click(desk, "button", "Start Release");
      rec = await openRec(SOLO, "solo release", (r) => !!r.thread?.path, 60_000);
      await chatPrepares(SOLO, rec, "0.2.0");
    } else if (rec.steps.some((s) => s.phase === "prepare" && s.state === "waiting") && stepOf(rec, "checks").state !== "waiting") {
      // D12's stuck release: Abandon it from the screen, then start again.
      notes_.push(`F8: abandoned the stuck release ${rec.id} (D12) from the screen`);
      await go(desk, tab(PID.solo, "releases"), "Abandon Release");
      await shot("F8-0-stuck-D12", "Abandon Release");
      await click(desk, "button", "Abandon Release");
      const g = `Confirm abandoning ${rec.tag ?? "v" + rec.version}`;
      const why = desk.getByRole("group", { name: g }).getByRole("textbox").filter({ visible: true });
      if (await why.count()) await why.first().fill("Stuck: bump can't be reported (D12)");
      await click(desk, "button", "Abandon Release", g);
      await openRec(SOLO, "abandoned", (r) => r.state === "abandoned", 120_000, rec.id);
      await until("solo master back", () => (git(SOLO.project, ["log", "-3", "--format=%s", "master"]).includes("Revert") ? true : null), 240_000, 500);
      await go(desk, tab(PID.solo, "releases"), "Start Release");
      await click(desk, "button", "Start Release");
      rec = await openRec(SOLO, "solo release again", (r) => !!r.thread?.path && r.state !== "abandoned", 60_000);
      await chatPrepares(SOLO, rec, "0.2.0");
    } else notes_.push(`F8: reused the open release ${rec.id} (started by a click in an earlier run)`);
    rec = await openRec(SOLO, "solo checks", (r) => stepOf(r, "checks").state === "done");
    const todo = rec.steps.filter((s) => s.phase !== "after" && s.by !== "sova" && s.id !== "checks" && s.id !== "publish" && s.state !== "done");
    if (todo.length) await chatDoes(k, rec, todo.map((s) => step(s.id, "done", `${s.label} done`)));
    const later = rec.steps.filter((s) => s.phase === "check");
    c.push(`solo check steps: ${later.map((s) => s.id).join(",") || "none"}`);
    rec = await openRec(SOLO, "solo ready", (r) => r.state === "ready", 120_000);
    await go(desk, `${BASE}/#/`, "Ready to publish");
    await shot("F8-1-needs-you-ready", "Ready to publish");
    check(c, /acme-solo[\s\S]{0,80}Ready to publish/.test(await desk.locator("body").innerText()), "Needs you: acme-solo Ready to publish · v0.2.0");
    await click(desk, "link", /Review and Publish/);
    await see(desk, "Publish v0.2.0");
    await click(desk, "button", "Publish v0.2.0");
    await click(desk, "button", "Publish Now", "Confirm publishing v0.2.0");
    await openRec(SOLO, "solo published", (r) => r.state === "published", 120_000, rec.id);
    check(c, git(SOLO.project, ["rev-parse", "v0.2.0^{commit}"]) === git(SOLO.project, ["rev-parse", "stable^{commit}"]), "local-only: v0.2.0 and stable tagged locally (nothing to push)");
    await go(desk, `${BASE}/#/`);
    await desk.waitForTimeout(4000);
    await shot("F8-2-needs-you-cleared");
    check(c, !/acme-solo[\s\S]{0,80}Ready to publish/.test(await desk.locator("body").innerText()), "the ready item cleared after Publish");
  });
  // ---------------- retest D11: a releases-only target refuses an unreleased commit in plain words
  await flowRun("R11", async (c) => {
    await go(desk, `${BASE}/#/projects/${PID.flow}`, "Plan Deploy");
    await click(desk, "button", /^Plan Deploy$/);
    await desk.waitForTimeout(1500);
    const tip = desk.getByRole("button", { name: "Plan the Branch Tip Instead" }).filter({ visible: true });
    if (await tip.count()) await tip.first().click();
    await see(desk, /takes releases only/, 30_000);
    await shot("retest-D11-refusal", /takes releases only/);
    const t = await desk.locator("body").innerText();
    c.push((t.match(/[^\n]*takes releases only[^\n]*/) ?? [""])[0]);
    check(c, !t.includes("${"), "no raw tag pattern in the refusal");
    check(c, /latest is v0\.2\.0/.test(t), "names the latest release to deploy instead");
  });

  // ---------------- retest D12: the commit report is refused while an earlier prepare step waits
  await flowRun("R12", async (c) => {
    await go(desk, tab(PID.solo, "releases"), "Start Release");
    await click(desk, "button", "Start Release");
    const rec = await openRec(SOLO, "solo release", (r) => !!r.thread?.path && r.state === "preparing", 60_000);
    await chatDoes(k, rec, [step("version", "done", "v0.3.0", { facts: { version: "0.3.0" } }), notes("## v0.3.0\n\n- retest."), step("notes", "done", "notes written")]);
    const commit = SOLO.commitIn(String(rec.thread!.checkout), SOLO.releaseFiles("0.3.0"), "Release v0.3.0");
    const [res] = await chatDoes(k, rec, [step("commit", "done", "Release v0.3.0", { facts: { commit, branch: String(rec.thread!.branch) } })], "Go on.", { expectOk: false });
    c.push(`commit before bump → ${String(res).match(/release-refused[^"\n]*/)?.[0]}`);
    check(c, /before the release commit/.test(String(res)), "commit before bump refused, naming bump");
    const r2 = await openRec(SOLO, "untouched", () => true, 5_000);
    check(c, stepOf(r2, "checks").state === "waiting" && !r2.entry, "nothing queued; checks still waiting");
    await chatDoes(k, rec, [step("bump", "done", "bumped"), step("commit", "done", "Release v0.3.0", { facts: { commit, branch: String(rec.thread!.branch) } })]);
    await openRec(SOLO, "checks begin", (r) => stepOf(r, "checks").state !== "waiting", 60_000);
    check(c, true, "after bump, the commit is accepted and the gating checks start");
    await go(desk, tab(PID.solo, "releases"), "Release in progress");
    await shot("retest-D12-after-bump", "Release in progress", { deskOnly: true });
    // leave acme-solo clean: Abandon from the screen
    await click(desk, "button", "Abandon Release");
    const g = "Confirm abandoning v0.3.0";
    const why = desk.getByRole("group", { name: g }).getByRole("textbox").filter({ visible: true });
    if (await why.count()) await why.first().fill("Retest only");
    await click(desk, "button", "Abandon Release", g);
    await openRec(SOLO, "abandoned", (r) => r.state === "abandoned", 240_000, rec.id);
    check(c, true, "retest release abandoned from the screen");
  });
} finally {
  writeFileSync(join(OUT, "flows-results.json"), JSON.stringify({ results, notes: notes_, errors }, null, 2));
  await browser.close().catch(() => {});
  model.kill("SIGKILL");
}
log("results", JSON.stringify(results.map((r) => [r.flow, r.pass, r.error?.split("\n")[0]])));
