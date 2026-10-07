// Run: node scripts/run-tests.mjs server/mesh/links-transfer.integration.test.ts
// A file offer's bytes through the host's real tar and zstd: packing into a spool (and tar's failures),
// pulls that land a tree (a whole one, one resumed after a cut, one over an existing tree or into a
// directory tar can't write), and an archive the sandbox's pre-scan accepts landing beside a read-only
// path. The rules around them, in-process: links-transfer.test.ts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { checkDest, listOffer, type OfferListing, type PullDeps, Pulls, partFile, serveTar, Spools, spoolFile, TransferError } from "./links-transfer";
import { type ResolvedPolicy, writeDenial } from "../../pi-config/extensions/sandbox/policy.ts";
import { prescan } from "../link-sandbox";
import { makeTree, refusal, snapshotTree, spoolMembers } from "./links-transfer-test-fixtures";

const tmp = mkdtempSync(join(tmpdir(), "sova-links-transfer-int-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const home = join(tmp, "home");
const work = join(home, "work");
const quiet = { log: () => undefined };

before(() => {
  makeTree(work, {
    proj: {
      "a.txt": "alpha",
      "b.log": "log",
      src: { "main.ts": "main", "x.log": "x" },
      node_modules: { dep: { "index.js": "dep" } },
      dist: { "out.js": "out" },
      "link-to-a": { link: "a.txt" },
      "link-out": { link: "../../outside" },
      empty: {},
    },
    "notes.md": "notes",
    other: { "notes.md": "another" },
  });
  makeTree(home, { outside: { "secret.txt": "s" } });
});

describe("Spools", () => {
  const root = join(tmp, "state-sender");
  const spools = new Spools({ root: () => root, ...quiet });

  test("packs roots with different parents into one spool whose members are exactly the listing", async () => {
    const l = await listOffer({ cwd: work, home, paths: ["proj", "~/outside", "notes.md"], exclude: ["node_modules"], sandbox: null });
    const seen: number[] = [];
    const r = await spools.pack("of_0000000000000001", l, (n) => seen.push(n));
    const file = spoolFile(root, "of_0000000000000001");
    assert.equal(statSync(file).size, r.size);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(r.sha256, execFileSync("sha256sum", [file], { encoding: "utf8" }).split(" ")[0]);
    assert.ok(seen.length > 0 && seen.at(-1) === r.size);
    assert.deepEqual((await spoolMembers(file)).sort(), l.packList.flatMap((p) => p.members).sort());
    assert.deepEqual(spools.status("of_0000000000000001"), { state: "ready", written: r.size });
  });

  test("a file that vanished before tar read it: tar-failed, no spool left", async () => {
    makeTree(join(tmp, "vanish"), { d: { "gone.txt": "x" } });
    const l = await listOffer({ cwd: tmp, home, paths: ["vanish"], sandbox: null });
    rmSync(join(tmp, "vanish", "d", "gone.txt"));
    const e = await refusal(spools.pack("of_0000000000000002", l));
    assert.equal(e.reason, "tar-failed");
    assert.equal(spools.status("of_0000000000000002")?.state, "failed");
    assert.throws(() => statSync(spoolFile(root, "of_0000000000000002")));
    assert.throws(() => statSync(`${spoolFile(root, "of_0000000000000002")}.part`));
  });

  test("a full disk fails the pack with a sentence (no-space)", { skip: !existsSync("/dev/full") && "no /dev/full on this host (macOS)" }, async () => {
    const l = await listOffer({ cwd: work, home, paths: ["proj"], sandbox: null });
    const part = `${spoolFile(root, "of_0000000000000003")}.part`;
    symlinkSync("/dev/full", part);
    const e = await refusal(spools.pack("of_0000000000000003", l));
    assert.equal(e.reason, "no-space");
    assert.match(e.message, /No room to pack/);
  });
});

describe("Pulls", () => {
  const sendRoot = join(tmp, "pull-sender");
  const rcvRoot = join(tmp, "pull-receiver");
  const spools = new Spools({ root: () => sendRoot, ...quiet });
  let listing: OfferListing;
  let snap: { sha256: string; size: number };
  const offerId = "of_1000000000000000";

  before(async () => {
    // Big enough to arrive in several chunks: incompressible bytes.
    makeTree(join(tmp, "big"), { proj: { "a.txt": "alpha", sub: { "b.txt": "beta", "l": { link: "../a.txt" } } } });
    writeFileSync(join(tmp, "big", "proj", "random.bin"), randomBytes(3 * 1024 * 1024));
    listing = await listOffer({ cwd: join(tmp, "big"), home, paths: ["proj"], sandbox: null });
    const r = await spools.pack(offerId, listing);
    snap = { sha256: r.sha256, size: r.size };
  });

  type Answer = (req: { headers: Record<string, string>; signal: AbortSignal; n: number }) => Promise<Response> | Response;
  /** A sender whose tar route answers through serveTar unless `script` answers first. */
  function sender(script?: Answer) {
    const log: Array<{ range?: string; ifRange?: string }> = [];
    const fetchTar: PullDeps["fetchTar"] = async ({ headers, signal }) => {
      log.push({ range: headers.Range, ifRange: headers["If-Range"] });
      const scripted = await script?.({ headers, signal, n: log.length });
      if (scripted) return scripted;
      return serveTar({ file: spools.file(offerId), ...snap, range: headers.Range, ifRange: headers["If-Range"] });
    };
    return { fetchTar, log };
  }
  const pulls = (fetchTar: PullDeps["fetchTar"], timings?: PullDeps["timings"]) =>
    new Pulls({ root: () => rcvRoot, fetchTar, ...quiet, timings: { idleMs: 500, downWaitMs: 200, maxBackoffMs: 50, ...timings } });
  let n = 0;
  const job = (extra: Partial<Parameters<Pulls["pull"]>[0]> = {}) => ({
    offerId,
    linkId: "lk_0000000000000001",
    from: "node-a",
    resolvedDest: join(rcvRoot, "dest", String(++n)),
    rootNames: ["proj"],
    ...extra,
  });
  const landed = (dest: string) => assert.deepEqual(snapshotTree(join(dest, "proj")).filter((l) => !l.startsWith("random.bin")), snapshotTree(join(tmp, "big", "proj")).filter((l) => !l.startsWith("random.bin")));
  const sameBin = (dest: string) => assert.ok(readFileSync(join(dest, "proj", "random.bin")).equals(readFileSync(join(tmp, "big", "proj", "random.bin"))));

  test("learns the snapshot, downloads, verifies, extracts, deletes the .part", async () => {
    const s = sender();
    const learnt: unknown[] = [];
    const extracting: number[] = [];
    const j = job({ onSnapshot: (x) => learnt.push(x), onExtracting: () => extracting.push(1) });
    const r = await pulls(s.fetchTar).pull(j);
    assert.equal(r.received, snap.size);
    assert.deepEqual(learnt, [snap]);
    assert.equal(extracting.length, 1);
    landed(j.resolvedDest);
    sameBin(j.resolvedDest);
    assert.equal(readlinkSync(join(j.resolvedDest, "proj", "sub", "l")), "../a.txt");
    assert.throws(() => statSync(partFile(rcvRoot, offerId)));
  });

  test("a cut mid-body resumes with Range and If-Range from the bytes on disk", async () => {
    const s = sender(({ headers, n }) => {
      if (n !== 1) return undefined as unknown as Response;
      const full = serveTar({ file: spools.file(offerId), ...snap, range: headers.Range });
      // The first answer dies after ~1 MiB.
      const reader = full.body!.getReader();
      let sent = 0;
      const cut = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (sent > 1024 * 1024) return c.error(new Error("connection reset"));
          const { value, done } = await reader.read();
          if (done) return c.close();
          sent += value.length;
          c.enqueue(value);
        },
      });
      return new Response(cut, { status: 200, headers: full.headers });
    });
    const progress: number[] = [];
    const j = job({ onProgress: (p) => progress.push(p.retries) });
    await pulls(s.fetchTar).pull(j);
    assert.equal(s.log.length, 2);
    assert.match(s.log[1]!.range!, /^bytes=\d+-$/);
    assert.ok(Number(/=(\d+)/.exec(s.log[1]!.range!)![1]) > 0, "resumed from the bytes on disk");
    assert.equal(s.log[1]!.ifRange, `"${snap.sha256}"`);
    assert.equal(progress.at(-1), 1);
    sameBin(j.resolvedDest);
  });

  test("extraction overwrites what is at dest and fails tar-failed when it can't write", async () => {
    const s = sender();
    const dest = join(rcvRoot, "dest", "ro");
    mkdirSync(join(dest, "proj"), { recursive: true });
    writeFileSync(join(dest, "proj", "a.txt"), "old");
    await pulls(s.fetchTar).pull(job({ resolvedDest: dest }));
    assert.equal(readFileSync(join(dest, "proj", "a.txt"), "utf8"), "alpha");
    if (process.getuid?.() === 0) return; // root writes anywhere
    const ro = join(rcvRoot, "dest", "ro2");
    mkdirSync(ro, { recursive: true });
    execFileSync("chmod", ["555", ro]);
    try {
      const e = await refusal(pulls(s.fetchTar).pull(job({ resolvedDest: ro })));
      assert.equal(e.reason, "tar-failed");
    } finally {
      execFileSync("chmod", ["755", ro]);
    }
  });
});

