// The product screenshots and the session videos, as site/scripts/screens/ last wrote them: real
// Sova on the demo data in site/scripts/screens/story.json (dark theme; the same images in both
// site themes). The pages ask by slot ("hero.desk"); the alt text, size and file come from the
// generated manifest, so a picture and its words can't drift apart. A slot with no image fails
// the build: run `pnpm run screens`.
import type { ImageMetadata } from "astro";
import manifest from "../assets/screens/manifest.json";

interface ShotEntry { file: string; width: number; height: number; viewport: string; alt: string }
interface VideoSource { file: string; type: string; bytes: number }
/** A caption's or a sped-up stretch's place in the video, in its own seconds (record.mjs writes them).
    A caption's `chapter` names the bar segment it belongs to (story.json). */
export interface Cue { a: number; b: number; text: string; chapter?: string }
interface VideoEntry { sources: VideoSource[]; width: number; height: number; seconds: number; alt: string; slot: string; poster: { file: string }; line: string; cues: Cue[]; tags: Cue[] }
interface Manifest { shots: Record<string, ShotEntry>; slots: Record<string, string>; videos?: Record<string, VideoEntry> }

const m = manifest as unknown as Manifest;
const files = import.meta.glob<{ default: ImageMetadata }>("../assets/screens/*.webp", { eager: true });

export interface Screen { id: string; image: ImageMetadata; alt: string; viewport: string }

function byId(id: string, what: string): Screen {
  const entry = m.shots[id];
  const image = entry && files[`../assets/screens/${entry.file}`]?.default;
  if (!entry || !image) throw new Error(`${what}: no image for shot "${id}" in site/src/assets/screens/; run pnpm run screens`);
  return { id, image, alt: entry.alt, viewport: entry.viewport };
}

/** The shot that fills a page slot (story.json `pageShots`). */
export function screen(slot: string): Screen {
  const id = m.slots[slot];
  if (!id) throw new Error(`no slot "${slot}" in site/src/assets/screens/manifest.json (story.json pageShots)`);
  return byId(id, `slot ${slot}`);
}

// Shots captured from a running Sova rather than the demo story (site/scripts/screens/capture-live.mjs)
// sit in live/ with their own manifest; either may be missing.
const later = import.meta.glob<{ default: ImageMetadata }>(["../assets/screens/*.webp", "../assets/screens/live/*.webp"], { eager: true });
const liveManifest = Object.values(import.meta.glob<{ shots?: Record<string, ShotEntry> }>("../assets/screens/live/manifest.json", { eager: true, import: "default" }))[0];
const liveShots: Record<string, ShotEntry> = liveManifest?.shots ?? {};

/** A shot that may not be captured yet (the merge queue and release screens), by its shot id in the screens manifest or the
    live/ one, else by a master named `<id>.webp` in either folder with `alt` as its words. Null when neither is there: the landing shows a
    marked placeholder in its place, and a docs page leaves its figure out. */
export function optionalShot(id: string, alt: string): Screen | null {
  for (const [dir, shots] of [["", m.shots], ["live/", liveShots]] as const) {
    const entry = shots[id];
    const image = later[`../assets/screens/${dir}${entry?.file ?? `${id}.webp`}`]?.default;
    if (image) return { id, image, alt: entry?.alt ?? alt, viewport: entry?.viewport ?? "desktop" };
  }
  return null;
}

export interface Video {
  /** AV1 first, H.264 as the fallback: the browser plays the first whose type it can. */
  sources: VideoSource[];
  width: number;
  height: number;
  seconds: number;
  alt: string;
  /** The video's first frame, which its loop also fades back into. */
  poster: ImageMetadata;
  /** The slot's still, shown with reduced motion (and under the video). */
  still: Screen;
  /** The fixed line under it where the video doesn't play: what the still shows. */
  line: string;
  /** The page's captions, in order, from 0 to the video's end, each with its chapter. */
  cues: Cue[];
  /** The sped-up stretches ("Sped up 3×"), shown beside the caption. */
  tags: Cue[];
}

/** A recorded video (the hero's "desk") with its poster and the still it plays over, when there is
    one and it has the still's shape: it must fill the same screen area exactly (never cropped,
    never letterboxed). A video of another shape is left off the page; re-record it. */
export function video(name: string): Video | null {
  const v = m.videos?.[name];
  if (!v) return null;
  const poster = files[`../assets/screens/${v.poster.file}`]?.default;
  if (!poster) throw new Error(`video ${name}: no poster ${v.poster.file} in site/src/assets/screens/; run pnpm run screens:video`);
  const still = screen(v.slot);
  const same = Math.abs(v.width / v.height - still.image.width / still.image.height) < 0.005;
  if (!v.line || !Array.isArray(v.cues)) throw new Error(`video ${name}: no caption cues in the screens manifest; run pnpm run screens:video -- --cues`);
  return same ? { sources: v.sources, width: v.width, height: v.height, seconds: v.seconds, alt: v.alt, poster, still, line: v.line, cues: v.cues, tags: v.tags ?? [] } : null;
}

/** Whether the page shows any video (the footer says so). */
export const hasVideo = Object.keys(m.videos ?? {}).some((name) => video(name) !== null);
