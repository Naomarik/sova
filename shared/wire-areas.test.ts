// Run: pnpm test -- shared/wire-areas.test.ts. The ratchet (§mesh.compatibility/declare-a-change) and
// the one reading of a host (§mesh.compatibility/states).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { areaShapes, shapeHash, shapeProgram, shapeText } from "../server/testing/wire-shape";
import manifest from "./wire-areas.json" with { type: "json" };
import { AREA_IDS, type AreaId, behindOn, hostState, peerRefusal, readAreas, WIRE_AREAS, type WireAreas, writingRefusal } from "./wire-areas";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(join(ROOT, file), "utf8");

type Entry = { version: number; shape: string; compatible: { shape: string; note: string }[] };
const entries = manifest as Record<AreaId, Entry>;
/** The shape an area's manifest stands at: its last compatible note's, else the one its number began with. */
const declared = (e: Entry): string => e.compatible.at(-1)?.shape ?? e.shape;

/** `file` with `from` replaced, failing when `from` isn't there (the edit must really happen). */
function edited(file: string, from: string, to: string): Map<string, string> {
  const text = source(file);
  assert.ok(text.includes(from), `${file} no longer has: ${from}`);
  return new Map([[file, text.replace(from, to)]]);
}

const instructions = (area: AreaId, now: string) =>
  `The format of area "${area}" changed (shape ${declared(entries[area])} → ${now}). Nothing decides this for you. Declare it in shared/wire-areas.json:\n` +
  `- compatible (an older reader still reads it correctly): keep "version", add to "compatible" {"shape": "${now}", "note": "what changed and why old readers cope"}.\n` +
  `- breaking: raise "version", set "shape" to "${now}", empty "compatible", remove the old format's code in this same change, and replace the area's saved samples.`;

describe("the ratchet", () => {
  test("every area's format is the one its manifest declares", () => {
    const now = areaShapes();
    for (const area of AREA_IDS) assert.equal(now[area], declared(entries[area]), instructions(area, now[area]));
  });

  test("a compatible change names what it did", () => {
    for (const area of AREA_IDS) for (const c of entries[area].compatible) assert.ok(c.note.trim().length >= 12 && /^[0-9a-f]{16}$/.test(c.shape), `${area}: a compatible entry needs its shape and a note`);
  });

  // The check must tell the two states apart: each edit below is a real one to a real source.
  const FIELD: Array<[AreaId, string, string, string]> = [
    ["sessions", "shared/protocol.ts", "export interface MeshSessions {", "export interface MeshSessions {\n  added: string;"],
    ["transcript", "shared/harness-wire.ts", "export interface RowFacts {", "export interface RowFacts {\n  added: string;"],
    ["composer", "shared/protocol.ts", `| { type: "abort" }`, `| { type: "abort"; why: string }`],
    ["peer", "shared/mesh-links.ts", "export interface PeerLinkMessage {", "export interface PeerLinkMessage {\n  added: string;"],
    // Types reached only through an import: an import the compiler lost would read as `any` and hide this.
    ["peer", "server/sync/logins-merge.ts", "export interface KeyRecord {", "export interface KeyRecord {\n  added: string;"],
    ["peer", "server/extensions.ts", "export interface ExtensionEntry {", "export interface ExtensionEntry {\n  added: string;"],
    ["composer", "server/chat-actions.ts", `| { type: "abort" }`, `| { type: "abort"; why: string }`],
  ];
  const baseline = areaShapes();
  for (const [area, file, from, to] of FIELD) {
    test(`a real format change fails: ${file} moves "${area}"`, () => assert.notEqual(areaShapes(edited(file, from, to))[area], baseline[area]));
  }

  test("a comment, a reordered field or a renamed parameter changes nothing", () => {
    assert.deepEqual(areaShapes(edited("shared/protocol.ts", `| { type: "abort" }`, `// Stop, reworded.\n  /** And again. */\n  | { type: "abort" }`)), baseline);
    const swap = (fields: string) => shapeHash(shapeText(shapeProgram(["x.ts"], new Map([["x.ts", `export interface T {\n${fields}\n}`]])), [["x.ts", "T"]]));
    assert.equal(swap("a: string;\nb?: number;"), swap("// note\nb?: number;\n/** doc */ a: string;"));
    assert.notEqual(swap("a: string;"), swap("a: number;"));
    assert.notEqual(swap("a: string;"), swap("a?: string;"));
    assert.notEqual(swap("a: 'x' | 'y';"), swap("a: 'x';"));
  });

  test("recursive and generic shapes finish and differ", () => {
    const of = (text: string) => shapeHash(shapeText(shapeProgram(["x.ts"], new Map([["x.ts", text]])), [["x.ts", "T"]]));
    assert.notEqual(of("export interface T { next?: T; a: string }"), of("export interface T { next?: T; a: number }"));
    assert.notEqual(of("export type T = { kids: T[] } | string;"), of("export type T = { kids: T[] } | number;"));
    assert.notEqual(of("interface B<X> { v: X } export interface T { a: B<string>; b: B<number> }"), of("interface B<X> { v: X } export interface T { a: B<string>; b: B<string> }"));
  });
});

