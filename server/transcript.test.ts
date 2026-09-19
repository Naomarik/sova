// Run: npx tsx --test server/transcript.test.ts
// Creates a few files directly in /tmp and removes them afterwards.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { after, describe, test } from "node:test";
import { checkTmpImage, inlineTmpImages, MAX_ATTACHMENTS_PER_ROW, readTmpImage } from "./attachments";
import { parseReport, previewLine } from "./reports";
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
const typed = tmpFile(`pi-web-test-${tag}.JPG`);
const gone = `/tmp/pi-clipboard-${randomUUID()}.png`; // never created

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
    const many = Array.from({ length: 11 }, (_, i) => `/tmp/pi-web-cap-${tag}-${i}.png`);
    const r = inlineTmpImages(`${many.join(" ")} ${many[0]}`);
    assert.equal(r.attachments?.length, MAX_ATTACHMENTS_PER_ROW);
    assert.deepEqual(r.attachments?.map((a) => a.path), many.slice(0, MAX_ATTACHMENTS_PER_ROW));
    assert.ok(r.attachments?.every((a) => a.available === false));
  });

  test("text without paths is returned unchanged (including empty)", () => {
    assert.deepEqual(inlineTmpImages("hello  world "), { text: "hello  world " });
    assert.deepEqual(inlineTmpImages(""), { text: "" });
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

  test("a path-only message has no text and keeps stored images", () => {
    const entry = userEntry(gone);
    entry.message.content.push({ type: "image", data: "AAAA", mimeType: "image/png" } as never);
    const [it] = normalizeEntry(entry);
    assert.equal(it?.text, undefined);
    assert.deepEqual(it?.images, ["data:image/png;base64,AAAA"]);
    assert.equal(it?.attachments?.[0]?.available, false);
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
  const dir = `/tmp/pi-web-test-${tag}`;
  mkdirSync(dir);
  created.push(dir);
  const inner = `${dir}/inner.png`;
  writeFileSync(inner, "x");
  const linkOut = `/tmp/pi-web-test-${tag}-out.png`;
  symlinkSync("/etc/hostname", linkOut);
  created.push(linkOut);
  const linkSub = `/tmp/pi-web-test-${tag}-sub.png`;
  symlinkSync(inner, linkSub);
  created.push(linkSub);
  const linkIn = `/tmp/pi-web-test-${tag}-in.png`;
  symlinkSync(clip, linkIn);
  created.push(linkIn);
  const notImage = `/tmp/pi-web-test-${tag}-txt.png`;
  symlinkSync(tmpFile(`pi-web-test-${tag}.txt`), notImage);
  created.push(notImage);

  test("a real image directly in /tmp is ok", () => {
    const r = checkTmpImage(clip);
    assert.deepEqual(r, { ok: true, realPath: clip, mimeType: "image/png", size: 9 });
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
    assert.equal(r.ok && r.realPath, clip);
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
