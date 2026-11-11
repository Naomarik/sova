import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionSkillOffer, SessionSkills, SessionSkillUse } from "../../shared/protocol";
import { overviewMeta, readBeforeCompaction, skillsOverview, type SkillReaderSource } from "./skills-overview";

const use = (name: string, at: string, location?: string, how: SessionSkillUse["how"] = "read"): SessionSkillUse => ({ name, at, entryId: `e-${at}`, how, ...(location ? { location } : {}) });
const offer = (name: string): SessionSkillOffer => ({ name, from: "", location: `/s/${name}/SKILL.md` });
const src = (key: string, used: SessionSkillUse[], offered: SessionSkillOffer[] = []): SkillReaderSource => ({ key, label: key, skills: { offered, used } satisfies SessionSkills });

describe("skillsOverview", () => {
  test("counts every opening once, in any order of chats and loads: the totals are the record's own tally", () => {
    // The rule: a skill's total is the number of its loads across every chat, and each reader's count
    // the number of its own; nothing joins, drops or doubles a load. Checked over every order of the sources.
    const a = src("a", [use("x", "2026-01-01T00:01:00Z"), use("x", "2026-01-01T00:02:00Z", undefined, "shell"), use("y", "2026-01-01T00:03:00Z")]);
    const b = src("b", [use("x", "2026-01-01T00:04:00Z", undefined, "invoked")]);
    const c = src("c", [use("y", "2026-01-01T00:05:00Z"), use("y", "2026-01-01T00:06:00Z"), use("y", "2026-01-01T00:07:00Z")]);
    const orders = [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]];
    for (const o of orders) {
      const { read } = skillsOverview(o);
      const tally = (name: string) => o.reduce((n, s) => n + s.skills!.used.filter((u) => u.name === name).length, 0);
      assert.deepEqual(read.map((r) => [r.name, r.total]), [["y", tally("y")], ["x", tally("x")]], "most-read first");
      for (const r of read) assert.equal(r.readers.reduce((n, x) => n + x.count, 0), r.total);
      assert.deepEqual(read[0]!.readers.map((x) => [x.key, x.count, x.lastAt]), [["c", 3, "2026-01-01T00:07:00Z"], ["a", 1, "2026-01-01T00:03:00Z"]]);
      assert.deepEqual(read[1]!.readers.map((x) => [x.key, x.count, x.lastAt]), [["a", 2, "2026-01-01T00:02:00Z"], ["b", 1, "2026-01-01T00:04:00Z"]]);
    }
  });

  test("a tie on openings goes to the skill more chats read, then to the name", () => {
    const { read } = skillsOverview([src("a", [use("solo", "t"), use("solo", "t"), use("pair", "t"), use("zed", "t")]), src("b", [use("pair", "t"), use("abc", "t")])]);
    assert.deepEqual(read.map((r) => r.name), ["pair", "solo", "abc", "zed"]);
  });

  test("one name opened at two SKILL.md paths is two rows; a load with no path of its own stands under the name alone", () => {
    const { read } = skillsOverview([
      src("a", [use("design", "t1", "/p1/.agents/skills/design/SKILL.md"), use("design", "t2", "/p2/.agents/skills/design/SKILL.md")]),
      src("b", [use("design", "t3", "/p1/.agents/skills/design/SKILL.md"), use("design", "t4", undefined, "invoked")]),
    ]);
    assert.deepEqual(
      read.map((r) => [r.location ?? null, r.total]),
      [["/p1/.agents/skills/design/SKILL.md", 2], [null, 1], ["/p2/.agents/skills/design/SKILL.md", 1]],
    );
    assert.equal(new Set(read.map((r) => r.id)).size, 3);
    // A single path, or a relative one beside it, never splits a name.
    const one = skillsOverview([src("a", [use("p", "t", "/s/p/SKILL.md"), use("p", "t", ".agents/skills/p/SKILL.md"), use("p", "t")])]);
    assert.deepEqual(one.read.map((r) => [r.id, r.total, r.location]), [["p", 3, undefined]]);
  });

  test("Not read by anyone: each skill offered to any chat that no chat opened, once, by name", () => {
    const { notRead } = skillsOverview([src("a", [use("read-it", "t")], [offer("read-it"), offer("zeta"), offer("alpha")]), src("b", [], [offer("alpha"), offer("beta")]), { key: "c", label: "c", skills: undefined }]);
    assert.deepEqual(notRead.map((s) => s.name), ["alpha", "beta", "zeta"]);
  });

  test("a row's short line counts openings and chats", () => {
    assert.equal(overviewMeta({ total: 1, readers: [{ key: "a", label: "a", count: 1, lastAt: "" }] }), "1 opening · 1 chat");
    assert.equal(overviewMeta({ total: 5, readers: [{ key: "a", label: "a", count: 4, lastAt: "" }, { key: "b", label: "b", count: 1, lastAt: "" }] }), "5 openings · 2 chats");
  });
});

describe("readBeforeCompaction", () => {
  const part = { group: "skills" as const, label: "playwright", path: "/s/playwright/SKILL.md" };
  test("only an offered skill the window shows as not read at all, that the whole history opened", () => {
    const used = [use("playwright", "t", "/s/playwright/SKILL.md")];
    assert.equal(readBeforeCompaction(part, used), true);
    assert.equal(readBeforeCompaction(part, [use("playwright", "t", undefined, "invoked")]), true, "an opening with no path matches by name");
    for (const not of [{ read: true }, { linesRead: 2 }, { manualOnly: true }, { offered: false }]) assert.equal(readBeforeCompaction({ ...part, ...not }, used), false);
    assert.equal(readBeforeCompaction(part, undefined), false);
    assert.equal(readBeforeCompaction(part, [use("omarchy", "t")]), false);
    assert.equal(readBeforeCompaction({ ...part, group: "tools" as const }, used), false);
    // Same name, another SKILL.md: a read of one says nothing of the other.
    assert.equal(readBeforeCompaction(part, [use("playwright", "t", "/elsewhere/playwright/SKILL.md")]), false);
  });
});
