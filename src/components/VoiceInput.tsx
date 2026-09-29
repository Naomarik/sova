import { createEffect, createSignal, onCleanup, Show, type Accessor } from "solid-js";
import { Portal } from "solid-js/web";
import { ApiError, transcribeVoice, warmVoice } from "../lib/api";
import { toast } from "../lib/ui-state";
import { captureSupported, startCapture, type Clip, type Recorder } from "../lib/voice/capture";
import {
  backgroundSentence,
  clock,
  insertedSentence,
  jobPercent,
  MAX_RECORD_SEC,
  micErrorSentence,
  recordingText,
  unsupportedReason,
} from "../lib/voice/format";
import { spacedInsert, targetRange, wordCount, type SavedCaret } from "../lib/voice/insert";
import { ensureVoiceStatus, refreshVoice, voiceStatus, watchVoice } from "../lib/voice/status";
import { SPEECH_RMS } from "../lib/voice/wav";
import { Icon } from "./ui";
import { VoiceSheet } from "./VoiceSetup";
import "../design/voice.css";

/** What a composer hands its mic: the box the text goes into, and how it speaks. */
export interface VoiceTarget {
  input(): HTMLTextAreaElement | undefined;
  /** The session folder's name, a prompt word for whisper. */
  hint?(): string | null;
  announce(text: string): void;
}

type Phase = "idle" | "starting" | "recording" | "transcribing" | "error";

export interface VoiceControl {
  phase: Accessor<Phase>;
  seconds: Accessor<number>;
  level: Accessor<number>;
  error: Accessor<{ text: string; retry: boolean } | null>;
  press(): void;
  cancel(): void;
  retry(): void;
  dismiss(): void;
  sheetOpen: Accessor<boolean>;
  closeSheet(): void;
}

/**
 * One composer's dictation (§chat/voice): tap to record, tap to stop, the text lands at the caret.
 * The clip is kept after a failed transcription so Try Again doesn't re-record.
 */
