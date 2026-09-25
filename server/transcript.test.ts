// Run: npx tsx --test server/transcript.test.ts
// Creates a few files directly in /tmp, and an attachments root in a throwaway
// PI_CODING_AGENT_DIR (attachmentsRoot reads it per call), and removes them afterwards.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { attachmentsRoot, checkTmpImage, inlineTmpImages, MAX_ATTACHMENTS_PER_ROW, readTmpImage } from "./attachments";
import { findTmpImagePaths } from "../shared/tmp-paths";
import { parseReport, previewLine } from "./reports";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { normalizeEntries, normalizeEntry } from "./transcript";

const created: string[] = [];
function tmpFile(name: string, bytes = "png-bytes"): string {
  const p = `/tmp/${name}`;
  writeFileSync(p, bytes);
  created.push(p);
  return p;
}
after(() => {
  // Newest first, so symlinks go before their targets (rmSync can't see a dangling link).
  for (const p of created.reverse()) rmSync(p, { recursive: true, force: true });
});

const tag = randomUUID().slice(0, 8);
const clip = tmpFile(`pi-clipboard-${randomUUID()}.png`);
const wsl = tmpFile(`pi-wsl-clip-${randomUUID()}.png`);
const typed = tmpFile(`sova-test-${tag}.JPG`);
const gone = `/tmp/pi-clipboard-${randomUUID()}.png`; // never created
const webUpload = tmpFile(`sova-${randomUUID()}.png`);
const webNotUuid = tmpFile(`sova-notauuid-${tag}.png`);

const userEntry = (text: string) => ({
  type: "message",
  id: "u1",
  parentId: null,
  timestamp: "2026-09-19T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text }], timestamp: 0 },
});

