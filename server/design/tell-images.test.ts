import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { DesignRun } from "../../shared/design";

// a21: the main chat's own images reach the coordinator by reference. They join the chat's design folder as
// assets of yours; the coordinator and the main chat hear their short names, never their bytes.
const agentDir = mkdtempSync(join(tmpdir(), "sova-tell-images-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
// Chats' shared folders live here, never in a real home.
process.env.SOVA_SHARED_BASE = join(agentDir, "shared");
after(() => rmSync(agentDir, { recursive: true, force: true }));
const { setCoordinatorPorts, startCoordinator } = await import("./coordinator");
const { setOwnImageDepsForTest } = await import("./asset-routes");
const { mainDesignTools } = await import("./tools");
const { attachmentsRoot } = await import("../attachments");
const { readAssets } = await import("./assets");
const { changeDesigns } = await import("./store");

const sessionId = "01a1c2a9-c0c7-7016-a44a-66741a821f65";
const parent = { sessionId, path: join(agentDir, "main.jsonl") };
// Bytes no text could hold by chance: what was pasted, and what the drawing made of it.
const original = new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("PASTED-IMAGE-BYTES-".repeat(40))]));
const webp = (mark: string) => { const b = Buffer.alloc(256, 0); b.write("RIFF", 0, "latin1"); b.write("WEBP", 8, "latin1"); b.write(mark, 16, "latin1"); return new Uint8Array(b); };
const png = (mark: string) => { const b = Buffer.alloc(256, 0); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.write(mark, 16, "latin1"); return new Uint8Array(b); };
const drawn = { full: webp("DRAWN-FULL-MARK"), small: webp("DRAWN-SMALL-MARK"), describe: png("DRAWN-DESCRIBE-MARK") };

test("the main chat's image goes to the coordinator by name: neither chat's file gets its bytes", async () => {
  const sends: string[] = [];
  setCoordinatorPorts({
    workers: () => ({ start: async () => ({ chatId: "coord", sessionFile: "/c.jsonl" }), send: async (_c: string, i: { text: string }) => (sends.push(i.text), { queued: false }), state: () => "idle", watch: () => () => {} }),
    designsFor: () => [], systemPrompt: () => "P", specFor: () => ({}) as never, sessionDir: () => "/s", stores: () => ({}) as never, projects: () => [],
  } as never);
  setOwnImageDepsForTest({
    draw: (async (_c: unknown, images: readonly Uint8Array[]) => images.map(() => ({ width: 800, height: 600, full: { bytes: drawn.full, w: 800, h: 600 }, small: { bytes: drawn.small, w: 400, h: 300 }, describe: { bytes: drawn.describe, w: 400, h: 300 } }))) as never,
    context: (async () => ({ sessionId, sessionFile: parent.path, cwd: agentDir, agentDir, sandbox: { on: false } })) as never,
  });
  after(() => { setCoordinatorPorts(null); setOwnImageDepsForTest(null); });
  const run: DesignRun = { id: "r1", setup: { brief: "A page", models: [{ ref: "zai/c", name: "c", design: true, coordinator: true, vision: true, route: "tool" }], directions: [{ name: "D", on: true }] }, phase: "setup", labels: [], createdAt: "t", updatedAt: "t" } as DesignRun;
  changeDesigns(sessionId, (s) => { s.runs.push(run); s.parentPath = parent.path; });
  await startCoordinator(parent, run, agentDir);

  const dir = join(attachmentsRoot(), sessionId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "sova-0f8f7c3e-1111-4222-8333-444455556666.png");
  writeFileSync(file, original);
  const tell = mainDesignTools(() => parent, () => agentDir).find((t) => t.name === "lookbook")!;
  const result = await tell.execute("t1", { op: "tell", text: "use this photo for the hero", images: [file] }, undefined, undefined, undefined as never);

  const asset = readAssets(sessionId).assets.find((a) => a.source === "yours");
  assert.ok(asset, "the image joined the chat's set as the user's own");
  const toMain = JSON.stringify(result);
  const toCoordinator = sends.join("\n");
  assert.match(toCoordinator, new RegExp(`\\b${asset.name}\\b`), "the coordinator hears the image's short name");
  assert.match(toMain, new RegExp(`\\b${asset.name}\\b`));
  for (const bytes of [original, drawn.full, drawn.small, drawn.describe]) {
    const b64 = Buffer.from(bytes).toString("base64");
    for (const [who, text] of [["main chat", toMain], ["coordinator", toCoordinator]] as const) {
      assert.ok(!text.includes(b64.slice(24, 72)), `${who} got image bytes`);
      assert.ok(!/PASTED-IMAGE-BYTES|DRAWN-(FULL|SMALL|DESCRIBE)-MARK/.test(text), `${who} got image bytes`);
    }
  }
  assert.ok(!/"type":"image"/.test(toMain), "no picture block in the main chat's tool result");
});

