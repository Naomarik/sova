// Run: pnpm test -- src/lib/background-jobs.test.ts
// The session pane's Background jobs section (§app.background-jobs/pane, §design.copy-deck/subagents-pane):
// a row's words, and the section as drawn (Solid's SSR build): absent with no job, one row per job
// with what runs, for how long, where its output goes (`No output file` when it has none), its
// worker, and Stop.
import assert from "node:assert/strict";
import { test } from "node:test";
import { jobKey, jobRowText, NO_OUTPUT_FILE } from "./background-jobs";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { BackgroundJobsView } = await importSsr(new URL("../components/BackgroundJobs.tsx", import.meta.url), (s: string) => import.meta.resolve(s));
type BackgroundJob = import("../../shared/protocol").BackgroundJob;

const NOW = Date.parse("2026-02-01T02:00:00.000Z");
const job = (over: Partial<BackgroundJob> = {}): BackgroundJob => ({
  id: "j1",
  sessionId: "s-1",
  command: "pnpm run lab > /home/u/lab.log 2>&1 &",
  cwd: "/home/u/work",
  kind: "kept",
  startedAt: NOW - (2 * 3600 + 17 * 60) * 1000,
  output: "/home/u/lab.log",
  noOutput: false,
  worker: null,
  stopping: false,
  ...over,
});

test("a row says what runs, for how long, and where its output goes", () => {
  const t = jobRowText(job(), NOW, "/home/u");
  assert.deepEqual([t.what, t.howLong, t.output, t.outputTitle, t.worker], ["pnpm run lab > /home/u/lab.log 2>&1 &", "2h 17m", "~/lab.log", "/home/u/lab.log", null]);
  // A multi-line command shows its first non-blank line; the title keeps it whole.
  const multi = jobRowText(job({ command: "\n  cd lab\nnpm start &" }), NOW, null);
  assert.equal(multi.what, "cd lab");
  assert.equal(multi.command, "\n  cd lab\nnpm start &");
  // No file, or a flagged closed output: `No output file`, never a path.
  assert.equal(jobRowText(job({ output: null }), NOW, null).output, NO_OUTPUT_FILE);
  assert.equal(jobRowText(job({ noOutput: true }), NOW, null).output, NO_OUTPUT_FILE);
  assert.equal(NO_OUTPUT_FILE, "No output file");
  assert.equal(jobRowText(job({ worker: "w2" }), NOW, null).worker, "w2");
  // A worker's j1 is not its main chat's j1.
  assert.notEqual(jobKey(job()), jobKey(job({ sessionId: "s-w" })));
});

const draw = (jobs: BackgroundJob[], stopping: (j: BackgroundJob) => boolean = () => false) =>
  renderToString(() => solid.createComponent(BackgroundJobsView as never, { jobs, now: NOW, home: "/home/u", labelId: "sp-jobs-label", stopping, onStop: () => {} } as never))
    .replace(/ data-hk="[^"]*"/g, "")
    .replace(/<!--[^>]*-->/g, "");

test("the section is absent while no job runs", () => {
  assert.equal(draw([]), "");
});

test("the section: a heading, then one row per job with Stop", () => {
  const html = draw([job(), job({ id: "j2", sessionId: "s-w", worker: "w1", output: null, noOutput: true, command: "sleep 600 &" })], (j) => j.id === "j2");
  assert.match(html, /^<section class="stack-2" aria-labelledby="sp-jobs-label"><h3 class="text-eyebrow" id="sp-jobs-label">Background jobs<\/h3><ul class="list">/);
  const rows = html.split('<li class="list-row">').slice(1);
  assert.equal(rows.length, 2);
  assert.match(rows[0]!, /<p class="list-title text-mono" title="pnpm run lab > \/home\/u\/lab.log 2>&amp;1 &amp;">pnpm run lab > \/home\/u\/lab.log 2>&amp;1 &amp;<\/p>/);
  assert.match(rows[0]!, /<p class="list-meta"><span class="text-num">2h 17m<\/span> · <span class="text-mono" title="\/home\/u\/lab.log">~\/lab.log<\/span><\/p>/);
  assert.match(rows[0]!, /<button type="button" class="button button-sm" aria-label="Stop job j1">Stop<\/button>/);
  // The worker's job: `No output file`, its worker id, and a Stop that waits while it stops.
  assert.match(rows[1]!, /<span class="text-num">2h 17m<\/span> · <span>No output file<\/span> · <span class="text-mono">w1<\/span><\/p>/);
  assert.match(rows[1]!, /<button type="button" class="button button-sm" disabled aria-busy="true" aria-label="Stop job j2">Stop<\/button>/);
});