describe("inlineTmpImages", () => {
  test("a pi clipboard path becomes an attachment and leaves the text", () => {
    const r = inlineTmpImages(`is there a way to do what VS Code does ${clip} to get this minimap?`, true);
    assert.equal(r.text, "is there a way to do what VS Code does to get this minimap?");
    assert.deepEqual(r.attachments, [
      { path: clip, name: clip.slice(5), mimeType: "image/png", size: 9, available: true },
    ]);
  });

  test("both pi shapes are recognized and removed", () => {
    const r = inlineTmpImages(`look\n${clip}\n${wsl} here`, true);
    assert.equal(r.text, "look\n\nhere");
    assert.deepEqual(r.attachments?.map((a) => a.path), [clip, wsl]);
  });

  test("text that is only the path is omitted", () => {
    const r = inlineTmpImages(`  ${clip}\n`, true);
    assert.equal(r.text, undefined);
    assert.equal(r.attachments?.length, 1);
  });

  test("adjacent pasted paths collapse to one space", () => {
    assert.equal(inlineTmpImages(`a ${clip} ${wsl} b`, true).text, "a b");
  });

  test("a missing file is available:false with no size", () => {
    const r = inlineTmpImages(`see ${gone}`, true);
    assert.equal(r.text, "see");
    assert.deepEqual(r.attachments, [{ path: gone, name: gone.slice(5), mimeType: "image/png", available: false }]);
  });

  test("a /tmp image the user typed stays in the text but still attaches", () => {
    const r = inlineTmpImages(`compare ${typed}.`, true);
    assert.equal(r.text, `compare ${typed}.`);
    assert.equal(r.attachments?.[0]?.mimeType, "image/jpeg");
    assert.equal(r.attachments?.[0]?.available, true);
  });

  test("non-/tmp, subfolder, non-image and glued paths are ignored", () => {
    for (const text of [
      "/home/me/shot.png",
      "/tmpfoo/x.png",
      "/tmp/sub/x.png",
      "/tmp/notes.txt",
      "/var/tmp/x.png",
      "./tmp/x.png",
      "/tmp/x.png/y",
      "/tmp/.hidden.png",
    ]) {
      const r = inlineTmpImages(`see ${text} ok`, true);
      assert.equal(r.attachments, undefined, text);
      assert.equal(r.text, `see ${text} ok`, text);
    }
  });

  test("without strip (every row but user rows) the text is kept as-is", () => {
    const r = inlineTmpImages(`report: ${clip} done`);
    assert.equal(r.text, `report: ${clip} done`);
    assert.equal(r.attachments?.[0]?.path, clip);
  });

  test("wildcards, placeholders and elided names are not paths", () => {
    for (const text of [
      "inline /tmp/pi-clipboard-*.png paths render as raw text",
      "shapes: /tmp/pi-clipboard-<uuid>.png and /tmp/pi-wsl-clip-<uuid>.png",
      "(line 54, /tmp/pi-clipboard-fc038d6a-….png)",
      "/tmp/<name>.png|jpg|jpeg|webp|gif",
      "/tmp/*.png",
    ]) {
      const r = inlineTmpImages(text, true);
      assert.equal(r.attachments, undefined, text);
      assert.equal(r.text, text, text);
    }
  });

  test("paths inside markdown code spans and fences are not paths", () => {
    for (const text of [
      `the file \`${clip}\` is gone`,
      `double \`\` ${clip} \`\` ticks`,
      `\`\`\`\nls ${clip}\n\`\`\``,
      `~~~text\n${clip}\n~~~`,
      `unclosed fence\n\`\`\`\n${clip}`,
    ]) {
      const r = inlineTmpImages(text, true);
      assert.equal(r.attachments, undefined, text);
      assert.equal(r.text, text, text);
    }
  });

  test("the same path in code and in prose: only the prose one counts", () => {
    const r = inlineTmpImages(`\`${clip}\` and ${clip}`, true);
    assert.equal(r.attachments?.length, 1);
    assert.equal(r.text, `\`${clip}\` and`);
  });

  test("a lone backtick doesn't hide the rest of the text", () => {
    assert.equal(inlineTmpImages(`it's \` odd ${clip}`).attachments?.length, 1);
  });

  test(`at most ${MAX_ATTACHMENTS_PER_ROW} distinct paths per row; duplicates count once`, () => {
    const many = Array.from({ length: 11 }, (_, i) => `/tmp/sova-cap-${tag}-${i}.png`);
    const r = inlineTmpImages(`${many.join(" ")} ${many[0]}`);
    assert.equal(r.attachments?.length, MAX_ATTACHMENTS_PER_ROW);
    assert.deepEqual(r.attachments?.map((a) => a.path), many.slice(0, MAX_ATTACHMENTS_PER_ROW));
    assert.ok(r.attachments?.every((a) => a.available === false));
  });

  test("text without paths is returned unchanged (including empty)", () => {
    assert.deepEqual(inlineTmpImages("hello  world "), { text: "hello  world " });
    assert.deepEqual(inlineTmpImages(""), { text: "" });
  });

  test("a Sova upload path (sova-<uuid>) leaves the text and attaches, like a clipboard paste", () => {
    const r = inlineTmpImages(`what's this?\n${webUpload}`, true);
    assert.equal(r.text, "what's this?");
    assert.deepEqual(r.attachments, [{ path: webUpload, name: webUpload.slice(5), mimeType: "image/png", size: 9, available: true }]);
  });

  test("a sova- name without a uuid is typed text: it stays, still attached", () => {
    const r = inlineTmpImages(`compare ${webNotUuid}`, true);
    assert.equal(r.text, `compare ${webNotUuid}`);
    assert.equal(r.attachments?.[0]?.path, webNotUuid);
  });

  test("an upload's .part file never matches", () => {
    const part = `/tmp/.${webUpload.slice(5)}.part`;
    assert.deepEqual(inlineTmpImages(`see ${part}`, true), { text: `see ${part}` });
    assert.equal(checkTmpImage(part).ok, false);
  });
});

