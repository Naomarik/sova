// Run: pnpm test -- server/harness/pi/reader.test.ts. The neutral reader (§app.harness/reader,
// §app.harness/unknown-entries): on every pi fixture the golden harness has (synthetic, faux, the generated
// large session and, when present, the local real corpus) the reader's branch is today's activeBranch entry
// for entry, its rows and context fill are today's, and a held session reads as pi reads it.
import assert from "node:assert/strict";
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import type { HEntry } from "../../../shared/harness";
import { stripImageNotes } from "../../../shared/image-note";
import { normalizeEntries, normalizeEntry, rowsOf, rowsOfEntry } from "../../transcript";
import { fixtureSets } from "./golden/golden";
import { largeSessionText } from "./golden/fixtures/large.ts";
import {
  activeBranch, BranchScan, branchOf, firstText, historyOf, joinedText, lineEntry, lineHead, lineHeader, lineMay, liveRead, parseLines, parsePi,
  rawOf, readBranch, readTailBranch, resetUnknownEntries, toHEntry, typedText, unknownEntries, type Entry,
} from "./reader";
import { loadPi } from "./testing/load-pi.ts";
import { contextForBranch, contextOfBranch, contextStep, messageContextTokens, piContextOf } from "./usage";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "sova-pi-reader-")));
after(() => rmSync(dir, { recursive: true, force: true }));

/** Every pi fixture: name, text, and whether pi's own reader should agree on its branch (well-formed trees). */
const fixtures: { set: string; name: string; text: string; path: string; private: boolean }[] = [];
for (const set of fixtureSets()) for (const fx of set.fixtures) if (fx.format === "pi") fixtures.push({ set: set.name, name: fx.name, text: readFileSync(fx.path, "utf8"), path: fx.path, private: set.private });
{
  const path = join(dir, "large-10mb.jsonl");
  writeFileSync(path, largeSessionText());
  fixtures.push({ set: "large", name: "large-10mb", text: readFileSync(path, "utf8"), path, private: false });
}
const label = (f: (typeof fixtures)[number]) => (f.private ? `real/${f.path.split("/").pop()!.slice(0, 12)}` : `${f.set}/${f.name}`);

describe("branch-rule parity: branchOf(parsePi) is activeBranch(parseLines), entry for entry", () => {
  for (const f of fixtures)
    test(label(f), () => {
      const raw = parseLines(f.text);
      const old = activeBranch(raw);
      const history = historyOf(raw);
      const branch = branchOf(history);
      // The same raw objects, in the same order: every reader that moves keeps its input.
      assert.equal(branch.length, old.length, "branch length");
      branch.forEach((h, i) => assert.equal(rawOf(h), old[i], `entry ${i}`));
      // 1:1 with the raw entries, unknown ones included; only headers are left out.
      assert.equal(history.length, raw.filter((e) => e.type !== "session").length);
      // parsePi's own parse gives the same ids and the first header.
      const file = parsePi(f.text);
      assert.deepEqual(branchOf(file.entries).map((h) => h.id), old.map((e) => (typeof e.id === "string" ? e.id : null)));
      const header = raw.find((e) => e.type === "session");
      assert.equal(file.header?.id, header?.id);
      assert.equal(file.header?.cwd, header?.cwd);
    });
});

describe("rowsOf(history) is normalizeEntries(raw branch), byte for byte", () => {
  for (const f of fixtures)
    test(label(f), () => {
      const raw = parseLines(f.text);
      const want = JSON.stringify(normalizeEntries(activeBranch(raw)));
      assert.equal(JSON.stringify(rowsOf(branchOf(historyOf(raw)))), want);
      // rowsOfEntry, as the live path calls normalizeEntry for one appended entry.
      const state: { model?: string } = {};
      const stateOld: { model?: string } = {};
      for (const [i, h] of historyOf(raw).entries())
        assert.equal(JSON.stringify(rowsOfEntry(h, `line${i}`, state)), JSON.stringify(normalizeEntry(rawOf(h), `line${i}`, stateOld)));
    });
});

describe("context fill: the HEntry rules equal the raw ones", () => {
  for (const f of fixtures)
    test(label(f), () => {
      const raw = parseLines(f.text);
      const history = historyOf(raw);
      assert.deepEqual(contextOfBranch(branchOf(history)), contextForBranch(activeBranch(raw)));
      for (const h of history) {
        const e = rawOf(h);
        assert.equal(contextStep(h), piContextOf(e), `contextStep ${h.id}`);
        const tokens = messageContextTokens(e.message);
        assert.equal(h.kind === "assistant" ? (h.contextTokens ?? null) : null, e.type === "message" ? tokens : null, `contextTokens ${h.id}`);
      }
    });
});

