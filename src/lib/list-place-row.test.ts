// Run: pnpm test -- src/lib/list-place-row.test.ts
// The owner mark on a session row (§app.extensions/list-place): with no declaration, or a row the
// declaration's key doesn't name, every row is exactly session-row.snapshot.json's; with one, the
// owner's 2 letters stand first on the meta line, on this host's rows and a peer's alike, yours
// highlighted, as plain text that is no control. Drawn as src/lib/session-row.test.ts draws it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { SessionRow } = await importSsr(new URL("../components/Sidebar.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
const mesh = await import("./mesh");
const { OwnerContext, ownerOf, validateListAnswer } = await import("./list-place");
type SessionSummary = import("../../shared/protocol").SessionSummary;
type OwnerOfRow = import("./list-place").OwnerOfRow;

const SNAPSHOT = JSON.parse(readFileSync(new URL("./session-row.snapshot.json", import.meta.url), "utf8")) as Record<string, string>;
const NOW = Date.parse("2026-02-01T02:00:00.000Z");
const session = (over: Partial<SessionSummary> = {}): SessionSummary =>
  ({
    id: "s-1",
    path: "/state/sessions/a.jsonl",
    cwd: "/work/a",
    title: "Fix the build",
    createdAt: "2026-02-01T00:00:00.000Z",
    lastActiveAt: "2026-02-01T00:00:00.000Z",
    model: "anthropic/claude-opus-5",
    ...over,
  }) as SessionSummary;
mesh.noteHost("/peer/sessions/owned.jsonl", "peer-1");

const decl = validateListAnswer(
  {
    people: [
      { id: "kim", name: "Kim Ortega", initials: "KO", callers: ["operator"] },
      { id: "lee", name: "Lee Varga", initials: "LV", callers: ["peer:node-lee"] },
    ],
    ownerKey: "owner",
    self: "kim",
  },
  { id: "team-bar", title: "Team bar" },
).answer!;
/** The pane's reader while the declaration exists (Sidebar's ownerOfRow). */
const declared: OwnerOfRow = (s) => {
  const person = ownerOf(decl, s);
  return person ? { person, self: person.id === decl.self } : undefined;
};

const drawRow = (s: SessionSummary, place?: OwnerOfRow): string =>
  renderToString(() => {
    const row = () => solid.createComponent(SessionRow as never, { session: s, selected: null, now: NOW, targets: [] } as never);
    return (
      place
        ? solid.createComponent(OwnerContext.Provider, {
            value: place,
            get children() {
              return row() as never;
            },
          })
        : row()
    ) as never;
  })
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/<!--[^>]*-->/g, "");

const MARK = (cls: string, id: string, title: string, letters: string, words: string) =>
  `<div class="list-line list-meta-row"><span class="${cls}" data-person-id="${id}" title="${title}"><span aria-hidden="true">${letters}</span><span class="visually-hidden">${words}</span></span>`;

test("no declaration, or no owner label the declaration names: the row is exactly the snapshot's", () => {
  assert.equal(drawRow(session()), SNAPSHOT.plain);
  assert.equal(drawRow(session(), declared), SNAPSHOT.plain, "a declaration, and an unlabelled row");
  assert.equal(drawRow(session({ labels: { other: { owner: "lee" } } }), declared), SNAPSHOT.plain, "another extension's label is not the owner");
  assert.equal(drawRow(session({ labels: { "team-bar": { team: "lee" } } }), declared), SNAPSHOT.plain, "another key is not the owner");
  assert.equal(drawRow(session({ labels: { "team-bar": { owner: "zed" } } }), declared), SNAPSHOT.plain, "a person it doesn't name has no mark");
  assert.equal(drawRow(session({ labels: { "team-bar": { owner: "lee" } } })), SNAPSHOT.plain, "labels alone, with no declaration, draw nothing");
});

test("the owner's 2 letters stand first on the meta line, yours highlighted, and the rest of the row is unchanged", () => {
  const lees = drawRow(session({ labels: { "team-bar": { owner: "lee" } } }), declared);
  const mark = MARK("owner-mark", "lee", "Lee Varga", "LV", "Lee Varga's. ");
  assert.ok(lees.includes(mark), lees);
  assert.equal(lees.replace(mark, '<div class="list-line list-meta-row">'), SNAPSHOT.plain, "only the mark is added");
  const mine = drawRow(session({ labels: { "team-bar": { owner: "kim" } } }), declared);
  assert.ok(mine.includes(MARK("owner-mark owner-mark-self", "kim", "Kim Ortega (you)", "KO", "Yours. ")), mine);
  // Never a control: the row is the link.
  assert.doesNotMatch(lees.slice(lees.indexOf("owner-mark"), lees.indexOf("list-meta\"")), /<button|<a[\s>]|onclick|href=/i);
});

test("a peer's row shows its owner too, read by this computer's key", () => {
  const peer = drawRow(session({ id: "s-p", path: "/peer/sessions/owned.jsonl", labels: { "team-bar": { owner: "lee" } } }), declared);
  assert.match(peer, /<div class="list-line list-meta-row"><span class="owner-mark" data-person-id="lee" title="Lee Varga">/);
  // Its host mark follows the owner.
  assert.ok(peer.indexOf("owner-mark") < peer.indexOf("session-host"), peer);
});