export function createVoiceInput(target: VoiceTarget): VoiceControl {
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [seconds, setSeconds] = createSignal(0);
  const [level, setLevel] = createSignal(0);
  const [error, setError] = createSignal<{ text: string; retry: boolean } | null>(null);
  const [sheetOpen, setSheetOpen] = createSignal(false);
  let recorder: Recorder | null = null;
  let startToken = 0;
  let saved: SavedCaret | null = null;
  let kept: Clip | null = null;
  let backgrounded = false;
  let clockTimer: ReturnType<typeof setInterval> | undefined;

  ensureVoiceStatus();

  const stopClock = () => {
    clearInterval(clockTimer);
    clockTimer = undefined;
  };

  /** Esc while recording cancels the recording and nothing else (never a turn). */
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || (phase() !== "recording" && phase() !== "starting")) return;
    e.preventDefault();
    e.stopPropagation();
    cancel();
  };
  const listenEsc = (on: boolean) => (on ? window.addEventListener("keydown", onKey, true) : window.removeEventListener("keydown", onKey, true));

  const insert = (text: string): number => {
    const el = target.input();
    if (!el) return 0;
    const focused = document.activeElement === el;
    const range = targetRange(el.value, { start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length, focused }, saved);
    const ins = spacedInsert(el.value, range, text);
    if (!ins) return 0;
    if (focused) {
      el.setSelectionRange(range.start, range.end);
      // Native undo, the input event and the IME state, as if typed. Deprecated, still universal.
      if (document.execCommand("insertText", false, ins)) return wordCount(text);
    }
    el.setRangeText(ins, range.start, range.end, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return wordCount(text);
  };

  const transcribe = async (clip: Clip) => {
    kept = clip;
    setPhase("transcribing");
    setSeconds(clip.sec);
    target.announce("Transcribing.");
    // Hidden (backgrounded): the request may not run; send it when the page is back.
    if (document.hidden) await new Promise<void>((r) => document.addEventListener("visibilitychange", function h() {
      if (!document.hidden) {
        document.removeEventListener("visibilitychange", h);
        r();
      }
    }));
    try {
      const out = await transcribeVoice(clip.wav, target.hint?.() ?? null);
      kept = null;
      const n = out.text ? insert(out.text) : 0;
      if (n === 0) {
        fail("Heard audio but no words. Nothing was inserted.", false);
        return;
      }
      setPhase("idle");
      setError(null);
      const said = insertedSentence(n);
      if (backgrounded) {
        toast(backgroundSentence(clip.sec));
        target.announce(`${backgroundSentence(clip.sec)} ${said}`);
      } else target.announce(said);
      backgrounded = false;
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        kept = null;
        void refreshVoice();
        fail("Voice isn't set up on this host anymore.", false);
        return;
      }
      fail(`Couldn't transcribe the clip. ${(err as Error).message.replace(/[.]+$/, "")}. Your recording is kept.`, true);
    }
  };

  const fail = (text: string, retry: boolean) => {
    backgrounded = false;
    setPhase("error");
    setError({ text, retry });
    target.announce(text);
  };

  const stop = async () => {
    const r = recorder;
    if (!r || phase() !== "recording") return;
    recorder = null;
    stopClock();
    listenEsc(false);
    setLevel(0);
    setPhase("transcribing");
    const clip = await r.stop();
    if (clip.peakRms < SPEECH_RMS || clip.sec < 0.3) {
      backgrounded = false;
      fail("Didn't catch any speech. Nothing was inserted.", false);
      return;
    }
    await transcribe(clip);
  };

  const begin = () => {
    const el = target.input();
    saved = el
      ? { start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length, focused: document.activeElement === el, value: el.value }
      : null;
    kept = null;
    backgrounded = false;
    setError(null);
    setSeconds(0);
    setLevel(0);
    setPhase("starting");
    listenEsc(true);
    const token = ++startToken;
    // Synchronously in the press: the AudioContext is created in here (lib/voice/capture).
    let pending: Promise<Recorder>;
    try {
      pending = startCapture({
        onLevel: setLevel,
        onInterrupt: () => {
          backgrounded = true;
          void stop();
        },
      });
    } catch (err) {
      listenEsc(false);
      fail(micErrorSentence(err), false);
      return;
    }
    void warmVoice();
    pending.then(
      (r) => {
        if (token !== startToken || phase() !== "starting") {
          r.cancel(); // cancelled while the mic was being asked for
          return;
        }
        recorder = r;
        setPhase("recording");
        target.announce("Recording.");
        clockTimer = setInterval(() => {
          const s = r.seconds();
          setSeconds(s);
          if (s >= MAX_RECORD_SEC) void stop();
          else if (Math.floor(s) === MAX_RECORD_SEC - 30) target.announce("30 seconds left.");
        }, 250);
      },
      (err) => {
        if (token !== startToken) return;
        listenEsc(false);
        fail(micErrorSentence(err), false);
      },
    );
  };

  const cancel = () => {
    const was = phase();
    if (was !== "recording" && was !== "starting") return;
    startToken++;
    stopClock();
    listenEsc(false);
    recorder?.cancel();
    recorder = null;
    setLevel(0);
    setPhase("idle");
    target.announce("Recording cancelled.");
  };

  const press = () => {
    const p = phase();
    if (p === "recording") return void stop();
    if (p === "starting" || p === "transcribing") return;
    const env = captureSupported();
    const why = unsupportedReason(env);
    if (why) {
      toast(why);
      target.announce(why);
      return;
    }
    if (voiceStatus()?.state !== "ready") {
      setSheetOpen(true);
      void refreshVoice();
      return;
    }
    begin();
  };

  onCleanup(() => {
    startToken++;
    stopClock();
    listenEsc(false);
    recorder?.cancel();
  });

  return {
    phase,
    seconds,
    level,
    error,
    press,
    cancel,
    retry: () => {
      if (kept) void transcribe(kept);
    },
    dismiss: () => {
      kept = null;
      setError(null);
      setPhase("idle");
      // The button that had focus is gone. Not on a touch-only device: focusing the textarea
      // there raises the keyboard, which the mic never does on its own.
      if (!matchMedia("(hover: none) and (pointer: coarse)").matches) target.input()?.focus({ preventScroll: true });
    },
    sheetOpen,
    closeSheet: () => setSheetOpen(false),
  };
}

const RING_R = 20;
const RING_C = 2 * Math.PI * RING_R;

