// Run: pnpm test -- src/lib/worktree-menu.test.ts
// A project's coding-worktree row menu from both its doors (§app.project-overseer/coding-worktrees,
// §app/context-menus): the row's ⋯ and a right-click or Shift+F10 on the row. Both draw the row's
// one list (lib/worktree-menu) with components/MenuRows: each row is pressed from each door and what
// it runs is checked (merge, land at the head the page read, the confirm under the row), with the reasons a
// row is off and the rows that are absent, and both doors' menus are drawn (Solid's SSR build) and
// compared.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { WorktreeQueueInfo } from "../../shared/merge-queue";
import { type CodingRow, READING_BRANCH } from "./coding-worktrees";
import { SENT_BACK_LINE } from "./merge-queue";
import type { MenuRow } from "./menu-row";
import { type WorktreeMenuFacts, worktreeMenuLabel, worktreeMenuOffered, worktreeMenuRows } from "./worktree-menu";

const row = (over: Partial<CodingRow> = {}): CodingRow =>
  ({ sessionId: "s-1", title: "Payroll export", branch: "sova/payroll-3f9a1c", target: "master", worktree: "/work/.worktrees/app-payroll", head: "1234567abc", createdAt: "", facts: true, ...over }) as CodingRow;
const entry = (state: string, over: Partial<WorktreeQueueInfo> = {}) => ({ state, commit: "abcdef1234567", ...over }) as unknown as WorktreeQueueInfo;
const facts = (over: Partial<WorktreeMenuFacts> = {}): WorktreeMenuFacts => ({ row: row(), title: "Payroll export", gestures: { merge: null, remove: null }, queued: false, queue: undefined, working: false, ...over });

type Call = [string, ...unknown[]];
const acts = (calls: Call[]) => ({ merge: () => calls.push(["merge"]), land: () => calls.push(["land"]), remove: () => calls.push(["remove"]) });

/** Both doors read the row's menu the same way; the ⋯ draws it when opened, the right-click when it comes. */
const DOORS = ["the row's ⋯", "a right-click on the row"] as const;

function press(label: string, f: WorktreeMenuFacts) {
  const calls: Call[] = [];
  const r = worktreeMenuRows(f, acts(calls)).find((x) => x.label === label);
  assert.ok(r, `no row ${label}`);
  assert.equal(r.disabled || "", "", `${label} is off: ${r.disabled}`);
  r.run?.();
  return calls;
}
const reasons = (f: WorktreeMenuFacts) => Object.fromEntries(worktreeMenuRows(f, acts([])).map((r: MenuRow) => [r.label, r.disabled || ""]));

