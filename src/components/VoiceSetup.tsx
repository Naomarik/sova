import { createSignal, For, onCleanup, Show } from "solid-js";
import type { VoiceStatus, VoiceStep } from "../../shared/protocol";
import { ApiError, cancelVoiceInstall, installVoice, repairVoice, transcribeVoice, uninstallVoice } from "../lib/api";
import { announce } from "../lib/ui-state";
import { captureSupported, startCapture, type Recorder } from "../lib/voice/capture";
import { backendWithDevice, diskSize, megabytes, micErrorSentence, readyLine, STEP_LABEL, STEP_STATE_WORD, stepFigure, unsupportedReason } from "../lib/voice/format";
import { voiceDeviceInfo } from "../lib/voice/device";
import { adoptVoice, refreshVoice, voiceLog, voiceStatus, voiceStatusError, watchVoice } from "../lib/voice/status";
import { SPEECH_RMS } from "../lib/voice/wav";
import { Banner, Icon, trapFocus } from "./ui";
import { VoiceCalibration } from "./VoiceCalibration";
import { VoiceModels } from "./VoiceModels";
import "../design/voice.css";

const time24 = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour12: false });

/** What Uninstall removes besides whisper.cpp: transcribe.cpp once Parakeet brought it, then the models. */
const modelsOnDisk = (s: VoiceStatus) => {
  const kept = s.models.filter((m) => m.state === "ready" || m.state === "downloading" || m.state === "verifying" || m.state === "failed");
  const engine = kept.some((m) => m.engine === "transcribe") ? "transcribe.cpp, " : "";
  return `${engine}${kept.length === 1 ? "the model" : `${kept.length} models`}`;
};

/** What setup will do, in one or two sentences (§design.copy-deck/settings-voice). */
function intro(s: VoiceStatus): string {
  const model = megabytes(s.model.bytes);
  if (s.gpu.backend === "cpu") {
    const how = s.cpuPrebuilt ? "uses a prebuilt whisper.cpp for the CPU" : "builds whisper.cpp for the CPU (a few minutes)";
    return `Dictation runs on this Sova host, not in the browser. Setup ${how}, downloads the ${model} speech model, and tests it. No GPU backend was found, so each clip takes longer; the self-test shows how long. Audio never leaves this host.`;
  }
  return `Dictation runs on this Sova host, not in the browser. Setup builds whisper.cpp for ${backendWithDevice(s.gpu.backend, s.gpu.device)} (a few minutes), downloads the ${model} speech model, and tests it. Audio never leaves this host.`;
}

function StepList(props: { steps: VoiceStep[] }) {
  return (
    <ol class="voice-steps" aria-label="Setup steps">
      <For each={props.steps}>
        {(step) => (
          <li class="voice-step" data-state={step.state}>
            <span class="voice-step-mark" aria-hidden="true">
              <Show when={step.state === "running"} fallback={<Icon name={step.state === "done" ? "check" : step.state === "failed" ? "alert-circle" : step.state === "skipped" ? "check" : "clock"} small />}>
                <span class="live-dot" />
              </Show>
            </span>
            <span class="voice-step-label">{STEP_LABEL[step.id]}</span>
            <span class="voice-step-state">{STEP_STATE_WORD[step.state]}</span>
            <Show when={(step.state === "running" && stepFigure(step)) || step.note}>
              {(detail) => <span class="voice-step-detail text-mono">{detail()}</span>}
            </Show>
          </li>
        )}
      </For>
    </ol>
  );
}

function LogBlock() {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="voice-log">
      <button type="button" class="button button-sm button-ghost" aria-expanded={open() ? "true" : "false"} onClick={() => setOpen(!open())}>
        <Icon name={open() ? "chevron-down" : "chevron-right"} small />
        {open() ? "Hide Log" : "Show Log"}
      </button>
      <Show when={open()}>
        <pre class="voice-log-lines text-mono" tabindex="0" aria-label="Setup log">
          <For each={voiceLog()} fallback={"No log lines yet."}>
            {(l) => `${time24(l.at)} ${l.text}\n`}
          </For>
        </pre>
      </Show>
    </div>
  );
}

