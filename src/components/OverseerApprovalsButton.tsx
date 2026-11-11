import { createResource, createSignal, Show } from "solid-js";
import { fetchSessionSetup } from "../lib/api";
import { rowApproval } from "../lib/setup-approvals";
import { FolderApprovalsDialog } from "./FolderApprovalsDialog";
import { Icon } from "./ui";

/**
 * The global Overseer runs in a folder that isn't a project, and with asking on it follows that
 * folder's list: what waits stays off and it never waits for you. This head button says how many
 * wait and opens the list (the same one a chat in that folder edits). Without asking it isn't shown.
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
            title="Context files and skills the Overseer may load. With asking on, what you haven't approved stays off."
            onClick={() => setOpen(true)}
          >
            <Icon name={waiting() ? "attention" : "file"} small />
            {waiting() ? `${waiting()} to approve` : "Context Files and Skills"}
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
