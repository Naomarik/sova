// Run: pnpm test -- src/lib/session-row-menu.test.ts
// The Agents board row's ⋯ menu (§app.insights/team-cards, §app.extensions/session-menu): Sova's own
// items keep their groups, order, labels and names. Drawn with Solid's SSR build
// (src/lib/align-card-ssr.mjs) and compared with session-row-menu.snapshot.json, taken from the menu
// as it stood before extensions could add to it. Hydration keys and marker comments are left out:
// they say how Solid drew it, not what the page holds. Regenerate only for a change you mean:
// WRITE_MENU_SNAPSHOT=1 pnpm test -- src/lib/session-row-menu.test.ts
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { RowMenu } = await importSsr(new URL("../components/SessionRowMenu.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
const { ExtensionsContext } = await import("./reply-place");
const { isSovaName, SESSION_MENU_NAMES } = await import("./menu-place");
const mesh = await import("./mesh");
type ExtensionInfo = import("../../shared/protocol").ExtensionInfo;
type BoardRow = import("./agents-board").BoardRow;
type SessionSummary = import("../../shared/protocol").SessionSummary;

const SNAPSHOT = new URL("./session-row-menu.snapshot.json", import.meta.url);

const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id: "s-1",
    path: "/state/sessions/a.jsonl",
    cwd: "/work/a",
    title: "Fix the build",
    createdAt: "2026-02-01T00:00:00.000Z",
    lastActiveAt: "2026-02-01T00:00:00.000Z",
    model: null,
    ...over,
  }) as SessionSummary;
const row = (s: SessionSummary): BoardRow => ({ session: s, agent: null, state: "idle", reason: null, word: "Idle", live: false, working: 0, total: 0, teams: [], lastActive: 0 });
const ctx = (detailsPath: string | null = null) => ({
  setRenaming() {},
  onRefresh() {},
  onArchiveChanged() {},
  onOpenSubagents() {},
  detailsPath,
  onOpenDetails() {},
});

/** The menu's markup, without Solid's hydration keys and marker comments, with the page's
    extension list as App provides it. */
const drawMenu = (props: Record<string, unknown>, extensions?: ExtensionInfo[]): string =>
  renderToString(() =>
    solid.createComponent(ExtensionsContext.Provider, {
      value: () => extensions,
      get children() {
        return solid.createComponent(RowMenu as never, props as never);
      },
    }),
  )
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/<!--[^>]*-->/g, "");

const CASES: Record<string, Record<string, unknown>> = {
  plain: { row: row(session()), ctx: ctx(), href: "#/s/a", archive: { label: "Archive", blocked: null } },
  "renamed, with a gist, details open": {
    row: row(session({ title: "Mine", originalTitle: "Fix the build", outlineGist: "Repairs CI" })),
    ctx: ctx("/state/sessions/a.jsonl"),
    href: "#/s/a",
    archive: { label: "Unarchive", blocked: null },
  },
  "archive blocked": { row: row(session({ outlineGist: "Fix the build" })), ctx: ctx(), href: "#/s/a", archive: { label: "Archive", blocked: "A TUI has it open." } },
  "no archive": { row: row(session()), ctx: ctx(), href: "#/h/peer/s/a", archive: null },
};

test("Sova's own items in the session ⋯ menu are drawn exactly as before", () => {
  const got = Object.fromEntries(Object.entries(CASES).map(([name, props]) => [name, drawMenu(props)]));
  if (process.env.WRITE_MENU_SNAPSHOT === "1") writeFileSync(SNAPSHOT, `${JSON.stringify(got, null, 2)}\n`);
  const want = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(got), Object.keys(want));
  for (const name of Object.keys(want)) assert.equal(got[name], want[name], name);
});