for (const door of DOORS) {
  test(`${door}: without the merge queue, Merge Branch merges and Remove Worktree… asks under the row`, () => {
    assert.deepEqual(
      worktreeMenuRows(facts(), acts([])).map((r) => [r.label, r.aria, r.description ?? null]),
      [
        ["Merge Branch", "Merge Branch: sova/payroll-3f9a1c into master", "sova/payroll-3f9a1c into master"],
        ["Remove Worktree…", "Remove Worktree: Payroll export", null],
      ],
    );
    assert.deepEqual(press("Merge Branch", facts()), [["merge"]]);
    assert.deepEqual(press("Remove Worktree…", facts()), [["remove"]]);
  });

  test(`${door}: with the merge queue, Land queues the head this page read; a sent-back entry has no second Land row`, () => {
    const queued = facts({ queued: true });
    assert.deepEqual(worktreeMenuRows(queued, acts([])).map((r) => r.label), ["Land", "Remove Worktree…"]);
    assert.deepEqual(press("Land", queued), [["land"]]);
    // Sent back, at the head the page reads or after the branch moved: Land alone, as the ⋯ has it.
    for (const queue of [entry("needs-fix"), entry("needs-fix", { newerCommits: 2 }), entry("with-chat")])
      assert.deepEqual(reasons(facts({ queued: true, queue, row: row({ head: "abcdef1234567" }) })), { Land: SENT_BACK_LINE, "Remove Worktree…": "" }, JSON.stringify(queue));
    // Its fix redrafted: Land runs again.
    assert.deepEqual(press("Land", facts({ queued: true, queue: entry("needs-fix", { redrafted: true }) })), [["land"]]);
    // Its folder gone: Land says where to land it from.
    const gone = facts({ queued: true, queue: entry("needs-fix"), row: row({ worktree: undefined }) });
    assert.deepEqual(reasons(gone), { Land: "Its folder is gone: land it from its chat.", "Remove Worktree…": "" });
  });

  test(`${door}: the rows that can't run say why, before the press`, () => {
    const reading = facts({ gestures: { merge: READING_BRANCH, remove: READING_BRANCH } });
    assert.deepEqual(reasons(reading), { "Merge Branch": READING_BRANCH, "Remove Worktree…": READING_BRANCH });
    assert.deepEqual(reasons(facts({ working: true })), { "Merge Branch": "Working", "Remove Worktree…": "Working" });
    // The gesture's own reason wins over Working.
    assert.equal(reasons(facts({ working: true, gestures: { merge: "No commits beyond master.", remove: null } }))["Merge Branch"], "No commits beyond master.");
    assert.equal(reasons(facts({ queued: true, queue: entry("queued") })).Land, "Already in the merge queue.");
    assert.equal(reasons(facts({ queued: true, queue: entry("needs-fix"), working: true, row: row({ head: "abcdef1234567" }) })).Land, "Working");
  });

  test(`${door}: a gesture the row doesn't offer is absent; neither offered, no menu at all`, () => {
    assert.deepEqual(worktreeMenuRows(facts({ gestures: { merge: false, remove: null } }), acts([])).map((r) => r.label), ["Remove Worktree…"]);
    assert.deepEqual(worktreeMenuRows(facts({ gestures: { merge: null, remove: false }, queued: true }), acts([])).map((r) => r.label), ["Land"]);
    assert.equal(worktreeMenuOffered({ merge: false, remove: false }), false);
    assert.equal(worktreeMenuOffered({ merge: READING_BRANCH, remove: false }), true);
  });
}

// ---- both doors draw the same menu ----

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const resolve = (s: string) => import.meta.resolve(s);
const { MenuRows } = await importSsr(new URL("../components/MenuRows.tsx", import.meta.url), resolve);
const { ActionMenu, MenuPanel } = await importSsr(new URL("../components/ActionMenu.tsx", import.meta.url), resolve);

const draw = (make: () => import("solid-js").JSX.Element) =>
  renderToString(make)
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/<!--[^>]*-->/g, "");
/** The panel itself, without the ⋯ trigger (this menu has no list wrapper: its rows sit in the panel). */
const panel = (html: string) => html.slice(html.indexOf('<div class="model-menu action-menu"'));
const rows = (f: WorktreeMenuFacts) => (menu: unknown) => solid.createComponent(MenuRows as never, { menu, rows: worktreeMenuRows(f, acts([])) } as never);
/** The row's ⋯, as ProjectOverseerPanel draws it. */
const dotsMenu = (f: WorktreeMenuFacts) => draw(() => solid.createComponent(ActionMenu as never, { label: worktreeMenuLabel(f.title), title: "Actions", icon: "more", children: rows(f) } as never));
/** A right-click on the row: the same rows in the page's one panel, as ContextMenuHost draws it. */
const contextMenu = (f: WorktreeMenuFacts) =>
  panel(draw(() => solid.createComponent(MenuPanel as never, { anchor: () => ({ kind: "point", x: 0, y: 0 }), origin: () => undefined, returnFocus: true, controls() {}, children: rows(f) } as never)));

test("the row's ⋯ and a right-click on the row draw the same menu", () => {
  for (const f of [
    facts(),
    facts({ working: true }),
    facts({ gestures: { merge: READING_BRANCH, remove: READING_BRANCH } }),
    facts({ queued: true }),
    facts({ queued: true, queue: entry("needs-fix") }),
    facts({ queued: true, queue: entry("with-chat") }),
    facts({ queued: true, queue: entry("queued") }),
    facts({ gestures: { merge: false, remove: null } }),
  ]) {
    const dots = dotsMenu(f);
    assert.match(dots, /^<button type="button" class="button button-icon button-ghost" aria-haspopup="menu" aria-expanded="false" aria-label="Actions · Payroll export" title="Actions">/);
    assert.equal(contextMenu(f), panel(dots), JSON.stringify(f));
  }
  assert.match(contextMenu(facts({ working: true })), /aria-label="Merge Branch: sova\/payroll-3f9a1c into master" aria-disabled="true" title="Working"/);
});
