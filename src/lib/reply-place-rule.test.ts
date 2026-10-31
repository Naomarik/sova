// Run: pnpm test -- src/lib/reply-place-rule.test.ts
// The rule (AGENTS.md "Commands and extensibility", agents/server/commands/overview.md): Sova's own
// features use the same places on its screens as extensions. Under a delivered message that place is
// the reply place (src/lib/reply-place.ts): Sova's built-ins drawn by MessageActions, then what
// extensions add drawn by ReplySlot, both only through ReplyPlaceView. Read from the source, so a
// second strip hand-wired beside the place, or extension markup in the page, fails here.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const tsx = (dir: string): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? tsx(join(dir, d.name)) : d.name.endsWith(".tsx") && !d.name.includes(".test.") ? [join(dir, d.name)] : [],
  );
const files = tsx(".").map((f) => ({ f, src: readFileSync(join(root, f), "utf8") }));
const using = (tag: string) => files.filter((x) => new RegExp(`<${tag}[\\s>]`).test(x.src)).map((x) => x.f).sort();
const count = (src: string, re: RegExp) => src.match(re)?.length ?? 0;

test("a delivered message's strip is drawn only by the reply place", () => {
  assert.deepEqual(using("ReplyPlaceView"), ["components/Thread.tsx"]);
  assert.deepEqual(using("ReplySlot"), ["components/ReplyPlace.tsx"], "what extensions add is drawn only in the place");
  // MessageActions: the place's built-ins, and the one Remove under a message still in the queue
  // (drawn by the user kind's live view, the running turn's message row).
  assert.deepEqual(using("MessageActions"), ["components/LiveKinds.tsx", "components/ReplyPlace.tsx"]);
  const live = files.find((x) => x.f === "components/LiveKinds.tsx")!.src;
  assert.equal(count(live, /<MessageActions[\s>]/g), 1);
  assert.match(live, /<MessageActions label="Actions for your queued message"/);
});

test("built-ins come first, then extensions", () => {
  const place = files.find((x) => x.f === "components/ReplyPlace.tsx")!.src;
  const actions = place.indexOf("<MessageActions");
  const slot = place.indexOf("<ReplySlot");
  assert.ok(actions > 0 && slot > actions);
});

test("every view that draws strips gives Sova's own actions to the place as built-ins", () => {
  for (const f of ["components/ChatView.tsx", "components/WatchView.tsx"]) {
    const src = files.find((x) => x.f === f)!.src;
    assert.match(src, /: ReplyPlace = \{\s*builtIns: \[\{ id: "sova\.message-actions"/, f);
  }
});

test("extension content is never markup in the page", () => {
  for (const f of ["components/ReplySlot.tsx", "components/ReplyPlace.tsx"]) {
    const src = files.find((x) => x.f === f)!.src;
    assert.doesNotMatch(src, /innerHTML|outerHTML|insertAdjacentHTML/, f);
  }
  const slot = files.find((x) => x.f === "components/ReplySlot.tsx")!.src;
  assert.equal(count(slot, /<iframe[\s>]/g), 1, "one frame, the walled one");
  assert.match(slot, /el\.srcdoc = walledSrcdoc\(/);
});
