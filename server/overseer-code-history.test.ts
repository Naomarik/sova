// sova_project_git and sova_server_log (§app.overseer/code-history): what may run, how git runs (no pager,
// external diff, textconv, hook, filter or index refresh), the cap, the action log and the server log's answers.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { Hono } from "hono";
import { scratchRoot } from "./test-scratch";

const tmp = realpathSync(scratchRoot("sova-code-history-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
mkdirSync(join(tmp, "agent", "sessions"), { recursive: true });

const ch = await import("./overseer-code-history");
const { registerProjectRoutes } = await import("./projects/routes");
const { closeAllOrgHosts } = await import("./org-engine");
const { overseerActionsFile } = await import("./overseer-store");
const { redactingTool } = await import("./overseer-redact");
after(() => closeAllOrgHosts());

const repo = join(tmp, "code", "acme");
mkdirSync(repo, { recursive: true });
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
git("init", "-q", "-b", "main");
writeFileSync(join(repo, "README.md"), "acme\n");
writeFileSync(join(repo, "app.ts"), "export const x = 1;\n");
git("add", ".");
git("commit", "-q", "-m", "first commit");
git("branch", "feat/x");
writeFileSync(join(repo, "app.ts"), "export const x = 2;\n");
git("commit", "-q", "-am", "second commit");
// A repository config that would run programs: a pager, an external diff, a textconv, an fsmonitor and a filter.
const marker = join(tmp, "ran");
const prog = join(tmp, "prog.sh");
writeFileSync(prog, `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
for (const [k, v] of [["core.pager", prog], ["diff.external", prog], ["core.fsmonitor", prog], ["diff.ts.textconv", prog], ["filter.evil.clean", prog], ["filter.evil.smudge", prog], ["log.showSignature", "true"], ["gpg.program", prog]]) git("config", k!, v!);
writeFileSync(join(repo, ".gitattributes"), "*.ts diff=ts filter=evil\n");
// A worktree edit, so status and diff have something to compare (and a clean filter something to run on).
writeFileSync(join(repo, "app.ts"), "export const x = 3;\n");
writeFileSync(join(repo, ".env"), "SECRET=1\n");
mkdirSync(join(tmp, "outside"), { recursive: true });
symlinkSync(join(tmp, "outside"), join(repo, "out-link"));

const app = new Hono();
registerProjectRoutes(app);
const made = await app.request("/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ root: repo, name: "Acme" }) });
assert.equal(made.status, 201, await made.clone().text());
const projectId = ((await made.json()) as { project: { id: string } }).project.id;

class Refusal extends Error {}
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required });
const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const int = (description: string, extra: Record<string, unknown> = {}) => ({ type: "integer", description, ...extra });

function tools(extra: Partial<Parameters<typeof ch.codeHistoryTools>[0]> = {}) {
  const [g, l] = ch.codeHistoryTools({ overseerId: () => "ov-test", refusal: (m) => new Refusal(m), obj, str, int, ...extra });
  return { git: g!, log: l! };
}
async function call(tool: { execute: unknown }, params: unknown): Promise<{ ok: boolean; text: string }> {
  try {
    const out = (await (tool.execute as (...a: unknown[]) => Promise<{ content: { text: string }[] }>)("tc1", params)) as { content: { text: string }[] };
    return { ok: true, text: out.content.map((c) => c.text).join("") };
  } catch (err) {
    return { ok: false, text: (err as Error).message };
  }
}
const lastLog = () => JSON.parse(readFileSync(overseerActionsFile(), "utf8").trim().split("\n").at(-1)!);

describe("sova_project_git: what runs (§app.overseer/code-history)", () => {
  const { git: tool } = tools();

  test("log, show, diff, branch, merge-base and status read the project's repository, by id or exact name", async () => {
    const log = await call(tool, { project: "Acme", command: "log", args: ["--oneline"] });
    assert.ok(log.ok, log.text);
    assert.match(log.text, /second commit[\s\S]*first commit/);
    assert.match((await call(tool, { project: projectId, command: "show", args: ["--stat", "HEAD"] })).text, /second commit/);
    assert.match((await call(tool, { project: "Acme", command: "diff", args: ["main~1", "main", "--", "app.ts"] })).text, /-export const x = 1;\n\+export const x = 2;/);
    const branches = await call(tool, { project: "Acme", command: "branch", args: ["-a"] });
    assert.match(branches.text, /feat\/x/);
    assert.match((await call(tool, { project: "Acme", command: "merge-base", args: ["main", "feat/x"] })).text, /[0-9a-f]{40}/);
    assert.match((await call(tool, { project: "Acme", command: "status", args: ["--short"] })).text, /M app\.ts/);
    assert.match((await call(tool, { project: "Acme", command: "branch", args: "--merged main" })).text, /feat\/x/, "args as one string");
  });

  test("it runs none of the repository's programs and writes nothing: no pager, external diff, textconv, fsmonitor, filter or signature check; status refreshes no index", async () => {
    const index = join(repo, ".git", "index");
    const before = statSync(index).mtimeMs;
    for (const [command, args] of [["status", []], ["diff", []], ["log", ["-p", "-2"]], ["show", ["HEAD"]]] as const) {
      const r = await call(tool, { project: "Acme", command, args });
      assert.ok(r.ok, r.text);
    }
    assert.equal(existsSync(marker), false, "no configured program ran");
    assert.equal(statSync(index).mtimeMs, before, "the index is untouched");
    // Control: the configured diff program does run when git is left to itself.
    execFileSync("git", ["diff"], { cwd: repo, stdio: "ignore" });
    assert.equal(existsSync(marker), true, "control: the stand-in program runs under a plain git diff");
  });

  test("write commands, writing branch options and options that write, run or point elsewhere are refused, naming what; nothing runs", async () => {
    for (const command of ["commit", "checkout", "reset", "stash", "push", "fetch", "worktree", "config", "tag", "rebase", "gc"]) {
      const r = await call(tool, { project: "Acme", command });
      assert.equal(r.ok, false, command);
      assert.match(r.text, new RegExp(`^git ${command} is refused`));
    }
    for (const a of [["-d", "feat/x"], ["-D", "feat/x"], ["-m", "feat/x", "y"], ["-c", "feat/x", "y"], ["-u", "origin/x"], ["--set-upstream-to=origin/x"], ["-f", "x"]]) {
      const r = await call(tool, { project: "Acme", command: "branch", args: a });
      assert.equal(r.ok, false, a.join(" "));
      assert.match(r.text, /refused/);
    }
    for (const a of ["-c", "-C", "--git-dir=/tmp", "--work-tree=/", "--exec-path=/tmp", `--output=${join(tmp, "o.txt")}`, "--ext-diff", "--textconv", "--no-index", "--show-signature", "--format=%G?"]) {
      const r = await call(tool, { project: "Acme", command: a === "--no-index" ? "diff" : "log", args: [a] });
      assert.equal(r.ok, false, a);
      assert.match(r.text, /refused/, a);
    }
    assert.equal(existsSync(join(tmp, "o.txt")), false);
    // A name never makes a branch: branch always lists.
    const listed = await call(tool, { project: "Acme", command: "branch", args: ["made-by-model"] });
    assert.ok(listed.ok, listed.text);
    assert.equal(git("branch", "--list", "made-by-model").trim(), "", "no branch was made");
    assert.equal(lastLog().tool, "sova_project_git");
  });

  test("a path outside the project root, through a symlink, or one the file guard denies is refused", async () => {
    for (const args of [["--", "/etc/passwd"], ["--", "../.."], ["--", "out-link/x"], ["HEAD:.env"], ["--", ".env"]]) {
      const r = await call(tool, { project: "Acme", command: args[0] === "HEAD:.env" ? "show" : "log", args });
      assert.equal(r.ok, false, args.join(" "));
      assert.match(r.text, /outside the project root|holds credentials/, args.join(" "));
    }
    assert.match((await call(tool, { project: "Nope", command: "log" })).text, /Nope/);
  });

  test("the action log names the project and command, never the output", async () => {
    await call(tool, { project: "Acme", command: "log", args: ["-1"] });
    const line = lastLog();
    assert.deepEqual([line.tool, line.args, line.outcome], ["sova_project_git", { project: "Acme", command: "log" }, "ok"]);
    assert.ok(!JSON.stringify(line).includes("second commit"));
  });

  test("the output is cut at 12,000 characters, saying so", () => {
    const long = "x".repeat(20_000);
    const out = ch.capOutput(long);
    assert.ok(out.length < 12_100);
    assert.match(out, /\[cut at 12,000 characters\]$/);
    assert.match(ch.capOutput(long, false, true), /^\[cut: only the newest 12,000 characters\]/);
    assert.equal(ch.capOutput("short"), "short");
  });

  test("through the Overseer's wrapper a secret in the output becomes [redacted]", async () => {
    const secret = `sk-ant-${"a1B2c3D4".repeat(5)}`;
    const { git: fake } = tools({ run: async (_cmd, args) => ({ code: 0, stdout: args.includes("config") ? "" : `token ${secret}\n`, stderr: "", cut: false }) });
    const wrapped = redactingTool(fake as never);
    const r = await call(wrapped, { project: "Acme", command: "log" });
    assert.ok(r.ok, r.text);
    assert.ok(!r.text.includes(secret) && r.text.includes("[redacted]"), r.text);
  });
});

describe("sova_server_log (§app.overseer/code-history)", () => {
  const ran: string[][] = [];
  const run: import("./overseer-code-history").Runner = async (cmd, args) => {
    ran.push([cmd, ...args]);
    return { code: 0, stdout: "2026-10-28T10:00:00+0000 host bun[1]: sova server on http://127.0.0.1:4800\n", stderr: "", cut: false };
  };

  test("reads its own unit's journal: 100 lines by default, at most 500", async () => {
    const { log } = tools({ run, platform: "linux", unit: () => "sova-runtime.service" });
    const r = await call(log, {});
    assert.ok(r.ok, r.text);
    assert.match(r.text, /^The newest 100 lines of sova-runtime\.service:\n.*sova server on/);
    assert.deepEqual(ran.at(-1), ["journalctl", "--user", "-u", "sova-runtime.service", "--no-pager", "-o", "short-iso", "-n", "100"]);
    assert.ok((await call(log, { lines: 500 })).ok);
    assert.equal(ran.at(-1)!.at(-1), "500");
    for (const lines of [0, 501, 2.5, "ten"]) assert.equal((await call(log, { lines })).ok, false, String(lines));
    assert.deepEqual(lastLog().args, { lines: "ten" });
  });

  test("macOS, no unit, no journalctl: a clear answer, nothing run", async () => {
    const before = ran.length;
    assert.equal((await call(tools({ run, platform: "darwin", unit: () => "x.service" }).log, {})).text, ch.LOG_MAC);
    assert.equal((await call(tools({ run, platform: "linux", unit: () => null }).log, {})).text, ch.LOG_NO_UNIT);
    assert.equal(ran.length, before);
    const missing = tools({ run: async () => ({ code: null, stdout: "", stderr: "", cut: false, missing: true }), platform: "linux", unit: () => "sova-runtime.service" });
    assert.equal((await call(missing.log, {})).text, ch.LOG_NO_JOURNAL);
  });

  test("its own unit comes from its cgroup", () => {
    assert.equal(ch.ownUnit(() => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/sova-runtime.service\n"), "sova-runtime.service");
    assert.equal(ch.ownUnit(() => "0::/user.slice/user-1000.slice/session-2.scope\n"), null);
    assert.equal(ch.ownUnit(() => "0::/system.slice/sova.service\n"), null, "a system unit isn't the user's journal");
    assert.equal(ch.ownUnit(() => {
      throw new Error("no proc");
    }), null);
  });
});
