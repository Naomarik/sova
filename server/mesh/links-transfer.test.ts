// Run: pnpm test -- server/mesh/links-transfer.test.ts
// The bytes of a file offer, in-process: listing (counts, exclude, symlinks, gitlinks, the sender's
// sandbox), spools on disk, serving one with Range, the receiver's dest checks, and pulls that
// resume, verify and pre-scan. The sender is a fake fetch that answers through serveTar; spools are
// packed without tar (links-transfer-test-fixtures.ts), and extraction records what reached it. With
// the host's real tar (packing, a pull that lands, extraction over a tree):
// links-transfer.integration.test.ts. Every tree lives in a throwaway dir, removed after.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  checkDest,
  excludeMatcher,
  listOffer,
  type OfferListing,
  packChanged,
  PullCancelled,
  type PullDeps,
  Pulls,
  partFile,
  resolveDest,
  serveTar,
  Spools,
  spoolFile,
  TransferError,
} from "./links-transfer";
import { type ResolvedPolicy, writeDenial } from "../../pi-config/extensions/sandbox/policy.ts";
import { prescan } from "../link-sandbox";
import { makeTree, packInProcess, refusal } from "./links-transfer-test-fixtures";

const tmp = mkdtempSync(join(tmpdir(), "sova-links-transfer-test-"));
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

describe("excludeMatcher", () => {
  test("a pattern without / matches any component; with / the name from the root", () => {
    const ex = excludeMatcher(["node_modules", "*.log", "proj/dist", "src/**/gen", "[ab].tmp"]);
    assert.equal(ex("proj/node_modules"), true);
    assert.equal(ex("proj/node_modules/dep/index.js"), true);
    assert.equal(ex("proj/src/x.log"), true);
    assert.equal(ex("proj/dist"), true);
    assert.equal(ex("proj/dist/out.js"), true);
    assert.equal(ex("proj/src/dist"), false);
    assert.equal(ex("proj/a.txt"), false);
    assert.equal(ex("proj/a.tmp"), true);
    assert.equal(ex("proj/c.tmp"), false);
    assert.equal(excludeMatcher(["proj/**/gen"])("proj/a/b/gen"), true);
    assert.equal(excludeMatcher(["proj/**/gen"])("proj/gen"), true);
    assert.equal(excludeMatcher([])("anything"), false);
  });
});

