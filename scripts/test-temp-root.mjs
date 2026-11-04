// Where a test file's throwaway root goes. It is also the file's TMPDIR, and Chromium puts a named Unix
// socket below that (server/tours/browser.ts refuses a socket path over 100 bytes). A Mac's default
// /var/folders/…/T/ is too long once the root is added, so there the root goes under /tmp. Linux and a
// short TMPDIR keep theirs.
import fs from "node:fs";
import path from "node:path";

export const TEST_ROOT_PREFIX = "sova-test-home-";

/** The parent of a test file's root, given the runner's temp dir. */
export function testRootBase(tmp, platform = process.platform) {
  if (platform !== "darwin") return tmp;
  const socket = path.join(tmp, `${TEST_ROOT_PREFIX}XXXXXX`, ".org.chromium.Chromium.scoped_dir.XXXXXX", "SingletonSocket");
  return Buffer.byteLength(socket) > 100 ? "/tmp" : tmp;
}

/**
 * A test file's root in `base`. macOS: its group is set to this process's own, since a new directory
 * takes its parent's group there, /tmp's is wheel, and everything below takes the root's. A test (and
 * Sova's handoff socket check, server/mesh/lan-handoff.ts) expects a folder it made to be its own group.
 */
export function makeTestRoot(base, platform = process.platform) {
  const root = fs.mkdtempSync(path.join(base, TEST_ROOT_PREFIX));
  if (platform === "darwin") {
    try {
      fs.chownSync(root, process.getuid(), process.getgid());
    } catch (err) {
      console.error(`run-tests: could not set the group of ${root}: ${err.message}`);
    }
  }
  return root;
}
