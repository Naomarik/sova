// Run: pnpm test -- src/lib/wake-card.test.ts
// A background job's card (§app.background-jobs/end-card, §design.copy-deck/main-pane): `ended HH:MM` is
// when the job ended, not when the card reached the chat; an older card without an end time shows its
// arrival. Drawn with Solid's SSR build.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseWakeNudge } from "../../shared/wake";
import { clockTime } from "./format";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { WakeCard } = await importSsr(new URL("../components/WakeCard.tsx", import.meta.url), (s: string) => import.meta.resolve(s));

const draw = (text: string, time?: string) =>
  renderToString(() => solid.createComponent(WakeCard as never, { nudge: parseWakeNudge(text)!, text, time } as never)).replace(/ data-hk="[^"]*"/g, "").replace(/<!--[^>]*-->/g, "");
/** The stamp's clock part, before its " · {late} late". */
const stamp = (html: string) => /<span class="toolcard-wake-time">([^<]*)/.exec(html)?.[1]?.split(" · ")[0];

const ENDED = "2026-11-04T09:05:00.000Z";
const ARRIVED = "2026-11-04T11:40:00.000Z";
const card = (endLine: boolean) =>
  ["[job j1] Background job ended.", "Late by 2h35m (Sova was not running).", "j1: `pnpm lab > lab.log &`, ran 1h.", "Output: /w/lab.log", "It ended on its own; its output says whether it worked.", ...(endLine ? [`Ended at ${ENDED}.`] : []), "Read its output and decide what to do next."].join("\n");

test("a job card's `ended HH:MM` is the job's end time, not the card's arrival", () => {
  assert.notEqual(clockTime(ENDED), clockTime(ARRIVED));
  const html = draw(card(true), ARRIVED);
  assert.equal(stamp(html), `ended ${clockTime(ENDED)}`);
  assert.match(html, /Background job j1/);
  assert.ok(html.includes(" · 2h35m late"), "the late part stays");
  // Live (no row time yet): the end time all the same.
  assert.equal(stamp(draw(card(true))), `ended ${clockTime(ENDED)}`);
});

test("an older job card, with no end time, still draws and shows when it arrived", () => {
  assert.equal(stamp(draw(card(false), ARRIVED)), `ended ${clockTime(ARRIVED)}`);
});

test("a wake nudge's `fired HH:MM` is still its row's time", () => {
  const text = "[wake_nudge n1] Scheduled wakeup fired (set 4m ago).\nReason: (none)\nContinue.";
  assert.equal(stamp(draw(text, ARRIVED)), `fired ${clockTime(ARRIVED)}`);
});
