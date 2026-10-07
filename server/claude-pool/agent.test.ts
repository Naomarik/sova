// Run: pnpm test -- server/claude-pool/agent.test.ts. Everything is under a mkdtemp dir: synthetic
// credentials (`fake-…` tokens, example.com emails), no network, no `claude`, no process of its own.
// Devices are PoolAgents wired to each other in-process (pool-test-fixtures.ts); a crash is an agent
// that throws at a named step and is replaced by a fresh one over the same directories (which replays
// the journal). Processes on a login are faked pids here; with real ones: agent.integration.test.ts.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { after, describe, test } from "node:test";
import {
  ClaudeLogins,
  claudeRunsOn,
  markLeaving,
  parseEtime,
  readAccounts,
  readLeaving,
  readLoginPicks,
  writeAccounts,
  writeLoginPick,
  type ClaudeAccountsFile,
} from "../../pi-config/extensions/claude-code/accounts.ts";
import { keychainService, resetKeychainMtimes, type KeychainOptions } from "../../pi-config/extensions/claude-code/keychain.ts";
import { clearPicksOf } from "./agent";
import { emptyDoc, mergeDocs, newPoolLogin, poolOrder, reg } from "./doc";
import { readJournal } from "./journal";
import { copies, credentialsOf, credsPath, holder, invariant, L1, L2, L3, makeWorld, MIN, pool, root, seedLogin, usableOn, want, type Device, type ProcView } from "./pool-test-fixtures";

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

