// Run: pnpm exec tsx --test src/lib/org-page-route.test.ts. Solid's reactive (browser) build, not
// the inert server build node resolves by default: the bug lives between re-runs of the graph.
import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(s, c, next) { return next(s === "solid-js" ? "solid-js/dist/solid.js" : s, c); }`,
    ),
  import.meta.url,
);
const solid = await import("solid-js");
const { orgPageRoute } = await import("./org-page-route");
import type { Accessor } from "solid-js";
import type { OrgsRoute } from "./orgs-route";

/** App's shape: a session Match before the orgs Match, whose children get the non-keyed accessor.
    `readStart` builds the page's `start` from that accessor; `closeForm` reads it the way the start
    form's Cancel does, from an event handler (no owner). Returns the route setters and the view. */
function app(readStart: (r: Accessor<OrgsRoute>) => () => string | undefined) {
  return solid.createRoot(() => {
    const [session, setSession] = solid.createSignal<string | null>(null);
    const [orgs, setOrgs] = solid.createSignal<OrgsRoute | null>({ kind: "org", id: "org_1", start: "p_1" });
    let start!: () => string | undefined;
    const view = solid.Switch({
      get children() {
        return [
          solid.Match({ get when() { return session(); }, children: "session" }),
          solid.Match({
            get when() { return orgs(); },
            children: (r: Accessor<OrgsRoute>) => {
              start = readStart(r);
              return "org page";
            },
          }),
        ];
      },
    }) as unknown as Accessor<unknown>;
    // What the screen shows: the DOM follows the view through an effect, as insert() does.
    let shown: unknown;
    solid.createRenderEffect(() => (shown = view()));
    const closeForm = () => solid.runWithOwner(null, () => start());
    // onHash: one setter after another, unbatched.
    const openSession = () => {
      setSession("s.jsonl");
      setOrgs(null);
    };
    return { view: () => shown, closeForm, openSession };
  });
}

test("a session link after the start form closes leaves the org page (the page's own memos)", () => {
  const a = app((r) => orgPageRoute(r).start);
  assert.equal(a.view(), "org page");
  assert.equal(a.closeForm(), "p_1");
  a.openSession();
  assert.equal(a.view(), "session");
});

test("control: the compiled ternary getter, read from a handler, breaks that route change", () => {
  // What `start={props.route.kind === "org" ? props.route.start : undefined}` compiles to.
  const a = app((r) => () => (solid.createMemo(() => r().kind === "org")() ? (r() as { start?: string }).start : undefined));
  assert.equal(a.closeForm(), "p_1");
  assert.throws(() => a.openSession(), /Stale read/);
  assert.equal(a.view(), "org page");
});
