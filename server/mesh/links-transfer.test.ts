// Run: pnpm exec tsx --test server/mesh/links-transfer.test.ts
// The bytes of a file offer with the host's real tar and zstd: listing (counts, exclude, symlinks,
// gitlinks, the sender's sandbox), packing into a spool, serving it with Range, the receiver's
// dest checks, and pulls that resume, verify and extract. The sender is a fake fetch that answers
// through serveTar. Every tree lives in a throwaway dir, removed after.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { createZstdDecompress } from "node:zlib";
import {
  checkDest,
  excludeMatcher,
  listOffer,
  type OfferListing,
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
import { tarMembers } from "./tar-list";

const tmp = mkdtempSync(join(tmpdir(), "sova-links-transfer-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));
const home = join(tmp, "home");
const work = join(home, "work");
const quiet = { log: () => undefined };

/** A tree from a spec: a string is a file's content, `{link}` a symlink, an object a directory. */
type Spec = { [name: string]: string | { link: string } | Spec };
function makeTree(dir: string, spec: Spec): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, v] of Object.entries(spec)) {
    const p = join(dir, name);
    if (typeof v === "string") writeFileSync(p, v);
    else if ("link" in v && typeof v.link === "string") symlinkSync(v.link, p);
    else makeTree(p, v as Spec);
  }
}

/** Every path under `dir` with its kind and content (file text, link target), sorted. */
function snapshotTree(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const n of execFileSync("ls", ["-A", dir], { encoding: "utf8" }).split("\n").filter(Boolean)) {
    const p = join(dir, n);
    const rel = base ? `${base}/${n}` : n;
    const st = lstatSync(p);
    if (st.isSymbolicLink()) out.push(`${rel} -> ${readlinkSync(p)}`);
    else if (st.isDirectory()) out.push(`${rel}/`, ...snapshotTree(p, rel));
    else out.push(`${rel} = ${readFileSync(p, "utf8")}`);
  }
  return out.sort();
}

async function spoolMembers(file: string): Promise<string[]> {
  const out: string[] = [];
  for await (const m of tarMembers(createReadStream(file).pipe(createZstdDecompress()))) out.push(m.name.replace(/\/$/, ""));
  return out;
}

async function refusal(p: Promise<unknown> | (() => unknown)): Promise<TransferError> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    if (err instanceof TransferError) return err;
    throw err;
  }
  assert.fail("expected a TransferError");
}

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

  test("a spool on disk reads ready after a restart", async () => {
    const again = new Spools({ root: () => root, ...quiet });
    assert.equal(again.status("of_0000000000000001")?.state, "ready");
    assert.equal(again.status("of_00000000000000ff"), null);
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

  test("a full disk fails the pack with a sentence (no-space)", async () => {
    const l = await listOffer({ cwd: work, home, paths: ["proj"], sandbox: null });
    const part = `${spoolFile(root, "of_0000000000000003")}.part`;
    symlinkSync("/dev/full", part);
    const e = await refusal(spools.pack("of_0000000000000003", l));
    assert.equal(e.reason, "no-space");
    assert.match(e.message, /No room to pack/);
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
    p = pulls(s.fetchTar, { downWaitMs: 60_000 });
    const t0 = Date.now();
    const j = job();
    await p.pull(j);
    assert.ok(Date.now() - t0 < 10_000, "the kick ended the wait");
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
    assert.throws(() => statSync(j.resolvedDest), "nothing extracted");
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
    assert.throws(() => statSync(j.resolvedDest));
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
