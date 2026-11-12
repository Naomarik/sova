import { test } from "node:test";
import assert from "node:assert/strict";
import { designSkillsLine } from "./design-skills";

test("a run's skills read as one line of names, with each folder and description in the tooltip", () => {
  const l = designSkillsLine({
    skills: [
      { name: "fold-ai-dev-design", description: "Sova's design system.", dir: "/p/.agents/skills/fold-ai-dev-design" },
      { name: "brand-kit", description: "", dir: "/home/u/Downloads/brand-kit" },
    ],
  });
  assert.equal(l.text, "Design skills: fold-ai-dev-design, brand-kit");
  assert.equal(l.missing, "");
  assert.equal(l.full, "fold-ai-dev-design · /p/.agents/skills/fold-ai-dev-design\nSova's design system.\n\nbrand-kit · /home/u/Downloads/brand-kit");
});

test("no skills reads as none, and a run made before skills reads the same", () => {
  assert.equal(designSkillsLine({ skills: [] }).text, "Design skills: none");
  assert.equal(designSkillsLine({}).text, "Design skills: none");
});

test("a named skill that wasn't found is said, never dropped", () => {
  const l = designSkillsLine({ skills: [], skillsMissing: [{ asked: "~/kits/acme", reason: "no SKILL.md in it" }, { asked: "brandbook" }] });
  assert.equal(l.missing, "Not found: ~/kits/acme, brandbook");
  assert.match(l.full, /Not found: ~\/kits\/acme \(no SKILL\.md in it\)/);
});
