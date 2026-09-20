// Run: npx tsx --test server/worker-skills.test.ts
// Creates real files in /tmp (the reader stats and reads them) and removes them afterwards.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { after, describe, test } from "node:test";
import type { WorkerInfo } from "../shared/protocol";
import { forgetWorkerSkills, workerSkills } from "./worker-skills";

const created: string[] = [];
function tmpSession(name: string, lines: unknown[]): string {
  const p = `/tmp/${name}-${randomUUID().slice(0, 8)}.jsonl`;
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  created.push(p);
  forgetWorkerSkills(p); // a reused path would otherwise serve the previous file's parse
  return p;
}
after(() => {
  for (const p of created) rmSync(p, { force: true });
});

const header = (cwd = "/home/u/project") => ({ type: "session", version: 3, id: "01a0", timestamp: "2026-01-01T00:00:00.000Z", cwd });
const system = (id: string, at: string, names: string[], parent: string | null = null) => ({
  type: "message",
  id,
  parentId: parent,
  timestamp: at,
  message: { role: "system", content: "", sections: { preamble: "…", skills: `<skills><available_skills>${names.map((n) => `<skill><name>${n}</name><description>d</description><location>/s/${n}/SKILL.md</location></skill>`).join("")}</available_skills></skills>` } },
});
/** A pi assistant turn with one read tool call. `parent` links the branch, as a real file does. */
const readCall = (id: string, at: string, path: string, parent: string | null = null) => ({
  type: "message",
  id,
  parentId: parent,
  timestamp: at,
  message: { role: "assistant", content: [{ type: "toolCall", id: "tc", name: "read", arguments: { path } }] },
});

const worker = (id: string, file: string | null): WorkerInfo => ({ id, name: id, status: "waiting", working: false, ...(file ? { sessionFile: file } : {}) });
/** Where a worker's transcript is: injectable, so a test never needs the live registry or ~/.claude. */
const at = (file: string | null) => () => file;

describe("workerSkills", () => {
  test("reads a pi worker's own session file: what it loaded and what it was offered", async () => {
    const file = tmpSession("w", [header(), system("s1", "2026-01-01T00:01:00.000Z", ["playwright", "omarchy"]), readCall("e1", "2026-01-01T00:02:00.000Z", "/s/playwright/SKILL.md", "s1")]);
    const out = await workerSkills([worker("ag_1", file)], at(file));
    assert.deepEqual(Object.keys(out ?? {}), ["ag_1"]);
    assert.deepEqual(out!.ag_1!.used.map((u) => [u.name, u.how, u.entryId]), [["playwright", "read", "e1:0"]]);
    assert.deepEqual(out!.ag_1!.offered.map((o) => o.name), ["omarchy", "playwright"]);
  });

  test("omits a worker that loaded nothing, and one whose file is missing", async () => {
    // A plain read is not a skill load, and nothing offered one either.
    const quiet = tmpSession("q", [header(), readCall("e1", "t1", "/home/u/notes.md")]);
    assert.equal(await workerSkills([worker("ag_1", quiet)], at(quiet)), undefined);
    assert.equal(await workerSkills([worker("ag_2", "/tmp/does-not-exist-whatsoever.jsonl")], at("/tmp/does-not-exist-whatsoever.jsonl")), undefined);
  });

  test("omits a worker whose transcript cannot be located at all", async () => {
    assert.equal(await workerSkills([worker("ag_3", null)], at(null)), undefined);
  });

  test("reports every worker that has something, keyed by worker id", async () => {
    const a = tmpSession("a", [header(), readCall("e1", "t1", "/s/alpha/SKILL.md")]);
    const b = tmpSession("b", [header(), readCall("e2", "t2", "/s/beta/SKILL.md")]);
    const out = await workerSkills([worker("ag_1", a), worker("ag_2", b)], (w) => (w.id === "ag_1" ? a : b));
    assert.deepEqual(Object.keys(out ?? {}).sort(), ["ag_1", "ag_2"]);
    assert.equal(out!.ag_2!.used[0]!.name, "beta");
  });

  test("parses a file once per change: a new load is picked up after the file moves", async () => {
    const file = tmpSession("c", [header(), readCall("e1", "t1", "/s/alpha/SKILL.md")]);
    const first = await workerSkills([worker("ag_1", file)], at(file));
    assert.equal(first!.ag_1!.used.length, 1);

    const grown = [header(), readCall("e1", "t1", "/s/alpha/SKILL.md"), readCall("e2", "t2", "/s/beta/SKILL.md", "e1")];
    writeFileSync(file, grown.map((l) => JSON.stringify(l)).join("\n") + "\n");
    // mtime resolution can be coarse on some filesystems; the key includes size, which changed.
    const second = await workerSkills([worker("ag_1", file)], at(file));
    assert.deepEqual(second!.ag_1!.used.map((u) => u.name), ["alpha", "beta"]);
  });

  test("does not attribute a nested agent's load to the worker that hosts the file", async () => {
    const file = tmpSession("d", [
      header(),
      readCall("e1", "t1", "/s/alpha/SKILL.md"),
      // A nested Claude Code Task agent's lines sit in the parent's file with isSidechain: true.
      { type: "assistant", uuid: "n1", parentUuid: "e1", isSidechain: true, timestamp: "t2", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "team" } }] } },
    ]);
    const out = await workerSkills([worker("ag_1", file)], at(file));
    assert.deepEqual(out!.ag_1!.used.map((u) => u.name), ["alpha"]);
  });

  test("a Claude Code worker's file is read the same way, with no offered set", async () => {
    const file = tmpSession("e", [
      { type: "assistant", uuid: "c1", parentUuid: null, isSidechain: false, timestamp: "t1", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: { skill: "re-frame", args: "the sidebar" } }] } },
      { type: "assistant", uuid: "c2", parentUuid: "c1", isSidechain: false, timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text: "…" }, { type: "tool_use", name: "Read", input: { file_path: "/s/playwright/SKILL.md" } }] } },
    ]);
    const out = await workerSkills([worker("ag_1", file)], at(file));
    assert.deepEqual(out!.ag_1!.used.map((u) => [u.name, u.how, u.entryId]), [
      ["re-frame", "invoked", "c1:0"],
      ["playwright", "read", "c2:1"],
    ]);
    assert.deepEqual(out!.ag_1!.offered, []);
  });
});
