// Run: pnpm test -- src/lib/message-menu.test.ts
// The message's right-click menu (§chat.transcript/message-actions "Right-click"): its rows are the
// strip's own items, built by the view's real builder (lib/message-actions `messageItems`, as ChatView
// and WatchView build them), plus exactly Copy as Plain Text after Copy. Each action is pressed from
// the strip's door (its item) and from the menu's door (its row, through the confirm screen for a
// branch action), and what runs is recorded; both are drawn (Solid's SSR build) and compared; and the
// plain text the menu's own row copies.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptItem } from "../../shared/protocol";
import type { MessageActionItem } from "../components/MessageActions";
import { ACTION_CONFIRM, ACTION_LABEL, type ActionState, COPIED, COPY_PLAIN, MENU_LABEL, type MessageItemsView, messageItems, type MessageStrip, REGENERATE_WAKE_REASON, SHARE_WAIT_REASON, stripsByRow } from "./message-actions";
import { confirmRow, confirmScreen, type MessageMenuRow, messageMenuRows, plainMarkdown, plainText, rowAct, stripBlocks } from "./message-menu";

type Call = [string, ...unknown[]];

const IDLE: ActionState = { chat: true, live: false, streaming: false, compacting: false, pending: false, paused: null };
const mine: MessageStrip = { index: 0, entryId: "u1", role: "user", text: "Fix **the** build" };
const reply: MessageStrip = { index: 1, entryId: "a1", role: "assistant", text: "Done. See `ci.yml`." };

/** A chat's view, as ChatView hands it over, with every request recorded. */
function chatView(calls: Call[], over: { state?: Partial<ActionState>; shareId?: string; host?: string | null } = {}): MessageItemsView {
  return {
    shareId: () => ("shareId" in over ? over.shareId : "s-1"),
    host: () => over.host ?? null,
    state: (wake, link, topic, tourNotice) => ({ ...IDLE, ...over.state, wake, link, topic, tourNotice }),
    copy: async (text, done) => void calls.push(["copy", text, done]),
    open: (href) => void calls.push(["open", href]),
    fork: (id) => void calls.push(["fork", id]),
    rewind: (id) => void calls.push(["rewind", id]),
    regenerate: (id) => void calls.push(["regenerate", id]),
  };
}

/** A watch's view, as WatchView hands it over: no requests of its own. */
function watchView(calls: Call[]): MessageItemsView {
  return {
    shareId: () => "s-1",
    host: () => null,
    state: (wake, link, topic, tourNotice) => ({ ...IDLE, chat: false, wake, link, topic, tourNotice }),
    copy: async (text, done) => void calls.push(["copy", text, done]),
    open: (href) => void calls.push(["open", href]),
  };
}

const plainCopier = (calls: Call[]) => () => void calls.push(["copyPlain"]);

const DOORS: [string, (calls: Call[]) => MessageItemsView][] = [
  ["a chat", (c) => chatView(c)],
  ["a watch", (c) => watchView(c)],
];

/** Press `kind` on the strip: its item's own run (a branch action's after its confirm, MessageActions). */
async function pressStrip(kind: string, strip: MessageStrip, view: (calls: Call[]) => MessageItemsView) {
  const calls: Call[] = [];
  const it = messageItems(strip, view(calls)).find((i) => i.kind === kind);
  assert.ok(it && !it.reason, `${kind} is off on the strip: ${it?.reason}`);
  await it.run();
  return calls;
}

/** Press `kind` in the menu: its row, then, for a branch action, the confirm screen's button. */
async function pressMenu(kind: string, strip: MessageStrip, view: (calls: Call[]) => MessageItemsView) {
  const calls: Call[] = [];
  const rows = messageMenuRows(messageItems(strip, view(calls)), plainCopier(calls));
  const row = rows.find((r) => r.kind === kind);
  assert.ok(row && !row.disabled, `${kind} is off in the menu: ${row?.disabled}`);
  const shown: (string | null)[] = [];
  await rowAct(row, (s) => shown.push(s))();
  if (!row.confirm) return { calls, shown };
  assert.deepEqual(shown, [confirmScreen(kind as MessageMenuRow["kind"])], "a branch action asks first");
  assert.deepEqual(calls, [], "and runs nothing yet");
  await confirmRow(rows, shown[0]!)!.run();
  return { calls, shown };
}

