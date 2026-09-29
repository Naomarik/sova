// This host's voice status, shared by every mic, the setup sheet and Settings → Voice: one read
// of GET /api/voice, polled while anything that shows setup is mounted — every second while a job
// runs, every 10 seconds otherwise (§app.settings-dialog/voice). The setup log accumulates here.

import { createSignal, onCleanup } from "solid-js";
import type { VoiceLogLine, VoiceStatus } from "../../../shared/protocol";
import { getVoiceStatus } from "../api";

const [status, setStatus] = createSignal<VoiceStatus | null>(null);
const [error, setError] = createSignal<string | null>(null);
const [log, setLog] = createSignal<VoiceLogLine[]>([]);
export { status as voiceStatus, error as voiceStatusError, log as voiceLog };

let since = 0;
let inflight: Promise<VoiceStatus | null> | null = null;
let withSize = 0;

/** Read the status now (one request at a time); appends the new log lines. */
export function refreshVoice(): Promise<VoiceStatus | null> {
  if (inflight) return inflight;
  inflight = getVoiceStatus(since, withSize > 0)
    .then((s) => {
      if (s.log.seq < since) {
        // The server restarted: its log starts over.
        since = 0;
        setLog([]);
      }
      if (s.log.lines.length) setLog((l) => [...l, ...s.log.lines].slice(-500));
      since = s.log.seq;
      // A read without the size keeps the last measured one.
      const prev = status();
      if (s.diskBytes === undefined && prev?.diskBytes !== undefined && s.state === prev.state) s.diskBytes = prev.diskBytes;
      setStatus(s);
      setError(null);
      return s;
    })
    .catch((err: Error) => {
      setError(err.message);
      return status();
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** Adopt a status a POST returned. */
export function adoptVoice(s: VoiceStatus): void {
  if (s.log.lines.length && s.log.seq > since) {
    setLog((l) => [...l, ...s.log.lines.filter((x) => x.seq > since)].slice(-500));
    since = s.log.seq;
  }
  setStatus(s);
}

let watchers = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const tick = () => {
  clearTimeout(timer);
  if (watchers === 0) return;
  void refreshVoice().finally(() => {
    if (watchers === 0 || document.hidden) return;
    timer = setTimeout(tick, status()?.state === "installing" ? 1000 : 10_000);
  });
};
const onVisible = () => {
  if (!document.hidden && watchers > 0) tick();
};

/** Poll while the calling component is mounted; `size` also measures the voice folder (Settings). */
export function watchVoice(o: { size?: boolean } = {}): void {
  watchers++;
  if (o.size) withSize++;
  if (watchers === 1) document.addEventListener("visibilitychange", onVisible);
  tick();
  onCleanup(() => {
    watchers--;
    if (o.size) withSize--;
    if (watchers === 0) {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    }
  });
}

/** Read once if nothing has yet (a mic mounting). */
export function ensureVoiceStatus(): void {
  if (!status() && !inflight) void refreshVoice();
}
