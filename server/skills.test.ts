// Run: npx tsx --test server/skills.test.ts
// Pure: builds entry objects in memory, touches no files.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { collectSkills, hasSkills, parseSkillSection, skillNameFromPath } from "./skills";

const system = (id: string, at: string, skills: string | null | undefined) => ({
  type: "message",
  id,
  timestamp: at,
  message: {
    role: "system",
    content: "",
    sections: skills === undefined ? { preamble: "…", tools: "…" } : { preamble: "…", skills },
  },
});

const user = (id: string, at: string, text: string) => ({ type: "message", id, timestamp: at, message: { role: "user", content: [{ type: "text", text }] } });

/** An assistant turn whose only interesting block is the tool call; `index` pads earlier blocks so the
    `${entryId}:${blockIndex}` row id can be asserted. */
const call = (id: string, at: string, name: string, args: unknown, index = 0) => {
  const blocks: unknown[] = Array.from({ length: index }, () => ({ type: "text", text: "" }));
  blocks.push({ type: "toolCall", id: "tc", name, arguments: args });
  return { type: "message", id, timestamp: at, message: { role: "assistant", content: blocks } };
};

const section = (entries: { name: string; description?: string; location?: string }[]) =>
  `<skills>\n<available_skills>\n${entries
    .map((e) => `  <skill>\n    <name>${e.name}</name>\n    <description>${e.description ?? "d"}</description>\n    <location>${e.location ?? `/s/${e.name}/SKILL.md`}</location>\n  </skill>`)
    .join("\n")}\n</available_skills>\n</skills>`;

describe("parseSkillSection", () => {
  test("reads name, description and location, and unescapes the prompt's entities", () => {
    const parsed = parseSkillSection(
      "<skills>\n<available_skills>\n  <skill>\n    <name>fold-ai-dev-design</name>\n    <description>Use when you&apos;re designing &amp; reviewing &lt;UI&gt;</description>\n    <location>/home/u/.claude/skills/fold/SKILL.md</location>\n  </skill>\n</available_skills>\n</skills>",
    );
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.name, "fold-ai-dev-design");
    assert.equal(parsed[0]!.description, "Use when you're designing & reviewing <UI>");
    assert.equal(parsed[0]!.location, "/home/u/.claude/skills/fold/SKILL.md");
  });

  test("ignores a skill block with no name, and empty input", () => {
    assert.deepEqual(parseSkillSection("<skills></skills>"), []);
    assert.deepEqual(parseSkillSection("<skill><description>d</description></skill>"), []);
  });
});

describe("skillNameFromPath", () => {
  test("names the skill after the directory holding its SKILL.md", () => {
    assert.equal(skillNameFromPath("/home/u/.claude/skills/playwright/SKILL.md"), "playwright");
    assert.equal(skillNameFromPath("skills/../npm/node_modules/pi-lens/skills/pi-lens-ast-grep/SKILL.md"), "pi-lens-ast-grep");
  });

  test("has no name for a bare file name", () => {
    assert.equal(skillNameFromPath("SKILL.md"), undefined);
  });

  test("refuses a name a shell variable or a glob could fake", () => {
    assert.equal(skillNameFromPath("/s/$dir/SKILL.md"), undefined);
    assert.equal(skillNameFromPath("/s/${dir}/SKILL.md"), undefined);
    assert.equal(skillNameFromPath("/s/*/SKILL.md"), undefined);
    assert.deepEqual(collectSkills([call("e1", "t1", "bash", { command: "cat $d/SKILL.md" })]).used, []);
  });

  test("a relative path is resolved against the session's cwd, so `..` is never a name", () => {
    // The bug this pins: `cat ../SKILL.md` used to be reported as a skill called `..`.
    assert.equal(skillNameFromPath("../SKILL.md"), undefined);
    assert.equal(skillNameFromPath("./SKILL.md"), undefined);
    assert.equal(skillNameFromPath("../SKILL.md", "/repo/pkg"), "repo");
    assert.equal(skillNameFromPath("../../skills/playwright/SKILL.md", "/repo/pkg"), "playwright");
    const session = {
      type: "session",
      id: "h",
      timestamp: "t0",
      cwd: "/repo/pkg",
    };
    const load = call("e1", "t1", "read", { path: "../skills/playwright/SKILL.md" });
    assert.deepEqual(collectSkills([session, load]).used.map((u) => u.name), ["playwright"]);
  });
});

