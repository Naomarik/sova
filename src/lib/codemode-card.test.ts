// Run: pnpm test -- src/lib/codemode-card.test.ts. The codemode card (§chat.transcript/codemode-card),
// rendered: the folded line (code icon, the script's first line, the calls), and the body's Script, Calls
// and Output; plus the DOM-free readers the server's slim rows share (src/lib/message.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { argsSummary, codemodeDetails, codemodeHead, codemodeTally, codemodeTallyText } from "./message";

// @ts-expect-error untyped .mjs import
const { importSsr } = await import("./align-card-ssr.mjs");
const solid = await import("solid-js");
const { renderToString } = await import("solid-js/web");
const { ToolCard, CodemodeBody } = await importSsr(new URL("../components/ToolCard.tsx", import.meta.url), (s: string) => import.meta.resolve(s));

const draw = (component: unknown, props: unknown): string => renderToString(() => solid.createComponent(component as never, props as never));
/** The text a reader gets: tags out (a quoted attribute may hold a `>`), entities decoded. */
const text = (html: string) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:[^>"]|"[^"]*")*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const SCRIPT = `// @options: {"timeout_ms": 60000}

const files = await Promise.all(["a.ts", "b.ts", "c.ts"].map((path) => tools.read({ path })));
return files.length;`;

const DETAILS = {
  calls: [
    { id: "call-1/1", name: "read", args: '{"path":"a.ts"}', status: "ok", durationMs: 12 },
    { id: "call-1/2", name: "read", args: '{"path":"b.ts"}', status: "error", durationMs: 1500, error: "ENOENT: b.ts" },
    { id: "call-1/3", name: "read", args: '{"path":"c.ts"}', status: "running" },
    { id: "call-1/models.classify/1", name: "models.classify", args: "typesafe/jev-latest", status: "ok", durationMs: 300, cost: 0.004 },
  ],
  fullOutputPath: "/tmp/pi-codemode-x.txt",
};

test("readers: the folded line is the script's first real line, never the whole script; calls tally from details", () => {
  assert.equal(codemodeHead(SCRIPT), 'const files = await Promise.all(["a.ts", "b.ts", "c.ts"].map((path) => tools.read({ path })));');
  assert.equal(codemodeHead("\n\n  return 1\n"), "return 1");
  assert.equal(codemodeHead("// @options: {}\n"), "");
  assert.equal(argsSummary({ code: SCRIPT }, "codemode"), codemodeHead(SCRIPT));
  assert.equal(argsSummary({ code: SCRIPT }), SCRIPT, "other tools keep the first-string rule");
  const d = codemodeDetails(DETAILS)!;
  assert.equal(d.calls.length, 4);
  assert.equal(d.fullOutputPath, "/tmp/pi-codemode-x.txt");
  assert.deepEqual(codemodeTally(d.calls), { total: 4, failed: 1, running: 1 });
  assert.equal(codemodeTallyText(codemodeTally(d.calls)), "4 calls · 1 failed · 1 running");
  assert.equal(codemodeTallyText({ total: 1, failed: 0, running: 0 }), "1 call");
  assert.equal(codemodeTallyText({ total: 0, failed: 0, running: 0 }), "");
  for (const bad of [null, {}, { calls: "x" }]) assert.equal(codemodeDetails(bad), null);
  assert.deepEqual(codemodeDetails({ calls: [{ name: "read", status: "weird" }, 3, { status: "ok" }] })!.calls.map((c) => [c.name, c.status]), [["read", "error"]], "malformed calls are dropped or read as failed, never trusted");
});

test("DOM: the folded card shows the code icon, the script's head and the calls; a row's tally stands in until details come", () => {
  const live = draw(ToolCard, { name: "codemode", args: { code: SCRIPT }, details: DETAILS, status: "running" });
  assert.match(live, /icons\/code\.svg/);
  assert.match(text(live), /codemode const files = await Promise\.all/);
  assert.doesNotMatch(live, /return files\.length/, "never the whole script on the folded line");
  assert.match(text(live), /4 calls · 1 failed · 1 running/);
  const lazy = draw(ToolCard, { name: "codemode", args: undefined, summary: codemodeHead(SCRIPT), calls: { total: 4, failed: 1, running: 0 }, status: "done" });
  assert.match(text(lazy), /4 calls · 1 failed Done/);
  const none = draw(ToolCard, { name: "codemode", args: { code: "return 1" }, details: { calls: [] }, status: "done" });
  assert.doesNotMatch(none, /toolcard-calls/, "no count before the first call");
  const other = draw(ToolCard, { name: "bash", args: { command: "ls" }, status: "done" });
  assert.doesNotMatch(other, /toolcard-calls|code\.svg/);
});

test("DOM: the body is the Script (highlighted, with Copy), the Calls with status, duration, cost and error, then the Output and the full output's file", () => {
  const html = draw(CodemodeBody, { name: "codemode", args: { code: SCRIPT }, details: DETAILS, status: "error", output: "Script failed\nWall time 1.6 seconds\nOutput:\n", live: true, script: SCRIPT });
  const t = text(html);
  const at = (s: string) => t.indexOf(s);
  assert.ok(at("Script") < at("Calls") && at("Calls") < at("Error"), `sections in order: ${t.slice(0, 200)}`);
  assert.match(html, /hljs language-javascript/, "highlighted as JavaScript");
  assert.match(t, /Copy Script/);
  assert.match(t, /read \{"path":"a\.ts"\} 12 ms Done/);
  assert.match(t, /read \{"path":"b\.ts"\} 1\.5 s Failed ENOENT: b\.ts/);
  assert.match(t, /read \{"path":"c\.ts"\} Running/);
  assert.match(t, /models\.classify model call typesafe\/jev-latest 300 ms <\$0\.01 Done/);
  assert.match(t, /Error Copy Output Script failed/, "a failed script's output is labelled Error");
  assert.match(t, /Full output: \/tmp\/pi-codemode-x\.txt/);
  assert.doesNotMatch(t, /Arguments/, "the script is not repeated as JSON arguments");
  const empty = text(draw(CodemodeBody, { name: "codemode", args: { code: "return 1" }, details: { calls: [] }, status: "done", output: "Script completed\n", live: true, script: "return 1" }));
  assert.match(empty, /Calls No calls\./);
});