test("the menu's rows are the strip's items in order, plus exactly Copy as Plain Text after Copy", () => {
  for (const [door, view] of DOORS) {
    for (const strip of [mine, reply]) {
      const items = messageItems(strip, view([]));
      const rows = messageMenuRows(items, () => {});
      assert.deepEqual(
        rows.map((r) => r.kind),
        [items[0]!.kind, "copy-plain", ...items.slice(1).map((i) => i.kind)],
        `${door}, ${strip.role}`,
      );
      // Each strip row runs the strip's own item, nothing of its own.
      for (const it of items) assert.equal(rows.find((r) => r.kind === it.kind)!.run, it.run);
    }
  }
  const words = (s: MessageStrip) => messageMenuRows(messageItems(s, chatView([])), () => {}).map((r) => r.label);
  assert.deepEqual(words(mine), ["Copy", "Copy as Plain Text", "Share From Here", "Rewind…"]);
  assert.deepEqual(words(reply), ["Copy", "Copy as Plain Text", "Share From Here", "Regenerate…", "Fork From Here"]);
  // Names: the strip button's, and Copy as Plain Text's own.
  const rows = messageMenuRows(messageItems(reply, chatView([])), () => {});
  assert.deepEqual(rows.map((r) => r.aria), [ACTION_LABEL.copy, COPY_PLAIN.aria, ACTION_LABEL.share, ACTION_LABEL.regenerate, ACTION_LABEL.fork]);
  assert.deepEqual(Object.values(MENU_LABEL), ["Copy", "Share From Here", "Rewind…", "Regenerate…", "Fork From Here"]);
});

test("an images-only message: no Copy in the strip, so no Copy as Plain Text in the menu either", () => {
  const images: MessageStrip = { ...mine, text: "  " };
  const rows = messageMenuRows(messageItems(images, chatView([])), () => {});
  assert.deepEqual(rows.map((r) => r.kind), ["share", "rewind"]);
});

for (const [door, view] of DOORS) {
  test(`${door}: Copy copies the message from both doors; Copy as Plain Text only from the menu`, async () => {
    assert.deepEqual(await pressStrip("copy", reply, view), [["copy", reply.text, COPIED]]);
    assert.deepEqual((await pressMenu("copy", reply, view)).calls, [["copy", reply.text, COPIED]]);
    assert.deepEqual((await pressMenu("copy-plain", reply, view)).calls, [["copyPlain"]]);
    assert.equal(messageItems(reply, view([])).some((i) => (i.kind as string) === "copy-plain"), false, "the strip has no such button");
  });

  test(`${door}: Share From Here opens the share page at this message, from both doors`, async () => {
    const href = "#/share/s-1?from=a1";
    assert.deepEqual(await pressStrip("share", reply, view), [["open", href]]);
    assert.deepEqual((await pressMenu("share", reply, view)).calls, [["open", href]]);
  });
}

test("a chat: Rewind… and Regenerate… ask on a screen with the strip's confirm, then send the strip's request", async () => {
  for (const [kind, strip] of [["rewind", mine], ["regenerate", reply]] as const) {
    const fromStrip = await pressStrip(kind, strip, (c) => chatView(c));
    const fromMenu = await pressMenu(kind, strip, (c) => chatView(c));
    assert.deepEqual(fromStrip, [[kind, strip.entryId]]);
    assert.deepEqual(fromMenu.calls, fromStrip);
    const row = messageMenuRows(messageItems(strip, chatView([])), () => {}).find((r) => r.kind === kind)!;
    assert.equal(row.confirm, ACTION_CONFIRM[kind], "the screen says what the strip's armed step says");
  }
  assert.deepEqual(await pressStrip("fork", reply, (c) => chatView(c)), [["fork", "a1"]]);
  assert.deepEqual((await pressMenu("fork", reply, (c) => chatView(c))).calls, [["fork", "a1"]], "Fork abandons nothing: no confirm");
});

