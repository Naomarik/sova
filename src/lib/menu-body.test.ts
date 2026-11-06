// Run: pnpm test -- src/lib/menu-body.test.ts
// The one menu body (components/MenuPlace.tsx), drawn with Solid's SSR build (src/lib/align-card-ssr.mjs):
// every place's ⋯ and its right-click draw the same declaration, a menu named as its ⋯ is; and the
// three screens a row opens are the same everywhere: the one name box (its box, hint, Save and
// Cancel), the one question (its sentence said to its button, then Cancel), a list of rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionInfo, SessionGroup, SessionSummary } from "../../shared/protocol";
import type { MessageActionItem } from "../components/MessageActions";
import type { CodingRow } from "./coding-worktrees";
import { GROUP_MENU } from "./group-menu";
import { MESSAGE_MENU } from "./message-menu";
import type { MenuDecl } from "./menu-place";
import { PANE_MENU, type PaneMenuWiring } from "./pane-menu";
import { SESSION_MENU, sessionArchiveRow } from "./session-menu";
import { WORKTREE_MENU } from "./worktree-menu";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const resolve = (s: string) => import.meta.resolve(s);
const { MenuBody, PlaceMenu } = await importSsr(new URL("../components/MenuPlace.tsx", import.meta.url), resolve);
const { MenuPanel } = await importSsr(new URL("../components/ActionMenu.tsx", import.meta.url), resolve);
const { ExtensionsContext } = await import("./reply-place");

const draw = (make: () => unknown, extensions?: ExtensionInfo[]) =>
  renderToString(() => solid.createComponent(ExtensionsContext.Provider, { value: () => extensions, get children() { return make(); } } as never))
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/<!--[^>]*-->/g, "")
    .replace(/ (id|for|aria-labelledby|aria-describedby)="[^"]*"/g, ' $1="…"');
/** What the panel holds, without the ⋯ trigger. */
const inner = (html: string) => html.slice(html.indexOf('popover="auto">') + 'popover="auto">'.length);
/** The ⋯ door. */
const dots = <T,>(decl: MenuDecl<T>, subject: T, extensions?: ExtensionInfo[]) => inner(draw(() => solid.createComponent(PlaceMenu, { decl, subject, title: "Actions" } as never), extensions));
/** The right-click door: the same body in the page's one panel, as ContextMenuHost draws it, on `screen`. */
const door = <T,>(decl: MenuDecl<T>, subject: T, screen: string | null = null, extensions?: ExtensionInfo[]) =>
  inner(
    draw(
      () =>
        solid.createComponent(MenuPanel, {
          anchor: () => ({ kind: "point", x: 0, y: 0 }),
          origin: () => undefined,
          returnFocus: true,
          controls() {},
          children: (menu: { show(s: string | null): void }) => {
            menu.show(screen);
            return solid.createComponent(MenuBody, { menu, decl, subject } as never);
          },
        } as never),
      extensions,
    ),
  );

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const P = "/state/sessions/a.jsonl";
const session = (over: Partial<SessionSummary> = {}) => ({ id: "s-1", path: P, cwd: "/w", title: "Fix the build", createdAt: "", lastActiveAt: "", model: null, origin: "web", ...over }) as SessionSummary;
const ctx = { detailsPath: null, onOpenDetails() {}, onOpenSubagents() {}, onRefresh() {}, onArchiveChanged() {} };
const sessionMenu = (s = session()) => ({ session: s, ctx, archive: sessionArchiveRow(s, {}) });
const groupMenu = (count = 2) => ({ group: { id: "g-1", name: "Work" } as SessionGroup, count, onChanged() {} });
const w = { nameOf: () => "Tests", groupName: () => "Work", split: () => true, panes: () => [P], labelOf: () => null, running: () => false, href: () => "#", resize() {}, move() {}, focusPane() {}, rename() {}, detach() {}, promote() {} } as PaneMenuWiring;
const item = (kind: MessageActionItem["kind"], reason: string | null = null): MessageActionItem => ({ kind, reason, run() {} });
const reply = (reason: string | null = null) => ({ strip: { index: 3, entryId: "e1", role: "assistant" as const, text: "hi" }, items: [item("copy"), item("share"), item("regenerate", reason), item("fork")], copyPlain() {} });
const worktree = { facts: { project: "p-1", row: { sessionId: "c-1", branch: "sova/x", target: "master", worktree: "/wt/x", head: "abc" } as CodingRow, title: "Fix it", gestures: { merge: "" as const, remove: "" as const }, queued: false, queue: undefined, working: false }, acts: { merge() {}, land() {}, remove() {} } };

const PLACES: [string, MenuDecl<never>, unknown][] = [
  ["session", SESSION_MENU as MenuDecl<never>, sessionMenu()],
  ["group", GROUP_MENU as MenuDecl<never>, groupMenu()],
  ["pane", PANE_MENU as MenuDecl<never>, { path: P, summary: session(), w }],
  ["message", MESSAGE_MENU as MenuDecl<never>, reply()],
  ["worktree", WORKTREE_MENU as MenuDecl<never>, worktree],
];

