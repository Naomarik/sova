// Settings → Alignment's one form over two stores (§app.settings-dialog/alignment): review to Sova's
// settings, style and Visuals to mode-align.json — each written only when it changed, at the same time,
// and a failure after the other landed is a partial save that keeps the draft.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ALIGN_EAGERNESS_OPTIONS, ALIGN_STYLE_OPTIONS, sameAlignment, writeAlignment, type AlignmentSettings } from "./alignment-draft";
import { SaveFailed } from "./settings-draft";

const base: AlignmentSettings = { eagerness: "eager", style: "default", visuals: false, review: false };

function io(fail: { review?: string; align?: string } = {}) {
  const calls: string[] = [];
  return {
    calls,
    io: {
      putReview: async (review: boolean) => {
        calls.push(`review:${review}`);
        if (fail.review) throw new Error(fail.review);
        return review;
      },
      putAlign: async (a: { eagerness: AlignmentSettings["eagerness"]; style: AlignmentSettings["style"]; visuals: boolean }) => {
        calls.push(`align:${a.style}:${a.visuals}${a.eagerness === "careful" ? ":careful" : ""}`);
        if (fail.align) throw new Error(fail.align);
        return a;
      },
    },
  };
}

test("only what changed is written, each to its own store", async () => {
  const a = io();
  assert.deepEqual(await writeAlignment({ ...base, review: true }, base, a.io), { ...base, review: true });
  assert.deepEqual(a.calls, ["review:true"], "review alone: Sova's settings only");
  const b = io();
  assert.deepEqual(await writeAlignment({ ...base, style: "pm" }, base, b.io), { ...base, style: "pm" });
  assert.deepEqual(b.calls, ["align:pm:false"], "style alone: mode-align.json only, whole");
  const c = io();
  await writeAlignment({ eagerness: "eager", style: "simplified", visuals: true, review: true }, base, c.io);
  assert.deepEqual(c.calls.sort(), ["align:simplified:true", "review:true"], "both: both");
  const d = io();
  assert.deepEqual(await writeAlignment({ ...base, eagerness: "careful" }, base, d.io), { ...base, eagerness: "careful" });
  assert.deepEqual(d.calls, ["align:default:false:careful"], "Eagerness alone: mode-align.json, whole");
});

test("a failure keeps the draft; partial when the other store's write landed", async () => {
  const one = io({ align: "disk full" });
  await assert.rejects(writeAlignment({ ...base, style: "pm", review: true }, base, one.io), (e: unknown) => e instanceof SaveFailed && e.partial && e.message === "disk full");
  const alone = io({ align: "disk full" });
  await assert.rejects(writeAlignment({ ...base, style: "pm" }, base, alone.io), (e: unknown) => e instanceof SaveFailed && !e.partial, "nothing else was written: not partial");
});

test("the form's own words and equality", () => {
  assert.deepEqual(
    ALIGN_STYLE_OPTIONS.map((o) => [o.id, o.label, o.description]),
    [
      ["pm", "Project manager", "Screens, wording and behaviour only; no code. Technical detail folded into notes."],
      ["simplified", "Simplified", "Short sentences in everyday words, fewer items."],
      ["default", "Technical", "Files, code and technical trade-offs in the plan."],
    ],
  );
  assert.equal(sameAlignment(base, { ...base }), true);
  assert.equal(sameAlignment(base, { ...base, visuals: true }), false);
  assert.equal(sameAlignment(base, { ...base, eagerness: "careful" }), false, "an Eagerness change is unsaved");
  assert.deepEqual(
    ALIGN_EAGERNESS_OPTIONS.map((o) => [o.id, o.label, o.description]),
    [
      ["eager", "Eager", "Opens an alignment card for any request that implies work, and leans toward asking first."],
      ["careful", "Careful", "Opens one when you want something changed; questions get their answer in chat."],
    ],
  );
});
