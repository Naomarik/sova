import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { Hono } from "hono";
import { FolderRefusal, listFolder, parseSource, readFolderFile, registerFolderReadRoutes, safeRef } from "./folder-read";
import { scratchRoot } from "./test-scratch";
import { deniedPath, FILE_MAX } from "./code-read";

// §app/folder-viewer

function repo(): { root: string; g: (...a: string[]) => string } {
  const root = scratchRoot("folder-read-");
  const g = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  g("init", "-q", "-b", "master");
  g("config", "user.name", "t");
  g("config", "user.email", "t@example.invalid");
  return { root, g };
}
const write = (root: string, rel: string, text: string | Buffer) => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const refusal = async (p: Promise<unknown>, status: number, re?: RegExp) => {
  await assert.rejects(p, (e: unknown) => e instanceof FolderRefusal && e.status === status && (!re || re.test(e.message)));
};

describe("a project folder at a ref", () => {
  test("lists the committed files of the folder, never the working tree's, with the commit", async () => {
    const { root, g } = repo();
    write(root, ".sova/playbooks/review/PLAYBOOK.md", "# Review\n");
    write(root, ".sova/playbooks/review/references/checklist.md", "- dead code\n");
    write(root, ".sova/playbooks/review/scripts/verdict.mjs", "process.exit(1)\n");
    write(root, ".sova/playbooks/review/.env", "KEY=1\n");
    g("add", "-A");
    g("commit", "-qm", "kit");
    const sha = g("rev-parse", "HEAD");
    write(root, ".sova/playbooks/review/uncommitted.md", "no\n");
    const deps = { rootOf: () => root };
    const l = await listFolder({ kind: "project", project: "p", ref: "", dir: ".sova/playbooks/review" }, deps);
    assert.equal(l.commit, sha);
    assert.deepEqual(
      l.files.map((f) => [f.path, f.kind]),
      [
        ["PLAYBOOK.md", "markdown"],
        ["references/checklist.md", "markdown"],
        ["scripts/verdict.mjs", "text"],
      ],
    );
    const f = await readFolderFile({ kind: "project", project: "p", ref: "master", dir: ".sova/playbooks/review" }, "scripts/verdict.mjs", deps);
    assert.deepEqual(f, { path: "scripts/verdict.mjs", kind: "text", text: "process.exit(1)\n" });
    await refusal(readFolderFile({ kind: "project", project: "p", ref: "", dir: ".sova/playbooks/review" }, "uncommitted.md", deps), 404);
    await refusal(readFolderFile({ kind: "project", project: "p", ref: "", dir: ".sova/playbooks/review" }, ".env", deps), 400);
  });

  test("reads at an older commit, and a bad or unknown ref is refused", async () => {
    const { root, g } = repo();
    write(root, "docs/a.md", "one\n");
    g("add", "-A");
    g("commit", "-qm", "1");
    const first = g("rev-parse", "HEAD");
    write(root, "docs/a.md", "two\n");
    g("commit", "-qam", "2");
    const deps = { rootOf: () => root };
    assert.equal((await readFolderFile({ kind: "project", project: "p", ref: first, dir: "docs" }, "a.md", deps)).text, "one\n");
    assert.equal((await readFolderFile({ kind: "project", project: "p", ref: "", dir: "docs" }, "a.md", deps)).text, "two\n");
    await refusal(listFolder({ kind: "project", project: "p", ref: "--output=/tmp/x", dir: "docs" }, deps), 400);
    await refusal(listFolder({ kind: "project", project: "p", ref: "nope", dir: "docs" }, deps), 404);
    await refusal(listFolder({ kind: "project", project: "p", ref: "", dir: "../x" }, deps), 400);
    await refusal(readFolderFile({ kind: "project", project: "p", ref: "", dir: "docs" }, "../../etc/passwd", deps), 400);
    await refusal(listFolder({ kind: "project", project: "p", ref: "", dir: ".git" }, deps), 400);
  });

  test("a project inside a larger repository reads its own folder", async () => {
    const { root, g } = repo();
    write(root, "app/notes/x.md", "x\n");
    g("add", "-A");
    g("commit", "-qm", "1");
    const l = await listFolder({ kind: "project", project: "p", ref: "", dir: "notes" }, { rootOf: () => join(root, "app") });
    assert.deepEqual(l.files.map((f) => f.path), ["x.md"]);
  });

  test("a binary or too-large file is listed but never read; a link is never followed; secrets are masked", async () => {
    const { root, g } = repo();
    write(root, "k/bin.dat", Buffer.from([1, 0, 2]));
    write(root, "k/big.txt", "a".repeat(FILE_MAX + 10));
    write(root, "k/keys.md", "token = abcdefghijklmnop\nfine\n");
    symlinkSync("/etc/hostname", join(root, "k/link.txt"));
    g("add", "-A");
    g("commit", "-qm", "1");
    const deps = { rootOf: () => root };
    const l = await listFolder({ kind: "project", project: "p", ref: "", dir: "k" }, deps);
    assert.deepEqual(
      l.files.map((f) => [f.path, f.kind]),
      [
        ["big.txt", "too-large"],
        ["bin.dat", "text"],
        ["keys.md", "markdown"],
      ],
    );
    await refusal(readFolderFile({ kind: "project", project: "p", ref: "", dir: "k" }, "bin.dat", deps), 400, /isn't text/);
    await refusal(readFolderFile({ kind: "project", project: "p", ref: "", dir: "k" }, "big.txt", deps), 400, /too large/);
    await refusal(readFolderFile({ kind: "project", project: "p", ref: "", dir: "k" }, "link.txt", deps), 404);
    assert.equal((await readFolderFile({ kind: "project", project: "p", ref: "", dir: "k" }, "keys.md", deps)).text, "[hidden]\nfine\n");
  });

  test("a project without Git: its files, never through a link leading out", async () => {
    const root = scratchRoot("folder-read-fs-");
    write(root, "notes/a.md", "a\n");
    symlinkSync("/etc", join(root, "notes/out"));
    const deps = { rootOf: () => root };
    const l = await listFolder({ kind: "project", project: "p", ref: "", dir: "notes" }, deps);
    assert.equal(l.commit, undefined);
    assert.deepEqual(l.files.map((f) => f.path), ["a.md"]);
    await refusal(readFolderFile({ kind: "project", project: "p", ref: "", dir: "notes" }, "out/hostname", deps), 404);
    await refusal(listFolder({ kind: "project", project: "p", ref: "master", dir: "notes" }, deps), 400);
    // The .sova exception is for committed trees only: on disk it stays denied.
    write(root, ".sova/playbooks/x/PLAYBOOK.md", "x\n");
    await refusal(listFolder({ kind: "project", project: "p", ref: "", dir: ".sova/playbooks/x" }, deps), 400);
    await refusal(readFolderFile({ kind: "project", project: "p", ref: "", dir: "" }, ".sova/playbooks/x/PLAYBOOK.md", deps), 400);
    assert.deepEqual((await listFolder({ kind: "project", project: "p", ref: "", dir: "" }, deps)).files.map((f) => f.path), ["notes/a.md"]);
  });

  test("in a committed tree .sova reads, but its secret-named files never do", async () => {
    const { root, g } = repo();
    write(root, ".sova/playbooks/r/PLAYBOOK.md", "r\n");
    write(root, ".sova/secrets/key.txt", "k\n");
    write(root, ".sova/api-token.txt", "t\n");
    g("add", "-A");
    g("commit", "-qm", "1");
    const deps = { rootOf: () => root };
    assert.deepEqual((await listFolder({ kind: "project", project: "p", ref: "", dir: ".sova" }, deps)).files.map((f) => f.path), ["playbooks/r/PLAYBOOK.md"]);
    await refusal(readFolderFile({ kind: "project", project: "p", ref: "", dir: ".sova" }, "api-token.txt", deps), 400);
    await refusal(listFolder({ kind: "project", project: "p", ref: "", dir: ".sova/secrets" }, deps), 400);
  });
});

describe("Sova's own folders", () => {
  test("a builtin reads only its allow-listed folder", async () => {
    const sova = scratchRoot("folder-read-sova-");
    write(sova, "playbooks/merge-queue/PLAYBOOK.md", "# Method\n");
    write(sova, "server/secret-ish.ts", "x\n");
    const deps = { rootOf: () => "/nowhere", sovaRoot: sova };
    const l = await listFolder({ kind: "builtin", id: "merge-queue-method" }, deps);
    assert.deepEqual(l.files.map((f) => f.path), ["PLAYBOOK.md"]);
    assert.equal((await readFolderFile({ kind: "builtin", id: "merge-queue-method" }, "PLAYBOOK.md", deps)).text, "# Method\n");
    await refusal(readFolderFile({ kind: "builtin", id: "merge-queue-method" }, "../../server/secret-ish.ts", deps), 400);
    assert.throws(() => parseSource({ kind: "builtin", id: "server" }), (e: unknown) => e instanceof FolderRefusal && e.status === 404);
  });

  test("the shipped merge-queue method is there", async () => {
    const l = await listFolder({ kind: "builtin", id: "merge-queue-method" }, { rootOf: () => "/nowhere" });
    assert.ok(l.files.some((f) => f.path === "PLAYBOOK.md"));
  });
});

describe("parsing and the deny list", () => {
  test("safeRef refuses options, ranges and odd characters", () => {
    for (const bad of ["-x", "a..b", "HEAD@{1}", "a b", "x;y", ""]) assert.equal(safeRef(bad), null, bad);
    for (const ok of ["master", "feat/x", "97927e0", "v1.2.3"]) assert.equal(safeRef(ok), ok);
  });
  test("the project's own .sova folder is readable only where the viewer asks; the rest of the deny list holds", () => {
    assert.equal(deniedPath(".sova/playbooks/review/PLAYBOOK.md"), true);
    assert.equal(deniedPath(".sova/playbooks/review/PLAYBOOK.md", { sovaOk: true }), false);
    assert.equal(deniedPath("a/.sova/x", { sovaOk: true }), true);
    assert.equal(deniedPath(".sova/secrets/x", { sovaOk: true }), true);
    assert.equal(deniedPath(".sova/.env", { sovaOk: true }), true);
  });
  test("parseSource takes the JSON param and refuses other shapes", () => {
    assert.deepEqual(parseSource('{"kind":"project","project":"prj_1","ref":"master","dir":"docs"}'), { kind: "project", project: "prj_1", ref: "master", dir: "docs" });
    assert.throws(() => parseSource("not json"), FolderRefusal);
    assert.throws(() => parseSource({ kind: "fs", root: "/" }), FolderRefusal);
  });
});

describe("the routes", () => {
  test("list and read answer JSON; a refusal is its status with the reason", async () => {
    const { root, g } = repo();
    write(root, "docs/a.md", "hello\n");
    g("add", "-A");
    g("commit", "-qm", "1");
    const app = new Hono();
    registerFolderReadRoutes(app, { rootOf: (id) => (id === "prj_1" ? root : (() => { throw new FolderRefusal(404, "No project"); })()) });
    const src = encodeURIComponent(JSON.stringify({ kind: "project", project: "prj_1", ref: "", dir: "docs" }));
    const l = await app.request(`/api/folders/list?src=${src}`);
    assert.equal(l.status, 200);
    assert.deepEqual(((await l.json()) as { files: { path: string }[] }).files.map((f) => f.path), ["a.md"]);
    const r = await app.request(`/api/folders/read?src=${src}&path=a.md`);
    assert.equal(((await r.json()) as { text: string }).text, "hello\n");
    const other = encodeURIComponent(JSON.stringify({ kind: "project", project: "prj_2", ref: "", dir: "docs" }));
    assert.equal((await app.request(`/api/folders/list?src=${other}`)).status, 404);
    assert.equal((await app.request(`/api/folders/list?src=nope`)).status, 400);
  });
});
