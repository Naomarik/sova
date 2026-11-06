// Run: pnpm test:int -- server/extension-views-changed.integration.test.ts
// §app.extensions/views, the operator's rule: edited trusted view code must not run. A real build of a view (esbuild
// is a program, hence this tier) over the real routes: a save that reaches the page before the background pass still
// isn't handed over, a page already told waits and hears Approve, and the view's command doesn't run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import type { SessionSummary } from "../shared/protocol";

const root = realpathSync(mkdtempSync(join(tmpdir(), "sova-ext-views-")));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
delete process.env.SOVA_EXTENSIONS_FILE;
const sessions = join(root, "agent", "sessions");
mkdirSync(sessions, { recursive: true });
mkdirSync(join(root, "agent", "sova"), { recursive: true });
after(() => rmSync(root, { recursive: true, force: true }));

await import("./testing/in-process-chats");
const { buildApp } = await import("./app");
const { app } = buildApp({ extensionEntriesOf: async () => [] });
const cards = await import("./transcript-cards");
const gate = await import("./extension-gate");
const fp = await import("./extension-fingerprint");
const { pageHeaders } = await import("./testing/page");

const put = (file: string, text: string) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};
const folder = join(root, "ext");
const dist = join(folder, "dist");
put(join(dist, "index.html"), "<p>");
put(join(dist, "v.js"), "globalThis.first = 1;");
put(join(folder, "sova-extension.json"), "{}");
const entry = { id: "notes", title: "Notes", folder, dist, cards: [{ name: "see", title: "See", draws: "view", view: "v.js", answer: "at-once", toolkit: 1, data: { type: "object" } }] };
put(join(root, "agent", "sova", "extensions.json"), JSON.stringify({ version: 1, extensions: [entry] }));

function approve() {
  const folders = fp.codeFoldersOf(entry);
  const e = gate.entryHash(entry);
  const code = fp.codeHashNow(folders);
  const sig = fp.codeSigNow(folders);
  gate.recordApproval("notes", { version: gate.versionOf(e, code), entry: e, code, sig });
  gate.setCodeReading("notes", { sig, code });
}
gate.migrateTrust(() => ({}));
approve();

const id = "01b00000-0000-7000-8000-000000000001";
const path = join(sessions, `x_${id}.jsonl`);
put(path, "");
cards.setCardDeps({
  async summary(p: string) {
    return { id, path: p, cwd: root, title: "S" } as SessionSummary;
  },
  async head() {
    return { hasUser: false };
  },
} as never);
await cards.cardSnapshotFor(id, path, root);
const card = await cards.raiseCard({ path, type: "notes.see", data: {}, by: { kind: "script" } });
cards.setCardsTrusted("ext:notes", true);

const view = async (have?: string, wait = false) => {
  const q = new URLSearchParams({ path, type: "notes.see", ...(have ? { have } : {}), ...(wait ? { wait: "1" } : {}) });
  const r = await app.request(`/api/session-cards/view?${q}`, { headers: pageHeaders() });
  return (await r.json()) as { ok: boolean; hash: string; error?: string; code?: string };
};
/** No such command: past the view's own check it answers 400, so a 409 is that check alone. */
const run = () => app.request("/api/session-cards/run", { method: "POST", headers: { ...pageHeaders(), "content-type": "application/json" }, body: JSON.stringify({ path, card: card.id, command: "no.such.command", params: {} }) });

test("a saved edit isn't handed over before the pass, its command doesn't run, and Approve redraws by itself", { timeout: 60_000 }, async () => {
  const first = await view();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal((await run()).status, 400, "before the edit, it isn't refused as changed");

  // The save. No background pass runs in this test: what stops it is the check before delivery.
  put(join(dist, "v.js"), "globalThis.second = 'edited';");
  const answer = await view(first.hash, true);
  assert.equal(answer.ok, false, JSON.stringify(answer).slice(0, 200));
  assert.equal(answer.error, "Notes changed and is waiting for your approval.");
  assert.equal(answer.code, undefined, "no build handed over");

  const refused = await run();
  assert.equal(refused.status, 409);
  assert.match(((await refused.json()) as { error: string }).error, /changed and is waiting/);
  assert.deepEqual(cards.openCardsOf(id), [], "and it leaves Needs You");

  // A page already told waits; Approve answers it with the new build.
  const told = view("changed", true);
  await new Promise((r) => setTimeout(r, 200));
  approve();
  const redrawn = await told;
  assert.equal(redrawn.ok, true, JSON.stringify(redrawn).slice(0, 200));
  assert.match(redrawn.code ?? "", /edited/);
  assert.equal(cards.openCardsOf(id).length, 1, "back in Needs You");
});

test("a build already checked walks nothing; a server started with a named list redraws as before", { timeout: 60_000 }, async () => {
  const a = await view();
  gate.setCodeReading("notes", { sig: "the same", code: gate.approvalOf("notes")!.code });
  assert.equal((await view()).hash, a.hash);
  assert.equal(gate.codeReadingOf("notes")!.sig, "the same", "no fresh reading was taken for a build already checked");

  const named = join(root, "named.json");
  put(named, JSON.stringify({ version: 1, extensions: [entry] }));
  process.env.SOVA_EXTENSIONS_FILE = named;
  try {
    const was = await view();
    put(join(dist, "v.js"), "globalThis.third = 'named';");
    const next = await view(was.hash, true);
    assert.equal(next.ok, true);
    assert.match(next.code ?? "", /named/);
  } finally {
    delete process.env.SOVA_EXTENSIONS_FILE;
  }
});
