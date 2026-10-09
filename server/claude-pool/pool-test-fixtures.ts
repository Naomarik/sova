// Tests: a pool of devices for the claude-pool tests (agent.test.ts, agent.integration.test.ts). Each
// device is a PoolAgent over its own directories under a mkdtemp root, wired to the others in-process
// (JSON on the wire; an offline device answers nothing), on a shared test clock. Synthetic credentials
// (`fake-…` tokens, example.com emails), no network, no `claude`.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeLogins, readAccounts, writeAccounts } from "../../pi-config/extensions/claude-code/accounts.ts";
import type { KeychainOptions } from "../../pi-config/extensions/claude-code/keychain.ts";
import { PoolAgent, type PoolAgentOptions, type PoolPeer } from "./agent";
import { INCOMING_DIR_NAME } from "./creds";

/** Every world's directories; remove it after the file's tests. */
export const root = mkdtempSync(join(tmpdir(), "sova-claude-pool-test-"));

export const L1 = "l-000000a1";
export const L2 = "l-000000a2";
export const L3 = "l-000000a3";
export const MIN = 60_000;

export interface Device {
  id: string;
  agentDir: string;
  stateDir: string;
  claudeDir: string;
  agent: PoolAgent;
  offline: boolean;
  crashAt?: string;
}

let world = 0;
/** How a world's agents see processes: by default the real liveness and `claude` checks. */
export type ProcView = Pick<PoolAgentOptions, "pidAlive" | "runsOn">;

export function makeWorld(ids: string[], clock: { now: number }, procScan: () => Map<string, number[]> = () => new Map(), apiKeysOnly: string[] = [], keychains: Record<string, KeychainOptions> = {}, procs: ProcView = {}) {
  const base = join(root, `w${++world}`);
  const devices = new Map<string, Device>();
  const killed: number[] = [];
  const crashed = new Set<string>();
  const logs: string[] = [];
  /** Pairs ("a>b", either order) that never talk directly: the document goes through the others. */
  const cut = new Set<string>();
  const build = (d: Omit<Device, "agent"> & { agent?: PoolAgent }): PoolAgent =>
    new PoolAgent({
      agentDir: d.agentDir,
      stateDir: d.stateDir,
      self: () => d.id,
      selfLabel: () => d.id.toUpperCase(),
      peers: () => ids.filter((x) => x !== d.id).map((x) => direct(d.id, x)),
      peerInfo: () => ids.filter((x) => x !== d.id).map((x) => ({ id: x, label: x.toUpperCase(), up: !devices.get(x)!.offline })),
      defaultClaudeDir: d.claudeDir,
      now: () => clock.now,
      tickMs: 0,
      syncMs: 0,
      kill: (pid) => killed.push(pid),
      procScan,
      ...procs,
      canHold: () => !apiKeysOnly.includes(d.id),
      ...(keychains[d.id] ? { keychain: keychains[d.id] } : {}),
      crash: (step) => {
        if (devices.get(d.id)?.crashAt === step) { crashed.add(step); throw new Error(`crash at ${step}`); }
      },
      log: (m: string) => {
        logs.push(`[${d.id}] ${m}`);
        if (process.env.POOL_TEST_LOG) console.log(`[${d.id}] ${m}`);
      },
    });
  // A peer as `from` reaches it: JSON on the wire, and an offline device answers nothing.
  const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  function direct(from: string, to: string): PoolPeer {
    const target = () => {
      const d = devices.get(to)!;
      const me = devices.get(from)!;
      if (d.offline || me.offline || cut.has(`${from}>${to}`) || cut.has(`${to}>${from}`)) throw new Error(`${to} unreachable`);
      return d.agent;
    };
    return {
      id: to,
      doc: async () => wire(target().doc()),
      pushDoc: async (doc) => wire(target().receiveDoc(wire(doc), from)!),
      lend: async (req) => wire(await target().lend(from, wire(req))),
      commit: async (req) => wire(await target().commit(from, wire(req))),
      giveBack: async (req) => wire(await target().receiveReturn(from, wire(req))),
    };
  }
  for (const id of ids) {
    const agentDir = join(base, id, "agent");
    const claudeDir = join(base, id, "claude");
    mkdirSync(join(agentDir, "sova"), { recursive: true });
    mkdirSync(join(claudeDir, "projects"), { recursive: true });
    // The mesh is on: peers.json lists the others (accounts.ts poolActive reads exactly this).
    writeFileSync(join(agentDir, "sova", "peers.json"), JSON.stringify({ version: 1, self: { id, label: id }, peers: ids.filter((x) => x !== id).map((x) => ({ id: x, label: x, nodeId: `n-${x}`, dnsName: `${x}.example.invalid` })) }));
    const d = { id, agentDir, stateDir: join(agentDir, "sova"), claudeDir, offline: false } as Device;
    d.agent = build(d);
    devices.set(id, d);
  }
  const dev = (id: string) => devices.get(id)!;
  return {
    devices,
    dev,
    killed,
    crashed,
    logs,
    cut,
    /** The process on `id` died and started again: a fresh agent, the same files. */
    restart(id: string) {
      const d = dev(id);
      d.crashAt = undefined;
      d.agent = build(d);
      d.agent.migrate();
    },
    async tickAll(rounds = 1) {
      for (let i = 0; i < rounds; i++) for (const d of devices.values()) if (!d.offline) await d.agent.tick();
    },
    async syncAll() {
      for (const d of devices.values()) if (!d.offline) await d.agent.syncAll();
    },
  };
}

