// Run: pnpm test -- src/lib/pane-menu.test.ts
// A workspace pane's Pane actions from every door (§workspace.groups/a-pane, §app/context-menus):
// the pane head's ⋯, a right-click or Shift+F10 on the pane head, and one on its tab. Every door
// builds its pane's props with `paneMenuFor` over the workspace's one wiring, and draws
// PaneMenuBody: each row is pressed from each door and what it runs is checked (the workspace
// gesture and its path, the screen, the focus rule, the reason it is off, the rows that are
// absent), and the ⋯'s menu and the right-click's are drawn (Solid's SSR build) and compared.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionSummary } from "../../shared/protocol";
import type { MenuRow } from "./menu-row";
import { paneEliminate, type PaneMenuActs, paneMenuFor, paneMenuLabel, type PaneMenuProps, paneMenuRows, type PaneMenuWiring } from "./pane-menu";

const A = "/state/sessions/a.jsonl";
const B = "/state/sessions/b.jsonl";
const C = "/state/sessions/c.jsonl";
const summary = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({ id: "s-a", path: A, cwd: "/work/a", title: "Fix the build", createdAt: "", lastActiveAt: "", model: null, origin: "web", ...over }) as SessionSummary;

type Call = [string, ...unknown[]];

/** The workspace's wiring, as GroupView builds it, every gesture recorded. */
function wiring(calls: Call[], over: Partial<{ split: boolean; panes: string[]; running: boolean }> = {}): PaneMenuWiring {
  return {
    nameOf: (p) => (p === A ? "control · Opus 5" : "other"),
    groupName: () => "Retry",
    split: () => over.split ?? true,
    panes: () => over.panes ?? [A, B, C],
    labelOf: (p) => (p === A ? "control" : null),
    running: () => over.running ?? false,
    href: (p) => `#/s/${encodeURIComponent(p)}`,
    resize: (p, d) => calls.push(["resize", p, d]),
    move: (p, d) => calls.push(["move", p, d]),
    focusPane: (p, f) => calls.push(["focusPane", p, f]),
    rename: (p, l) => calls.push(["rename", p, l]),
    detach: (p, a) => calls.push(["detach", p, a]),
    promote: (p) => calls.push(["promote", p]),
  };
}
const acts = (calls: Call[]): PaneMenuActs => ({ go: (h) => calls.push(["go", h]) });
const all = (r: ReturnType<typeof paneMenuRows>): MenuRow[] => [...r.member, ...r.pane, ...r.membership];

/** The doors: the head's ⋯ and the head's right-click read the pane's own (held) summary; a tab reads the list's. */
const DOORS: [string, (s: SessionSummary) => () => SessionSummary][] = [
  ["the head's ⋯", (s) => () => s],
  ["a right-click on the head", (s) => () => s],
  // GroupView's tab: the list's row for its path, else the one it saw when the right-click came.
  ["a right-click on the tab", (s) => () => [s].find((m) => m.path === A) ?? s],
];

function press(label: string, door: (s: SessionSummary) => () => SessionSummary, opts: { s?: SessionSummary; split?: boolean; panes?: string[] } = {}) {
  const calls: Call[] = [];
  const p = paneMenuFor(A, door(opts.s ?? summary()), wiring(calls, opts));
  const row = all(paneMenuRows(p, () => calls.push(["startNaming"]), acts(calls))).find((r) => r.label === label);
  assert.ok(row, `no row ${label}`);
  assert.equal(row.disabled || "", "", `${label} is off: ${row.disabled}`);
  row.run?.();
  return { calls, row };
}

for (const [door, read] of DOORS) {
  test(`${door}: every row runs the workspace's gesture on this pane`, () => {
    const expect: [string, Call[], { keepFocus?: boolean; stayOpen?: boolean }][] = [
      ["Rename…", [["startNaming"]], { stayOpen: true }],
      ["Open", [["go", `#/s/${encodeURIComponent(A)}`]], { keepFocus: true }],
      ["Wider", [["resize", A, 1]], {}],
      ["Narrower", [["resize", A, -1]], {}],
      ["Move Right", [["move", A, 1]], {}],
      ["Focus", [["focusPane", A, true]], { keepFocus: true }],
      ["Promote", [["promote", A]], { keepFocus: true }],
      ["Remove From Group", [["detach", A, false]], { keepFocus: true }],
      ["Eliminate", [["detach", A, true]], { keepFocus: true }],
    ];
    for (const [label, calls, flags] of expect) {
      const r = press(label, read);
      assert.deepEqual(r.calls, calls, label);
      assert.equal(!!r.row.keepFocus, !!flags.keepFocus, `${label} keepFocus`);
      assert.equal(!!r.row.stayOpen, !!flags.stayOpen, `${label} stayOpen`);
    }
    // Move Left, on a pane that isn't first.
    assert.deepEqual(press("Move Left", read, { panes: [B, A, C] }).calls, [["move", A, -1]]);
  });

  test(`${door}: the rows that can't run say why; the rows that don't apply are absent`, () => {
    const rows = (over: Parameters<typeof wiring>[1] = {}, s = summary()) =>
      Object.fromEntries(all(paneMenuRows(paneMenuFor(A, read(s), wiring([], over)), () => {}, acts([]))).map((r) => [r.label, r.disabled || ""]));
    const first = rows();
    assert.equal(first["Move Left"], "It's already first.");
    assert.equal(first["Move Right"], "");
    assert.equal(rows({ panes: [C, A] })["Move Right"], "It's already last.");
    assert.equal(first.Eliminate, "");
    assert.equal(rows({ running: true }).Eliminate, "It's mid-turn. Stop it or wait, then eliminate it.");
    assert.equal(rows({}, summary({ live: { pid: 1, status: "idle" } } as Partial<SessionSummary>)).Eliminate, "This session is open in a terminal.");
    // Not started in Sova: nothing to archive, so no Eliminate at all.
    assert.equal("Eliminate" in rows({}, summary({ origin: "external" } as Partial<SessionSummary>)), false);
    // Tabs mode (no split row): width and order mean nothing, so those rows are absent.
    assert.deepEqual(Object.keys(rows({ split: false })), ["Rename…", "Open", "Focus", "Promote", "Remove From Group", "Eliminate"]);
  });
}

