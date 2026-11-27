// The Transport dialog's error banner (§app.transport/dialog, words in §design.copy-deck/transport): what failed
// decides its title. A start that failed sent nothing, so it says so above the reason. A refused Retry, Cancel or
// Interrupt sends nothing new either, but the transport may still be going in ("It is opening on Laptop right
// now…"), so "Nothing was sent." would contradict it: the reason the server gave is the banner's one line.
// DOM- and Solid-free.

export type TransportErrorFrom = "start" | "retry" | "cancel" | "interrupt";

export function transportErrorBanner(from: TransportErrorFrom, text: string): { title: string; body?: string } {
  return from === "start" ? { title: "Nothing was sent.", body: text } : { title: text };
}