describe("accounts, then logins", () => {
  test("the pool's order keeps an account's logins together, where its first falls, whatever order was saved", () => {
    const doc = emptyDoc();
    const add = (id: string, account: string | null, addedAt: number) => {
      doc.logins[id] = newPoolLogin({ addedAt, identity: account ? { accountUuid: account, email: `${account}@example.com` } : null, enabled: true, device: "k", free: true, now: 1 });
    };
    add(L1, "acct-one", 1);
    add(L2, "acct-two", 2);
    add(L3, "acct-one", 3);
    add("l-000000a4", null, 4);
    assert.deepEqual(poolOrder(doc), [L1, L3, L2, "l-000000a4"], "by age, grouped");
    doc.order = reg([L2, L1, "l-000000a4", L3], 5, "d");
    assert.deepEqual(poolOrder(doc), [L2, L1, L3, "l-000000a4"], "a saved order that splits acct-one is read grouped");
  });

  test("a device follows the document for the logins it has: a rename, Use and a move made elsewhere reach its registry", async () => {
    const { w, clock, k } = await pool(["k", "d", "e"], [[L1, "acct-one"], [L2, "acct-two"], [L3, "acct-one"]]);
    const d = w.dev("d");
    // d borrows twice: it holds acct-one's first login, then (after a want excluding it) another.
    want(d);
    await d.agent.tick();
    want(d, { excludeLogins: [L1] });
    await d.agent.tick();
    const held = readAccounts(d.agentDir).value.logins.filter((l) => l.device === "d").map((l) => l.id).sort();
    assert.equal(held.length, 2, `d holds two logins (${held.join(", ")})`);
    // Edits made on e, which holds nothing.
    const e = w.dev("e");
    clock.now += 1000;
    e.agent.setLabel(held[0]!, "Work laptop");
    e.agent.setEnabled(held[1]!, false);
    const order = poolOrder(e.agent.doc());
    e.agent.setOrder([...order].reverse());
    await w.syncAll();
    await d.agent.tick();
    const after = readAccounts(d.agentDir).value;
    assert.equal(after.logins.find((l) => l.id === held[0])!.label, "Work laptop");
    assert.equal(after.logins.find((l) => l.id === held[1])!.enabled, false);
    const wanted = poolOrder(d.agent.doc()).filter((id) => held.includes(id));
    assert.deepEqual(new ClaudeLogins({ agentDir: d.agentDir, env: { HOME: d.agentDir, CLAUDE_CONFIG_DIR: d.claudeDir } }).order().filter((id) => id !== "default"), wanted, "its spawns try them in the pool's order");
    // A rename cleared elsewhere clears it here too; nothing is written when nothing differs.
    clock.now += 1000;
    e.agent.setLabel(held[0]!, null);
    await w.syncAll();
    await d.agent.tick();
    assert.equal(readAccounts(d.agentDir).value.logins.find((l) => l.id === held[0])!.label, undefined);
    const file = join(d.agentDir, "claude-accounts.json");
    const before = readFileSync(file, "utf8");
    await d.agent.tick();
    assert.equal(readFileSync(file, "utf8"), before);
    void k;
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

  test("a want naming one login (a pick in the composer) borrows that one, even while another is held; none when it isn't free", async () => {
    const { w } = await pool();
    const d = w.dev("d");
    const e = w.dev("e");
    const wants = (x: Device) => (existsSync(join(x.agentDir, "claude-pool", "wants")) ? readdirSync(join(x.agentDir, "claude-pool", "wants")) : []);
    want(d);
    await d.agent.tick();
    assert.deepEqual(usableOn(w, L1), ["d"], "d holds the first free login");
    want(d, { only: L2 });
    await d.agent.tick();
    assert.deepEqual([usableOn(w, L1), usableOn(w, L2)], [["d"], ["d"]], "and borrows L2 by name while holding L1");
    assert.deepEqual(wants(d), [], "the want is answered");
    want(d, { only: L2 });
    await d.agent.tick();
    assert.deepEqual(wants(d), [], "L2 is here already: answered with no borrow");
    await w.syncAll();
    want(e, { only: L1 });
    await e.agent.tick();
    assert.deepEqual(usableOn(w, L1), ["d"], "L1 is held by d: the keeper lends it to nobody else");
    assert.deepEqual(readAccounts(e.agentDir).value.logins.filter((l) => l.device === "e"), [], "e got no other login instead");
    assert.deepEqual(wants(e), [], "the want is answered: nothing to borrow");
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
  async function borrowed(procs: ProcView = {}) {
    const p = await pool(undefined, undefined, undefined, procs);
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

  test("a login is not handed over while a process runs on it; at the cut its claude is stopped (the process faked)", async () => {
    // The claude child is a pid no process has: whether it lives and runs claude on L1 is this
    // test's say. With a real process named claude: agent.integration.test.ts.
    const CLAUDE = 2 ** 30;
    let running = true;
    const { w, d, k, clock } = await borrowed({ pidAlive: (pid) => pid === process.pid || (pid === CLAUDE && running), runsOn: (pid) => pid === CLAUDE && running });
    const leases = join(d.agentDir, "claude-accounts", L1, ".sova-leases");
    mkdirSync(leases, { recursive: true });
    const lease = () => writeFileSync(join(leases, `${process.pid}.json`), JSON.stringify({ v: 1, owner: process.pid, users: 1, busy: 1, children: [CLAUDE], lastActiveAt: clock.now, at: clock.now }));
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
    assert.deepEqual(w.killed, [CLAUDE], "the cut stops the claude process still on it");
    running = false;
    rmSync(leases, { recursive: true });
    await d.agent.tick();
    assert.equal(existsSync(credsPath(d, L1)), false, "then it goes");
    assert.equal(holder(k, L1)!.free, true);
  });

  test("a stale lease (its owner gone, its child pid reused by another process) holds nothing and nothing is stopped (the pids faked)", async () => {
    // The owner is a pid no process has, and this test's own pid runs no claude: as the real checks
    // find them (agent.integration.test.ts).
    const { w, d, k, clock } = await borrowed({ pidAlive: (pid) => pid === process.pid, runsOn: () => false });
    const leases = join(d.agentDir, "claude-accounts", L1, ".sova-leases");
    mkdirSync(leases, { recursive: true });
    // A dead owner whose recorded child pid now belongs to an unrelated live process (this test's),
    // and a live pid as owner that stopped rewriting its lease long ago (a reused owner pid).
    const dead = 2 ** 30;
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

  test("a child's exit does not reset idleness: the last activity seen on a login is remembered", async () => {
    const { w, d, k, clock } = await borrowed();
    const leases = join(d.agentDir, "claude-accounts", L1, ".sova-leases");
    mkdirSync(leases, { recursive: true });
    clock.now += 20 * MIN;
    writeFileSync(join(leases, `${process.pid}.json`), JSON.stringify({ v: 1, owner: process.pid, users: 1, busy: 0, children: [], lastActiveAt: clock.now, at: clock.now }));
    await d.agent.tick();
    // The child is reaped: its lease goes, and with it the only record of the turn at +20 min.
    rmSync(leases, { recursive: true });
    clock.now += 11 * MIN;
    await d.agent.tick();
    await d.agent.tick();
    assert.deepEqual(usableOn(w, L1), ["d"], "31 minutes after the borrow but 11 after its last use: kept");
    clock.now += 20 * MIN;
    await d.agent.tick();
    await d.agent.tick();
    assert.equal(holder(k, L1)!.free, true, "31 minutes after its last use: returned");
  });

  test("a login a chat here picked by hand is never returned for idleness; Return still moves it", async () => {
    const { w, d, k, clock } = await borrowed();
    want(d, { excludeLogins: [L1] });
    await d.agent.tick();
    assert.deepEqual(usableOn(w, L2), ["d"]);
    writeLoginPick(d.agentDir, L2, "chat-picked", clock.now);
    clock.now += 61 * MIN;
    await d.agent.tick();
    await d.agent.tick();
    assert.equal(holder(k, L1)!.free, true, "L1, unpicked, went back");
    assert.deepEqual(usableOn(w, L2), ["d"], "L2, picked, stays past twice the idle time");
    clearPicksOf(d.agentDir, "another-chat");
    assert.equal(readLoginPicks(d.agentDir, L2).length, 1, "another chat's archive leaves the pick");
    k.agent.askReturn(L2);
    await w.syncAll();
    await d.agent.tick();
    await d.agent.tick();
    assert.equal(existsSync(credsPath(d, L2)), false, "the user's Return moves it all the same");
    assert.equal(holder(k, L2)!.free, true);
  });

  test("archiving or deleting the chat ends its pick: the login goes back once idle", async () => {
    const { w, d, k, clock } = await borrowed();
    writeLoginPick(d.agentDir, L1, "chat-picked", clock.now);
    clock.now += 61 * MIN;
    await d.agent.tick();
    assert.deepEqual(usableOn(w, L1), ["d"]);
    clearPicksOf(d.agentDir, "chat-picked");
    assert.deepEqual(readLoginPicks(d.agentDir, L1), []);
    await d.agent.tick();
    await d.agent.tick();
    assert.equal(holder(k, L1)!.free, true);
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
    let inflight = Promise.resolve();
    const ticking = setInterval(() => (inflight = d.agent.tick()), 30);
    try {
      const first = await logins.acquire();
      assert.equal(first.id, L1);
      assert.equal(first.env.CLAUDE_CONFIG_DIR, join(d.agentDir, "claude-accounts", L1));
      const next = await logins.failoverAsync(first, { kind: "limit", resetsAt: clock.now + 60 * MIN, window: "five_hour" });
      assert.equal(next?.id, L2, "the next login of another account, borrowed");
      // A tick already running makes another a no-op: stop the ticking, let the last one end, then tick.
      clearInterval(ticking);
      await inflight;
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
  test("the keeper never returns a login it holds for idleness", async () => {
    const { w, k, clock } = await pool();
    want(k);
    await k.agent.tick();
    assert.deepEqual(usableOn(w, L1), ["k"], "the keeper took L1 for itself");
    clock.now += 120 * MIN;
    await k.agent.tick();
    await k.agent.tick();
    assert.deepEqual({ device: holder(k, L1)!.device, free: holder(k, L1)!.free }, { device: "k", free: false });
    assert.equal(readAccounts(k.agentDir).value.logins.find((l) => l.id === L1)!.device, "k");
    assert.equal(readLeaving(k.agentDir, L1), undefined);
    assert.deepEqual(usableOn(w, L1), ["k"]);
  });

  test("nothing free: a peer's borrow gets an idle login the keeper holds, never a picked one, and only on a borrow", async () => {
    const { w, k, clock } = await pool();
    const d = w.dev("d");
    const e = w.dev("e");
    want(k);
    await k.agent.tick();
    want(k, { excludeLogins: [L1] });
    await k.agent.tick();
    assert.deepEqual([usableOn(w, L1), usableOn(w, L2)], [["k"], ["k"]], "the keeper holds both");
    writeLoginPick(k.agentDir, L2, "chat-on-k", clock.now);
    await w.syncAll();
    want(d);
    await d.agent.tick();
    assert.deepEqual([usableOn(w, L1), usableOn(w, L2)], [["k"], ["k"]], "used moments ago: not lent");
    clock.now += 60 * MIN;
    await w.tickAll(2);
    assert.deepEqual([usableOn(w, L1), usableOn(w, L2)], [["k"], ["k"]], "no borrow: nothing moves");
    // L1 has an idle chat child at the keeper; it lets go once the login is marked leaving.
    const leases = join(k.agentDir, "claude-accounts", L1, ".sova-leases");
    mkdirSync(leases, { recursive: true });
    writeFileSync(join(leases, `${process.pid}.json`), JSON.stringify({ v: 1, owner: process.pid, users: 1, busy: 0, children: [], lastActiveAt: clock.now - 45 * MIN, at: clock.now }));
    // The child lets go once it sees the login marked leaving (the lend waits up to 8 s for that).
    let markedFirst = false;
    const release = setInterval(() => {
      if (readLeaving(k.agentDir, L1)?.reason !== "idle") return;
      markedFirst = true;
      rmSync(leases, { recursive: true, force: true });
      clearInterval(release);
    }, 10);
    want(d);
    await d.agent.tick();
    clearInterval(release);
    assert.ok(markedFirst, "its idle children were asked to let go first");
    assert.deepEqual(usableOn(w, L1), ["d"], "d borrowed L1, the keeper's idle login");
    assert.equal(existsSync(credsPath(k, L1)), false);
    await w.syncAll();
    want(e);
    await e.agent.tick();
    assert.deepEqual(usableOn(w, L2), ["k"], "L2, picked by a chat on the keeper, is never lent");
    assert.deepEqual(readAccounts(e.agentDir).value.logins.filter((l) => l.device === "e"), []);
  });

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

describe("a Mac's keychain-only login (§app.claude-logins/macos-keychain)", () => {
  /** Keeper `k`; Mac `m` holds L3, whose sign-in is only a keychain item (its directory has no file). */
  async function macWorld(platform: NodeJS.Platform = "darwin") {
    resetKeychainMtimes();
    const clock = { now: 1_000_000 };
    const items = new Set<string>();
    const queries: string[][] = [];
    const execSync = (_file: string, args: string[]) => {
      queries.push(args);
      if (args.includes("-w")) throw new Error("the pool never reads the secret");
      if (!items.has(args[2]!)) throw new Error("exit 44");
      return `    "mdat"<timedate>=0x00  "20261004130350Z\\000"\n`;
    };
    const w = makeWorld(["k", "m"], clock, undefined, [], { m: { platform, env: { USER: "someone" }, home: "/fixture/home", userHome: "/fixture/home", execSync } });
    const k = w.dev("k");
    const m = w.dev("m");
    k.agent.migrate();
    k.agent.setKeeper("k");
    seedLogin(m, L3, "acct-mac", "m");
    rmSync(credsPath(m, L3));
    items.add(keychainService(join(m.agentDir, "claude-accounts", L3)));
    m.agent.migrate();
    await w.syncAll();
    const stays = () => {
      assert.ok(existsSync(join(m.agentDir, "claude-accounts", L3)), "its directory is never deleted");
      assert.equal(readAccounts(m.agentDir).value.logins.find((l) => l.id === L3)?.device, "m", "held by the Mac in its registry");
      assert.deepEqual({ device: holder(m, L3)!.device, free: holder(m, L3)!.free }, { device: "m", free: false });
      assert.ok(!readLeaving(m.agentDir, L3), "not leaving: spawns here still pick it");
      assert.deepEqual(readJournal(m.stateDir).ops, {});
    };
    return { w, k, m, clock, queries, stays };
  }

  test("it never leaves the Mac: not when idle, limited, pinned elsewhere, asked to return, or mid-move", async () => {
    const { w, k, m, clock, queries, stays } = await macWorld();
    clock.now += 31 * MIN;
    await m.agent.tick();
    await m.agent.tick();
    stays();
    markLeaving(m.agentDir, L3, "limit", clock.now);
    await m.agent.tick();
    stays();
    k.agent.setPin(L3, "k");
    k.agent.askReturn(L3);
    await w.syncAll();
    await m.agent.tick();
    await m.agent.tick();
    stays();
    m.agent.leave(L3, "return", "user"); // a move already under way (an older version, a crash) is called off
    await m.agent.tick();
    stays();
    assert.ok(queries.every((q) => !q.includes("-w")));
    const row = m.agent.view().logins.find((l) => l.id === L3)!;
    assert.equal(row.staysHere, true);
    assert.equal(row.returnAsked, undefined, "a Return asked elsewhere is not shown as pending here");
    await w.syncAll();
    assert.equal(k.agent.view().logins.find((l) => l.id === L3)?.staysHere, undefined, "only the Mac knows");
  });

  test("one kept free here (as the keeper's) is taken back and used here", async () => {
    const { m, stays } = await macWorld();
    updateAccountsFor(m.agentDir, L3, null);
    await m.agent.tick();
    stays();
  });

  test("not macOS: nothing is asked of a keychain", async () => {
    const { m, clock, queries } = await macWorld("linux");
    clock.now += 31 * MIN;
    await m.agent.tick();
    assert.deepEqual(queries, []);
    assert.equal(m.agent.view().logins.find((l) => l.id === L3)?.staysHere, undefined);
  });
});

function updateAccountsFor(agentDir: string, id: string, device: string | null): void {
  const read = readAccounts(agentDir).value;
  read.logins.find((l) => l.id === id)!.device = device;
  writeAccounts(agentDir, read);
}

test("off Linux a lease's child counts only as a `claude` started no later than the lease was written (a reused pid is neither)", () => {
  assert.equal(parseEtime("05:07"), 307);
  assert.equal(parseEtime("1:00:00"), 3600);
  assert.equal(parseEtime("2-03:04:05"), 2 * 86400 + 3 * 3600 + 4 * 60 + 5);
  assert.equal(parseEtime("bogus"), null);
  const now = 1_000_000_000;
  const at = now - 60_000; // the lease, written a minute ago
  const ps = (comm: string, ageSec: number) => () => ({ ageSec, comm });
  const me = process.pid; // alive; ps is faked
  assert.equal(claudeRunsOn(me, "/l", at, now, "darwin", ps("claude", 120)), true, "started before the lease");
  assert.equal(claudeRunsOn(me, "/l", at, now, "darwin", ps("/opt/tools/bin/claude", 61)), true, "a path names it too; within ps's whole seconds");
  assert.equal(claudeRunsOn(me, "/l", at, now, "darwin", ps("claude", 30)), false, "started after the lease: a reused pid");
  assert.equal(claudeRunsOn(me, "/l", at, now, "darwin", ps("bun", 120)), false, "not claude");
  assert.equal(claudeRunsOn(me, "/l", at, now, "darwin", () => null), false, "ps can't read it");
  const dead = 2 ** 30; // no process has it
  assert.equal(claudeRunsOn(dead, "/l", at, now, "darwin", ps("claude", 120)), false, "not alive");
});