test("the rows that can't run say the strip's reason, in both views", () => {
  const reasons = (items: MessageActionItem[]) => {
    const rows = messageMenuRows(items, () => {});
    for (const it of items) assert.equal(rows.find((r) => r.kind === it.kind)!.disabled, it.reason ?? undefined, it.kind);
    assert.equal(rows.find((r) => r.kind === "copy-plain")?.disabled, rows.find((r) => r.kind === "copy")?.disabled);
    return Object.fromEntries(rows.map((r) => [r.kind, r.disabled ?? ""]));
  };
  const streaming = reasons(messageItems(reply, chatView([], { state: { streaming: true } })));
  assert.deepEqual(streaming, { copy: "", "copy-plain": "", share: "", regenerate: "Stop the current turn first.", fork: "Stop the current turn first." });
  const watched = reasons(messageItems(mine, watchView([])));
  assert.equal(watched.rewind, "Only a chat open in Sova can rewind.");
  assert.equal(reasons(messageItems(reply, chatView([], { shareId: undefined }))).share, SHARE_WAIT_REASON);
  assert.equal(reasons(messageItems({ ...reply, fromWake: true }, chatView([]))).regenerate, REGENERATE_WAKE_REASON);
});

test("a confirm screen gives way once its action can't run, and never runs another row", () => {
  const calls: Call[] = [];
  const ok = messageMenuRows(messageItems(mine, chatView(calls)), () => {});
  assert.equal(confirmRow(ok, confirmScreen("rewind"))?.kind, "rewind");
  assert.equal(confirmRow(ok, confirmScreen("copy")), undefined, "Copy asks nothing");
  assert.equal(confirmRow(ok, null), undefined);
  const busy = messageMenuRows(messageItems(mine, chatView(calls, { state: { streaming: true } })), () => {});
  assert.equal(confirmRow(busy, confirmScreen("rewind")), undefined, "a turn started: the rows again, with the reason");
  // An off row's press runs nothing (the menu's Item answers with its reason, as the strip's button does).
  assert.ok(busy.find((r) => r.kind === "rewind")!.disabled);
});

// ---- the plain text ----

const row = (id: string, kind: string, text?: string) => ({ id, kind, text }) as unknown as TranscriptItem;

test("the message's blocks: your message's one row, or every text block of the reply, never its tool calls", () => {
  const rows = [row("u1", "user", "Go"), row("a1:0", "assistant-text", "First"), row("a1:1", "tool-call"), row("a1:2", "assistant-text", "Second"), row("a1:stop", "info")];
  const strips = [...stripsByRow(rows).values()];
  assert.deepEqual(stripBlocks(rows, strips[0]!), [{ id: "u1", text: "Go", markdown: false }]);
  assert.deepEqual(stripBlocks(rows, strips[1]!), [
    { id: "a1:0", text: "First", markdown: true },
    { id: "a1:2", text: "Second", markdown: true },
  ]);
  // Older rows arrived above while the menu was open: the strip's index is stale, its entry isn't.
  const older = [row("u0", "user", "Earlier"), row("a0:0", "assistant-text", "Before"), ...rows];
  assert.deepEqual(stripBlocks(older, strips[0]!).map((b) => b.id), ["u1"]);
  assert.deepEqual(stripBlocks(older, strips[1]!).map((b) => b.id), ["a1:0", "a1:2"]);
});

test("plain text: each block as drawn, else its source without Markdown's marks, joined as Copy joins them", () => {
  const blocks = [
    { id: "a1:0", text: "**Bold** start", markdown: true },
    { id: "a1:2", text: "Then [the docs](https://example.com) and `code`", markdown: true },
  ];
  assert.equal(plainText(blocks, (id) => (id === "a1:0" ? "Bold start\n" : null)), "Bold start\n\nThen the docs and code");
  // Your message isn't Markdown: its source is already what you read.
  assert.equal(plainText([{ id: "u1", text: "a *b* c", markdown: false }], () => null), "a *b* c");
  assert.equal(plainText([{ id: "u1", text: "a *b* c", markdown: false }], () => "drawn"), "drawn");
});

test("Markdown without its marks: code keeps its text, links collapse to their words, lists keep their bullets and numbers", () => {
  const src = [
    "# Title",
    "",
    "Some *emphasis*, __strong__ and `inline code`, a [link](https://x.dev) and ![a chart](c.png).",
    "",
    "> quoted",
    "",
    "- one",
    "- two",
    "  1. nested",
    "",
    "3. three",
    "4. four",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |",
  ].join("\n");
  assert.equal(
    plainMarkdown(src),
    [
      "Title",
      "",
      "Some emphasis, strong and inline code, a link and a chart.",
      "",
      "quoted",
      "",
      "• one\n• two\n  1. nested",
      "",
      "3. three\n4. four",
      "",
      "const x = 1;",
      "",
      "A\tB\n1\t2",
    ].join("\n"),
  );
});

