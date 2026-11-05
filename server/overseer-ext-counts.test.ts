// Run: pnpm test -- server/overseer-ext-counts.test.ts
// The Overseer's side of extension commands (§app.overseer/extension-commands) that lives in
// server/overseer.ts: sessions an extension reports count toward the Overseer's own running cap
// only, never toward a schedule's or auto-resume's slots; the {{EXT}} prompt part is written as
// given (no `$` patterns) and its titles and labels are one plain line. A throwaway
// PI_CODING_AGENT_DIR and extensions file; nothing listens anywhere.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

const tmp = mkdtempSync(join(tmpdir(), "sova-overseer-ext-counts-"));
process.env.PI_CODING_AGENT_DIR = join(tmp, "agent");
process.env.SOVA_EXTENSIONS_FILE = join(tmp, "extensions.json");
mkdirSync(join(tmp, "agent", "sova"), { recursive: true });
after(() => rmSync(tmp, { recursive: true, force: true }));

const { reportedCountsForTest, renderOverseerPrompt, extCommandsText } = await import("./overseer");
const { readOverseerSettings } = await import("./overseer-store");
const { disposeAllChats } = await import("./chat-manager");
after(async () => {
  await disposeAllChats();
});

describe("reported sessions", () => {
  test("count toward the Overseer's own cap while they run, never toward a schedule's or auto-resume's free slots", () => {
    const cap = readOverseerSettings().caps.concurrentSessions;
    const paths = ["/x/a.jsonl", "/x/b.jsonl", "/x/c.jsonl"];
    const none = reportedCountsForTest([], () => true);
    const all = reportedCountsForTest(paths, (p) => paths.includes(p));
    assert.equal(all.overseer, none.overseer + 3, "each running reported session counts for the Overseer");
    assert.equal(all.scheduleSlots, none.scheduleSlots, "a schedule's fire sees the same free slots");
    assert.equal(all.resumeSlots, none.resumeSlots, "auto-resume sees the same free slots");
    assert.equal(all.scheduleSlots, cap - none.overseer);
    // Once they stop running they count for no one.
    assert.equal(reportedCountsForTest(paths, () => false).overseer, 0);
  });
});

describe("the {{EXT}} prompt part", () => {
  test("filled as written: `$` patterns in it don't expand", () => {
    const ext = "  - ext.evil.go: Evil $` before $' after $& match $$ · Go";
    const out = renderOverseerPrompt([], readOverseerSettings(), "A\n{{EXT}}\nB", new Date(0), () => ({ redact: (t: string) => t }) as never, { EXT: ext });
    assert.equal(out, `A\n${ext}\nB`);
  });

  test("an extension's title and label are one plain line there, whatever reached the list", () => {
    // A title the manifest's own check would leave out (server/extensions.ts) isn't the only guard:
    // the line is written plain too.
    writeFileSync(
      process.env.SOVA_EXTENSIONS_FILE!,
      JSON.stringify({ version: 1, extensions: [{ id: "evil", title: "Evil", dist: "/abs/dist", api: "http://127.0.0.1:47916", commands: [{ name: "go", label: "Go >>now<<", overseer: true }] }] }),
    );
    assert.equal(extCommandsText(), "  - ext.evil.go: Evil · Go now");
  });
});