test("images attached when the Lookbook is asked for join the run itself, and a Creative Director that reads pictures sees them first", async () => {
  const starts: { task?: string; images?: { mimeType: string }[] }[] = [];
  setCoordinatorPorts({
    workers: () => ({ start: async (req: { task?: string; images?: { mimeType: string }[] }) => (starts.push(req), { chatId: "coord2", sessionFile: "/c2.jsonl" }), send: async () => ({ queued: false }), state: () => "idle", watch: () => () => {} }),
    designsFor: () => [], systemPrompt: () => "P", specFor: () => ({}) as never, sessionDir: () => "/s", stores: () => ({}) as never, projects: () => [],
  } as never);
  setOwnImageDepsForTest({
    draw: (async (_c: unknown, images: readonly Uint8Array[]) => images.map(() => ({ width: 1440, height: 900, full: { bytes: drawn.full, w: 800, h: 600 }, small: { bytes: drawn.small, w: 400, h: 300 }, describe: { bytes: drawn.describe, w: 400, h: 300 } }))) as never,
    context: (async () => ({ sessionId: other, sessionFile: chat.path, cwd: agentDir, agentDir, sandbox: { on: false } })) as never,
  });
  after(() => { setCoordinatorPorts(null); setOwnImageDepsForTest(null); });
  const other = "01a1c2a9-c0c7-7016-a44a-66741a821f66";
  const chat = { sessionId: other, path: join(agentDir, "main2.jsonl") };
  const dir = join(attachmentsRoot(), other);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "sova-0f8f7c3e-1111-4222-8333-444455556667.png");
  writeFileSync(file, Buffer.concat([Buffer.from(original), Buffer.from("SCREENSHOT")]));
  const lookbook = mainDesignTools(() => chat, () => agentDir).find((t) => t.name === "lookbook")!;
  const out = await lookbook.execute("s1", { op: "start", brief: "Redesign this screen", images: [file] }, undefined, undefined, undefined as never);
  const { viewOf } = await import("./store");
  const { keptImages } = await import("./brief");
  const run = viewOf(other).runs.at(-1)!;
  const asset = readAssets(other).assets.find((a) => a.source === "yours")!;
  assert.ok(asset, "the attached image joined the chat's images");
  assert.match(JSON.stringify(out), new RegExp(`Images: ${asset.name} joined the run`));
  assert.ok(!run.setup.brief.includes(file), "no path in the brief");
  assert.deepEqual(run.images, [asset.name], "on the run itself, so Setup has them from its first frame");
  assert.deepEqual(keptImages({ ...run, brief: { imageUse: {} } as never }, readAssets(other)), [asset.name], "it is this run's own image: Setup shows it and Start hands it over");
  // The Creative Director: told its name, and shown the picture on its first turn.
  run.setup.models = [{ ref: "zai/c", name: "c", design: true, coordinator: true, vision: true, route: "tool" }];
  changeDesigns(other, (s) => void (s.runs.find((r) => r.id === run.id)!.setup = run.setup));
  await startCoordinator(chat, run, agentDir);
  assert.match(starts.at(-1)!.task!, new RegExp(`The user's own images for this run: ${asset.name}\\.`));
  assert.equal(starts.at(-1)!.images?.length, 1);
  assert.equal(starts.at(-1)!.images![0]!.mimeType, "image/png");
});