/** Test Microphone: up to 3 seconds, shown, never inserted anywhere. */
function MicTest() {
  const [phase, setPhase] = createSignal<"idle" | "recording" | "working">("idle");
  const [left, setLeft] = createSignal(3);
  const [result, setResult] = createSignal<string | null>(null);
  let rec: Recorder | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  onCleanup(() => {
    clearInterval(timer);
    rec?.cancel();
  });
  const finish = async () => {
    clearInterval(timer);
    const r = rec;
    rec = null;
    if (!r) return;
    setPhase("working");
    const clip = await r.stop();
    if (clip.peakRms < SPEECH_RMS) {
      setResult("Heard nothing.");
      setPhase("idle");
      return;
    }
    try {
      const out = await transcribeVoice(clip.wav, voiceDeviceInfo());
      setResult(out.text ? `Heard: “${out.text}” (${(out.ms / 1000).toFixed(1)} s)` : "Heard nothing.");
    } catch (err) {
      setResult(`Couldn't transcribe the clip. ${(err as Error).message}`);
    }
    announce(result() ?? "");
    setPhase("idle");
  };
  const start = () => {
    if (phase() === "recording") return void finish();
    if (phase() !== "idle") return;
    const why = unsupportedReason(captureSupported());
    if (why) {
      setResult(why);
      return;
    }
    setResult(null);
    setLeft(3);
    setPhase("recording");
    startCapture({ onLevel: () => {}, onInterrupt: () => void finish() }).then(
      (r) => {
        rec = r;
        timer = setInterval(() => {
          const s = r.seconds();
          setLeft(Math.max(0, Math.ceil(3 - s)));
          if (s >= 3) void finish();
        }, 200);
      },
      (err) => {
        setResult(micErrorSentence(err));
        setPhase("idle");
      },
    );
  };
  return (
    <div class="voice-test">
      <button type="button" class="button" aria-disabled={phase() === "working" ? "true" : undefined} onClick={start}>
        <Icon name={phase() === "recording" ? "stop" : "mic"} small />
        {phase() === "recording" ? `Stop (${left()} s)` : phase() === "working" ? "Transcribing…" : "Test Microphone"}
      </button>
      <Show when={result()}>{(r) => <p class="voice-test-result">{r()}</p>}</Show>
    </div>
  );
}