describe("kinds", () => {
  const all = (name: string) => historyOf(parseLines(fixtures.find((f) => f.set === "synthetic" && f.name === name)!.text));

  test("all-types: every entry pi 0.87.1 writes has its kind; none is unknown", () => {
    const kinds = new Set(all("all-types").map((h) => (h.kind === "setting" ? `setting:${h.what}` : h.kind === "summary" ? `summary:${h.of}:${h.inMessage}` : h.kind === "note" ? `note:${h.inMessage}` : h.kind)));
    assert.deepEqual([...kinds].sort(), [
      "assistant", "compaction", "context-edit", "note:false", "note:true", "setting:label", "setting:model", "setting:name", "setting:thinking", "shell",
      "state", "summary:branch:false", "summary:branch:true", "summary:compaction:true", "system", "tool-result", "usage-record", "user",
    ]);
  });

  test("blocks are pi's own array (no copy) unless one is unknown, which is wrapped", () => {
    for (const h of all("all-types")) {
      if (!("blocks" in h)) continue;
      const content = rawOf(h).message.content;
      if (typeof content === "string") assert.deepEqual(h.blocks, [{ type: "text", text: content }]);
      else if (h.blocks.some((b) => b.type === "unknown")) {
        assert.notEqual(h.blocks, content);
        h.blocks.forEach((b, i) => assert.equal(b.type === "unknown" ? b.raw : b, content[i]));
      } else assert.equal(h.blocks, content);
    }
    assert.ok(all("all-types").some((h) => "blocks" in h && h.blocks.some((b) => b.type === "unknown")), "the fixture has an unknown block");
  });

  test("fields are pi's, as written", () => {
    const a = all("all-types").find((h): h is Extract<HEntry, { kind: "assistant" }> => h.kind === "assistant" && h.usage !== undefined)!;
    const m = rawOf(a).message;
    assert.equal(a.provider, m.provider);
    assert.equal(a.model, m.model);
    assert.equal(a.stop, m.stopReason);
    assert.equal(a.sentAt, m.timestamp);
    assert.equal(a.at, rawOf(a).timestamp);
    assert.equal(a.usage!.input, m.usage.input);
    assert.equal(a.usage!.cost, m.usage.cost?.total);
    const s = all("all-types").find((h) => h.kind === "state")!;
    assert.equal((s as { key: string }).key, rawOf(s).customType);
    assert.equal((s as { data: unknown }).data, rawOf(s).data);
  });

  test("cacheWrite1h is carried when pi recorded it", () => {
    const h = toHEntry({ type: "message", id: "x", parentId: null, message: { role: "assistant", content: [], usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 40, cacheWrite1h: 30, cost: { total: 0.5 } } } });
    assert.deepEqual(h && h.kind === "assistant" ? h.usage : null, { input: 1, output: 2, cacheRead: 3, cacheWrite: 40, cacheWrite1h: 30, cost: 0.5 });
    assert.equal(h?.kind === "assistant" ? h.contextTokens : null, 44);
  });

  test("the header is never an entry; a non-object is nothing", () => {
    assert.equal(toHEntry({ type: "session", id: "s" }), null);
    assert.equal(toHEntry("x"), null);
    assert.equal(toHEntry(null), null);
  });
});

