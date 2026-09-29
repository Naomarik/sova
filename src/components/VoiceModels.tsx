import { createSignal, For, Show } from "solid-js";
import type { VoiceModelState, VoiceStatus } from "../../shared/protocol";
import { cancelVoiceModelDownload, deleteVoiceModel, downloadVoiceModel, useVoiceModel } from "../lib/api";
import { announce } from "../lib/ui-state";
import { diskSize, ENGINE_LABEL, languagesWord, modelName } from "../lib/voice/format";
import { Banner, Chip, Icon } from "./ui";

type Act = (fn: () => Promise<VoiceStatus | { freed: number }>, said?: string) => Promise<void>;

/** The room a download needs: the file, the engine on first use, and 50 MB to spare. */
const needBytes = (m: VoiceModelState) => m.bytes + (m.engineBytes ?? 0) + 50e6;

const CHECKSUM = "The download didn't match its checksum and was deleted. Download it again.";

const pct = (p?: { done: number; total: number }) => (p ? Math.round((p.done / Math.max(1, p.total)) * 100) : 0);

/** The Models section of the Ready view (§app.settings-dialog/voice-models). */
export function VoiceModels(props: { st: VoiceStatus; busy: boolean; act: Act }) {
  const [confirmDelete, setConfirmDelete] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const job = () => (props.st.modelJob && !props.st.modelJob.outcome ? props.st.modelJob : undefined);
  const models = () => [...props.st.models].sort((a, b) => a.bytes - b.bytes);
  const onDisk = () => props.st.models.filter((m) => m.state === "ready");
  const activeModel = () => props.st.models.find((m) => m.active);
  const toDelete = () => props.st.models.find((m) => m.id === confirmDelete());

  /** Why `Download` can't run now, or null. */
  const downloadBlocked = (m: VoiceModelState): string | null => {
    if (job()) return "Another download is running.";
    const free = props.st.diskFree;
    if (free !== undefined && free < needBytes(m)) return `Needs ${diskSize(needBytes(m))}; this disk has ${diskSize(free)} free.`;
    return null;
  };
  /** Why `Use This Model` can't run now, or null. */
  const switchBlocked = (): string | null => {
    if (job()) return "Another download is running.";
    if (props.st.sweep) return "Stop Calibration first.";
    return null;
  };
  const guarded = (why: string | null, run: () => void) => () => {
    if (why || props.busy) return;
    run();
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      announce("Copied.");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The command stays on screen to select by hand.
    }
  };

  /** The caption under a row's name: size, languages, then its state. */
  const meta = (m: VoiceModelState): string => {
    const parts = [diskSize(m.bytes), languagesWord(m.languages)];
    if (m.engine === "transcribe") parts.push(ENGINE_LABEL.transcribe);
    if (!m.tunable) parts.push("No prompt or voice detection");
    if (m.active && m.selftestMs) parts.push(`self-test ${(m.selftestMs / 1000).toFixed(1)} s`);
    else if (m.state === "absent") parts.push("Not downloaded");
    else if (m.state === "ready") parts.push(m.importedFrom ? `Copied from ${m.importedFrom}` : "Downloaded");
    return parts.join(" · ");
  };
  /** A failure's sentence (§design.copy-deck/settings-voice). */
  const failure = (m: VoiceModelState): string | null => {
    const j = props.st.modelJob;
    if (j && j.model === m.id && j.outcome === "failed" && j.kind === "switch")
      return `${modelName(m)} didn't pass the self-test (heard “${m.selftestText ?? ""}”). Still using ${activeModel() ? modelName(activeModel()!) : props.st.activeModel}.`;
    if (m.state !== "failed" || !m.error) return null;
    return m.error === CHECKSUM ? CHECKSUM : `Couldn't download ${modelName(m)}. ${m.error.replace(/\.$/, "")}. Nothing else changed.`;
  };

  const Row = (p: { m: VoiceModelState }) => {
    const m = () => p.m;
    const testing = () => job()?.kind === "switch" && job()!.model === m().id;
    return (
      <li class="list-row voice-model" data-state={m().state}>
        <div class="list-main">
          <p class="voice-model-name">
            <span>{modelName(m())}</span>
            <Show when={m().active}>
              <Chip tone="success" title="Switch to another model first.">
                In Use
              </Chip>
            </Show>
            <Show when={m().recommended && !m().active}>
              <Chip tone="info">Recommended</Chip>
            </Show>
          </p>
          <p class="voice-model-meta">{meta(m())}</p>
          <Show when={m().state === "downloading" || m().state === "verifying"}>
            <div class="meter voice-model-meter">
              <p class="meter-head">
                <span class="meter-label">{m().state === "verifying" ? `Checking the file… ${pct(m().progress)}%` : "Downloading"}</span>
                <Show when={m().state === "downloading" && m().progress}>
                  {(pr) => (
                    <span class="meter-value">
                      {Math.round(pr().done / 1e6).toLocaleString("en-US")} <span class="meter-of">of {diskSize(pr().total)}</span>
                    </span>
                  )}
                </Show>
              </p>
              <div class="meter-track">
                <span class="meter-fill" style={{ "--meter-pct": `${pct(m().progress)}%` }} />
              </div>
            </div>
          </Show>
          <Show when={testing()}>
            <p class="voice-model-meta">Testing…</p>
          </Show>
          <Show when={failure(m())}>
            {(e) => (
              <p class="voice-model-error">
                <Icon name="alert-circle" small />
                <span>{e()}</span>
              </p>
            )}
          </Show>
          <Show when={m().state === "needs-packages" && m().missing}>
            {(miss) => (
              <div class="voice-needs">
                <p class="voice-needs-title">
                  Parakeet needs {miss().packages.length} {miss().packages.length === 1 ? "package" : "packages"} to build its engine.
                </p>
                <Show when={miss().command} fallback={<p class="settings-intro">Install these, then check again: {miss().packages.join(", ")}.</p>}>
                  {(cmd) => (
                    <>
                      <p class="settings-intro">Run this on the Sova host, then check again.</p>
                      <pre class="voice-command text-mono">{cmd()}</pre>
                    </>
                  )}
                </Show>
              </div>
            )}
          </Show>
        </div>
        <div class="voice-model-actions">
          <Show when={m().state === "absent" || m().state === "failed"}>
            <button
              type="button"
              class="button button-sm"
              aria-disabled={downloadBlocked(m()) || props.busy ? "true" : undefined}
              title={downloadBlocked(m()) ?? undefined}
              onClick={guarded(downloadBlocked(m()), () => void props.act(() => downloadVoiceModel(m().id), `Downloading ${modelName(m())}.`))}
            >
              {m().state === "failed" ? "Retry" : "Download"}
            </button>
          </Show>
          <Show when={m().state === "needs-packages"}>
            <button
              type="button"
              class="button button-sm"
              aria-disabled={job() || props.busy ? "true" : undefined}
              onClick={guarded(job() ? "busy" : null, () => void props.act(() => downloadVoiceModel(m().id)))}
            >
              Check Again
            </button>
            <Show when={m().missing?.command}>
              {(cmd) => (
                <button type="button" class="button button-sm" onClick={() => void copy(cmd())}>
                  <Icon name={copied() ? "check" : "copy"} small />
                  {copied() ? "Copied." : "Copy Command"}
                </button>
              )}
            </Show>
          </Show>
          <Show when={m().state === "downloading" || m().state === "verifying"}>
            <button type="button" class="button button-sm button-ghost" onClick={() => void props.act(cancelVoiceModelDownload, "Download cancelled.")}>
              Cancel Download
            </button>
          </Show>
          <Show when={m().state === "ready" && !m().active && !testing()}>
            <button
              type="button"
              class="button button-sm"
              aria-disabled={switchBlocked() || props.busy ? "true" : undefined}
              title={switchBlocked() ?? undefined}
              onClick={guarded(switchBlocked(), () => void props.act(() => useVoiceModel(m().id), `Testing ${modelName(m())}.`))}
            >
              Use This Model
            </button>
            <button
              type="button"
              class="button button-sm button-destructive"
              aria-disabled={job() ? "true" : undefined}
              title={job() ? "Another download is running." : undefined}
              onClick={() => !job() && setConfirmDelete(m().id)}
            >
              Delete Model
            </button>
          </Show>
        </div>
      </li>
    );
  };

  return (
    <section class="voice-section" aria-labelledby="voice-models-title">
      <h4 class="voice-section-title" id="voice-models-title">
        Models
      </h4>
      <p class="settings-intro">One model runs for the whole host. Each device keeps its own settings for each model.</p>
      <ul class="list voice-models" aria-label="Models">
        {/* Keyed by id: every poll brings new objects, and a rebuilt row would drop keyboard focus. */}
        <For each={models().map((m) => m.id)}>{(id) => <Row m={models().find((m) => m.id === id)!} />}</For>
      </ul>
      <Show when={toDelete()}>
        {(m) => (
          <Banner
            tone="warn"
            title={`Delete ${modelName(m())}?`}
            body={`Its ${diskSize(m().bytes)} file goes away. Its calibration results stay, in case you download it again.`}
            action={
              <span class="cluster">
                <button type="button" class="button button-sm button-ghost" onClick={() => setConfirmDelete(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  class="button button-sm button-destructive"
                  onClick={() => void props.act(() => deleteVoiceModel(m().id), `Deleted ${modelName(m())}.`).then(() => setConfirmDelete(null))}
                >
                  Delete
                </button>
              </span>
            }
          />
        )}
      </Show>
      <p class="voice-caption">
        {onDisk().length === 1 ? "1 model" : `${onDisk().length} models`} · {diskSize(onDisk().reduce((n, m) => n + m.bytes, 0))} on disk
        <Show when={props.st.diskFree !== undefined}> · {diskSize(props.st.diskFree!)} free on this disk</Show>
      </p>
    </section>
  );
}
