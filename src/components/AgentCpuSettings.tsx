import { createResource, createSignal, Show } from "solid-js";
import { agentCoresRule, type AgentCpuState } from "../../shared/agent-cpu";
import { check } from "../../shared/form-rules";
import { coresWord, driftLine, firstCeiling, savedLine } from "../lib/agent-cpu";
import { getAgentCpu, setAgentCpu } from "../lib/api";
import { announce, toast } from "../lib/ui-state";
import { NumberField, Toggle } from "./form";

/**
 * Settings → General's **Agents' CPU · this computer** (server/agent-cpu.ts): an off-by-default ceiling
 * on the CPU all agents together may use, "Agents may use at most N of M cores". Saved at once: the
 * switch when flipped, the number when it is committed (Enter or leaving the box), never per keystroke.
 * Where it can't apply (macOS, no systemd user manager) the switch is disabled and the hint says why.
 */
export function AgentCpuSection() {
  const [state, { mutate }] = createResource(getAgentCpu);
  const [saving, setSaving] = createSignal(false);
  /** The box's own text while it differs from what is saved. */
  const [typed, setTyped] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);

  /** A failed save from the box says so under it; one from the switch puts the switch back and says so in a toast. */
  const save = (maxCores: number | null, undo?: () => void) => {
    setSaving(true);
    setError(null);
    setAgentCpu(maxCores)
      .then((next) => {
        mutate(next);
        setTyped(null);
        announce(savedLine(next));
      })
      .catch((err: Error) => {
        if (undo) {
          undo();
          toast(`Couldn't change the agents' CPU. ${err.message}`);
        } else setError(`Couldn't change that. ${err.message}`);
      })
      .finally(() => setSaving(false));
  };

  const flip = (s: AgentCpuState, on: boolean, el: HTMLInputElement) => {
    if (saving()) {
      el.checked = !on;
      return;
    }
    // Nothing changed on a failure: the switch goes back to what the server has.
    save(on ? firstCeiling(s.cores) : null, () => (el.checked = !on));
  };

  const commit = (s: AgentCpuState) => {
    const raw = typed();
    if (raw === null || saving()) return;
    const r = check(agentCoresRule(s.cores), raw);
    if (!r.ok || r.value === null) return; // the box is red with the rule's sentence; nothing is saved
    if (r.value === s.maxCores) return void setTyped(null);
    save(r.value);
  };

  return (
    <section class="settings-updates settings-agent-cpu" aria-labelledby="settings-agent-cpu-title">
      <h3 class="settings-type-title" id="settings-agent-cpu-title">
        Agents' CPU · this computer
      </h3>
      <Show when={state.error && !state()}>
        <p class="field-error">Couldn't read this setting. {(state.error as Error).message}</p>
      </Show>
      <Show when={state()}>
        {(s) => (
          <>
            <Toggle
              switch
              class="settings-field"
              label="Limit agents' CPU"
              hint={
                s().available
                  ? "Off by default. On, all agents together, with their background jobs and project services, may use at most the cores you set. The Sova server isn't limited."
                  : s().why
              }
              checked={s().maxCores !== null}
              disabled={!s().available || saving()}
              onChange={(on, el) => flip(s(), on, el)}
            />
            <Show when={s().available && s().maxCores !== null}>
              <NumberField
                id="agent-cpu-cores"
                class="settings-field"
                label="Agents may use at most"
                rule={agentCoresRule(s().cores)}
                error={error()}
                value={typed() ?? String(s().maxCores ?? "")}
                disabled={saving()}
                inputClass="agent-cpu-input"
                afterClass="agent-cpu-row"
                after={<span class="agent-cpu-of text-num">of {coresWord(s().cores)}</span>}
                onInput={(v) => (setError(null), setTyped(v))}
                onChange={() => commit(s())}
              />
            </Show>
            <Show when={driftLine(s())}>{(line) => <p class="field-hint">{line()}</p>}</Show>
          </>
        )}
      </Show>
    </section>
  );
}