test("start images the chat already had belong to the new run without being re-dated; a darkroom that fails still leaves one card, and says so", async () => {
  const sid = "01a1c2a9-c0c7-7016-a44a-66741a821f67";
  const chat = { sessionId: sid, path: join(agentDir, "main3.jsonl") };
  const drawOk = (async (_c: unknown, images: readonly Uint8Array[]) => images.map(() => ({ width: 800, height: 600, full: { bytes: drawn.full, w: 800, h: 600 }, small: { bytes: drawn.small, w: 400, h: 300 }, describe: { bytes: drawn.describe, w: 400, h: 300 } }))) as never;
  const context = (async () => ({ sessionId: sid, sessionFile: chat.path, cwd: agentDir, agentDir, sandbox: { on: false } })) as never;
  setOwnImageDepsForTest({ draw: drawOk, context });
  after(() => setOwnImageDepsForTest(null));
  const dir = join(attachmentsRoot(), sid);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "sova-0f8f7c3e-1111-4222-8333-444455556668.png");
  writeFileSync(file, Buffer.concat([Buffer.from(original), Buffer.from("KNOWN")]));
  const lookbook = mainDesignTools(() => chat, () => agentDir).find((t) => t.name === "lookbook")!;
  await lookbook.execute("s1", { op: "start", brief: "first", images: [file] }, undefined, undefined, undefined as never);
  const { viewOf } = await import("./store");
  const { keptImages } = await import("./brief");
  const name = readAssets(sid).assets[0]!.name;
  const first = readAssets(sid).assets[0]!.addedAt;
  await new Promise((r) => setTimeout(r, 5));
  await lookbook.execute("s2", { op: "start", brief: "second", images: [file] }, undefined, undefined, undefined as never);
  const second = viewOf(sid).runs.at(-1)!;
  assert.equal(readAssets(sid).assets.length, 1, "the same image, one asset");
  assert.equal(readAssets(sid).assets[0]!.addedAt, first, "never re-dated");
  assert.ok(first < second.createdAt);
  assert.deepEqual(second.images, [name]);
  assert.deepEqual(keptImages({ ...second, brief: { imageUse: {} } as never }, readAssets(sid)), [name], "the new run has it");
  // The darkroom fails after the card is up: the call still answers, once, and says what to do.
  setOwnImageDepsForTest({ draw: (async () => { throw new Error("the darkroom didn't start"); }) as never, context });
  const runs = viewOf(sid).runs.length;
  writeFileSync(file, Buffer.concat([Buffer.from(original), Buffer.from("OTHER")]));
  const out = JSON.stringify(await lookbook.execute("s3", { op: "start", brief: "third", images: [file] }, undefined, undefined, undefined as never));
  assert.equal(viewOf(sid).runs.length, runs + 1, "one card");
  assert.match(out, /The Setup card is on screen/);
  assert.match(out, /couldn't be added \(the darkroom didn't start\)[^"]*paste them into the Creative Director's box\. Don't start another card\./);
  assert.equal(viewOf(sid).runs.at(-1)!.images, undefined);
});

test("a picture path is refused by name, with why, and the places pictures are taken from; the chat's shared folder is one", async () => {
  const { readAttachedImages, IMAGE_REFUSALS, imagePlacesLine } = await import("./own-images");
  const { symlinkSync } = await import("node:fs");
  const sid = "01a1c2a9-c0c7-7016-a44a-66741a821f70";
  const shared = join(agentDir, "shared", sid);
  mkdirSync(join(shared, "logos"), { recursive: true });
  const ok = join(shared, "logos", "mark.png");
  writeFileSync(ok, original);
  writeFileSync(join(shared, "notes.png"), "only words, no picture");
  writeFileSync(join(shared, "huge.png"), Buffer.concat([Buffer.from(original), Buffer.alloc(8 * 1024 * 1024)]));
  const outside = join(agentDir, "outside.png");
  writeFileSync(outside, original);
  symlinkSync(outside, join(shared, "link.png"));
  symlinkSync(join(agentDir), join(shared, "dirlink"));
  const tmpName = `/tmp/sova-test-${process.pid}-missing.png`;
  const paths = [ok, join(shared, "notes.png"), join(shared, "huge.png"), join(shared, "link.png"), join(shared, "dirlink", "outside.png"), join(shared, "gone.png"), `${shared}/../${sid}-x/escape.png`, "/etc/hostname", tmpName, "/tmp/notes.txt", outside];
  const r = await readAttachedImages(paths, { shared });
  assert.deepEqual(r.names, [ok], "the shared folder's picture, by its path as given");
  assert.equal(r.images.length, 1);
  assert.deepEqual(r.unreadable.map((u) => [u.what, u.reason]), [
    [join(shared, "notes.png"), IMAGE_REFUSALS.notImage],
    [join(shared, "huge.png"), IMAGE_REFUSALS.tooBig],
    [join(shared, "link.png"), IMAGE_REFUSALS.outside],
    [join(shared, "dirlink", "outside.png"), IMAGE_REFUSALS.outside],
    [join(shared, "gone.png"), IMAGE_REFUSALS.missing],
    [`${shared}/../${sid}-x/escape.png`, IMAGE_REFUSALS.place],
    ["/etc/hostname", IMAGE_REFUSALS.place],
    [tmpName, IMAGE_REFUSALS.missingTmp],
    ["/tmp/notes.txt", IMAGE_REFUSALS.notImage],
    [outside, IMAGE_REFUSALS.place],
  ]);
  const without = await readAttachedImages([ok]);
  assert.deepEqual(without.unreadable.map((u) => u.reason), [IMAGE_REFUSALS.place], "only the calling chat's own folder: none given, none taken");
  assert.match(imagePlacesLine(shared), new RegExp(`directly in /tmp; Sova's attachments folder \\(.*\\); and your shared folder \\(${shared}/`));
});

