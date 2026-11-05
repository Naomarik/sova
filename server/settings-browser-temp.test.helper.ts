// Test-only: where Settings' browser test (settings-browser.integration.test.ts) puts Chrome's temp
// files. Chrome makes named Unix sockets under TMPDIR, and a socket path over 100 bytes kills it before
// a page exists (server/tours/browser.ts assertTourBrowserTempPath, reused here). A landing must never
// fail because its TMPDIR is long (operator decision), so the test picks its own short directory:
// the OS temp dir when a socket under it fits, else a fresh one under /tmp, else /dev/shm. Only when
// none is writable and short does it skip, saying why. Never imported by product code.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertTourBrowserTempPath } from "./tours/browser";

const PREFIX = "sova-sb-";

/** The directory chosen (made, empty, this process's), or why none could be. */
export type BrowserTemp = { dir: string; cleanup(): void } | { skip: string };

/** A socket under `dir` fits Chrome's limit. */
export function socketFits(dir: string): boolean {
  try {
    assertTourBrowserTempPath(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first candidate a socket fits under once the private directory is made in it, and that can be
 * written: `mkdtemp` is the writability test (a read-only /tmp throws). `make` is a seam for tests.
 */
export function chooseBrowserTemp(
  candidates: readonly string[] = [tmpdir(), "/tmp", "/dev/shm"],
  make: (prefix: string) => string = (p) => mkdtempSync(p),
): BrowserTemp {
  const why: string[] = [];
  for (const base of candidates) {
    // The directory made is PREFIX plus six characters; check the path it will have.
    if (!socketFits(join(base, `${PREFIX}XXXXXX`))) {
      why.push(`${base}: too long for Chrome's sockets`);
      continue;
    }
    let dir: string;
    try {
      dir = make(join(base, PREFIX));
    } catch (err) {
      why.push(`${base}: not writable (${(err as NodeJS.ErrnoException).code ?? String(err)})`);
      continue;
    }
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }
  return { skip: `No short writable temp directory for Chrome's sockets (${why.join("; ")}).` };
}
