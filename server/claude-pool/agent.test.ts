// Run: pnpm exec tsx --test server/claude-pool/agent.test.ts (or pnpm test). Everything is under a
// mkdtemp dir: synthetic credentials (`fake-…` tokens, example.com emails), no network, no `claude`.
// Devices are PoolAgents wired to each other in-process; a crash is an agent that throws at a named
// step and is replaced by a fresh one over the same directories (which replays the journal).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { after, describe, test } from "node:test";
import {
  ClaudeLogins,
  markLeaving,
  readAccounts,
  readLeaving,
  writeAccounts,
  type ClaudeAccountsFile,
} from "../../pi-config/extensions/claude-code/accounts.ts";
import { spawn, spawnSync } from "node:child_process";
import { PoolAgent, scanClaudeProcs, type PoolPeer } from "./agent";
import { INCOMING_DIR_NAME } from "./creds";
import { emptyDoc, mergeDocs, newPoolLogin, reg } from "./doc";
import { readJournal } from "./journal";

const root = mkdtempSync(join(tmpdir(), "sova-claude-pool-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

// `pnpm test` loads pi-config/extensions/claude-code/tests/hermetic-env.mjs with `--import`: every
// test process gets a throwaway HOME and none of the inherited agent-dir / Claude-directory
// variables, so no test here or elsewhere reaches the real `~/.pi/agent` or a real login's directory.
test("unit tests run in a throwaway home, whatever they inherited", () => {
  const home = process.env.SOVA_TEST_HOME;
  assert.ok(home, "pnpm test did not --import tests/hermetic-env.mjs");
  const inside = (dir: string, parent: string) => { const rel = relative(parent, dir); return !rel.startsWith("..") && !isAbsolute(rel); };
  assert.ok(inside(realpathSync(home), realpathSync(tmpdir())), `${home} is not a temp dir`);
  assert.ok(inside(homedir(), home), "HOME is outside the throwaway home");
  for (const name of ["CLAUDE_CONFIG_DIR", "PI_CODING_AGENT_DIR", "PI_AGENT_DIR", "SOVA_DEVICE_ID"]) assert.equal(process.env[name], undefined, `${name} is inherited`);
});

const L1 = "l-000000a1";
const L2 = "l-000000a2";
const L3 = "l-000000a3";
const MIN = 60_000;

interface Device {
  id: string;
  agentDir: string;
  stateDir: string;
  claudeDir: string;
  agent: PoolAgent;
  offline: boolean;
  crashAt?: string;
}

let world = 0;
function makeWorld(ids: string[], clock: { now: number }, procScan: () => Map<string, number[]> = () => new Map(), apiKeysOnly: string[] = []) {
  const base = join(root, `w${++world}`);
  const devices = new Map<string, Device>();
  const killed: number[] = [];
  const crashed = new Set<string>();
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
      canHold: () => !apiKeysOnly.includes(d.id),
      crash: (step) => {
        if (devices.get(d.id)?.crashAt === step) { crashed.add(step); throw new Error(`crash at ${step}`); }
      },
      log: process.env.POOL_TEST_LOG ? (m: string) => console.log(`[${d.id}] ${m}`) : () => {},
    });
  // A peer as `from` reaches it: JSON on the wire, and an offline device answers nothing.
  const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v));
  function direct(from: string, to: string): PoolPeer {
    const target = () => {
      const d = devices.get(to)!;
      const me = devices.get(from)!;
      if (d.offline || me.offline) throw new Error(`${to} unreachable`);
      return d.agent;
    };
    return {
      id: to,
      doc: async () => wire(target().doc()),
      pushDoc: async (doc) => wire(target().receiveDoc(wire(doc))!),
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

function credentialsOf(tag: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `fake-access-token-${tag}`, refreshToken: `fake-refresh-token-${tag}`, expiresAt: 4102444800000, scopes: ["user:inference"] } });
}
/** A login signed in on `d` (as phase 1 leaves it): its directory and a registry entry `device`. */
function seedLogin(d: Device, id: string, account: string, device: string | null = d.id, tag = id): void {
  const dir = join(d.agentDir, "claude-accounts", id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, ".credentials.json"), credentialsOf(tag), { mode: 0o600 });
  writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: account, emailAddress: `${account}@example.com` }, projects: { "/somewhere": {} } }));
  const read = readAccounts(d.agentDir).value;
  read.logins.push({ id, addedAt: read.logins.length + 1, enabled: true, device, identity: { accountUuid: account, email: `${account}@example.com` } });
  writeAccounts(d.agentDir, read);
}
const credsPath = (d: Device, id: string) => join(d.agentDir, "claude-accounts", id, ".credentials.json");
const stagedPath = (d: Device, id: string) => join(d.agentDir, "claude-accounts", INCOMING_DIR_NAME, id, ".credentials.json");
/** Devices where a `claude` spawn could run on `id` now (the pool is on everywhere here). */
function usableOn(w: ReturnType<typeof makeWorld>, id: string): string[] {
  return [...w.devices.values()].filter((d) => {
    const logins = new ClaudeLogins({ agentDir: d.agentDir, env: { HOME: d.agentDir, CLAUDE_CONFIG_DIR: d.claudeDir } });
    return logins.order().includes(id) && existsSync(credsPath(d, id)) && !logins.leaving(id);
  }).map((d) => d.id);
}
/** Copies of `id`'s credentials anywhere (active or staged). */
function copies(w: ReturnType<typeof makeWorld>, id: string): number {
  let n = 0;
  for (const d of w.devices.values()) {
    if (existsSync(credsPath(d, id))) n++;
    if (existsSync(stagedPath(d, id))) n++;
  }
  return n;
}
function invariant(w: ReturnType<typeof makeWorld>, id: string, where: string): void {
  assert.ok(usableOn(w, id).length <= 1, `${where}: ${id} usable on ${usableOn(w, id).join(", ")}`);
  assert.ok(copies(w, id) >= 1, `${where}: ${id} lost`);
}
const want = (d: Device, extra: Record<string, unknown> = {}) => {
  mkdirSync(join(d.agentDir, "claude-pool", "wants"), { recursive: true });
  writeFileSync(join(d.agentDir, "claude-pool", "wants", `${process.pid}-${Math.random().toString(16).slice(2, 10)}.json`), JSON.stringify({ v: 1, at: 1, pid: process.pid, ...extra }));
};
const holder = (d: Device, id: string) => d.agent.doc().logins[id]?.holder;

