// The Transport agent card's one action row (§app.transport/agent, words in §design.copy-deck): its order, its words,
// and its one primary, over every state the card has.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { carriesOn, openAppHref, transportCardActions } from "./transport-card-actions";

type At = Parameters<typeof transportCardActions>[0];
const none: At = { downloads: null, commands: [], hostValues: false, href: null };
const row = (a: Partial<At>) =>
  transportCardActions({ ...none, ...a }).map((x) => `${x.label}${x.primary ? "*" : ""}`);

describe("the action row", () => {
  test("working or ready: Open Agent Chat alone, never primary; nothing at all without its chat", () => {
    assert.deepEqual(row({ href: "/s/x" }), ["Open Agent Chat"]);
    assert.deepEqual(row({}), []);
  });

  test("every answer comes before Open Agent Chat, in one row, and only the first is primary", () => {
    assert.deepEqual(row({ downloads: "dl_1", commands: ["ad_1"], hostValues: true, href: "/s/x" }), ["Allow Downloads*", "Done", "Save Values", "Open Agent Chat"]);
    assert.deepEqual(row({ commands: ["ad_1"], href: "/s/x" }), ["Done*", "Open Agent Chat"]);
    assert.deepEqual(row({ hostValues: true }), ["Save Values*"]);
  });

  test("with more than one command, each Done names its command, so no two buttons read the same", () => {
    const labels = row({ commands: ["ad_1", "ad_2"] });
    assert.deepEqual(labels, ["Done With Command 1*", "Done With Command 2"]);
    assert.equal(new Set(labels).size, labels.length);
  });

  test("each answer carries the id it answers", () => {
    const acts = transportCardActions({ ...none, downloads: "dl_1", commands: ["ad_1", "ad_2"] });
    assert.deepEqual(acts.map((a) => ("id" in a ? a.id : null)), ["dl_1", "ad_1", "ad_2"]);
  });
});

describe("Open App and the outside file", () => {
  const running = { state: "running" as const, copies: [{ entry: { port: 4100, path: "/app" } }] };
  test("Open App links to the running copy's entry page only once the card reads Ready and the copy runs", () => {
    assert.equal(openAppHref({ ready: true, copy: running, host: "air.local" }), "http://air.local:4100/app");
    assert.equal(openAppHref({ ready: false, copy: running, host: "air.local" }), null, "not Ready: no link");
    for (const state of ["waiting", "starting", "failed", "none"] as const) assert.equal(openAppHref({ ready: true, copy: { state, copies: running.copies }, host: "h" }), null, state);
    assert.equal(openAppHref({ ready: true, copy: { state: "running", copies: [{}] }, host: "h" }), null, "no entry page declared: no link");
    assert.equal(openAppHref({ ready: true, copy: null, host: "h" }), null);
  });

  test("on Ready Open App is the row's primary, before Open Agent Chat; with an answer waiting it isn't", () => {
    assert.deepEqual(row({ app: "http://h:1/", href: "/s/x" }), ["Open App*", "Open Agent Chat"]);
    assert.deepEqual(row({ app: "http://h:1/", hostValues: true }), ["Save Values*", "Open App"]);
  });

  test("a file outside the project: Bring From {device} first and primary, then I Placed It Myself; several are numbered", () => {
    assert.deepEqual(row({ files: [{ id: "of_1", from: "Desk" }], href: "/s/x" }), ["Bring From Desk*", "I Placed It Myself", "Open Agent Chat"]);
    const labels = row({ files: [{ id: "of_1", from: "Desk" }, { id: "of_2", from: "Desk" }] });
    assert.deepEqual(labels, ["Bring File 1 From Desk*", "I Placed File 1", "Bring File 2 From Desk", "I Placed File 2"]);
    assert.equal(new Set(labels).size, labels.length);
    const acts = transportCardActions({ ...none, files: [{ id: "of_1", from: "Desk" }] });
    assert.deepEqual(acts.map((a) => ("id" in a ? `${a.kind}:${a.id}` : a.kind)), ["bring:of_1", "placed:of_1"]);
  });
});

describe("after an answer you gave", () => {
  test("\"The agent carries on.\" follows it only while the card reads Working: never at Ready or Needs you", () => {
    assert.equal(carriesOn("working"), " The agent carries on.");
    for (const st of ["ready", "needs-you"] as const) assert.doesNotMatch(`Allowed from nodejs.org.${carriesOn(st)}`, /carries on/);
  });
});