export function credentialsOf(tag: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `fake-access-token-${tag}`, refreshToken: `fake-refresh-token-${tag}`, expiresAt: 4102444800000, scopes: ["user:inference"] } });
}
/** A login signed in on `d` (as phase 1 leaves it): its directory and a registry entry `device`. */
export function seedLogin(d: Device, id: string, account: string, device: string | null = d.id, tag = id): void {
  const dir = join(d.agentDir, "claude-accounts", id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ".credentials.json"), credentialsOf(tag), { mode: 0o600 });
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: account, emailAddress: `${account}@example.com` }, projects: { "/somewhere": {} } }));
  const read = readAccounts(d.agentDir).value;
  read.logins.push({ id, addedAt: read.logins.length + 1, enabled: true, device, identity: { accountUuid: account, email: `${account}@example.com` } });
  writeAccounts(d.agentDir, read);
}
export const credsPath = (d: Device, id: string) => join(d.agentDir, "claude-accounts", id, ".credentials.json");
export const stagedPath = (d: Device, id: string) => join(d.agentDir, "claude-accounts", INCOMING_DIR_NAME, id, ".credentials.json");
/** Devices where a `claude` spawn could run on `id` now (the pool is on everywhere here). */
export function usableOn(w: ReturnType<typeof makeWorld>, id: string): string[] {
  return [...w.devices.values()].filter((d) => {
    const logins = new ClaudeLogins({ agentDir: d.agentDir, env: { HOME: d.agentDir, CLAUDE_CONFIG_DIR: d.claudeDir } });
    return logins.order().includes(id) && existsSync(credsPath(d, id)) && !logins.leaving(id);
  }).map((d) => d.id);
}
/** Copies of `id`'s credentials anywhere (active or staged). */
export function copies(w: ReturnType<typeof makeWorld>, id: string): number {
  let n = 0;
  for (const d of w.devices.values()) {
    if (existsSync(credsPath(d, id))) n++;
    if (existsSync(stagedPath(d, id))) n++;
  }
  return n;
}
export function invariant(w: ReturnType<typeof makeWorld>, id: string, where: string): void {
  assert.ok(usableOn(w, id).length <= 1, `${where}: ${id} usable on ${usableOn(w, id).join(", ")}`);
  assert.ok(copies(w, id) >= 1, `${where}: ${id} lost`);
}
export const want = (d: Device, extra: Record<string, unknown> = {}) => {
  mkdirSync(join(d.agentDir, "claude-pool", "wants"), { recursive: true });
  writeFileSync(join(d.agentDir, "claude-pool", "wants", `${process.pid}-${Math.random().toString(16).slice(2, 10)}.json`), JSON.stringify({ v: 1, at: 1, pid: process.pid, ...extra }));
};
export const holder = (d: Device, id: string) => d.agent.doc().logins[id]?.holder;

/** Keeper `k` with L1 (and L2) kept free, `d` and `e` with nothing; everything in sync. */
export async function pool(ids = ["k", "d", "e"], logins: Array<[string, string]> = [[L1, "acct-one"], [L2, "acct-two"]], procScan?: () => Map<string, number[]>, procs: ProcView = {}) {
  const clock = { now: 1_000_000 };
  const w = makeWorld(ids, clock, procScan, [], {}, procs);
  const k = w.dev(ids[0]!);
  for (const [id, account] of logins) seedLogin(k, id, account, null);
  k.agent.migrate();
  k.agent.setKeeper(k.id);
  await w.syncAll();
  return { w, clock, k };
}

