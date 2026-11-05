// Run: pnpm test -- src/lib/session-menu.test.ts
// The session menu from every door (§app.extensions/session-menu, §app.insights/team-cards,
// §app.session-list/accessibility): the Agents board row's ⋯ (and its right-click), and a
// right-click on a sidebar session row. Each row is pressed from each door and what it runs is
// checked — the handler or route, the server call, the Archive state, the reasons a row is off —
// and both doors' menus are drawn (Solid's SSR build) and compared, extension rows included.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionInfo, SessionSummary } from "../../shared/protocol";
import { ORG_GROUP_REASON } from "./regions";
import { renameValue, type SessionMenuActs, type SessionMenuCtx, sessionArchiveRow, sessionMenuRows, sidebarSessionMenuCtx } from "./session-menu";

const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id: "s-1",
    path: "/state/sessions/a.jsonl",
    cwd: "/work/a",
    title: "Fix the build",
    createdAt: "2026-02-01T00:00:00.000Z",
    lastActiveAt: "2026-02-01T00:00:00.000Z",
    model: null,
    origin: "web",
    ...over,
  }) as SessionSummary;
const ORG = { org: { id: "o-1", name: "Acme", project: "p-1" } } as unknown as Partial<SessionSummary>;

type Call = [string, ...unknown[]];

/** A door's context whose every gesture is recorded: the board's, as AgentsView hands App's handlers through. */
function boardDoor(calls: Call[], detailsPath: string | null = null): SessionMenuCtx {
  return {
    detailsPath,
    onOpenDetails: (p) => calls.push(["board.openDetailsFor", p]),
    onOpenSubagents: (p) => calls.push(["openSubagentsFor", p]),
    onRefresh: () => calls.push(["refresh"]),
    onArchiveChanged: (p, a) => calls.push(["onArchived", p, a]),
  };
}

/** The sidebar's door, built as App builds it, over a recorded stand-in of App's pane wiring. */
function sidebarDoor(calls: Call[], pane: { path: string | null; tab: "session" | "agents" } = { path: null, tab: "session" }) {
  const state = { ...pane };
  return sidebarSessionMenuCtx({
    route: (p) => calls.push(["route", p]),
    paneOn: (p, tab) => state.path === p && state.tab === tab,
    openPane: (p, tab) => {
      calls.push(["openPane", p, tab]);
      state.path = p;
      state.tab = tab;
    },
    closePane: () => {
      calls.push(["closePane"]);
      state.path = null;
    },
    detailsOnSession: () => (state.tab === "session" ? state.path : null),
    onRefresh: () => calls.push(["refresh"]),
    onArchiveChanged: (p, a) => calls.push(["onArchived", p, a]),
  });
}