/** Keeper `k` with L1 (and L2) kept free, `d` and `e` with nothing; everything in sync. */
async function pool(ids = ["k", "d", "e"], logins: Array<[string, string]> = [[L1, "acct-one"], [L2, "acct-two"]], procScan?: () => Map<string, number[]>) {
  const clock = { now: 1_000_000 };
  const w = makeWorld(ids, clock, procScan);
  const k = w.dev(ids[0]!);
  for (const [id, account] of logins) seedLogin(k, id, account, null);
  k.agent.migrate();
  k.agent.setKeeper(k.id);
  await w.syncAll();
  return { w, clock, k };
}

describe("pool document", () => {
  test("edits of different fields on two devices both survive; the holder with the larger seq wins", () => {
    const a = emptyDoc();
    a.logins[L1] = newPoolLogin({ addedAt: 1, identity: null, enabled: true, device: "k", free: true, now: 10 });
    const b = structuredClone(a);
    a.logins[L1]!.pin = reg("d", 20, "a");
    b.logins[L1]!.label = reg("work", 21, "b");
    b.logins[L1]!.holder = { device: "d", free: false, seq: 2, at: 15 };
    a.keeper = reg("k", 5, "a");
    const ab = mergeDocs(a, b);
    const ba = mergeDocs(b, a);
    assert.deepEqual(ab, ba, "commutative");
    assert.deepEqual(mergeDocs(ab, a), ab, "idempotent");
    assert.equal(ab.logins[L1]!.pin.value, "d");
    assert.equal(ab.logins[L1]!.label.value, "work");
    assert.equal(ab.logins[L1]!.holder.device, "d");
    assert.equal(ab.keeper.value, "k");
  });
});