describe("unknown entries (§app.harness/unknown-entries)", () => {
  test("an unknown type or role is kind unknown, keeps its place in the tree, and carries nothing else", () => {
    const history = historyOf(parseLines(fixtures.find((f) => f.name === "unknown")!.text));
    const unknown = history.filter((h) => h.kind === "unknown");
    assert.deepEqual(unknown.map((h) => [h.id, (h as { type: string }).type]), [["b0000002", "future_entry"], ["b0000004", "message/future_role"], ["b0000005", "future_entry"]]);
    for (const h of unknown) assert.deepEqual(Object.keys(h).sort(), ["at", "id", "kind", "parentId", "type"]);
    const branch = branchOf(history);
    assert.equal(branch.at(-1)!.id, "b0000005", "an unknown entry can be the leaf");
  });

  test("each is counted once by (type, id), across reads; an id-less one once per type", () => {
    resetUnknownEntries();
    const text = fixtures.find((f) => f.name === "unknown")!.text;
    parsePi(text);
    assert.equal(unknownEntries(), 3);
    parsePi(text);
    historyOf(parseLines(text));
    assert.equal(unknownEntries(), 3, "a second read counts nothing new");
    parsePi(fixtures.find((f) => f.name === "unknown-noid")!.text);
    assert.equal(unknownEntries(), 4, "the id-less future_entry: (future_entry, null)");
    parsePi(fixtures.find((f) => f.set === "synthetic" && f.name === "all-types")!.text);
    assert.equal(unknownEntries(), 4, "a known file adds nothing (an unknown block is not an unknown entry)");
  });

  test("the transcript's rows count the same entries, once each with the reader's reads", () => {
    const text = fixtures.find((f) => f.name === "unknown")!.text;
    resetUnknownEntries();
    normalizeEntries(activeBranch(parseLines(text)));
    assert.equal(unknownEntries(), 3, "the Unrecognized rows' entries");
    parsePi(text);
    for (const e of parseLines(text)) normalizeEntry(e);
    assert.equal(unknownEntries(), 3, "the same (type, id) pairs whichever path read them");
    resetUnknownEntries();
  });

  test("a type's ids are capped, so the count stays bounded", () => {
    resetUnknownEntries();
    for (let i = 0; i < 10_050; i++) toHEntry({ type: "flood", id: `f${i}` });
    assert.equal(unknownEntries(), 10_000);
    resetUnknownEntries();
  });

  test("id-less entries keep today's legacy-linear flattening (pinned, fixture unknown-noid)", () => {
    const branch = branchOf(parsePi(fixtures.find((f) => f.name === "unknown-noid")!.text).entries);
    assert.deepEqual(branch.map((h) => h.id), ["c0000001", "c0000002", "c0000003", "c0000004", null, "c0000005"]);
  });
});

describe("files", () => {
  const all = fixtures.find((f) => f.set === "synthetic" && f.name === "all-types")!;

  test("readBranch reads a file as parsePi + branchOf", async () => {
    assert.deepEqual((await readBranch(all.path)).map((h) => h.id), branchOf(parsePi(all.text).entries).map((h) => h.id));
  });

  test("readTailBranch: the whole file when it fits; else the branch of the window, its cut first line dropped", async () => {
    const whole = await readTailBranch(all.path, 1 << 30);
    assert.deepEqual(whole.map((h) => h.id), branchOf(parsePi(all.text).entries).map((h) => h.id));
    const tail = await readTailBranch(all.path, 4096);
    const bytes = readFileSync(all.path);
    const window = bytes.subarray(bytes.length - 4096).toString("utf8");
    const want = activeBranch(parseLines(window.slice(window.indexOf("\n") + 1)));
    assert.deepEqual(tail.map((h) => h.id), want.map((e) => e.id));
  });

  test("line scanners: head, prefilters, one entry, the header", () => {
    const lines = all.text.split("\n").filter(Boolean);
    assert.equal(lineHeader(lines[0]!)?.cwd, JSON.parse(lines[0]!).cwd);
    assert.equal(lineHeader(lines[1]!), null);
    for (const line of lines.slice(1)) {
      const raw = JSON.parse(line) as Entry;
      const head = lineHead(line);
      if (head) assert.deepEqual(head, { type: raw.type, id: raw.id, parentId: raw.parentId ?? null });
      assert.equal(lineEntry(line)?.id, typeof raw.id === "string" ? raw.id : null);
      assert.equal(lineEntry(Buffer.from(line))?.id, lineEntry(line)?.id);
      // A prefilter never misses: false means the line holds no such entry.
      if (raw.type === "message" && raw.message?.role === "user") assert.ok(lineMay(line, "user"));
      if (raw.type === "message" && raw.message?.role === "toolResult") assert.ok(lineMay(line, "toolResult") && lineMay(line, { tool: raw.message.toolName }));
      if (raw.type === "custom") assert.ok(lineMay(line, { state: raw.customType }));
      if (raw.type === "custom_message") assert.ok(lineMay(line, { note: raw.customType }));
    }
    assert.equal(lineEntry(""), null);
    assert.equal(lineEntry("{torn"), null);
  });

  test("BranchScan: grown in pieces (a torn line in between) equals one full read; a rewrite starts over", async () => {
    for (const f of fixtures.filter((x) => !x.private && x.set !== "large")) {
      const path = join(dir, `scan-${f.set}-${f.name}.jsonl`);
      const keep = (line: string) => {
        try {
          const v = JSON.parse(line);
          return v && typeof v === "object" ? { type: v.type, id: v.id, parentId: v.parentId } : null;
        } catch {
          return null;
        }
      };
      const full = new BranchScan(keep);
      copyFileSync(f.path, path);
      await full.grow(path, Buffer.byteLength(f.text));
      const grown = new BranchScan(keep);
      const bytes = Buffer.from(f.text);
      writeFileSync(path, "");
      for (const cut of [Math.floor(bytes.length / 3), Math.floor(bytes.length / 2) + 7, bytes.length]) {
        writeFileSync(path, bytes.subarray(0, cut));
        await grown.grow(path, cut);
      }
      assert.deepEqual(grown.items, full.items, `${f.name}: items`);
      assert.deepEqual(grown.branch().map((e) => e.id), activeBranch(parseLines(f.text).map((e) => ({ type: e.type, id: e.id, parentId: e.parentId }))).map((e) => e.id), `${f.name}: branch`);
      // Rewritten shorter: the scan starts over.
      writeFileSync(path, bytes.subarray(0, Math.floor(bytes.length / 4)));
      appendFileSync(path, "");
      const small = Math.floor(bytes.length / 4);
      await grown.grow(path, small);
      const fresh = new BranchScan(keep);
      await fresh.grow(path, small);
      assert.deepEqual(grown.items, fresh.items, `${f.name}: after a rewrite`);
    }
  });
});

