// What a Move keeps and what a package sends (§app.transport/moved-row, §app.transport/package): the old
// code folder goes into the safety copy whole, with what no package carries (an unticked private file,
// build output, a file written after packing), and a home's earlier safety copy never travels again.
import "../testing/scratch-agent-dir";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import { scratchRoot } from "../test-scratch";
import { buildPackage, compressFolder } from "./package";
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