describe("migration from a phase-1 registry", () => {
  test("logins stay where they are, held by this device, which becomes the keeper; nothing is deleted", async () => {
    const clock = { now: 5_000 };
    const w = makeWorld(["desk", "vps"], clock);
    const desk = w.dev("desk");
    seedLogin(desk, L1, "acct-one", "local");
    seedLogin(desk, L2, "acct-two", "desk");
    const accounts = readAccounts(desk.agentDir).value;
    accounts.devices = { local: { order: [L2, L1, "default"] } };
    writeAccounts(desk.agentDir, accounts);
    const before = [readFileSync(credsPath(desk, L1), "utf8"), readFileSync(credsPath(desk, L2), "utf8")];
    desk.agent.migrate();
    const doc = desk.agent.doc();
    assert.equal(doc.keeper.value, "desk");
    assert.deepEqual(doc.order.value, [L2, L1]);
    for (const id of [L1, L2]) assert.deepEqual({ device: doc.logins[id]!.holder.device, free: doc.logins[id]!.holder.free }, { device: "desk", free: false });
    const after = readAccounts(desk.agentDir).value;
    assert.deepEqual(after.logins.map((l) => l.device), ["desk", "desk"], "`local` became the mesh id");
    assert.ok(after.devices.desk && !after.devices.local);
    assert.deepEqual([readFileSync(credsPath(desk, L1), "utf8"), readFileSync(credsPath(desk, L2), "utf8")], before, "credentials untouched");
    assert.deepEqual(usableOn(w, L1), ["desk"]);
    await w.syncAll();
    assert.equal(holder(w.dev("vps"), L1)?.device, "desk", "the other device learns the pool");
  });
});

describe("borrowing", () => {
  test("a device with no login borrows a free one; the keeper keeps no copy", async () => {
    const { w, k } = await pool();
    const d = w.dev("d");
    want(d);
    await d.agent.tick();
    assert.deepEqual(usableOn(w, L1), ["d"]);
    assert.equal(existsSync(credsPath(k, L1)), false, "the keeper deleted its copy as plain files");
    assert.equal(readFileSync(credsPath(d, L1), "utf8"), credentialsOf(L1), "byte for byte");
    assert.deepEqual(JSON.parse(readFileSync(join(d.agentDir, "claude-accounts", L1, ".claude.json"), "utf8")).oauthAccount.emailAddress, "acct-one@example.com");
    assert.ok(!JSON.parse(readFileSync(join(d.agentDir, "claude-accounts", L1, ".claude.json"), "utf8")).projects, "only the login's own keys travel");
    assert.deepEqual({ device: holder(k, L1)!.device, free: holder(k, L1)!.free }, { device: "d", free: false });
    assert.deepEqual(readJournal(d.stateDir).ops, {});
    assert.deepEqual(readJournal(k.stateDir).ops, {});
  });

  test("exclusions: a limited account is skipped, and so is a login pinned to another device", async () => {
    const { w, k } = await pool(["k", "d", "e"], [[L1, "acct-one"], [L2, "acct-two"], [L3, "acct-one"]]);
    k.agent.setPin(L2, "e");
    const d = w.dev("d");
    want(d, { excludeAccounts: ["acct-one"] });
    await d.agent.tick();
    assert.deepEqual([usableOn(w, L1), usableOn(w, L2), usableOn(w, L3)], [[], [], []], "L1/L3 share the excluded account, L2 is pinned to e");
    const e = w.dev("e");
    await w.syncAll();
    await e.agent.tick();
    assert.deepEqual(usableOn(w, L2), ["e"], "the pinned device takes its login as soon as it is free");
  });

  for (const step of ["lend-offered", "borrow-staged", "lend-committing", "lend-deleting", "borrow-activating"]) {
    test(`a crash at ${step}: never two holders, never lost, and it settles`, async () => {
      const { w, clock, k } = await pool();
      const d = w.dev("d");
      const crashed = step.startsWith("lend") ? k : d;
      crashed.crashAt = step;
      want(d);
      await d.agent.tick().catch(() => {});
      assert.ok(w.crashed.has(step), `the crash at ${step} happened`);
      invariant(w, L1, `after the crash at ${step}`);
      w.restart(crashed.id);
      invariant(w, L1, `after ${crashed.id} restarted`);
      // Time passes (offers expire), both sides tick and sync until the journal is empty.
      for (let i = 0; i < 4; i++) {
        clock.now += 3 * MIN;
        await w.tickAll();
        invariant(w, L1, `round ${i}`);
        await w.syncAll();
        invariant(w, L1, `round ${i}, synced`);
      }
      want(d);
      await w.tickAll(2);
      await w.syncAll();
      invariant(w, L1, "settled");
      assert.deepEqual(readJournal(d.stateDir).ops, {}, "the borrower's journal is empty");
      assert.deepEqual(readJournal(k.stateDir).ops, {}, "the keeper's journal is empty");
      const on = usableOn(w, L1);
      const h = holder(k, L1)!;
      if (on.length) assert.deepEqual([on[0], h.device, h.free], [h.device, h.device, false], "the document names the one device that runs it");
      else assert.deepEqual([h.device, h.free, existsSync(credsPath(k, L1))], ["k", true, true], "or it is free at the keeper");
      assert.equal(copies(w, L1), 1, "exactly one copy remains");
    });
  }
});