describe("normalizeEntry (user rows)", () => {
  test("attachments are set, text normalized, raw untouched", () => {
    const entry = userEntry(`fix this ${clip}`);
    const before = JSON.stringify(entry);
    const [it] = normalizeEntry(entry);
    assert.equal(it?.kind, "user");
    assert.equal(it?.text, "fix this");
    assert.equal(it?.attachments?.[0]?.path, clip);
    assert.equal(JSON.stringify(it?.raw), before);
  });

  test("a Sova upload path on its own line after the text becomes an attachment", () => {
    const [web] = normalizeEntry(userEntry(`fix this\n${webUpload}`));
    assert.equal(web?.text, "fix this");
    assert.equal(web?.attachments?.[0]?.path, webUpload);
  });

  test("a path-only message has no text and keeps stored images", () => {
    const entry = userEntry(gone);
    entry.message.content.push({ type: "image", data: "AAAA", mimeType: "image/png" } as never);
    const [it] = normalizeEntry(entry);
    assert.equal(it?.text, undefined);
    assert.deepEqual(it?.images, ["data:image/png;base64,AAAA"]);
    assert.equal(it?.attachments?.[0]?.available, false);
  });

  test("a tagged user message becomes a wake row, its text intact and its fields parsed", () => {
    const text = [
      "[wake_nudge n4] Scheduled wakeup fired (set 4m17s ago).",
      "Overdue by 3m17s (pi was not running).",
      "Reason: check the deploy",
      "Continue the pending work; re-schedule if still not ready. Prioritize any newer user message.",
    ].join("\n");
    const entry = userEntry(text);
    const before = JSON.stringify(entry);
    const [it] = normalizeEntry(entry);
    assert.equal(it?.kind, "wake");
    assert.equal(it?.text, text);
    assert.deepEqual(it?.wake, { id: "n4", late: "3m17s", reason: "check the deploy" });
    assert.equal(JSON.stringify(it?.raw), before);
  });

  test("an ordinary user message stays kind user, even one that mentions wake_nudge later on", () => {
    const [it] = normalizeEntry(userEntry("can you use wake_nudge here?\n[wake_nudge n1] not the first line"));
    assert.equal(it?.kind, "user");
    assert.equal(it?.wake, undefined);
  });

  test("assistant text keeps its text and gets attachments per block", () => {
    const entry = {
      type: "message",
      id: "a1",
      message: { role: "assistant", content: [{ type: "text", text: `| file |\n|---|\n| ${clip} |` }, { type: "text", text: "no paths" }] },
    };
    const [first, second] = normalizeEntry(entry);
    assert.equal(first?.kind, "assistant-text");
    assert.equal(first?.text, `| file |\n|---|\n| ${clip} |`);
    assert.equal(first?.attachments?.[0]?.path, clip);
    assert.equal(second?.attachments, undefined);
  });

  test("subagent reports become report rows; attachments come from the body; short custom-role messages stay info", () => {
    const body = `**Done.** Screenshot at ${gone}; the pattern \`/tmp/pi-clipboard-*.png\` is quoted.`;
    const [rep] = normalizeEntry({ type: "custom_message", id: "c1", customType: "subagent-complete", display: true, content: body });
    assert.equal(rep?.kind, "report");
    assert.equal(rep?.text, body);
    assert.deepEqual(rep?.attachments, [{ path: gone, name: gone.slice(5), mimeType: "image/png", available: false }]);
    const [msg] = normalizeEntry({ type: "message", id: "c2", message: { role: "custom", content: [{ type: "text", text: `see ${wsl}` }] } });
    assert.equal(msg?.kind, "info");
    assert.equal(msg?.attachments?.[0]?.path, wsl);
    assert.equal(normalizeEntry({ type: "custom_message", id: "c3", display: false, content: `${clip}` }).length, 0);
  });

  test("tool results: detected in the full output, not just the truncated text", () => {
    const text = `${"x".repeat(3000)}\n${clip}`;
    const [it] = normalizeEntry({ type: "message", id: "t1", message: { role: "toolResult", toolCallId: "call1", content: [{ type: "text", text }] } });
    assert.equal(it?.kind, "tool-result");
    assert.ok(!it?.text?.includes(clip));
    assert.equal(it?.attachments?.[0]?.path, clip);
  });

  test("a plain message has no attachments field", () => {
    const [it] = normalizeEntry(userEntry("hi"));
    assert.equal(it?.text, "hi");
    assert.equal("attachments" in (it ?? {}), false);
  });
});

