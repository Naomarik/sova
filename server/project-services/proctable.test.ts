import assert from "node:assert/strict";
import { test } from "node:test";
import { hostPortOwner, lsofPortOwner, parseLsofListen, parsePs, psTable, unitMembers, type ProcEntry, type SyncExec } from "./proctable";

const e = (pid: number, ppid: number, pgid: number, sid: number | null = null, zombie = false): ProcEntry => ({ pid, ppid, pgid, sid, zombie });

test("ps lines parse, with and without a session column; zombies are marked", () => {
  assert.deepEqual(parsePs("  100     1   100 Ss   100\n  101   100   101 S+   100\n  102   101   101 Z    100\n", true), [e(100, 1, 100, 100), e(101, 100, 101, 100), e(102, 101, 101, 100, true)]);
  assert.deepEqual(parsePs("100 1 100 Ss\nnot a line\n\n101 100 100 R\n", false), [e(100, 1, 100), e(101, 100, 100)]);
});

test("with session ids, a unit is its leader's session, process groups inside it included", () => {
  const table = [e(100, 1, 100, 100), e(101, 100, 101, 100), e(102, 101, 101, 100, true), e(200, 1, 200, 200), e(300, 100, 300, 300)];
  assert.deepEqual(unitMembers(table, 100, true), [100, 101], "the zombie is not a member; the child that left for a session of its own (300) escapes");
});

test("without session ids (macOS ps), a unit is its leader's tree and the groups its members created", () => {
  const table = [
    e(100, 1, 100), // the leader
    e(101, 100, 101), // a child in a group of its own (pnpm exec, set -m)
    e(102, 1, 101), // an orphan in that group: its parent died, the group is a member's
    e(103, 102, 103), // the orphan's child, by the tree
    e(104, 1, 104), // an orphan that left for a group of its own: escapes (documented)
    e(200, 1, 200), // unrelated
    e(201, 200, 200),
    e(105, 100, 100, null, true), // a zombie child
  ];
  assert.deepEqual(unitMembers(table, 100, false).sort(), [100, 101, 102, 103]);
  // The leader is gone: what is left of its group is still the unit's.
  assert.deepEqual(unitMembers([e(101, 1, 100), e(102, 101, 100), e(200, 1, 200)], 100, false).sort(), [101, 102]);
  assert.deepEqual(unitMembers([e(200, 1, 200)], 100, false), []);
});

/** A fake `ps` answering like macOS's (no `sid` keyword) or Linux's. */
function fakePs(withSid: boolean, rows: string, lstart = "Wed Oct  1 12:00:00 2026"): { exec: SyncExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: SyncExec = (file, args) => {
    calls.push([file, ...args]);
    assert.equal(file, "ps");
    const cols = args[args.indexOf("-o") + 1]!;
    if (cols === "sid=") return withSid ? { code: 0, stdout: " 4242\n" } : { code: 1, stdout: "" };
    if (cols === "lstart=") return { code: 0, stdout: `${lstart}\n` };
    assert.equal(cols.includes("sid="), withSid, `columns ${cols}`);
    if (args.includes("-p")) {
      const pid = args[args.indexOf("-p") + 1];
      return { code: 0, stdout: rows.split("\n").filter((l) => l.trim().split(/\s+/)[0] === pid).join("\n") };
    }
    return { code: 0, stdout: rows };
  };
  return { exec, calls };
}

test("the ps table: no session column on macOS, so sessions are off; lstart is the start time", () => {
  const mac = fakePs(false, "  1 0 1 Ss\n 100 1 100 Ss\n 101 100 101 S\n");
  const t = psTable(mac.exec);
  assert.equal(t.kind, "ps");
  assert.equal(t.sessions, false);
  assert.equal(t.list().length, 3);
  assert.deepEqual(t.get(101), e(101, 100, 101));
  assert.equal(t.get(999), null);
  assert.equal(t.startOf(100), "Wed Oct 1 12:00:00 2026", "spaces folded, so a reread compares equal");
  assert.equal(mac.calls.filter((c) => c.includes("sid=")).length, 1, "the column is probed once");
  const linux = psTable(fakePs(true, " 100 1 100 Ss 100\n").exec);
  assert.equal(linux.sessions, true);
  assert.deepEqual(linux.get(100), e(100, 1, 100, 100));
});

test("lsof: the listener on loopback or any address and its cwd; none; no lsof is unknown", () => {
  assert.equal(parseLsofListen("p321\nn127.0.0.1:8761\n"), 321);
  assert.equal(parseLsofListen("p321\nn*:8761\n"), 321);
  assert.equal(parseLsofListen("p321\nn[::1]:8761\n"), 321);
  assert.equal(parseLsofListen("p321\nn192.0.2.5:8761\n"), null, "an address a loopback start doesn't collide with");
  const exec: SyncExec = (file, args) => {
    assert.equal(file, "lsof");
    if (args.includes("-iTCP:8761")) return { code: 0, stdout: "p321\nf7\nn*:8761\n" };
    if (args.includes("-iTCP:8762")) return { code: 1, stdout: "" };
    if (args.includes("cwd")) return { code: 0, stdout: "p321\nfcwd\nn/work/site\n" };
    return { code: 1, stdout: "" };
  };
  assert.deepEqual(lsofPortOwner(8761, exec), { pid: 321, cwd: "/work/site" });
  assert.equal(lsofPortOwner(8762, exec), "none");
  assert.equal(lsofPortOwner(8761, () => ({ code: 127, stdout: "" })), "unknown");
  assert.deepEqual(hostPortOwner(8761, "darwin", exec), { pid: 321, cwd: "/work/site" }, "off Linux, the port's owner comes from lsof");
});