describe("display text", () => {
  test("typedText strips pi's image notes from user text only; firstText and joinedText read the blocks", () => {
    const fx = fixtures.filter((f) => !f.private && f.set !== "large");
    let stripped = 0;
    for (const f of fx)
      for (const h of historyOf(parseLines(f.text))) {
        if (!("blocks" in h)) continue;
        const content = rawOf(h).message.content;
        const texts = h.blocks.filter((b) => b.type === "text") as { text: string }[];
        const want = h.kind === "user" && texts[0] ? stripImageNotes(texts[0].text, content) : texts[0]?.text;
        assert.equal(firstText(h), want);
        if (h.kind === "user" && texts[0] && want !== texts[0].text) stripped++;
        if (typeof content !== "string") {
          const joined = content.flatMap((b: any) => (b?.type === "text" && typeof b.text === "string" ? [b.text] : b?.type === "image" ? ["[image]"] : [])).join("\n");
          assert.equal(joinedText(h), joined);
          assert.equal(typedText(joined, h), h.kind === "user" ? stripImageNotes(joined, content) : joined);
        }
      }
    assert.ok(stripped >= 1, "some fixture has image notes to strip");
  });
});

describe("liveRead: a held session reads as pi reads it", async () => {
  const pi = (await loadPi()).agent;
  for (const f of fixtures.filter((x) => x.set === "faux" || (x.set === "synthetic" && ["all-types", "rewind", "fork", "compaction-mid", "unknown", "workers", "baton"].includes(x.name))))
    test(label(f), () => {
      const file = join(dir, `live-${f.set}-${f.name}.jsonl`);
      copyFileSync(f.path, file);
      const sm = pi.SessionManager.open(file);
      const live = liveRead(sm);
      assert.equal(live.id, sm.getSessionId());
      assert.equal(live.cwd, sm.getCwd());
      assert.equal(live.leafId(), sm.getLeafId() ?? null);
      const branch = live.branch();
      assert.deepEqual(branch.map(rawOf), sm.getBranch(), "branch: pi's entries, in pi's order");
      assert.deepEqual(live.entries().map((h) => h.id), sm.getEntries().map((e) => e.id));
      for (const h of branch) assert.equal(rawOf(live.entry(h.id!)!), sm.getEntry(h.id!));
      assert.equal(live.entry("no-such-id"), undefined);
      // Owners: the manager itself, or anything that carries it.
      assert.deepEqual(liveRead({ sessionManager: sm } as never).branch().map((h) => h.id), branch.map((h) => h.id));
      // pi's own walk and the reader's agree on a well-formed file.
      assert.deepEqual(branchOf(parsePi(readFileSync(f.path, "utf8")).entries).map((h) => h.id), branch.map((h) => h.id), "branchOf agrees with pi");
    });
});