describe("returning", () => {
  async function borrowed() {
    const p = await pool();
    const d = p.w.dev("d");
    want(d);
    await d.agent.tick();
    assert.deepEqual(usableOn(p.w, L1), ["d"]);
    return { ...p, d };
  }

  test("a limit returns the login with its standing; the keeper lends another account next", async () => {
    const { w, k, d, clock } = await borrowed();
    // What accounts.ts failoverAsync does on a limit: the state file, and the leaving mark.
    writeFileSync(join(d.agentDir, "claude-accounts-state.json"), JSON.stringify({ version: 1, logins: { [L1]: { kind: "limit", at: clock.now, until: clock.now + 60 * MIN, window: "five_hour" } } }));
    markLeaving(d.agentDir, L1, "limit", clock.now);
    assert.deepEqual(usableOn(w, L1), [], "leaving: nothing picks it");
    want(d, { excludeAccounts: ["acct-one"], excludeLogins: [L1] });
    await d.agent.tick();
    assert.equal(existsSync(credsPath(d, L1)), false, "d deleted its copy after the keeper stored it");
    assert.equal(readFileSync(credsPath(k, L1), "utf8"), credentialsOf(L1));
    assert.deepEqual({ device: holder(k, L1)!.device, free: holder(k, L1)!.free }, { device: "k", free: true });
    assert.equal(k.agent.doc().logins[L1]!.standing.value?.kind, "limit");
    assert.deepEqual(usableOn(w, L2), ["d"], "and borrowed the next free login, of another account");
    // Until the reset, nobody gets L1.
    const e = w.dev("e");
    want(e);
    await w.syncAll();
    await e.agent.tick();
    assert.deepEqual(usableOn(w, L1), [], "a limited login is not lent before its reset");
    clock.now += 61 * MIN;
    want(e);
    await e.agent.tick();
    assert.deepEqual(usableOn(w, L1), ["e"]);
  });

  for (const step of ["return-sending", "return-stored", "return-deleting"]) {
    test(`a crash at ${step}: never two holders, never lost, and it settles`, async () => {
      const { w, k, d, clock } = await borrowed();
      const crashed = step === "return-stored" ? k : d;
      crashed.crashAt = step;
      markLeaving(d.agentDir, L1, "user", clock.now);
      await d.agent.tick().catch(() => {});
      assert.ok(w.crashed.has(step), `the crash at ${step} happened`);
      invariant(w, L1, `after the crash at ${step}`);
      w.restart(crashed.id);
      for (let i = 0; i < 4; i++) {
        clock.now += MIN;
        await w.tickAll();
        invariant(w, L1, `round ${i}`);
        await w.syncAll();
        invariant(w, L1, `round ${i}, synced`);
      }
      assert.deepEqual(readJournal(d.stateDir).ops, {});
      assert.equal(existsSync(credsPath(d, L1)), false);
      assert.equal(copies(w, L1), 1);
      assert.deepEqual({ device: holder(k, L1)!.device, free: holder(k, L1)!.free }, { device: "k", free: true });
    });
  }

  test("a login is not handed over while a process runs on it; at the cut its claude is stopped", async () => {
    const { w, d, k, clock } = await borrowed();
    // A live process (this test's) with a busy user on L1 and its claude child: its lease, which
    // the owner rewrites every few seconds.
    const dir = join(d.agentDir, "claude-accounts", L1);
    const leases = join(dir, ".sova-leases");
    mkdirSync(leases, { recursive: true });
    const claude = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { env: { ...process.env, CLAUDE_CONFIG_DIR: dir }, stdio: "ignore" });
    const lease = () => writeFileSync(join(leases, `${process.pid}.json`), JSON.stringify({ v: 1, owner: process.pid, users: 1, busy: 1, children: [claude.pid], lastActiveAt: clock.now, at: clock.now }));
    try {
      await new Promise((r) => setTimeout(r, 100));
      lease();
      k.agent.askReturn(L1);
      await w.syncAll();
      await d.agent.tick();
      assert.equal(readLeaving(d.agentDir, L1)?.reason, "user");
      assert.ok(existsSync(credsPath(d, L1)), "still here: a process runs on it");
      assert.deepEqual(usableOn(w, L1), [], "but no new process may take it");
      clock.now += 16 * MIN;
      lease();
      await d.agent.tick();
      assert.deepEqual(w.killed, [claude.pid], "the cut stops the claude process still on it");
    } finally {
      claude.kill();
    }
    rmSync(leases, { recursive: true });
    await d.agent.tick();
    assert.equal(existsSync(credsPath(d, L1)), false, "then it goes");
    assert.equal(holder(k, L1)!.free, true);
  });

  test("a stale lease (its owner gone, its child pid reused by another process) holds nothing and nothing is stopped", async () => {
    const { w, d, k, clock } = await borrowed();
    const leases = join(d.agentDir, "claude-accounts", L1, ".sova-leases");
    mkdirSync(leases, { recursive: true });
    // A dead owner whose recorded child pid now belongs to an unrelated live process (this test's),
    // and a live pid as owner that stopped rewriting its lease long ago (a reused owner pid).
    const dead = spawnSync(process.execPath, ["-e", "0"]).pid!;
    writeFileSync(join(leases, `${dead}.json`), JSON.stringify({ v: 1, owner: dead, users: 1, busy: 1, children: [process.pid, process.pid], lastActiveAt: clock.now, at: clock.now }));
    writeFileSync(join(leases, `${process.pid}.json`), JSON.stringify({ v: 1, owner: process.pid, users: 1, busy: 1, children: [], lastActiveAt: clock.now - 5 * MIN, at: clock.now - 5 * MIN }));
    k.agent.askReturn(L1);
    await w.syncAll();
    await d.agent.tick();
    await d.agent.tick();
    assert.deepEqual(w.killed, [], "no pid from a stale lease is signalled");
    assert.equal(existsSync(credsPath(d, L1)), false, "the login went back without waiting for a cut");
    assert.equal(holder(k, L1)!.free, true);
  });

  test("the holder publishes its usage reading (numbers only) for every device's row", async () => {
    const { w, d, k } = await borrowed();
    mkdirSync(join(d.agentDir, "cache"), { recursive: true });
    writeFileSync(join(d.agentDir, "cache", "usage-status.json"), JSON.stringify({ claudeAccounts: { [L1]: { data: { state: "ok", fiveHour: { pct: 41.6, resetsAt: "2030-01-01T00:00:00.000Z" }, sevenDay: { pct: 18 } }, nextFetchAt: 0 } } }));
    await d.agent.tick();
    await w.syncAll();
    assert.deepEqual(k.agent.view().logins.find((l) => l.id === L1)!.usage, { fiveHour: 42, fiveHourResetsAt: Date.parse("2030-01-01T00:00:00.000Z"), sevenDay: 18, at: k.agent.doc().logins[L1]!.usage.at });
  });

  test("idle for 30 minutes goes back; a login pinned to its holder never does", async () => {
    const { w, d, k, clock } = await borrowed();
    clock.now += 29 * MIN;
    await d.agent.tick();
    assert.deepEqual(usableOn(w, L1), ["d"], "29 minutes: kept");
    clock.now += 2 * MIN;
    await d.agent.tick();
    await d.agent.tick();
    assert.equal(holder(k, L1)!.free, true, "31 minutes idle: returned");
    // Pinned to d: d takes it back at once, and keeps it however idle.
    k.agent.setPin(L1, "d");
    await w.syncAll();
    await d.agent.tick();
    assert.deepEqual(usableOn(w, L1), ["d"]);
    clock.now += 120 * MIN;
    await d.agent.tick();
    assert.deepEqual(usableOn(w, L1), ["d"], "pinned: never returned for idleness");
  });

  test("pinned to another device: the holder returns it and that device takes it", async () => {
    const { w, d, k } = await borrowed();
    k.agent.setPin(L1, "e");
    await w.syncAll();
    await d.agent.tick();
    await d.agent.tick();
    assert.equal(existsSync(credsPath(d, L1)), false);
    await w.syncAll();
    await w.dev("e").agent.tick();
    assert.deepEqual(usableOn(w, L1), ["e"]);
  });
});

