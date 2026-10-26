#!/usr/bin/env node
// node site/scripts/screens/add-video.mjs <exported tree> — copy the hero videos into an exported tree before
// its site build, and refuse (exit 1) when any video the site references is missing. The videos are
// gitignored and live on disk only, so a `git archive` export has none.
// Source: $SOVA_SITE_VIDEO_DIR, else the main checkout's site/public/video (found with git from the
// current directory).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The video files the site references: every source of every video in the screens manifest. */
export function referencedVideos(manifest) {
  const out = [];
  for (const video of Object.values(manifest.videos ?? {})) {
    for (const source of video.sources ?? []) out.push(basename(source.file));
  }
  return out;
}

/** Names of the referenced videos missing from `dir`. */
export function missingVideos(names, dir) {
  return names.filter((name) => !existsSync(join(dir, name)));
}

export function defaultVideoDir(cwd = process.cwd()) {
  if (process.env.SOVA_SITE_VIDEO_DIR) return resolve(process.env.SOVA_SITE_VIDEO_DIR);
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8",
  }).trim();
  return join(dirname(common), "site", "public", "video");
}

/** Copy the referenced videos from `source` into `<tree>/site/public/video`; throws when any is missing. */
export function addVideo(tree, source) {
  const manifest = JSON.parse(readFileSync(join(tree, "site/src/assets/screens/manifest.json"), "utf8"));
  const names = referencedVideos(manifest);
  const missing = missingVideos(names, source);
  if (missing.length) {
    throw new Error(
      `refusing to publish: missing hero video(s) in ${source}: ${missing.join(", ")}. ` +
        "Run `pnpm run screens:video` in the main checkout, or set SOVA_SITE_VIDEO_DIR.",
    );
  }
  const target = join(tree, "site", "public", "video");
  mkdirSync(target, { recursive: true });
  for (const name of names) copyFileSync(join(source, name), join(target, name));
  const stillMissing = missingVideos(names, target);
  if (stillMissing.length) throw new Error(`refusing to publish: copy failed for ${stillMissing.join(", ")}`);
  return names;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const tree = process.argv[2];
  if (!tree) {
    console.error("usage: node site/scripts/screens/add-video.mjs <exported tree>");
    process.exit(2);
  }
  try {
    const source = defaultVideoDir();
    const names = addVideo(resolve(tree), source);
    console.log(`added ${names.join(", ")} from ${source}`);
  } catch (err) {
    console.error(String(err.message ?? err));
    process.exit(1);
  }
}
