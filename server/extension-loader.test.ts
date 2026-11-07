// Run: pnpm test -- server/extension-loader.test.ts
// The folder and the loader, in-process: what a folder says, the one reason it can't be used, the two
// readers, approval by version, the first start's approvals, peers, the doors and what cards do. The running of
// a program is server/extension-loader.integration.test.ts.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, beforeEach, describe, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";
import { MENU_PLACES } from "../shared/extension-offers";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-ext-loader-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.SOVA_EXTENSIONS_FILE;
mkdirSync(join(root, "agent", "sova"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

const { readDescription } = await import("./extension-description");
const gate = await import("./extension-gate");
const fp = await import("./extension-fingerprint");
const ext = await import("./extensions");
const { resolveProgram, extensionDataDir, programEnv } = await import("./extension-program");
const { rowOf } = await import("./extension-routes");
const { reviewFolder } = await import("./extension-loader");
const { ExtensionSync } = await import("./sync/extensions");
const cards = await import("./transcript-cards");

const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
let n = 0;
function folder(desc: unknown, files: Record<string, string> = {}): string {
  const dir = join(root, `f${++n}`);
  mkdirSync(dir, { recursive: true });
  if (desc !== undefined) put(join(dir, "sova-extension.json"), typeof desc === "string" ? desc : JSON.stringify(desc));
  for (const [k, v] of Object.entries(files)) put(join(dir, k), v);
  return dir;
}
const base = (over: object = {}) => ({ version: 1, id: "notes", title: "Notes", needsContract: "1.20", ...over });
const reason = (d: string) => {
  const r = readDescription(d);
  return r.ok ? "ok" : r.reason;
};
const listFile = () => join(root, "agent", "sova", "extensions.json");
const writeList = (extensions: unknown[]) => writeFileSync(listFile(), JSON.stringify({ version: 1, extensions }));

/** Approve an entry as Install does. */
function approve(raw: Record<string, unknown>) {
  const folders = fp.codeFoldersOf(raw);
  const entry = gate.entryHash(raw);
  const code = fp.codeHashNow(folders);
  const sig = fp.codeSigNow(folders);
  gate.recordApproval(raw.id as string, { version: gate.versionOf(entry, code), entry, code, sig });
  gate.setCodeReading(raw.id as string, { sig, code });
}

beforeEach(() => {
  rmSync(listFile(), { force: true });
  rmSync(gate.extensionTrustFile(), { force: true });
  gate.resetGateForTest();
  gate.migrateTrust(() => ({}));
});

describe("a folder names an extension or says why not", () => {
  test("in the deck's order, the first thing that fails is the one answer", () => {
    assert.match(reason(folder(undefined)), /no extension description/);
    assert.match(reason(folder("{nope")), /can't be read/);
    assert.match(reason(folder({ id: "x" })), /doesn't say which Sova/);
    assert.match(reason(folder(base({ needsContract: 1.2 }))), /doesn't say which Sova/);
    // A newer file with keys this Sova doesn't know says newer, not broken.
    assert.equal(reason(folder(base({ needsContract: "1.99", wat: 1 }))), `This needs a newer Sova (1.99; this one has ${ext.contractWords()}).`);
    assert.equal(reason(folder(base({ needsContract: "2.0" }))), `This needs a newer Sova (2.0; this one has ${ext.contractWords()}).`);
    assert.match(reason(folder(base({ wat: 1 }))), /key Sova doesn't know: wat/);
    assert.match(reason(folder(base({ backend: { run: ["x"], wat: 1 } }))), /key Sova doesn't know: backend.wat/);
    assert.match(reason(folder(base({ version: 2 }))), /version must be 1/);
    assert.match(reason(folder(base({ id: "a/b" }))), /can't be used: id/);
    assert.match(reason(folder(base({ title: "two\nlines" }))), /can't be used: title/);
    assert.match(reason(folder(base({ page: "../x" }))), /can't be used: page/);
    assert.match(reason(folder(base({ page: "dist" }), { "dist/a.txt": "" })), /index.html/);
    assert.match(reason(folder(base({ backend: { run: "node x" } }))), /can't be used: backend/);
    assert.match(reason(folder(base({ backend: { run: ["x"], folder: "../.." } }))), /can't be used: backend/);
    assert.equal(reason(folder(base({ id: "Project" }))), "The name project is Sova's own, so this can't be added.");
    assert.equal(reason(folder(base({ commands: [{ name: "a", label: "A" }] }))), "It lists commands or screens but no program to answer them.");
    assert.equal(reason(folder(base({ screens: ["row"] }))), "It lists commands or screens but no program to answer them.");
  });
  test("an id on the list from another folder is taken; the same folder isn't", () => {
    const d = folder(base());
    writeList([{ id: "notes", folder: join(root, "elsewhere") }]);
    assert.match(reason(d), /already an extension named notes/);
    writeList([{ id: "notes", folder: d }]);
    assert.equal(reason(d), "ok");
  });
  test("what it describes becomes an entry; one bad item leaves out only itself, and says so", () => {
    const d = folder(
      base({ page: "dist", backend: { run: ["node", "b/s.mjs"], folder: "b" }, commands: [{ name: "ok", label: "OK", overseer: true }, { name: "BAD", label: "x" }], cards: [{ name: "ask", title: "Ask", draws: "buttons", answer: "at-once", toolkit: 1 }, { name: "Bad", title: "x", draws: "table", toolkit: 1 }] }),
      { "dist/index.html": "", "b/s.mjs": "" },
    );
    const r = readDescription(d);
    assert.ok(r.ok);
    assert.deepEqual([r.described.entry.dist, r.described.entry.programFolder, r.described.entry.run], [join(d, "dist"), join(d, "b"), ["node", "b/s.mjs"]]);
    assert.deepEqual(r.described.asks, { program: ["node", "b/s.mjs"], page: true, key: true, cards: ["Ask"], commands: ["OK"], overseer: ["OK"] });
    assert.equal(r.described.leftOut.length, 2);
  });
  test("a part it doesn't have asks for nothing", () => {
    const r = readDescription(folder(base({ cards: [{ name: "ask", title: "Ask", draws: "buttons", answer: "at-once", toolkit: 1 }] })));
    assert.ok(r.ok);
    assert.deepEqual(r.described.asks, { cards: ["Ask"] });
  });
});

describe("Choose Folder reads the folder for that one extension", () => {
  test("a folder describing another id is refused at the pick, by both names; the same id goes to review", async () => {
    const d = folder(base({ page: "dist" }), { "dist/index.html": "<p>" });
    const other = await reviewFolder(d, "bookmarks");
    assert.equal(other.ok, false);
    assert.ok(!other.ok && other.reason.includes("notes") && other.reason.includes("bookmarks"), JSON.stringify(other));
    const same = await reviewFolder(d, "notes");
    assert.ok(same.ok && same.review.id === "notes", JSON.stringify(same));
  });
});

describe("code stays where approval can see it", () => {
  test("a page, a program folder or a program file inside a folder approval skips is refused, in plain words", () => {
    assert.equal(reason(folder(base({ page: "data/dist" }), { "data/dist/index.html": "" })), "Its page is in data, which approval doesn't check, so this can't be added. Move it to another folder.");
    assert.equal(reason(folder(base({ backend: { run: ["node", "s.mjs"], folder: "logs/b" } }), { "logs/b/s.mjs": "" })), "Its program is in logs, which approval doesn't check, so this can't be added. Move it to another folder.");
    assert.equal(reason(folder(base({ backend: { run: ["node", "node_modules/x/s.mjs"] } }), { "node_modules/x/s.mjs": "" })), "Its program is in node_modules, which approval doesn't check, so this can't be added. Move it to another folder.");
    assert.equal(reason(folder(base({ backend: { run: ["data/run"] } }), { "data/run": "" })), "Its program is in data, which approval doesn't check, so this can't be added. Move it to another folder.");
  });
  test("once links are followed", async () => {
    const { symlinkSync } = await import("node:fs");
    const d = folder(base({ backend: { run: ["node", "s.mjs"] } }), { "data/s.mjs": "" });
    symlinkSync(join(d, "data/s.mjs"), join(d, "s.mjs"));
    assert.match(reason(d), /program is in data/);
  });
  test("a bare argument that names a folder is only an argument", () => {
    assert.equal(reason(folder(base({ backend: { run: ["node", "s.mjs", "logs"] } }), { "s.mjs": "", "logs/x": "" })), "ok");
    assert.equal(reason(folder(base({ backend: { run: ["node", "s.mjs", "--dir=data"] } }), { "s.mjs": "", "data/x": "" })), "ok");
  });
});

describe("two readers, and approval by version", () => {
  const entry = (d: string, over: object = {}) => ({ id: "notes", title: "Notes", folder: d, dist: join(d, "dist"), ...over });
  const page = () => folder(base({ page: "dist" }), { "dist/index.html": "<p>", "dist/data/x": "1", "dist/logs/x": "1", "dist/a.log": "1" });
  const state = () => ext.listedExtensions()![0]!.state;

  test("no approval: on the list, waiting, and nothing acts on it", () => {
    const d = page();
    writeList([entry(d)]);
    assert.equal(state(), "waiting");
    assert.deepEqual(ext.readExtensions(), []);
    assert.deepEqual(ext.installedIdsForKeys(), []);
    assert.equal(ext.findExtension("notes"), undefined);
    assert.deepEqual(ext.listedIds(), ["notes"]);
  });
  test("approved: active; off keeps its place and drops from every reader but the tab's", () => {
    const d = page();
    const e = entry(d);
    writeList([e]);
    approve(e);
    assert.equal(state(), "on");
    assert.equal(ext.findExtension("notes")?.id, "notes");
    writeList([{ ...e, off: true }]);
    assert.equal(state(), "off", "off isn't part of what you approved");
    assert.deepEqual(ext.installedIdsForKeys(), []);
    assert.equal(ext.findExtension("notes"), undefined);
  });
  test("an edited record waits: its new declarations never go live under an older approval", () => {
    const d = page();
    const e = entry(d);
    writeList([e]);
    approve(e);
    writeList([{ ...e, title: "Other" }]);
    assert.equal(state(), "waiting");
    assert.equal(ext.listedExtensions()![0]!.approvedBefore, true);
    assert.equal(ext.findExtension("notes"), undefined);
  });
  test("the port Sova assigned to a program it runs isn't part of the version; a hand-written api is", () => {
    const run = { id: "a", run: ["x"], api: "http://127.0.0.1:1" };
    assert.equal(gate.entryHash(run), gate.entryHash({ ...run, api: "http://127.0.0.1:2" }));
    assert.equal(gate.entryHash({ ...run, off: true }), gate.entryHash(run));
    const own = { id: "a", api: "http://127.0.0.1:1" };
    assert.notEqual(gate.entryHash(own), gate.entryHash({ ...own, api: "http://127.0.0.1:2" }));
  });
  test("changed code: active, its page off, as long as the last reading says so", () => {
    const d = page();
    const e = entry(d);
    writeList([e]);
    approve(e);
    gate.setCodeReading("notes", { sig: "moved", code: "other" });
    assert.equal(state(), "changed");
    assert.equal(ext.findExtension("notes")?.changed, true);
    const r = ext.serveExtensionFile(ext.findExtension("notes")!, "");
    assert.equal(r.status, 404);
    assert.deepEqual(ext.publishedExtensions()[0]!.changed, undefined, "never published");
    writeList([{ ...e, off: true }]);
    assert.equal(ext.listedExtensions()![0]!.active, false, "off wins for what runs");
  });
  test("a folder gone and a contract too new are not active", () => {
    const d = page();
    const e = entry(d);
    writeList([e]);
    approve(e);
    gate.setCodeReading("notes", { sig: "", missing: true });
    assert.equal(state(), "folder-not-found");
    assert.equal(ext.findExtension("notes"), undefined);
    gate.forgetCodeReading("notes");
    const newer = { ...e, needsContract: "1.99" };
    writeList([newer]);
    approve(newer);
    assert.equal(state(), "needs-newer");
    assert.equal(ext.findExtension("notes"), undefined);
  });
  test("a dropped entry is on the tab's list and nowhere else", () => {
    writeList([{ id: "bad id" }, { id: "x", needsContract: "soon" }]);
    const l = ext.listedExtensions()!;
    assert.deepEqual(l.map((x) => x.state), ["not-usable", "not-usable"]);
    assert.match(l[0]!.error!, /bad id/);
    assert.deepEqual(ext.readExtensions(), []);
  });
  test("a list that can't be read whole is null to both, so nothing is revoked", () => {
    writeFileSync(listFile(), "{half");
    assert.equal(ext.listedExtensions(), null);
    assert.equal(ext.installedIdsForKeys(), null);
  });
  test("a named list counts as approved and never reads Changed, and can still be off", () => {
    const named = join(root, "named.json");
    writeFileSync(named, JSON.stringify({ version: 1, extensions: [{ id: "n", dist: "/x", api: "http://127.0.0.1:1" }] }));
    process.env.SOVA_EXTENSIONS_FILE = named;
    try {
      gate.setCodeReading("n", { sig: "x", code: "other" });
      assert.equal(ext.listedExtensions()![0]!.state, "on");
      writeFileSync(named, JSON.stringify({ version: 1, extensions: [{ id: "n", dist: "/x", api: "http://127.0.0.1:1", off: true }] }));
      assert.equal(ext.listedExtensions()![0]!.state, "off");
    } finally {
      delete process.env.SOVA_EXTENSIONS_FILE;
      gate.forgetCodeReading("n");
    }
  });
  test("the first start approves what is there, once; the file exists even with none, so anything later waits", () => {
    rmSync(gate.extensionTrustFile(), { force: true });
    gate.resetGateForTest();
    const e = { id: "old", dist: "/x", api: "http://127.0.0.1:1" };
    writeList([e]);
    assert.equal(ext.listedExtensions()![0]!.state, "on", "before the first start, nothing has been decided");
    gate.migrateTrust(() => ({ old: { version: "v", entry: gate.entryHash(e), code: "c", sig: "s", at: "" } }));
    assert.equal(ext.listedExtensions()![0]!.state, "on");
    writeList([e, { id: "later", dist: "/y", api: "http://127.0.0.1:2" }]);
    assert.deepEqual(ext.listedExtensions()!.map((l) => l.state), ["on", "waiting"]);
    gate.migrateTrust(() => {
      throw new Error("a second start seeds nothing");
    });
    // None at all: the file is still written, and deleting it later doesn't reopen the door in this process.
    rmSync(gate.extensionTrustFile(), { force: true });
    gate.resetGateForTest();
    gate.migrateTrust(() => ({}));
    writeList([{ id: "later", dist: "/y", api: "http://127.0.0.1:2" }]);
    assert.equal(ext.listedExtensions()![0]!.state, "waiting");
  });
  test("no page and no program: nothing is probed or served, and neither is an error", async () => {
    writeList([{ id: "cards-only", title: "C" }]);
    approve({ id: "cards-only", title: "C" });
    const [info] = await ext.listExtensions();
    assert.deepEqual(info, { id: "cards-only", title: "C", status: "ok", page: false });
    const e = ext.findExtension("cards-only")!;
    assert.equal(await ext.serveExtensionFile(e, "").text(), "This extension has no page.");
  });
  test("a command in any of the five menus reaches the page's list, and so a menu, only while approved and on", async () => {
    const e = { id: "menus", title: "M", commands: MENU_PLACES.map((menu) => ({ name: menu, label: `File ${menu}`, menu })) };
    const menus = async () => (await ext.listExtensions()).find((x) => x.id === "menus")?.offers?.commands?.map((c) => c.menu);
    writeList([e]);
    assert.equal(await menus(), undefined, "waiting for you: not on the page's list");
    approve(e);
    assert.deepEqual(await menus(), [...MENU_PLACES]);
    writeList([{ ...e, off: true }]);
    assert.equal(await menus(), undefined, "turned off");
    writeList([e]);
    assert.deepEqual(await menus(), [...MENU_PLACES], "turned on again, with no new review");
    writeList([]);
    assert.equal(await menus(), undefined, "removed");
  });
});

describe("the code folders", () => {
  test("data, logs, libraries and *.log never count; anything else does; only what the entry names", () => {
    const d = folder(base(), { "s.mjs": "1", "data/a": "1", "logs/a": "1", "node_modules/m/a": "1", ".git/x": "1", "run.log": "1", "other/o": "1" });
    const raw = { id: "x", folder: d, run: ["node"] };
    const code = fp.codeFoldersOf(raw);
    const before = [fp.codeHashNow(code), fp.codeSigNow(code)];
    for (const f of ["data/a", "logs/a", "node_modules/m/a", ".git/x", "run.log"]) appendFileSync(join(d, f), "more");
    assert.deepEqual([fp.codeHashNow(code), fp.codeSigNow(code)], before, "a program writing its log never asks again");
    appendFileSync(join(d, "s.mjs"), "2");
    assert.notEqual(fp.codeHashNow(code), before[0]);
  });
  test("data and logs are skipped only at the extension's top level; a library's own data folder is code", () => {
    const d = folder(base(), { "s.mjs": "1", "lib/data/x.js": "1", "lib/logs/y.js": "1", "data/x.json": "1", "logs/z": "1", "lib/node_modules/m/a": "1", "lib/.git/x": "1" });
    const code = fp.codeFoldersOf({ id: "x", folder: d, run: ["node"] });
    let was = fp.codeHashNow(code);
    for (const f of ["data/x.json", "logs/z", "lib/node_modules/m/a", "lib/.git/x"]) {
      appendFileSync(join(d, f), "more");
      assert.equal(fp.codeHashNow(code), was, `${f} doesn't count`);
    }
    for (const f of ["lib/data/x.js", "lib/logs/y.js"]) {
      appendFileSync(join(d, f), "more");
      const now = fp.codeHashNow(code);
      assert.notEqual(now, was, `${f} counts`);
      was = now;
    }
  });
  test("a program folder's or page's own data folder counts: its top isn't the extension's", () => {
    const d = folder(base(), { "b/data/x.js": "1", "dist/index.html": "", "dist/data/y.json": "1" });
    const code = fp.codeFoldersOf({ id: "x", folder: d, dist: join(d, "dist"), run: ["n"], programFolder: join(d, "b") });
    let was = fp.codeHashNow(code);
    for (const f of ["b/data/x.js", "dist/data/y.json"]) {
      appendFileSync(join(d, f), "more");
      const now = fp.codeHashNow(code);
      assert.notEqual(now, was, `${f} counts`);
      was = now;
    }
  });
  test("recognition refuses what approval skips and only that: a top-level data folder, a library anywhere", () => {
    assert.match(reason(folder(base({ page: "data/dist" }), { "data/dist/index.html": "" })), /page is in data/);
    assert.match(reason(folder(base({ page: "lib/node_modules/p" }), { "lib/node_modules/p/index.html": "" })), /page is in node_modules/);
    assert.equal(reason(folder(base({ page: "lib/data/dist" }), { "lib/data/dist/index.html": "" })), "ok");
    assert.equal(reason(folder(base({ backend: { run: ["node", "lib/logs/s.mjs"] } }), { "lib/logs/s.mjs": "" })), "ok");
    assert.match(reason(folder(base({ backend: { run: ["node", "s.mjs"], folder: "logs" } }), { "logs/s.mjs": "" })), /program is in logs/);
    assert.equal(reason(folder(base({ backend: { run: ["node", "s.mjs"], folder: "lib/data" } }), { "lib/data/s.mjs": "" })), "ok");
  });
  test("a program folder named: only it, the page and the description count", () => {
    const d = folder(base(), { "b/s.mjs": "1", "dist/index.html": "", "notes.txt": "1" });
    const code = fp.codeFoldersOf({ id: "x", folder: d, dist: join(d, "dist"), run: ["n"], programFolder: join(d, "b") });
    const was = fp.codeHashNow(code);
    appendFileSync(join(d, "notes.txt"), "2");
    assert.equal(fp.codeHashNow(code), was);
    appendFileSync(join(d, "sova-extension.json"), " ");
    assert.notEqual(fp.codeHashNow(code), was);
  });
  test("a touched file moves the sig and not the hash, so a pass hashes and stays approved", async () => {
    const d = folder(base(), { "s.mjs": "1" });
    const code = fp.codeFoldersOf({ id: "x", folder: d, run: ["n"] });
    const [sig, hash] = [await fp.codeSig(code), await fp.codeHash(code)];
    const f = join(d, "s.mjs");
    const { utimesSync } = await import("node:fs");
    utimesSync(f, new Date(1000), new Date(1000));
    assert.notEqual(await fp.codeSig(code), sig);
    assert.equal(await fp.codeHash(code), hash);
  });
  test("a data folder inside the folder never counts", () => {
    const d = folder(base(), { "state/x": "1", "s": "1" });
    const code = fp.codeFoldersOf({ id: "x", folder: d, run: ["n"] }, join(d, "state"));
    const was = fp.codeHashNow(code);
    appendFileSync(join(d, "state/x"), "2");
    assert.equal(fp.codeHashNow(code), was);
  });
});

describe("the program's environment", () => {
  test("bare node always has an answer, a relative path starts from its folder, an unknown name has none", () => {
    const d = folder(base(), {});
    const exe = join(d, "bin/run");
    put(exe, "#!/bin/sh\n");
    const { chmodSync } = require("node:fs") as typeof import("node:fs");
    chmodSync(exe, 0o755);
    assert.equal(resolveProgram("bin/run", d, { PATH: "" }), exe);
    assert.equal(resolveProgram("bin/nope", d, { PATH: "" }), null);
    assert.equal(resolveProgram("run", d, { PATH: join(d, "bin") }), exe);
    assert.equal(resolveProgram("no-such-program", d, { PATH: join(d, "bin") }), null);
    assert.equal(resolveProgram("node", d, { PATH: "" }, "/self/bun"), "/self/bun");
    assert.equal(resolveProgram("node", d, { PATH: "", SOVA_NODE: "/opt/node" }, "/self/bun"), "/opt/node");
  });
  test("its address, its key's file and its data folder; never Sova's token", () => {
    const env = programEnv({ id: "n", run: ["x"], folder: "/f", api: "http://127.0.0.1:7" }, "7", "/k", "/d", { PATH: "/bin", SOVA_TOKEN: "t", MY_API_KEY: "s", HOME: "/h" });
    assert.deepEqual([env.PORT, env.SOVA_EXTENSION_ID, env.SOVA_EXTENSION_KEY_FILE, env.SOVA_EXTENSION_DATA_DIR, env.PATH], ["7", "n", "/k", "/d", "/bin"]);
    assert.ok(env.SOVA_URL?.startsWith("http://127.0.0.1:"));
    assert.equal(env.SOVA_TOKEN, undefined);
    assert.equal(env.MY_API_KEY, undefined);
  });
  test("ids that differ only in case keep their data apart", () => {
    assert.notEqual(extensionDataDir("Foo").toLowerCase(), extensionDataDir("foo").toLowerCase());
    assert.ok(extensionDataDir("foo").endsWith("/extension-data/foo"));
  });
});

describe("rows", () => {
  test("one state and its line, the first that applies; no switch until it can be switched", async () => {
    const d = folder(base());
    const e = { id: "w", title: "W", folder: d };
    writeList([e, { id: "bad id" }]);
    const [w, bad] = await Promise.all(ext.listedExtensions()!.map(rowOf));
    assert.deepEqual([w!.state, w!.on, w!.line], ["waiting", undefined, "Added or edited outside this screen. Nothing runs until you approve it."]);
    assert.deepEqual([bad!.state, bad!.key], ["not-usable", "bad id"]);
    writeList([{ ...e, off: true }]);
    approve({ ...e, off: true });
    assert.deepEqual([(await rowOf(ext.listedExtensions()![0]!)).state, (await rowOf(ext.listedExtensions()![0]!)).on], ["off", false]);
    writeList([e]);
    const on = await rowOf(ext.listedExtensions()![0]!);
    assert.deepEqual([on.state, on.on, on.ownProgram], ["running", true, undefined]);
  });
});

describe("across computers, mixed versions", () => {
  const sync = (local: ReturnType<typeof ext.publishedExtensions>, validate: (r: unknown) => { entry: never } | { error: string }, listed?: string[]) =>
    new ExtensionSync({ hostId: `h${++n}`, file: join(root, `mesh-${n}.json`), local: () => local, validate: validate as never, ...(listed ? { listedIds: () => listed } : {}) });
  /** The rule of a Sova before this version. */
  const olderValidate = (r: unknown) => {
    const x = r as { id?: string; dist?: unknown; api?: unknown };
    return typeof x.dist === "string" && typeof x.api === "string" ? { entry: x as never } : { error: "needs both" };
  };

  test("what is published carries neither a folder nor a program, nor an entry that isn't active", () => {
    const d = folder(base());
    const on = { id: "on", title: "On", folder: d, dist: join(d, "dist"), api: "http://127.0.0.1:5", run: ["x"], programFolder: d };
    const off = { id: "off", title: "Off", folder: d, off: true };
    const waits = { id: "waits", title: "W", folder: d };
    writeList([on, off, waits]);
    approve(on);
    approve({ ...off });
    const pub = ext.publishedExtensions();
    assert.deepEqual(pub, [{ id: "on", title: "On", dist: join(d, "dist"), api: "http://127.0.0.1:5" }]);
  });
  test("an older peer quietly leaves out an entry with no page or no program, and keeps the rest", async () => {
    const whole = { id: "whole", title: "Whole", dist: "/d", api: "http://127.0.0.1:1" };
    const a = sync([whole, { id: "cards", title: "Cards" }], ext.validateExtension as never);
    const older = sync([], olderValidate);
    await older.syncWith({ id: "a", extensions: async () => structuredClone(a.published()), notify: async () => {} });
    assert.deepEqual(older.peerEntries().map((p) => p.entry.id), ["whole"]);
  });
  test("this version lists a peer's entry with no page, and its no-dist reads as not here", async () => {
    const a = sync([{ id: "cards", title: "Cards" }], ext.validateExtension as never);
    const b = sync([], ext.validateExtension as never);
    await b.syncWith({ id: "a", extensions: async () => structuredClone(a.published()), notify: async () => {} });
    assert.deepEqual(b.peerEntries().map((p) => [p.entry.id, p.installed]), [["cards", false]]);
  });
  test("an id on this host's list in any state is this host's: a peer's never shows in its place", async () => {
    const a = sync([{ id: "notes", title: "Theirs", dist: "/d", api: "http://127.0.0.1:1" }], ext.validateExtension as never);
    const b = sync([], ext.validateExtension as never, ["notes"]);
    await b.syncWith({ id: "a", extensions: async () => structuredClone(a.published()), notify: async () => {} });
    assert.deepEqual(b.peerEntries(), []);
  });
});

describe("old cards", () => {
  const project = join(root, "project");
  const e = { id: "notes", title: "Notes", cards: [{ name: "ok", title: "OK?", draws: "buttons", answer: "at-once", toolkit: 1 }] };
  let s = 0;
  const fresh = () => {
    const id = `01b00000-0000-7000-8000-${String(++s).padStart(12, "0")}`;
    return { id, path: join(root, "sessions", `x_${id}.jsonl`) };
  };
  async function open() {
    const f = fresh();
    await cards.cardSnapshotFor(f.id, f.path, project);
    const card = await cards.raiseCard({ path: f.path, type: "notes.ok", data: { title: "Pick", buttons: [{ label: "A", does: { kind: "answer" } }] }, by: { kind: "script" } } as never);
    return { ...f, card };
  }
  beforeEach(() => {
    mkdirSync(project, { recursive: true });
    cards.resetCardsForTest();
    cards.setCardDeps({
      async summary(path: string) {
        const id = /x_(.+)\.jsonl$/.exec(path)?.[1] ?? "nope";
        return { id, path, cwd: project, title: "S" } as SessionSummary;
      },
      async head() {
        return { hasUser: false };
      },
    } as never);
    writeList([e]);
    approve(e);
  });

  test("off: the page's answer says so, it leaves Needs You, and Turn On brings it back", async () => {
    const { id, path } = await open();
    assert.equal(cards.openCardsOf(id).length, 1);
    writeList([{ ...e, off: true }]);
    const a = await cards.sessionCardsAt(path);
    assert.deepEqual([a.off, a.gone, a.blocked], [["notes"], undefined, undefined]);
    assert.deepEqual(cards.openCardsOf(id), [], "off: nothing to answer it, so it isn't waiting");
    assert.equal(a.cards[0]!.state, "open", "kept, not closed");
    writeList([e]);
    assert.equal(cards.openCardsOf(id).length, 1);
    assert.deepEqual((await cards.sessionCardsAt(path)).off, undefined);
  });
  test("on the list but unable to run: blocked, not off", async () => {
    const { id, path } = await open();
    gate.forgetApproval("notes");
    const a = await cards.sessionCardsAt(path);
    assert.deepEqual([a.off, a.blocked], [undefined, ["notes"]]);
    assert.deepEqual(cards.openCardsOf(id), []);
  });
  test("removed: gone, its open cards close and its trust is forgotten", async () => {
    const { id, path } = await open();
    cards.setCardsTrusted("ext:notes", true);
    writeList([]);
    assert.deepEqual((await cards.sessionCardsAt(path)).gone, ["notes"]);
    cards.setCardsTrusted("ext:notes", false);
    cards.closeCardsOfExtension("notes");
    assert.equal((await cards.sessionCardsAt(path)).cards[0]!.state, "done");
    assert.deepEqual(cards.openCardsOf(id), []);
    assert.equal(cards.cardsTrusted("ext:notes"), false);
  });
  test("Changed: a data card stays waiting; a view card leaves Needs You, runs nothing and keeps no state, and returns on approval", async () => {
    const dist = folder(undefined, { "index.html": "", "v.js": "export {};" });
    const v = { ...e, dist, cards: [{ name: "ok", title: "OK?", draws: "buttons", answer: "at-once", toolkit: 1 }, { name: "see", title: "See", draws: "view", view: "v.js", answer: "at-once", toolkit: 1, data: { type: "object" } }] };
    writeList([v]);
    approve(v);
    const f = fresh();
    await cards.cardSnapshotFor(f.id, f.path, project);
    const data = await cards.raiseCard({ path: f.path, type: "notes.ok", data: { title: "Pick", buttons: [{ label: "A", does: { kind: "answer" } }] }, by: { kind: "script" } });
    const view = await cards.raiseCard({ path: f.path, type: "notes.see", data: {}, by: { kind: "script" } });
    assert.equal(cards.openCardsOf(f.id).length, 2);
    await cards.setCardState(f.path, view.id, { a: 1 });
    const was = gate.codeReadingOf("notes")!;
    gate.setCodeReading("notes", { sig: "moved", code: "edited" });
    assert.deepEqual(cards.openCardsOf(f.id).map((c) => c.id), [data.id]);
    await assert.rejects(cards.setCardState(f.path, view.id, { a: 2 }), /changed and is waiting for your approval/);
    await assert.rejects(cards.runCardCommand(f.path, view.id, "session.list", {}), /changed and is waiting for your approval/);
    gate.setCodeReading("notes", was);
    assert.equal(cards.openCardsOf(f.id).length, 2);
    await cards.setCardState(f.path, view.id, { a: 3 });
  });
  test("an open card with no extension asks no list", async () => {
    assert.deepEqual(cards.openCardsOf("no-such"), []);
  });
});
