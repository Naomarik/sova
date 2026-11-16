// A design's views (al_1 step 17): what a page's markup declares and what is refused, the role="tab" fallback, the
// browser pass's findings (driven here by a stand-in browser), the pictures it keeps, and a look at one view by name.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { DesignRecord, DesignView } from "../../shared/design";
import { TourCaptureFailure } from "../tours/targets";

process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "design-views-"));
after(() => rmSync(process.env.PI_CODING_AGENT_DIR!, { recursive: true, force: true }));
const { checkVersionViews, lookAtDesignPage, pageViews, viewsLine } = await import("./views");
const { pageProblem } = await import("./lint");
const store = await import("./store");

const page = (body: string) => `<!doctype html><html><head></head><body>\n${body}\n</body></html>`;

test("a page's declared views are read in page order, with their via, and a declaration done wrong is refused naming its line", () => {
  const ok = page(`<button role="tab" data-sova-view="Overview">Overview</button>
<a href="#d" data-sova-view=" Deploy  plan ">Deploy</a>
<button data-sova-view="User menu" aria-haspopup="menu">NK</button>
<div role="menuitem" data-sova-view="Billing" data-sova-via="user MENU">Billing</div>
<label for="t2" data-sova-view="Second">Second</label>`);
  assert.deepEqual(
    pageViews(ok).views.map((v) => [v.name, v.via ?? null, v.source]),
    [["Overview", null, "declared"], ["Deploy plan", null, "declared"], ["User menu", null, "declared"], ["Billing", "user MENU", "declared"], ["Second", null, "declared"]],
  );
  assert.equal(pageProblem(ok), null);
  // Line 2 of each page holds the declaration that is wrong.
  const wrong: [string, RegExp][] = [
    [`<section data-sova-view="Pricing">x</section>`, /line 2: data-sova-view="Pricing" is on a <section>, which can't be clicked/],
    [`<a data-sova-view="Docs">no href</a>`, /line 2: .*on a <a>, which can't be clicked/],
    [`<button data-sova-view="  ">x</button>`, /line 2: data-sova-view on <button> is empty/],
    [`<button data-sova-view="Plan">a</button>\n<button data-sova-view="plan">b</button>`, /line 3: a view named "plan" is already declared on line 2/],
    [`<button data-sova-view="Billing" data-sova-via="Account">x</button>`, /line 2: data-sova-via="Account" names no view/],
    [`<button data-sova-view="A" data-sova-via="B">a</button>\n<button data-sova-view="B" data-sova-via="A">b</button>`, /line 2: data-sova-via goes round in a loop: A → B → A/],
    [`<button data-sova-view="D" data-sova-via="C">d</button>\n<button data-sova-view="C" data-sova-via="B">c</button>\n<button data-sova-view="B" data-sova-via="A">b</button>\n<button data-sova-view="A">a</button>`, /line 2: the view "D" takes 4 clicks to reach \(A → B → C → D\); views go at most 3 deep/],
    [`<button data-sova-via="Menu">x</button>`, /line 2: data-sova-via without data-sova-view/],
    [`<form>\n<button data-sova-view="Send">x</button></form>`, /line 3: the control opening the view "Send" submits its form/],
    [`<button data-sova-view="${"x".repeat(41)}">x</button>`, /line 2: the view name ".*" is longer than 40 characters/],
    [Array.from({ length: 21 }, (_, i) => `<button data-sova-view="V${i}">${i}</button>`).join(""), /declares 21 views; at most 20/],
  ];
  for (const [body, want] of wrong) assert.match(pageProblem(page(body)) ?? "", want, body);
  // Nothing wrong with the depth rule's own edge: three clicks deep is allowed, and a form's type="button" opens no submit.
  assert.equal(pageProblem(page(`<button data-sova-view="C" data-sova-via="B">c</button><button data-sova-view="B" data-sova-via="A">b</button><button data-sova-view="A">a</button><form><button type="button" data-sova-view="F">f</button></form>`)), null);
});

test("a page that declares none has its role=\"tab\" controls as its views, by aria-label or words, each name once", () => {
  const tabs = page(`<div role="tablist"><button role="tab" aria-selected="true">Sessions</button><button role="tab"><span>Deploy</span> <b>&amp; logs</b></button><button role="tab" aria-label="Back log">BL</button><button role="tab">Sessions</button><button role="tab" disabled>Off</button></div>`);
  assert.deepEqual(pageViews(tabs).views.map((v) => [v.name, v.source]), [["Sessions", "found"], ["Deploy & logs", "found"], ["Back log", "found"]]);
  assert.equal(pageProblem(tabs), null);
  // One declaration and the tabs are no longer views.
  assert.deepEqual(pageViews(tabs.replace("<button role=\"tab\" aria-label", `<button data-sova-view="New" type="button">N</button><button role="tab" aria-label`)).views.map((v) => v.name), ["New"]);
});

test("a read's views line names each view, its way there, the first screen, and what the browser found", () => {
  const v = (name: string, over: Partial<DesignView> = {}): DesignView => ({ name, source: "declared", state: "ok", ...over });
  assert.equal(viewsLine({}), "");
  assert.equal(viewsLine({ views: [v("Deploy", { state: "unchecked" }), v("Billing", { via: "User menu", state: "unchecked" })] }), "Views: the first screen · Deploy · Billing (via User menu) · not yet checked in a browser");
  assert.equal(
    viewsLine({ views: [v("Sessions", { start: true }), v("Deploy", { state: "unreachable", problem: "Target matched 0 visible controls" }), v("Log", { state: "unchanged" })] }),
    "Views: Sessions (the first screen) · Deploy (unreachable: Target matched 0 visible controls) · Log (unchanged: clicking it left the screen as it was)",
  );
  assert.match(viewsLine({ views: [v("Sessions", { source: "found" })] }), /^Views \(found from its tabs; the page declares none\): the first screen · Sessions$/);
});

// ---- the pass, with a stand-in browser -----------------------------------------------------------

const sid = "views-1";
const parent = { sessionId: sid, path: join(process.env.PI_CODING_AGENT_DIR!, "main.jsonl") };
const tabsPage = page(`<button role="tab" data-sova-view="Overview">Overview</button>
<button role="tab" data-sova-view="Deploy">Deploy</button>
<button data-sova-view="User menu">NK</button>
<a href="#b" data-sova-view="Billing" data-sova-via="User menu">Billing</a>
<button data-sova-view="Gone">Gone</button>
<a href="#x" data-sova-view="Behind gone" data-sova-via="Gone">x</a>`);
const record = (): DesignRecord => ({
  label: "A", runId: "r1", direction: "Quiet", model: "zai/a", modelName: "a", parents: [], status: "ready", route: "tool", workerState: "idle", vision: true, createdAt: "2026-11-16T10:00:00.000Z", updatedAt: "2026-11-16T10:00:00.000Z",
  versions: [{ n: 1, at: "2026-11-16T10:01:00.000Z", chars: tabsPage.length, by: "first" }],
});
store.changeDesigns(sid, (s) => void s.designs.push(record()));
store.writePage(sid, "A", 1, tabsPage);

/** A browser over a page whose controls are its test ids: clicking one shows its screen, except the broken ones (no
    control on screen) and the start tab (already showing). Records each attempt's steps. */
function browser(broken: Set<string>) {
  const attempts: string[][] = [];
  const screens: string[] = [];
  const served: string[] = [];
  const run = async (o: { script: { steps: { id: string }[] }; walkSteps: Record<string, { desktop?: { target: { testId: string } }[] }> }) => {
    const ids = o.script.steps.map((s) => s.id);
    attempts.push(ids);
    const steps = [];
    const assets = new Map<string, Uint8Array>();
    const pages = [];
    for (const id of ids) {
      const clicks = (o.walkSteps[id]?.desktop ?? []).map((a) => a.target.testId);
      const bad = clicks.find((c) => broken.has(c));
      if (bad) throw new TourCaptureFailure({ message: "Target matched 0 visible controls; exactly 1 is required.", guidance: "", stepId: id });
      // sova-view-0 is the tab already selected: clicking it shows the first screen again.
      const screen = clicks.filter((c) => c !== "sova-view-0").join(">") || "first";
      screens.push(screen);
      const image = `${id}.png`;
      assets.set(image, new TextEncoder().encode(screen));
      steps.push({ id, views: [{ id: "page", captures: { desktop: { image } } }] });
      pages.push({ route: "/", desktop: { url: "/", controls: [], links: [`#${screen}`] } });
    }
    return { steps, assets, look: { pages } };
  };
  const deps = {
    run: run as never,
    context: async () => ({}) as never,
    serve: async <T,>(html: string, fn: (origin: string) => Promise<T>) => (served.push(html), fn("http://127.0.0.1:1")),
    showAssets: ((_s: string, html: string) => html) as never,
  };
  return { deps, attempts, screens, served };
}

test("the pass marks a view whose control can't be clicked unreachable, with the views behind it, finds the first screen's own tab, and keeps the pictures", async () => {
  // Gone (index 4) can't be clicked; Behind gone goes through it.
  const b = browser(new Set(["sova-view-4"]));
  const views = await checkVersionViews(parent, "A", 1, b.deps);
  assert.deepEqual(
    views?.map((v) => [v.name, v.state, v.start ?? false, v.problem ?? ""]),
    [
      ["Overview", "ok", true, ""],
      ["Deploy", "ok", false, ""],
      ["User menu", "ok", false, ""],
      ["Billing", "ok", false, ""],
      ["Gone", "unreachable", false, "Target matched 0 visible controls; exactly 1 is required."],
      ["Behind gone", "unreachable", false, "its way there goes through Gone, which couldn't be opened"],
    ],
  );
  // One browser for the version; a failed walk brings nothing back, so once more without what couldn't be reached.
  assert.deepEqual(b.attempts, [["start", "view-0", "view-1", "view-2", "view-3", "view-4", "view-5"], ["start", "view-0", "view-1", "view-2", "view-3"]]);
  // Its path is clicked control by control, the way there first; the served copy carries the ids, the stored page never.
  assert.ok(b.screens.includes("sova-view-2>sova-view-3"));
  assert.match(b.served[0]!, /<button data-testid="sova-view-1" role="tab" data-sova-view="Deploy">/);
  assert.doesNotMatch(store.readPage(sid, "A", 1)!, /data-testid/);

  // A look at a view the pass pictured needs no browser; at another width it walks there.
  const again = browser(new Set());
  const deploy = await lookAtDesignPage(parent, "A", { view: "deploy", sizes: ["desktop"] }, again.deps);
  assert.equal(deploy.view, "Deploy");
  assert.equal(new TextDecoder().decode(deploy.shots[0]!.png), "sova-view-1");
  assert.match(deploy.outline, /#sova-view-1/);
  assert.equal(again.attempts.length, 0);
});

test("a click that leaves the screen as it was reads unchanged; with two such tabs neither is the first screen, unless one says it is selected", async () => {
  const p = page(`<button role="tab" data-sova-view="One">1</button><button role="tab" data-sova-view="Two">2</button>`);
  const sid2 = "views-2";
  store.changeDesigns(sid2, (s) => void s.designs.push(record()));
  store.writePage(sid2, "A", 1, p);
  const b = browser(new Set());
  // Both clicks draw the first screen again: the stand-in treats sova-view-0 as already showing, and sova-view-1 is made the same.
  const deps = { ...b.deps, run: (async (o: never) => {
    const r = await (b.deps.run as unknown as (o: never) => Promise<{ assets: Map<string, Uint8Array> }>)(o);
    for (const [k] of r.assets) r.assets.set(k, new TextEncoder().encode("first"));
    return r;
  }) as never };
  const views = await checkVersionViews({ sessionId: sid2, path: parent.path }, "A", 1, deps);
  assert.deepEqual(views?.map((v) => [v.name, v.state, v.start ?? false]), [["One", "unchanged", false], ["Two", "unchanged", false]]);
  store.writePage(sid2, "A", 1, p.replace('role="tab" data-sova-view="Two"', 'role="tab" aria-selected="true" data-sova-view="Two"'));
  const marked = await checkVersionViews({ sessionId: sid2, path: parent.path }, "A", 1, deps);
  assert.deepEqual(marked?.map((v) => [v.name, v.state, v.start ?? false]), [["One", "unchanged", false], ["Two", "ok", true]]);
});

test("a look at a view the version doesn't have is refused, naming the views it has", async () => {
  await assert.rejects(lookAtDesignPage(parent, "A", { view: "Settings", sizes: ["phone"] }, browser(new Set()).deps), /^Error: Design A's version 1 has no view "Settings"\. Its views: the first screen, Overview, Deploy, User menu, Billing, Gone, Behind gone\.$/);
  // At phone width, a declared view is walked to: its path, clicked in order.
  const b = browser(new Set());
  const billing = await lookAtDesignPage(parent, "A", { view: "BILLING", sizes: ["phone"] }, { ...b.deps, run: (async (o: { walkSteps: Record<string, { phone?: { target: { testId: string } }[] }> }) => {
    const clicks = o.walkSteps.page?.phone?.map((a) => a.target.testId) ?? [];
    return { steps: [{ id: "page", views: [{ id: "page", captures: { phone: { image: "p.png" } } }] }], assets: new Map([["p.png", new TextEncoder().encode(clicks.join(">"))]]), look: { pages: [] } };
  }) as never });
  assert.equal(new TextDecoder().decode(billing.shots[0]!.png), "sova-view-2>sova-view-3");
});

test("the main chat's read lists a version's views, and its look returns one picture of one view at one width", async () => {
  const { mainDesignTools } = await import("./tools");
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const sid3 = "views-3";
  const views: DesignView[] = [{ name: "Sessions", source: "found", state: "ok", start: true }, { name: "Deploy", source: "found", state: "ok" }];
  store.changeDesigns(sid3, (s) => void s.designs.push({ ...record(), versions: [{ ...record().versions[0]!, views }] }));
  const tabs = page(`<button role="tab" aria-selected="true">Sessions</button><button role="tab">Deploy</button>`);
  store.writePage(sid3, "A", 1, tabs);
  // What the pass kept for Deploy at desktop width: the look answers from it, with no browser.
  const dir = join(store.designDirOf(sid3), "A", "views", "v1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "view-1.desktop.png"), "DEPLOY-PICTURE");
  writeFileSync(join(dir, "view-1.desktop.txt"), "");
  const tool = mainDesignTools(() => ({ sessionId: sid3, path: parent.path }), () => "/cwd").find((t) => t.name === "lookbook")!;
  const call = (params: Record<string, unknown>) => tool.execute("t", params, undefined, undefined, undefined as never);
  const read = (await call({ op: "read", label: "A" })).content[0] as { text: string };
  assert.match(read.text, /\nViews \(found from its tabs; the page declares none\): Sessions \(the first screen\) · Deploy\nFile: /);
  const look = await call({ op: "look", label: "A1", view: "DEPLOY" });
  assert.deepEqual(look.content.map((b) => b.type), ["text", "image"]);
  assert.match((look.content[0] as { text: string }).text, /^Design A · version 1 of 1 \(latest\).*\nThe view Deploy, at desktop width\.\nViews \(found/);
  assert.equal(Buffer.from((look.content[1] as { data: string }).data, "base64").toString(), "DEPLOY-PICTURE");
  // Refused before anything is opened: a bad width, two designs at once, a view the version doesn't have.
  for (const [params, why] of [[{ size: "tablet" }, /size is "desktop" or "phone"/], [{ label: "A, A1" }, /one design at a time/], [{ view: "Billing" }, /has no view "Billing"\. Its views: the first screen, Sessions, Deploy\./]] as const)
    await assert.rejects(call({ op: "look", label: "A", ...params }), why);
});