/** The mic: first in `.composer-row` (§chat.voice/button). Never takes focus from the textarea. */
export function VoiceButton(props: { voice: VoiceControl }) {
  const v = props.voice;
  const env = captureSupported();
  const unsupported = unsupportedReason(env);
  const s = () => voiceStatus()?.state ?? null;
  const setup = () => s() !== null && s() !== "ready";
  const installing = () => s() === "installing";
  const percent = () => jobPercent(voiceStatus()?.install?.steps ?? []);
  // Only while a job runs does the mic need fresh figures (its ring).
  createEffect(() => {
    if (installing()) watchVoice();
  });
  const label = () => {
    const p = v.phase();
    if (p === "recording") return "Stop Recording";
    if (p === "transcribing") return "Transcribing";
    if (installing()) return `Dictate — setting up voice, ${percent()}%`;
    return "Dictate";
  };
  const title = () => {
    if (unsupported) return unsupported;
    if (setup() && !installing()) return "Dictate · Voice isn't set up on this host yet";
    return label();
  };
  let button!: HTMLButtonElement;
  return (
    <>
      <button
        ref={button}
        type="button"
        class="button button-icon button-ghost voice-button"
        data-voice={v.phase() === "idle" && installing() ? "installing" : v.phase()}
        aria-label={label()}
        title={title()}
        aria-disabled={unsupported || v.phase() === "transcribing" || v.phase() === "starting" ? "true" : undefined}
        aria-haspopup={setup() ? "dialog" : undefined}
        // Keep the textarea's focus and selection: an open phone keyboard stays open.
        onPointerDown={(e) => e.preventDefault()}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => v.press()}
      >
        <Icon name={v.phase() === "recording" ? "stop" : "mic"} />
        <Show when={installing() && v.phase() === "idle"}>
          <svg class="voice-ring" viewBox="0 0 44 44" aria-hidden="true">
            <circle class="voice-ring-track" cx="22" cy="22" r={RING_R} fill="none" />
            <circle
              class="voice-ring-fill"
              cx="22"
              cy="22"
              r={RING_R}
              fill="none"
              transform="rotate(-90 22 22)"
              style={{ "stroke-dasharray": `${RING_C}`, "stroke-dashoffset": `${RING_C * (1 - percent() / 100)}` }}
            />
          </svg>
        </Show>
      </button>
      <Show when={v.sheetOpen()}>
        <Portal>
          <VoiceSheet onClose={() => {
            v.closeSheet();
            button.focus();
          }} />
        </Portal>
      </Show>
    </>
  );
}

/** The one strip above `.composer-row` while dictating (§chat.voice/states). */
export function VoiceStrip(props: { voice: VoiceControl }) {
  const v = props.voice;
  return (
    <Show when={v.phase() !== "idle"}>
      <div class="voice-strip" role="group" aria-label="Dictation" data-voice={v.phase()}>
        <Show when={v.phase() === "starting"}>
          <span class="voice-strip-text">Starting the mic…</span>
          <button type="button" class="button button-icon button-ghost" aria-label="Cancel Recording" title="Cancel Recording" onPointerDown={(e) => e.preventDefault()} onClick={() => v.cancel()}>
            <Icon name="close" small />
          </button>
        </Show>
        <Show when={v.phase() === "recording"}>
          <span class="live-dot" aria-hidden="true" />
          <span class="voice-strip-text text-num">{recordingText(v.seconds(), MAX_RECORD_SEC)}</span>
          <span class="voice-level" aria-hidden="true">
            <span class="voice-level-num text-num">{v.level()}</span>
            <span class="voice-level-track">
              <span class="voice-level-fill" style={{ width: `${v.level()}%` }} />
            </span>
          </span>
          <button type="button" class="button button-icon button-ghost" aria-label="Cancel Recording" title="Cancel Recording" onPointerDown={(e) => e.preventDefault()} onClick={() => v.cancel()}>
            <Icon name="close" small />
          </button>
        </Show>
        <Show when={v.phase() === "transcribing"}>
          <span class="voice-strip-text">Transcribing <span class="text-num">{clock(v.seconds())}</span>…</span>
        </Show>
        <Show when={v.phase() === "error" && v.error()}>
          {(err) => (
            <>
              <Icon name="alert-circle" small />
              <span class="voice-strip-text voice-strip-error">{err().text}</span>
              <Show when={err().retry}>
                <button type="button" class="button button-sm" onPointerDown={(e) => e.preventDefault()} onClick={() => v.retry()}>
                  Try Again
                </button>
              </Show>
              <button type="button" class="button button-icon button-ghost" aria-label="Dismiss" title="Dismiss" onClick={() => v.dismiss()}>
                <Icon name="close" small />
              </button>
            </>
          )}
        </Show>
      </div>
    </Show>
  );
}