test("every door builds the same rows for a pane, in the same groups and words", () => {
  const shapes = DOORS.map(([, read]) => JSON.stringify(paneMenuRows(paneMenuFor(A, read(summary()), wiring([])), () => {}, acts([]))));
  assert.equal(new Set(shapes).size, 1);
  const r = paneMenuRows(paneMenuFor(A, () => summary(), wiring([])), () => {}, acts([]));
  assert.deepEqual(
    [r.member, r.pane, r.membership].map((g) => g.map((x) => x.label)),
    [["Rename…"], ["Open", "Wider", "Narrower", "Move Left", "Move Right", "Focus"], ["Promote", "Remove From Group", "Eliminate"]],
  );
  assert.equal(paneMenuLabel("control · Opus 5"), "Pane actions · control · Opus 5");
});

test("the props follow the workspace live: an open menu reads the pane's place as it is now", () => {
  let panes = [A, B];
  const w = { ...wiring([]), panes: () => panes };
  const p = paneMenuFor(A, () => summary(), w);
  assert.equal(p.first, true);
  panes = [B, A];
  assert.equal(p.first, false);
  assert.equal(p.last, true);
  assert.equal(p.label, "control");
  assert.equal(p.name, "control · Opus 5");
});

test("paneEliminate: absent for what Sova didn't start, else the reason it can't, else on", () => {
  assert.equal(paneEliminate(summary({ origin: "external" } as Partial<SessionSummary>), false), null);
  assert.equal(paneEliminate(summary({ live: { pid: 1, status: "idle" } } as Partial<SessionSummary>), true), "This session is open in a terminal.");
  assert.equal(paneEliminate(summary(), true), "It's mid-turn. Stop it or wait, then eliminate it.");
  assert.equal(paneEliminate(summary(), false), "");
});

// ---- the ⋯ and the right-click draw the same menu ----

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const resolve = (s: string) => import.meta.resolve(s);
const { PaneMenu, PaneMenuBody } = await importSsr(new URL("../components/PaneMenu.tsx", import.meta.url), resolve);
const { MenuPanel } = await importSsr(new URL("../components/ActionMenu.tsx", import.meta.url), resolve);

const draw = (make: () => import("solid-js").JSX.Element) =>
  renderToString(make)
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/<!--[^>]*-->/g, "");
const list = (html: string) => html.slice(html.indexOf('<div class="model-menu-list"'));
const dotsMenu = (p: PaneMenuProps) => list(draw(() => solid.createComponent(PaneMenu as never, p as never)));
/** The head's or the tab's right-click: the same body in the page's one panel, as GroupView opens it. */
const contextMenu = (p: PaneMenuProps) =>
  list(
    draw(() =>
      solid.createComponent(MenuPanel as never, {
        anchor: () => ({ kind: "point", x: 0, y: 0 }),
        origin: () => undefined,
        returnFocus: true,
        controls() {},
        children: (menu: unknown) => solid.createComponent(PaneMenuBody as never, solid.mergeProps(p, { menu }) as never),
      } as never),
    ),
  );

test("the head's ⋯ and a right-click on the head or the tab draw the same menu", () => {
  const cases: [Parameters<typeof wiring>[1], SessionSummary][] = [
    [{}, summary()],
    [{ panes: [B, A] }, summary()],
    [{ split: false }, summary()],
    [{ running: true }, summary()],
    [{}, summary({ origin: "external" } as Partial<SessionSummary>)],
  ];
  for (const [over, s] of cases) {
    const p = paneMenuFor(A, () => s, wiring([], over));
    const dots = dotsMenu(p);
    assert.ok(dots.startsWith('<div class="model-menu-list" role="menu" aria-label="Pane actions · control · Opus 5">'), dots.slice(0, 120));
    assert.equal(contextMenu(p), dots, JSON.stringify(over));
  }
  // A disabled row carries its reason as its title in both.
  const off = contextMenu(paneMenuFor(A, () => summary(), wiring([])));
  assert.match(off, /aria-label="Move control · Opus 5 left" aria-disabled="true" title="It's already first."/);
});