describe("listOffer", () => {
  const base = { cwd: work, home, sandbox: null };

  test("counts regular files and bytes, lists directories and links, never follows a link", async () => {
    const l = await listOffer({ ...base, paths: ["proj", "notes.md"] });
    assert.deepEqual(
      l.roots.map((r) => [r.name, r.kind, r.files]),
      [
        ["proj", "dir", 6],
        ["notes.md", "file", 1],
      ],
    );
    assert.equal(l.files, 7);
    assert.equal(l.bytes, "alpha".length + "log".length + "main".length + "x".length + "dep".length + "out".length + "notes".length);
    assert.deepEqual(l.warnings, []);
    const names = l.packList.flatMap((p) => p.members);
    assert.ok(names.includes("proj/link-out"), "a symlink is a member");
    assert.ok(!names.some((n) => n.startsWith("proj/link-out/")), "never followed");
    assert.ok(names.includes("proj/empty"), "directories are members");
    // Every directory comes before what is in it.
    for (const [i, n] of names.entries()) {
      const parent = n.slice(0, n.lastIndexOf("/"));
      if (parent) assert.ok(names.indexOf(parent) < i, `${parent} before ${n}`);
    }
  });

  test("exclude drops members and their subtrees from the count", async () => {
    const l = await listOffer({ ...base, paths: ["proj"], exclude: ["node_modules", "*.log", "proj/dist"] });
    assert.equal(l.files, 2); // a.txt, src/main.ts
    const names = l.packList[0]!.members;
    assert.ok(!names.some((n) => n.includes("node_modules") || n.endsWith(".log") || n.startsWith("proj/dist")));
  });

  test("~ and absolute paths; a symlinked root travels as the link", async () => {
    symlinkSync(join(work, "proj"), join(work, "proj-link"));
    try {
      const l = await listOffer({ ...base, paths: ["~/outside", join(work, "proj-link")] });
      assert.deepEqual(
        l.roots.map((r) => [r.name, r.kind]),
        [
          ["outside", "dir"],
          ["proj-link", "symlink"],
        ],
      );
      assert.deepEqual(l.packList[1], { parent: work, members: ["proj-link"] });
    } finally {
      unlinkSync(join(work, "proj-link"));
    }
  });

  test("refused: a missing path, /, ~user, two roots with one name", async () => {
    assert.equal((await refusal(listOffer({ ...base, paths: ["nope"] }))).reason, "no-path");
    assert.equal((await refusal(listOffer({ ...base, paths: ["/"] }))).reason, "no-path");
    assert.equal((await refusal(listOffer({ ...base, paths: ["~root/x"] }))).reason, "no-path");
    assert.equal((await refusal(listOffer({ ...base, paths: [] }))).reason, "no-path");
    const same = await refusal(listOffer({ ...base, paths: ["notes.md", "other/notes.md"] }));
    assert.equal(same.reason, "same-name");
    assert.match(same.message, /dest\/notes\.md/);
  });

  describe("gitlinks", () => {
    before(() => {
      makeTree(join(work, "super"), {
        ".git": { modules: { sub: { HEAD: "ref" } } },
        sub: { ".git": "gitdir: ../.git/modules/sub\n", "f.txt": "f" },
      });
      makeTree(join(work, "wt"), { ".git": `gitdir: ${join(work, "main", ".git", "worktrees", "wt")}\n`, "f.txt": "f" });
    });

    test("a worktree's absolute gitdir warns", async () => {
      const l = await listOffer({ ...base, paths: ["wt"] });
      assert.deepEqual(l.warnings, [{ kind: "gitlink", root: "wt", path: "wt/.git", gitdir: join(work, "main", ".git", "worktrees", "wt") }]);
    });
    test("a submodule inside the offered superproject doesn't; offered alone it does", async () => {
      assert.deepEqual((await listOffer({ ...base, paths: ["super"] })).warnings, []);
      assert.deepEqual((await listOffer({ ...base, paths: ["super/sub"] })).warnings, [{ kind: "gitlink", root: "sub", path: "sub/.git", gitdir: "../.git/modules/sub" }]);
    });
    test(".git excluded: no warning", async () => {
      assert.deepEqual((await listOffer({ ...base, paths: ["wt"], exclude: [".git"] })).warnings, []);
    });
  });

  describe("the sender's sandbox", () => {
    const hidden = (paths: string[]) => ({
      readDenial: (c: string) => (paths.some((h) => c === h || c.startsWith(`${h}/`)) ? `${c} is hidden by the sandbox policy` : undefined),
      hiddenBelow: (root: string) => paths.filter((h) => h !== root && h.startsWith(`${root}/`)),
    });
    test("a hidden root is refused", async () => {
      const e = await refusal(listOffer({ ...base, paths: ["proj"], sandbox: hidden([join(work, "proj")]) }));
      assert.equal(e.reason, "hidden");
    });
    test("a hidden path below a root is refused by name; excluding it lets the offer through", async () => {
      const sb = hidden([join(work, "proj", "src")]);
      const e = await refusal(listOffer({ ...base, paths: ["proj"], sandbox: sb }));
      assert.equal(e.reason, "hidden");
      assert.match(e.message, /proj\/src/);
      assert.match(e.message, /exclude/);
      const l = await listOffer({ ...base, paths: ["proj"], sandbox: sb, exclude: ["proj/src"] });
      assert.equal(l.files, 4);
    });
    test("sandbox off: no check", async () => {
      assert.equal((await listOffer({ ...base, paths: ["proj"], sandbox: null })).files, 6);
    });
  });
});

