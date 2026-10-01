import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import { PREVIEWS } from "./previews.fixture";
import { BLOCKS, MAX_BLOCKS, MAX_DEPTH, MAX_ROWS, SYNONYMS, TAUGHT, type WBlock, type WireframeSpec } from "./parse";

const parse = (body: string) => {
  const r = parseVis("wireframe", body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return { spec: r.spec as WireframeSpec, warnings: r.warnings.map((w) => `${w.line}: ${w.message}`) };
};
const ok = (body: string) => {
  const { spec, warnings } = parse(body);
  assert.deepEqual(warnings, [], "draws without warnings");
  return spec;
};
const err = (body: string) => {
  const r = parseVis("wireframe", body);
  assert.equal(r.ok, false, "a hard error");
  return r as { line: number; message: string };
};
/** A block's shape without its bookkeeping: type, texts, and whatever else is set. */
const shape = (b: WBlock): unknown[] => [b.type, b.texts, ...(["tag", "tone", "on", "wide", "chart", "items", "current", "value", "to", "toName"] as const).filter((k) => b[k] !== undefined).map((k) => ({ [k]: b[k] })), ...(b.children.length ? [b.children.map(shape)] : [])];
const top = (s: WireframeSpec, i = 0) => s.screens[i]!.blocks.map(shape);

test("wireframe: one screen needs no screen line; indentation nests, any width", () => {
  const s = ok('header "Inbox"\n  icon "search"\nlist\n    item "Maria" "Q3 budget" "9:41"\n    item "Ops"\nbutton "Compose" accent');
  assert.equal(s.screens.length, 1);
  assert.equal(s.screens[0]!.name, undefined);
  assert.equal(s.device, "phone");
  assert.deepEqual(top(s), [
    ["header", ["Inbox"], [["icon", ["search"]]]],
    ["list", [], [["item", ["Maria", "Q3 budget", "9:41"]], ["item", ["Ops"]]]],
    ["button", ["Compose"], { tone: "accent" }],
  ]);
  // Keys: s<screen>.<path>, the emphasis keys.
  assert.deepEqual(s.screens[0]!.blocks[1]!.children.map((b) => b.key), ["s0.1.0", "s0.1.1"]);
});

test("wireframe: the nearest less-indented line is the parent (Python-style), so uneven indents still nest", () => {
  const s = ok("card \"A\"\n   row\n     button \"x\"\n   text \"under A\"\ntext \"top\"");
  assert.deepEqual(top(s), [["card", ["A"], [["row", [], [["button", ["x"]]]], ["text", ["under A"]]]], ["text", ["top"]]]);
});

test("wireframe: screens, devices and the default device", () => {
  const s = ok('device: desktop\nscreen "Home"\ntext "a"\nscreen "Phone view" phone\ntext "b"\nscreen "Web" mobile\ntext "c"');
  assert.deepEqual(s.screens.map((x) => [x.name, x.device, x.key]), [["Home", "desktop", "s0"], ["Phone view", "phone", "s1"], ["Web", "phone", "s2"]]);
  // Device synonyms map silently; blocks indented under a screen line are still that screen's.
  assert.equal(ok("device: web\ntext \"x\"").device, "desktop");
  assert.equal(ok("device: tablet\ntext \"x\"").device, "desktop");
  assert.deepEqual(top(ok('screen "A"\n  header "A"\n    icon "back"\n  text "x"')), [["header", ["A"], [["icon", ["back"]]]], ["text", ["x"]]]);
});

test("wireframe: == Name == starts a screen, and a screen line right after it names the same screen", () => {
  const s = ok('== Before ==\nscreen "Orders"\ntext "a"\n== After ==\ntext "b"');
  assert.deepEqual(s.screens.map((x) => x.name), ["Before · Orders", "After"]);
  // A screen line after a section that already has blocks is a new screen.
  assert.deepEqual(ok('== A ==\ntext "a"\nscreen "B"\ntext "b"').screens.map((x) => x.name), ["A", "B"]);
});

test("wireframe: -> names the screen a tap opens: exact, then a prefix, then its number", () => {
  const s = ok('screen "Invoices"\nitem "No. 1" -> "Invoice detail"\nbutton "Pay" -> "3"\nscreen "Invoice detail"\ntext "x"\nscreen "Paid"\nlink "Back" -> invoices');
  assert.equal(s.screens[0]!.blocks[0]!.to, 1);
  assert.equal(s.screens[0]!.blocks[1]!.to, 2);
  assert.equal(s.screens[2]!.blocks[0]!.to, 0, "bare words, any case");
  assert.equal(ok('screen "Cart"\nbutton "Checkout" -> "Checkout"\nscreen "Checkout — shipping"\ntext "x"').screens[0]!.blocks[0]!.to, 1, "a prefix of the name");
  // A screen line may carry the arrow; so may a line of two quoted screen names.
  const t = ok('screen "A" -> "B"\ntext "a"\nscreen "B"\ntext "b"\n"B" -> "A"');
  assert.equal(t.screens[0]!.to, 1);
  assert.equal(t.screens[1]!.to, 0);
});

test("wireframe: an arrow to a screen not drawn is a chip with no warning; one to its own screen is dropped with one", () => {
  const { spec, warnings } = parse('screen "A"\nbutton "Edit" -> "Edit profile"\nbutton "Stay" -> "A"\nscreen "B"\ntext "x"\n"A" -> "Nowhere"');
  assert.deepEqual(top(spec), [["button", ["Edit"], { toName: "Edit profile" }], ["button", ["Stay"]]]);
  assert.deepEqual(warnings, ['3: -> "A" points at its own screen, dropped', '6: no screen "Nowhere", arrow dropped']);
});

test("wireframe: a lone -> line: the block above at its indent or less opens the screen; before any block, the screen does", () => {
  const s = ok('screen "A"\n-> "C"\nlist\n  item "x"\n    -> "B"\nbutton "Go"\n-> "B"\nscreen "B"\ntext "b"\nscreen "C"\ntext "c"');
  assert.equal(s.screens[0]!.to, 2);
  assert.equal(s.screens[0]!.blocks[0]!.children[0]!.to, 1, "indented under the item: the item's");
  assert.equal(s.screens[0]!.blocks[1]!.to, 1, "at the button's indent: the button's");
  // A block that already has an arrow passes the next one to its screen.
  const t = ok('screen "A"\nbutton "Go" -> "B"\n-> "C"\nscreen "B"\ntext "b"\nscreen "C"\ntext "c"');
  assert.deepEqual([t.screens[0]!.blocks[0]!.to, t.screens[0]!.to], [1, 2]);
  // Before any screen or block there is nothing to carry it.
  assert.deepEqual(parse('-> "B"\ntext "x"').warnings, ["1: -> needs a block or screen before it and a screen name after it, ignored"]);
});

// Parsing only: that the View draws a chip for each is the browser check's (no DOM here).
test("wireframe: every block word parses its arrow, and a table row keeps its own blocks, their arrows and marks", () => {
  for (const w of BLOCKS) {
    const s = ok(`screen "A"\n${w} "x" -> "B"\nscreen "B"\ntext "b"`);
    assert.equal(s.screens[0]!.blocks[0]!.to, 1, w);
  }
  const t = ok('screen "A"\ntable "A, B"\n  item "Alpha" "Beta"\n    badge "Important" -> "B"\nmark "Important" "kept"\nscreen "B"\ntext "b"');
  const row = t.screens[0]!.blocks[0]!.children[0]!;
  assert.deepEqual(row.children.map(shape), [["badge", ["Important"], { to: 1 }]]);
  assert.deepEqual(t.emphasis!.map((e) => e.key), [row.children[0]!.key]);
});

test("wireframe: a prefix names a screen only when one other screen has it; its own screen's prefix is a screen not drawn", () => {
  // "Invoice" is a prefix of the item's own screen "Invoices": a chip for a screen not drawn, no warning.
  const s = ok('screen "Invoices"\nlist\n  item "Invoice no." -> "Invoice"');
  assert.deepEqual(s.screens[0]!.blocks[0]!.children.map(shape), [["item", ["Invoice no."], { toName: "Invoice" }]]);
  // Two screens share the prefix: a chip, with a warning, never the first one silently.
  const { spec, warnings } = parse('screen "Home"\nbutton "Go" -> "Details"\nscreen "Details basic"\ntext "x"\nscreen "Details advanced"\ntext "y"');
  assert.deepEqual(top(spec), [["button", ["Go"], { toName: "Details" }]]);
  assert.deepEqual(warnings, ['2: -> "Details" matches several screens; drawn as a chip (use the full name)']);
  // The exact name still wins over a longer one it prefixes.
  assert.equal(ok('screen "Home"\nbutton "Go" -> "Details"\nscreen "Details"\ntext "x"\nscreen "Details advanced"\ntext "y"').screens[0]!.blocks[0]!.to, 1);
});

test("wireframe: words after the texts: tones (and their synonyms), on, wide, chart types; ignored words are silent", () => {
  const s = ok('row\n  card "A" wide ok\n  card "B" danger\nbutton "Go" primary large\ntoggle "Dark mode" checked\nchart "Revenue" line\nchart "Split" donut\nchart "Default"\nprogress "Upload" "60%"\nprogress "Unknown"');
  assert.deepEqual(top(s), [
    ["row", [], [["card", ["A"], { tone: "ok" }, { wide: true }], ["card", ["B"], { tone: "error" }]]],
    ["button", ["Go"], { tone: "accent" }],
    ["toggle", ["Dark mode"], { on: true }],
    ["chart", ["Revenue"], { chart: "line" }],
    ["chart", ["Split"], { chart: "pie" }],
    ["chart", ["Default"], { chart: "bar" }],
    ["progress", ["Upload", "60%"], { value: 60 }],
    ["progress", ["Unknown"], { value: 50 }],
  ]);
});

test("wireframe: tabs, tab bars and tables are comma lists; * picks the selected tab; a mis-quoted list keeps every item", () => {
  const s = ok('tabs "All, *Unpaid, Paid"\ntabbar "Home, Search, Settings"\ntable "Name, Status"\n  item "Invoice 1" "Paid"\n  row "Invoice 2, Due"\ntabs "Home, Plan, "Settings", Profile"');
  assert.deepEqual(top(s), [
    ["tabs", [], { items: ["All", "Unpaid", "Paid"] }, { current: 1 }],
    ["tabbar", [], { items: ["Home", "Search", "Settings"] }, { current: 0 }],
    ["table", [], { items: ["Name", "Status"] }, [["item", ["Invoice 1", "Paid"]], ["item", ["Invoice 2", "Due"]]]],
    ["tabs", [], { items: ["Home", "Plan", "Settings", "Profile"] }, { current: 0 }],
  ]);
  // Modifier words (a tone or its synonym, on, wide, an ignored word) apply to the list, never become items.
  assert.deepEqual(top(ok('tabs "Home, Settings" wide on primary\ntabbar "A, B" active small\ntable "Col, Other" danger')), [
    ["tabs", [], { tone: "accent" }, { on: true }, { wide: true }, { items: ["Home", "Settings"] }, { current: 0 }],
    ["tabbar", [], { on: true }, { items: ["A", "B"] }, { current: 0 }],
    ["table", [], { tone: "error" }, { items: ["Col", "Other"] }],
  ]);
});

test("wireframe: unquoted text is the rest of the line (| splits it); a block word with a colon is that block", () => {
  assert.deepEqual(top(ok("button Save changes\ntext Your account is ok\nitem Invoice | due Friday | AED —")), [
    ["button", ["Save changes"]],
    ["text", ["Your account is ok"]],
    ["item", ["Invoice", "due Friday", "AED —"]],
  ]);
  assert.deepEqual(top(ok("text: Welcome back\nheading: Settings")), [["text", ["Welcome back"]], ["heading", ["Settings"]]]);
  // A line that is only a "text" is a text block.
  assert.deepEqual(top(ok('"Just words"')), [["text", ["Just words"]]]);
});

test("wireframe: a line of only modifiers under a block applies to that block", () => {
  assert.deepEqual(top(ok('row\n  card "A"\n    wide\n    accent\n  card "B"')), [["row", [], [["card", ["A"], { tone: "accent" }, { wide: true }], ["card", ["B"]]]]]);
  // Even the tones that are also block words (`error`, `warning` → alert): indented under a block, they tone it.
  assert.deepEqual(top(ok('button "Pay"\n  error\ninput "Email"\n  warning')), [["button", ["Pay"], { tone: "error" }], ["input", ["Email"], { tone: "warn" }]]);
  // At the top, with nothing above it to modify, `error` is an alert.
  assert.deepEqual(top(ok("error")), [["alert", []]]);
});

test("wireframe: synonyms map silently to the block that draws them, one per family", () => {
  const pairs: [string, string][] = [
    ["navbar", "header"], ["menu", "tabs"], ["bottomnav", "tabbar"], ["drawer", "sidebar"], ["hstack", "row"], ["form", "col"], ["gallery", "grid"],
    ["panel", "card"], ["listitem", "item"], ["dialog", "modal"], ["bottomsheet", "sheet"], ["h1", "heading"], ["label", "text"], ["photo", "image"],
    ["chip", "badge"], ["kpi", "stat"], ["graph", "chart"], ["meter", "progress"], ["cta", "button"], ["url", "link"], ["textfield", "input"],
    ["searchbar", "search"], ["dropdown", "select"], ["switch", "toggle"], ["check", "checkbox"], ["spinner", "loading"], ["banner", "alert"],
    ["snackbar", "toast"], ["hr", "divider"],
  ];
  for (const [word, type] of pairs) {
    assert.equal(SYNONYMS[word], type);
    assert.equal(ok(`${word} "x"`).screens[0]!.blocks[0]!.type, type, word);
  }
  // Every synonym lands on a real block, and none shadows a taught word.
  for (const [word, type] of Object.entries(SYNONYMS)) {
    assert.ok([...TAUGHT, "divider"].includes(type), `${word} → ${type}`);
    assert.ok(!TAUGHT.includes(word), `${word} is taught`);
  }
  assert.equal(TAUGHT.length, 35, "35 taught block words (plus screen: 36)");
});

test("wireframe: an unknown word draws as a plain box tagged with the word, with a warning", () => {
  const { spec, warnings } = parse('carousel "Featured cases"\n  image "case"');
  assert.deepEqual(top(spec), [["box", ["Featured cases"], { tag: "carousel" }, [["image", ["case"]]]]]);
  assert.deepEqual(warnings, ['1: "carousel" isn\'t a wireframe block; drawn as a plain box']);
});

test("wireframe: soft problems draw with a warning", () => {
  const w = (body: string) => parse(body).warnings;
  assert.deepEqual(w('button "Pay"\n  text "under a button"'), ["2: a button holds no blocks; drawn after it"]);
  assert.deepEqual(top(parse('button "Pay"\n  text "under a button"').spec), [["button", ["Pay"]], ["text", ["under a button"]]]);
  assert.deepEqual(w('button "Pay" hint'), ['1: ignored "hint" (after the texts: a tone, on, wide)']);
  assert.deepEqual(w('chart "x" radar'), ['1: ignored "radar" (after the texts: a tone, on, wide, bar line pie)']);
  assert.deepEqual(w('device: tv\ntext "x"'), ["1: device: is phone or desktop; drew phone"]);
  assert.deepEqual(w('layout: grid\ntext "x"'), ['1: unknown setting "layout:", ignored (this kind takes title: caption: device:)']);
  assert.deepEqual(w('title: A\ntitle: B\ntext "x"'), ['2: "title:" is set twice; the first is kept']);
  assert.deepEqual(w('button "Go" -> "A" -> "B"\nscreen "A"\ntext "x"'), ["1: one -> per line; the rest ignored"]);
  assert.deepEqual(w('text "x"\nbutton "Go" ->'), ["2: -> needs a screen name, ignored"]);
});

test("wireframe: limits cut with a warning, never fail", () => {
  const seven = parse(Array.from({ length: 7 }, (_, i) => `screen "S${i}"\ntext "x"`).join("\n"));
  assert.equal(seven.spec.screens.length, 6);
  assert.deepEqual(seven.warnings, ["13: at most 6 screens; the rest dropped"]);
  const many = parse(Array.from({ length: MAX_BLOCKS + 5 }, (_, i) => `text "t${i}"`).join("\n"));
  assert.equal(many.spec.screens[0]!.blocks.length, MAX_BLOCKS);
  assert.deepEqual(many.warnings, [`${MAX_BLOCKS + 1}: at most ${MAX_BLOCKS} blocks; the rest dropped`]);
  const deep = parse(Array.from({ length: MAX_DEPTH + 1 }, (_, i) => `${"  ".repeat(i)}col`).join("\n") + `\n${"  ".repeat(MAX_DEPTH + 1)}text "deep"`);
  assert.ok(deep.warnings.some((w) => w.includes(`at most ${MAX_DEPTH} levels; drawn one level up`)));
  const rows = parse(`table "A, B"\n${Array.from({ length: MAX_ROWS + 2 }, (_, i) => `  item "r${i}" "x"`).join("\n")}`);
  assert.equal(rows.spec.screens[0]!.blocks[0]!.children.length, MAX_ROWS);
  assert.ok(rows.warnings.includes(`${MAX_ROWS + 2}: a table draws ${MAX_ROWS} rows; the rest dropped`));
  const tabs = parse('tabs "A, B, C, D, E, F, G, H"');
  assert.deepEqual(tabs.spec.screens[0]!.blocks[0]!.items, ["A", "B", "C", "D", "E", "F"]);
  assert.deepEqual(tabs.warnings, ["1: drew 6 of 8 tabs"]);
  const long = parse(`text "${"x".repeat(250)}"`);
  assert.equal(long.spec.screens[0]!.blocks[0]!.texts[0]!.length, 200);
  assert.deepEqual(long.warnings, ["1: text over 200 characters, shortened"]);
});

test("wireframe: a quoted text that runs over several lines is one text, with a warning; one never closed is still an error", () => {
  const { spec, warnings } = parse('screen "Message"\ntext "Hi there,\n\nLooking forward to it.\nSam"\nrow\n  icon "reply"');
  assert.deepEqual(top(spec), [["text", ["Hi there, Looking forward to it. Sam"]], ["row", [], [["icon", ["reply"]]]]]);
  assert.deepEqual(warnings, ["2: a quoted text ran over 4 lines; joined into one"]);
  // A # inside the quote is text, not a comment, even at the start of a line.
  assert.deepEqual(top(parse('text "a # b\nc" muted').spec), [["text", ["a # b c"], { tone: "muted" }]]);
  assert.deepEqual(top(parse('text "First\n# part\nLast"\nbutton "Go"').spec), [["text", ["First # part Last"]], ["button", ["Go"]]]);
  assert.deepEqual(err('text "never closed\nbutton "x"'), { ok: false, line: 1, message: "unclosed quote" });
  assert.equal(err(`text "too long${"\nline".repeat(14)}\nend"`).message, "unclosed quote");
});

test("wireframe: the hard errors — a line that isn't a block, an unclosed quote, nothing to draw", () => {
  for (const body of ["┌──────┐\n│ Home │", "<div>hi</div>", "| a | b |"]) {
    const e = err(body);
    assert.match(e.message, /^each line is one block: a word \(row, card, text, button, …\) then its "text"; found /, body);
  }
  assert.equal(err("text \"ok\"\n<b>x</b>").line, 2);
  assert.deepEqual(err('button "Save'), { ok: false, line: 1, message: "unclosed quote" });
  assert.deepEqual(err("title: x\n# nothing"), { ok: false, line: 0, message: 'nothing to draw: one block per line, like header "Title" or button "Save"' });
  assert.equal(err('screen "Empty"').line, 0);
});

test("wireframe: mark a block by its first text, a screen by name, or a block word; first in the screen it is written under", () => {
  const s = ok('screen "Before"\ntable "Field, Value"\n  item "Status" "Delivered"\nscreen "After"\ncard "Status" "Delivered"\nmark "Status" "now at the top"\nmark "Before" muted\nmark tabs\ntabs "One, Two"');
  assert.deepEqual(s.emphasis, [
    { key: "s1.0", tone: "accent", note: "now at the top", n: 1 },
    { key: "s0", tone: "muted" },
    { key: "s1.1", tone: "accent" },
  ]);
  // A mark written before any screen line resolves anywhere; a later text, a tab or a column name also names a block.
  const t = ok('mark "Unpaid" "tap to filter"\nstat "Paid" "AED —"\nstat "Unpaid" "AED —"\ntabs "All, Overdue"\nmark "Overdue"\nmark "AED —"');
  assert.deepEqual(t.emphasis!.map((e) => e.key), ["s0.1", "s0.2", "s0.0"]);
  // `mark item "X" "note"`: the block word before the label is dropped; an indented mark is still a mark.
  const u = parse('list\n  item "Invoice no." "x"\n  mark item "Invoice no." "was a row"\nmark tabs "no tabs here"');
  assert.deepEqual(u.spec.emphasis, [{ key: "s0.0.0", tone: "accent", note: "was a row", n: 1 }]);
  assert.deepEqual(u.warnings, ["4: mark: no block or screen tabs, dropped"]);
  // A block word, too, is looked up in the mark's own screen first.
  assert.deepEqual(ok('screen "A"\ntext "A"\nscreen "B"\ntext "B"\nmark text "local"').emphasis, [{ key: "s1.0", tone: "accent", note: "local", n: 1 }]);
});

// The guide's worked example, as plan a4 reads it: what it must mean, not merely parse.
test("wireframe: the guide's example means what the section says", () => {
  const s = ok(`title: Invoices on a phone
caption: Totals first; tapping an invoice opens it.
screen "Invoices"
header "Invoices"
  icon "search"
row
  stat "Unpaid" "AED —" warn
  stat "Paid this month" "AED —"
tabs "All, Unpaid, Paid"
list
  item "Invoice no." "customer · due date" "AED —" -> "Invoice"
  item "Invoice no." "customer · due date" "AED —"
button "New invoice" accent
screen "Invoice"
header "Invoice no."
  icon "back"
card "Amount due" "AED —"
  button "Send reminder" accent
mark "Unpaid" "tap to filter"`);
  assert.deepEqual(s.screens.map((x) => [x.name, x.device]), [["Invoices", "phone"], ["Invoice", "phone"]]);
  assert.deepEqual(top(s, 0), [
    ["header", ["Invoices"], [["icon", ["search"]]]],
    ["row", [], [["stat", ["Unpaid", "AED —"], { tone: "warn" }], ["stat", ["Paid this month", "AED —"]]]],
    ["tabs", [], { items: ["All", "Unpaid", "Paid"] }, { current: 0 }],
    ["list", [], [["item", ["Invoice no.", "customer · due date", "AED —"], { to: 1 }], ["item", ["Invoice no.", "customer · due date", "AED —"]]]],
    ["button", ["New invoice"], { tone: "accent" }],
  ]);
  assert.deepEqual(top(s, 1), [["header", ["Invoice no."], [["icon", ["back"]]]], ["card", ["Amount due", "AED —"], [["button", ["Send reminder"], { tone: "accent" }]]]]);
  // The mark sits under screen 2, which has no "Unpaid": found by the anywhere fallback, on the stat.
  assert.deepEqual(s.emphasis, [{ key: "s0.1.0", tone: "accent", note: "tap to filter", n: 1 }]);
});

// A real fence whose items' title column once collapsed beside a row of badges and buttons: the parser
// was never at fault. It reads the fence as meant, with no warning, the row under each item.
test("wireframe: an item holding a row of badges and buttons parses as written", () => {
  const s = ok(PREVIEWS);
  assert.deepEqual(s.screens.map((x) => [x.name, x.device]), [["Desktop", "desktop"], ["Phone", "phone"]]);
  assert.deepEqual(top(s, 0), [
    ["header", ["Project name"]],
    ["card", ["Previews", "A coding session's running app, shown to people outside"], [["list", [], [
      ["item", ["Purpose of preview", "Coding session · branch · static files", "Expires in N days"], [["row", [], [
        ["badge", ["Made by the overseer"], { tone: "info" }],
        ["badge", ["Serving"], { tone: "ok" }],
        ["button", ["Copy Link"]],
        ["button", ["Turn Off"], { tone: "error" }],
      ]]]],
      ["item", ["Older preview", "Matched by the app's folder · port N", "Expires in N days"], [["row", [], [
        ["badge", ["Made by you"], { tone: "muted" }],
        ["button", ["Turn Off"], { tone: "error" }],
      ]]]],
    ]]]],
  ]);
  assert.deepEqual(top(s, 1), [
    ["header", ["Project name"]],
    ["card", ["Previews"], [["list", [], [
      ["item", ["Purpose of preview", "Coding session · static files"], [["row", [], [["button", ["Copy Link"]], ["button", ["Turn Off"], { tone: "error" }]]]]],
    ]]]],
  ]);
  assert.deepEqual(s.emphasis!.map((e) => e.key), ["s0.1.0.1", "s1.1.0.0.0.0"]);
});

test("wireframe: a comma inside parentheses doesn't split a tab, a column or a row's cell, unless the table's columns say so", () => {
  const s = ok('tabs "All, Open (new, reopened), Closed"\ntable "Name, Size (KB, raw)"\n  item "report.pdf, 120 (compressed, 80)"\n  item "a (b, c)"');
  assert.deepEqual(top(s), [
    ["tabs", [], { items: ["All", "Open (new, reopened)", "Closed"] }, { current: 0 }],
    ["table", [], { items: ["Name", "Size (KB, raw)"] }, [["item", ["report.pdf", "120 (compressed, 80)"]], ["item", ["a (b", "c)"]]]],
  ]);
});