describe("offered skills", () => {
  test("windows a skill from the entry that offered it until the one that dropped it", () => {
    const skills = collectSkills([
      system("s1", "2026-01-01T00:00:00.000Z", section([{ name: "alpha" }, { name: "beta" }])),
      system("s2", "2026-01-01T01:00:00.000Z", section([{ name: "alpha" }])),
    ]);
    assert.deepEqual(
      skills.offered.map((o) => [o.name, o.from, o.until]),
      [
        ["alpha", "2026-01-01T00:00:00.000Z", undefined],
        ["beta", "2026-01-01T00:00:00.000Z", "2026-01-01T01:00:00.000Z"],
      ],
    );
  });

  test("a patch without a skills key changes nothing, and a null section closes what was open", () => {
    const untouched = collectSkills([system("s1", "t1", section([{ name: "alpha" }])), system("s2", "t2", undefined)]);
    assert.equal(untouched.offered.length, 1);
    assert.equal(untouched.offered[0]!.until, undefined);

    const removed = collectSkills([system("s1", "t1", section([{ name: "alpha" }])), system("s2", "t2", null)]);
    assert.equal(removed.offered[0]!.until, "t2");
  });

  test("offering a skill is not evidence of using it", () => {
    const skills = collectSkills([system("s1", "t1", section([{ name: "playwright" }]))]);
    assert.deepEqual(skills.used, []);
    assert.equal(hasSkills(skills), true);
  });

  test("a re-emitted skill keeps its first window and takes the newer metadata", () => {
    const skills = collectSkills([
      system("s1", "t1", section([{ name: "alpha", description: "old" }])),
      system("s2", "t2", section([{ name: "alpha", description: "new" }])),
    ]);
    assert.equal(skills.offered.length, 1);
    assert.equal(skills.offered[0]!.from, "t1");
    assert.equal(skills.offered[0]!.description, "new");
  });
});

