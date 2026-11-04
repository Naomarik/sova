#!/usr/bin/env node
// Sova's merge thread: what the live server owes after landings, and the restart itself
// (PLAYBOOK.md "When the queue is idle"). Prints one JSON object per call and exits 0 whatever it found
// (2: bad usage). Runs on Bun or Node 23.6+ (it imports server/restart-paths.ts from the repo it reads).
//
//   bun restart-sova.mjs plan    [--repo <main checkout>] [--target master] [--health <url> | --live <sha>]
//     {action: "restart" | "build" | "nothing" | "unknown", install, live, tip, restart[], build[], why}
//     live: the commit the running server started on (GET /api/health head); tip: the target's head.
//     The landed files are `git diff live..tip`, read with that tip's own rule (server/restart-paths.ts); a
//     package.json whose only change is its top-level version (a release's bump) doesn't count.
//     --live names the running commit instead of asking the server.
//   bun restart-sova.mjs build   [--repo <main checkout>] [--install]
//     {ok, step: "install" | "build", tail}: pnpm install --frozen-lockfile (with --install), then pnpm run build.
//   bun restart-sova.mjs restart --expect <sha> [--timeout 60] [--health <url>] [--unit sova-runtime.service]
//     {ok, head, startedAt, why}: restarts the service (Linux: systemctl --user restart <unit>; macOS:
//     launchctl kickstart -k gui/<uid>/sova-runtime), then waits until health answers with head == expect
//     and a new startedAt.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const DEFAULT_REPO = resolve(HERE, "..", "..", "..", "..");
const DEFAULT_HEALTH = "http://127.0.0.1:4800/api/health";

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) out._.push(a);
    else if (a === "--install") out.install = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

const say = (o) => process.stdout.write(`${JSON.stringify(o, null, 2)}\n`);

function git(repo, ...a) {
  const r = spawnSync("git", a, { cwd: repo, encoding: "utf8" });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

async function health(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const j = await res.json();
    return j && typeof j.head === "string" ? { head: j.head, startedAt: j.startedAt ?? null } : null;
  } catch {
    return null;
  }
}

export async function plan(o) {
  const repo = resolve(o.repo ?? DEFAULT_REPO);
  const target = o.target ?? "master";
  const live = o.live ? { head: o.live, startedAt: null } : await health(o.health ?? DEFAULT_HEALTH);
  const tip = git(repo, "rev-parse", `refs/heads/${target}`);
  const base = { action: "unknown", install: false, live: live?.head ?? null, tip: tip.ok ? tip.out : null, restart: [], build: [] };
  if (!tip.ok) return { ...base, why: `no ${target} in ${repo}` };
  if (!live) return { ...base, why: "the live server didn't answer GET /api/health: it is down or restarting; systemd starts it again on its own" };
  const head = git(repo, "rev-parse", "HEAD");
  if (!head.ok || head.out !== tip.out) return { ...base, why: `the main checkout is at ${head.out.slice(0, 7) || "?"}, not ${target}'s ${tip.out.slice(0, 7)}: Sova moves it with each landing, so wait for the next idle` };
  if (live.head === tip.out) return { ...base, action: "nothing", why: "the live server already runs the target's head" };
  let mod;
  try {
    mod = await import(pathToFileURL(join(repo, "server", "restart-paths.ts")).href);
  } catch (err) {
    return { ...base, why: `server/restart-paths.ts didn't load (${err?.message ?? err})` };
  }
  if (!git(repo, "cat-file", "-e", `${live.head}^{commit}`).ok) {
    return { ...base, action: "restart", install: true, why: `the live server's commit ${live.head.slice(0, 7)} isn't in this repository: restart, installing first` };
  }
  const diff = git(repo, "diff", "--name-only", "--no-renames", live.head, tip.out);
  if (!diff.ok) return { ...base, why: `git diff failed: ${diff.err}` };
  const files = diff.out.split("\n").map((l) => l.trim()).filter(Boolean);
  // A release's own commit bumps package.json's version only: that owes no install and no restart.
  const versionOnly = [];
  if (files.includes("package.json") && typeof mod.onlyVersionBumped === "function") {
    const before = git(repo, "show", `${live.head}:package.json`);
    const after = git(repo, "show", `${tip.out}:package.json`);
    if (before.ok && after.ok && mod.onlyVersionBumped(before.out, after.out)) versionOnly.push("package.json");
  }
  const p = mod.restartPlan(files, { versionOnly });
  const ahead = git(repo, "merge-base", "--is-ancestor", live.head, tip.out).ok;
  return {
    ...base,
    action: p.action,
    install: p.install,
    restart: p.restart.slice(0, 20),
    build: p.build.slice(0, 20),
    counts: { files: files.length, restart: p.restart.length, build: p.build.length },
    why:
      (p.action === "restart"
        ? `${p.restart.length} landed file(s) the server only loads at its start`
        : p.action === "build"
          ? `${p.build.length} landed file(s) of the page only`
          : "nothing landed that the server or the page loads") + (ahead ? "" : ` (the live commit isn't an ancestor of ${target}: compared tree to tree)`),
  };
}