/** The one setup view: the composer's sheet and Settings → Voice both render it (§app.settings-dialog/voice). */
export function VoiceSetupView(props: { context: "sheet" | "settings" }) {
  const s = () => voiceStatus();
  const [busy, setBusy] = createSignal(false);
  const [actionError, setActionError] = createSignal<string | null>(null);
  const [copied, setCopied] = createSignal(false);
  const [confirmUninstall, setConfirmUninstall] = createSignal(false);

  const act = async (fn: () => Promise<VoiceStatus | { freed: number }>, said?: string) => {
    if (busy()) return;
    setBusy(true);
    setActionError(null);
    try {
      const out = await fn();
      if ("state" in out) adoptVoice(out);
      else await refreshVoice();
      if (said) announce(said);
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : String(err));
      void refreshVoice();
    } finally {
      setBusy(false);
    }
  };
  const setUp = (mode: "gpu" | "cpu" = "gpu") => act(() => installVoice(mode), "Setting up voice.");
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      announce("Copied.");
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setActionError("Couldn't copy. Select the command and copy it by hand.");
    }
  };
  const failedStep = () => s()?.install?.steps.find((x) => x.state === "failed");
  const stepIndex = () => {
    const steps = s()?.install?.steps ?? [];
    const i = steps.findIndex((x) => x.state === "running");
    return i < 0 ? steps.filter((x) => x.state !== "pending").length : i + 1;
  };
  const offerCpu = () => !!s()?.cpuPrebuilt && s()?.gpu.backend !== "cpu" && s()?.install?.mode !== "cpu";

  return (
    <div class="voice-setup">
      <Show when={s()} fallback={<Show when={voiceStatusError()} fallback={<div class="skeleton skeleton-line" />}>{(e) => <Banner tone="error" title="Couldn't read the voice status." body={e()} />}</Show>}>
        {(st) => (
          <>
            <Show when={st().state === "unsupported"}>
              <p class="settings-intro">{st().reason}</p>
            </Show>

            <Show when={st().state === "not-installed"}>
              <p class="settings-intro">{intro(st())}</p>
              <Show when={st().install?.outcome === "cancelled"}>
                <p class="settings-intro">Setup cancelled. Everything done so far is kept; Set Up Voice picks up where it stopped.</p>
              </Show>
              <div class="voice-actions">
                <button type="button" class="button button-primary" aria-disabled={busy() ? "true" : undefined} onClick={() => void setUp()}>
                  <Icon name="mic" small />
                  Set Up Voice
                </button>
              </div>
            </Show>

            <Show when={st().state === "installing"}>
              <p class="voice-progress-line" aria-live="off">Setting up voice · step {stepIndex()} of {st().install?.steps.length ?? 7}</p>
              <StepList steps={st().install?.steps ?? []} />
              <div class="voice-actions">
                <button type="button" class="button button-ghost" onClick={() => void act(cancelVoiceInstall, "Setup cancelled.")}>
                  Cancel Setup
                </button>
              </div>
              <LogBlock />
            </Show>

            <Show when={st().state === "needs-packages" && st().missing}>
              {(m) => (
                <>
                  <div class="voice-needs">
                    <p class="voice-needs-title">This host needs {m().packages.length} {m().packages.length === 1 ? "package" : "packages"} to build whisper.cpp.</p>
                    <Show
                      when={m().command}
                      fallback={<p class="settings-intro">Install these, then check again: {m().packages.join(", ")}.</p>}
                    >
                      {(cmd) => (
                        <>
                          <p class="settings-intro">Run this on the Sova host, then check again. Sova never runs sudo.</p>
                          <pre class="voice-command text-mono">{cmd()}</pre>
                        </>
                      )}
                    </Show>
                  </div>
                  <div class="voice-actions">
                    <button type="button" class="button button-primary" aria-disabled={busy() ? "true" : undefined} onClick={() => void setUp(st().install?.mode ?? "gpu")}>
                      <Icon name="refresh" small />
                      Check Again
                    </button>
                    <Show when={m().command}>
                      {(cmd) => (
                        <button type="button" class="button" onClick={() => void copy(cmd())}>
                          <Icon name={copied() ? "check" : "copy"} small />
                          {copied() ? "Copied." : "Copy Command"}
                        </button>
                      )}
                    </Show>
                    <Show when={offerCpu()}>
                      <button type="button" class="button button-ghost" onClick={() => void setUp("cpu")}>
                        Use CPU Instead
                      </button>
                    </Show>
                  </div>
                  <StepList steps={st().install?.steps ?? []} />
                </>
              )}
            </Show>

            <Show when={st().state === "failed"}>
              <Banner
                tone="error"
                title={`Setup stopped at ${failedStep() ? STEP_LABEL[failedStep()!.id].toLowerCase() : "a step"}.`}
                body={`${failedStep()?.error ?? "Unknown error"}. Everything before it is kept.`}
              />
              <div class="voice-actions">
                <button type="button" class="button button-primary" aria-disabled={busy() ? "true" : undefined} onClick={() => void setUp(st().install?.mode ?? "gpu")}>
                  Retry
                </button>
                <Show when={offerCpu()}>
                  <button type="button" class="button button-ghost" onClick={() => void setUp("cpu")}>
                    Use CPU Instead
                  </button>
                </Show>
              </div>
              <StepList steps={st().install?.steps ?? []} />
              <LogBlock />
            </Show>

            <Show when={st().state === "ready"}>
              <Show
                when={props.context === "settings"}
                fallback={<p class="settings-intro">Voice is ready. Tap the mic to dictate.</p>}
              >
                <p class="voice-ready-line">
                  <span class="chip chip-success"><span class="chip-dot" />Ready</span>
                  <span>{readyLine(st()).replace(/^Ready · /, "")}</span>
                </p>
                <Show when={st().runtime.crashedOut}>
                  <Banner tone="error" title="whisper-server stopped 3 times in a minute." body="Repair to try again." />
                </Show>
                <MicTest />
                <VoiceModels st={st()} busy={busy()} act={act} />
                <VoiceCalibration st={st()} busy={busy()} act={act} />
                <div class="voice-section">
                  <div class="voice-actions">
                    <button type="button" class="button" aria-disabled={busy() ? "true" : undefined} title="Checks every file again, every model included, and reruns the self-test." onClick={() => void act(repairVoice, "Repairing voice.")}>
                      <Icon name="wrench" small />
                      Repair
                    </button>
                    <button type="button" class="button button-destructive" onClick={() => setConfirmUninstall(true)}>
                      Uninstall Voice
                    </button>
                  </div>
                </div>
                <Show when={confirmUninstall()}>
                  <Banner
                    tone="warn"
                    title="Uninstall voice?"
                    body={`The voice folder${st().diskBytes !== undefined ? ` (${diskSize(st().diskBytes!)})` : ""} goes away: whisper.cpp, ${modelsOnDisk(st())}, the calibration clips, and the logs. System packages stay installed.`}
                    action={
                      <span class="cluster">
                        <button type="button" class="button button-sm button-ghost" onClick={() => setConfirmUninstall(false)}>
                          Cancel
                        </button>
                        <button
                          type="button"
                          class="button button-sm button-destructive"
                          onClick={() =>
                            void act(uninstallVoice, "Voice uninstalled.").then(() => setConfirmUninstall(false))
                          }
                        >
                          Uninstall
                        </button>
                      </span>
                    }
                  />
                </Show>
              </Show>
            </Show>

            <Show when={actionError()}>{(e) => <Banner tone="error" title="That didn't work." body={e()} />}</Show>
          </>
        )}
      </Show>
    </div>
  );
}

/** The composer's setup sheet: what a mic press opens while voice isn't ready. */
export function VoiceSheet(props: { onClose(): void }) {
  watchVoice();
  return (
    <>
      <div class="scrim" onClick={() => props.onClose()} />
      <div
        class="modal voice-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="voice-sheet-title"
        ref={(el) => trapFocus(el)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            props.onClose();
          }
        }}
      >
        <div class="sheet-grip" aria-hidden="true" />
        <div class="modal-head">
          <h2 class="modal-title" id="voice-sheet-title">
            Set up voice
          </h2>
        </div>
        <div class="modal-body">
          <VoiceSetupView context="sheet" />
        </div>
        <div class="modal-foot">
          <span class="modal-spacer" />
          <button type="button" class="button button-ghost" onClick={() => props.onClose()}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}

/** Settings → Voice: the same view with the ready tools. Polls while mounted (its tab is open). */
export function VoiceSettingsSection() {
  watchVoice({ size: true });
  return (
    <section class="settings-delegate voice-settings" aria-labelledby="voice-settings-title">
      <div class="settings-type-head">
        <h3 class="settings-type-title" id="voice-settings-title">
          Voice
        </h3>
      </div>
      <VoiceSetupView context="settings" />
    </section>
  );
}
