import type { ModelPick } from "../../shared/powers";
import { modelLabel } from "./format";

/** "Opus 5.5 · medium": a pick as the Project Assistant's rows say it (§app.project-assistant/models). */
export const pickLabel = (p: ModelPick | null | undefined): string | null => (p ? [modelLabel(p.model) ?? p.model, p.thinking].filter(Boolean).join(" · ") : null);

/** A newly picked model keeps the thinking level only when its ladder has it (an unknown ladder keeps it). */
export function pickWithModel(current: ModelPick | null | undefined, ref: string, ladder: readonly string[]): ModelPick {
  const t = current?.thinking ?? null;
  return t && ladder.length && !ladder.includes(t) ? { model: ref } : { model: ref, ...(t ? { thinking: t } : {}) };
}
