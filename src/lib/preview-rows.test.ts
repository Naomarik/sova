// Run: pnpm exec tsx --test src/lib/preview-rows.test.ts. The Previews card's rows.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PREVIEW_NOT_KEPT, type PreviewView } from "../../shared/preview-links";
import { makerLine, previewRow, previewTitle, stateLine } from "./preview-rows";

const NOW = Date.parse("2026-09-30T00:00:00.000Z");
const view = (over: Partial<PreviewView>): PreviewView => ({
  id: "pv_aaaaaaaaaaaaaaaa",
  orgId: "o",
  projectId: "p",
  port: 5173,
  createdAt: "2026-09-29T00:00:00.000Z",
  expiresAt: "2026-10-07T00:00:00.000Z",
  createdBy: "operator",
  state: "active",
  ...over,
});

test("a port preview the overseer made for a recorded session reads in full", () => {
  const row = previewRow(
    view({
      target: { kind: "port", port: 3000 },
      running: true,
      url: "https://abc.preview.example.com/",
      purpose: "Checkout redesign",
      sessionId: "01a0-sess",
      sessionTitle: "Redo the checkout",
      branch: "feat/checkout",
      sessionFrom: "recorded",
      createdBy: "session:01a0-over",
    }),
    NOW,
  );
  assert.deepEqual(row, {
    title: "Checkout redesign",
    session: { title: "Redo the checkout", href: "sova://s/01a0-sess" },
    branch: "feat/checkout",
    serves: "app on port 3000",
    matched: false,
    maker: { text: "Made by the overseer", href: "sova://s/01a0-over" },
    state: { text: "Serving", tone: "ok" },
    expires: "Expires in 7 days",
    url: "https://abc.preview.example.com/",
    linkNote: null,
  });
});

test("a folder preview: static files, matched by its folder, and not served now", () => {
  const row = previewRow(view({ target: { kind: "static", folder: "dist" }, running: false, sessionId: "s1", sessionFrom: "worktree" }), NOW);
  assert.equal(row.serves, "static files");
  assert.equal(row.matched, true);
  assert.deepEqual(row.state, { text: "Folder not served", tone: "warn" });
  assert.equal(row.title, "Preview of dist");
  // A session id with no title still links.
  assert.deepEqual(row.session, { title: "Coding session", href: "sova://s/s1" });
});

test("a preview from before the extended list reads as its port, with no link kept", () => {
  const row = previewRow(view({ running: false }), NOW);
  assert.equal(row.title, "Preview of port 5173");
  assert.equal(row.serves, "app on port 5173");
  assert.deepEqual(row.state, { text: "Nothing on port 5173", tone: "warn" });
  assert.equal(row.session, null);
  assert.equal(row.branch, null);
  assert.deepEqual(row.maker, { text: "Made by you", href: null });
  assert.equal(row.url, null);
  assert.equal(row.linkNote, PREVIEW_NOT_KEPT);
});

test("the link this page minted is copyable even when the list keeps none", () => {
  assert.deepEqual(previewRow(view({ url: null }), NOW, "https://x.example/").url, "https://x.example/");
});

test("a blank purpose falls back; the worktree folder is named, not '.'", () => {
  assert.equal(previewTitle(view({ purpose: "  " })), "Preview of port 5173");
  assert.equal(previewTitle(view({ target: { kind: "static", folder: "." } })), "Preview of the worktree");
});

test("maker: you, the overseer's conversation, or unknown", () => {
  assert.deepEqual(makerLine("operator"), { text: "Made by you", href: null });
  assert.deepEqual(makerLine("session:abc"), { text: "Made by the overseer", href: "sova://s/abc" });
  assert.equal(makerLine("something-else"), null);
});

test("state follows running, for a port and a folder alike", () => {
  assert.deepEqual(stateLine(view({ running: true, target: { kind: "static", folder: "out" } })), { text: "Serving", tone: "ok" });
  assert.deepEqual(stateLine(view({ running: false, port: 8080 })), { text: "Nothing on port 8080", tone: "warn" });
});
