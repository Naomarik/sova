import assert from "node:assert/strict";
import { test } from "node:test";
import { parseVis } from "../../parse";
import { unweighted } from "../tree/measure";
import { estimateHeight, fitStrip, frameWidth, MIN_STRIP_SCALE, stripWidth } from "./layout";
import type { WireframeSpec } from "./parse";

const spec = (body: string) => {
  const r = parseVis("wireframe", body);
  if (!r.ok) assert.fail(`line ${r.line}: ${r.message}`);
  return r.spec as WireframeSpec;
};
/** 7px a character: easy to reason about. */
const flat = unweighted((t) => t.length * 7);

const INVOICES = spec(`title: Invoices on a phone
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

const CHECKOUT = spec(`title: Checkout in three steps
caption: Each step's main action opens the next.
screen "Cart"
header "Cart"
  icon "back"
list
  item "Product name" "qty 1" "AED —"
  item "Product name" "qty 2" "AED —"
stat "Total" "AED —"
button "Checkout" accent -> "Shipping"
tabbar "Shop, Cart, Account"
screen "Shipping"
header "Shipping"
  icon "back"
input "Name"
input "Address"
select "Delivery" "Standard"
checkbox "Save for next time" on
button "Pay AED —" accent -> "Done"
screen "Done"
header "Order placed"
alert "We'll email the receipt." ok
progress "Delivery" "20%"
button "Track order" -> "Tracking"
link "Continue shopping" -> "Cart"`);

const SETTINGS = spec(`title: Settings on a phone and on a desktop
screen "Settings" phone
header "Settings"
  icon "menu"
list
  item "Notifications" "email and push"
    toggle on
  item "Dark mode"
    toggle
input "Display name" "Name" "shown to others"
input "Email" "name@" "that address isn't valid" error
screen "Settings" desktop
sidebar
  tabs "General, *Notifications, Billing"
header "Notifications"
  button "Save" accent
row
  card "Email" "a digest each morning"
    toggle "Daily digest" on
  card "Push" "only direct replies"
    toggle "Replies" on
table "Channel, When, Status"
  item "Email" "Daily" "On"
  item "Push" "Always" "On"
  item "SMS" "Never" "Off"
mark "Daily digest" "new default"`);

const OVERLAYS = spec(`title: Delete, confirm, undo
screen "Confirm"
header "Project"
text
image "cover image"
modal "Delete this project?"
  text "Its 12 files go away."
  row
    button "Cancel"
    button "Delete" error
screen "Share"
header "Project"
grid
  card "Files"
  card "People"
  card "Settings"
  card "History"
sheet "Share"
  item "Copy link"
    icon "copy"
  item "Email"
    icon "chat"
  button "Done" accent
screen "Undo"
header "Projects"
empty "No projects yet" "Start one from a template"
  button "New project" accent
loading
toast "Project deleted · Undo"`);

const LONG_NAMES = spec(`title: Six long screen names
screen "Choose a plan for the whole team"
text "a"
screen "Enter billing details and address"
text "b"
screen "Review the order before paying"
text "c"
screen "Payment is being processed now"
loading
screen "Receipt and next steps for admins"
text "e"
screen "Invite the rest of the team later"
button "Invite" accent`);

const WIDE = spec(`title: A wide grid and a wide row
device: desktop
grid
  card "Revenue" "this month" wide
  card "Orders"
  card "Refunds"
  card "Visitors" wide
  card "Returns"
row
  stat "One" "1"
  stat "Two" "2" wide
  stat "Three" "3"
  stat "Four" "4"
  stat "Five" "5"
  stat "Six" "6"`);

const CHIPS = spec(`title: Heavy chips
screen "List of every invoice"
list
  item "Invoice no." "customer" "AED —" -> "Invoice detail page"
  item "Invoice no." "customer" "AED —" -> "Payment reminders"
  item "Invoice no." "customer" "AED —" -> "Edit profile"
row
  button "Pay now" accent -> "Payment reminders"
  button "Later" -> "Invoice detail page"
card "Summary" "all invoices" -> "Payment reminders"
screen "Invoice detail page"
header "Invoice"
  icon "back" -> "List of every invoice"
table "Line, Qty, Amount"
  item "Item" "1" "AED —"
    badge "Overdue" warn -> "Payment reminders"
  item "Item" "2" "AED —"
    button "Remind"
screen "Payment reminders"
text "x"`);

const TILES = spec(`title: Four tiles
grid
  card "Revenue" "this month"
  card "Orders" "today"
  card "Refunds" "this week"
  card "Visitors" "live"`);
const WIDE_TILES = spec(`title: Four wide tiles
grid
  card "Revenue" "this month" wide
  card "Orders" "today" wide
  card "Refunds" "this week" wide
  card "Visitors" "live" wide`);
const RAGGED = spec(`title: A ragged desktop grid
device: desktop
grid
  card "One" wide
  card "Two"
  card "Three" wide
  card "Four"
  card "Five"
  card "Six" wide -> "Details"`);
const SHELL = spec(`title: An app shell with headings
device: desktop
screen "Projects"
header "Acme" "workspace"
  icon "search"
  avatar "Sam Lee"
sidebar
  tabs "Home, *Projects, Settings"
heading "Projects"
  button "New project" accent
  text "Everything your team is working on."
list
  item "Website" "12 tasks"
  item "Mobile app" "4 tasks"
heading "Archived"
  link "Show all"`);

test("wireframe layout: frames narrow with the pane to fit whole, down to 240px (phone) and 560px (desktop)", () => {
  // The body's content width less the strip's 6px padding each side (wireframe.css --wf-inset).
  assert.equal(frameWidth("desktop", 676), 664);
  assert.equal(frameWidth("desktop", 1000), 760);
  assert.equal(frameWidth("desktop", 400), 560);
  assert.equal(frameWidth("phone", 296), 284);
  assert.equal(frameWidth("phone", 200), 240);
  // One frame fits the 676px chat column; several don't, and the strip scrolls (the widths the browser laid out).
  assert.equal(stripWidth(spec('screen "A" desktop\ntext "x"'), 676), 676);
  assert.equal(stripWidth(CHECKOUT, 676), 1008);
  assert.equal(stripWidth(SETTINGS, 676), 1032);
});

test("wireframe layout: fixed control heights, a row its tallest child, a phone frame's chrome", () => {
  // Strip padding 12, frame chrome 18 + border 3, page padding 20.
  const one = (body: string) => estimateHeight(spec(body), 676, flat) - 12 - 18 - 3 - 20;
  assert.equal(one('button "Go"'), 34);
  assert.equal(one('input "Name"'), 16 + 3 + 34);
  assert.equal(one('row\n  button "A"\n  stat "Label" "1"'), 14 + 16 + 26);
  assert.equal(one('button "Go"\nbutton "Stop"'), 34 + 8 + 34);
  // A header bleeds into the page's padding: 40 for itself, less the 10 above it.
  assert.equal(one('header "Title"'), 40 - 10);
  // A grid: 2 tiles to a row on a phone; a wide one spans both, so 4 wide tiles take 4 rows, not 2. Its chip takes a cell.
  const card = 18 + 18;
  assert.equal(one('grid\n  card "A"\n  card "B"\n  card "C"\n  card "D"'), 2 * card + 8);
  assert.equal(one('grid\n  card "A" wide\n  card "B" wide\n  card "C" wide\n  card "D" wide'), 4 * card + 3 * 8);
  assert.equal(one('grid "x" -> "Nowhere"\n  card "A"\n  card "B"'), card + 8 + 18);
  // A heading's leading buttons, links and icons sit on its line; a later one, or a toggle, stacks under it.
  assert.equal(one('heading "Plan"\n  button "Add"'), 28);
  assert.equal(one('heading "Plan"\n  text "x"\n  button "Add"'), 22 + 8 + 18 + 8 + 34);
  assert.equal(one('heading "Plan"\n  toggle "On"'), 22 + 8 + 20);
  // A long label wraps inside a button on its own, and is cut short on one line in a row.
  assert.ok(one(`button "${"word ".repeat(20)}"`) > 34);
  assert.equal(one(`row\n  button "${"word ".repeat(12)}"\n  button "B"`), 34);
});

test("wireframe layout: the screen buttons are one line at any width", () => {
  const six = spec(Array.from({ length: 6 }, (_, i) => `screen "Step number ${i + 1} of the flow"\ntext "x"`).join("\n"));
  // Scrolling (six phones would go below 3/4): 36px of buttons and 8px under them, over the strip.
  const strip = 14 + 6 + 26 + 18 + 3 + 20 + 18;
  assert.equal(estimateHeight(six, 676, flat), 36 + 8 + strip);
  assert.equal(estimateHeight(six, 296, flat), 36 + 8 + strip);
});

// Rendered heights of the drawing (`.vis-wf`) in the chat: captured 2026-09-29 from this branch's build
// (uncommitted work on feat/vis-wireframe) in headless Chromium, dark theme, Inter; at 1280px the body's
// content is 676px wide, at 390px 296px. Where a strip is scaled (fitStrip) the heights are the scaled
// ones. Recapture them when wireframe.css changes. Off the DOM the estimate measures text with core/text's
// per-character widths, so it is held to within 15% here (it measured within 6.5% in the browser).
const RENDERED: [string, WireframeSpec, number, number][] = [
  ["the guide's example (2 phone screens)", INVOICES, 676, 383],
  ["the guide's example (2 phone screens)", INVOICES, 296, 437],
  ["a 3-screen flow with a tab bar", CHECKOUT, 676, 304],
  ["a 3-screen flow with a tab bar", CHECKOUT, 296, 425],
  ["a phone and a desktop with a sidebar", SETTINGS, 676, 290],
  ["a phone and a desktop with a sidebar", SETTINGS, 296, 426],
  ["a modal, a sheet and a toast", OVERLAYS, 676, 288],
  ["a modal, a sheet and a toast", OVERLAYS, 296, 406],
  ["six long screen names", LONG_NAMES, 676, 196],
  ["six long screen names", LONG_NAMES, 296, 196],
  ["a grid and a row of more than 4, with wide blocks", WIDE, 676, 282],
  ["a grid and a row of more than 4, with wide blocks", WIDE, 296, 154],
  ["chips on items, buttons, a card and table rows", CHIPS, 676, 335],
  ["chips on items, buttons, a card and table rows", CHIPS, 296, 460],
  ["four tiles", TILES, 676, 168],
  ["four tiles", TILES, 296, 168],
  ["four wide tiles", WIDE_TILES, 676, 292],
  ["four wide tiles", WIDE_TILES, 296, 292],
  ["a ragged desktop grid with a chip", RAGGED, 676, 180],
  ["a ragged desktop grid with a chip", RAGGED, 296, 102],
  ["an app shell: a header over the sidebar, controls in headings", SHELL, 676, 324],
  ["an app shell: a header over the sidebar, controls in headings", SHELL, 296, 186],
];

test("wireframe layout: the estimate is within 15% of the rendered height", () => {
  for (const [what, s, width, rendered] of RENDERED) {
    const e = estimateHeight(s, width);
    assert.ok(Math.abs(e - rendered) / rendered <= 0.15, `${what} at ${width}px: estimated ${e}, rendered ${rendered}`);
  }
});

test("wireframe layout: deterministic, and positive at every width", () => {
  for (const s of [INVOICES, CHECKOUT, SETTINGS, OVERLAYS, LONG_NAMES, WIDE, CHIPS, TILES, WIDE_TILES, RAGGED, SHELL]) {
    for (let w = 280; w <= 1000; w += 3) {
      const h = estimateHeight(s, w);
      assert.equal(h, estimateHeight(s, w));
      assert.ok(h > 0 && Number.isFinite(h), `height ${h} at ${w}`);
    }
  }
});

test("wireframe layout: what fits whole, what is scaled whole, and what scrolls between screens with each frame fit to the pane", () => {
  const desktop = spec('screen "A" desktop\ntext "x"');
  // A lone desktop frame fits the chat column unscaled; on a phone it is scaled to the pane, never panned.
  assert.deepEqual(fitStrip(desktop, 676), { widths: [664], strip: 1, frames: [1], scrolls: false });
  const phone = fitStrip(desktop, 296);
  assert.deepEqual([phone.widths, phone.strip, phone.scrolls], [[560], 1, false]);
  assert.ok(Math.abs(phone.frames[0]! - 284 / 560) < 1e-9);
  // Two phones fit the chat column as they are.
  assert.deepEqual(fitStrip(INVOICES, 676), { widths: [300, 300], strip: 1, frames: [1, 1], scrolls: false });
  // A phone and a desktop, or 3 phones: scaled whole at their narrowest frames, since that keeps 3/4 or more.
  for (const s of [SETTINGS, CHECKOUT]) {
    const f = fitStrip(s, 676);
    assert.equal(f.scrolls, false);
    assert.ok(f.strip >= MIN_STRIP_SCALE && f.strip < 1, `scale ${f.strip}`);
    assert.equal(Math.round(stripWidth(s, 676, f.widths) * f.strip), 676);
  }
  // Six phones would go below 3/4: the strip scrolls between screens, each unscaled.
  assert.deepEqual(fitStrip(LONG_NAMES, 676), { widths: [300, 300, 300, 300, 300, 300], strip: 1, frames: [1, 1, 1, 1, 1, 1], scrolls: true });
  // On a phone: a phone and a desktop scroll; the desktop frame alone is scaled to the pane.
  const both = fitStrip(SETTINGS, 296);
  assert.equal(both.scrolls, true);
  assert.equal(both.frames[0], 1);
  assert.ok(both.frames[1]! < 1 && Math.abs(both.frames[1]! * both.widths[1]! - 284) < 1e-9);
});
