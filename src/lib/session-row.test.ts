// Run: pnpm test -- src/lib/session-row.test.ts
// A row in the sessions pane (§app.session-list/anatomy, §app.extensions/row-chips): with no
// extension adding to rows, every row is exactly the row it was before line 3 became a place, its
// readiness badge included. Drawn with Solid's SSR build (src/lib/align-card-ssr.mjs) and compared
// with session-row.snapshot.json, taken from the rows as they stood before the place existed (base
// 9d508bba). Hydration keys and marker comments are left out: they say how Solid drew it, not what
// the page holds. Regenerate only for a change you mean:
// WRITE_ROW_SNAPSHOT=1 pnpm test -- src/lib/session-row.test.ts
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { SessionRow } = await importSsr(new URL("../components/Sidebar.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
const mesh = await import("./mesh");
const { RowPlaceContext } = await import("./row-place");
type RowChip = import("./row-place").RowChip;
type SessionSummary = import("../../shared/protocol").SessionSummary;
type SessionReadiness = import("../../shared/protocol").SessionReadiness;

const SNAPSHOT = new URL("./session-row.snapshot.json", import.meta.url);
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

const tree = (branch: string, state: SessionReadiness["trees"][number]["state"], merged = false) => ({ path: `/work/${branch}`, branch, state, ...(merged ? { merged: true as const } : {}) });

/** Every line-3 shape a row has today: no readiness, a count alone, each badge, a remote row. */
const ROWS: Record<string, SessionSummary> = {
  plain: session(),
  "no model": session({ model: null }),
  "count only": session({ readiness: { trees: [tree("feat/a", "ready"), tree("feat/b", "in-progress")], since: 0 } }),
  "restart pending": session({ readiness: { trees: [tree("feat/a", "merged", true)], badge: "restart", since: 0, restartPending: true } }),
  "2 follow-ups": session({
    readiness: { trees: [tree("feat/a", "merged", true), tree("feat/c", "stale", true)], badge: "merged", since: 0, followUps: 2, followUp: { weight: "small", cue: "tidy the docs" } },
  }),
  "merged, no follow-up": session({ readiness: { trees: [tree("feat/a", "merged", true)], badge: "merged", since: 0 } }),
  remote: session({ id: "s-r", path: "/peer/sessions/r.jsonl", readiness: { trees: [tree("feat/r", "merged", true)], badge: "restart", since: 0 } }),
};
mesh.noteHost("/peer/sessions/r.jsonl", "peer-1");

/** The row's markup, without Solid's hydration keys and marker comments. */
const drawRow = (s: SessionSummary, wrap?: (children: () => unknown) => unknown): string =>
  renderToString(() => {
    const row = () => solid.createComponent(SessionRow as never, { session: s, selected: null, now: NOW, targets: [] } as never);
    return (wrap ? wrap(row) : row()) as never;
  })
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/<!--[^>]*-->/g, "");

test("with no extension adding to rows, every row is exactly the row it was", () => {
  const drawn = Object.fromEntries(Object.entries(ROWS).map(([name, s]) => [name, drawRow(s)]));
  if (process.env.WRITE_ROW_SNAPSHOT) writeFileSync(SNAPSHOT, JSON.stringify(drawn, null, 2) + "\n");
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(drawn), Object.keys(snapshot));
  for (const name of Object.keys(snapshot)) assert.equal(drawn[name], snapshot[name], name);
  // The fixtures reach every shape: the badge in both words, and none.
  assert.match(snapshot["restart pending"]!, /<span class="session-readiness" title="[^"]*">restart pending<\/span>/);
  assert.match(snapshot["2 follow-ups"]!, />2 follow-ups<\/span>/);
  assert.doesNotMatch(snapshot.plain!, /session-readiness/);
});

test("what extensions add stands after the readiness badge and before the model, as plain text", () => {
  const chips: RowChip[] = [
    { extension: "ci", extensionTitle: "CI", label: "CI green", tone: "ok", title: "All 12 checks passed" },
    { extension: "pr", extensionTitle: "Reviews", label: "PR 12", tone: "muted" },
  ];
  const withChips = (children: () => unknown) =>
    solid.createComponent(RowPlaceContext.Provider, {
      value: (s: SessionSummary) => (s.id === "s-1" ? chips : undefined),
      get children() {
        return children() as never;
      },
    });
  const html = drawRow(ROWS["restart pending"]!, withChips);
  const meta = html.slice(html.indexOf('<p class="list-meta">'));
  assert.match(
    meta,
    /restart pending<\/span> · <span class="session-row-chip session-row-chip-ok" title="All 12 checks passed · From CI"><span class="chip-dot" aria-hidden="true"><\/span>CI green<span class="visually-hidden">, from CI<\/span><\/span> · <span class="session-row-chip" title="PR 12 · From Reviews"><span class="chip-dot" aria-hidden="true"><\/span>PR 12<span class="visually-hidden">, from Reviews<\/span><\/span> · <span class="text-mono"/,
  );
  // Everything else on the row is exactly the snapshot's.
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Record<string, string>;
  assert.equal(html.replace(/ · <span class="session-row-chip[^]*?<\/span><\/span>/g, ""), snapshot["restart pending"]);
  // Another session in the same pane shows none.
  assert.equal(drawRow({ ...ROWS.plain!, id: "s-2" }, withChips), snapshot.plain);
});
