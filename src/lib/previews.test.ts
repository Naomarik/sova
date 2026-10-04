// Run: pnpm exec tsx --test src/lib/previews.test.ts. The Previews card's words and checks.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PreviewView } from "../../shared/preview-links";
import {
  activePreviews,
  DELETE_ALL_TIP,
  DELETE_CONFIRM,
  deleteFailed,
  deleteLabel,
  deleteNote,
  parsePort,
  PREVIEW_DELETED,
  previewGroups,
  previewWarning,
  RECIPIENT_DELETE_LABEL,
  recipientDeleteConfirm,
  recipientDeleted,
  recipientDeleteName,
  recipientDeleteNote,
  recipientDeleteTip,
  recipientName,
  runningLine,
  sentToLine,
  turnOffConfirm,
} from "./previews";

const view = (over: Partial<PreviewView>): PreviewView => ({
  id: "pv_aaaaaaaaaaaaaaaa",
  projectId: "p",
  port: 5173,
  createdAt: "2026-09-30T00:00:00.000Z",
  expiresAt: "2026-10-01T00:00:00.000Z",
  createdBy: "operator",
  state: "active",
  ...over,
});

test("the warning names the port, and a placeholder while none is typed", () => {
  assert.equal(previewWarning(5173), "Anyone with this link can use the app on port 5173 as if they were on this computer, including its logins, admin pages and anything it can change.");
  assert.match(previewWarning(null), /on port N as if/);
});

test("running line: the app answers, or nothing on its port", () => {
  assert.equal(runningLine(view({ running: true })), "App is running");
  assert.equal(runningLine(view({ running: false, port: 3000 })), "Nothing on port 3000");
});

test("only active previews are listed, longest-lived first", () => {
  const list = [
    view({ id: "a", expiresAt: "2026-10-01T00:00:00.000Z" }),
    view({ id: "b", state: "off" }),
    view({ id: "c", state: "expired" }),
    view({ id: "d", expiresAt: "2026-10-20T00:00:00.000Z" }),
  ];
  assert.deepEqual(activePreviews(list).map((v) => v.id), ["d", "a"]);
});

test("the port field: whole numbers 1–65535, never Sova's own defaults", () => {
  assert.deepEqual(parsePort(" 5173 "), { port: 5173 });
  for (const bad of ["", "abc", "0", "65536", "51.73", "-1"]) assert.ok("error" in parsePort(bad), bad);
  for (const own of ["4800", "4801", "4802", "4810"]) assert.match((parsePort(own) as { error: string }).error, /Sova's own/);
});

test("a person's own link sits under its original, not on a row of its own", () => {
  const list = [
    view({ id: "orig", expiresAt: "2026-10-03T00:00:00.000Z" }),
    view({ id: "karim", siblingOf: "orig", sentTo: "p_t", sentToName: "Karim", createdAt: "2026-09-30T02:00:00.000Z", expiresAt: "2026-10-03T00:00:00.000Z" }),
    view({ id: "sara", siblingOf: "orig", sentTo: "p_s", sentToName: "Sara", createdAt: "2026-09-30T01:00:00.000Z", expiresAt: "2026-10-03T00:00:00.000Z" }),
    // Turned off: not a recipient.
    view({ id: "undone", siblingOf: "orig", sentTo: "p_t", sentToName: "Karim", state: "off" }),
    view({ id: "other", expiresAt: "2026-10-02T00:00:00.000Z" }),
  ];
  const groups = previewGroups(list);
  assert.deepEqual(
    groups.map((g) => [g.preview.id, g.recipients.map((r) => r.id)]),
    [
      ["orig", ["sara", "karim"]],
      ["other", []],
    ],
  );
});

test("a sibling whose original isn't listed keeps its own row, still saying who it went to", () => {
  const list = [
    view({ id: "gone-orig", state: "off" }),
    view({ id: "orphan", siblingOf: "gone-orig", sentTo: "p_t", sentToName: "Karim" }),
    view({ id: "lost", siblingOf: "pv_never_listed", sentTo: "p_s" }),
  ];
  const groups = previewGroups(list);
  assert.deepEqual(groups.map((g) => [g.preview.id, g.recipients.length]).sort(), [["lost", 0], ["orphan", 0]]);
  assert.equal(sentToLine(groups.find((g) => g.preview.id === "orphan")!.preview), "sent to Karim");
  assert.equal(recipientName({ sentToName: "  " }), "a person");
});

test("the original's Turn Off confirm counts every link it ends", () => {
  assert.equal(turnOffConfirm(0), "Turn Off Preview?");
  assert.equal(turnOffConfirm(2), "Turn Off All 3 Links?");
});

test("the card's Delete names its scope: the preview with its recipients' links, or one person's link", () => {
  assert.equal(deleteLabel(0), "Delete Preview");
  assert.equal(deleteLabel(1), "Delete Preview + 1 Link");
  assert.equal(deleteLabel(3), "Delete Preview + 3 Links");
  assert.equal(DELETE_ALL_TIP, "Deletes this preview and every link sent from it.");
  assert.equal(RECIPIENT_DELETE_LABEL, "Delete Link");
  assert.equal(recipientDeleteName("Fatoom Wife"), "Delete Fatoom Wife's Link");
  assert.equal(recipientDeleteTip("Fatoom Wife"), "Deletes only Fatoom Wife's link.");
});

test("a Delete's second click says the link ends for good, and the app keeps running", () => {
  assert.equal(DELETE_CONFIRM, "Delete for Good?");
  assert.equal(deleteNote(0), "The link stops working for good. Your app keeps running; make a New Preview to share it again.");
  assert.equal(deleteNote(1), "This link and the 1 sent from it stop working for good. Your app keeps running; make a New Preview to share it again.");
  assert.equal(recipientDeleteConfirm("Fatoom Wife"), "Delete Fatoom Wife's Link for Good?");
  assert.equal(recipientDeleteNote("Fatoom Wife"), "Fatoom Wife's link stops working for good.");
});

test("a Delete's done and failed toasts", () => {
  assert.equal(PREVIEW_DELETED, "Preview deleted.");
  assert.equal(recipientDeleted("Fatoom Wife"), "Fatoom Wife's link deleted.");
  assert.equal(deleteFailed("Not found."), "Couldn't delete it. Not found.");
});