describe("offline devices", () => {
  test("keeper offline: no borrow, a holder keeps working, and its return waits until the keeper is back", async () => {
    const { w, k, clock } = await pool();
    const d = w.dev("d");
    const e = w.dev("e");
    want(d);
    await d.agent.tick();
    k.offline = true;
    want(e);
    await e.agent.tick();
    assert.deepEqual(usableOn(w, L2), [], "borrowing stops while the keeper is offline");
    assert.deepEqual(usableOn(w, L1), ["d"], "the holder keeps working");
    markLeaving(d.agentDir, L1, "user", clock.now);
    await d.agent.tick();
    assert.ok(existsSync(credsPath(d, L1)), "the return waits, the login unused");
    assert.deepEqual(usableOn(w, L1), []);
    k.offline = false;
    await d.agent.tick();
    assert.equal(existsSync(credsPath(d, L1)), false);
    assert.equal(holder(k, L1)!.free, true);
  });

  test("holder offline: the login is stuck there; signed in again elsewhere, the old copy is deleted when it is back", async () => {
    const { w, k } = await pool();
    const d = w.dev("d");
    want(d);
    await d.agent.tick();
    await w.syncAll();
    d.offline = true;
    const view = k.agent.view();
    assert.deepEqual(view.logins.find((l) => l.id === L1)!.holder, { device: "d", label: "D", free: false, stuck: true, since: view.logins.find((l) => l.id === L1)!.holder.since });
    await k.agent.tick();
    assert.equal(holder(k, L1)!.device, "d", "the keeper never reclaims it on its own");
    // The user signs L1 in again on e (a new refresh chain): e holds it now.
    const e = w.dev("e");
    seedLogin(e, L1, "acct-one", "e", "resigned");
    e.agent.addedHere(L1, { identity: { accountUuid: "acct-one" }, addedAt: 1 });
    await w.syncAll();
    d.offline = false;
    await w.syncAll();
    await d.agent.tick();
    assert.deepEqual(usableOn(w, L1), ["e"], "d's old copy is never used again once d sees the newer holder");
    await d.agent.tick();
    assert.equal(existsSync(credsPath(d, L1)), false, "and d deletes it (no logout)");
    assert.equal(readFileSync(credsPath(e, L1), "utf8"), credentialsOf("resigned"));
  });
});

