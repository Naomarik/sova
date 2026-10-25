// A private Sova server for one e2e walkthrough: a scratch agent dir built like dev:hermetic's
// (scripts/hermetic-agent-dir.mjs), the app this worktree built (`pnpm run build`), a free port, and
// with `fakeClaude` scripts/fake-claude.mjs as its `claude`, signed in through a fixture login dir
// (CLAUDE_CONFIG_DIR). Nothing in ~/.pi, the worktree's .agent or the user's systemd is touched:
// chats run as detached processes recorded in the scratch dir, from this checkout.
//
//   const sova = await selfHosted({ fakeClaude: true });   // { base, port, agent, stop }
//   try { … } finally { await sova.stop(); }
//
// `stop()` (also run on SIGINT and SIGTERM) stops the server, then every chat it started
// (scripts/stop-chats.ts), and removes the scratch dir. It is idempotent.

import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A port nothing listens on now (bound and released on loopback). */
const freePort = () =>
  new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });

/** The server's env: the caller's, minus anything that names a real login, key, agent dir or Sova knob. */
function serverEnv(extra) {
  const keep = new Set(["SOVA_RUNTIME", "SOVA_BUN", "SOVA_NODE"]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith("CLAUDE") && !/_API_KEY$|_AUTH_TOKEN$/.test(k) && !(k.startsWith("SOVA_") && !keep.has(k)) && k !== "PI_CODING_AGENT_DIR" && k !== "PORT"),
  );
  return { ...env, ...extra };
}

export async function selfHosted({ fakeClaude = false, label = "e2e" } = {}) {
  if (!existsSync(join(ROOT, "dist", "index.html"))) throw new Error(`no built app in ${join(ROOT, "dist")}: run pnpm run build first`);
  const scratch = mkdtempSync(join(tmpdir(), `sova-${label}-`));
  const homePi = join(homedir(), ".pi");
  if (scratch === homePi || scratch.startsWith(homePi + "/")) throw new Error(`refusing a scratch dir inside ~/.pi: ${scratch}`);
  const agent = join(scratch, "agent");
  const log = join(scratch, "server.log");
  let child = null;
  let stopped = null;

  const stop = () =>
    (stopped ??= (async () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill("SIGTERM");
        await Promise.race([exited, sleep(10000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      // Chats outlive their server (§app.chat-processes): stop the ones it recorded, through its records.
      if (existsSync(agent)) {
        try {
          const bun = execFileSync(process.execPath, [join(ROOT, "server", "runtime-choice.ts"), "launch"], { cwd: ROOT, encoding: "utf8" }).split("\n")[1]?.trim() || "bun";
          execFileSync(bun, [join(ROOT, "scripts", "stop-chats.ts"), "--agent-dir", agent], { cwd: ROOT, stdio: "ignore", env: serverEnv({}) });
        } catch (err) {
          console.error(`self-hosted: stop-chats failed (${String(err?.message ?? err).split("\n")[0]}); chats of ${agent} may still run`);
        }
      }
      rmSync(scratch, { recursive: true, force: true });
    })());
  const onSignal = (sig) => {
    void stop().finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    execFileSync(process.execPath, [join(ROOT, "scripts", "hermetic-agent-dir.mjs")], { cwd: ROOT, env: { ...process.env, HERMETIC_AGENT_DIR: agent }, stdio: "pipe" });
    const port = await freePort();
    const extra = {
      PORT: String(port),
      PI_CODING_AGENT_DIR: agent,
      // No network: no price fetch, no usage poll.
      SOVA_PRICES_FETCH: "off",
      SOVA_USAGE_POLL: "off",
      // Chats as detached processes recorded under the agent dir (never units on the user's bus),
      // run from this checkout (no copy of the code per server).
      SOVA_CHAT_DRIVER: "detached",
      SOVA_CHAT_CODE: "live",
    };
    if (fakeClaude) {
      // The shim goes into the scratch dir (fake-claude-path.sh writes under $TMPDIR).
      const bin = execFileSync(join(ROOT, "scripts", "fake-claude-path.sh"), [], { cwd: ROOT, env: { ...process.env, TMPDIR: scratch }, encoding: "utf8" }).trim();
      // The login the fake answers on (it needs only .credentials.json there).
      const login = join(scratch, "claude-login");
      mkdirSync(login, { recursive: true });
      writeFileSync(join(login, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "fake", refreshToken: "fake", expiresAt: Date.now() + 8 * 3600_000 } }), { mode: 0o600 });
      writeFileSync(join(login, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { emailAddress: `${label}@example.invalid` } }));
      Object.assign(extra, { PATH: `${bin}:${process.env.PATH ?? ""}`, CLAUDE_CONFIG_DIR: login });
    }
    const fd = openSync(log, "a");
    child = spawn(join(ROOT, "scripts", "start-server.sh"), [], { cwd: ROOT, env: serverEnv(extra), stdio: ["ignore", fd, fd] });
    closeSync(fd);
    const base = `http://127.0.0.1:${port}`;
    const until = Date.now() + 60000;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`the server exited (${child.exitCode ?? child.signalCode}) before answering /api/health`);
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {}
      if (Date.now() > until) throw new Error(`${base}: no /api/health answer within 60 s`);
      await sleep(250);
    }
    return { base, port, agent, stop };
  } catch (err) {
    let tail = "";
    try {
      tail = readFileSync(log, "utf8").split("\n").slice(-30).join("\n");
    } catch {}
    await stop();
    throw new Error(`${err?.message ?? err}${tail ? `\n--- server log (last lines) ---\n${tail}` : ""}`);
  }
}
