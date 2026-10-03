import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Policy } from "../../pi-config/extensions/sandbox/backend.ts";
import { LinuxBwrapBackend, RELAY_PORT, findExecutable } from "../../pi-config/extensions/sandbox/backends/linux-bwrap.ts";
import { proxyEnv } from "../../pi-config/extensions/sandbox/env.ts";
import { canonicalize, isWithin, readDenial, type ResolvedPolicy } from "../../pi-config/extensions/sandbox/policy.ts";
import { proxySocketPath, startProxy, type ProxyHandle } from "../../pi-config/extensions/sandbox/proxy.ts";
import { resolveSessionPolicy } from "../../pi-config/extensions/sandbox/session-policy.ts";
import { portOwner as procPortOwner, type PortOwner, type ProcFs } from "../port-owner";
import { conformDir } from "./store";

/**
 * Confined conformance (§app.project-services/confined): a definition that is not approved on this
 * host runs its conformance in ONE private network namespace per run, under the host's sandbox
 * policy. The namespace is held by an anchor (a bwrap with its own user and network namespace,
 * the policy's proxy relayed in, running `netns-agent.mjs`); every unit of the run is
 * `nsenter -t <anchor> -U -n -- bwrap <the policy's filesystem view, no network unshare> -- argv`,
 * so the run's services reach each other and nothing else, and Sova reads readiness and listeners
 * inside the namespace (the agent's socket, `/proc/<anchor>/net/tcp`).
 *
 * Linux only. The sandbox's own modules (pi-config/extensions/sandbox, builtins only) give the
 * policy, the proxy and the bwrap view, so a confined run sees exactly what a sandboxed session would.
 */

const AGENT = join(dirname(fileURLToPath(import.meta.url)), "netns-agent.mjs");

/** The `not-approved` sentence for a container service (al_4 q2). */
export const CONTAINER_REFUSAL = "a container service runs only after approval: approve this definition to conform it";

/** What one unit of the run needs to be wrapped. */
export interface ConfinedUnit {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** The instance's checkout (writable), its data dir (writable), and a tmp of its own. */
  checkout: string;
  dataDir: string;
  tmpKey: string;
}

export interface Confinement {
  readonly runId: string;
  /** A host pid inside the namespace. */
  readonly anchorPid: number;
  wrap(u: ConfinedUnit): Promise<{ argv: string[]; env: Record<string, string> }>;
  tcp(port: number): Promise<boolean>;
  http(port: number, path: string): Promise<boolean>;
  /** Who listens on `port` inside the namespace. */
  portOwner(port: number): PortOwner;
  /** Why the run may not copy `src` (a data `from`), or null. */
  fromRefusal(src: string, roots: string[]): string | null;
  /** Units started under this run (the run's own shared services' included), for its cleanup. */
  readonly units: Set<string>;
  close(): Promise<void>;
}

/** The runs open in this server, by run id: an instance record naming one that is not open belongs to a run that ended. */
const open = new Map<string, Confinement>();
export const confinementOf = (runId: string | undefined): Confinement | null => (runId ? (open.get(runId) ?? null) : null);

function fromProblem(src: string, roots: string[], hidden: string[]): string | null {
  const c = canonicalize(src);
  if (!roots.some((r) => isWithin(c, canonicalize(r)))) return `a data folder is copied from ${src}, outside the project: approve this definition to conform it`;
  const denied = readDenial({ hidden }, c);
  const below = hidden.find((h) => isWithin(h, c));
  if (denied || below) return `a data folder is copied from ${src}, which the sandbox policy hides: approve this definition to conform it`;
  return null;
}

/** The host policy a confined unit of `checkout` runs under (the sandbox policy file, as a session there would get it). */
export function confinedPolicy(checkout: string, dataDir: string, tmpDir: string, agentDir = getAgentDir()): { ok: true; value: ResolvedPolicy } | { ok: false; error: string } {
  const r = resolveSessionPolicy({ agentDir, cwd: checkout, sessionId: "conform", tmpDir, worktreeRoots: [dataDir], home: homedir() });
  if (!r.ok) return { ok: false, error: r.error };
  if (r.value.level !== "workspace-write") return { ok: false, error: "the sandbox policy is read-only, so a confined run could write nothing" };
  return r;
}

