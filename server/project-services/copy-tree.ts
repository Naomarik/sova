/**
 * Copying a folder's contents the host's own `cp` way (imports nothing: `scripts/copy-tree.mjs` runs
 * it on plain node). GNU cp (Linux) takes `--reflink=auto`; macOS's BSD cp rejects it ("illegal
 * option") and clones with `-c` (APFS clonefile, a plain copy where the file system has none).
 */

/** The `cp` argv that copies the contents of folder `src` into the existing folder `dst`, keeping modes, times and symlinks (pure, for tests). */
export function copyContentsArgv(src: string, dst: string, platform: NodeJS.Platform = process.platform): string[] {
  return platform === "darwin" ? ["-a", "-c", `${src}/.`, dst] : ["-a", "--reflink=auto", `${src}/.`, dst];
}
