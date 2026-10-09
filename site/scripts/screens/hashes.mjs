// Input hashes: a shot or the video is retaken only when something it shows could have changed:
// its part of the story (notes left out), every session's sidebar row, the project, the models, the
// app's last commit and the capture scripts themselves. capture.mjs, record.mjs and verify.mjs
// all compute them here, so they agree.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HERE, REPO } from "./load-story.mjs";

const stripNotes = (v) =>
  Array.isArray(v) ? v.map(stripNotes) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "note").map(([k, x]) => [k, stripNotes(x)])) : v;

const h = (v) => createHash("sha256").update(JSON.stringify(stripNotes(v))).digest("hex").slice(0, 16);

/** The last commit that touched the app the screens show. */
export function appRev() {
  try {
    return execFileSync("git", ["log", "-1", "--format=%H", "--", "src", "shared", "server", "pi-config", "public", "index.html"], { cwd: REPO, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

/** The capture scripts, tests and the story left out. */
function scriptsHash() {
  return createHash("sha256")
    .update(readdirSync(HERE).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs")).sort().map((f) => readFileSync(join(HERE, f), "utf8")).join("\0"))
    .digest("hex");
}

/** shot id -> input hash. */
export function inputHashes(story, plan) {
  const rev = appRev();
  const scripts = scriptsHash();
  const sidebar = story.sessions.map((s) => [s.id, s.title, s.at]);
  return Object.fromEntries(
    story.shots.map((shot) => {
      const sess = story.sessions.find((s) => s.id === shot.session) ?? null;
      const workers = Object.entries(story.workers ?? {}).filter(([id]) => plan.workers[id]?.owner === shot.session);
      return [shot.id, h({ shot, sess, workers, overseer: shot.session === "overseer" ? story.overseer : null, project: story.project, models: story.models, provider: story.provider, sidebar, rev, scripts })];
    }),
  );
}

export function videoHash(story, plan) {
  const workers = Object.entries(story.workers ?? {}).filter(([id]) => plan.workers[id]?.owner === story.video.session);
  return h({ video: story.video, sess: story.sessions.find((s) => s.id === story.video.session), workers, project: story.project, models: story.models, provider: story.provider, sidebar: story.sessions.map((s) => [s.id, s.title, s.at]), rev: appRev(), scripts: scriptsHash() });
}

/** A file's content hash, as manifest.json records it. */
export const fileSha = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 16);
