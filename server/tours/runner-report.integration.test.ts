// In the installed Chrome: a dry run reports every failing view in one answer and still stops at once on a
// safety stop or two views that find none of their targets, while a recording stops at its first problem;
// the reveal action scrolls an inner panel and gets out from under a fixed bar, or names the bar; the
// page's settle waits for an inner panel's scroll; text and names ignore direction marks; a sign-in page
// showing neither control lists what it does show (§app.tours/recording, §app.tours/authoring).
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeTourScript, type TourAction, type TourFailure, type TourScript, type TourSignIn, type TourTarget } from "../../shared/tour";
import { runTourAttempt, type TourAttemptResult } from "./runner";
import { TourCaptureFailure, TOUR_TARGET_MOVING } from "./targets";
import type { TourRecordingContext } from "./sandbox";

const page = (body: string, head = "") => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:18px sans-serif}${head}</style></head><body>${body}</body></html>`;
const PAGES: Record<string, string> = {
  "/plain": page(`<h1>Overview</h1><nav><a href="/plain">Overview</a></nav><div role="tablist"><button role="tab" aria-selected="true">Activity</button></div><button type="button">Save</button>`),
  "/fine": page(`<h1>Settings</h1>`),
  "/blank": page(`<h1>Sign in</h1><p>Your session has ended.</p>`),
  "/alert": page(`<h1>Settings</h1><script>addEventListener("load", () => setTimeout(() => alert("hi"), 50))</script>`),
  // The app scrolls an inner panel; the page itself never scrolls.
  "/panel": page(`<main id="pane" style="position:absolute;inset:0;overflow:auto"><h1>Invoices</h1><div style="height:1400px"></div><button type="button">Pay invoice</button><div style="height:900px"></div></main>`, "html,body{height:100%;overflow:hidden}"),
  // A fixed bottom bar: the nearest scroll leaves the target under it; centred, it is clear.
  "/bar": page(`<h1>Invoices</h1><div style="height:1500px"></div><button type="button">Pay invoice</button><div style="height:1200px"></div><nav aria-label="Bottom bar" style="position:fixed;left:0;right:0;bottom:0;height:160px;background:#ccc"><a href="/bar">Home</a></nav>`),
  // A fixed banner over the whole middle of the screen: no scroll gets the target out from under it.
  "/covered": page(`<h1>Invoices</h1><div style="height:1500px"></div><button type="button">Pay invoice</button><div style="height:1200px"></div><div role="region" aria-label="Cookie banner" style="position:fixed;left:0;right:0;top:120px;bottom:0;background:#eee">We use cookies.</div>`),
  // An inner panel that keeps scrolling by itself: the page never settles.
  "/drift": page(`<main id="pane" style="position:absolute;inset:0;overflow:auto"><h1>Feed</h1><div style="height:40000px"></div></main><script>const p=document.getElementById("pane");let y=0;setInterval(()=>{y=(y+7)%30000;p.scrollTop=y},16)</script>`, "html,body{height:100%;overflow:hidden}"),
  "/bidi": page(`<h1>Wallet</h1><p>\u2066AED 0.00\u2069</p><button type="button" aria-label="\u200fPay\u200e now">\u2067ادفع\u2069</button>`),
  // A link holding a heading and a paragraph (its text runs the two together with no space), and a sentence
  // whose part a target asks for.
  "/glued": page(`<h1>Groups</h1><a href="/glued"><h3>Practice groups</h3><p>Jumayah, a savings circle</p></a><section><h2>Pot order</h2><p><span>Sara Al-Amin</span> receives the pot this month, then Omar.</p></section>`),
  // Two marks far apart: no one screen holds both, at either size.
  "/tall": page(`<h1>Report</h1><div style="height:1500px"></div><button type="button">Export</button>`),
  "/login": page(`<h1>Welcome</h1><form><label>Email <input type="email" name="email"></label><button type="button">Continue</button></form>`),
};
async function site() {
  const server = createServer((req, res) => {
    const html = PAGES[new URL(req.url ?? "/", "http://x").pathname];
    if (!html) { res.statusCode = 404; res.end("missing"); return; }
    res.setHeader("content-type", "text/html; charset=utf-8"); res.end(html);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => { server.closeAllConnections(); server.close(); } };
}
interface ViewSpec { route: string; actions?: TourAction[]; marks?: TourTarget[] }
function script(origin: string, views: ViewSpec[], signIn?: TourSignIn): TourScript {
  const s: TourScript = {
    v: 1, title: "Made-up app", summary: "A made-up app.", audience: "A reviewer", outcome: "See the app.",
    source: { kind: "site", origin }, chapters: [{ id: "main", title: "Main" }], ...(signIn ? { signIn } : {}),
    steps: views.map((v, i) => ({ id: `step-${i + 1}`, chapter: "main", title: `Step ${i + 1}`, summary: "A step.", views: [{
      id: "view", title: "View", kind: "page" as const, note: "", route: v.route, sizes: ["desktop", "phone"] as ("desktop" | "phone")[],
      actions: { desktop: v.actions ?? [], phone: v.actions ?? [] }, marks: (v.marks ?? []).map(target => ({ target, label: "Made-up mark.", side: "right" as const })), masks: [],
    }] })),
  };
  assert.ok(normalizeTourScript(s), "fixture invalid");
  return s;
}
async function attempt(s: TourScript, dryRun: boolean): Promise<TourAttemptResult | TourFailure> {
  const root = mkdtempSync(join(tmpdir(), "tour-report-"));
  const context: TourRecordingContext = { sessionId: "report", sessionFile: join(root, "chat.jsonl"), cwd: root, agentDir: join(root, "agent"), sandbox: { on: false } };
  try {
    return await runTourAttempt({ context, script: s, tourId: "report", editionId: "report-edition", dryRun, beforeContact: async () => {} })
      .then(r => r, (e: unknown) => { if (e instanceof TourCaptureFailure) return e.failure; throw e; });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const failed = (r: TourAttemptResult | TourFailure): TourFailure => { assert.ok("message" in r, "expected a failure, got a recording"); return r; };
const recorded = (r: TourAttemptResult | TourFailure): TourAttemptResult => { assert.ok(!("message" in r), `expected a recording, got: ${"message" in r ? `${r.message} ${r.guidance}` : ""}`); return r as TourAttemptResult; };
const role = (r: string, name: string): TourTarget => ({ kind: "role", role: r, name });

test("a dry run reports every failing view at once, grouped, with nearby controls as targets; a recording stops at the first", { timeout: 180_000 }, async () => {
  const s = await site();
  try {
    const views: ViewSpec[] = [{ route: "/plain", marks: [{ kind: "text", text: "Overview" }] }, { route: "/fine" }, { route: "/plain", marks: [role("button", "Activity")] }];
    const report = failed(await attempt(script(s.origin, views), true));
    assert.equal(report.message, "The dry run found 4 problems in 2 views.");
    assert.equal(report.problems?.length, 2, "one group per distinct problem");
    const [two, zero] = report.problems!;
    assert.match(two!.message, /matched 2 visible controls/);
    assert.deepEqual(two!.at.map(a => `${a.stepId}/${a.size}`), ["step-1/desktop", "step-1/phone"]);
    assert.match(zero!.message, /matched 0 visible controls/);
    assert.deepEqual(zero!.at.map(a => a.stepId), ["step-3", "step-3"]);
    const nearby = JSON.stringify(zero!.nearby);
    assert.ok(nearby.includes(JSON.stringify({ target: role("tab", "Activity"), matches: 1 })), `the tab is offered by its real role: ${nearby}`);
    assert.ok(JSON.stringify(two!.nearby).includes(JSON.stringify({ target: role("heading", "Overview"), matches: 1 })), JSON.stringify(two!.nearby));
    // A recording keeps stopping at its first problem.
    const first = failed(await attempt(script(s.origin, views), false));
    assert.match(first.message, /^Target matched 2 visible controls; exactly 1 is required\.$/);
    assert.equal(first.problems, undefined);
    assert.equal(first.stepId, "step-1");
  } finally { s.close(); }
});

test("a dry run still stops at once on a safety stop, and after two views in a row that find none of their targets", { timeout: 180_000 }, async () => {
  const s = await site();
  try {
    const safety = failed(await attempt(script(s.origin, [{ route: "/plain", marks: [role("button", "Missing")] }, { route: "/alert" }, { route: "/plain", marks: [role("button", "Gone")] }]), true));
    assert.equal(safety.message, "Blocked a dialog requiring user input during recording.");
    assert.equal(safety.problems, undefined);
    const blind = failed(await attempt(script(s.origin, [{ route: "/blank", marks: [role("heading", "Invoices")] }, { route: "/blank", marks: [role("button", "Pay")] }, { route: "/plain", marks: [role("button", "Never reached")] }]), true));
    assert.equal(blind.message, "Two views in a row found none of their targets, so the dry run stopped there.");
    assert.deepEqual(blind.problems!.map(p => p.at.map(a => `${a.stepId}/${a.size}`)), [["step-1/desktop"], ["step-2/desktop"]], "it stopped at the second blind view");
  } finally { s.close(); }
});

test("reveal scrolls an inner panel and gets out from under a fixed bar; a bar it can't clear is named", { timeout: 180_000 }, async () => {
  const s = await site();
  try {
    const pay = role("button", "Pay invoice");
    for (const route of ["/panel", "/bar"]) {
      const r = recorded(await attempt(script(s.origin, [{ route, actions: [{ op: "reveal", target: pay }], marks: [pay] }]), false));
      for (const size of ["desktop", "phone"] as const) {
        const m = r.steps[0]!.views[0]!.captures[size]!.marks[0]!;
        assert.ok(m.y >= 0 && m.y + m.h <= 1.001, `${route} ${size}: the mark is on the screen: ${JSON.stringify(m)}`);
        if (route === "/bar") assert.ok(m.y + m.h <= (size === "desktop" ? (960 - 160) / 960 : (844 - 160) / 844) + 0.001, `${route} ${size}: above the bottom bar`);
      }
    }
    const covered = failed(await attempt(script(s.origin, [{ route: "/covered", actions: [{ op: "reveal", target: pay }] }]), false));
    assert.equal(covered.message, 'Target is covered by "Cookie banner", a fixed or sticky bar.');
  } finally { s.close(); }
});

test("the page isn't captured while an inner panel keeps scrolling", { timeout: 180_000 }, async () => {
  const s = await site();
  try {
    assert.equal(failed(await attempt(script(s.origin, [{ route: "/drift" }]), false)).message, TOUR_TARGET_MOVING);
  } finally { s.close(); }
});

test("text targets and role names ignore invisible direction marks", { timeout: 180_000 }, async () => {
  const s = await site();
  try {
    recorded(await attempt(script(s.origin, [{ route: "/bidi", marks: [{ kind: "text", text: "AED 0.00" }, role("button", "Pay now")] }]), true));
  } finally { s.close(); }
});

test("a sign-in page showing neither control lists the controls it does show, as targets", { timeout: 180_000 }, async () => {
  const s = await site();
  try {
    const signIn: TourSignIn = { route: "/login", username: role("textbox", "Username"), password: { kind: "testId", testId: "password" }, submit: role("button", "Sign in"), signedIn: role("heading", "Dashboard") };
    const neither = failed(await attempt(script(s.origin, [{ route: "/fine" }], signIn), true));
    assert.match(neither.message, /showed neither its signed-in control nor its password box/);
    const listed = JSON.stringify(neither.nearby);
    for (const t of [role("textbox", "Email"), role("button", "Continue"), role("heading", "Welcome")]) assert.ok(listed.includes(JSON.stringify({ target: t, matches: 1 })), `${JSON.stringify(t)} in ${listed}`);
    assert.match(neither.guidance, /vis_guide tour-signin/);
  } finally { s.close(); }
});

test("nearby: full names that start with the words asked for come first, read with a reader's spaces; a sentence's part offers the smallest element holding it", { timeout: 180_000 }, async () => {
  const s = await site();
  try {
    const report = failed(await attempt(script(s.origin, [{ route: "/glued", marks: [role("link", "Practice groups")] }, { route: "/glued", marks: [{ kind: "text", text: "Sara Al-Amin receives the pot" }] }]), true));
    const [link, sentence] = report.problems!;
    assert.deepEqual(link!.nearby?.[0], { target: role("link", "Practice groups Jumayah, a savings circle"), matches: 1 }, JSON.stringify(link!.nearby));
    for (const p of report.problems!) assert.ok(!JSON.stringify(p.nearby).includes("groupsJumayah"), `no glued words: ${JSON.stringify(p.nearby)}`);
    assert.deepEqual(sentence!.nearby?.[0], { target: { kind: "text", text: "Sara Al-Amin receives the pot this month, then Omar." }, matches: 1 }, JSON.stringify(sentence!.nearby));
  } finally { s.close(); }
});

test("marks spanning more than one screen at a size: the guidance says to split the view, never to drop marks", { timeout: 180_000 }, async () => {
  const s = await site();
  try {
    const report = failed(await attempt(script(s.origin, [{ route: "/tall", marks: [role("heading", "Report"), role("button", "Export")] }]), true));
    const outside = report.problems!.find(p => p.message === "Target is outside the captured screen.");
    assert.ok(outside, JSON.stringify(report));
    assert.match(outside!.guidance, /split this view into two at this size/);
    assert.match(outside!.guidance, /never drop marks/);
    // One mark alone below the screen keeps the reveal guidance.
    const single = failed(await attempt(script(s.origin, [{ route: "/tall", marks: [role("button", "Export")] }]), true));
    assert.doesNotMatch(single.problems![0]!.guidance, /split this view/);
    assert.match(single.problems![0]!.guidance, /reveal/);
  } finally { s.close(); }
});