test("the snapshot holds every item, in order", () => {
  const html = drawMenu(CASES.plain!);
  const labels = [...html.matchAll(/<span class="popover-item-label">([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ["Open Session", "Session Details", "Open Subagents", "Rename…", "Use Gist as Title", "Reset to Original Title", "Move to Group…", "Archive", "Copy Path"]);
  const groups = [...html.matchAll(/role="group" aria-label="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(groups, ["Open", "Title", "Organize"]);
});

// ---- what extensions add ------------------------------------------------------------------------

const tickets: ExtensionInfo = {
  id: "tickets",
  title: "Tickets",
  status: "ok",
  offers: { commands: [{ name: "file", label: "File Issue", summary: "Opens an issue for it", menu: "session" }, { name: "cli-only", label: "CLI Only" }] },
};
const notes: ExtensionInfo = { id: "notes", title: "Notes", status: "ok", offers: { commands: [{ name: "pin", label: "Pin Note", menu: "session" }] } };
/** Extensions that declare nothing for the menu: commands only, the reply place only, nothing. */
const noMenu: ExtensionInfo[] = [
  { id: "plain", title: "Plain", status: "ok" },
  { id: "cli", title: "CLI", status: "ok", offers: { commands: [{ name: "x", label: "X" }] } },
  { id: "reply", title: "Reply", status: "ok", offers: { commands: [{ name: "y", label: "Y" }], screens: ["reply"] } },
];
const labels = (html: string) => [...html.matchAll(/<span class="popover-item-label">([^<]*)<\/span>/g)].map((m) => m[1]);

test("with no extension entry to show, the menu is exactly the snapshot's", () => {
  const want = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, string>;
  for (const list of [undefined, [], noMenu, [{ ...tickets, status: "down" as const }]]) assert.equal(drawMenu(CASES.plain!, list), want.plain, JSON.stringify(list));
});

test("a session on another host shows no extension rows: an extension is this host's", () => {
  const { noteHost } = mesh;
  noteHost("/peer/sessions/b.jsonl", "peer");
  const remote = { row: row(session({ path: "/peer/sessions/b.jsonl" })), ctx: ctx(), href: "#/h/peer/s/b", archive: null };
  assert.equal(drawMenu(remote, [tickets, notes]), drawMenu(remote, []));
  assert.ok(drawMenu({ ...remote, row: row(session()) }, [tickets]).includes("File Issue"), "the same session on this host does");
});

test("extension rows come after every one of Sova's items, one group per extension, headed by its title", () => {
  const html = drawMenu(CASES.plain!, [tickets, notes]);
  assert.deepEqual(labels(html), ["Open Session", "Session Details", "Open Subagents", "Rename…", "Use Gist as Title", "Reset to Original Title", "Move to Group…", "Archive", "Copy Path", "File Issue", "Pin Note"]);
  const groups = [...html.matchAll(/role="group" aria-label="([^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(groups, ["Open", "Title", "Organize"], "Sova's groups, named by aria-label");
  // Each extension group is named by its visible heading.
  const heads = [...html.matchAll(/role="group" aria-labelledby="([^"]+)"><div class="list-group-label" id="([^"]+)">([^<]*)<\/div>/g)];
  assert.deepEqual(heads.map((m) => m[3]), ["Tickets", "Notes"]);
  for (const m of heads) assert.equal(m[1], m[2], "the group is labelled by its own heading");
  assert.notEqual(heads[0]![1], heads[1]![1], "each heading has its own id");
  const want = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, string>;
  const sova = want.plain!.slice(0, want.plain!.lastIndexOf("</div></div></div>"));
  assert.ok(html.startsWith(sova), "Sova's items are drawn exactly as before, ahead of everything extensions add");
});

test("a row names its extension in its tooltip and its accessible name, and shows its summary", () => {
  const html = drawMenu(CASES.plain!, [tickets]);
  assert.match(html, /<div class="list-group-label" id="[^"]+">Tickets<\/div>/);
  assert.doesNotMatch(html, /popover-label/);
  assert.match(html, /aria-label="File Issue for “Fix the build” · From Tickets"/);
  assert.match(html, /title="File Issue · From Tickets"/);
  assert.match(html, /<span class="popover-item-desc">Opens an issue for it<\/span>/);
  assert.doesNotMatch(html, /CLI Only/, "a command not declared for the menu stays out of it");
});

test("a backend that is down hides its rows; the others stay", () => {
  const html = drawMenu(CASES.plain!, [{ ...tickets, status: "down", error: "connection refused" }, notes]);
  assert.deepEqual(labels(html).slice(-2), ["Copy Path", "Pin Note"]);
});

test("every label Sova's own items draw is one an extension entry may not take", () => {
  const want = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, string>;
  const drawn = new Set(Object.values(want).flatMap(labels));
  assert.ok(drawn.has("Close Session Details") && drawn.has("Unarchive"), "the snapshot cases draw both forms of the switching items");
  for (const label of drawn) assert.ok(isSovaName(label!), `${label} is in SESSION_MENU_NAMES`);
  assert.equal(new Set(SESSION_MENU_NAMES).size, SESSION_MENU_NAMES.length);
});

test("an extension entry named like one of Sova's items is left out of the menu", () => {
  const imitators: ExtensionInfo = {
    id: "imit",
    title: "Imit",
    status: "ok",
    offers: { commands: [...SESSION_MENU_NAMES.map((label, i) => ({ name: `c${i}`, label, menu: "session" as const })), { name: "ok", label: "Real One", menu: "session" }] },
  };
  const html = drawMenu(CASES.plain!, [imitators]);
  assert.deepEqual(labels(html).slice(-2), ["Copy Path", "Real One"]);
  assert.equal(labels(html).filter((l) => l === "Copy Path").length, 1);
});
