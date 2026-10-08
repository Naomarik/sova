// The product screenshots and the session video, as site/scripts/screens/ last wrote them: real
// Sova on the demo data in site/scripts/screens/story.json (dark theme; the same images in both
// site themes). The pages ask by slot ("hero.desk"); the alt text, size and file come from the
// generated manifest, so a picture and its words can't drift apart. A slot with no image fails
// the build: run `pnpm run screens`.
import type { ImageMetadata } from "astro";
import manifest from "../assets/screens/manifest.json";

interface ShotEntry { file: string; width: number; height: number; viewport: string; alt: string }
interface VideoEntry { file: string; width: number; height: number; seconds: number; alt: string; poster: string }
interface Manifest { shots: Record<string, ShotEntry>; slots: Record<string, string>; video?: VideoEntry }

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

/** The recorded session, when there is one, with its poster shot. */
export const video: (VideoEntry & { posterShot: Screen }) | null = m.video ? { ...m.video, posterShot: byId(m.video.poster, "the video's poster") } : null;
