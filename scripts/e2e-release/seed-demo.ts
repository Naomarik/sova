#!/usr/bin/env bun
/**
 * Seeds Release demo data into ONE running Sova copy (a branch's own instance, never the live server), for the UI
 * screen pass. Every chat it causes talks to the scripted stand-in model, bound for the run on the port of a local
 * provider the copy already lists (default ollama's 11434, which must be free), and the copy's new-session default
 * is switched to that provider first. When this script ends the stand-in stops; a later chat turn then fails to
 * connect (no real model is ever called).
 *
 *   bun scripts/e2e-release/seed-demo.ts --url http://127.0.0.1:4820 --token-file <copy .agent>/sova/auth-token \
 *       --under <dir> [--model-port 11434] [--model ollama/qwen3:4b]
 *
 * Seeds three projects under <dir>/projects (each a git repo; the published ones with a bare origin beside them):
 *   acme-app   releases initialized with the maker's `init` defaults, extended with check-phase steps (try-live held,
 *              smoke, docs-check) and an after-step; v0.1.0…v0.3.0 with v0.3.0 withdrawn; a releases-only stand-in
 *              deploy target `site` running v0.2.0; 4 landings since; a release v0.4.0 in progress with steps done,
 *              held, failed and running; a branch waiting in the frozen merge queue.
 *   acme-ready the maker's defaults; a release v0.2.0 ready to publish.
 *   acme-fresh merge set up, releases not initialized.
 * Writes <dir>/seed.json (paths, ids).
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { git, ReleaseFixture, until } from "./fixtures";
import { chatDoes, mergeAdd, notes, ok, step, stepOf, waitEntry, waitRecord, type Rec } from "./flow";
import type { ModelAction, ModelLogEntry, ReleaseServer, VerbAnswer } from "./server-kit";

const args = process.argv.slice(2);
const opt = (k: string, d = "") => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1]! : d;
};
const BASE = opt("--url");
const TOKEN = readFileSync(opt("--token-file"), "utf8").trim();
const UNDER = resolve(opt("--under"));
const MODEL_PORT = Number(opt("--model-port", "11434"));
const MODEL = opt("--model", "ollama/qwen3:4b");
if (!BASE || !UNDER) throw new Error("--url, --token-file and --under are required");
if (/:(4800|4810)\b/.test(BASE)) throw new Error("never the live server or the default hermetic port");
for (const bad of [resolve(homedir(), ".pi"), resolve(homedir(), "webapps", "sova")]) if (UNDER === bad || UNDER.startsWith(bad + "/")) throw new Error(`refusing ${UNDER}`);
const MAKER = resolve(import.meta.dirname, "../../playbooks/release-maker/scripts/release-maker.mjs");
const log = (...a: unknown[]) => console.log("[seed]", ...a);

// ---- the stand-in model on the provider's port, for this run
const model = spawn("node", [join(import.meta.dirname, "scripted-model.mjs"), String(MODEL_PORT)], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise<void>((done, fail) => {
  model.stdout!.on("data", (d) => String(d).includes("listening") && done());
  model.once("exit", (c) => fail(new Error(`the stand-in model exited ${c} (port ${MODEL_PORT} taken?)`)));
});
const ctl = async (method: string, path: string, body?: unknown) => (await fetch(`http://127.0.0.1:${MODEL_PORT}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) })).json();

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

try {
  // ---- the copy's new-session default: the stand-in's provider (a pristine session's pick saves it)
  const probe = (await http("POST", "/api/sessions", { cwd: UNDER })).json as { id: string; path: string };
  const ws = new WebSocket(`${BASE.replace("http", "ws")}/ws/chat?path=${encodeURIComponent(probe.path)}&tail=rest&wire=2`, { headers: { "x-sova-token": TOKEN } } as never);
  const frames: any[] = [];
  ws.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data))));
  await until("the chat socket's hello", () => frames.some((f) => f.type === "hello"), 30_000);
  ws.send(JSON.stringify({ type: "set_model", ref: MODEL }));
  await until(`the model switch to ${MODEL}`, () => frames.some((f) => f.type === "model" && String(f.model).includes(MODEL.split("/")[1]!)), 30_000);
  ws.close();
  await http("POST", "/api/sessions/archive", { path: probe.path, archived: true });
  log("new-session default:", MODEL);

  const maker = (root: string, ...a: string[]) => {
    const r = spawnSync("node", [MAKER, ...a, "--root", root], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`release-maker ${a.join(" ")}: ${r.stdout}${r.stderr}`);
  };
  const commitAll = (fx: ReleaseFixture, msg: string) => {
    git(fx.project, ["add", "-A"]);
    git(fx.project, ["commit", "-q", "-m", msg]);
    git(fx.project, ["push", "-q", "origin", "master"]);
  };

  // ---- acme-app
  const app = new ReleaseFixture({ kind: "bare", name: "acme-app", under: join(UNDER, "projects"), versions: ["0.1.0", "0.2.0", "0.3.0"], deploy: { releasesOnly: true } });
  maker(app.project, "init");
  {
    const f = join(app.project, ".sova/playbooks/release/release.json");
    const m = JSON.parse(readFileSync(f, "utf8")) as { v: 1; steps: Array<Record<string, unknown>> };
    m.steps.push({ id: "try-live", label: "Try it on the staging copy", phase: "check", held: true }, { id: "smoke", label: "Smoke test the build", phase: "check" }, { id: "docs-check", label: "Check the docs links", phase: "check" }, { id: "page", label: "Release page", phase: "after" });
    writeFileSync(f, JSON.stringify(m));
    const pb = join(app.project, ".sova/playbooks/release/PLAYBOOK.md");
    writeFileSync(pb, `${readFileSync(pb, "utf8")}\n## This project's own steps\n\n- \`try-live\`: run it on the staging copy and wait for the operator's Continue.\n- \`smoke\`: smoke test the build.\n- \`docs-check\`: check the docs links.\n- \`page\`: make the release page.\n`);
  }
  maker(app.project, "fmt");
  maker(app.project, "check");
  commitAll(app, "Set up releases (release-maker init defaults, plus this project's check steps)");
  const ready = new ReleaseFixture({ kind: "bare", name: "acme-ready", under: join(UNDER, "projects"), versions: ["0.1.0"] });
  maker(ready.project, "init");
  maker(ready.project, "fmt");
  commitAll(ready, "Set up releases (release-maker init defaults)");
  const fresh = new ReleaseFixture({ kind: "bare", name: "acme-fresh", under: join(UNDER, "projects"), versions: ["0.1.0"] });

  const ids: Record<string, string> = {};
  for (const fx of [app, ready, fresh]) {
    const list = await http("GET", "/api/projects");
    const found = ((list.json.projects ?? []) as { root: string; id: string }[]).find((p) => p.root === fx.project);
    if (found) {
      ids[fx.name] = found.id;
      continue;
    }
    const made = await http("POST", "/api/projects", { root: fx.project, name: fx.name });
    if (made.status !== 201) throw new Error(`register ${fx.name}: ${made.status} ${JSON.stringify(made.json).slice(0, 300)}`);
    ids[fx.name] = made.json.project.id as string;
  }
  log("registered", ids);

  // ---- acme-app: v0.3.0 withdrawn; v0.2.0 deployed; landings since
  ok(await k.verb("release.withdraw", { project: app.project, tag: "v0.3.0", why: "Sign-in broke for SSO users", confirm: true }), "withdraw v0.3.0");
  const v020 = app.tagAt("v0.2.0")!;
  const planned = ok(await k.verb("deploy.plan", { project: app.project, target: "site", commit: v020 }), "deploy.plan v0.2.0");
  const dep = ok(await k.verb("deploy.run", { project: app.project, plan: planned.json.deploy.plan.planId, confirm: true }), "deploy.run").json.deploy.record.id as string;
  await until("the v0.2.0 deploy", async () => JSON.stringify((await k.verb("deploy.status", { project: app.project, target: "site" })).json).match(new RegExp(`"id":"${dep}"[^}]*?"state":"succeeded"`)), 120_000, 300);
  log("v0.3.0 withdrawn, v0.2.0 deployed to site");
  app.seedLandings(4);

  // ---- acme-app: v0.4.0 in progress, mixed step states
  ok(await k.verb("release.start", { project: app.project }), "start acme-app");
  let rec: Rec = await waitRecord(k, app, "acme-app's release chat", (r) => !!r.thread?.path);
  await chatDoes(k, rec, [step("version", "done", "v0.4.0 · adds features since v0.3.0", { facts: { version: "0.4.0" } }), notes("## v0.4.0\n\n- Search across projects.\n- Faster sign-in.\n- Fixes the SSO sign-in that v0.3.0 broke."), step("notes", "done", "notes written for people on v0.2.0")]);
  const co = String(rec.thread!.checkout);
  const commit = app.commitIn(co, app.releaseFiles("0.4.0", "- Search across projects.\n- Faster sign-in."), "Release v0.4.0");
  await chatDoes(k, rec, [step("commit", "done", "Release v0.4.0", { facts: { commit, branch: String(rec.thread!.branch) } })]);
  rec = await waitRecord(k, app, "acme-app's checks", (r) => stepOf(r, "checks").state === "done", 240_000);
  await chatDoes(k, rec, [
    step("try-live", "held", "running on the staging copy: try sign-in and search, then Continue"),
    step("smoke", "running", "smoke testing the build"),
    step("smoke", "failed", "smoke: /search answered 500 on an empty query", { detail: "GET /search?q= → 500\nexpected 200 with no results" }),
    step("docs-check", "running", "checking 214 links"),
  ]);
  const search = app.branch("search-ui", { "src/search.txt": "search ui\n" });
  const waiting = await mergeAdd(k, app, search.branch);
  await waitEntry(k, app, "the branch waiting on the release", (e) => e.id === waiting.id && /release/i.test(e.reason ?? ""), 60_000);
  log("acme-app v0.4.0 in progress", rec.id);

  // ---- acme-ready: v0.2.0 ready to publish
  ok(await k.verb("release.start", { project: ready.project }), "start acme-ready");
  let rr: Rec = await waitRecord(k, ready, "acme-ready's release chat", (r) => !!r.thread?.path);
  await chatDoes(k, rr, [step("version", "done", "v0.2.0 · adds features since v0.1.0", { facts: { version: "0.2.0" } }), notes("## v0.2.0\n\n- The first feature release."), step("notes", "done", "notes written")]);
  const rc = ready.commitIn(String(rr.thread!.checkout), ready.releaseFiles("0.2.0", "- The first feature release."), "Release v0.2.0");
  await chatDoes(k, rr, [step("commit", "done", "Release v0.2.0", { facts: { commit: rc, branch: String(rr.thread!.branch) } })]);
  rr = await waitRecord(k, ready, "acme-ready ready", (r) => r.state === "ready", 240_000);
  log("acme-ready ready", rr.id);

  const out = { url: BASE, model: MODEL, ids, projects: { "acme-app": app.project, "acme-ready": ready.project, "acme-fresh": fresh.project }, origins: { "acme-app": app.origin, "acme-ready": ready.origin }, deployTarget: app.deployTarget, releases: { "acme-app": rec.id, "acme-ready": rr.id }, waitingEntry: waiting.id, withdrawn: "v0.3.0" };
  writeFileSync(join(UNDER, "seed.json"), JSON.stringify(out, null, 2) + "\n");
  log("done", JSON.stringify(out));
} finally {
  model.kill("SIGKILL");
}
