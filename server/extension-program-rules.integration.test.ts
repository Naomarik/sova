// Run: pnpm test:int -- server/extension-program-rules.integration.test.ts
// What an approval does to a program, on the detached driver, in this process: a version with no program stops the
// old one and the pass keeps it stopped; Choose Folder gives a new program a port as Install and Approve do; and a
// route's id reaches no file outside what the list and the units name.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { Hono } from "hono";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-ext-rules-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.SOVA_PROJECT_NO_SYSTEMD = "1";
delete process.env.SOVA_EXTENSIONS_FILE;
mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });
mkdirSync(join(root, "agent", "sova"), { recursive: true });

const loader = await import("./extension-loader");
const program = await import("./extension-program");
const ext = await import("./extensions");
const gate = await import("./extension-gate");
const { registerExtensionRoutes } = await import("./extension-routes");
gate.migrateTrust(() => ({}));

const started = new Set<string>();
after(async () => {
  for (const id of started) await program.stopProgram(id).catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

const PROGRAM = `import { createServer } from "node:http";
createServer((q, r) => r.end(JSON.stringify({ pid: process.pid }))).listen(Number(process.env.PORT), "127.0.0.1");
`;
let n = 0;
function folder(id: string, kind: "program" | "page"): string {
  const d = join(root, `f${++n}`);
  mkdirSync(d, { recursive: true });
  const desc: Record<string, unknown> = { version: 1, id, title: id, needsContract: "1.20" };
  if (kind === "program") {
    desc.backend = { run: ["node", "s.mjs"] };
    writeFileSync(join(d, "s.mjs"), PROGRAM);
  } else {
    desc.page = "dist";
    mkdirSync(join(d, "dist"));
    writeFileSync(join(d, "dist", "index.html"), "<p>");
  }
  writeFileSync(join(d, "sova-extension.json"), JSON.stringify(desc));
  started.add(id);
  return d;
}
const install = async (d: string): Promise<string> => {
  const r = await loader.reviewFolder(d);
  assert.ok(r.ok, JSON.stringify(r));
  return loader.installFolder(d, r.review.version);
};
const state = async (id: string): Promise<string> => (await program.programStatus(id)).state;
const up = (s: string) => s === "active" || s === "activating";
const until = async (what: string, ok: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> => {
  const end = Date.now() + ms;
  while (!(await ok())) {
    if (Date.now() > end) assert.fail(`${what}: never`);
    await new Promise((r) => setTimeout(r, 50));
  }
};
const pageOnly = (d: string, id: string) => {
  rmSync(join(d, "s.mjs"), { force: true });
  mkdirSync(join(d, "dist"), { recursive: true });
  writeFileSync(join(d, "dist", "index.html"), "<p>");
  writeFileSync(join(d, "sova-extension.json"), JSON.stringify({ version: 1, id, title: id, needsContract: "1.20", page: "dist" }));
};

test("approving a version with no program stops the old one", async () => {
  const d = folder("dropapprove", "program");
  await install(d);
  await until("started", async () => up(await state("dropapprove")));
  pageOnly(d, "dropapprove");
  const r = await loader.reviewEntry("dropapprove");
  assert.ok(r.ok, JSON.stringify(r));
  await loader.approveExtension("dropapprove", r.review.version);
  assert.ok(!up(await state("dropapprove")), "the approve stopped it");
});

test("choosing a folder with no program stops the old one", async () => {
  const d = folder("dropchoose", "program");
  await install(d);
  await until("started", async () => up(await state("dropchoose")));
  const to = folder("dropchoose", "page");
  const r = await loader.reviewFolder(to, "dropchoose");
  assert.ok(r.ok, JSON.stringify(r));
  await loader.chooseFolder("dropchoose", to, r.review.version);
  assert.ok(!up(await state("dropchoose")), "the choice stopped it");
});

test("a pass, and a restart of the pass, stop a unit whose active entry has no program", async () => {
  const d = folder("leftover", "page");
  await install(d);
  const spec = { id: "leftover", run: [process.execPath, join(d, "left.mjs")], folder: d, api: `http://127.0.0.1:${await program.freePort()}` };
  writeFileSync(spec.run[1]!, PROGRAM);
  await program.startProgram(spec);
  assert.ok(up(await state("leftover")), "a leftover unit runs");
  assert.equal(ext.listedExtension("leftover")?.state, "on");
  await loader.loaderPass();
  assert.ok(!up(await state("leftover")), "the pass stopped it");

  await program.startProgram(spec);
  assert.ok(up(await state("leftover")), "a leftover unit runs again");
  loader.resetLoaderForTest();
  const stop = loader.startExtensionLoader();
  try {
    await until("a restart of the pass stops it", async () => !up(await state("leftover")));
  } finally {
    stop();
  }
});

test("Choose Folder gives a new program a port; Start and Restart Program work", async () => {
  const d = folder("gainsprogram", "page");
  await install(d);
  assert.equal(await state("gainsprogram").then(up), false);
  const to = folder("gainsprogram", "program");
  const r = await loader.reviewFolder(to, "gainsprogram");
  assert.ok(r.ok, JSON.stringify(r));
  await loader.chooseFolder("gainsprogram", to, r.review.version);
  const api = ext.listedExtension("gainsprogram")?.raw.api;
  assert.equal(typeof api, "string", "the entry has an address");
  assert.ok(up(await state("gainsprogram")), "the unit runs");
  const pid = async () => ((await (await fetch(`${api}/api/health`)).json()) as { pid: number }).pid;
  let first = 0;
  await until("it answers", async () => {
    first = await pid().catch(() => 0);
    return first > 0;
  });
  await loader.programAction("gainsprogram", "restart");
  let second = 0;
  await until("Restart Program runs a new process", async () => {
    second = await pid().catch(() => 0);
    return second > 0 && second !== first;
  });
  await loader.programAction("gainsprogram", "stop");
  await until("stopped", async () => !up(await state("gainsprogram")));
  await loader.programAction("gainsprogram", "start");
  await until("Start runs it", async () => (await pid().catch(() => 0)) > 0);
});

test("the log route answers only for an id on the list or among the units", async () => {
  const app = new Hono();
  registerExtensionRoutes(app);
  const log = (id: string) => app.request(`/api/extensions/${encodeURIComponent(id)}/log`);
  // The unit's name is `<prefix>../../../secret`: the prefix's segment and two more above the driver's log folder.
  const secret = join(root, "agent", "sova", "extension-programs", "secret.log");
  mkdirSync(dirname(secret), { recursive: true });
  writeFileSync(secret, "SECRET LINE\n");
  const res = await log("../../../secret");
  const text = await res.text();
  assert.equal(res.status, 404, `an encoded ../ answered ${res.status}: ${text}`);
  assert.ok(!text.includes("SECRET"), text);
  assert.equal((await log("nobody")).status, 404);

  const d = folder("logged", "page");
  await install(d);
  assert.equal((await log("logged")).status, 200, "one on the list");
  const orphan = folder("orphan", "program");
  await program.startProgram({ id: "orphan", run: ["node", "s.mjs"], folder: orphan, api: `http://127.0.0.1:${await program.freePort()}` });
  assert.equal(ext.listedExtension("orphan"), undefined);
  assert.equal((await log("orphan")).status, 200, "one among the units");
});

test("removing a broken entry named with a path deletes nothing outside its data", async () => {
  const victim = join(root, "agent", "victim");
  mkdirSync(victim, { recursive: true });
  writeFileSync(join(victim, "keep"), "1");
  const listFile = join(root, "agent", "sova", "extensions.json");
  const list = JSON.parse(readFileSync(listFile, "utf8"));
  list.extensions.push({ id: "../../victim", title: "Broken" });
  writeFileSync(listFile, JSON.stringify(list));
  await loader.removeExtension("../../victim", true);
  assert.ok(existsSync(join(victim, "keep")), "what lies outside extension-data is untouched");
  assert.ok(!JSON.parse(readFileSync(listFile, "utf8")).extensions.some((e: { id: string }) => e.id === "../../victim"), "the entry left the list");
});

test("removing a broken entry named .. deletes no state", async () => {
  const listFile = join(root, "agent", "sova", "extensions.json");
  const list = JSON.parse(readFileSync(listFile, "utf8"));
  list.extensions.push({ id: "..", title: "Broken" });
  writeFileSync(listFile, JSON.stringify(list));
  await loader.removeExtension("..", true);
  assert.ok(existsSync(listFile), "the state folder is still there");
  assert.ok(!JSON.parse(readFileSync(listFile, "utf8")).extensions.some((e: { id: string }) => e.id === ".."), "the entry left the list");
});