/** /proc read through the namespace's own tcp tables (`/proc/<anchor>/net/…`). */
function netnsFs(anchor: number): ProcFs {
  return {
    read: (p) => {
      try {
        return readFileSync(p.startsWith("/proc/net/") ? `/proc/${anchor}/net/${p.slice("/proc/net/".length)}` : p, "utf8");
      } catch {
        return null;
      }
    },
    list: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return [];
      }
    },
    link: (p) => {
      try {
        return readlinkSync(p);
      } catch {
        return null;
      }
    },
  };
}

function ask(socket: string, req: object, timeoutMs = 5_000): Promise<{ ok: boolean } | null> {
  return new Promise((done) => {
    const c = connect(socket);
    let buf = "";
    const end = (v: { ok: boolean } | null) => {
      c.destroy();
      done(v);
    };
    c.setTimeout(timeoutMs, () => end(null));
    c.setEncoding("utf8");
    c.on("data", (d) => {
      buf += d;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      try {
        end(JSON.parse(buf.slice(0, nl)) as { ok: boolean });
      } catch {
        end(null);
      }
    });
    c.once("error", () => end(null));
    c.once("connect", () => c.write(`${JSON.stringify(req)}\n`));
  });
}

const netNs = (pid: number | "self"): string | null => {
  try {
    return readlinkSync(`/proc/${pid}/ns/net`);
  } catch {
    return null;
  }
};

/** A child of `parent` in another network namespace than this server's (bwrap's process inside its namespaces). */
function insidePid(parent: number): number | null {
  const mine = netNs("self");
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (ppid !== parent) continue;
      const ns = netNs(Number(d));
      if (ns && ns !== mine) return Number(d);
    } catch {
      // gone
    }
  }
  return null;
}

/**
 * What a dead anchor said, in one line: its first error line (`Error: listen EINVAL …`, `bwrap: …`) and,
 * when different, its last line; never a stack frame, a source excerpt or Node's version banner.
 */
export function whyExited(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l) && !/^\^+$/.test(l) && !/^Node\.js v\d/.test(l) && !/^node:[\w/]+:\d+$/.test(l) && !/^(throw|Emitted 'error' event)/.test(l) && l !== "}" && !l.startsWith("{"));
  const first = lines.find((l) => /(^bwrap: |Error\b|error:)/.test(l)) ?? lines[0];
  const last = lines.at(-1);
  return [first, last && last !== first ? last : null].filter(Boolean).join("; ").slice(0, 600);
}

/**
 * Maven's resolver (the Clojure CLI's tools.deps, Maven, Gradle's Maven repos) ignores HTTP(S)_PROXY and the
 * JVM's proxy properties: it reads proxies from `~/.m2/settings.xml` only. Inside a sandbox `~/.m2` is the
 * sandbox's private copy, and the only way out is the relay on 127.0.0.1:3128, so that copy gets a settings
 * file naming it (written once, never over one that exists).
 */
export const MAVEN_SETTINGS = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Written by Sova for sandboxed processes: their only way out is the sandbox proxy relay. -->
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0">
  <proxies>
    <proxy><id>sandbox-https</id><active>true</active><protocol>https</protocol><host>127.0.0.1</host><port>${RELAY_PORT}</port><nonProxyHosts>localhost|127.*</nonProxyHosts></proxy>
    <proxy><id>sandbox-http</id><active>true</active><protocol>http</protocol><host>127.0.0.1</host><port>${RELAY_PORT}</port><nonProxyHosts>localhost|127.*</nonProxyHosts></proxy>
  </proxies>