describe("accounts.ts in the pool", () => {
  test("acquire borrows when nothing but default is usable; failoverAsync returns the login and borrows the next", async () => {
    const { w, k, clock } = await pool();
    const d = w.dev("d");
    const env = { HOME: d.agentDir, CLAUDE_CONFIG_DIR: d.claudeDir } as NodeJS.ProcessEnv;
    const logins = new ClaudeLogins({ agentDir: d.agentDir, env, wantPollMs: 20, wantWaitMs: 5_000, now: () => clock.now });
    // The agent heartbeat (this process) and a ticking agent.
    await d.agent.tick();
    const ticking = setInterval(() => void d.agent.tick(), 30);
    try {
      const first = await logins.acquire();
      assert.equal(first.id, L1);
      assert.equal(first.env.CLAUDE_CONFIG_DIR, join(d.agentDir, "claude-accounts", L1));
      const next = await logins.failoverAsync(first, { kind: "limit", resetsAt: clock.now + 60 * MIN, window: "five_hour" });
      assert.equal(next?.id, L2, "the next login of another account, borrowed");
      await new Promise((r) => setTimeout(r, 150));
      await d.agent.tick();
      assert.equal(existsSync(credsPath(d, L1)), false, "the limited login went back");
      assert.equal(holder(k, L1)?.device, "k");
    } finally {
      clearInterval(ticking);
    }
  });

  test("with the mesh off every login here is used, kept ones included (phase 1)", () => {
    const clock = { now: 1 };
    const w = makeWorld(["solo"], clock);
    const s = w.dev("solo");
    seedLogin(s, L1, "acct-one", null);
    rmSync(join(s.agentDir, "sova", "peers.json"));
    const logins = new ClaudeLogins({ agentDir: s.agentDir, env: { HOME: s.agentDir, CLAUDE_CONFIG_DIR: s.claudeDir } });
    assert.deepEqual(logins.order(), [L1, "default"]);
  });
});

void ({} as ClaudeAccountsFile);

