// Run: pnpm test -- src/lib/group-menu.test.ts
// A sidebar group's actions menu from both its doors (§app.session-list/groups "The actions menu",
// §app/context-menus): the name row's ⋯ and a right-click or Shift+F10 on the name row. Both draw
// GroupMenuBody, which draws lib/group-menu's rows: each row is pressed and what it runs is checked
// (the screen it shows, the link it is, the reason it is off), and both doors' menus are drawn
// (Solid's SSR build) and compared.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionGroup } from "../../shared/protocol";
import { groupDeletedToast, groupDeleteQuestion, groupMenuLabel, groupMenuRows } from "./group-menu";
import { EMPTY_GROUP_REASON } from "./group-picker";
import { groupHref } from "./group-route";

const group = (over: Partial<SessionGroup> = {}): SessionGroup => ({ id: "g-1", name: "Work", createdAt: "2026-02-01T00:00:00.000Z", ...over }) as SessionGroup;

/** Press the row named `label` and return the screens it asked for. */
function press(label: string, count = 2) {
  const shown: string[] = [];
  const row = groupMenuRows(group(), count, (s) => shown.push(s)).find((r) => r.label === label);
  assert.ok(row, `no row ${label}`);
  assert.equal(row.disabled || "", "", `${label} is off: ${row.disabled}`);
  row.run?.();
  return { shown, row };
}

test("the three rows, in order, each naming the group", () => {
  const rows = groupMenuRows(group(), 2, () => {});
  assert.deepEqual(
    rows.map((r) => [r.label, r.aria]),
    [
      ["Open workspace", "Open “Work” as a workspace"],
      ["Rename…", "Rename “Work”"],
      ["Delete group…", "Delete “Work”"],
    ],
  );
  assert.equal(groupMenuLabel("Work"), "Group actions · Work");
});

test("Open workspace is a link to the group's workspace; off with its reason for an empty group", () => {
  const { row, shown } = press("Open workspace");
  assert.equal(row.href, groupHref("g-1"));
  assert.equal(row.run, undefined, "the browser navigates");
  assert.deepEqual(shown, []);
  const empty = groupMenuRows(group(), 0, () => {})[0]!;
  assert.equal(empty.disabled, EMPTY_GROUP_REASON);
});

test("Rename… and Delete group… ask inside the menu, and change nothing yet", () => {
  for (const [label, screen] of [
    ["Rename…", "rename"],
    ["Delete group…", "delete"],
  ] as const) {
    const { shown, row } = press(label);
    assert.deepEqual(shown, [screen]);
    assert.equal(row.stayOpen, true, `${label}: the menu stays open on its screen`);
  }
});

test("the Delete screen's question and its toast, in both their forms", () => {
  assert.equal(groupDeleteQuestion("Work", 0), "Delete “Work”? Nothing is in it.");
  assert.equal(groupDeleteQuestion("Work", 1), "Delete “Work”? Its 1 session stays in the list.");
  assert.equal(groupDeleteQuestion("Work", 4), "Delete “Work”? Its 4 sessions stay in the list.");
  assert.equal(groupDeletedToast("Work", 0), "Deleted “Work”. It had no sessions.");
  assert.equal(groupDeletedToast("Work", 1), "Deleted “Work”. Its 1 session is ungrouped.");
  assert.equal(groupDeletedToast("Work", 4), "Deleted “Work”. Its 4 sessions are ungrouped.");
});

// ---- both doors draw the same menu ----

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const resolve = (s: string) => import.meta.resolve(s);
const { GroupMenuBody } = await importSsr(new URL("../components/Groups.tsx", import.meta.url), resolve);
const { ActionMenu, MenuPanel } = await importSsr(new URL("../components/ActionMenu.tsx", import.meta.url), resolve);

const draw = (make: () => import("solid-js").JSX.Element) =>
  renderToString(make)
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/<!--[^>]*-->/g, "");
/** The menu list itself: what the panel holds, without the ⋯ trigger. */
const list = (html: string) => html.slice(html.indexOf('<div class="model-menu-list"'));
const body = (g: SessionGroup, count: number) => (menu: unknown) => solid.createComponent(GroupMenuBody as never, { menu, group: g, count, onChanged() {} } as never);

/** The name row's ⋯, as GroupBlock draws it (inside the <summary>, so `contain`). SSR draws nothing
    inside a Portal, and `contain` only wraps the same panel in one (ActionMenu.tsx MenuPanel), so
    the panel is drawn without it to compare. */
const dotsMenu = (g: SessionGroup, count: number, contain = true) =>
  draw(() => solid.createComponent(ActionMenu as never, { label: groupMenuLabel(g.name), title: "Group actions", class: "group-actions", contain, children: body(g, count) } as never));
/** A right-click on the name row: the same body in the page's one panel, as ContextMenuHost draws it. */
const contextMenu = (g: SessionGroup, count: number) =>
  list(draw(() => solid.createComponent(MenuPanel as never, { anchor: () => ({ kind: "point", x: 0, y: 0 }), origin: () => undefined, returnFocus: true, controls() {}, children: body(g, count) } as never)));

test("the name row's ⋯ and a right-click on it draw the same menu", () => {
  for (const [g, count] of [
    [group(), 3],
    [group(), 0],
    [group({ name: "Say “hi” <now>" }), 1],
  ] as const) {
    const dots = dotsMenu(g, count);
    assert.match(dots, /^<button type="button" class="button button-icon button-ghost group-actions" aria-haspopup="menu"/);
    assert.doesNotMatch(dots, /model-menu-list/, "the ⋯'s panel is portalled out of the summary");
    const ctx = contextMenu(g, count);
    assert.ok(ctx.startsWith(`<div class="model-menu-list" role="menu" aria-label="Group actions · `), ctx.slice(0, 120));
    assert.equal(list(dotsMenu(g, count, false)), ctx, `${g.name}, ${count}`);
  }
});

test("an empty group: Open workspace is off with its reason, in the right-click menu too", () => {
  const html = contextMenu(group(), 0);
  assert.match(html, new RegExp(`aria-label="Open “Work” as a workspace" aria-disabled="true" title="${EMPTY_GROUP_REASON}"`));
  assert.doesNotMatch(html, /href="#\/g\//, "a disabled link row loses its href");
  assert.match(contextMenu(group(), 2), new RegExp(`href="${groupHref("g-1").replace(/[/#]/g, "\\$&")}"`));
});
