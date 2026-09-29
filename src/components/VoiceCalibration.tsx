import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import type { VoiceCalibrationRow, VoiceCalibrationRun, VoiceModelScore, VoiceStatus } from "../../shared/protocol";
import { applyCalibration, deleteCalibrationClips, forgetVoiceDevice, putCalibrationClip, revertCalibration, runCalibration, stopCalibration } from "../lib/api";
import { relativeTime, shortDate } from "../lib/format";
import { announce } from "../lib/ui-state";
import { captureSupported, startCapture, type Recorder } from "../lib/voice/capture";
import { voiceDeviceId, voiceDeviceInfo } from "../lib/voice/device";
import { BACKEND_LABEL, clock, etaSentence, micErrorSentence, modelName, percentWer, perClip, roughTime, settingsWords, unsupportedReason, wordDiff } from "../lib/voice/format";
import { adoptVoice } from "../lib/voice/status";
import { SPEECH_RMS } from "../lib/voice/wav";
import { Banner, Chip, Icon } from "./ui";

type Act = (fn: () => Promise<VoiceStatus | { freed: number }>, said?: string) => Promise<void>;

/** A sentence stops itself at 20 s, the passage at 60 s. */
const capSec = (long?: boolean) => (long ? 60 : 20);

const nameOf = (st: VoiceStatus, id: string) => {
  const m = st.models.find((x) => x.id === id);
  return m ? modelName(m) : id;
};

/** One sweep on this install: how many settings, and about how long on `clips` clips. */
function estimate(st: VoiceStatus, clips: number): { settings: number; sec: number } {
  const active = st.models.find((m) => m.id === st.activeModel);
  const settings = active && !active.tunable ? 1 : st.installed?.backend === "cpu" ? 8 : 24;
  // The self-test clip is 3 s; a sentence is about twice that. The current settings run twice.
  const perInference = Math.max(0.3, ((active?.selftestMs ?? st.installed?.selftestMs ?? 500) / 1000) * 2);
  return { settings, sec: (settings + (settings > 1 ? 1 : 0)) * clips * perInference };
}

