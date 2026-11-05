// Run: pnpm test -- src/lib/voice/voice-strip.test.ts
// What the dictation strip shows when the mic never starts (§chat.voice/states,
// §design.copy-deck/composer): the real createVoiceInput, VoiceStrip and VoiceButton over the real
// startCapture on a browser of stand-ins, drawn with Solid's server build at each step. The phases
// themselves are followed reactively in voice-strip.browser.test.ts.
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("../align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { createVoiceInput, VoiceStrip, VoiceButton } = await importSsr(new URL("../../components/VoiceInput.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
const { standIns, LIMIT, SENTENCE } = await import("./voice-strip.fixture");

const b = standIns();
const disposers: (() => void)[] = [];
beforeEach(() => b.install());
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  b.restore();
});

const dictation = () =>
  solid.createRoot((dispose) => {
    disposers.push(dispose);
    return createVoiceInput({ input: () => undefined, announce() {} });
  });
const plain = (h: string) => h.replaceAll(/<!--[^>]*-->/g, "").replaceAll("&#39;", "'");
const draw = (c: (p: { voice: unknown }) => unknown, voice: unknown): string => plain(renderToString(() => c({ voice }) as never));

test("the strip goes from Starting to the error, Dismiss clears it, and the mic stays usable", async () => {
  const voice = dictation();
  assert.equal(draw(VoiceStrip, voice), "", "no strip before a press");
  voice.press();

  const starting = draw(VoiceStrip, voice);
  assert.match(starting, /data-voice="starting"/);
  assert.match(starting, /Starting the mic…/);
  assert.match(starting, /aria-label="Cancel Recording"/);
  assert.match(draw(VoiceButton, voice), /aria-disabled="true"/, "the mic waits while it starts");

  await b.flush();
  b.fire(LIMIT);
  await b.flush();

  const failed = draw(VoiceStrip, voice);
  assert.match(failed, /data-voice="error"/);
  assert.ok(failed.includes(SENTENCE), failed);
  assert.match(failed, /aria-label="Dismiss"/);
  assert.doesNotMatch(failed, /Try Again/, "there is no clip to keep");
  assert.doesNotMatch(failed, /Starting the mic|Cancel Recording/);
  const mic = draw(VoiceButton, voice);
  assert.doesNotMatch(mic, /aria-disabled/, "a press works again");
  assert.match(mic, /aria-label="Dictate"/);

  voice.dismiss();
  assert.equal(draw(VoiceStrip, voice), "");
  assert.match(draw(VoiceButton, voice), /data-voice="idle"/);
});
