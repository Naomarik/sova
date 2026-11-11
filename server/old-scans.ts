/**
 * When a session file counts as old for the incremental scans (the align read, the readiness read):
 * untouched this long, by its mtime. An old file's scans keep their answers but let go of the lines
 * they stored only to carry on when the file grows; such a file, once it grows, is scanned again
 * from its start, once, and is a recent file from then on.
 */
export const OLD_SCAN_MS = 30 * 24 * 60 * 60_000;

/** Whether a file last written at `mtimeMs` is old at `now`. */
export const isOldFile = (mtimeMs: number, now: number = Date.now()): boolean => now - mtimeMs >= OLD_SCAN_MS;
