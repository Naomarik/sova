// Run: pnpm exec tsx --test server/sessions-configure-pin.test.ts (or pnpm test)
// A mode set through POST /api/sessions/configure (§mesh.links/configure: the Overseer's
// sova_create_session with `host`) is pinned exactly as the local sova_create_session pins one:
// the same `mode` entry (pinEntryFor), even for a mode equal to the default, which the mode
// extension alone never writes. A REAL hosted runtime in a throwaway PI_CODING_AGENT_DIR whose only
// extension is this repo's mode extension; no model request is made.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-configure-pin-")));
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "sova-configure-pin-cwd-")));
writeFileSync(join(dir, "settings.json"), JSON.stringify({ extensions: [resolve(here, "../pi-config/extensions/mode")] }));
writeFileSync(join(dir, "mode.json"), JSON.stringify({ version: 1, mode: "normal", strict: false, minorModes: [] }));
process.env.PI_CODING_AGENT_DIR = dir;
process.env.PORT = "0";
const { app, server } = await import("./index");
const { acquireChat, disposeAllChats } = await import("./chat-manager");
after(async () => {
  await disposeAllChats();
  await new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res())));
  rmSync(dir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function create(): Promise<string> {
  const res = await post("/api/sessions", { cwd });
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { path: string }).path;
}

/** The `mode` custom entries in the file, their data only. */
const modeEntries = (path: string) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === "custom" && e.customType === "mode")
    .map((e) => e.data);

/** The local sova_create_session's mode step: open, POST /api/mode, then pin (server/overseer-tools.ts). */
async function localCreate(body: Record<string, unknown>): Promise<string> {
  const path = await create();
  if (Object.keys(body).length) {
    await acquireChat(path);
    const r = await post(`/api/mode?path=${encodeURIComponent(path)}`, body);
    assert.equal(r.status, 200, await r.clone().text());
    assert.ok((await acquireChat(path)).pinMode());
  }
  return path;
}

/** sova_create_session with host: the peer's create, then its configure route (createOnPeer). */
async function peerCreate(body: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<string> {
  const path = await create();
  const configure = { ...extra, ...body };
  if (Object.keys(configure).length) {
    const r = await post("/api/sessions/configure", { path, ...configure });
    assert.equal(r.status, 200, await r.clone().text());
  }
  return path;
}

test("a mode equal to the default, set on a peer, gets the same pinned entry as a local create", async () => {
  const asked = { mode: "normal", minorModes: [] };
  const local = modeEntries(await localCreate(asked));
  const peer = modeEntries(await peerCreate(asked));
  assert.equal(local.length, 1, "the local path pins it");
  assert.deepEqual(peer, local);
  assert.deepEqual(peer[0].active, { version: 1, mode: "normal", strict: false, minorModes: [] });
});

test("a mode other than the default: the same entries on each path", async () => {
  const asked = { mode: "normal", minorModes: ["align"] };
  const local = modeEntries(await localCreate(asked));
  const peer = modeEntries(await peerCreate(asked));
  assert.ok(local.length > 0);
  assert.deepEqual(peer, local);
});

test("no mode asked: neither path writes a mode entry (only thinking is configured)", async () => {
  assert.deepEqual(modeEntries(await localCreate({})), []);
  assert.deepEqual(modeEntries(await peerCreate({}, { thinking: "low" })), []);
});
