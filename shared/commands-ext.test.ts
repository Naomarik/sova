// Run: pnpm test -- shared/commands-ext.test.ts
// Extensions' own actions (§app.commands/extension-commands): the manifest's `commands` key as the
// command line reads it. Ids always under ext.<id>., bad commands left out alone.
import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMANDS } from "./commands-catalog";
import { extCommand, extCommandsOf } from "./commands-ext";

const doc = (extensions: unknown[]) => ({ version: 1, extensions });
const good = { name: "snap", label: "Take Snapshot", summary: "Saves a snapshot", params: { note: { type: "string", description: "A note" }, count: { type: "integer", required: true } } };

test("a valid command becomes ext.<id>.<name>, a POST through the proxy", () => {
  const [e] = extCommandsOf(doc([{ id: "notes", commands: [good] }]));
  assert.equal(e!.id, "ext.notes.snap");
  assert.equal(e!.extension, "notes");
  assert.equal(e!.effect, "changes");
  assert.deepEqual(e!.route, { method: "POST", path: "/ext/notes/api/commands/snap" });
  assert.deepEqual(e!.params, { note: { type: "string", description: "A note", in: "body" }, count: { type: "integer", description: "", in: "body", required: true } });
});

test("bad commands are left out alone; the rest of the extension stays", () => {
  const bad = [
    { name: "Bad Name", label: "x" },
    { name: "x".repeat(49), label: "x" },
    { name: "no-label" },
    { name: "long-label", label: "x".repeat(49) },
    { name: "ctl", label: "a\u0007b" },
    { name: "bad-type", label: "x", params: { a: { type: "date" } } },
    { name: "reserved", label: "x", params: { url: { type: "string" } } },
    { name: "bad-param", label: "x", params: { "A!": { type: "string" } } },
    { name: "list-params", label: "x", params: [] },
    "not an object",
  ];
  const got = extCommandsOf(doc([{ id: "e1", commands: [...bad, good, { ...good, label: "Second Snap" }] }]));
  assert.deepEqual(got.map((c) => `${c.id} ${c.label}`), ["ext.e1.snap Take Snapshot"]);
  for (const b of bad) assert.equal(extCommand("e1", b), null, JSON.stringify(b));
});

test("entries: a bad id and a second entry with a taken id are left out; no commands is none", () => {
  const got = extCommandsOf(doc([{ id: "../x", commands: [good] }, { id: "a", commands: [good] }, { id: "a", commands: [{ ...good, name: "other" }] }, { id: "b" }, { id: "c", commands: "x" }]));
  assert.deepEqual(got.map((c) => c.id), ["ext.a.snap"]);
  for (const d of [null, {}, { version: 2, extensions: [] }, { version: 1, extensions: {} }, "x"]) assert.deepEqual(extCommandsOf(d), []);
});

test("no extension can take a core id", () => {
  const core = new Set(COMMANDS.map((c) => c.id));
  // An extension named after a core namespace still lands under ext.
  for (const c of extCommandsOf(doc([{ id: "session", commands: [{ name: "archive", label: "Archive" }] }]))) {
    assert.ok(c.id.startsWith("ext.session."));
    assert.equal(core.has(c.id), false);
  }
});