/** The recording steps: one sentence at a time, tap to start, tap to stop (§chat.voice/capture). */
function Sentences(props: { st: VoiceStatus; start: number; busy: boolean; runBlocked: string | null; onClose(): void; onRun(): void }) {
  const cal = () => props.st.calibration!;
  const sentences = () => cal().sentences;
  const [i, setI] = createSignal(props.start);
  const [phase, setPhase] = createSignal<"idle" | "recording" | "uploading">("idle");
  const [sec, setSec] = createSignal(0);
  const [level, setLevel] = createSignal(0);
  const [line, setLine] = createSignal<string | null>(null);
  let rec: Recorder | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const drop = () => {
    clearInterval(timer);
    rec?.cancel();
    rec = null;
  };
  onCleanup(drop);

  const sentence = () => sentences()[i()];
  const clipOf = (n: number) => cal().clips.find((c) => c.n === n);
  const recorded = () => cal().clips.length;

  const go = (to: number) => {
    drop();
    setPhase("idle");
    setLine(null);
    setI(to);
  };

  const finish = async () => {
    clearInterval(timer);
    const r = rec;
    rec = null;
    const s = sentence();
    if (!r || !s) {
      setPhase("idle");
      return;
    }
    setPhase("uploading");
    const clip = await r.stop();
    if (clip.peakRms < SPEECH_RMS) {
      setLine("Didn't catch any speech. Record it again.");
    } else {
      try {
        adoptVoice(await putCalibrationClip(voiceDeviceInfo(), s.n, clip.wav));
        setLine(`Got ${clip.sec.toFixed(1)} s.`);
      } catch (err) {
        setLine((err as Error).message);
      }
    }
    announce(line()!);
    setPhase("idle");
  };

  /** The press: `startCapture` runs synchronously here, as iOS requires. */
  const press = () => {
    if (phase() === "recording") return void finish();
    if (phase() !== "idle") return;
    const why = unsupportedReason(captureSupported());
    if (why) {
      setLine(why);
      return;
    }
    const cap = capSec(sentence()?.long);
    setLine(null);
    setSec(0);
    setLevel(0);
    setPhase("recording");
    startCapture({
      onLevel: setLevel,
      onInterrupt: () => {
        if (phase() !== "recording") return;
        drop();
        setPhase("idle");
        setLine("Recording stopped when the app went to the background. Record this sentence again.");
      },
    }).then(
      (r) => {
        // Stopped or left before the mic opened: nothing to keep.
        if (phase() !== "recording") return r.cancel();
        rec = r;
        timer = setInterval(() => {
          const s = r.seconds();
          setSec(s);
          if (s >= cap) void finish();
        }, 200);
      },
      (err) => {
        setLine(micErrorSentence(err));
        setPhase("idle");
      },
    );
  };

  /** "Sentence 2 of 6", then "Passage"; empty on the last step. An accessor read in JSX, so it tracks i(). */
  const eyebrow = () => {
    const s = sentence();
    if (!s) return "";
    return s.long ? "Passage" : `Sentence ${i() + 1} of ${sentences().filter((x) => !x.long).length}`;
  };
  const est = () => estimate(props.st, recorded());
  const enough = () => recorded() >= cal().minClips;
  const backend = () => BACKEND_LABEL[props.st.installed?.backend ?? props.st.gpu.backend];

  return (
    <div
      class="voice-cal-flow"
      onKeyDown={(e) => {
        // Esc drops the take, never Settings.
        if (e.key === "Escape" && phase() === "recording") {
          e.stopPropagation();
          e.preventDefault();
          go(i());
        }
      }}
    >
      <div class="voice-cal-flow-head">
        <span class="text-eyebrow">{eyebrow()}</span>
        <button type="button" class="button button-sm button-ghost" onClick={() => props.onClose()}>
          Cancel Calibration
        </button>
      </div>

      <Show
        when={sentence()}
        fallback={
          <>
            <p class="settings-intro">
              {enough()
                ? `${est().settings} ${est().settings === 1 ? "setting" : "settings"} × ${recorded()} clips ≈ ${roughTime(est().sec)} on ${backend()}`
                : "At least 4 clips are needed."}
            </p>
            <div class="voice-actions">
              <button
                type="button"
                class="button button-primary"
                aria-disabled={!enough() || props.runBlocked || props.busy ? "true" : undefined}
                title={props.runBlocked ?? (enough() ? undefined : "At least 4 clips are needed.")}
                onClick={() => enough() && !props.runBlocked && !props.busy && props.onRun()}
              >
                Find Best Settings
              </button>
            </div>
          </>
        }
      >
        {(s) => (
          <>
            <p class="voice-cal-sentence">{s().text}</p>
            <Show when={s().long}>
              <p class="settings-intro">Optional. About 35 seconds.</p>
            </Show>
            <Show when={phase() === "recording"}>
              <div class="voice-cal-recording" aria-live="off">
                <span>Recording {clock(sec())}</span>
                <span class="voice-level" aria-hidden="true">
                  <span class="voice-level-num text-num">{level()}</span>
                  <span class="voice-level-track">
                    <span class="voice-level-fill" style={{ width: `${level()}%` }} />
                  </span>
                </span>
              </div>
            </Show>
            <Show when={line() ?? (phase() === "idle" && clipOf(s().n) ? `Got ${clipOf(s().n)!.sec.toFixed(1)} s.` : null)}>
              {(l) => <p class="voice-test-result">{l()}</p>}
            </Show>
            <div class="voice-actions">
              <Show
                when={phase() === "idle" && clipOf(s().n)}
                fallback={
                  <button
                    type="button"
                    class="button"
                    classList={{ "button-primary": phase() !== "recording", "voice-cal-stop": phase() === "recording" }}
                    aria-disabled={phase() === "uploading" ? "true" : undefined}
                    onClick={press}
                  >
                    <Icon name={phase() === "recording" ? "stop" : "mic"} small />
                    {phase() === "recording" ? "Stop Recording" : "Record Sentence"}
                  </button>
                }
              >
                <button type="button" class="button button-primary" onClick={() => go(i() + 1)}>
                  Next Sentence
                </button>
                <button type="button" class="button" onClick={press}>
                  <Icon name="mic" small />
                  Record Again
                </button>
              </Show>
              <Show when={phase() === "idle" && !clipOf(s().n)}>
                <button type="button" class="button button-ghost" onClick={() => go(i() + 1)}>
                  Skip Sentence
                </button>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}

/** A results row: its settings (or its model), its scores, and, opened, each clip read against what was heard. */
function ResultRow(props: { row: VoiceCalibrationRow; best: boolean; name: string; st: VoiceStatus; tunable: boolean; busy: boolean; onUse(): void }) {
  const [open, setOpen] = createSignal(false);
  const r = () => props.row;
  const textOf = (n: number) => props.st.calibration?.sentences.find((s) => s.n === n)?.text ?? "";
  return (
    <li class="list-row voice-result">
      <div class="list-main">
        <button type="button" class="voice-result-toggle" aria-expanded={open() ? "true" : "false"} onClick={() => setOpen(!open())}>
          <Icon name={open() ? "chevron-down" : "chevron-right"} small />
          <span class="voice-result-name">{props.name}</span>
        </button>
        <p class="voice-result-tags">
          <Show when={props.best && props.tunable}>
            <Chip tone="success">Best</Chip>
          </Show>
          <Show when={r().current && props.tunable}>
            <Chip>Current</Chip>
          </Show>
        </p>
        <p class="voice-model-meta">
          {percentWer(r().wer)} word error · {r().jargonHits} of {r().jargonTotal} jargon · {perClip(r().medianMs)} per clip
        </p>
        <Show when={open()}>
          <ol class="voice-result-clips">
            <For each={r().clips}>
              {(c) => (
                <li class="voice-result-clip">
                  <p class="voice-result-ref">Read: {textOf(c.n)}</p>
                  <p class="voice-diff">
                    {"Heard: "}
                    <For each={wordDiff(textOf(c.n), c.heard)}>
                      {(w) =>
                        w.op === "same" ? (
                          <span>{w.word} </span>
                        ) : w.op === "case" ? (
                          <span class="voice-diff-case" title="Heard in the wrong case">
                            ~{w.word}{" "}
                          </span>
                        ) : w.op === "missed" ? (
                          <del class="voice-diff-missed">−{w.word} </del>
                        ) : (
                          <ins class="voice-diff-extra">+{w.word} </ins>
                        )
                      }
                    </For>
                  </p>
                </li>
              )}
            </For>
          </ol>
        </Show>
      </div>
      <Show when={props.tunable && !r().applied}>
        <div class="voice-model-actions">
          <button type="button" class="button button-sm" aria-disabled={props.busy ? "true" : undefined} onClick={() => !props.busy && props.onUse()}>
            Use These Settings
          </button>
        </div>
      </Show>
    </li>
  );
}

/** Another model's best score on this device's clips: a row to compare, nothing to open or use. */
function ScoreRow(props: { score: VoiceModelScore; name: string }) {
  return (
    <li class="list-row voice-result">
      <div class="list-main">
        <p class="voice-model-name">{props.name}</p>
        <p class="voice-model-meta">
          {percentWer(props.score.wer)} word error · {props.score.jargonHits} of {props.score.jargonTotal} jargon · {perClip(props.score.medianMs)} per clip
        </p>
      </div>
    </li>
  );
}

/** A run's progress, polled like setup (§app.settings-dialog/voice-calibration). */
function Progress(props: { st: VoiceStatus; run: VoiceCalibrationRun; act: Act }) {
  const p = () => props.run.progress;
  const pct = () => Math.round((p().done / Math.max(1, p().total)) * 100);
  const best = () => props.run.rows[0];
  const score = () => props.run.grid === "score";
  return (
    <div class="voice-cal-flow">
      <Show when={score()}>
        <p class="settings-intro">Parakeet has no settings to try. Scoring it on your {p().clips} clips.</p>
      </Show>
      <div class="meter">
        <p class="meter-head">
          <span class="meter-label">{score() ? `Clip ${p().clip} of ${p().clips}` : `Trying setting ${p().setting} of ${p().settings} · clip ${p().clip} of ${p().clips}`}</span>
          <span class="meter-value">{pct()}%</span>
        </p>
        <div class="meter-track">
          <span class="meter-fill" style={{ "--meter-pct": `${pct()}%` }} />
        </div>
        <Show when={p().pausedForDictation || p().etaSec !== undefined}>
          <p class="meter-context">{p().pausedForDictation ? "Paused for dictation." : etaSentence(p().etaSec!)}</p>
        </Show>
      </div>
      <Show when={!score() && best()}>
        {(b) => (
          <p class="settings-intro">
            Best so far: {percentWer(b().wer)} word error · {perClip(b().medianMs)} per clip.
          </p>
        )}
      </Show>
      <p class="settings-intro">You can close Settings; the run keeps going on this host.</p>
      <div class="voice-actions">
        <button type="button" class="button button-ghost" onClick={() => void props.act(() => stopCalibration(voiceDeviceId()), "Calibration stopped.")}>
          Stop Calibration
        </button>
      </div>
    </div>
  );
}

/** The run's outcome: what happened to this device's settings, then the ranked rows. */
function Results(props: { st: VoiceStatus; run: VoiceCalibrationRun; busy: boolean; act: Act; onDone(): void }) {
  const run = () => props.run;
  const tunable = () => run().engine === "whisper" && run().grid !== "score";
  const [reverted, setReverted] = createSignal(false);
  /** The top 5, plus the current settings wherever they ranked. */
  const shown = createMemo(() => {
    const top = run().rows.slice(0, 5);
    const cur = run().rows.find((r) => r.current);
    return tunable() && cur && !top.includes(cur) ? [...top, cur] : top;
  });
  /** This device's best on every other model, Parakeet's among them: to compare. */
  const scores = () => (props.st.calibration?.scores ?? []).filter((s) => s.model !== run().model);
  const currentWon = () => !!run().rows.find((r) => r.key === run().best)?.current;
  const outcome = (): string | null => {
    const r = run();
    if (!tunable()) return "Parakeet has no settings, so nothing is saved.";
    if (r.phase === "stopped") return `Stopped after ${r.progress.setting} of ${r.progress.settings} settings. Nothing was saved; pick a row to use it.`;
    if (r.phase !== "done") return null;
    if (reverted()) return "Back to the previous settings.";
    if (currentWon()) return "Your current settings scored best. Nothing changed.";
    return r.applied === r.best ? `Saved the best settings for this device on ${nameOf(props.st, r.model)}.` : null;
  };
  const revert = () => void props.act(() => revertCalibration(voiceDeviceInfo()), "Back to the previous settings.").then(() => setReverted(true));
  return (
    <div class="voice-cal-flow">
      <Show when={run().phase === "failed"}>
        <Banner
          tone="error"
          title={`Calibration stopped at setting ${run().progress.setting} of ${run().progress.settings}.`}
          body={`${(run().error ?? "Unknown error").replace(/\.$/, "")}. Your clips are kept; Find Best Settings tries again.`}
        />
      </Show>
      <Show when={run().hostBusy}>
        <Banner
          tone="warn"
          title="The host was busy during calibration."
          body="Timings may be slower than usual; word error isn't affected. Run it again when the host is quiet for truer times."
        />
      </Show>
      <Show when={outcome()}>{(o) => <p class="voice-cal-outcome">{o()}</p>}</Show>
      <Show when={tunable() && run().phase === "done" && !currentWon() && !reverted() && props.st.device?.canRevert}>
        <div class="voice-actions">
          <button type="button" class="button" aria-disabled={props.busy ? "true" : undefined} onClick={() => !props.busy && revert()}>
            <Icon name="undo" small />
            Revert to Previous
          </button>
        </div>
      </Show>
      <Show when={tunable() && run().phase === "done" && currentWon()}>
        <div class="voice-actions">
          <button type="button" class="button" onClick={() => props.onDone()}>
            Done
          </button>
        </div>
      </Show>
      <Show when={shown().length > 0}>
        <p class="voice-caption">Sorted by word error, then jargon, then time.</p>
        <ul class="list voice-results" aria-label="Calibration results">
          {/* Keyed by the row's key: every poll brings new objects, and a rebuilt row would close and lose focus. */}
          <For each={shown().map((r) => r.key)}>
            {(key) => (
              <ResultRow
                row={shown().find((r) => r.key === key)!}
                best={key === run().best}
                name={tunable() ? settingsWords(shown().find((r) => r.key === key)!.settings) : nameOf(props.st, run().model)}
                st={props.st}
                tunable={tunable()}
                busy={props.busy}
                onUse={() => {
                  setReverted(false);
                  const row = shown().find((r) => r.key === key)!;
                  void props.act(() => applyCalibration(voiceDeviceInfo(), key), `Using ${settingsWords(row.settings)}.`);
                }}
              />
            )}
          </For>
          <For each={scores()}>{(s) => <ScoreRow score={s} name={nameOf(props.st, s.model)} />}</For>
        </ul>
      </Show>
    </div>
  );
}

/** The This Device section of the Ready view (§app.settings-dialog/voice-calibration). */
export function VoiceCalibration(props: { st: VoiceStatus; busy: boolean; act: Act }) {
  const [flow, setFlow] = createSignal<number | null>(null);
  const [hidden, setHidden] = createSignal<string | null>(null);
  const [confirm, setConfirm] = createSignal<{ kind: "clips" } | { kind: "forget"; id: string; label: string } | null>(null);
  const myId = () => props.st.device?.id ?? voiceDeviceId();
  const label = () => {
    const d = props.st.device ?? voiceDeviceInfo();
    return `${d.label}${d.app ? " (app)" : ""}`;
  };
  const cal = () => props.st.calibration;
  const run = () => cal()?.run;
  const active = () => props.st.models.find((m) => m.id === props.st.activeModel);
  const clips = () => cal()?.clips.length ?? 0;
  const others = () => props.st.devices.filter((d) => d.id !== myId() && d.calibrated.length > 0);
  const calibrated = () => (props.st.device?.source !== "default" ? props.st.device?.calibration : undefined);

  /** Why a run can't start now, or null. */
  const runBlocked = (): string | null => {
    if (props.st.sweep && props.st.sweep.device !== myId()) return `Calibration is running for ${props.st.sweep.deviceLabel}.`;
    if (props.st.modelJob && !props.st.modelJob.outcome) return "Another download is running.";
    return null;
  };
  const why = () => unsupportedReason(captureSupported());
  const startRun = () => {
    setFlow(null);
    setHidden(null);
    void props.act(() => runCalibration(voiceDeviceInfo()), "Finding the best settings.");
  };
  /** Open the sentences at the first one not yet recorded. */
  const openFlow = () => {
    const c = cal();
    if (!c) return;
    const first = c.sentences.findIndex((s) => !c.clips.some((x) => x.n === s.n));
    setFlow(first < 0 ? 0 : first);
  };

  const summary = (): string => {
    const c = calibrated();
    if (c) return `Calibrated ${shortDate(c.at)} on ${c.clips} clips · ${percentWer(c.wer)} word error · ${perClip(c.medianMs)} per clip.`;
    const name = active() ? modelName(active()!) : props.st.activeModel;
    return `${name} uses the defaults on this device. Calibrating takes a few minutes: you read 6 sentences, then we try ${estimate(props.st, 6).settings === 8 ? 8 : 24} settings on them.`;
  };

  return (
    <section class="voice-section" aria-labelledby="voice-device-title">
      <h4 class="voice-section-title" id="voice-device-title">
        This Device
      </h4>
      <p class="settings-intro">This device: {label()}</p>
      <Show when={cal()} fallback={<p class="settings-intro">{summary()}</p>}>
        {(c) => (
          <Show
            when={run()?.phase === "running" && run()}
            fallback={
              <Show
                when={flow() !== null}
                fallback={
                  <>
                    <p class="settings-intro">{summary()}</p>
                    <div class="voice-actions">
                      <Show when={clips() >= c().minClips}>
                        <button
                          type="button"
                          class="button button-primary"
                          aria-disabled={runBlocked() || props.busy ? "true" : undefined}
                          title={runBlocked() ?? undefined}
                          onClick={() => !runBlocked() && !props.busy && startRun()}
                        >
                          Find Best Settings
                        </button>
                      </Show>
                      <button
                        type="button"
                        class="button"
                        aria-disabled={why() ? "true" : undefined}
                        title={why() ?? undefined}
                        onClick={() => !why() && openFlow()}
                      >
                        <Icon name="mic" small />
                        {calibrated() || clips() > 0 ? "Calibrate Again" : "Calibrate This Device"}
                      </button>
                    </div>
                    <Show when={run() && run()!.id !== hidden() && run()}>
                      {(r) => <Results st={props.st} run={r()} busy={props.busy} act={props.act} onDone={() => setHidden(r().id)} />}
                    </Show>
                    <Show when={clips() > 0}>
                      <div class="voice-actions">
                        <button type="button" class="button button-destructive" onClick={() => setConfirm({ kind: "clips" })}>
                          Delete Clips
                        </button>
                      </div>
                    </Show>
                  </>
                }
              >
                <Sentences st={props.st} start={flow()!} busy={props.busy} runBlocked={runBlocked()} onClose={() => setFlow(null)} onRun={startRun} />
              </Show>
            }
          >
            {(r) => <Progress st={props.st} run={r()} act={props.act} />}
          </Show>
        )}
      </Show>

      <Show when={confirm()}>
        {(cf) => {
          const x = cf();
          return x.kind === "clips" ? (
            <Banner
              tone="warn"
              title="Delete this device's clips?"
              body={`Its ${clips()} recorded ${clips() === 1 ? "sentence" : "sentences"} and their results go. Its saved settings stay.`}
              action={
                <span class="cluster">
                  <button type="button" class="button button-sm button-ghost" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="button button-sm button-destructive"
                    onClick={() => void props.act(() => deleteCalibrationClips(voiceDeviceId()), "Clips deleted.").then(() => setConfirm(null))}
                  >
                    Delete Clips
                  </button>
                </span>
              }
            />
          ) : (
            <Banner
              tone="warn"
              title={`Forget ${x.label}?`}
              body="Its settings and calibration clips go. It dictates with the defaults until it's calibrated again."
              action={
                <span class="cluster">
                  <button type="button" class="button button-sm button-ghost" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    class="button button-sm button-destructive"
                    onClick={() => void props.act(() => forgetVoiceDevice(x.id), `Forgot ${x.label}.`).then(() => setConfirm(null))}
                  >
                    Forget
                  </button>
                </span>
              }
            />
          );
        }}
      </Show>

      <Show when={others().length > 0}>
        <h5 class="voice-subtitle">Other devices</h5>
        <ul class="list voice-devices" aria-label="Other devices">
          <For each={others()}>
            {(d) => (
              <li class="list-row">
                <div class="list-main">
                  <p class="voice-model-name">
                    {d.label}
                    {d.app ? " (app)" : ""}
                  </p>
                  <p class="voice-model-meta">
                    seen {relativeTime(d.lastSeenAt)} · calibrated for {d.calibrated.map((id) => nameOf(props.st, id)).join(", ")}
                  </p>
                </div>
                <div class="voice-model-actions">
                  <button
                    type="button"
                    class="button button-sm button-destructive"
                    onClick={() => setConfirm({ kind: "forget", id: d.id, label: d.label + (d.app ? " (app)" : "") })}
                  >
                    Forget
                  </button>
                </div>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}
