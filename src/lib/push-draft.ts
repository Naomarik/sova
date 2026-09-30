import { PUSH_KINDS, type PushKind, type PushSettings, type PushSettingsInfo } from "../../shared/protocol";
import { contactProblem, HHMM } from "../../shared/push";
import { getPushInfo, putPushSettings } from "./api";
import { createDraftStore, saveRebased } from "./settings-draft";

/** The form's copy: the contact as typed (a blank one is none). */
export interface PushDraft {
  enabled: boolean;
  contact: string;
  kinds: Record<PushKind, boolean>;
  quietHours: PushSettings["quietHours"];
}

export const toPushDraft = (s: PushSettings): PushDraft => ({
  enabled: s.enabled,
  contact: s.contact ?? "",
  kinds: { ...s.kinds },
  quietHours: { ...s.quietHours },
});

export const fromPushDraft = (d: PushDraft): PushSettings => ({
  version: 1,
  enabled: d.enabled,
  contact: d.contact.trim() || null,
  kinds: { ...d.kinds },
  quietHours: { ...d.quietHours },
});

const sameQuiet = (a: PushSettings["quietHours"], b: PushSettings["quietHours"]) => a.enabled === b.enabled && a.start === b.start && a.end === b.end;

export function samePush(d: PushDraft, s: PushSettings): boolean {
  const x = fromPushDraft(d);
  return x.enabled === s.enabled && x.contact === s.contact && PUSH_KINDS.every((k) => x.kinds[k] === s.kinds[k]) && sameQuiet(x.quietHours, s.quietHours);
}

/** The user's edits of `base`, on top of `fresh`: each field (each kind) they left alone follows the file. Pure. */
export function rebasePush(d: PushDraft, base: PushSettings, fresh: PushSettings): PushDraft {
  const mine = fromPushDraft(d);
  const kinds = { ...fresh.kinds };
  for (const k of PUSH_KINDS) if (mine.kinds[k] !== base.kinds[k]) kinds[k] = mine.kinds[k];
  return {
    enabled: mine.enabled !== base.enabled ? mine.enabled : fresh.enabled,
    contact: mine.contact !== base.contact ? d.contact : (fresh.contact ?? ""),
    kinds,
    quietHours: sameQuiet(mine.quietHours, base.quietHours) ? { ...fresh.quietHours } : { ...mine.quietHours },
  };
}

/** Why the draft can't be saved, naming the form, or null. Pure. */
export function pushDraftProblem(d: PushDraft): string | null {
  const c = d.contact.trim();
  const bad = c ? contactProblem(c) : null;
  if (bad) return `Phone Notifications: ${bad}`;
  const q = d.quietHours;
  if (!HHMM.test(q.start) || !HHMM.test(q.end)) return "Phone Notifications: quiet hours need a start and an end time.";
  if (q.start === q.end) return "Phone Notifications: quiet hours can't start and end at the same time.";
  return null;
}

/** Settings → Notifications → Phone Notifications' unsaved settings (settings-draft.ts: module state, held on close). */
const store = createDraftStore<PushDraft, PushSettings, PushSettingsInfo>({
  tab: "notifications",
  label: "Phone Notifications",
  toDraft: toPushDraft,
  same: samePush,
  rebase: rebasePush,
  problem: (d) => pushDraftProblem(d),
  write: async (d, base) => {
    const { result } = await saveRebased(d, base, {
      read: (): Promise<PushSettingsInfo> => getPushInfo(),
      settingsOf: (i) => i.settings,
      rebase: rebasePush,
      same: samePush,
      write: (next) => putPushSettings(fromPushDraft(next)),
    });
    return { saved: result.settings, result };
  },
});

export const pushDraft = store.draft;
export const pushSaved = store.saved;
export const setPushDraft = store.setDraft;
export const setPushSaved = store.setSaved;
export const pushSaving = store.saving;
export const pushSaveError = store.error;
export const pushDirty = store.dirty;
