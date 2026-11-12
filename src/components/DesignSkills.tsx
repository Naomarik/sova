import { Show } from "solid-js";
import { designSkillsLine, type SkillMissingShown, type SkillShown } from "../lib/design-skills";

/** The design skills a run uses, on the Setup card and the brief: one read-only line, the folders in its tooltip. */
export function DesignSkillsLine(props: { run: { skills?: readonly SkillShown[]; skillsMissing?: readonly SkillMissingShown[] } }) {
  const line = () => designSkillsLine(props.run);
  return (
    <p class="text-caption design-skills-line" title={line().full || undefined}>
      <span class="design-skills-names">{line().text}</span>
      <Show when={line().missing}>
        <span class="text-muted design-skills-missing"> · {line().missing}</span>
      </Show>
    </p>
  );
}
