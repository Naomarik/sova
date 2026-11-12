// The design skills a Lookbook run uses, as the Setup card and the brief show them: read-only words, no controls.

/** What the page needs of one skill (shared/design.ts `DesignSkill`). */
export interface SkillShown {
  name: string;
  description?: string;
  dir: string;
}

/** What the page needs of a named skill that wasn't found (shared/design.ts `DesignSkillMissing`). */
export interface SkillMissingShown {
  asked: string;
  reason?: string;
}

export interface SkillsLine {
  /** "Design skills: fold-ai-dev-design, brand-kit" or "Design skills: none". */
  text: string;
  /** "Not found: ~/Downloads/kit", or "" when every named skill was found. */
  missing: string;
  /** The tooltip: each skill's name, folder and description, one per line. */
  full: string;
}

/** The one line both the Setup card and the brief show for a run's skills. */
export function designSkillsLine(run: { skills?: readonly SkillShown[]; skillsMissing?: readonly SkillMissingShown[] }): SkillsLine {
  const skills = run.skills ?? [];
  const missing = run.skillsMissing ?? [];
  const text = `Design skills: ${skills.length ? skills.map((s) => s.name).join(", ") : "none"}`;
  const full = [
    ...skills.map((s) => [`${s.name} · ${s.dir}`, s.description?.trim()].filter(Boolean).join("\n")),
    ...missing.map((m) => `Not found: ${m.asked}${m.reason ? ` (${m.reason})` : ""}`),
  ].join("\n\n");
  return { text, missing: missing.length ? `Not found: ${missing.map((m) => m.asked).join(", ")}` : "", full };
}
