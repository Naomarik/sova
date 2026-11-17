import { createResource, createSignal, Show } from "solid-js";
import { fetchSessionSetup } from "../lib/api";
import { overseerButtonWords } from "../lib/approvals";
import { rowApproval } from "../lib/setup-approvals";
import { FolderApprovalsDialog } from "./FolderApprovalsDialog";
import { Icon } from "./ui";

/**
 * The global Overseer runs in a folder that isn't a project, and follows that folder's list. While
 * new items start off, what nobody has turned on stays off and it never waits for you: this head
 * button says how many new items are off and opens the list (the same one a chat in that folder
 * edits). While new items start on it isn't shown.
 */
export function OverseerApprovalsButton(props: { path: string }) {
  const [setup, { refetch }] = createResource(
    () => props.path,
    (p) => fetchSessionSetup(p, true),
  );
  const [open, setOpen] = createSignal(false);
  const list = () => {
    const s = setup();
    return s && s.state === "ok" && s.approvals?.asking && s.approvals.folder.kind === "folder" ? { folder: s.approvals.folder, rows: [...s.context, ...s.skills] } : null;
  };
  const waiting = () => list()?.rows.filter((r) => r.approval && rowApproval(r) === "waiting").length ?? 0;
  return (
    <Show when={list()}>
      {(l) => (
        <>
          <button
            type="button"
            class="button button-sm button-ghost overseer-approvals"
            title="Context files and skills the Overseer loads. A new one stays off until you turn it on."
            onClick={() => setOpen(true)}
          >
            <Icon name={waiting() ? "attention" : "file"} small />
            {overseerButtonWords(waiting())}
          </button>
          <Show when={open() && l().folder.kind === "folder" && (l().folder as { path: string; name: string })}>
            {(f) => (
              <FolderApprovalsDialog
                cwd={f().path}
                name="The Overseer's folder"
                onClose={() => setOpen(false)}
                onChanged={() => void refetch()}
              />
            )}
          </Show>
        </>
      )}
    </Show>
  );
}
