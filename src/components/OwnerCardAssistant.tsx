import { createResource, createSignal, For, Show } from "solid-js";
import type { AssistantInfo, PricedPick } from "../../shared/project-assistant";
import type { ModelPick, WorkKind } from "../../shared/powers";
import { ApiError, assistantInfo, openAssistantChat, setAssistantModels } from "../lib/api";
import { SHOWN_KINDS, WORK_LABEL } from "../lib/assistant-model-rows";
import { orgTabHref } from "../lib/orgs-route";
import { isOpenRequest, openRequestsLine } from "../lib/owner-requests";
import { announce } from "../lib/ui-state";
import { AssistantPowers } from "./PowersGrid";
import { ModelPickButton, pickLabel } from "./ModelPickButton";
import "./OwnerCardAssistant.css";

/**
 * The Owner card's Project Assistant part (§app.owner-page/controls, §app/project-assistant): one
 * line linking the owner's open requests on the Requests tab, Open Assistant Chat, its models per kind of work
 * (§app.project-assistant/models: the org's own pick, else the host's default; a project may override
 * coding) as rows with `Change` (the composer's picker, saved at once with its thinking) and `Use
 * Default` on the org's own pick (the gathering kind runs its feature request chats), and each project's Project Assistant
 * switches (powers-ui's AssistantPowers).
 */

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

export { SHOWN_KINDS, WORK_LABEL } from "../lib/assistant-model-rows";

/** "$3 in / $15 out per million tokens", or that the price isn't known. */
export function priceLine(p: PricedPick | null | undefined): string {
  if (!p) return "Not set: nothing runs.";
  if (!p.price) return "Price not known.";
  const usd = (n: number) => (n === 0 ? "$0" : n < 1 ? `$${n.toFixed(2)}` : `$${Number.isInteger(n) ? n : n.toFixed(2)}`);
  return `${usd(p.price.input)} in / ${usd(p.price.output)} out per million tokens`;
}

