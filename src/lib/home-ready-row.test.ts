// The Ready to merge row as the overview's project card draws it (§app.projects/home-cards), rendered server-side:
// a link to the Merge Queue tab only while the queue serves the project; "—" and no link for one it doesn't serve,
// a muted "…" (still the tab's link) while a served project's first view is read.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProjectGlance } from "../../shared/projects";
import { cardRuntime } from "./home-glance";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const { renderToString } = await import("solid-js/web");
const { ReadyToMerge } = await importSsr(new URL("../components/OverviewProjects.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
const html = (fn: () => unknown) => renderToString(fn as never).replaceAll(/<!--[^>]*-->/g, "");

const HREF = "#/projects/prj_a/merge-queue";
const glance = (x: Partial<ProjectGlance>): ProjectGlance => ({ projectId: "prj_a", merge: "unserved", queue: null, slots: null, memory: { chatsBytes: 0, copiesBytes: 0 }, release: null, ...x });
const row = (g: ProjectGlance | undefined) => html(() => ReadyToMerge({ ready: cardRuntime(g, null, 0).ready, href: HREF }));

test("unserved: — and not a link; before the first glance likewise", () => {
  for (const out of [row(glance({})), row(undefined)]) {
    assert.ok(!/<a\b/.test(out), out);
    assert.match(out, /Ready to merge/);
    assert.match(out, /—/);
  }
});

test("served: the count, a link to the Merge Queue tab; reading: a muted …, still the tab's link", () => {
  const served = row(glance({ merge: "served", queue: { ready: 2, inLine: 1, waiting: 1, target: "main", at: "x" } }));
  assert.match(served, new RegExp(`<a [^>]*href="${HREF}"`));
  assert.match(served, />2</);
  const reading = row(glance({ merge: "reading" }));
  assert.match(reading, new RegExp(`<a [^>]*href="${HREF}"`));
  assert.match(reading, /…/);
  assert.ok(!/—/.test(reading), "never the unserved dash");
});