</settings>
`;

function mavenProxy(sh: { path: string; source: string }): void {
  if (basename(sh.path) !== ".m2") return;
  const file = join(sh.source, "settings.xml");
  try {
    mkdirSync(sh.source, { recursive: true, mode: 0o700 });
    if (!existsSync(file)) writeFileSync(file, MAVEN_SETTINGS, { mode: 0o600, flag: "wx" });
  } catch {
    // another run wrote it first, or the shadow is not ours to write: the resolver then says why
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** JVMs ignore HTTP(S)_PROXY: the same proxy as system properties, loopback excepted. */
const JAVA_PROXY = `-Dhttp.proxyHost=127.0.0.1 -Dhttp.proxyPort=${RELAY_PORT} -Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=${RELAY_PORT} -Dhttp.nonProxyHosts=localhost|127.*|[::1]`;

/** Variables a confined unit never gets from the host: the user bus and runtime dir are hidden (/run is replaced). */
const DROP = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "SSH_AUTH_SOCK"];

export interface OpenOptions {
  /** The project's main checkout: the anchor's policy is read for it. */
  project: string;
  agentDir?: string;
}

/**
 * Open a confined run: the policy, its proxy, and the anchor holding the network namespace.
 * `{refused}` (naming why) when this host can't confine; nothing is left running then.
 */
export async function openConfinement(opts: OpenOptions): Promise<Confinement | { refused: string }> {
  if (process.platform !== "linux") return { refused: "confined conformance needs Linux (bwrap and network namespaces): approve this definition to conform it" };
  const backend = new LinuxBwrapBackend();
  const bwrap = findExecutable("bwrap");
  const nsenter = findExecutable("nsenter") ?? (existsSync("/usr/bin/nsenter") ? "/usr/bin/nsenter" : undefined);
  if (!bwrap || !nsenter) return { refused: `confined conformance needs ${!bwrap ? "bwrap" : "nsenter"} on the server's PATH: approve this definition to conform it` };
  const agentDir = opts.agentDir ?? getAgentDir();
  const runId = randomBytes(4).toString("hex");
  const dir = join(conformDir(), `run-${runId}`);
  const tmpRoot = join(dir, "tmp");
  mkdirSync(join(tmpRoot, "anchor"), { recursive: true, mode: 0o700 });
  const base = confinedPolicy(opts.project, dir, join(tmpRoot, "anchor"), agentDir);
  if (!base.ok) {
    rmSync(dir, { recursive: true, force: true });
    return { refused: `the host can't confine this run (${base.error}): approve this definition to conform it` };
  }
  const policy = base.value;
  for (const sh of policy.shadowed) mavenProxy(sh);
  let proxy: ProxyHandle | null = null;
  let child: ChildProcess | null = null;
  // The probe agent's socket, in a short dir of its own: a Unix socket path holds at most 107 bytes, and the
  // run dir under an agent dir (a worktree's hermetic one) can be longer than that.
  const sockDir = join(tmpdir(), `sova-conform-${process.getuid?.() ?? "u"}`, runId);
  const fail = async (why: string) => {
    child?.kill("SIGKILL");
    await proxy?.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(sockDir, { recursive: true, force: true });
    return { refused: `the confined run could not start (${why}): approve this definition to conform it` };
  };
  try {
    proxy = await startProxy({ socket: proxySocketPath(`conform:${runId}`), allow: policy.proxyAllow });
  } catch (err) {
    return fail(`its proxy: ${(err as Error).message}`);
  }
  try {
    mkdirSync(sockDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return fail(`its socket dir: ${(err as Error).message}`);
  }
  const sock = join(canonicalize(sockDir), "net.sock");
  if (Buffer.byteLength(sock) > 107) return fail(`its socket path is too long for a Unix socket: ${sock}`);
  const anchorPolicy: Policy = {
    level: "workspace-write",
    workspaceRoot: canonicalize(dir),
    writable: [canonicalize(dir), canonicalize(sockDir)],
    readOnlyWithinWritable: [],
    hidden: policy.hidden,
    tmpDir: join(tmpRoot, "anchor"),
    network: { mode: "proxy", proxy: { socket: proxy.socket, allow: policy.proxyAllow } },
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: homedir(), LANG: process.env.LANG ?? "C.UTF-8" },
    sessionId: `conform-${runId}`,
  };
  const res = await backend.confine({ argv: [process.execPath, AGENT, sock], cwd: dir, policy: anchorPolicy });
  if (!res.ok) return fail(res.reason);
  if (res.confined.network !== "proxy") return fail(res.confined.notes?.join("; ") ?? "no proxy relay");
  const [cmd, ...args] = res.confined.argv;
  child = spawn(cmd!, args, { env: res.confined.env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (d) => (stderr = (stderr + String(d)).slice(-8000)));
  let anchorPid: number | null = null;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) return fail(`its anchor exited: ${whyExited(stderr) || `exit ${child.exitCode}`}`);
    anchorPid ??= child.pid ? insidePid(child.pid) : null;
    if (anchorPid && (await ask(sock, { op: "ping" }, 500))?.ok) break;
    await sleep(50);
  }
  if (!anchorPid || !(await ask(sock, { op: "ping" }, 1_000))?.ok) return fail("its anchor did not answer");
  // The namespace has loopback and nothing else.
  const ifaces = (readFileSync(`/proc/${anchorPid}/net/dev`, "utf8").split("\n").slice(2).filter((l) => l.trim()).map((l) => l.trim().split(":")[0]));
  if (ifaces.join() !== "lo") return fail(`its network namespace has ${ifaces.join(", ")}, not only loopback`);
  child.unref();

  const pid = anchorPid;
  const fs = netnsFs(pid);
  const units = new Set<string>();
  const c: Confinement = {
    runId,
    anchorPid: pid,
    units,
    async wrap(u) {
      const tmp = join(tmpRoot, u.tmpKey);
      mkdirSync(tmp, { recursive: true, mode: 0o700 });
      const p = confinedPolicy(u.checkout, u.dataDir, tmp, agentDir);
      if (!p.ok) throw new Error(`the sandbox policy: ${p.error}`);
      const env: Record<string, string> = { ...u.env, ...proxyEnv(RELAY_PORT) };
      for (const k of DROP) delete env[k];
      env.JAVA_TOOL_OPTIONS = [u.env.JAVA_TOOL_OPTIONS, JAVA_PROXY].filter(Boolean).join(" ");
      const unitPolicy: Policy = {
        level: "workspace-write",
        workspaceRoot: p.value.workspaceRoot,
        writable: p.value.writable,
        readOnlyWithinWritable: p.value.readOnlyWithinWritable,
        hidden: p.value.hidden,
        tmpDir: p.value.tmpDir,
        // The run's namespace, which the unit joins: no namespace of its own.
        network: { mode: "host" },
        env,
        sessionId: `conform-${runId}`,
        shadowed: p.value.shadowed,
      };
      const r = await backend.confine({ argv: u.argv, cwd: u.cwd, policy: unitPolicy });
      if (!r.ok) throw new Error(`the sandbox: ${r.reason}`);
      // A unit has no terminal, and the detached supervisor's unit is its session: the confined
      // process stays in it, so stopping the unit stops it.
      const all = r.confined.argv;
      const cmdAt = all.findIndex((a, i) => a === "--" && all[i - 2] === "--chdir");
      const inner = all.filter((a, i) => !(a === "--new-session" && i < cmdAt));
      return { argv: [nsenter, "-t", String(pid), "-U", "-n", "--preserve-credentials", "--", ...inner], env: r.confined.env };
    },
    async tcp(port) {
      return (await ask(sock, { op: "tcp", port }))?.ok === true;
    },
    async http(port, path) {
      return (await ask(sock, { op: "http", port, path }))?.ok === true;
    },
    portOwner(port) {
      return procPortOwner(port, fs);
    },
    fromRefusal(src, roots) {
      return fromProblem(src, roots, policy.hidden);
    },
    async close() {
      open.delete(runId);
      child?.kill("SIGTERM");
      for (let i = 0; i < 40 && child && child.exitCode === null && existsSync(`/proc/${pid}`); i++) await sleep(50);
      if (child && child.exitCode === null) child.kill("SIGKILL");
      await proxy?.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
      rmSync(sockDir, { recursive: true, force: true });
    },
  };
  open.set(runId, c);
  return c;
}