describe("with the sandbox's own write rule: an existing root is decided by the pre-scan", () => {
  const cwd = join(tmp, "rcv", "cwd");
  const state = join(tmp, "rcv", "agent", "sova");
  const sessions = join(tmp, "rcv", "agent", "sessions");
  const protectedRoots = [state, sessions];
  before(() => mkdirSync(cwd, { recursive: true }));
  const dest = join(tmp, "rcv", "cwd", "into");
  const policy = {
    hidden: [] as string[],
    writable: [cwd],
    readOnlyWithinWritable: [join(dest, "pj", "locked"), join(dest, "fresh", ".git", "hooks")],
  };
  const sb = { writeDenial: (c: string, o?: { creating?: boolean }) => writeDenial(policy, c, o) };
  const sendRoot = join(tmp, "locked-sender");
  const rcvRoot = join(tmp, "locked-receiver");
  const spools = new Spools({ root: () => sendRoot, ...quiet });
  before(() => {
    makeTree(join(dest, "pj", "locked"), { "keep.txt": "keep" });
    makeTree(join(tmp, "locked-src", "a"), { pj: { "new.txt": "new" } });
    makeTree(join(tmp, "locked-src", "b"), { pj: { "new.txt": "new", locked: { x: "x" } } });
  });
  /** Offer `pj` from `src`, pull it into dest with the real pre-scan when checkDest asks for one. */
  async function offerAndPull(src: string, offerId: string) {
    const { scan } = checkDest({ resolvedDest: dest, rootNames: ["pj"], protectedRoots, sandbox: sb });
    const listing = await listOffer({ cwd: src, home, paths: ["pj"], sandbox: null });
    const snap = await spools.pack(offerId, listing);
    const pulls = new Pulls({
      root: () => rcvRoot,
      ...quiet,
      fetchTar: async ({ headers }) => serveTar({ file: spools.file(offerId), ...snap, range: headers.Range, ifRange: headers["If-Range"] }),
    });
    return pulls.pull({
      offerId,
      linkId: "lk_0000000000000001",
      from: "node-a",
      resolvedDest: dest,
      rootNames: ["pj"],
      prescan: scan
        ? async (members) => {
            const d = await prescan(members, { dest, roots: ["pj"], sandbox: { on: true, policy: policy as unknown as ResolvedPolicy }, protectedRoots });
            if (d) throw new TransferError(d.reason, d.message);
          }
        : undefined,
    });
  }

  test("an archive that leaves the read-only path alone is accepted and lands", async () => {
    await offerAndPull(join(tmp, "locked-src", "a"), "of_2000000000000001");
    assert.equal(readFileSync(join(dest, "pj", "new.txt"), "utf8"), "new");
    assert.equal(readFileSync(join(dest, "pj", "locked", "keep.txt"), "utf8"), "keep");
  });
});
