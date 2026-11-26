// What a Move keeps and what a package sends (§app.transport/moved-row, §app.transport/package): the old
// code folder goes into the safety copy whole, with what no package carries (an unticked private file,
// build output, a file written after packing), and a home's earlier safety copy never travels again.
import "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { scratchRoot } from "../test-scratch";
import { buildPackage, compressFolder, keepIo, verifyHome } from "./package";
import { listTar } from "./tar";

const root = scratchRoot("sova-transport-package-");
after(() => rmSync(root, { recursive: true, force: true }));

async function members(zst: string): Promise<string[]> {
  const tar = `${zst}.plain`;
  writeFileSync(tar, zstdDecompressSync(readFileSync(zst)));
  return (await listTar(tar)).map((m) => m.name.replace(/\/$/, ""));
}

test("a folder is kept whole: ignored files, build output, links and what came after packing", async () => {
  const wt = join(root, "wt");
  mkdirSync(join(wt, "target", "debug"), { recursive: true });
  writeFileSync(join(wt, ".git"), "gitdir: /elsewhere\n");
  writeFileSync(join(wt, ".env.local"), "SECRET=1\n");
  writeFileSync(join(wt, "target", "debug", "x"), "bin");
  writeFileSync(join(wt, "after-pack.txt"), "new\n");
  symlinkSync(".env.local", join(wt, "link"));
  const out = join(root, "wt.tar.zst");
  const r = await compressFolder(wt, out);
  assert.equal(r.entries, 7);
  assert.deepEqual(await members(out), ["wt/.env.local", "wt/.git", "wt/after-pack.txt", "wt/link", "wt/target", "wt/target/debug", "wt/target/debug/x"]);
  // The same folder keeps to the same bytes.
  const again = join(root, "wt-again.tar.zst");
  await compressFolder(wt, again);
  assert.deepEqual(readFileSync(again), readFileSync(out));
});

test("a folder's archive is on the disk before compressFolder returns (the caller removes the folder next): its bytes, then the rename naming it", async () => {
  const wt = join(root, "flushed");
  mkdirSync(wt);
  writeFileSync(join(wt, "a.txt"), "a\n");
  const out = join(root, "flushed.tar.zst");
  const seen: string[] = [];
  const was = { ...keepIo };
  keepIo.file = (f) => (seen.push(`file ${f} archive-named:${existsSync(out)}`), was.file(f));
  keepIo.dir = (d) => (seen.push(`dir ${d} archive-named:${existsSync(out)}`), was.dir(d));
  try {
    await compressFolder(wt, out);
  } finally {
    Object.assign(keepIo, was);
  }
  assert.deepEqual(seen, [`file ${out}.part archive-named:false`, `dir ${root} archive-named:true`]);
});

test("a home's earlier safety copy and its draft never go into a package", async () => {
  const home = join(root, "home");
  mkdirSync(join(home, "sessions"), { recursive: true });
  mkdirSync(join(home, "chat"), { recursive: true });
  mkdirSync(join(home, "transport"), { recursive: true });
  writeFileSync(join(home, "sessions", "t_L.jsonl"), '{"type":"session","id":"L"}\n{"type":"message","id":"torn"');
  writeFileSync(join(home, "chat", "draft.json"), "{}");
  writeFileSync(join(home, "transport", "tr_old.tar.zst"), "old package");
  const p = await buildPackage({
    tid: "tr_test01",
    spool: root,
    mode: "copy",
    chat: { id: "L", title: "t", cwd: root, file: "t_L.jsonl" },
    source: { nodeLabel: "a", stateRoot: root, agentDir: root, home, homeDir: root, codeRoot: root },
    trees: [],
    haves: [],
  });
  assert.deepEqual(Object.keys(p.manifest.home), ["sessions/t_L.jsonl"]);
  const names = await members(p.file);
  assert.ok(!names.some((n) => n.startsWith("home/transport") || n === "home/chat/draft.json"), names.join(", "));
  // The conversation is cut where its last complete line ends.
  assert.equal(p.homeBytes, '{"type":"session","id":"L"}\n'.length);
});

test("a Move's usage records travel beside the home, checked by hash on arrival", async () => {
  const home = join(root, "home-u");
  mkdirSync(join(home, "sessions"), { recursive: true });
  writeFileSync(join(home, "sessions", "t_U.jsonl"), '{"type":"session","id":"U"}\n');
  const usage = Buffer.from('{"v":1,"chat":"U","calls":[],"replies":[],"tools":[]}');
  const p = await buildPackage({
    tid: "tr_test02",
    spool: root,
    mode: "move",
    chat: { id: "U", title: "u", cwd: root, file: "t_U.jsonl" },
    source: { nodeLabel: "a", stateRoot: root, agentDir: root, home, homeDir: root, codeRoot: root },
    trees: [],
    haves: [],
    usage,
  });
  const names = await members(p.file);
  assert.ok(names.includes("usage.json") && !names.some((n) => n.startsWith("home/usage")), names.join(", "));
  const staged = join(root, "staged-u");
  mkdirSync(join(staged, "home", "sessions"), { recursive: true });
  writeFileSync(join(staged, "home", "sessions", "t_U.jsonl"), '{"type":"session","id":"U"}\n');
  writeFileSync(join(staged, "usage.json"), usage);
  assert.equal(await verifyHome(staged, p.manifest), null);
  writeFileSync(join(staged, "usage.json"), "{}");
  assert.equal(await verifyHome(staged, p.manifest), "its usage records didn't arrive exactly");
});