test("the chat's edit adds pictures from its shared folder to the run and takes one off it; a refusal ends with the places", async () => {
  const sid = "01a1c2a9-c0c7-7016-a44a-66741a821f71";
  const chat = { sessionId: sid, path: join(agentDir, "main-edit.jsonl") };
  setOwnImageDepsForTest({
    draw: (async (_c: unknown, images: readonly Uint8Array[]) => images.map(() => ({ width: 800, height: 600, full: { bytes: drawn.full, w: 800, h: 600 }, small: { bytes: drawn.small, w: 400, h: 300 }, describe: { bytes: drawn.describe, w: 400, h: 300 } }))) as never,
    context: (async () => ({ sessionId: sid, sessionFile: chat.path, cwd: agentDir, agentDir, sandbox: { on: false } })) as never,
  });
  after(() => setOwnImageDepsForTest(null));
  const run: DesignRun = { id: "re", setup: { brief: "A page", models: [{ ref: "zai/c", name: "c", design: true, coordinator: true, vision: true, route: "tool" }], directions: [{ name: "D", on: true }] }, phase: "setup", labels: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "t" } as DesignRun;
  changeDesigns(sid, (s) => { s.runs.push(run); s.parentPath = chat.path; });
  const shared = join(agentDir, "shared", sid);
  mkdirSync(shared, { recursive: true });
  const logo = join(shared, "logo.png");
  writeFileSync(logo, Buffer.concat([Buffer.from(original), Buffer.from("LOGO")]));
  const lookbook = mainDesignTools(() => chat, () => agentDir).find((t) => t.name === "lookbook")!;
  const text = async (params: Record<string, unknown>) => ((await lookbook.execute("e", params as never, undefined, undefined, undefined as never)).content[0] as { text: string }).text;
  const added = await text({ op: "edit", images: [logo, "/etc/hostname"] });
  const { viewOf } = await import("./store");
  const { runOwnImage } = await import("../../shared/design");
  const asset = readAssets(sid).assets.find((a) => a.source === "yours")!;
  assert.deepEqual(viewOf(sid).runs.at(-1)!.images, [asset.name]);
  assert.match(added, new RegExp(`Images \\(1\\): ${asset.name}\\.`));
  assert.match(added, /\/etc\/hostname wasn't added: It isn't in a place images are taken from\./);
  assert.match(added, /Images are taken from: a file directly in \/tmp; .*your shared folder/);
  const removed = await text({ op: "edit", removeImages: [asset.name, "img-99"] });
  const after2 = viewOf(sid).runs.at(-1)!;
  assert.deepEqual(after2.imagesLeftOut, [asset.name]);
  assert.equal(runOwnImage(asset, after2), false, "off this run");
  assert.ok(readAssets(sid).assets.some((a) => a.name === asset.name), "still in the chat's images");
  assert.match(removed, /Images \(0\): none\./);
  assert.match(removed, /img-99: there's no image by that name on this run\./);
  // Added again: back on the run.
  await text({ op: "edit", images: [logo] });
  assert.equal(viewOf(sid).runs.at(-1)!.imagesLeftOut, undefined);
  assert.equal(runOwnImage(asset, viewOf(sid).runs.at(-1)!), true);
});
