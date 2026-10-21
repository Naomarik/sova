import { createResource, createSignal, For, Show } from "solid-js";
import type { ModelInfo } from "../../shared/protocol";
import type { AssistantInfo, PricedPick } from "../../shared/project-assistant";
import type { WorkKind } from "../../shared/powers";
import { ApiError, assistantInfo, listModels, openAssistantChat, setAssistantModels } from "../lib/api";
import { orgTabHref } from "../lib/orgs-route";
import { isOpenRequest, openRequestsLine } from "../lib/owner-requests";
import { announce } from "../lib/ui-state";
import { AssistantPowers } from "./PowersGrid";
import "./OwnerCardAssistant.css";

/**
 * The Owner card's Project Assistant part (§app.owner-page/controls, §app/project-assistant): one
 * line linking the owner's open requests on the Requests tab, Open Assistant Chat, its models per kind of work
 * with their prices (per org; a project may override coding and gathering), and each project's
 * Project Assistant switches (powers-ui's AssistantPowers).
 */

const errText = (err: unknown) => (err instanceof ApiError || err instanceof Error ? err.message : String(err));

export const WORK_LABEL: Record<WorkKind, string> = { reply: "Its replies", coding: "Fixes it starts", gathering: "Gatherings it starts" };

/** "$3 in / $15 out per million tokens", or that the price isn't known. */
export function priceLine(p: PricedPick | null | undefined): string {
  if (!p) return "Not set: nothing runs.";
  if (!p.price) return "Price not known.";
  const usd = (n: number) => (n === 0 ? "$0" : n < 1 ? `$${n.toFixed(2)}` : `$${Number.isInteger(n) ? n : n.toFixed(2)}`);
  return `${usd(p.price.input)} in / ${usd(p.price.output)} out per million tokens`;
}

export function OwnerCardAssistant(props: { orgId: string; ownerName: string }) {
  const [info, { mutate, refetch }] = createResource(() => props.orgId, (id) => assistantInfo(id));
  const [models] = createResource(() => listModels().catch((): ModelInfo[] => []));
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
  const setModel = (kind: WorkKind, ref: string) => void run(() => setAssistantModels(props.orgId, { [kind]: ref ? { model: ref } : null }), ref ? `${WORK_LABEL[kind]}: ${ref}.` : `${WORK_LABEL[kind]}: not set.`);
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
              <div class="orgs-fields orgs-assistant-model-fields">
              <For each={["reply", "coding", "gathering"] as WorkKind[]}>
                {(kind) => (
                  <label class="field">
                    <span class="field-label">{WORK_LABEL[kind]}</span>
                    <select class="select" disabled={busy()} onChange={(e) => setModel(kind, e.currentTarget.value)}>
                      <option value="" selected={!i().models[kind]}>
                        Not set
                      </option>
                      <Show when={i().models[kind] && !(models() ?? []).some((m) => m.ref === i().models[kind]!.model)}>
                        <option value={i().models[kind]!.model} selected>
                          {i().models[kind]!.model}
                        </option>
                      </Show>
                      <For each={models() ?? []}>
                        {(m) => (
                          <option value={m.ref} selected={m.ref === i().models[kind]?.model}>
                            {m.ref}
                          </option>
                        )}
                      </For>
                    </select>
                    <span class="field-hint">{priceLine(i().models[kind])}</span>
                    <Show when={kind === "reply" && i().seesPhotos === false}>
                      <span class="field-hint">This model can't see photos: {first()} won't get an attach button.</span>
                    </Show>
                  </label>
                )}
              </For>
              </div>
              <For each={i().projects.filter((p) => p.coding.source === "project" || p.gathering.source === "project")}>
                {(p) => (
                  <p class="field-hint">
                    {p.name} uses its own model for{" "}
                    {[p.coding.source === "project" ? `fixes (${p.coding.pick?.model}, ${priceLine(p.coding.pick)})` : "", p.gathering.source === "project" ? `gatherings (${p.gathering.pick?.model}, ${priceLine(p.gathering.pick)})` : ""].filter(Boolean).join(" and ")}
                    .
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