describe("Spools", () => {
  const root = join(tmp, "state-sender");
  const spools = new Spools({ root: () => root, ...quiet });

  before(async () => {
    // The spool the tests below find on disk (packing it with tar: links-transfer.integration.test.ts).
    const l = await listOffer({ cwd: work, home, paths: ["proj", "~/outside", "notes.md"], exclude: ["node_modules"], sandbox: null });
    packInProcess(root, "of_0000000000000001", l);
  });


  test("a spool on disk reads ready after a restart", async () => {
    const again = new Spools({ root: () => root, ...quiet });
    assert.equal(again.status("of_0000000000000001")?.state, "ready");
    assert.equal(again.status("of_00000000000000ff"), null);
  });

  test("tar's exit 1 is a warning only with GNU tar's changed-file message; bsdtar's exit 1 is fatal", () => {
    assert.equal(packChanged(1, "tar: d/a.txt: file changed as we read it\n"), true);
    assert.equal(packChanged(1, "tar: d/a.txt: File shrank by 3 bytes; padding with zeros\n"), true);
    assert.equal(packChanged(1, "tar: d/gone.txt: Cannot stat: No such file or directory\ntar: Error exit delayed from previous errors.\n"), false);
    assert.equal(packChanged(1, ""), false);
    assert.equal(packChanged(2, "tar: d/a.txt: file changed as we read it\n"), false);
    assert.equal(packChanged(0, ""), false);
  });

  test("remove deletes the spool; sweep deletes what no open offer owns", async () => {
    mkdirSync(join(root, "mesh-links", "incoming"), { recursive: true });
    writeFileSync(partFile(root, "of_00000000000000aa"), "x");
    writeFileSync(partFile(root, "of_00000000000000bb"), "x");
    spools.sweep(new Set(["of_0000000000000001", "of_00000000000000aa"]));
    assert.ok(statSync(spoolFile(root, "of_0000000000000001")));
    assert.ok(statSync(partFile(root, "of_00000000000000aa")));
    assert.throws(() => statSync(partFile(root, "of_00000000000000bb")));
    spools.remove("of_0000000000000001");
    assert.throws(() => statSync(spoolFile(root, "of_0000000000000001")));
  });
});

describe("serveTar", () => {
  const file = join(tmp, "blob");
  const data = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  const sha256 = "a".repeat(64);
  before(() => writeFileSync(file, data));
  const serve = (h: { range?: string; ifRange?: string }, served?: number[]) =>
    serveTar({ file, sha256, size: data.length, ...h, ...(served ? { onServed: (n: number) => served.push(n) } : {}) });

  test("200 whole, with ETag and length; counts what it served", async () => {
    const served: number[] = [];
    const r = serve({}, served);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("ETag"), `"${sha256}"`);
    assert.equal(r.headers.get("Content-Length"), "1000");
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), data);
    assert.equal(served.at(-1), 1000);
  });
  test("206 from an offset, with Content-Range", async () => {
    const r = serve({ range: "bytes=600-", ifRange: `"${sha256}"` });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("Content-Range"), "bytes 600-999/1000");
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), data.subarray(600));
  });
  test("If-Range naming another spool: the whole spool, 200", async () => {
    const r = serve({ range: "bytes=600-", ifRange: `"${"b".repeat(64)}"` });
    assert.equal(r.status, 200);
    assert.equal((await r.arrayBuffer()).byteLength, 1000);
  });
  test("416 past the end", async () => {
    const r = serve({ range: "bytes=1000-" });
    assert.equal(r.status, 416);
    assert.equal(r.headers.get("Content-Range"), "bytes */1000");
    assert.notDeepEqual(await r.json(), { error: "Not found" });
  });
});

