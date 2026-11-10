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
  const tell = mainDesignTools(() => parent, () => agentDir).find((t) => t.name === "design")!;
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
