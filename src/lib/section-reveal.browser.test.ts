// Run: pnpm test -- src/lib/section-reveal.browser.test.ts (Solid's reactive build).
// A section holding the open session opens when you move to it, once; the user's collapse then sticks through every
// refresh of the session list (§app.projects/list, §app.session-list/regions-top-and-archive,
// §app.session-list/organizations). Driven the way the sidebar wires it: the section's `open` is an effect that writes
// the <details> on every re-run (a render effect, as Solid's compiled `open={…}` is), the list refresh mints fresh arrays, and the
// toggle handler ignores the sidebar's own `open` writes.
import assert from "node:assert/strict";
import { test } from "node:test";
if (!import.meta.resolve("solid-js").endsWith("/dist/solid.js")) throw new Error("run with --conditions=browser (the *.browser.test.ts invocation)");

const solid = await import("solid-js");
const { createSectionReveal } = await import("./section-reveal");
const { orgsRegionOpen, orgSectionOpen } = await import("./org-region");

type Row = { path: string };

/** A stand-in for the sidebar: one region (stored choice, the Projects head's rule) holding one project fold. */
function sidebar() {
  const [selected, setSelected] = solid.createSignal<string | null>("/p/a.jsonl");
  const [sessions, setSessions] = solid.createSignal<Row[]>([{ path: "/p/a.jsonl" }, { path: "/p/b.jsonl" }]);
  const [stored, setStored] = solid.createSignal(true);
  const [chosen, setChosen] = solid.createSignal<boolean | undefined>(undefined);
  const { dismissed, noteToggle } = createSectionReveal(selected);
  // A refresh mints a fresh array, so everything that reads it re-runs, as `hits()` does in the sidebar.
  const rows = () => sessions().filter((s) => s.path.startsWith("/p/"));
  const holds = () => rows().some((r) => r.path === selected());
  const regionOpen = () => orgsRegionOpen({ stored: stored(), searching: false, holdsSelected: holds(), dismissed: dismissed("projects") });
  const foldOpen = () => orgSectionOpen({ chosen: chosen(), searching: false, holdsSelected: holds(), dismissed: dismissed("project\np") });
  const details = { open: false };
  let writes = 0;
  solid.createRenderEffect(() => {
    details.open = regionOpen();
    writes++;
  });
  /** The user clicks the region's summary: the browser flips `open`, then fires `toggle`. */
  const toggleRegion = () => {
    details.open = !details.open;
    const open = details.open;
    if (open === regionOpen()) return; // our own `open` update, not the user's
    noteToggle("projects", open, holds());
    setStored(open);
  };
  /** The project's arrow button. */
  const fold = () => {
    const open = !foldOpen();
    noteToggle("project\np", open, holds());
    setChosen(open);
  };
  const refresh = () => setSessions((s) => s.map((r) => ({ ...r })));
  return { details, writes: () => writes, toggleRegion, fold, foldOpen, refresh, setSelected, setSessions };
}

/** Mounted in its own root, driven from outside it: writes made inside a root's setup are batched until it returns. */
const mount = () => solid.createRoot((dispose) => ({ s: sidebar(), dispose }));

test("a collapsed region stays collapsed through refreshes while its session is open", () => {
  {
    const { s, dispose } = mount();
    assert.equal(s.details.open, true, "open by default");
    s.toggleRegion();
    assert.equal(s.details.open, false, "the user collapsed it");
    const before = s.writes();
    for (let i = 0; i < 5; i++) s.refresh();
    assert.ok(s.writes() > before, "the refreshes did re-run the open effect");
    assert.equal(s.details.open, false, "and it stays shut");
    s.setSelected("/p/b.jsonl");
    assert.equal(s.details.open, true, "moving to another session inside opens it once");
    s.toggleRegion();
    s.refresh();
    assert.equal(s.details.open, false, "the next collapse sticks again");
    dispose();
  }
});

test("moving back to the same session is a new visit and reveals again", () => {
  {
    const { s, dispose } = mount();
    s.toggleRegion();
    s.setSelected("/elsewhere.jsonl");
    s.setSelected("/p/a.jsonl");
    assert.equal(s.details.open, true);
    dispose();
  }
});

test("a project fold made on the open session sticks; expand then collapse again sticks too", () => {
  {
    const { s, dispose } = mount();
    assert.equal(s.foldOpen(), true);
    s.fold();
    assert.equal(s.foldOpen(), false, "the arrow folds it although it holds the open session");
    s.refresh();
    s.refresh();
    assert.equal(s.foldOpen(), false, "through refreshes");
    s.fold();
    assert.equal(s.foldOpen(), true, "unfolded by hand");
    s.fold();
    s.refresh();
    assert.equal(s.foldOpen(), false, "folded again on the same session: it sticks");
    s.setSelected("/p/b.jsonl");
    assert.equal(s.foldOpen(), true, "moving to another of its sessions opens it");
    dispose();
  }
});

test("a region collapsed away from the open session opens when you move into it", () => {
  {
    const { s, dispose } = mount();
    s.setSelected("/elsewhere.jsonl");
    s.toggleRegion();
    assert.equal(s.details.open, false);
    s.refresh();
    assert.equal(s.details.open, false);
    s.setSelected("/p/b.jsonl");
    assert.equal(s.details.open, true, "revealed on arrival");
    s.setSelected("/elsewhere.jsonl");
    assert.equal(s.details.open, false, "back to the user's choice once you move out");
    dispose();
  }
});
