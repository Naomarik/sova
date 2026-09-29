// This device, as voice knows it (§chat.voice/decoding): a random id made once and kept in
// localStorage, so decoding settings and calibration belong to the browser or installed app the
// user speaks into. An iPhone's home-screen app and its Safari tab have separate storage, so they
// are two devices. The label and the installed flag are shown, never trusted.

import { deviceLabel, isInstalledApp } from "../push";
import { readKey, writeKey } from "../storage-keys";

export const VOICE_DEVICE_KEY = "sova:voice-device";

const ID = /^[0-9a-f-]{16,64}$/i;

let memo: string | null = null;

function fresh(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** This device's voice id: the stored one, else a new one written now. A blocked store keeps it for this page load. */
export function voiceDeviceId(): string {
  if (memo) return memo;
  const stored = readKey(localStorage, VOICE_DEVICE_KEY);
  memo = stored !== null && ID.test(stored) ? stored : fresh();
  if (stored !== memo) writeKey(localStorage, VOICE_DEVICE_KEY, memo);
  return memo;
}

/** What the server shows for this device: "iPhone · Safari", and whether it's the installed app. */
export function voiceDeviceInfo(): { id: string; label: string; app: boolean } {
  return { id: voiceDeviceId(), label: deviceLabel(navigator.userAgent, navigator.maxTouchPoints ?? 0), app: isInstalledApp() };
}