function run(cmd, a, cwd, timeoutMs) {
  const r = spawnSync(cmd, a, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const tail = text.split("\n").filter(Boolean).slice(-40).join("\n");
  if (r.error) return { ok: false, tail: `${cmd}: ${r.error.message}\n${tail}` };
  return { ok: r.status === 0, tail };
}

export function build(o) {
  const repo = resolve(o.repo ?? DEFAULT_REPO);
  if (!existsSync(join(repo, "package.json"))) return { ok: false, step: "build", tail: `no package.json in ${repo}` };
  if (o.install) {
    const i = run("pnpm", ["install", "--frozen-lockfile"], repo, 15 * 60_000);
    if (!i.ok) return { ok: false, step: "install", tail: i.tail };
  }
  const b = run("pnpm", ["run", "build"], repo, 20 * 60_000);
  return { ok: b.ok, step: "build", tail: b.tail };
}

export async function restart(o) {
  const expect = o.expect;
  if (!expect || !/^[0-9a-f]{7,40}$/.test(expect)) return { ok: false, head: null, startedAt: null, why: "name the commit to expect: --expect <sha>" };
  const url = o.health ?? DEFAULT_HEALTH;
  const timeoutMs = Math.max(5, Number(o.timeout ?? 60)) * 1000;
  const before = await health(url);
  const r =
    process.platform === "darwin"
      ? run("launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${o.label ?? "sova-runtime"}`], undefined, 150_000)
      : run("systemctl", ["--user", "restart", o.unit ?? "sova-runtime.service"], undefined, 150_000);
  if (!r.ok) return { ok: false, head: before?.head ?? null, startedAt: before?.startedAt ?? null, why: `the restart command failed: ${r.tail || "no output"}` };
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await health(url);
    if (last && last.head.startsWith(expect) && (!before || last.startedAt !== before.startedAt)) return { ok: true, head: last.head, startedAt: last.startedAt, why: "back on the expected commit" };
    await new Promise((done) => setTimeout(done, 1000));
  }
  return {
    ok: false,
    head: last?.head ?? null,
    startedAt: last?.startedAt ?? null,
    why: last ? `it answers on ${last.head.slice(0, 7)}${before && last.startedAt === before.startedAt ? " without having restarted" : ""}, not ${expect.slice(0, 7)}` : `it didn't answer within ${timeoutMs / 1000} s`,
  };
}

const self = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (self) {
  const o = args(process.argv.slice(2));
  const cmd = o._[0];
  if (cmd === "plan") say(await plan(o));
  else if (cmd === "build") say(build(o));
  else if (cmd === "restart") say(await restart(o));
  else {
    process.stderr.write("usage: restart-sova.mjs plan|build|restart [--repo <dir>] [--target <branch>] [--health <url> | --live <sha>] [--install] [--expect <sha>] [--timeout <s>] [--unit <unit>]\n");
    process.exit(2);
  }
}
