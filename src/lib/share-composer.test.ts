// The share build's message box keys and hint (§app.project-assistant/chat, "The composer's keys";
// hand-off pages keep Ctrl+Enter, §app.baton/outsider-view).
import assert from "node:assert/strict";
import { test } from "node:test";
import { composerEnterKeyHint, composerKeySends, composerPlaceholder, composerSend, countFrom } from "./share-composer";

const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing: boolean }> = {}) => ({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...mods });

test("owner page: Enter sends, Shift+Enter is a line, a touch makes Enter a line", () => {
  assert.equal(composerKeySends("enter", key("Enter"), false), true);
  assert.equal(composerKeySends("enter", key("Enter", { shiftKey: true }), false), false);
  assert.equal(composerKeySends("enter", key("Enter"), true), false);
  for (const touch of [false, true]) {
    assert.equal(composerKeySends("enter", key("Enter", { ctrlKey: true }), touch), true);
    assert.equal(composerKeySends("enter", key("Enter", { metaKey: true }), touch), true);
  }
});

test("owner page: an IME's Enter never sends, not even with Ctrl", () => {
  for (const touch of [false, true]) {
    assert.equal(composerKeySends("enter", key("Enter", { isComposing: true }), touch), false);
    assert.equal(composerKeySends("enter", key("Enter", { isComposing: true, ctrlKey: true }), touch), false);
  }
});

test("hand-off pages: only Ctrl+Enter or ⌘+Enter sends, touch or not", () => {
  for (const touch of [false, true]) {
    assert.equal(composerKeySends("mod-enter", key("Enter"), touch), false);
    assert.equal(composerKeySends("mod-enter", key("Enter", { shiftKey: true }), touch), false);
    assert.equal(composerKeySends("mod-enter", key("Enter", { ctrlKey: true }), touch), true);
    assert.equal(composerKeySends("mod-enter", key("Enter", { metaKey: true }), touch), true);
  }
  assert.equal(composerKeySends("mod-enter", key("a", { ctrlKey: true }), false), false);
});

test("the placeholder carries the hint exactly while Enter sends", () => {
  assert.equal(composerPlaceholder("enter", "Write a message", false), "Write a message. Enter sends");
  assert.equal(composerPlaceholder("enter", "Write a message", true), "Write a message");
  // Hand-off pages: their hint is the foot's "Ctrl+Enter sends", never the placeholder.
  for (const touch of [false, true]) assert.equal(composerPlaceholder("mod-enter", "Write your reply", touch), "Write your reply");
});

test("enterkeyhint is send only while Enter sends; hand-off pages set none", () => {
  assert.equal(composerEnterKeyHint("enter", false), "send");
  assert.equal(composerEnterKeyHint("enter", true), "enter");
  assert.equal(composerEnterKeyHint("mod-enter", false), undefined);
  assert.equal(composerEnterKeyHint("mod-enter", true), undefined);
});

test("the count starts at 80% of the limit (3,200 of the 4,000 both pages take)", () => {
  assert.equal(countFrom(4000), 3200);
});

test("instant send: a photo expired, the retry sends the first text and leaves what was added meanwhile", async () => {
  type A = { cid: string; kind: "photo" | "file"; state: string; id?: string };
  let draft = "hello";
  let atts: A[] = [{ cid: "p1", kind: "photo", state: "ready", id: "s1" }];
  const sends: { text: string; photos: string[]; again: boolean }[] = [];
  await composerSend<A>({
    draft: () => draft,
    setDraft: (t) => (draft = t),
    atts: () => atts,
    setAtts: (l) => (atts = l),
    copy: (l) => l.map((a) => ({ ...a })),
    upload: async (cid) => {
      atts = atts.map((a) => (a.cid === cid ? { ...a, id: `${a.id}x` } : a));
      return true;
    },
    send: async (text, photos, _files, again) => {
      sends.push({ text, photos: photos.map((p) => p.cid), again });
      if (again) return "sent";
      // Typed and attached while the first send was in flight.
      draft = "more";
      atts = [...atts, { cid: "p2", kind: "photo", state: "ready", id: "s2" }];
      return { expired: "photo" };
    },
    optimistic: true,
  });
  assert.deepEqual(sends.map((s) => s.text), ["hello", "hello"]);
  assert.deepEqual(sends[1]!.photos, ["p1"], "the retry sends only what the first send took");
  assert.equal(draft, "more");
  assert.deepEqual(atts.map((a) => a.cid), ["p2"]);
});
