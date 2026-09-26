import type { MeshSettings, SyncCategory } from "../../shared/protocol";
import { fetchMesh, putMeshSettings } from "./api";
import { setMeshState } from "./mesh";
import { createDraftStore } from "./settings-draft";

/**
 * Settings → Mesh's unsaved edits (settings-draft.ts: module state, held on close, forgotten once
 * closed): this host's name, the sync switches, which logins sync, and the front door. Peers
 * rewrite parts of the same file, so a save sends only the fields the user changed
 * (`meshChanges`) and the server merges them into what it has then.
 */
export interface MeshDraft {
  /** As typed; trimmed when compared and saved. */
  hostLabel: string;
  sync: Record<SyncCategory, boolean>;
  /** As typed; "" is no front door. */
  frontDoor: string;
  loginKinds: "all" | "api-keys";
}

const loginKindsOf = (s: Pick<MeshSettings, "loginKinds">): MeshDraft["loginKinds"] => (s.loginKinds === "api-keys" ? "api-keys" : "all");

export const meshDraftOf = (s: MeshSettings): MeshDraft => ({
  hostLabel: s.hostLabel,
  sync: { ...s.sync },
  frontDoor: s.frontDoor ?? "",
  loginKinds: loginKindsOf(s),
});

/**
 * What a save sends: each field the draft changed, and nothing else — for the sync switches, only
 * the categories that moved (the server merges them into its own). Empty when nothing changed.
 */
export function meshChanges(d: MeshDraft, s: MeshSettings): Partial<MeshSettings> {
  const out: Partial<MeshSettings> = {};
  const label = d.hostLabel.trim();
  if (label !== s.hostLabel) out.hostLabel = label;
  const sync = (Object.keys(d.sync) as SyncCategory[]).filter((c) => d.sync[c] !== s.sync[c]);
  if (sync.length) out.sync = Object.fromEntries(sync.map((c) => [c, d.sync[c]])) as Record<SyncCategory, boolean>;
  const door = d.frontDoor.trim();
  if (door !== (s.frontDoor ?? "")) out.frontDoor = door || null;
  if (d.loginKinds !== loginKindsOf(s)) out.loginKinds = d.loginKinds;
  return out;
}

export const sameMesh = (d: MeshDraft, s: MeshSettings): boolean => Object.keys(meshChanges(d, s)).length === 0;

/** Why the draft can't be saved, one sentence, or null. */
export const meshDraftIssue = (d: MeshDraft): string | null => (d.hostLabel.trim() ? null : "This host needs a name.");

const store = createDraftStore<MeshDraft, MeshSettings>({
  tab: "mesh",
  label: "Mesh",
  toDraft: meshDraftOf,
  same: sameMesh,
  problem: (d) => {
    const issue = meshDraftIssue(d);
    return issue ? `Mesh: ${issue}` : null;
  },
  write: async (d, s) => {
    const next = await putMeshSettings(meshChanges(d, s));
    // The name shows on the card, in New Session and on the Mesh page: they read the mesh state.
    void fetchMesh().then(setMeshState, () => {});
    return { saved: next, result: next };
  },
});

export const meshDraft = store.draft;
export const meshSaved = store.saved;
export const setMeshDraft = store.setDraft;
export const setMeshSaved = store.setSaved;
export const acceptMeshSave = store.acceptSave;
export const meshDirty = store.dirty;
export const meshSaving = store.saving;
export const meshSaveError = store.error;
export const resetMeshDraft = store.reset;