describe("checkTmpImage (GET /api/attachment)", () => {
  const dir = `/tmp/sova-test-${tag}`;
  mkdirSync(dir);
  created.push(dir);
  const inner = `${dir}/inner.png`;
  writeFileSync(inner, "x");
  const linkOut = `/tmp/sova-test-${tag}-out.png`;
  symlinkSync("/etc/hosts", linkOut); // outside /tmp, and present on Linux and macOS alike
  created.push(linkOut);
  const linkSub = `/tmp/sova-test-${tag}-sub.png`;
  symlinkSync(inner, linkSub);
  created.push(linkSub);
  const linkIn = `/tmp/sova-test-${tag}-in.png`;
  symlinkSync(clip, linkIn);
  created.push(linkIn);
  const notImage = `/tmp/sova-test-${tag}-txt.png`;
  symlinkSync(tmpFile(`sova-test-${tag}.txt`), notImage);
  created.push(notImage);

  test("a real image directly in /tmp is ok", () => {
    const r = checkTmpImage(clip);
    // realPath is resolved: on macOS /tmp is itself a link to /private/tmp.
    assert.deepEqual(r, { ok: true, realPath: realpathSync(clip), mimeType: "image/png", size: 9 });
  });

  test("bad shapes are 400 (traversal, subfolders, other dirs, non-images, non-strings)", () => {
    for (const p of [
      "/tmp/../etc/passwd",
      "/tmp/../etc/x.png",
      "/tmp/./x.png",
      "/tmpfoo/x.png",
      "/tmp/a/b.png",
      inner,
      "/etc/passwd",
      "tmp/x.png",
      "/tmp/x.txt",
      "/tmp/.x.png",
      "/tmp/x.png\0",
      "",
      undefined,
    ]) {
      const r = checkTmpImage(p);
      assert.equal(r.ok, false, String(p));
      if (!r.ok) assert.equal(r.status, 400, String(p));
    }
  });

  test("a missing file is 404", () => {
    const r = checkTmpImage(gone);
    assert.equal(r.ok ? 0 : r.status, 404);
  });

  test("symlinks resolving outside /tmp, into a subfolder, or to a non-image are 403", () => {
    for (const p of [linkOut, linkSub, notImage]) {
      const r = checkTmpImage(p);
      assert.equal(r.ok ? 0 : r.status, 403, p);
    }
  });

  test("a symlink to an image directly in /tmp resolves to it", () => {
    const r = checkTmpImage(linkIn);
    assert.equal(r.ok && r.realPath, realpathSync(clip));
  });

  test("readTmpImage reads the file and refuses a symlink", async () => {
    assert.equal((await readTmpImage(clip))?.toString(), "png-bytes");
    assert.equal(await readTmpImage(linkOut), null);
  });
});

describe("report rows (subagent-complete and long custom messages)", () => {
  const cm = (content: unknown, customType = "subagent-complete") => normalizeEntry({ type: "custom_message", id: "r1", customType, display: true, content })[0]!;
  const finalOutput = [
    "All requested checks pass. Report for items 5 and 6, plus the item 1 flag check.",
    "",
    "**Item 1 flag survived item 5**: `topic-outline-headless` is still passed via `extensionFlagValues`.",
    "",
    "| a | b |",
    "|---|---|",
    "| 1 | 2 |",
    "",
    "```ts",
    "const x = 1;   // spacing kept",
    "```",
  ].join("\n");

  test("full header with outcome, Session, body verbatim", () => {
    const it = cm(`### ag_01 (orchestrator) — waiting · task success\nSession: 24306cf1-13fa-4541-8931-446cec254aa7\n${finalOutput}`);
    assert.equal(it.kind, "report");
    assert.deepEqual(it.report, {
      source: "subagent-complete",
      truncated: false,
      agent: { id: "ag_01", name: "orchestrator", status: "waiting", outcome: "success" },
      session: "24306cf1-13fa-4541-8931-446cec254aa7",
      body: finalOutput,
      preview: "All requested checks pass. Report for items 5 and 6, plus the item 1 flag check.",
    });
    assert.equal(it.text, finalOutput);
  });

  test("no outcome, no Session line; names with spaces and parentheses", () => {
    const r = parseReport("subagent-complete", "### ag_12 (ui (review) team) — running\nStill going.");
    assert.deepEqual(r.agent, { id: "ag_12", name: "ui (review) team", status: "running" });
    assert.equal(r.session, undefined);
    assert.equal(r.body, "Still going.");
  });

  test("Error line, then Session, then the placeholder body", () => {
    const r = parseReport("subagent-complete", "### ag_03 (runner) — error · task error\nError: spawn ENOENT\nSession: /tmp/s.jsonl\n(no output for this task)");
    assert.equal(r.error, "spawn ENOENT");
    assert.equal(r.session, "/tmp/s.jsonl");
    assert.equal(r.body, "(no output for this task)");
    assert.deepEqual(r.agent, { id: "ag_03", name: "runner", status: "error", outcome: "error" });
  });

  test("the 4000-character trailer becomes truncated:true and leaves the body", () => {
    const body = `${"a".repeat(3950)}\n## cut here`;
    const r = parseReport("subagent-complete", `### ag_02 (x) — waiting · task success\n${body}\n[Use agent_transcript for more.]`);
    assert.equal(r.truncated, true);
    assert.equal(r.body, body);
    assert.ok(!r.body.includes("agent_transcript"));
  });

  test("the older header: 'Subagent <id> (<name>) finished its task.' / 'was killed.'", () => {
    const r = parseReport("subagent-complete", "Subagent ag_01 (ui-review) finished its task.\n\nFinal output:\nAll green: **24/24**.");
    assert.deepEqual(r.agent, { id: "ag_01", name: "ui-review", status: "done" });
    assert.equal(r.body, "All green: **24/24**.");
    assert.equal(parseReport("subagent-complete", "Subagent ag_01 (essayist) was killed.").agent?.status, "killed");
  });

  test("a subagent-complete that doesn't parse is still a report (left-aligned markdown), never info", () => {
    const it = cm("something else entirely");
    assert.equal(it.kind, "report");
    assert.equal(it.report?.agent, undefined);
    assert.equal(it.report?.body, "something else entirely");
  });

  test("other long or multi-line custom messages become reports; short one-liners stay info", () => {
    const intercom = "**From claude-runner-worker** (/home/user)\n\n_id 79ed · seq 1_\n\nRunner proposal: …";
    const long = cm(intercom, "intercom_message");
    assert.equal(long.kind, "report");
    assert.equal(long.report?.source, "intercom_message");
    assert.equal(long.report?.preview, "From claude-runner-worker (/home/user)");
    assert.equal(cm("x".repeat(201), "note").kind, "report");
    const short = cm("Compaction notice: kept 12 messages.", "note");
    assert.equal(short.kind, "info");
    assert.equal(short.text, "Compaction notice: kept 12 messages.");
    assert.equal(short.report, undefined);
  });

  test("content as text blocks works the same as a string", () => {
    const it = cm([{ type: "text", text: "### ag_05 (qa) — waiting · task success" }, { type: "text", text: "Ok." }]);
    assert.equal(it.report?.agent?.id, "ag_05");
    assert.equal(it.report?.body, "Ok.");
  });

  test("previewLine strips the markdown that would show as marks", () => {
    assert.equal(previewLine("\n\n## The three failures\nmore"), "The three failures");
    assert.equal(previewLine("- **Item 5**: `npm test` [docs](http://x) _done_"), "Item 5: npm test docs done");
    assert.equal(previewLine(""), "");
  });
});