/** Server calls, recorded; each answers `ok`. */
function acts(calls: Call[], ok = true): SessionMenuActs {
  return {
    setTitle: async (s, t) => (calls.push(["setTitle", s.path, t]), ok),
    setArchived: async (s, a) => (calls.push(["setArchived", s.path, a]), ok),
    loadGroups: () => calls.push(["loadGroups"]),
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

/** Press the row named `label` on a menu built for this door, and return what ran. */
async function press(label: string, s: SessionSummary, ctx: (calls: Call[]) => SessionMenuCtx, opts: { archive?: ReturnType<typeof sessionArchiveRow>; ok?: boolean } = {}) {
  const calls: Call[] = [];
  const rows = sessionMenuRows(s, ctx(calls), opts.archive === undefined ? sessionArchiveRow(s, {}) : opts.archive, (screen) => calls.push(["show", screen]), acts(calls, opts.ok ?? true));
  const row = [...rows.open, ...rows.title, ...rows.organize].find((r) => r.label === label);
  assert.ok(row, `no row ${label}`);
  assert.equal(row.disabled || "", "", `${label} is off: ${row.disabled}`);
  row.run();
  await flush();
  return { calls, row };
}

const DOORS: [string, (calls: Call[]) => SessionMenuCtx][] = [
  ["the board", (c) => boardDoor(c)],
  ["the sidebar", (c) => sidebarDoor(c)],
];

test("both doors list Sova's rows in the same groups and order, with the same words", () => {
  const s = session({ outlineGist: "Repairs CI", originalTitle: "First message" });
  const shapes = DOORS.map(([, door]) => {
    const r = sessionMenuRows(s, door([]), sessionArchiveRow(s, {}), () => {}, acts([]));
    return JSON.stringify({ open: r.open, title: r.title, organize: r.organize });
  });
  assert.equal(shapes[0], shapes[1]);
  const r = sessionMenuRows(s, boardDoor([]), sessionArchiveRow(s, {}), () => {}, acts([]));
  assert.deepEqual(
    [r.open, r.title, r.organize].map((g) => g.map((x) => x.label)),
    [["Session Details", "Open Subagents"], ["Rename…", "Use Gist as Title", "Reset to Original Title"], ["Move to Group…", "Archive"]],
  );
});

test("Session Details: the board's opens its pane in place; the sidebar's opens the session with its pane on Session", async () => {
  const s = session();
  assert.deepEqual((await press("Session Details", s, (c) => boardDoor(c))).calls, [["board.openDetailsFor", s.path]]);
  assert.deepEqual((await press("Session Details", s, (c) => sidebarDoor(c))).calls, [["route", s.path], ["openPane", s.path, "session"]]);
  // Its pane already shows it there: the row says Close Session Details, and closes it, staying put.
  const open = { path: s.path, tab: "session" as const };
  const calls: Call[] = [];
  const rows = sessionMenuRows(s, sidebarDoor(calls, open), null, () => {}, acts(calls));
  assert.equal(rows.open[0]!.label, "Close Session Details");
  rows.open[0]!.run();
  assert.deepEqual(calls, [["closePane"]]);
  // The pane on another tab: Session Details switches it to Session.
  const other: Call[] = [];
  const onAgents = sessionMenuRows(s, sidebarDoor(other, { path: s.path, tab: "agents" }), null, () => {}, acts(other));
  assert.equal(onAgents.open[0]!.label, "Session Details");
  onAgents.open[0]!.run();
  assert.deepEqual(other, [["route", s.path], ["openPane", s.path, "session"]]);
  // The board says Close while its row's pane is open beside it.
  assert.equal(sessionMenuRows(s, boardDoor([], s.path), null, () => {}, acts([])).open[0]!.label, "Close Session Details");
});

test("Open Subagents: the session, with its pane on the Agents tab, from both doors", async () => {
  const s = session();
  assert.deepEqual((await press("Open Subagents", s, (c) => boardDoor(c))).calls, [["openSubagentsFor", s.path]]);
  assert.deepEqual((await press("Open Subagents", s, (c) => sidebarDoor(c))).calls, [["route", s.path], ["openPane", s.path, "agents"]]);
  const { row } = await press("Open Subagents", s, (c) => sidebarDoor(c));
  assert.equal(row.keepFocus, true, "focus follows the pane, not back to the row");
});

for (const [door, ctx] of DOORS) {
  test(`${door}: Rename… asks inside the menu, and writes nothing yet`, async () => {
    const { calls, row } = await press("Rename…", session(), ctx);
    assert.deepEqual(calls, [["show", "rename"]]);
    assert.equal(row.stayOpen, true, "the menu stays open on its name screen");
  });

  test(`${door}: Use Gist as Title and Reset to Original Title write the title, then refresh the list`, async () => {
    const s = session({ outlineGist: "Repairs CI", originalTitle: "First message" });
    assert.deepEqual((await press("Use Gist as Title", s, ctx)).calls, [["setTitle", s.path, "Repairs CI"], ["refresh"]]);
    assert.deepEqual((await press("Reset to Original Title", s, ctx)).calls, [["setTitle", s.path, null], ["refresh"]]);
    // A write that failed (or changed nothing) doesn't refresh.
    assert.deepEqual((await press("Reset to Original Title", s, ctx, { ok: false })).calls, [["setTitle", s.path, null]]);
  });

  test(`${door}: Move to Group… loads the groups and shows them; off for an organization's session, with the drag's reason`, async () => {
    const { calls, row } = await press("Move to Group…", session(), ctx);
    assert.deepEqual(calls, [["loadGroups"], ["show", "groups"]]);
    assert.equal(row.stayOpen, true);
    const org = sessionMenuRows(session(ORG), ctx([]), null, () => {}, acts([])).organize[0]!;
    assert.equal(org.label, "Move to Group…");
    assert.equal(org.disabled, ORG_GROUP_REASON);
  });

  test(`${door}: Archive archives, then tells the app; Unarchive the other way`, async () => {
    const s = session();
    assert.deepEqual((await press("Archive", s, ctx)).calls, [["setArchived", s.path, true], ["onArchived", s.path, true]]);
    const a = session({ archived: true });
    assert.deepEqual((await press("Unarchive", a, ctx)).calls, [["setArchived", a.path, false], ["onArchived", a.path, false]]);
    assert.deepEqual((await press("Archive", s, ctx, { ok: false })).calls, [["setArchived", s.path, true]], "a refused archive tells nobody");
  });

  test(`${door}: the rows that can't run say why, before the press`, () => {
    const rows = (s: SessionSummary) => {
      const r = sessionMenuRows(s, ctx([]), sessionArchiveRow(s, {}), () => {}, acts([]));
      return Object.fromEntries([...r.open, ...r.title, ...r.organize].map((x) => [x.label, x.disabled || ""]));
    };
    const fresh = rows(session());
    assert.equal(fresh["Use Gist as Title"], "No gist yet.");
    assert.equal(fresh["Reset to Original Title"], "Not renamed.");
    assert.equal(fresh["Move to Group…"], "");
    assert.equal(fresh.Archive, "");
    assert.equal(rows(session({ outlineGist: "Fix the build" }))["Use Gist as Title"], "The gist is already the title.");
  });
}

test("the Archive row: only for what Sova started or archived, busy read as the row reads it", () => {
  const s = session();
  assert.deepEqual(sessionArchiveRow(s, {}), { label: "Archive", blocked: null });
  assert.equal(sessionArchiveRow(session({ origin: "external" } as Partial<SessionSummary>), {}), null, "not started in Sova: no row");
  assert.deepEqual(sessionArchiveRow(session({ origin: "external", archived: true } as Partial<SessionSummary>), {}), { label: "Unarchive", blocked: null });
  // This tab's own run is newer than the list: the sidebar's busy includes it, as its drag does.
  assert.deepEqual(sessionArchiveRow(s, { [s.path]: true }), { label: "Archive", blocked: "Can't archive: mid-turn." });
  assert.deepEqual(sessionArchiveRow(session({ busy: true }), { [s.path]: false }), { label: "Archive", blocked: null }, "this tab saw the turn end");
  assert.deepEqual(sessionArchiveRow(session({ busy: true }), {}), { label: "Archive", blocked: "Can't archive: mid-turn." });
  assert.deepEqual(sessionArchiveRow(session({ live: { pid: 1, status: "idle" } } as Partial<SessionSummary>), {}), { label: "Archive", blocked: "Can't archive: open in a TUI." });
  // The archive row, pressed while blocked, is off: its reason is the row's.
  const rows = sessionMenuRows(s, boardDoor([]), sessionArchiveRow(s, { [s.path]: true }), () => {}, acts([]));
  assert.equal(rows.organize.find((r) => r.label === "Archive")!.disabled, "Can't archive: mid-turn.");
});

test("the rename screen: trimmed, empty restores the derived title, the opened title is a cancel", () => {
  assert.equal(renameValue("Fix the build", "  Better name "), "Better name");
  assert.equal(renameValue("Fix the build", ""), null);
  assert.equal(renameValue("Fix the build", "   "), null);
  assert.equal(renameValue("Fix the build", null), null);
  assert.equal(renameValue("Fix the build", "Fix the build"), undefined, "the title it opened with: no write");
  assert.equal(renameValue("Fix the build", " Fix the build "), undefined);
});

// ---- both doors draw the same menu ----

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const resolve = (s: string) => import.meta.resolve(s);
const { RowMenu, SessionMenuBody } = await importSsr(new URL("../components/SessionRowMenu.tsx", import.meta.url), resolve);
const { MenuPanel } = await importSsr(new URL("../components/ActionMenu.tsx", import.meta.url), resolve);
const { ExtensionsContext } = await import("./reply-place");

const tickets: ExtensionInfo = { id: "tickets", title: "Tickets", status: "ok", offers: { commands: [{ name: "file", label: "File Issue", summary: "Opens an issue for it", menu: "session" }] } };

const draw = (make: () => import("solid-js").JSX.Element, extensions?: ExtensionInfo[]) =>
  renderToString(() =>
    solid.createComponent(ExtensionsContext.Provider, {
      value: () => extensions,
      get children() {
        return make();
      },
    }),
  )
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/<!--[^>]*-->/g, "")
    // An extension group's heading id is generated, and SSR numbers it by nesting depth.
    .replace(/ (id|aria-labelledby)="0[0-9]+"/g, ' $1="…"');
/** The menu list itself: what the panel holds, without the ⋯ trigger. */
const list = (html: string) => html.slice(html.indexOf('<div class="model-menu-list"'));
const row = (s: SessionSummary) => ({ session: s, agent: null, state: "idle", reason: null, word: "Idle", live: false, working: 0, total: 0, teams: [], lastActive: 0 });

const boardMenu = (s: SessionSummary, extensions?: ExtensionInfo[]) =>
  list(draw(() => solid.createComponent(RowMenu as never, { row: row(s), ctx: boardDoor([]), archive: sessionArchiveRow(s, {}) } as never), extensions));
/** The right-click door: the same body in the page's one panel, as ContextMenuHost draws it. */
const contextMenu = (s: SessionSummary, ctx: SessionMenuCtx, extensions?: ExtensionInfo[]) =>
  list(
    draw(
      () =>
        solid.createComponent(MenuPanel as never, {
          anchor: () => ({ kind: "point", x: 0, y: 0 }),
          origin: () => undefined,
          returnFocus: true,
          controls() {},
          children: (menu: unknown) => solid.createComponent(SessionMenuBody as never, { menu, session: s, ctx, archive: sessionArchiveRow(s, {}) } as never),
        } as never),
      extensions,
    ),
  );

test("the board's ⋯, a right-click on a board row and one on a sidebar row draw the same menu", () => {
  for (const s of [session(), session({ outlineGist: "Repairs CI", originalTitle: "First" }), session({ archived: true }), session(ORG), session({ origin: "external" } as Partial<SessionSummary>)]) {
    const board = boardMenu(s);
    assert.ok(board.startsWith('<div class="model-menu-list" role="menu" aria-label="Actions for “'), board.slice(0, 120));
    assert.equal(contextMenu(s, boardDoor([])), board, `board right-click, ${s.title}`);
    assert.equal(contextMenu(s, sidebarDoor([])), board, `sidebar right-click, ${s.title}`);
  }
});

test("what extensions add shows in every door, after Sova's rows", () => {
  const s = session();
  const board = boardMenu(s, [tickets]);
  assert.match(board, /File Issue/);
  assert.equal(contextMenu(s, sidebarDoor([]), [tickets]), board);
  assert.ok(board.indexOf("Copy Path") < board.indexOf("File Issue"));
});

test("an organization's session: Move to Group… is off with the reason in every door", () => {
  const html = contextMenu(session(ORG), sidebarDoor([]));
  assert.match(html, new RegExp(`aria-label="Move “Fix the build” into a group" aria-disabled="true" title="${ORG_GROUP_REASON}"`));
  assert.equal(html, boardMenu(session(ORG)));
});
