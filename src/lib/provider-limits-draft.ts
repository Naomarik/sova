import type { ProviderLimits, ProviderLimitsInfo } from "../../shared/provider-limits";
import { getProviderLimits, putProviderLimits } from "./api";
import { limitsDraftOf, limitsOfDraft, limitsProblem, rebaseLimits, sameLimits, type LimitsDraft } from "./provider-limits";
import { createDraftStore, saveRebased } from "./settings-draft";

/**
 * Settings → Models' unsaved "At once" fields (§app.provider-limits/setting): staged beside the
 * policy's switches and written by the same Save Changes. A peer's sync writes the same file, so a
 * kept draft is rebased onto each fresh read, and Save rebases once more before it writes.
 */
const store = createDraftStore<LimitsDraft, ProviderLimits, ProviderLimitsInfo>({
  tab: "models",
  label: "Request limits",
  toDraft: limitsDraftOf,
  same: sameLimits,
  rebase: rebaseLimits,
  problem: (d) => limitsProblem(d),
  write: async (d, base) => {
    const { result } = await saveRebased(d, base, {
      read: () => getProviderLimits(),
      settingsOf: (info) => info.limits,
      rebase: rebaseLimits,
      same: sameLimits,
      write: (next) => {
        const parsed = limitsOfDraft(next);
        if ("invalid" in parsed) throw new Error(limitsProblem(next) ?? "invalid limit");
        return putProviderLimits(parsed.limits);
      },
    });
    return { saved: result.limits, result };
  },
});

export const limitsDraft = store.draft;
export const setLimitsDraft = store.setDraft;
export const setLimitsSaved = store.setSaved;
export const limitsSaving = store.saving;
export const limitsSaveError = store.error;
export const limitsSaveResult = store.result;