describe("model attribution", () => {
  const assistantEntry = (id: string, text: string, provider?: string, model?: string) => ({
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-09-19T00:00:00.000Z",
    message: { role: "assistant", provider, model, content: [{ type: "text", text }], stopReason: "stop" },
  });
  const changeEntry = (id: string, provider: string, modelId: string) => ({
    type: "model_change",
    id,
    parentId: null,
    timestamp: "2026-09-19T00:00:00.000Z",
    provider,
    modelId,
  });

  test("assistant rows carry their own provider/model", () => {
    const items = normalizeEntry(assistantEntry("a1", "hi", "zai", "glm-5.3"));
    const rows = items.filter((i) => i.kind === "assistant-text");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.model, "zai/glm-5.3");
  });

  test("rows without their own model fall back to the nearest prior model_change", () => {
    const items = normalizeEntries([
      changeEntry("c1", "ollama-cloud", "deepseek-v4.1-flash"),
      assistantEntry("a1", "one"),
      changeEntry("c2", "zai", "glm-5.3"),
      assistantEntry("a2", "two"),
      assistantEntry("a3", "three", "openai", "gpt-5.5"),
    ]);
    const rows = items.filter((i) => i.kind === "assistant-text");
    assert.deepEqual(
      rows.map((r) => r.model),
      ["ollama-cloud/deepseek-v4.1-flash", "zai/glm-5.3", "openai/gpt-5.5"],
    );
  });

  test("user and info rows carry no model", () => {
    const items = normalizeEntries([
      userEntry("question"),
      assistantEntry("a1", "hi", "zai", "glm-5.3"),
      changeEntry("c1", "zai", "glm-5.3"),
    ]);
    for (const it of items) if (it.kind !== "assistant-text") assert.equal(it.model, undefined);
  });
});

describe("btw thread entries", () => {
  const btwEntry = (id: string, data: unknown, customType = "btw-thread-entry") => ({
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-09-19T00:00:00.000Z",
    customType,
    data,
  });

  test("an answered exchange becomes a report row labeled btw", () => {
    const items = normalizeEntry(
      btwEntry("b1", { question: "what landed today?", answer: "Two fixes shipped.", provider: "zai", model: "glm-5.3" }),
    );
    assert.equal(items.length, 1);
    const it = items[0]!;
    assert.equal(it.kind, "report");
    assert.equal(it.report?.source, "btw-thread-entry");
    assert.equal(it.report?.agent?.name, "what landed today?");
    assert.equal(it.report?.body, "Two fixes shipped.");
    assert.equal(it.model, "zai/glm-5.3");
  });

  test("entries without an answer, resets and overrides stay hidden", () => {
    assert.deepEqual(normalizeEntry(btwEntry("b1", { question: "hi" })), []);
    assert.deepEqual(normalizeEntry(btwEntry("b2", { answer: "" }, "btw-thread-reset")), []);
    assert.deepEqual(normalizeEntry(btwEntry("b3", { model: "glm-5.3" }, "btw-model-override")), []);
  });
});

