// Run: pnpm test -- src/lib/voice/voice-strip.browser.test.ts (Solid's reactive build).
// Dictation when the mic never starts (§chat.voice/states): the real createVoiceInput over the real
// startCapture, on a browser of stand-ins (voice-strip.fixture.ts), its permission granted and
// getUserMedia hanging, as on a Mac whose browser macOS refuses the mic without a prompt. This pass
// follows the phases as Solid's signals carry them, and watches them only ever step through the
// states the strip has; voice-strip.test.ts draws the strip at each one.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { pathToFileURL } from "node:url";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("../align-card-ssr.mjs");
const solid = await import("solid-js");
// createVoiceInput draws nothing, but its module is compiled for SSR, and one server-only import is
// missing from Solid's browser build. It is never called here.
const shim = join(mkdtempSync(join(tmpdir(), "sova-web-shim-")), "web.mjs");
writeFileSync(shim, `export * from ${JSON.stringify(import.meta.resolve("solid-js/web"))};\nexport const ssrStyleProperty = () => { throw new Error("no drawing in this pass"); };\n`);
process.on("exit", () => rmSync(dirname(shim), { recursive: true, force: true }));
const { createVoiceInput } = await importSsr(new URL("../../components/VoiceInput.tsx", import.meta.url), (s: string) => (s === "solid-js/web" ? pathToFileURL(shim).href : import.meta.resolve(s)));
const { standIns, LIMIT, SENTENCE } = await import("./voice-strip.fixture");

const b = standIns();
const disposers: (() => void)[] = [];
beforeEach(() => b.install());
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose(); // while the stand-ins still stand: its cleanup reads them
  b.restore();
});

function dictation() {
  const said: string[] = [];
  const phases: string[] = [];
  return solid.createRoot((dispose) => {
    disposers.push(dispose);
    const voice = createVoiceInput({ input: () => undefined, announce: (t: string) => said.push(t) });
    solid.createRenderEffect(() => phases.push(voice.phase()));
    return { voice, said, phases };
  });
}
const { flush, fire } = b;

test("granted and the mic never answers: Starting, the error at the limit, then Dismiss", async () => {
  const d = dictation();
  d.voice.press();
  await flush();
  assert.equal(d.voice.phase(), "starting");
  fire(LIMIT);
  await flush();
  assert.equal(d.voice.phase(), "error");
  assert.deepEqual(d.voice.error(), { text: SENTENCE, retry: false }, "no clip to keep, so no Try Again");
  assert.deepEqual(d.said, [SENTENCE], "said once, to the polite region");
  assert.equal(b.closed(), 1, "the context closed");
  assert.equal(b.keys.size, 0, "Esc is no longer taken");
  d.voice.dismiss();
  assert.equal(d.voice.phase(), "idle");
  assert.equal(d.voice.error(), null);
  assert.deepEqual(d.phases, ["idle", "starting", "error", "idle"]);
  d.voice.press();
  assert.equal(d.voice.phase(), "starting", "a press tries again");
  assert.equal(b.asked.length, 2);
});

test("a press from the error tries again without Dismiss", async () => {
  const d = dictation();
  d.voice.press();
  await flush();
  fire(LIMIT);
  await flush();
  assert.equal(d.voice.phase(), "error");
  d.voice.press();
  assert.equal(d.voice.phase(), "starting");
  assert.equal(d.voice.error(), null);
  assert.equal(b.asked.length, 2);
});

test("Cancel during the wait: idle at once, no error when the limit passes, and the late stream is released", async () => {
  const d = dictation();
  d.voice.press();
  await flush();
  d.voice.cancel();
  assert.equal(d.voice.phase(), "idle");
  assert.deepEqual(d.said, ["Recording cancelled."]);

  fire(LIMIT);
  await flush();
  assert.equal(d.voice.phase(), "idle", "a cancelled start shows no error");
  assert.equal(d.voice.error(), null);
  assert.deepEqual(d.said, ["Recording cancelled."]);
  assert.equal(b.closed(), 1);

  let stopped = 0;
  b.asked[0]!.resolve({ getTracks: () => [{ stop: () => void stopped++ }] } as unknown as MediaStream);
  await flush();
  assert.equal(stopped, 1, "the mic indicator would stay on");
  assert.equal(d.voice.phase(), "idle");
});

test("Cancel, then a new press: the first start's limit can't end the second", async () => {
  const d = dictation();
  d.voice.press();
  await flush();
  d.voice.cancel();
  d.voice.press();
  await flush();
  assert.equal(d.voice.phase(), "starting");
  fire(LIMIT); // the first start's
  await flush();
  assert.equal(d.voice.phase(), "starting", "the second start is still waiting");
  fire(LIMIT);
  await flush();
  assert.equal(d.voice.phase(), "error");
});

test("Esc during the wait cancels it too", async () => {
  const d = dictation();
  d.voice.press();
  await flush();
  b.keys.get("keydown")!({ key: "Escape", preventDefault() {}, stopPropagation() {} });
  assert.equal(d.voice.phase(), "idle");
});

test("the browser's question on screen: Starting stays, with no limit waiting", async () => {
  b.setPermission("prompt");
  const d = dictation();
  d.voice.press();
  await flush();
  assert.equal(b.waiting(LIMIT), 0);
  assert.equal(d.voice.phase(), "starting");
});
