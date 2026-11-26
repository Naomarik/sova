// Run: pnpm test -- src/lib/list-place-rule.test.ts
// The rule (AGENTS.md "Commands and extensibility"), for the list place (src/lib/list-place.ts,
// §app.extensions/list-place) and the row-chips amendment (§app.extensions/row-chips): the page asks
// for a declaration in one place, once per list, never per row; Sova draws the owner mark and the
// person menu itself, once each, from the declaration's data, never as markup or a control on the
// row; and a chat's labels are read in one place only, through the key this computer's declaration
// names, so a peer's label is never drawn for its own sake. Read from the source, so a second asker,
// a label read beside the declaration, or a clickable mark fails here.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const walk = (dir: string, ext: RegExp): string[] =>
  readdirSync(join(root, dir), { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name), ext) : ext.test(d.name) && !d.name.includes(".test.") ? [join(dir, d.name)] : [],
  );
const files = walk(".", /\.tsx?$/).map((f) => ({ f, src: readFileSync(join(root, f), "utf8") }));
const src = (f: string) => files.find((x) => x.f === f)!.src;
const using = (tag: string) => files.filter((x) => new RegExp(`<${tag}[\\s>]`).test(x.src)).map((x) => x.f).sort();

test("one lane for the whole page, made by App; nothing else asks the list place", () => {
  const makers = files.filter((x) => /\bcreateListPlace\(/.test(x.src)).map((x) => x.f);
  assert.deepEqual(makers.sort(), ["App.tsx", "lib/list-place.ts"]);
  assert.equal(src("App.tsx").match(/\bcreateListPlace\(/g)?.length, 1);
  const askers = files.filter((x) => /screenPath\("list"\)|screens\/list/.test(x.src)).map((x) => x.f);
  assert.deepEqual(askers, ["lib/list-place.ts"]);
  // The one path it asks: no session in it.
  assert.match(src("lib/list-place.ts"), /fetch\(`\/ext\/\$\{encodeURIComponent\(id\)\}\$\{screenPath\("list"\)\}`,/);
  // Its pacing, timeout, mute and switch are the row place's lane, not a copy.
  assert.match(src("lib/list-place.ts"), /createPlaceAnswers\(policy, validateListAnswer,/);
  assert.doesNotMatch(src("lib/list-place.ts"), /\bsetTimeout\(|\bsetInterval\(/);
});

test("the owner mark is drawn once, on the row, and the person menu once, in the foot, both Sova's own", () => {
  assert.deepEqual(using("OwnerMark"), ["components/ListPlace.tsx", "components/Sidebar.tsx"]);
  assert.equal(src("components/Sidebar.tsx").match(/<OwnerMark[\s>]/g)?.length, 1);
  assert.deepEqual(using("PersonMenu"), ["components/Sidebar.tsx"]);
  assert.equal(src("components/Sidebar.tsx").match(/<PersonMenu[\s>]/g)?.length, 1);
  // Both stand only while a declaration exists.
  // A row makes its slot only under the owner context, which the pane provides only while there is one.
  assert.match(src("components/Sidebar.tsx"), /const ownerSlot = owners \? <Show when=\{owners\(s\(\)\)\}>\{\(o\) => <OwnerMark /);
  assert.match(src("components/Sidebar.tsx"), /<Show when=\{hasDeclaration\(\)\} fallback=\{<ListBody \/>\}>\s*<OwnerContext\.Provider value=\{ownerOfRow\}>/);
  assert.equal(files.filter((x) => /<OwnerContext\.Provider[\s>]/.test(x.src)).map((x) => x.f).join(), "components/Sidebar.tsx");
  assert.match(src("components/Sidebar.tsx"), /<Show when=\{listPlace\.declaration\(\)\}>\{\(d\) => <PersonMenu /);
  // The mark is no control and no markup: the row is the link.
  const place = src("components/ListPlace.tsx");
  const mark = place.slice(place.indexOf("export function OwnerMark"), place.indexOf("/** The gap the panel"));
  assert.doesNotMatch(mark, /innerHTML|onClick|href=|<button[\s>]|<a[\s>]|tabindex/);
  assert.doesNotMatch(place, /innerHTML|outerHTML|insertAdjacentHTML|<iframe/);
});

test("a chat's labels are read only through the local declaration's key (the row-chips amendment)", () => {
  const readers = files.filter((x) => /\.labels\?\.\[/.test(x.src)).map((x) => x.f);
  assert.deepEqual(readers, ["lib/list-place.ts"], "nothing on the page reads row.labels except the list place");
  assert.match(src("lib/list-place.ts"), /s\.labels\?\.\[decl\.ownerExt\]\?\.\[decl\.ownerKey\]/);
  // Today's answered chips stay this host's only.
  assert.match(src("lib/row-place.ts"), /return chips && hostOf\(s\.path\) === null \? chips : undefined;/);
});

test("the person filter narrows the host filter's pool, in the same memo, and leaves it whole without a choice", () => {
  const side = src("components/Sidebar.tsx");
  const pool = side.slice(side.indexOf("const hostPool = createMemo("), side.indexOf("const hits = createMemo("));
  assert.match(pool, /passesHostFilter\(h, s\.path\)/);
  assert.match(pool, /if \(p === null\) return pool;/);
  assert.match(pool, /passesPersonFilter\(d, p, s\)/);
  assert.equal(side.match(/passesPersonFilter\(/g)?.length, 1);
});

test("labels ride on the row reads only through lib/labels-ask", () => {
  const api = src("lib/api.ts");
  assert.match(api, /withLabels\("\/api\/sessions"\)/);
  assert.match(api, /withLabels\("\/api\/mesh\/sessions"\)/);
  assert.match(src("lib/session-feed.ts"), /createReconnectingSocket<SessionFeedMessage>\(\(\) => withLabels\(url\)/);
  const setters = files.filter((x) => /\bsetLabelsAsk\b/.test(x.src)).map((x) => x.f).sort();
  assert.deepEqual(setters, ["lib/labels-ask.ts", "lib/list-place.ts"], "the list place alone says which labels the page reads");
});