describe("align-doc entries", () => {
  const alignEntry = (id: string, data: unknown) => ({
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-09-20T00:00:00.000Z",
    customType: "align-doc",
    data,
  });
  const markdown = [
    "## Alignment: Web align viewer",
    "",
    "### Findings",
    "- transcript rows come from server/transcript.ts",
    "",
    "### Approach",
    "- reuse the report kind",
    "",
    "### Open questions",
    "1. [x] Reuse report rows? — yes, source align-doc",
    "2. [ ] Show every revision?",
    "3. [ ] Keybinding?",
    "",
    "### Rejected",
    "- [ ] a new EntryKind",
    "",
    "### Status",
    "aligning",
  ].join("\n");
  const doc = (over: Record<string, unknown> = {}) => ({
    version: 1,
    title: "Web align viewer",
    markdown,
    questions: [
      { n: 1, text: "Reuse report rows?", checked: true },
      { n: 2, text: "Show every revision?", checked: false },
      { n: 3, text: "Keybinding?", checked: false },
    ],
    revision: 3,
    capturedAt: "2026-09-20T00:00:00.000Z",
    ...over,
  });

  test("a full doc becomes a report row: markdown verbatim, checklists kept, metrics from the payload", () => {
    const [it, ...rest] = normalizeEntry(alignEntry("al1", { version: 1, doc: doc() }));
    assert.equal(rest.length, 0);
    assert.equal(it!.kind, "report");
    assert.equal(it!.text, markdown);
    assert.equal(it!.report?.source, "align-doc");
    assert.equal(it!.report?.body, markdown);
    assert.match(it!.report!.body, /^2\. \[ \] Show every revision\?$/m);
    assert.match(it!.report!.body, /^1\. \[x\] Reuse report rows\? — yes/m);
    assert.equal(it!.report?.preview, "Alignment: Web align viewer");
    assert.equal(it!.report?.agent, undefined);
    assert.equal(it!.report?.truncated, false);
    assert.deepEqual(it!.report?.align, {
      status: "questions-open",
      title: "Web align viewer",
      lines: markdown.split("\n").length,
      open: 2,
      settled: 1,
      total: 3,
      revision: 3,
    });
  });

  test("status: explicit implementing/confirmed win; all settled is ready; no questions is aligning", () => {
    const status = (d: unknown) => normalizeEntry(alignEntry("al", { version: 1, doc: d }))[0]?.report?.align?.status;
    assert.equal(status(doc({ explicitStatus: "implementing" })), "implementing");
    assert.equal(status(doc({ explicitStatus: "confirmed" })), "confirmed");
    assert.equal(status(doc({ explicitStatus: "aligning" })), "questions-open");
    assert.equal(status(doc({ questions: [{ n: 1, text: "a", checked: true }] })), "ready");
    assert.equal(status(doc({ questions: [] })), "aligning");
  });

  test("a minimal doc (no revision, no explicitStatus) defaults revision to 0", () => {
    const md = "## Alignment: Just started";
    const align = normalizeEntry(alignEntry("al2", { version: 1, doc: { title: "Just started", markdown: md, questions: [] } }))[0]?.report?.align;
    assert.deepEqual(align, { status: "aligning", title: "Just started", lines: 1, open: 0, settled: 0, total: 0, revision: 0 });
  });

  test("cleared, empty and malformed payloads yield no row", () => {
    for (const data of [
      { version: 1, doc: null },
      { version: 1, doc: { markdown: "   \n" } },
      { version: 1, doc: { markdown: 42 } },
      { version: 1, doc: doc({ questions: undefined }) }, // align.ts is the only parser: no markdown fallback
      { version: 1, doc: doc({ questions: "1. [ ] x" }) },
      { version: 1, doc: doc({ title: undefined }) },
      { version: 1, doc: "## Alignment: x" },
      { version: 1 },
      null,
      "garbage",
    ]) {
      assert.deepEqual(normalizeEntry(alignEntry("al", data)), [], JSON.stringify(data));
    }
  });

  test("only the newest align-doc on the branch renders; a newest clear hides older revisions", () => {
    const user = userEntry("hi");
    const r1 = alignEntry("al1", { version: 1, doc: doc({ revision: 1 }) });
    const r2 = alignEntry("al2", { version: 1, doc: doc({ revision: 2 }) });
    const rows = normalizeEntries([r1, user, r2]);
    assert.deepEqual(rows.map((r) => r.id), ["u1", "al2"]);
    assert.equal(rows[1]!.report?.align?.revision, 2);
    assert.deepEqual(normalizeEntries([r1, r2, alignEntry("al3", { version: 1, doc: null })]).map((r) => r.id), []);
    assert.deepEqual(normalizeEntries([r1, alignEntry("al3", { version: 1, doc: { markdown: 1 } })]).map((r) => r.id), []);
  });

  test("an older session without align data is unchanged: no align rows, other custom entries still hidden", () => {
    const rows = normalizeEntries([
      userEntry("hi"),
      { type: "custom", id: "x1", parentId: "u1", customType: "topic-outline", data: { doc: { markdown: "## Alignment: no" } } },
      { type: "custom_message", id: "m1", parentId: "x1", customType: "note", content: "short", display: true },
    ]);
    assert.deepEqual(rows.map((r) => [r.id, r.kind]), [["u1", "user"], ["m1", "info"]]);
    assert.ok(rows.every((r) => r.report?.align === undefined));
  });
});

