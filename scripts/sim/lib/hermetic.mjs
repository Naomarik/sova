// A hermetic Sova server for the simulation: its own agent dir (built by
// scripts/hermetic-agent-dir.mjs, as `pnpm run dev:hermetic` builds .agent), the user's pi auth.json
// copied in by hand, its own port and share-listener port. Never the live server, never ~/.pi.
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

/** This process's environment minus what belongs to the chat or session running the simulation
    (SOVA_*, PI_*): the server under test gets only what it is given here. */
export function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SOVA_") && !k.startsWith("PI_")));
}

/** Refuses anything that could be the live server or the real agent dir. */
function guard({ port, agentDir }) {
  const real = join(homedir(), ".pi", "agent");
  if (agentDir === real || agentDir.startsWith(`${real}/`)) throw new Error(`refusing: ${agentDir} is the real agent dir`);
  if (port === 4800) throw new Error("refusing: 4800 is the live server's port");
}

async function portFree(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(800) });
    return false;
  } catch (err) {
    return err?.cause?.code === "ECONNREFUSED" || /ECONNREFUSED/.test(String(err?.cause ?? err));
  }
}

/** Build (or, with fresh, rebuild) the agent dir and copy auth.json in. */
export function buildAgentDir({ agentDir, fresh }) {
  guard({ port: 0, agentDir });
  if (fresh) rmSync(agentDir, { recursive: true, force: true });
  mkdirSync(agentDir, { recursive: true });
  execFileSync(process.execPath, [join(ROOT, "scripts/hermetic-agent-dir.mjs"), "--unlock-url"], {
    cwd: ROOT,
    env: { ...cleanEnv(), HERMETIC_AGENT_DIR: agentDir },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const auth = join(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(auth) && !existsSync(join(agentDir, "auth.json"))) {
    copyFileSync(auth, join(agentDir, "auth.json"));
    chmodSync(join(agentDir, "auth.json"), 0o600);
  }
  return { token: readFileSync(join(agentDir, "sova", "auth-token"), "utf8").trim() };
}

/** Start the server; resolves once /api/health answers with this server's startedAt. */
export async function startServer({ agentDir, port, sharePort, log }) {
  guard({ port, agentDir });
  if (!(await portFree(port))) throw new Error(`port ${port} is taken: pick another with --port`);
  if (!(await portFree(sharePort))) throw new Error(`share port ${sharePort} is taken: pick another with --share-port`);
  const out = createWriteStream(log, { flags: "a" });
  const child = spawn(join(ROOT, "scripts/start-server.sh"), [], {
    cwd: ROOT,
    env: {
      ...cleanEnv(),
      PORT: String(port),
      PI_CODING_AGENT_DIR: agentDir,
      SOVA_UPDATES_CHECK: "off",
      SOVA_SHARE_HOST: "127.0.0.1",
      SOVA_SHARE_PORT: String(sharePort),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}); see ${log}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
      const h = await r.json();
      if (h.startedAt) return { child, health: h, stop: () => stopServer(child) };
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  stopServer(child);
  throw new Error(`server not healthy in 90 s; see ${log}`);
}

export async function stopServer(child) {
  if (child.exitCode !== null) return;
  try { process.kill(-child.pid, "SIGTERM"); } catch {}
  const t = Date.now();
  while (child.exitCode === null && Date.now() - t < 10_000) await new Promise((r) => setTimeout(r, 200));
  if (child.exitCode === null) try { process.kill(-child.pid, "SIGKILL"); } catch {}
}
