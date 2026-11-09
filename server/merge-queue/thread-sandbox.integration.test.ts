// The merge thread under its sandbox (the sandbox extension's read-only level, its cwd never writable): its own
// commands write nowhere but their temp folder (a commit in the main checkout fails, a scratch clone there works), and
// what it needs outside goes through the merge verbs Sova runs: merge.restart against a STAND-IN unit (never
// sova-runtime.service: the unit, the process check and the restart are all stood in), whose next start sees the
// expected head through merge.live. Real git and the real OS sandbox; nothing restarts.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MERGE_THREAD_FLAGS } from "../chat-manager";
import { extensionFlagValues } from "../harness/pi/open";
import { prepareSessionCommand } from "../../pi-config/extensions/sandbox/session-policy.ts";
import type { Caller } from "../project-services/engine";
import { realGit } from "./guard";
import { checkRestartAtStart, type RestartDeps, restartQueueOf } from "./restart";
import { merger } from "./routes";
import { makeKit, sh } from "./testing/queue-kit";

const STANDIN = `sova-standin-${process.pid}.service`;

function run(argv: string[], cwd: string, env?: Record<string, string>): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const p = spawn(argv[0]!, argv.slice(1), { cwd, env: env ?? process.env });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => done({ code, out }));
  });
}

test("the thread's start flags: sandbox On, read-only level, the cwd never writable", () => {
  const flags = extensionFlagValues(MERGE_THREAD_FLAGS);
  assert.equal(flags.get("sandbox"), "on");
  assert.equal(flags.get("sandbox-read-only"), true);
  assert.equal(flags.get("sandbox-cwd-not-writable"), true);
});

test("a sandboxed thread can't write the main checkout but can clone into its tmp; merge.restart restarts only the stand-in unit and the next start sees the expected head", async (t) => {
  const k = makeKit();
  try {
    const root = k.repo.root;
    // Under the thread's policy, through the same launcher the chat's own commands use.
    const agentDir = join(k.repo.scratch, "agent");
    // The shipped policy (workspace-write): the thread's flag is what makes it read-only.
    cpSync(join(import.meta.dirname, "..", "..", "pi-config", "sandbox-policy"), join(agentDir, "sandbox-policy"), { recursive: true });
    const tryConfined = async (script: string) => {
      const prepared = await prepareSessionCommand({ agentDir, cwd: root, sessionId: `thread-${process.pid}`, cwdWritable: false, readOnly: true }, ["/bin/sh", "-c", script]);
      if (!prepared.ok) return { skipped: prepared.error ?? "unknown" };
      try {
        return { ...(await run(prepared.value.argv, root, prepared.value.env)), tmp: prepared.value.env?.TMPDIR };
      } finally {
        await prepared.value.dispose();
      }
    };
    const write = await tryConfined('git -c user.name=t -c user.email=t@t.invalid commit -q --allow-empty -m escape && echo WROTE');
    // Only a machine without the OS sandbox (no bwrap / Seatbelt) skips this half; the policy is in policy.unit.test.ts.
    if ("skipped" in write) {
      assert.match(write.skipped ?? "", /bwrap|sandbox-exec|unavailable|not found|namespace/i, `the sandbox couldn't be prepared: ${write.skipped}`);
      t.diagnostic(`OS sandbox unavailable here (${write.skipped})`);
    }
    else {
      assert.notEqual(write.code, 0, `a commit in the main checkout must fail: ${write.out}`);
      assert.ok(!write.out.includes("WROTE"));
      const clone = await tryConfined(`git clone -q --shared --no-checkout "${root}" "\${TMPDIR:-/tmp}/try" && git -C "\${TMPDIR:-/tmp}/try" checkout -q --detach HEAD && echo CLONED && rm -rf "\${TMPDIR:-/tmp}/try"`);
      assert.ok(!("skipped" in clone));
      assert.equal(clone.code, 0, clone.out);
      assert.match(clone.out, /CLONED/);
    }
    // Something the server loads at its start lands on master.
    const live = sh(root, "rev-parse", "HEAD");
    mkdirSync(join(root, "server"), { recursive: true });
    writeFileSync(join(root, "server", "a.ts"), "export {};\n");
    sh(root, "add", "server/a.ts");
    sh(root, "commit", "-q", "-m", "server");
    const tip = sh(root, "rev-parse", "HEAD");
    let start = { startedAt: "2026-11-07T10:00:00.000Z", head: live as string | null };
    const scheduled: string[] = [];
    const ran: string[][] = [];
    const deps: RestartDeps = {
      git: realGit,
      start: () => start,
      checkout: () => root,
      unitOf: async () => STANDIN,
      runsAs: async (unit) => unit === STANDIN,
      schedule: async (unit) => (scheduled.push(unit), null),
      run: async (argv) => (ran.push(argv), { code: 0, timedOut: false, aborted: false, ms: 1, out: "built" }),
    };
    const thread = "thread-1";
    const call = merger({
      queues: k.queues,
      served: { isListed: () => true, served: async () => true, bareView: async () => { throw new Error("served"); } },
      rootOf: async () => root,
      isThreadChat: (r, sid) => r === root && sid === thread,
      restart: deps,
    });
    const me: Caller = { kind: "session", id: thread, root, own: [] };
    assert.equal((await call("merge.live", { project: root }, me)).merge!.live!.plan.action, "restart");
    const r = await call("merge.restart", { project: root }, me);
    assert.equal(r.ok, true, r.error?.message);
    assert.equal(r.merge!.restart!.outcome, "restarting", r.merge!.restart!.why);
    assert.equal(r.merge!.restart!.expect, tip);
    assert.deepEqual(scheduled, [STANDIN], "only the stand-in unit");
    assert.ok(!scheduled.includes("sova-runtime.service"));
    assert.deepEqual(ran.at(-1), ["pnpm", "run", "build"]);
    // The stand-in unit's next start runs the tip: it checks the record, and merge.live says so.
    start = { startedAt: "2026-11-07T10:05:00.000Z", head: tip };
    const q = await k.q();
    assert.deepEqual(await checkRestartAtStart(restartQueueOf(q), deps), { ok: true, expect: tip, head: tip });
    const after = (await call("merge.live", { project: root }, me)).merge!.live!;
    assert.equal(after.head, tip);
    assert.equal(after.plan.action, "nothing");
    assert.equal(q.holdNow(), null, "the hold is lifted");
  } finally {
    await k.done();
  }
});
