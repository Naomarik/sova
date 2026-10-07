// Tests: a resync world for resync.test.ts (an in-memory history, a fake deploy child) and
// resync.integration.test.ts (a real checkout, the deploy script as a real child). Peers vps, phone,
// new and gone; this host is Desk, booted at C, with commits a - b - c on main and d branching from a.
import { type ChildProcess, spawn as nodeSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { BootBuild, Git } from "./build-id";
import type { ProbeResult } from "./hello";
import type { PeerEntry, PeersConfig } from "./peers";
import { type Recipe, ResyncService } from "./resync";

/** The commits a world is told about, the checkout they live in, and how it is asked. */
export interface History {
  A: string;
  B: string;
  C: string;
  D: string;
  repo: string;
  git: Git;
}

/** a - b - c on main, d from a, answered as git would for the three questions relationOf asks. */
export function memoryHistory(repo: string): History {
  const [A, B, C, D] = ["a", "b", "c", "d"].map((c) => c.repeat(40)) as [string, string, string, string];
  const parent = new Map([
    [B, A],
    [C, B],
    [D, A],
  ]);
  /** c and every commit before it. */
  const lineOf = (c: string) => {
    const out = new Set<string>();
    for (let x: string | undefined = c; x; x = parent.get(x)) out.add(x);
    return out;
  };
  const known = new Set([A, B, C, D]);
  const ok = (s = "") => Promise.resolve(Buffer.from(s));
  const git: Git = (args) => {
    const [cmd, flag, x, y] = args;
    if (cmd === "cat-file" && flag === "-e") return known.has(x!.replace("^{commit}", "")) ? ok() : Promise.resolve(null);
    if (cmd === "merge-base" && flag === "--is-ancestor") return known.has(x!) && known.has(y!) && lineOf(y!).has(x!) ? ok() : Promise.resolve(null);
    if (cmd === "rev-list" && flag === "--count") {
      const [from, to] = x!.split("..") as [string, string];
      const before = lineOf(from);
      return ok(`${[...lineOf(to)].filter((c) => !before.has(c)).length}\n`);
    }
    return Promise.resolve(null);
  };
  return { A, B, C, D, repo, git };
}

/** What the fake deploy script does: says two lines and exits with `exit`, or never finishes. */
export interface Script {
  exit: number;
  hang?: boolean;
}

/** The deploy script as a child in-process: its output, then 'close' with its code; kill ends it. */
export function fakeScript(s: Script): ChildProcess {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; pid: number; exitCode: number | null; kill(signal?: string): boolean };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 2 ** 30; // no process has it: a signal to its group fails, and kill() is used
  child.exitCode = null;
  const close = (code: number | null) => {
    if (child.exitCode !== null) return;
    child.exitCode = code ?? 143;
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit("close", code));
  };
  child.kill = () => (close(null), true);
  if (!s.hang)
    setImmediate(() => {
      child.stdout.write("deploying\n");
      child.stderr.write("to stderr\n");
      close(s.exit);
    });
  return child as unknown as ChildProcess;
}

/** The same script as a real child (node -e). */
export function realScript(s: Script): ChildProcess {
  const script = s.hang ? "setInterval(() => {}, 1000)" : `console.log("deploying"); console.error("to stderr"); process.exit(${s.exit})`;
  return nodeSpawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
}

export const PROTO = "1111111111111111";
const peer = (id: string, port: number): PeerEntry => ({ id, label: id.toUpperCase(), nodeId: `n${id}`, dnsName: `${id}.lab`, url: `http://127.0.0.1:${port}` });
export const config: PeersConfig = { self: { id: "desk", label: "Desk" }, peers: [peer("vps", 1), peer("phone", 2), peer("new", 3), peer("gone", 4)], sync: {}, frontDoor: null };

export interface World extends Script {
  build: BootBuild | null;
  /** Each peer's hello answer. */
  probes: Record<string, ProbeResult>;
  /** Each peer's details commit and activity. */
  details: Record<string, { commit?: string; turnsRunning: number; workers: number }>;
  recipes: Map<string, Recipe>;
  spawned: string[][];
}

export const skewed = (commit?: string): ProbeResult => ({ state: "skewed", hello: { mesh: 1, id: "x", label: "X", hostname: "x", version: "0.1.0", protocol: "0000000000000000", pi: "0", now: 0, ...(commit ? { commit } : {}) } });

/** Worlds and services over history `h`, whose deploy scripts start with `start`. */
export function resyncKit(h: History, start: (s: Script) => ChildProcess) {
  const { A, B, C, D } = h;
  function world(over: Partial<World> = {}): World {
    return {
      build: { commit: C, protocol: PROTO, dirty: false, verified: true },
      probes: { vps: skewed(), phone: skewed(A), new: skewed(), gone: { state: "down", error: "ECONNREFUSED" } },
      details: { vps: { commit: A, turnsRunning: 1, workers: 2 }, phone: { commit: B, turnsRunning: 0, workers: 0 }, new: { commit: D, turnsRunning: 0, workers: 0 } },
      recipes: new Map<string, Recipe>([
        ["vps", { kind: "vps", args: [] }],
        ["phone", { kind: "termux", args: [], ssh: "u@p" }],
      ]),
      spawned: [],
      exit: 0,
      ...over,
    };
  }
  function service(w: World, logDir: string, timeouts: Partial<{ vps: number; termux: number; wait: number; poll: number }> = {}) {
    const byUrl = (url: string) => config.peers.find((p) => p.url === url)!.id;
    return new ResyncService({
      mesh: {
        enabled: () => true,
        config: () => config,
        self: () => ({ id: "desk", label: "Desk" }),
        peerFetch: async (id: string) => {
          const d = w.details[id];
          if (!d) throw new Error("ECONNREFUSED");
          const body = { details: 1, identity: {}, versions: { sova: "0.1.0", ...(d.commit ? { commit: d.commit } : {}), pi: "0", node: "v22", protocol: "0" }, activity: { sessions: 1, turnsRunning: d.turnsRunning, workers: d.workers } };
          return new Response(JSON.stringify(body), { status: 200 });
        },
      } as never,
      root: h.repo,
      git: h.git,
      build: () => w.build,
      buildChecked: async () => w.build,
      probe: async (p) => w.probes[p.id]!,
      hello: async (url) => w.probes[byUrl(url)]!,
      protocol: () => PROTO,
      recipes: () => ({ recipes: w.recipes }),
      logDir: () => logDir,
      exists: () => true,
      spawn: (argv) => {
        w.spawned.push(argv);
        return start(w);
      },
      timeouts: { vps: 2_000, termux: 2_000, wait: 300, poll: 20, ...timeouts },
    });
  }
  return { world, service, deployScript: join(h.repo, "scripts/mesh-vps/deploy.sh") };
}

/** Polls until f holds; the limit is only a hang guard. */
export async function until(f: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!f()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
