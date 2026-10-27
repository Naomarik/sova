import { createResource, createSignal, For, Show } from "solid-js";
import type { ClaudeLoginOption, OrgClaudeLogin, ProjectClaudeLogin } from "../../shared/projects";

interface CardView { setting: string; orgLogin?: string | null; options: ClaudeLoginOption[] }
const shape = (v: ProjectClaudeLogin | OrgClaudeLogin, fallback: ClaudeLoginOption[] = []): CardView => {
  const orgLogin = (v as ProjectClaudeLogin).orgLogin;
  return { setting: v.setting, ...(orgLogin !== undefined ? { orgLogin } : {}), options: v.options ?? fallback };
};
import { getOrgClaudeLogin, getProjectClaudeLogin, putOrgClaudeLogin, putProjectClaudeLogin } from "../lib/api";
import { cardChoices, savedText } from "../lib/claude-login-card";
import { announce, toast } from "../lib/ui-state";
import { Banner } from "./ui";

/**
 * The Claude login a project's new chats start on, or the one an organization's projects follow
 * (§app.claude-logins/project-login): one select, saved on change, on the host that holds it (a peer's
 * project or org is asked through this host, lib/mesh.ts routeUrl).
 */
export function ClaudeLoginCard(props: { kind: "project" | "org"; id: string; placed?: boolean }) {
  const [view, { mutate }] = createResource(
    () => props.id,
    async (id): Promise<CardView> => shape(props.kind === "project" ? await getProjectClaudeLogin(id) : await getOrgClaudeLogin(id)),
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const headingId = `${props.kind}-claude-login`;
  const pick = async (value: string, el: HTMLSelectElement) => {
    const before = view.latest?.setting ?? "none";
    setBusy(true);
    try {
      const next = props.kind === "project" ? await putProjectClaudeLogin(props.id, value) : await putOrgClaudeLogin(props.id, value);
      mutate(shape(next, view.latest?.options ?? []));
      setError(null);
      const done = savedText(props.kind, value, next.options ?? []);
      toast(done);
      announce(done);
    } catch (err) {
      el.value = before;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section class="card orgs-section" aria-labelledby={headingId}>
      <h2 class="orgs-h2" id={headingId}>
        {props.kind === "project" ? "Claude login" : "Claude login for its projects"}
      </h2>
      <Show when={view.error}>
        <Banner tone="error" title="The Claude logins can't be read." body="Nothing changed. Open this tab again to retry." />
      </Show>
      <Show when={!view.error && view.latest} fallback={<Show when={!view.error}><div class="skeleton skeleton-line" /></Show>}>
        {(v) => (
          <>
            <label class="field">
              <span class="field-label">{props.kind === "project" ? "New chats start on" : "Its projects start on"}</span>
              <span class="select-wrap">
                <select class="select" aria-describedby={`${headingId}-hint`} disabled={busy()} onChange={(e) => void pick(e.currentTarget.value, e.currentTarget)}>
                  <For each={cardChoices({ kind: props.kind, placed: props.placed, orgLogin: v().orgLogin, setting: v().setting, options: v().options })}>
                    {(c) => (
                      <option value={c.value} selected={c.value === v().setting}>
                        {c.label}
                      </option>
                    )}
                  </For>
                </select>
              </span>
            </label>
            <p class="field-hint" id={`${headingId}-hint`}>
              {props.kind === "project"
                ? "Open chats keep their login. A pick in a chat's composer wins for that chat."
                : "Every project here follows it unless the project picks its own. Open chats keep their login."}
            </p>
          </>
        )}
      </Show>
      <Show when={error()}>{(e) => <Banner tone="error" title={`The Claude login wasn't changed: ${e()}`} />}</Show>
    </section>
  );
}