describe("resolveDest and checkDest", () => {
  const cwd = join(tmp, "rcv", "cwd");
  const state = join(tmp, "rcv", "agent", "sova");
  const sessions = join(tmp, "rcv", "agent", "sessions");
  before(() => {
    mkdirSync(cwd, { recursive: true });
    mkdirSync(state, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    symlinkSync(cwd, join(tmp, "rcv", "cwd-link"));
    writeFileSync(join(cwd, "a-file"), "x");
  });
  const r = (d: string) => resolveDest(d, { cwd, home: join(tmp, "rcv") });

  test("~, relative, .., and symlinks resolved", () => {
    assert.equal(r("~"), join(tmp, "rcv"));
    assert.equal(r("~/in"), join(tmp, "rcv", "in"));
    assert.equal(r("in/deeper"), join(cwd, "in", "deeper"));
    assert.equal(r("../x"), join(tmp, "rcv", "x"));
    assert.equal(r(join(tmp, "rcv", "cwd-link", "new")), join(cwd, "new"));
  });
  test("refused: empty, ~user, NUL", async () => {
    for (const d of ["", "  ", "~root/x", "a\0b"]) assert.equal((await refusal(() => r(d))).reason, "bad-dest", d);
  });

  const protectedRoots = [state, sessions];
  test("inside a protected root: refused", async () => {
    for (const d of [state, join(state, "x"), join(sessions, "y")]) {
      assert.equal((await refusal(() => checkDest({ resolvedDest: d, rootNames: ["p"], protectedRoots, sandbox: null }))).reason, "protected", d);
    }
  });
  test("a protected root under dest: refused only when an offered root lands on it; scanned otherwise", async () => {
    const agentParent = join(tmp, "rcv");
    const e = await refusal(() => checkDest({ resolvedDest: agentParent, rootNames: ["agent"], protectedRoots, sandbox: null }));
    assert.equal(e.reason, "protected");
    assert.deepEqual(checkDest({ resolvedDest: agentParent, rootNames: ["proj"], protectedRoots, sandbox: null }), { scan: true });
    assert.deepEqual(checkDest({ resolvedDest: join(cwd, "in"), rootNames: ["agent"], protectedRoots, sandbox: null }), { scan: false });
  });
  test("a root name that isn't one plain component: bad-dest", async () => {
    for (const n of ["", ".", "..", "../x", "a/b"]) assert.equal((await refusal(() => checkDest({ resolvedDest: join(cwd, "in"), rootNames: [n], protectedRoots, sandbox: null }))).reason, "bad-dest", n);
  });
  test("an existing non-directory: bad-dest", async () => {
    assert.equal((await refusal(() => checkDest({ resolvedDest: join(cwd, "a-file"), rootNames: ["p"], protectedRoots, sandbox: null }))).reason, "bad-dest");
  });
  test("the sandbox's write check on dest and on each root under it; always scanned", async () => {
    const calls: Array<[string, boolean | undefined]> = [];
    const writable = (roots: string[]) => ({
      writeDenial: (c: string, o?: { creating?: boolean }) => {
        calls.push([c, o?.creating]);
        return roots.some((w) => c === w || c.startsWith(`${w}/`)) ? undefined : `${c} is outside the sandbox's writable roots`;
      },
    });
    assert.deepEqual(checkDest({ resolvedDest: join(cwd, "in"), rootNames: ["p", "q"], protectedRoots, sandbox: writable([cwd]) }), { scan: true });
    assert.deepEqual(calls, [
      [join(cwd, "in"), true],
      [join(cwd, "in", "p"), true],
      [join(cwd, "in", "q"), true],
    ]);
    const e = await refusal(() => checkDest({ resolvedDest: join(tmp, "rcv", "elsewhere"), rootNames: ["p"], protectedRoots, sandbox: writable([cwd]) }));
    assert.equal(e.reason, "not-writable");
    // A tracked worktree is one more writable root.
    const tree = join(tmp, "rcv", "tree");
    assert.deepEqual(checkDest({ resolvedDest: tree, rootNames: ["p"], protectedRoots, sandbox: writable([cwd, tree]) }), { scan: true });
  });

  describe("with the sandbox's own write rule: an existing root is decided by the pre-scan", () => {
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
    const extracted: string[] = [];
    before(() => {
      makeTree(join(dest, "pj", "locked"), { "keep.txt": "keep" });
      makeTree(join(tmp, "locked-src", "a"), { pj: { "new.txt": "new" } });
      makeTree(join(tmp, "locked-src", "b"), { pj: { "new.txt": "new", locked: { x: "x" } } });
    });
    /** Offer `pj` from `src`, pull it into dest with the real pre-scan when checkDest asks for one. */
    async function offerAndPull(src: string, offerId: string) {
      const { scan } = checkDest({ resolvedDest: dest, rootNames: ["pj"], protectedRoots, sandbox: sb });
      const listing = await listOffer({ cwd: src, home, paths: ["pj"], sandbox: null });
      const snap = packInProcess(sendRoot, offerId, listing);
      const pulls = new Pulls({
        root: () => rcvRoot,
        ...quiet,
        extract: async (_part, into) => void extracted.push(into),
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

    test("an archive that leaves the read-only path alone is accepted and reaches extraction", async () => {
      await offerAndPull(join(tmp, "locked-src", "a"), "of_2000000000000001");
      assert.deepEqual(extracted, [dest]);
    });
    test("an archive with a member in it passes the offer, then the pre-scan refuses naming it", async () => {
      const e = await refusal(offerAndPull(join(tmp, "locked-src", "b"), "of_2000000000000002"));
      assert.equal(e.reason, "not-writable");
      assert.match(e.message, /pj\/locked/);
      assert.deepEqual(extracted, [dest], "nothing more extracted");
    });
    test("a root not there yet that would hold a protected path is still refused at the offer", async () => {
      const e = await refusal(() => checkDest({ resolvedDest: dest, rootNames: ["fresh"], protectedRoots, sandbox: sb }));
      assert.equal(e.reason, "not-writable");
      assert.match(e.message, /fresh/);
    });
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
    snap = packInProcess(sendRoot, offerId, listing);
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
  /** What reached extraction: each dest with the archive's bytes then (tar -x itself: the integration file). */
  const extracted = new Map<string, Buffer>();
  const extract: PullDeps["extract"] = async (part, dest) => void extracted.set(dest, readFileSync(part));
  const pulls = (fetchTar: PullDeps["fetchTar"], timings?: PullDeps["timings"]) =>
    new Pulls({ root: () => rcvRoot, fetchTar, extract, ...quiet, timings: { idleMs: 500, downWaitMs: 200, maxBackoffMs: 50, ...timings } });
  let n = 0;
  const job = (extra: Partial<Parameters<Pulls["pull"]>[0]> = {}) => ({
    offerId,
    linkId: "lk_0000000000000001",
    from: "node-a",
    resolvedDest: join(rcvRoot, "dest", String(++n)),
    rootNames: ["proj"],
    ...extra,
  });
  /** The verified spool, byte for byte, went to extraction into dest. */
  const sameBin = (dest: string) => assert.ok(extracted.get(dest)?.equals(readFileSync(spools.file(offerId))), `the spool reached extraction into ${dest}`);

  test("learns the snapshot, downloads, verifies, extracts, deletes the .part", async () => {
    const s = sender();
    const learnt: unknown[] = [];
    const extracting: number[] = [];
    const j = job({ onSnapshot: (x) => learnt.push(x), onExtracting: () => extracting.push(1) });
    const r = await pulls(s.fetchTar).pull(j);
    assert.equal(r.received, snap.size);
    assert.deepEqual(learnt, [snap]);
    assert.equal(extracting.length, 1);
    sameBin(j.resolvedDest);
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

  test("a sender that stalls: the idle watchdog aborts and the pull resumes", async () => {
    const s = sender(({ headers, n, signal }) => {
      if (n !== 1) return undefined as unknown as Response;
      const full = serveTar({ file: spools.file(offerId), ...snap, range: headers.Range });
      const reader = full.body!.getReader();
      let first = true;
      const stall = new ReadableStream<Uint8Array>({
        async pull(c) {
          if (!first) {
            // Never another byte; the abort ends it.
            await new Promise((_, no) => signal.addEventListener("abort", () => no(signal.reason)));
          }
          first = false;
          const { value } = await reader.read();
          c.enqueue(value!);
        },
      });
      return new Response(stall, { status: 200, headers: full.headers });
    });
    const j = job();
    await pulls(s.fetchTar, { idleMs: 150 }).pull(j);
    assert.equal(s.log.length, 2);
    assert.ok(s.log[1]!.range);
    sameBin(j.resolvedDest);
  });

  test("503 packing is waited out; a down sender is waited for and kicked", async () => {
    let p!: Pulls;
    const s = sender(({ n }) => {
      if (n === 1) return new Response(JSON.stringify({ state: "packing", written: 10 }), { status: 503, headers: { "Retry-After": "0" } });
      if (n === 2) {
        setTimeout(() => p.kick("node-a"), 20);
        throw new TypeError("fetch failed");
      }
      return undefined as unknown as Response;
    });
    // A minute's wait for the down sender: only the kick ends it within the runner's per-test timeout.
    p = pulls(s.fetchTar, { downWaitMs: 60_000 });
    const j = job();
    await p.pull(j);
    assert.equal(s.log.length, 3);
    sameBin(j.resolvedDest);
  });

  test("a complete .part (a restart after the download) is verified and extracted, not fetched", async () => {
    mkdirSync(join(rcvRoot, "mesh-links", "incoming"), { recursive: true });
    writeFileSync(partFile(rcvRoot, offerId), readFileSync(spools.file(offerId)));
    const s = sender();
    const j = job({ snapshot: snap });
    await pulls(s.fetchTar).pull(j);
    assert.equal(s.log.length, 0);
    sameBin(j.resolvedDest);
  });

  test("a corrupt download restarts once from 0, then fails bad-hash", async () => {
    const bad = { sha256: "0".repeat(64), size: snap.size };
    const s = sender(({ headers }) => serveTar({ file: spools.file(offerId), ...bad, range: headers.Range, ifRange: headers["If-Range"] }));
    const j = job();
    const e = await refusal(pulls(s.fetchTar).pull(j));
    assert.equal(e.reason, "bad-hash");
    assert.equal(s.log.length, 2);
    assert.equal(s.log[1]!.range, undefined, "restarted from 0");
    assert.throws(() => statSync(partFile(rcvRoot, offerId)));
    assert.equal(extracted.has(j.resolvedDest), false, "nothing extracted");
  });

  test("a spool re-packed under a resume (If-Range mismatch → 200) starts over", async () => {
    mkdirSync(join(rcvRoot, "mesh-links", "incoming"), { recursive: true });
    writeFileSync(partFile(rcvRoot, offerId), Buffer.alloc(1000, 1)); // bytes of an older spool
    const s = sender();
    const learnt: unknown[] = [];
    const j = job({ snapshot: { sha256: "c".repeat(64), size: snap.size }, onSnapshot: (x) => learnt.push(x) });
    await pulls(s.fetchTar).pull(j);
    assert.equal(s.log[0]!.range, "bytes=1000-");
    assert.deepEqual(learnt, [snap]);
    sameBin(j.resolvedDest);
  });

  test("the sender's refusal is final: its reason and sentence", async () => {
    const s = sender(() => new Response(JSON.stringify({ error: "That offer was cancelled.", reason: "ended" }), { status: 410 }));
    const e = await refusal(pulls(s.fetchTar).pull(job()));
    assert.equal(e.reason, "ended");
    assert.match(e.message, /cancelled/);
  });

  test("the pre-scan refuses: nothing extracted, .part gone", async () => {
    const s = sender();
    const seen: string[] = [];
    const j = job({
      prescan: async (members) => {
        for await (const m of members) seen.push(m.name);
        throw new TransferError("not-writable", "proj/sub is not writable");
      },
    });
    const e = await refusal(pulls(s.fetchTar).pull(j));
    assert.equal(e.reason, "not-writable");
    assert.ok(seen.includes("proj/sub/"));
    assert.equal(extracted.has(j.resolvedDest), false, "nothing extracted");
    assert.throws(() => statSync(partFile(rcvRoot, offerId)));
  });

  test("a pre-scan that refuses without reading leaves no stream behind", async () => {
    const s = sender();
    const j = job({
      prescan: async () => {
        throw new TransferError("not-writable", "the sandbox is on but unresolvable");
      },
    });
    assert.equal((await refusal(pulls(s.fetchTar).pull(j))).reason, "not-writable");
    // An unhandled stream error would surface on the next ticks and fail the run.
    await new Promise((ok) => setTimeout(ok, 50));
    assert.throws(() => statSync(partFile(rcvRoot, offerId)));
  });

  test("cancel stops a waiting pull and deletes its .part", async () => {
    let p!: Pulls;
    const s = sender(() => {
      setTimeout(() => p.cancel(offerId), 20);
      throw new TypeError("fetch failed");
    });
    p = pulls(s.fetchTar, { downWaitMs: 60_000 });
    await assert.rejects(p.pull(job()), PullCancelled);
    assert.throws(() => statSync(partFile(rcvRoot, offerId)));
  });

});
