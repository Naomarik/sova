// Run: pnpm test -- src/lib/land-confirm.test.ts. Land asks first, everywhere Land appears (the Worktrees modal, the
// session pane's Worktrees rows and the Merge Queue tab's Ready rows all draw LandSplit and LandConfirms from
// WorktreesModal.tsx): the button's words, the confirm's words from the row's own commit count, the order of its
// buttons, the specs confirm drawn the same way, and the rows hiding their actions while a confirm is open. Focus and
// Escape are the browser's (checked by driving the modal).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { landConfirmWords, modalHead } from "./merge-queue";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const resolve = (s: string) => import.meta.resolve(s);
const { LandSplit, LandConfirms, createLandConfirm } = await importSsr(new URL("../components/WorktreesModal.tsx", import.meta.url), resolve);

const html = (fn: () => unknown) => renderToString(fn as never).replaceAll(/<!--[^>]*-->/g, "");
/** Each button's text, in document order, with its classes. */
const buttons = (h: string) => [...h.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map((m) => ({ cls: m[1] ?? "", text: (m[2] ?? "").trim() }));
/** The nth button, or a failure that says there's none. */
const nth = (h: string, i: number) => buttons(h)[i] ?? assert.fail(`no button ${i}`);
const asking = (k: "land" | "specs" | null) => ({ ask: () => k, open() {}, close() {}, rowRef() {} });
const noop = () => {};

test("the confirm's words: the row's commit count, what moves once the checks pass, and a fallback with no count", () => {
  assert.deepEqual(landConfirmWords("feat/x", 3, "master"), {
    title: "Land feat/x?",
    line: "3 commits go to the merge queue; master moves once checks pass.",
    confirm: "Land 3 Commits",
  });
  assert.deepEqual(landConfirmWords("feat/x", 1, "main"), { title: "Land feat/x?", line: "1 commit goes to the merge queue; main moves once checks pass.", confirm: "Land 1 Commit" });
  // No count known (or a stale 0): the line names none, and the button names the branch instead of a number.
  for (const n of [undefined, 0]) {
    const w = landConfirmWords("feat/x", n, undefined);
    assert.equal(w.line, "Its commits go to the merge queue; the target branch moves once checks pass.");
    assert.equal(w.confirm, "Land Branch");
    assert.doesNotMatch(`${w.line} ${w.confirm}`, /\b0\b|undefined/);
  }
  // A project that lands by request: nothing moves on its own, so the line says what happens instead.
  assert.equal(landConfirmWords("feat/x", 2, "main", "github-pr").line, "2 commits go to the merge queue; a pull request opens on GitHub once checks pass.");
  assert.doesNotMatch(landConfirmWords("feat/x", 2, "main", "push-branch").line, /main moves/);
});

test("Land reads Land (no ellipsis) and only asks; its ▾ is a separate button", () => {
  const h = html(() => solid.createComponent(LandSplit, { branch: "feat/x", review: true, busy: false, onAsk: noop, onLand: noop, onWithoutSpecs: noop }));
  const b = buttons(h);
  assert.equal(nth(h, 0).text, "Land");
  assert.match(nth(h, 0).cls, /\bwt-queue-land\b/);
  assert.match(h, /aria-label="Land feat\/x"/);
  assert.doesNotMatch(h, /Land…|feat\/x…/, "no ellipsis on Land");
  assert.match(h, /aria-haspopup="menu"/, "the ▾ is its own menu button");
  assert.equal(b.filter((x) => x.text === "Land").length, 1);
});

test("an open Land confirm: bold question, the muted line, Not Yet (ghost) then the primary action rightmost", () => {
  const h = html(() => solid.createComponent(LandConfirms, { confirm: asking("land"), branch: "feat/x", ahead: 3, target: "master", busy: false, onLand: noop }));
  assert.match(h, /class="wt-queue-confirm"[^>]*role="group"[^>]*aria-label="Land feat\/x"/);
  assert.match(h, /<p class="wt-queue-confirm-title">Land feat\/x\?<\/p>/);
  assert.match(h, /3 commits go to the merge queue; master moves once checks pass\./);
  assert.deepEqual(
    buttons(h).map((x) => [x.text, /button-primary/.test(x.cls), /button-ghost/.test(x.cls)]),
    [
      ["Not Yet", false, true],
      ["Land 3 Commits", true, false],
    ],
  );
});

test("Land Without Its Specs…'s confirm is drawn the same way: Cancel, then Land Without Specs", () => {
  const h = html(() => solid.createComponent(LandConfirms, { confirm: asking("specs"), branch: "feat/x", ahead: 3, target: "master", busy: false, onLand: noop }));
  assert.match(h, /class="wt-queue-confirm"[^>]*aria-label="Land feat\/x without its specs"/);
  assert.match(h, /Land feat\/x without its specs\?/);
  assert.deepEqual(buttons(h).map((x) => x.text), ["Cancel", "Land Without Specs"]);
  assert.match(nth(h, 1).cls, /button-primary/);
});

test("no confirm open draws nothing; the confirm state opens one kind at a time and closes", () => {
  assert.equal(html(() => solid.createComponent(LandConfirms, { confirm: asking(null), branch: "feat/x", busy: false, onLand: noop })), "");
  const c = createLandConfirm();
  assert.equal(c.ask(), null);
  c.open("land");
  assert.equal(c.ask(), "land");
  c.open("specs");
  assert.equal(c.ask(), "specs", "the ▾'s confirm replaces Land's");
  c.close(true); // no row element: nothing to focus, and no throw
  assert.equal(c.ask(), null);
});

test("every row that draws Land hides its actions while a confirm is open, and Land only opens it", () => {
  for (const file of ["WorktreesModal.tsx", "MergeQueueTab.tsx"]) {
    const src = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8");
    const uses = [...src.matchAll(/<LandSplit\b[\s\S]*?\/>/g)].map((m) => m[0]);
    assert.ok(uses.length >= 1, `${file} draws LandSplit`);
    for (const u of uses) assert.match(u, /onAsk=\{\(\) => confirm\.open\("land"\)\}/, `${file}: Land opens the confirm, never lands`);
    assert.equal([...src.matchAll(/<LandConfirms\b/g)].length, uses.length, `${file}: one confirm per Land`);
    assert.equal([...src.matchAll(/<Show when=\{!confirm\.ask\(\)\}>/g)].length, uses.length, `${file}: the actions step aside for it`);
  }
});

test("the Worktrees dialog: its foot carries the queue's one line and View Merge Queue; no Close button there", () => {
  assert.equal(modalHead([{ mergeServed: true, mergeProject: { target: "master", checks: "declared" } }]).intro, "Land queues a branch; it lands as the commit that was tested.");
  const src = readFileSync(new URL("../components/WorktreesModal.tsx", import.meta.url), "utf8");
  const modal = src.slice(src.indexOf("export function WorktreesModal("));
  const foot = modal.slice(modal.indexOf('class="modal-foot'));
  assert.match(foot, /head\(\)\.intro/);
  assert.match(foot, /View Merge Queue/);
  assert.doesNotMatch(foot, />\s*Close\s*</, "the head's ✕ is the one close");
  assert.doesNotMatch(modal.slice(modal.indexOf('class="modal-body"'), modal.indexOf("</div>", modal.indexOf('class="modal-body"'))), /head\(\)\.intro/, "not in the body too");
});
