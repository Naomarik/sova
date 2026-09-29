// Pure, so the share build can use it without the operator app's renderer.

/** Opening fence lines (``` or ~~~, up to 3 spaces indent) that never got closed. */
export function unclosedFence(text: string): { index: number; marker: string } | null {
  let open: { marker: string; index: number } | null = null;
  let count = 0;
  for (const line of text.split("\n")) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (!m) continue;
    if (!open) {
      open = { marker: m[1]!, index: count++ };
    } else if (m[1]![0] === open.marker[0] && m[1]!.length >= open.marker.length && line.trim() === m[1]) {
      open = null;
    }
  }
  return open;
}
