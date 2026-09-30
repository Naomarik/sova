# §chat/voice — Voice input
> Part of the Sova design spec · [overview](../design/overview.md)

Dictation into any prompt box. A mic button records in the browser, and the Sova host serving the
page turns the clip into text with a local speech model, installed on that host by an in-app
installer (§app.settings-dialog/voice). The model is the one chosen in Settings → Voice
(§app.settings-dialog/voice-models), one for the whole host: by default `ggml-large-v3-turbo-q5_0`
on a whisper.cpp server. How it decodes is this device's own (§chat.voice/decoding). The text lands
in the box at the caret and is never sent by itself: you read it, edit it, and send it like typed
text. Audio goes from the browser to this Sova host and nowhere else. Dictation stores nothing: a
clip is held only while it is transcribed. Calibration is the one exception: the sentences you read
for it are kept on this host, in the voice folder, until you delete them, forget the device, or
uninstall voice (§app.settings-dialog/voice-calibration). A remote-target session is unaffected:
the text goes to the far host like typed text. v1 records, then transcribes after Stop; there are
no live partials.

## §chat.voice/button — The mic button

The session composer and the group composer (§workspace.groups/the-group-composer) each carry one
mic button, the first child of `.composer-row`: in the session composer it sits immediately left
of the `plus` trigger. It is a ghost `.button-icon`, 44×44 at every width, with `mic.svg`.

```html
<button class="button button-icon button-ghost voice-button" type="button"
        aria-label="Dictate" title="Dictate" data-voice="idle">
  <span class="icon" style="--icon: url(/icons/mic.svg)" aria-hidden="true"></span>
</button>
```

- **Tap to start, tap to stop**, everywhere. There is no press-and-hold and no keyboard shortcut.
- **It keeps the keyboard and the caret.** Its `pointerdown` and `mousedown` call
  `preventDefault()`, so a focused textarea stays focused: an open on-screen keyboard stays open
  and the selection stays put. It never focuses the textarea itself, so on a phone it never raises
  the keyboard on its own.
- **Hidden** when the composer is read only (a session live in a TUI). While the composer is
  merely blocked (connecting, reconnecting, a pending model switch, busy) it works: dictating is
  typing.
- **Unsupported browser context** — no `isSecureContext`, or no `navigator.mediaDevices.getUserMedia`,
  or no `AudioContext`: the button stays visible, `aria-disabled="true"`, and its `title` and a
  press say why (§design.copy-deck/composer).
- **Not set up** (the host has no working install: not installed, needs packages, failed, or
  unsupported host): the same icon; a press opens the voice setup sheet (§app.settings-dialog/voice)
  instead of recording, and it carries `aria-haspopup="dialog"`.
- **Setting up**: the icon with a small progress ring under it; a press reopens the sheet.

## §chat.voice/states — Recording states

The button and one strip, `.voice-strip`, directly above `.composer-row` (where `.align-picks`
sits), carry every state. The strip adds no control to the row, so a 320px screen keeps its
textarea. The textarea stays visible and editable throughout.

```html
<div class="voice-strip" role="group" aria-label="Dictation" data-voice="recording">
  <span class="live-dot" aria-hidden="true"></span>
  <span class="voice-strip-text">Recording <span class="text-num">0:07</span></span>
  <span class="voice-level" aria-hidden="true"><span class="voice-level-num text-num">42</span>
    <span class="voice-level-track"><span class="voice-level-fill" style="width: 42%"></span></span></span>
  <button class="button button-icon button-ghost" type="button" aria-label="Cancel Recording" title="Cancel Recording">…close…</button>
</div>
```

| State | Button | Strip |
|---|---|---|
| Idle | mic, "Dictate" | none |
| Starting (asking for the mic) | mic, `aria-disabled` | "Starting the mic…", Cancel |
| Recording | accent fill, `stop.svg`, "Stop Recording" | live dot, "Recording {m:ss}", the level (number first, then the bar), Cancel |
| Last 30 s of the 5-minute cap | as Recording | "Recording {m:ss} · {s} s left" |
| Transcribing | `aria-disabled`, "Transcribing" | "Transcribing {m:ss}…" |
| Error | mic, "Dictate" | the reason, `Try Again` when the clip is kept, Dismiss |

- **The recording state reads from its end state**: an accent-filled button with the stop glyph
  and the word "Recording". The live dot is the one thing that moves, and under
  `prefers-reduced-motion` it stands still.