// ---- both doors drawn ----

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const resolve = (s: string) => import.meta.resolve(s);
const { ReplyPlaceView } = await importSsr(new URL("../components/ReplyPlace.tsx", import.meta.url), resolve);
const { MessageMenuBody } = await importSsr(new URL("../components/MessageMenu.tsx", import.meta.url), resolve);
const { MenuPanel } = await importSsr(new URL("../components/ActionMenu.tsx", import.meta.url), resolve);
const { stripLabel } = await import("./message-actions");

const html = (make: () => import("solid-js").JSX.Element) =>
  renderToString(make)
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/<!--[^>]*-->/g, "");
const attr = (tag: string, name: string) => tag.match(new RegExp(` ${name}="([^"]*)"`))?.[1];
/** What each control says: its name, and its reason when it is off. */
const said = (markup: string, open: RegExp) => [...markup.matchAll(open)].map((m) => ({ aria: attr(m[0], "aria-label"), off: attr(m[0], "aria-disabled") ? attr(m[0], "title") : undefined }));

const placeFor = (view: MessageItemsView) => ({ builtIns: [{ id: "sova.message-actions", items: (s: MessageStrip) => messageItems(s, view) }] });
const strip = (s: MessageStrip, view: MessageItemsView) => html(() => solid.createComponent(ReplyPlaceView as never, { place: placeFor(view), strip: s } as never));
const menu = (s: MessageStrip, view: MessageItemsView, screen: string | null = null) =>
  html(() =>
    solid.createComponent(MenuPanel as never, {
      anchor: () => ({ kind: "point", x: 0, y: 0 }),
      origin: () => undefined,
      returnFocus: true,
      controls() {},
      children: (api: { show(s: string | null): void }) => {
        api.show(screen);
        return solid.createComponent(MessageMenuBody as never, { menu: api, label: stripLabel(s.role), items: messageItems(s, view), copyPlain() {} } as never);
      },
    } as never),
  );

test("drawn, the menu says what the strip says, row for row, plus Copy as Plain Text", () => {
  const views: [string, MessageItemsView][] = [
    ["a chat", chatView([])],
    ["a busy chat", chatView([], { state: { streaming: true } })],
    ["a watch", watchView([])],
  ];
  for (const [name, view] of views) {
    for (const s of [mine, reply]) {
      const buttons = said(strip(s, view), /<button[^>]* class="button button-icon button-ghost message-action"[^>]*>/g);
      const drawn = menu(s, view);
      const rows = said(drawn, /<div[^>]* role="menuitem"[^>]*>/g);
      assert.ok(buttons.length >= 3, `${name}: the strip drew its buttons`);
      assert.deepEqual(rows, [buttons[0], { aria: COPY_PLAIN.aria, off: undefined }, ...buttons.slice(1)], `${name}, ${s.role}`);
      assert.match(drawn, new RegExp(`role="menu" aria-label="${stripLabel(s.role)}"`));
    }
  }
});

test("drawn, the confirm screen is the strip's: its sentence, said to its button, then Cancel", () => {
  for (const [kind, s] of [["rewind", mine], ["regenerate", reply]] as const) {
    const drawn = menu(s, chatView([]), confirmScreen(kind));
    const { label, note } = ACTION_CONFIRM[kind]!;
    assert.doesNotMatch(drawn, /role="menuitem"/, "the rows gave way");
    const noteId = drawn.match(/<p class="group-tools-question" id="([^"]+)">/)?.[1];
    assert.ok(noteId && drawn.includes(`>${note}</p>`), drawn);
    assert.match(drawn, new RegExp(`class="button button-sm button-destructive" aria-describedby="${noteId}"[^>]*>${label}</button>`));
    assert.match(drawn, />Cancel<\/button>/);
  }
  // Off now: the screen isn't drawn; the rows are, with the reason.
  const busy = menu(mine, chatView([], { state: { streaming: true } }), confirmScreen("rewind"));
  assert.match(busy, /aria-label="Rewind to before this message" aria-disabled="true" title="Stop the current turn first\."/);
});
