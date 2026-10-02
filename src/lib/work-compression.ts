// This browser's work rendering preference, shared by Settings and every transcript.
import { createSignal } from "solid-js";
import { readKey, writeKey } from "./storage-keys";

export const COMPRESS_WORK_KEY = "sova:compress-work";

/** Only an explicit off choice disables compression. Missing and corrupt values mean on. */
export const parseCompressWork = (stored: string | null): boolean => stored !== "false";

export function readCompressWork(store: Storage): boolean {
  return parseCompressWork(readKey(store, COMPRESS_WORK_KEY));
}

export function writeCompressWork(store: Storage, on: boolean): void {
  writeKey(store, COMPRESS_WORK_KEY, String(on));
}

export function readStoredCompressWork(): boolean {
  try {
    return readCompressWork(localStorage);
  } catch {
    // Missing or blocked storage never breaks boot.
    return true;
  }
}

const [compressWork, setCompress] = createSignal(readStoredCompressWork());
export { compressWork };

export function setCompressWork(on: boolean): void {
  setCompress(on);
  try {
    writeCompressWork(localStorage, on);
  } catch {
    // Persistence is a convenience; the choice still holds for this page.
  }
}
