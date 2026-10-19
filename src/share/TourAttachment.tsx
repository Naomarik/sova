import { normalizeTourPresentation } from "../../shared/tour";
import { TourReadCard } from "../components/TourReadCard";
import type { TourPosition } from "../lib/tour-state";

export interface TourHost {
  base(handle: string): string;
  onAsk?(question: string): void;
  onRequestCoverage?(question: string): void;
  progress?: boolean;
}
async function json(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  if (!response.ok) throw new Error("This tour isn't available through this conversation. Reload the conversation to try again.");
  return response.json();
}
/** No owner API import, inferred source address or fallback: the host grants one scoped path. */
export function TourAttachment(props: { handle: string; title: string; summary: string; steps: number; host: TourHost }) {
  const base = () => props.host.base(props.handle);
  return <TourReadCard title={props.title} summary={props.summary} steps={props.steps}
    loadManifest={async () => {
      const manifest = normalizeTourPresentation(await json(base()));
      if (!manifest) throw new Error("This tour couldn't be read. Reload the conversation to try again.");
      return manifest;
    }}
    assetUrl={file => `${base()}/assets/${encodeURIComponent(file)}`}
    loadProgress={props.host.progress ? async () => await json(`${base()}/progress`) as TourPosition | null : undefined}
    saveProgress={props.host.progress ? position => json(`${base()}/progress`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(position) }) : undefined}
    onAsk={props.host.onAsk}
    onRequestCoverage={props.host.onRequestCoverage}
  />;
}