- **Cancel** (the strip's close button, or `Esc` anywhere while recording) throws the clip away and
  inserts nothing. `Esc` never aborts a turn.
- **Cap.** A recording stops itself at 5:00 and is transcribed.
- **Nothing heard.** A clip whose level never rose above the speech threshold is not sent: the
  strip says so, and nothing is inserted.
- **Errors keep the clip.** A failed transcription (server unreachable, whisper not ready, busy)
  keeps the recorded audio in page memory, so `Try Again` sends it again without re-recording.
  Dismiss, a new recording, or leaving the page drops it.
- **Announcements** go through the polite region: "Recording.", "Transcribing.", "Inserted {n}
  words." and every error sentence.

## §chat.voice/capture — Capture

- **One gesture.** The `AudioContext` is created synchronously in the press handler (iOS leaves a
  context created after an `await` suspended), then `getUserMedia({audio: {channelCount: 1,
  echoCancellation: false, noiseSuppression: false, autoGainControl: false}})` and `ctx.resume()`:
  the browser's own noise suppression and gain control smear consonants and, stacked on a system
  noise gate, cut words, so the speech models get the mic's raw signal.
- **PCM, not MediaRecorder.** An AudioWorklet (`/voice-capture-worklet.js`) posts mono Float32
  batches and their RMS; where AudioWorklet is missing a ScriptProcessorNode does the same.
- **Stop** keeps recording for 350 ms more (post-roll, so a stop tapped on the last syllable
  doesn't cut it), then flushes the worklet, stops every mic track (which releases the OS mic indicator), closes
  the context, resamples to 16 kHz through an `OfflineAudioContext`, and encodes a 16-bit mono WAV
  (32 KB per second).
- **Warm-up.** Starting a recording sends `POST /api/voice/warm`, so the model loads while you
  speak.

## §chat.voice/insertion — Where the text goes

- **At the caret.** The selection is saved when recording starts. When the text arrives: if the
  textarea is focused, it replaces the current selection; otherwise, if the textarea was focused
  when recording started and its text hasn't changed since, it replaces the saved selection;
  otherwise it is appended at the end.
- **Spacing.** A space is added before the text when the character before it isn't whitespace,
  and after it when the character after it isn't whitespace. Whisper's own leading and trailing
  whitespace is trimmed.
- **Focused**, the text goes in through `document.execCommand("insertText")`, so native undo, the
  input event and the IME state all behave as if typed. **Not focused**, it goes in with
  `setRangeText` and an input event, without focusing, so no keyboard opens.
- **Drafts.** The inserted text is part of the draft like typed text (§chat.composer/behavior
  "Drafts"); it is never sent by itself.

## §chat.voice/mobile-lifecycle — Backgrounding mid-recording

When the page goes to the background while recording — `visibilitychange` to hidden, `pagehide`,
the mic track ending or muting, or the context turning `interrupted` or `suspended` (a lock screen,
an app switch, a call, Siri) — the recording stops itself and what was captured is transcribed:
immediately if the page is visible, otherwise as soon as it is visible again. When the text is in,
a toast (and the same announcement) says "Recording stopped when the app went to the background.
Transcribed {m:ss}." A page the OS discards loses the clip. iOS may ask for the mic again at each
launch of the installed app; the permission prompt's reason is the browser's own.

## §chat.voice/transcribe — The transcribe endpoint

`POST /api/voice/transcribe[?device=<id>][&hint=<word>]`, body the raw WAV (`Content-Type: audio/wav`, no
multipart), at most 12 MB (about 6 minutes).

- **200** `{text, ms, audioSec}` — `text` is the transcript with whisper's non-speech markers
  (`[BLANK_AUDIO]`, `(music)` and the like) removed, whitespace collapsed and Sova's jargon
  corrected (§chat.voice/jargon-fixes); it may be empty.
- **400** the body isn't a 16 kHz, 16-bit PCM, mono RIFF/WAVE file. **409** voice isn't installed.
  **413** the body is over the limit. **503** whisper is starting and failed, has crashed too often,
  or two requests are already waiting.
- **This device's settings.** `device` is the browser's voice device id (§chat.voice/decoding).
  The clip is decoded with that device's saved settings for the active model; a missing or unknown
  id gets the defaults, which decode exactly as before calibration existed.
- **Biasing.** whisper gets temperature 0 and, unless the device's settings turn the prompt off, a
  prompt of fixed hotwords (Sova, pi, SolidJS, worktree, Vite, TypeScript, subagent, Hono, pnpm,
  Claude, Codex, Overseer, statechart) — as a comma list by default, or as one short sentence using
  the same words — plus `hint`, the session folder's name, when it is a short plain word that
  doesn't repeat a hotword of 3 or more letters (a lowercase "sova-voice-input" turned "Sova" into
  "sova"). Parakeet takes no prompt, so on it the hotwords and `hint` are not sent.

## §chat.voice/jargon-fixes — Jargon post-correction

Every transcript (dictation, calibration and the self-test) goes through one small fixed table of
whole-word corrections for Sova's jargon, after the non-speech markers are removed: "work tree" and
"worktreet" become "worktree", "sub agent", "sub-agent" and "subagen" become "subagent", "state
chart" and "state-chart" become "statechart" (each with its plural), "Claud" becomes "Claude", and
"sova" or "SOVA" becomes "Sova" and "overseer" becomes "Overseer". Only misspellings with no
everyday meaning are in the table, so ordinary speech is never rewritten; a lowercase correction
keeps a sentence-initial capital ("Work tree" becomes "Worktree").

## §chat.voice/runtime — The engine supervisor

- **Two engines, one model at a time.** The active model (§app.settings-dialog/voice-models)
  decides the engine: whisper.cpp's `whisper-server` for the whisper models, and for Parakeet
  transcribe.cpp `v0.2.4` (its prebuilt Linux x86_64 Vulkan release) inside a small host,
  `sova-transcribe-host`, compiled against it when Parakeet is downloaded, that answers the same
  `/health` and `/inference` as whisper-server. Both sit behind one supervisor with the same rules
  below, and only the active model's engine ever runs; everything below said of `whisper-server`
  holds for the host too, except that it takes no prompt and no voice detection.
- **On demand.** Nothing starts at Sova boot. `POST /api/voice/warm` (204) or the first transcribe
  spawns the active engine's server on `127.0.0.1` at a free port — `whisper-server`, or the host
  for Parakeet — with the active model, `min(8, cores)`
  threads, `--no-gpu` for a CPU install and, when the Silero voice-detection model is on disk,
  `-vm` with its path, and waits up to 60 s for its `/health`. `-vm` is launch-only, so when the
  Silero file first arrives (fetched before a sweep that tries voice detection) a running engine is
  restarted with it before that sweep's first inference; without it, a request with voice
  detection would fail. Every decoding setting a device can
  save is a field of each request, never a launch flag, so one running server serves every device
  its own settings.
- **One at a time, dictation first.** Requests are serialized; at most 2 dictation clips wait, and
  a third gets 503. A calibration sweep's inferences go through the same engine one at a time, at
  low priority, each with a 15 s limit, and don't count toward that limit: a waiting dictation clip
  always runs before the sweep's next inference, so it waits at most one inference.
- **Switching models.** A switch stops the engine and starts the new model's, then runs the
  self-test on it; if that fails, the old model is started again and stays active. A clip in flight
  when the engine stops fails with 503 and is kept for `Try Again`, as after a crash.
- **Idle unload.** After 15 minutes with no request (sweep inferences count) the process is
  stopped, freeing its GPU memory; the next recording's warm-up starts it again.
- **Crashes.** An unexpected exit fails the request in flight (503). The next start waits 1, 2, then
  4 s; a third crash inside 60 s stops restarting, and the status says so until a repair or a
  reinstall.
- **Cleanup.** The child's pid and binary are recorded in `runtime.json`; when the voice service
  first starts (the first voice request after a boot) a leftover process is killed only when its
  command line is that binary. Sova's shutdown kills the child.

## §chat.voice/decoding — Per-device decoding settings

How a clip is decoded belongs to the device you speak into, not to the host: a laptop and a phone
have different mics and rooms, so each gets its own settings, per model. The model itself stays one
per host (§app.settings-dialog/voice-models).

- **The device.** A browser, or an installed home-screen app (on iOS the two have separate storage,
  so they are two devices). On first use of voice it makes a random id (`crypto.randomUUID()`) and
  keeps it in its own storage; nothing else identifies it. It sends the id as `device` on every
  transcribe, status read and calibration request, with its label — the platform and browser, as in
  "iPhone · Safari", plus "(app)" for the installed app. The server keeps the label and when the
  device was last seen. Clearing the browser's storage makes a new device.
- **Where it lives.** `<state root>/voice/settings.json`, written atomically:
  `{version, activeModel, devices: {<id>: {label, lastSeenAt, perModel: {<model id>: settings}}}}`,
  each model's entry holding the decoding settings, where they came from (defaults, calibration or a
  chosen results row), the previous settings (for Revert) and the last calibration's summary. A
  missing file means the default model and no device settings, so an install from before this
  change keeps working unchanged.
- **The settings.** For a whisper model: beam size (1, greedy, or 5), the prompt (none, the
  hotword list, or the hotword sentence; §chat.voice/transcribe), voice detection (off, or Silero at
  threshold 0.5 with 150 ms of padding) and the temperature fallback (temperature 0 with fallback
  steps of 0.2, or none). Anything else keeps whisper-server's own default. Parakeet has no settings.
- **Defaults.** A device with no saved settings for the active model — an unknown id, no id, or a
  model it never calibrated — gets greedy decoding, the hotword list, no voice detection and the
  0.2 fallback: exactly how dictation decoded before calibration existed. Nothing is ever copied
  from another device.
- **Voice detection needs its model.** Silero (`ggml-silero-v6.2.0.bin`, 885,098 bytes, pinned
  sha256) is fetched, import first and verified like any model, before the first sweep that tries
  it. `-vm` is a launch flag, so once it is fetched the engine restarts with it before the sweep's
  first inference, at an idle moment (dictation still goes first). A saved setting with voice
  detection on is sent without it while that file is missing.
- **Routes.** `GET /api/voice?device=<id>` adds that device's settings for the active model and the
  list of known devices; `DELETE /api/voice/devices/<id>` forgets one: its settings and its kept
  calibration clips go.
