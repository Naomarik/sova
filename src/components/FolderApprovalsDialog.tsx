import { createResource, createUniqueId, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import type { ApprovalState, FolderApprovalsView } from "../../shared/approvals";
import { getFolderApprovals, setFolderApprovals } from "../lib/api";
import { folderQueue, projectQueue } from "../lib/approval-overlay";
import { ApprovalsCard } from "./ProjectSkillsCard";
import { Icon, trapFocus } from "./ui";

/**
 * A folder that isn't a project keeps its list too: its Context Files and Skills, the same two cards
 * a project's Settings tab shows, opened from a chat in that folder. Escape, the backdrop and the
 * close button close it.
 */
export function FolderApprovalsDialog(props: { cwd: string; name: string; onClose(): void; onChanged?(): void }) {
  const id = createUniqueId();
  const [view, { mutate }] = createResource(() => props.cwd, getFolderApprovals);
  const decide = (kind: "files" | "skills") => async (change: Record<string, ApprovalState>) => {
    const next: FolderApprovalsView = await setFolderApprovals(props.cwd, { [kind]: change });
    mutate(next);
    props.onChanged?.();
  };
  const err = () => (view.error ? (view.error as Error).message : null);
  /** The folder's save queue, shared with the new chat's rows for this folder. */
  const queue = () => {
    const f = view()?.folder;
    return f?.projectId ? projectQueue(f.projectId) : folderQueue(f?.root ?? props.cwd);
  };
  // Escape closes it wherever focus went (a decided row's button goes away under the pointer).
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    props.onClose();
  };
  document.addEventListener("keydown", onKey);
  onCleanup(() => document.removeEventListener("keydown", onKey));
  // Drawn at the page's root: inside the chat's setup card it would cover only that card.
  return (
    <Portal>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal folder-approvals-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        ref={(el) => trapFocus(el)}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id={`${id}-title`}>
            {props.name}: context files and skills
          </h2>
          <button type="button" class="button button-icon button-ghost" aria-label="Close" title="Close" onClick={() => props.onClose()}>
            <Icon name="close" />
          </button>
        </div>
        <div class="modal-body folder-approvals-body">
          <ApprovalsCard
            id={`${id}-context`}
            title="Context Files"
            what="context files"
            list={view() ? { rows: view()!.files, asking: view()!.asking, complete: view()!.complete } : undefined}
            error={err()}
            decide={decide("files")}
            queue={queue()}
            folder={view()?.folder.kind ?? "folder"}
          />
          <ApprovalsCard
            id={`${id}-skills`}
            title="Skills"
            what="skills"
            list={view() ? { rows: view()!.skills, asking: view()!.asking, complete: view()!.complete } : undefined}
            error={err()}
            decide={decide("skills")}
            queue={queue()}
            folder={view()?.folder.kind ?? "folder"}
          />
        </div>
      </div>
    </Portal>
  );
}