describe("loaded skills", () => {
  test("an explicit /skill:name is exact, with its location and args", () => {
    const skills = collectSkills([
      user("u1", "t1", '<skill name="playwright" location="/p/.claude/skills/playwright/SKILL.md">\n# Playwright\n…\n</skill>\n\nscreenshot the login page'),
    ]);
    assert.deepEqual(skills.used, [
      { name: "playwright", at: "t1", entryId: "u1", how: "invoked", location: "/p/.claude/skills/playwright/SKILL.md", args: "screenshot the login page" },
    ]);
  });

  test("an invocation with no args carries none", () => {
    const skills = collectSkills([user("u1", "t1", '<skill name="omarchy" location="/s/omarchy/SKILL.md">\nbody\n</skill>')]);
    assert.equal(skills.used[0]!.args, undefined);
    assert.equal(skills.used[0]!.how, "invoked");
  });

  test("a Claude Code Skill call is exact, and its row is the block, not the entry", () => {
    const skills = collectSkills([call("e1", "t1", "Skill", { skill: "re-frame", args: "the sidebar" }, 1)]);
    assert.deepEqual(skills.used, [{ name: "re-frame", at: "t1", entryId: "e1:1", how: "invoked", args: "the sidebar" }]);
  });

  test("a Claude Code tool_use block is read with the same rule, under its own argument names", () => {
    // Claude spells them `input`, `file_path` and `command`; pi spells them `arguments`, `path`.
    const claude = (uuid: string, at: string, name: string, input: unknown, index = 0) => {
      const blocks: unknown[] = Array.from({ length: index }, () => ({ type: "text", text: "" }));
      blocks.push({ type: "tool_use", id: `toolu_${index}`, name, input });
      return { type: "assistant", uuid, parentUuid: null, timestamp: at, isSidechain: false, message: { role: "assistant", content: blocks } };
    };
    const skills = collectSkills([
      claude("c1", "t1", "Skill", { skill: "team", args: "wire it" }, 1),
      claude("c2", "t2", "Read", { file_path: "/s/playwright/SKILL.md" }),
      claude("c3", "t3", "Bash", { command: "cat /s/fold-ai-dev-design/SKILL.md" }),
    ]);
    assert.deepEqual(skills.used, [
      { name: "team", at: "t1", entryId: "c1:1", how: "invoked", args: "wire it" },
      { name: "playwright", at: "t2", entryId: "c2:0", how: "read", location: "/s/playwright/SKILL.md" },
      { name: "fold-ai-dev-design", at: "t3", entryId: "c3:0", how: "shell", location: "/s/fold-ai-dev-design/SKILL.md" },
    ]);
    // A Claude transcript records no prompt, so nothing is ever offered: availability is not
    // recoverable for these workers, which the pane states rather than showing an empty list.
    assert.deepEqual(skills.offered, []);
  });

  test("a Claude Code tool_use whose input is not an object is ignored", () => {
    const entry = { type: "assistant", uuid: "c1", timestamp: "t1", message: { role: "assistant", content: [{ type: "tool_use", name: "Skill", input: null }] } };
    assert.deepEqual(collectSkills([entry]).used, []);
  });

  test("a read of a SKILL.md is a load, named after its directory (pi's own rule)", () => {
    const skills = collectSkills([
      call("e1", "t1", "read", { path: "/home/u/.pi/agent/npm/node_modules/pi-lens/skills/pi-lens-ast-grep/SKILL.md" }, 2),
    ]);
    assert.deepEqual(skills.used, [
      { name: "pi-lens-ast-grep", at: "t1", entryId: "e1:2", how: "read", location: "/home/u/.pi/agent/npm/node_modules/pi-lens/skills/pi-lens-ast-grep/SKILL.md" },
    ]);
  });

  test("reading anything else is not a skill load", () => {
    assert.deepEqual(collectSkills([call("e1", "t1", "read", { path: "/home/u/notes.md" })]).used, []);
  });

  test("a SKILL.md anywhere is a load, because that is pi's own rule and the TUI shows the same", () => {
    // Deliberately NOT stricter than pi: its renderer classifies on the basename alone, so the
    // TUI and this list agree instead of the pane inventing a second definition of "skill load".
    const skills = collectSkills([call("e1", "t1", "read", { path: "/home/u/SKILL.md" })]);
    assert.deepEqual(skills.used.map((u) => [u.name, u.how]), [["u", "read"]]);
  });

  test("a bash read of a SKILL.md is inferred, and the location names the file", () => {
    const skills = collectSkills([call("e1", "t1", "bash", { command: "cat /home/u/.claude/skills/playwright/SKILL.md" })]);
    assert.deepEqual(skills.used, [{ name: "playwright", at: "t1", entryId: "e1:0", how: "shell", location: "/home/u/.claude/skills/playwright/SKILL.md" }]);
  });

  test("bash that only names a SKILL.md is not a load: no read verb, or a search", () => {
    assert.deepEqual(collectSkills([call("e1", "t1", "bash", { command: "ls -la /home/u/.claude/skills/playwright/SKILL.md" })]).used, []);
    assert.deepEqual(collectSkills([call("e1", "t1", "bash", { command: "grep -rn 'foo' /home/u/.claude/skills/playwright/SKILL.md" })]).used, []);
  });

  test("a read verb and a path in different commands are not a load", () => {
    // Real false positive: `head` piped one thing, `grep -rl` mentioned the file in its argument.
    const command = `cd /repo && npx tsx /tmp/x.ts 2>&1 | head -6; f=$(grep -rl "pi-lens/SKILL.md" ~/.pi/agent/sessions/*.jsonl | head -1)`;
    assert.deepEqual(collectSkills([call("e1", "t1", "bash", { command })]).used, []);
  });

  test("a heredoc that merely mentions a SKILL.md is not a load", () => {
    // Real false positive: a python heredoc whose source text held `/s/alpha/SKILL.md`.
    const command = `python3 - <<'EOF'\ns = 'cat /s/alpha/SKILL.md'\nprint(s)\nEOF`;
    assert.deepEqual(collectSkills([call("e1", "t1", "bash", { command })]).used, []);
  });

  test("a read verb immediately before the file is a load, flags and quotes included", () => {
    assert.deepEqual(collectSkills([call("e1", "t1", "bash", { command: "head -n 40 '/s/playwright/SKILL.md'" })]).used.map((u) => u.name), ["playwright"]);
    assert.deepEqual(collectSkills([call("e1", "t1", "bash", { command: "cat /s/a/SKILL.md" })]).used.map((u) => u.name), ["a"]);
  });

  test("one bash command loading 2 skills reports both", () => {
    const skills = collectSkills([
      call("e1", "t1", "bash", { command: "cat /s/a/SKILL.md /s/b/SKILL.md" }),
    ]);
    assert.deepEqual(skills.used.map((u) => u.name).sort(), ["a", "b"]);
  });

  test("every load is kept, in order, because 'when' is half the question", () => {
    const skills = collectSkills([call("e1", "t1", "read", { path: "/s/a/SKILL.md" }), call("e2", "t2", "read", { path: "/s/a/SKILL.md" })]);
    assert.deepEqual(skills.used.map((u) => [u.name, u.at, u.entryId]), [
      ["a", "t1", "e1:0"],
      ["a", "t2", "e2:0"],
    ]);
  });
});

describe("collectSkills", () => {
  test("ignores entries that say nothing about skills, and junk input", () => {
    const skills = collectSkills([null, 7, { type: "message", id: "m", message: { role: "assistant", content: "plain text" } }, { type: "session" }]);
    assert.deepEqual(skills, { offered: [], used: [] });
    assert.equal(hasSkills(skills), false);
  });
});