test("every place's ⋯ and its right-click draw the same menu, named as its ⋯ is", () => {
  for (const [place, decl, subject] of PLACES) {
    const menu = door(decl, subject as never);
    assert.equal(dots(decl, subject as never), menu, place);
    assert.ok(menu.startsWith(`<div class="model-menu-list" role="menu" aria-label="${decl.label(subject as never)}">`), `${place}: ${menu.slice(0, 90)}`);
  }
  // Named sections are groups; bare rows aren't; an empty section isn't drawn at all.
  assert.deepEqual([...door(SESSION_MENU, sessionMenu(session({ fixedName: "project-overseer" } as Partial<SessionSummary>))).matchAll(/role="group" aria-label="([^"]*)"/g)].map((m) => m[1]), ["Open", "Organize"]);
  assert.doesNotMatch(door(GROUP_MENU, groupMenu()), /role="group"/);
  assert.match(door(GROUP_MENU, groupMenu()), /<a class="popover-item " role="menuitem" tabindex="0" aria-label="Open “Work” as a workspace"[^>]*href="#\/g\/g-1">/);
});

test("the one name box: the box named for what it renames, its hint, then Save and Cancel, in every menu", () => {
  const boxes: [string, string, RegExp][] = [
    [door(SESSION_MENU, sessionMenu(), "Rename…"), "Rename “Fix the build”", /maxlength="\d+" placeholder="Session title"[^>]* value="Fix the build"/],
    [door(GROUP_MENU, groupMenu(), "Rename…"), "Rename “Work”", /maxlength="60" placeholder="Group name"[^>]* value="Work"/],
    [door(PANE_MENU, { path: P, summary: session(), w }, "Rename…"), "Name Tests", /maxlength="40" placeholder="Tests"[^>]* value=""/],
  ];
  for (const [html, name, input] of boxes) {
    assert.doesNotMatch(html, /role="menuitem"/, `${name}: the rows gave way`);
    assert.match(html, new RegExp(`^<form class="group-menu-screen" aria-label="${name}"><div class="field"><label class="visually-hidden" for="…">${name}</label><input class="input "`), html);
    assert.match(html, input, name);
    assert.match(html, /<div class="cluster"><button type="submit" class="button button-sm">Save<\/button><button type="button" class="button button-sm button-ghost">Cancel<\/button><\/div><\/form><\/div>$/, name);
  }
  assert.match(boxes[0]![0], /<span class="field-hint" id="…">Kept in Sova only\. Empty restores “Fix the build”\.<\/span>/);
  assert.doesNotMatch(boxes[1]![0], /field-hint/, "the group's box has no hint");
  assert.match(boxes[2]![0], /<span class="field-hint" id="…">Empty clears the label — the pane shows the title again\.<\/span>/);
});

test("the one question: its sentence said to its button, then Cancel; gone once its row can't run", () => {
  for (const [html, name, note, label] of [
    [door(GROUP_MENU, groupMenu(0), "Delete group…"), "Delete “Work”", "Delete “Work”? Nothing is in it.", "Delete group"],
    [door(MESSAGE_MENU, reply(), "Regenerate…"), "Regenerate this reply", "", "Regenerate Here"],
  ]) {
    assert.doesNotMatch(html!, /role="menuitem"/);
    assert.match(html!, new RegExp(`^<div class="group-menu-screen" role="group" aria-label="${name}"><p class="group-tools-question" id="…">${note ? esc(note) : "[^<]+"}</p>`), html);
    assert.match(html!, new RegExp(`<button type="button" class="button button-sm button-destructive" aria-describedby="…">${label}</button><button type="button" class="button button-sm button-ghost">Cancel</button>`));
  }
  // A turn started while it asked: the rows, the row off with its reason.
  const busy = door(MESSAGE_MENU, reply("Stop the current turn first."), "Regenerate…");
  assert.match(busy, /role="menuitem" tabindex="0" aria-label="Regenerate this reply" aria-disabled="true" title="Stop the current turn first\."/);
});

test("a list of rows in place of the menu's own: Move to Group…", () => {
  const html = door(SESSION_MENU, sessionMenu(), "Move to Group…");
  assert.match(html, /^<div class="model-menu-list" role="menu" aria-label="Move to group"><div class="model-menu-group" role="group" aria-label="Groups"><div class="list-group-label">Groups<\/div><div class="popover-item " role="menuitem" tabindex="0" aria-label="Take “Fix the build” out of its group" >/);
});

test("extension entries come after Sova's rows, only in a menu place and only for this host's thing", () => {
  const ext: ExtensionInfo = { id: "t", title: "Tickets", status: "ok", offers: { commands: [{ name: "f", label: "File Issue", menu: "session" }] } };
  const html = door(SESSION_MENU, sessionMenu(), null, [ext]);
  assert.ok(html.indexOf("File Issue") > html.indexOf("Copy Path"));
  assert.match(html, /aria-label="File Issue for “Fix the build” · From Tickets"/);
  for (const [place, decl, subject] of PLACES.slice(1)) assert.equal(door(decl, subject as never, null, [ext]), door(decl, subject as never), `${place} is no menu place yet`);
});