describe("processes without a lease (started before this version, or by hand)", () => {
  test("/proc: a claude process is found by its CLAUDE_CONFIG_DIR; a tool's shell under it is not", { skip: process.platform !== "linux" }, async () => {
    const dir = join(root, "proc-scan", "claude-accounts", L1);
    mkdirSync(dir, { recursive: true });
    const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
    const claude = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", "fake-claude"], { env, stdio: "ignore" });
    const shell = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", "a-tool-shell"], { env, stdio: "ignore" });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const found = scanClaudeProcs().get(dir) ?? [];
      assert.deepEqual(found, [claude.pid]);
    } finally {
      claude.kill();
      shell.kill();
    }
  });

  test("a login with such a process is never lent, never returned for idleness, and at the cut it is stopped", async () => {
    let pids: number[] = [];
    const scan = (agentDir: () => string) => () => new Map(pids.length ? [[join(agentDir(), "claude-accounts", L1), pids]] : []);
    let keeperDir = "";
    const { w, k, clock } = await pool(["k", "d"], [[L1, "acct-one"]], () => scan(() => keeperDir)());
    keeperDir = k.agentDir;
    pids = [process.pid]; // alive: a claude on the keeper's kept copy, started by hand
    const d = w.dev("d");
    want(d);
    await d.agent.tick();
    assert.deepEqual(usableOn(w, L1), [], "not lent while a claude runs on the keeper's copy");
    pids = [];
    want(d);
    await d.agent.tick();
    assert.deepEqual(usableOn(w, L1), ["d"]);
    // On the holder now: a process without a lease keeps it from idling out.
    keeperDir = d.agentDir;
    pids = [process.pid];
    clock.now += 60 * MIN;
    await d.agent.tick();
    assert.deepEqual(usableOn(w, L1), ["d"], "not returned for idleness while it runs");
    markLeaving(d.agentDir, L1, "user", clock.now);
    await d.agent.tick();
    assert.ok(existsSync(credsPath(d, L1)), "draining");
    clock.now += 16 * MIN;
    await d.agent.tick();
    assert.ok(w.killed.includes(process.pid), "the cut stops it");
    pids = [];
    await d.agent.tick();
    assert.equal(existsSync(credsPath(d, L1)), false, "then the login goes back");
  });
});

describe("the keeper, removal, and a device that holds no subscription login", () => {
  test("a new keeper: the old one hands every free login over; borrowing then goes to the new one", async () => {
    const { w, k, clock } = await pool();
    const d = w.dev("d");
    clock.now += 1_000; // a later edit than the pool's first keeper
    k.agent.setKeeper("d");
    await w.syncAll();
    await k.agent.tick();
    await k.agent.tick();
    for (const id of [L1, L2]) {
      assert.equal(existsSync(credsPath(k, id)), false, `${id} left the old keeper`);
      assert.ok(existsSync(credsPath(d, id)), `${id} is kept by the new one`);
      assert.deepEqual({ device: holder(d, id)!.device, free: holder(d, id)!.free }, { device: "d", free: true });
      assert.deepEqual(usableOn(w, id), [], "kept, not used");
    }
    const e = w.dev("e");
    await w.syncAll();
    want(e);
    await e.agent.tick();
    assert.deepEqual(usableOn(w, L1), ["e"], "e borrows from the new keeper");
  });

  test("Remove on any device: the holder drains and deletes its copy (plain files); the login leaves the pool", async () => {
    const { w, k } = await pool();
    const d = w.dev("d");
    want(d);
    await d.agent.tick();
    assert.deepEqual(usableOn(w, L1), ["d"]);
    w.dev("e").agent.remove(L1);
    await w.syncAll();
    await d.agent.tick();
    await d.agent.tick();
    assert.equal(copies(w, L1), 0, "gone everywhere");
    assert.ok(!k.agent.view().logins.some((l) => l.id === L1), "and out of the list");
  });

  test("an API-keys-only device never borrows, and the keeper never takes a return there", async () => {
    const clock = { now: 1_000_000 };
    const w = makeWorld(["k", "d"], clock, () => new Map(), ["d"]);
    const k = w.dev("k");
    seedLogin(k, L1, "acct-one", null);
    k.agent.migrate();
    await w.syncAll();
    const d = w.dev("d");
    want(d);
    await d.agent.tick();
    assert.deepEqual(usableOn(w, L1), []);
    assert.equal(d.agent.view().apiKeysOnly, true);
  });
});