export function OwnerCardAssistant(props: { orgId: string; ownerName: string }) {
  const [info, { mutate, refetch }] = createResource(() => props.orgId, (id) => assistantInfo(id));
  const [err, setErr] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const open = () => (info()?.requests ?? []).filter(isOpenRequest);
  const first = () => props.ownerName.trim().split(/\s+/)[0] ?? props.ownerName;

  const run = async (fn: () => Promise<AssistantInfo>, done: string) => {
    if (busy()) return;
    setBusy(true);
    try {
      mutate(await fn());
      setErr(null);
      announce(done);
    } catch (x) {
      setErr(errText(x));
    } finally {
      setBusy(false);
    }
  };
  /** Save-on-pick: the model AND its thinking; null clears the org's pick (the kind follows the default). */
  const setModel = (kind: WorkKind, pick: ModelPick | null) =>
    void run(() => setAssistantModels(props.orgId, { [kind]: pick ? { model: pick.model, ...(pick.thinking ? { thinking: pick.thinking } : {}) } : null }), pick ? `${WORK_LABEL[kind]}: ${pickLabel(pick)}.` : `${WORK_LABEL[kind]}: follows the default.`);
  const openChat = async () => {
    try {
      const r = await openAssistantChat(props.orgId);
      location.hash = `#/s/${encodeURIComponent(r.path)}`;
    } catch (x) {
      setErr(errText(x));
    }
  };

  return (
    <div class="orgs-assistant" aria-labelledby="orgs-assistant-h">
      <h3 class="orgs-h3" id="orgs-assistant-h">
        Project Assistant
      </h3>
      <p class="orgs-line project-muted">
        {first()}'s own chat on their page. It answers, reports problems and outages to you, and notes new requirements for you to review; anything its switches leave off comes to you as a request.
      </p>
      <Show when={info.error}>
        <p class="field-error">
          Couldn't read the Project Assistant.{" "}
          <button type="button" class="button button-sm button-ghost" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      </Show>
      <Show when={info()}>
        {(i) => (
          <>
            <div class="orgs-assistant-requests">
              {/* The requests themselves are the org's Requests tab (§app.project-assistant/requests-tab). */}
              <p class="orgs-line">
                <a href={orgTabHref(props.orgId, "requests")}>{openRequestsLine(open().length, props.ownerName)}</a>
              </p>
              <div class="button-row">
                <button type="button" class="button button-sm" onClick={() => void openChat()}>
                  {i().sessionId ? "Open Assistant Chat" : "Start Assistant Chat"}
                </button>
              </div>
            </div>
            <div class="orgs-assistant-models">
              <h4 class="orgs-h4">Models</h4>
              <div class="orgs-assistant-model-rows">
                <For each={SHOWN_KINDS}>
                  {(kind) => {
                    const m = () => i().models[kind] ?? null;
                    const labelId = `orgs-assistant-model-${kind}`;
                    return (
                      <div class="orgs-assistant-model-row" role="group" aria-labelledby={labelId}>
                        <div class="orgs-assistant-model-main">
                          <span class="field-label" id={labelId}>
                            {WORK_LABEL[kind]}
                          </span>
                          <Show
                            when={m()}
                            fallback={
                              <span class="orgs-line">
                                Not set. <a href="#/settings/organizations">Set a default in Settings → Organizations.</a>
                              </span>
                            }
                          >
                            {(p) => (
                              <>
                                <span class="orgs-line">
                                  <span class="orgs-assistant-model-source">{p().source === "org" ? "This organization" : "Default"}</span> · {pickLabel(p())}
                                </span>
                                <span class="field-hint">{priceLine(p())}</span>
                              </>
                            )}
                          </Show>
                          <Show when={kind === "reply" && m() && i().replyProblem}>
                            {(why) => (
                              <span class="field-error">
                                {why() === "turned-off" ? `Settings → Models turned this model off: ${first()}'s assistant isn't ready.` : `This host can't run this model: ${first()}'s assistant isn't ready.`}
                              </span>
                            )}
                          </Show>
                          <Show when={kind === "reply" && !i().replyProblem && i().seesPhotos === false}>
                            <span class="field-hint">This model can't see photos: {first()} won't get an attach button.</span>
                          </Show>
                        </div>
                        <div class="button-row">
                          <ModelPickButton
                            id={`owner-assistant-${kind}`}
                            label="Change"
                            ariaLabel={`Change ${WORK_LABEL[kind]}`}
                            value={m() ? { model: m()!.model, ...(m()!.thinking ? { thinking: m()!.thinking } : {}) } : null}
                            busy={busy()}
                            onPick={(pick) => setModel(kind, pick)}
                          />
                          <Show when={m()?.source === "org"}>
                            <button
                              type="button"
                              class="button button-sm button-ghost"
                              disabled={busy()}
                              title={i().default ? `Use the default, ${pickLabel(i().default)}` : "No default is set in Settings → Organizations: this row would be not set."}
                              onClick={() => setModel(kind, null)}
                            >
                              Use Default
                            </button>
                          </Show>
                        </div>
                      </div>
                    );
                  }}
                </For>
              </div>
              <For each={i().projects.filter((p) => p.coding.source === "project")}>
                {(p) => (
                  <p class="field-hint">
                    {p.name} uses its own model for fixes ({pickLabel(p.coding.pick)}, {priceLine(p.coding.pick).replace(/\.$/, "")}).
                  </p>
                )}
              </For>
            </div>
            <div class="orgs-assistant-powers">
              <h4 class="orgs-h4">What it may set off on its own</h4>
              <AssistantPowers projects={i().projects.map((p) => ({ id: p.projectId, name: p.name }))} />
              <p class="orgs-line project-muted">{first()} sees what these let the assistant do, in plain words, on their page.</p>
            </div>
          </>
        )}
      </Show>
      <Show when={err()}>{(e) => <p class="field-error">{e()}</p>}</Show>
    </div>
  );
}
