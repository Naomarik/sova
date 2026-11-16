// The playbook contents page's sections: Create's `playbooks` topic, one page
// per section, read where Create keeps them, so a run and Create read the same contents.
import * as guide from "../../pi-config/extensions/mode/create/guide.ts";
import type { ContentsSection } from "./message";

export function playbookContents(): ContentsSection[] {
  const sections = (guide as { playbookSections?: () => ContentsSection[] }).playbookSections;
  try {
    return sections ? sections() : [];
  } catch (err) {
    console.warn(`[playbook-runs] the contents page couldn't be read: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
