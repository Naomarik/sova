import { createMemo, createSignal, Show } from "solid-js";
import { Choice } from "../form";
import { HOW_HINT, HOW_LABEL, HOW_SHORT, inEffectWords, LAND_HOWS, landHowWaitingWords, signInWords, suggestionWords, type LandHow, type LandHowSetting } from "../../lib/merge-queue-requests";
import { clearLandHowOverride, saveLandHow } from "../../lib/merge-queue-requests-client";
import { short } from "../../lib/merge-queue";
import { announce, toast } from "../../lib/ui-state";
import "./MergeQueueLandHow.css";

/**
 * The first row of the Merge Queue settings' Landing group: How it lands (al_3 a1–a3). Four ways, what origin
 * suggests, the one in effect and where it comes from, and Clear Override when this computer's choice wins over the
 * project file's. Picking a different way asks where to keep it (this computer, or the project file through the
 * settings save) before anything changes; Land never offers a one-off choice (q4).
 */
export function MergeQueueLandHow(props: { project: string; target: string; settings: { how?: LandHowSetting } | undefined; editBlocked?: string; onSaved(): void }) {
  const s = (): LandHowSetting => props.settings?.how ?? { effective: "local", from: "default" };
  const [picked, setPicked] = createSignal<LandHow | null>(null);
  const [where, setWhere] = createSignal<"computer" | "project">("computer");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [said, setSaid] = createSignal<string | null>(null);
  const chosen = createMemo(() => picked() ?? s().effective);
  const changed = () => picked() !== null && picked() !== s().effective;
  const name = () => `mq-landhow-${props.project}`;
  const suggestion = () => suggestionWords(s());
  const signIn = () => signInWords({ effective: chosen(), signIn: picked() ? undefined : s().signIn });
  const projectBlocked = () => (where() === "project" ? props.editBlocked : undefined);

  const done = (m: string) => {
    setSaid(m);
    toast(m);
    announce(m);
    setPicked(null);
    props.onSaved();
  };
  const fail = (m: string) => {
    setError(m);
    announce(m);
  };

  const save = async () => {
    const how = picked();
    if (!how || busy()) return;
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const r = await saveLandHow(props.project, how, where());
      if (!r.ok) return fail(r.message);
      if (where() === "computer") return done(`${HOW_SHORT[how]} on this computer, from the next Land.`);
      if (r.body.state === "waiting") return done(landHowWaitingWords(how, r.body.release));
      done(`${HOW_SHORT[how]} saved to ${props.target}${r.body.commit ? ` as ${short(r.body.commit)}` : ""}; pushed with the next landing.`);
    } finally {
      setBusy(false);
    }
  };

  const clear = async () => {
    if (busy()) return;
    setBusy(true);
    setError(null);
    setSaid(null);
    try {
      const r = await clearLandHowOverride(props.project);
      if (!r.ok) return fail(r.message);
      done(`Cleared this computer's choice. The project's ${HOW_SHORT[s().project ?? "local"]} applies from the next Land.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="mq-landhow" role="group" aria-labelledby={`${name()}-label`} data-effective={s().effective} data-from={s().from}>
      <div class="mqs-row mq-landhow-head">
        <span class="mqs-label" id={`${name()}-label`}>
          How it lands
        </span>
        <span class="mqs-value mq-landhow-effect" data-testid="landhow-in-effect">
          {inEffectWords(s())}
        </span>
        <Show when={s().from === "computer"} fallback={<span class="mqs-tag">{s().from === "project" ? "Project file" : "Set by Sova"}</span>}>
          <button type="button" class="button button-sm button-ghost" disabled={busy()} aria-busy={busy() ? "true" : undefined} onClick={() => void clear()}>
            Clear Override
          </button>
        </Show>
      </div>
      <Choice
        cards
        labelledBy={`${name()}-label`}
        class="mq-landhow-choices"
        value={chosen()}
        options={LAND_HOWS.map((how) => ({ value: how, label: HOW_LABEL[how], hint: HOW_HINT[how] }))}
        disabled={busy()}
        onChange={(how) => {
          setPicked(how === s().effective ? null : (how as LandHow));
          setError(null);
          setSaid(null);
        }}
      />
      <Show when={suggestion()}>{(w) => <p class="text-caption text-muted mq-landhow-suggest">{w()}</p>}</Show>
      <Show when={signIn()}>{(w) => <p class="text-caption mq-landhow-warn" role="note">{w()}</p>}</Show>
      <Show when={changed()}>
        <div class="mq-landhow-save" role="group" aria-label="Where to keep it">
          <Choice
            cards
            label="Keep it"
            class="mq-landhow-where"
            value={where()}
            options={[
              { value: "computer", label: "This computer only", hint: "Applies at once and wins over the project file. Nothing is committed." },
              { value: "project", label: "Project file", hint: `Shared with everyone who runs Sova on this repo. Saved as one commit on ${props.target}.` },
            ]}
            disabled={busy()}
            onChange={(w) => setWhere(w as "computer" | "project")}
          />
          <Show when={projectBlocked()}>{(m) => <p class="text-caption mq-landhow-warn">{m()}</p>}</Show>
          <div class="button-row">
            <button type="button" class="button button-sm button-primary" disabled={busy() || !!projectBlocked()} aria-busy={busy() ? "true" : undefined} onClick={() => void save()}>
              {where() === "computer" ? "Save on This Computer" : "Save to Project File"}
            </button>
            <button type="button" class="button button-sm button-ghost" disabled={busy()} onClick={() => setPicked(null)}>
              Cancel
            </button>
          </div>
        </div>
      </Show>
      <Show when={error()}>{(m) => <p class="text-caption mq-error" role="alert">{m()}</p>}</Show>
      <Show when={said()}>{(m) => <p class="text-caption text-muted" role="status">{m()}</p>}</Show>
    </div>
  );
}

/** The a2 suggestion alone, for the tab's not-set-up screen (a project the queue doesn't serve yet): one line, or nothing. */
export function MergeQueueLandSuggestion(props: { settings: { how?: LandHowSetting } | undefined }) {
  const w = () => suggestionWords(props.settings?.how ?? { effective: "local" });
  return <Show when={w()}>{(t) => <p class="text-caption text-muted mq-landhow-suggest">{t()}</p>}</Show>;
}