const areas = (over: Partial<WireAreas> = {}): WireAreas => ({ sessions: 1, transcript: 1, composer: 1, peer: 1, ...over });

describe("the one reading of a host", () => {
  test("the first line that is true decides, whichever side is higher", () => {
    const own = areas({ sessions: 2, transcript: 2, composer: 2, peer: 2 });
    const same = { ...own };
    const read = (over: Partial<WireAreas>) => hostState(own, { state: "up", areas: { ...same, ...over } });
    assert.equal(read({}), "works");
    assert.equal(read({ composer: 1 }), "read-only");
    assert.equal(read({ composer: 3 }), "read-only");
    assert.equal(read({ transcript: 1 }), "display");
    assert.equal(read({ transcript: 3, composer: 1 }), "display");
    assert.equal(read({ sessions: 1 }), "update");
    assert.equal(read({ peer: 3 }), "update");
    assert.equal(read({ peer: 1, transcript: 1, composer: 1 }), "update");
  });

  test("a host that lists none is judged by its fingerprint's state", () => {
    assert.equal(hostState(WIRE_AREAS, { state: "skewed" }), "update");
    assert.equal(hostState(WIRE_AREAS, { state: "up" }), "works");
  });

  test("a host that doesn't answer keeps its state", () => {
    for (const state of ["down", "refused", "hidden"]) assert.equal(hostState(WIRE_AREAS, { state, areas: WIRE_AREAS }), null);
  });

  test("behindOn names the lower number", () => {
    assert.equal(behindOn("composer", areas({ composer: 2 }), areas()), "theirs");
    assert.equal(behindOn("composer", areas(), areas({ composer: 2 })), "own");
    assert.equal(behindOn("composer", areas(), areas()), null);
  });

  test("a list that isn't one reads as none, and a later area doesn't blind this build", () => {
    assert.equal(readAreas(undefined), undefined);
    assert.equal(readAreas("1"), undefined);
    assert.equal(readAreas({ sessions: 1, transcript: 1, composer: 1 }), undefined);
    assert.equal(readAreas({ ...areas(), peer: 0 }), undefined);
    assert.equal(readAreas({ ...areas(), peer: "1" }), undefined);
    assert.deepEqual(readAreas({ ...areas(), later: 4 }), areas());
  });
});

describe("the refusal", () => {
  test("the same number passes, whatever it is", () => {
    assert.equal(writingRefusal("1", 1, "vps"), null);
    assert.equal(writingRefusal("7", 7, "vps"), null);
  });
  test("a sender behind is told to reload, one ahead that the host needs an update", () => {
    assert.match(writingRefusal("1", 2, "vps")!, /Reload the page/);
    assert.match(writingRefusal("3", 2, "vps")!, /^Vps needs an update/);
    assert.match(writingRefusal("3", 2, "this host")!, /^This host needs an update/);
  });
  test("no number passes at the first version and is asked to reload after it (q8)", () => {
    for (const none of [undefined, null, "", "x", "0", "-1", "1.5"]) {
      assert.equal(writingRefusal(none, 1, "vps"), null);
      assert.match(writingRefusal(none, 2, "vps")!, /Reload the page/);
    }
  });
  test("a host that lists no areas states no host-to-host number and stays as it was", () => {
    assert.equal(peerRefusal(undefined, 2, "vps"), null);
    assert.equal(peerRefusal("2", 2, "vps"), null);
    assert.match(peerRefusal("1", 2, "vps")!, /sending host needs an update/);
    assert.match(peerRefusal("3", 2, "vps")!, /^Vps needs an update/);
  });
});
