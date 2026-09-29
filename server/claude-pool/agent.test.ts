// Run: pnpm exec tsx --test server/claude-pool/agent.test.ts (or pnpm test). Everything is under a
// mkdtemp dir: synthetic credentials (`fake-…` tokens, example.com emails), no network, no `claude`.
// Devices are PoolAgents wired to each other in-process; a crash is an agent that throws at a named
// step and is replaced by a fresh one over the same directories (which replays the journal).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import {
  ClaudeLogins,
  markLeaving,
  readAccounts,
  readLeaving,
  writeAccounts,
  type ClaudeAccountsFile,
} from "../../pi-config/extensions/claude-code/accounts.ts";
import { PoolAgent, type PoolPeer } from "./agent";
import { INCOMING_DIR_NAME } from "./creds";
import { emptyDoc, mergeDocs, newPoolLogin, reg } from "./doc";
import { readJournal } from "./journal";

const root = mkdtempSync(join(tmpdir(), "sova-claude-pool-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

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
function makeWorld(ids: string[], clock: { now: number }) {
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
      crash: (step) => {
        if (devices.get(d.id)?.crashAt === step) { crashed.add(step); throw new Error(`crash at ${step}`); }
      },
      log: () => {},
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
async function pool(ids = ["k", "d", "e"], logins: Array<[string, string]> = [[L1, "acct-one"], [L2, "acct-two"]]) {
  const clock = { now: 1_000_000 };
  const w = makeWorld(ids, clock);
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
    // A live process (this test's) with a busy user on L1: its lease.
    const leases = join(d.agentDir, "claude-accounts", L1, ".sova-leases");
    mkdirSync(leases, { recursive: true });
    writeFileSync(join(leases, `${process.pid}.json`), JSON.stringify({ v: 1, owner: process.pid, users: 1, busy: 1, children: [process.pid], lastActiveAt: clock.now, at: clock.now }));
    k.agent.askReturn(L1);
    await w.syncAll();
    await d.agent.tick();
    assert.equal(readLeaving(d.agentDir, L1)?.reason, "user");
    assert.ok(existsSync(credsPath(d, L1)), "still here: a process runs on it");
    assert.deepEqual(usableOn(w, L1), [], "but no new process may take it");
    clock.now += 16 * MIN;
    await d.agent.tick();
    assert.deepEqual(w.killed, [process.pid], "the cut stops the claude process still on it");
    rmSync(leases, { recursive: true });
    await d.agent.tick();
    assert.equal(existsSync(credsPath(d, L1)), false, "then it goes");
    assert.equal(holder(k, L1)!.free, true);
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