describe("pi 0.86.0 entries the TUI keeps out of the conversation", () => {
  test("a system message and a usage entry render nothing at all", () => {
    const system = {
      type: "message", id: "s1", parentId: "u1", message: { role: "system", content: "",
        sections: { preamble: "You are an expert coding assistant", tools: "<tools>...</tools>" },
        toolsAdded: ["read"], toolsRemoved: [] },
    };
    const usage = { type: "usage", id: "w1", parentId: "s1", kind: "cache_warm", provider: "anthropic", model: "m",
      usage: { input: 0, output: 0, cacheRead: 50_000, cacheWrite: 0, totalTokens: 50_000 } };
    assert.deepEqual(normalizeEntry(system), []);
    assert.deepEqual(normalizeEntry(usage), []);
    assert.deepEqual(normalizeEntry({ ...usage, kind: "something-new" }), [], "an unknown kind is hidden too");
    const rows = normalizeEntries([system, userEntry("hi"), usage]);
    assert.deepEqual(rows.map((r) => [r.id, r.kind]), [["u1", "user"]]);
    assert.ok(rows.every((r) => r.kind !== "unknown"), "nothing renders as an unrecognized entry");
  });
});

describe("pi 0.87.0 context edits", () => {
  test("a context_edit, as the real SessionManager writes it, renders nothing and leaves its target's row alone", () => {
    // Built by the pinned SDK itself, not by hand: this is the entry pi appends when it drops an
    // abandoned attempt after a retried error (`_omitRecoveryAttempt`), and the one an extension
    // gets from appendContextEdit with a replacement.
    const sm = SessionManager.inMemory("/tmp");
    sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
    const failed = sm.appendMessage({
      role: "assistant", content: [], provider: "p", model: "m", api: "openai-completions", stopReason: "error",
      errorMessage: "overloaded", timestamp: 2,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    sm.appendContextEdit(failed, null);
    sm.appendContextEdit(failed, { content: [{ type: "text", text: "replaced for the model" }] });
    const entries = sm.getEntries() as Record<string, any>[];
    const edits = entries.filter((e) => e.type === "context_edit");
    assert.equal(edits.length, 2, "the SDK wrote both edits as context_edit entries");
    for (const edit of edits) assert.deepEqual(normalizeEntry(edit), [], `${JSON.stringify(edit)} renders nothing`);
    const rows = normalizeEntries(entries);
    assert.ok(rows.every((r) => r.kind !== "unknown"), "nothing renders as an unrecognized entry");
    assert.deepEqual(rows, normalizeEntries(entries.filter((e) => e.type !== "context_edit")),
      "the rows are exactly those without the edits: the edited message keeps its recorded row");
  });
});

describe("attachments root (composer-draft uploads)", () => {
  const agentDir = realpathSync(mkdtempSync(join(tmpdir(), "sova-transcript-test-")));
  created.unshift(agentDir); // removed last, after the links below
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sid = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";
  const root = join(agentDir, "sova", "attachments");
  mkdirSync(join(root, sid), { recursive: true });
  const upload = join(root, sid, `sova-${randomUUID()}.png`);
  writeFileSync(upload, "png-bytes");
  // Same tail, wrong place: another dir that merely ends in /sova/attachments/<id>/.
  const lookalikeDir = join(agentDir, "other", "sova", "attachments", sid);
  mkdirSync(lookalikeDir, { recursive: true });
  const lookalike = join(lookalikeDir, "x.png");
  writeFileSync(lookalike, "png-bytes");
  const escape = join(root, sid, "escape.png");
  symlinkSync(lookalike, escape);
  const linkedSession = join(root, "linked");
  symlinkSync(lookalikeDir, linkedSession);
  const deep = join(root, sid, "sub");
  mkdirSync(deep);
  writeFileSync(join(deep, "y.png"), "x");

  test("attachmentsRoot follows PI_CODING_AGENT_DIR", () => assert.equal(attachmentsRoot(), root));

  test("an image in a session folder under the root is ok", () => {
    assert.deepEqual(checkTmpImage(upload), { ok: true, realPath: upload, mimeType: "image/png", size: 9 });
  });

  test("/tmp is still recognised", () => assert.equal(checkTmpImage(clip).ok, true));

  test("lookalikes outside the root, traversal and extra depth are 400", () => {
    for (const p of [
      lookalike,
      `/sova/attachments/${sid}/x.png`,
      `${root}/${sid}/../${sid}/${upload.split("/").pop()}`,
      `${root}/../attachments/${sid}/x.png`,
      `${root}/./${sid}/x.png`,
      `${root}/${sid}/sub/y.png`,
      `${root}/${sid}/.hidden.png`,
      `${root}/${sid}/x.txt`,
      `${root}/x.png`,
      `${root}/.${sid}/x.png`,
    ]) {
      const r = checkTmpImage(p);
      assert.equal(r.ok ? 0 : r.status, 400, p);
    }
  });

  test("a symlink out of the root (file or session folder) is 403; a missing file is 404", () => {
    assert.equal(((r) => (r.ok ? 0 : r.status))(checkTmpImage(escape)), 403);
    assert.equal(((r) => (r.ok ? 0 : r.status))(checkTmpImage(join(linkedSession, "x.png"))), 403);
    assert.equal(((r) => (r.ok ? 0 : r.status))(checkTmpImage(join(root, sid, "gone.png"))), 404);
  });

  test("readTmpImage reads it", async () => assert.equal((await readTmpImage(upload))?.toString(), "png-bytes"));

  test("findTmpImagePaths matches the tail, keeps boundaries, order and code masking", () => {
    const text = `a ${upload} b ${clip} \`${upload}\` ~/.pi/agent/sova/attachments/${sid}/z.png rel/sova/attachments/${sid}/z.png ${lookalike}.`;
    assert.deepEqual(
      findTmpImagePaths(text).map((m) => m.path),
      [upload, clip, lookalike],
    );
    for (const m of findTmpImagePaths(text)) assert.equal(text.slice(m.start, m.end), m.path);
    assert.deepEqual(findTmpImagePaths(`${root}/${sid}/sub/y.png ${root}/${sid}/x.png/more`), []);
  });

  test("inlineTmpImages: an upload path leaves user text and attaches; a lookalike is unavailable", () => {
    const r = inlineTmpImages(`what's this?\n${upload}`, true);
    assert.equal(r.text, "what's this?");
    assert.deepEqual(r.attachments, [{ path: upload, name: upload.split("/").pop(), mimeType: "image/png", size: 9, available: true }]);
    assert.equal(inlineTmpImages(`see ${lookalike}`).attachments?.[0]?.available, false);
  });
});

// §chat.transcript: the sandbox extension's `sandbox` entry (one per flip) is state, not a row.
// The web draws no marker for it; the composer's shield says the state instead.
test("the sandbox extension's entries render as nothing, on and off alike", () => {
  const entries = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "hi", timestamp: 1 } },
    { type: "custom", id: "s1", parentId: "u1", customType: "sandbox", data: { version: 1, on: true, level: "workspace-write", backend: "linux-bwrap", enforcement: "full" } },
    { type: "custom", id: "s2", parentId: "s1", customType: "sandbox", data: { version: 1, on: true, level: "workspace-write", backend: "linux-bwrap", enforcement: "unavailable", reasons: ["bwrap missing"] } },
    { type: "custom", id: "s3", parentId: "s2", customType: "sandbox", data: { version: 1, on: false, level: "workspace-write", backend: "none", enforcement: "none" } },
  ];
  for (const e of entries.slice(1)) assert.deepEqual(normalizeEntry(e), [], e.id);
  const items = normalizeEntries(entries);
  assert.equal(items.length, 1);
  assert.ok(!JSON.stringify(items).includes("Sandbox"), "no sandbox text reaches the transcript");
});
