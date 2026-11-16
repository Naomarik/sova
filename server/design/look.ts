// A look at a design's own finished page, for the coordinator's design_browse by label and for Refine's
// look-and-fix passes. The page is model-written, so it runs where a tour's browser runs: in the confined child,
// behind the attempt's proxy. It is served once, on a loopback port of its own, for this one look, under the same
// rules as its frame: its own scripts and styles, Google Fonts, nothing else.
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { TourScriptRequest, TourSize, TourSource } from "../../shared/tour";
import { resolveTourContext, tourCallerBySession } from "../tours/context";
import { runTourAttempt } from "../tours/runner";
import type { TourRecordingContext } from "../tours/sandbox";
import { TourCaptureFailure } from "../tours/targets";
import type { TourWalkAction } from "../tours/runner-protocol";
import { browseOutline, browseScript, type BrowseParent } from "./browse";
import { readPage } from "./store";
import { showAssets } from "./assets";

export const DESIGN_LOOK_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src data: blob:; media-src data: blob:; form-action 'none'; base-uri 'none'; frame-src 'none'";
const FONT_ORIGINS = ["https://fonts.googleapis.com", "https://fonts.gstatic.com"];
const LOOK_MS = 90_000;

export interface DesignLookDeps {
  run?: typeof runTourAttempt;
  context?: (parent: BrowseParent) => Promise<TourRecordingContext>;
  readPage?: typeof readPage;
  /** Tests: the pictures put into the page. */
  showAssets?: typeof showAssets;
  /** Tests: where the page is served (a unit test opens no port). */
  serve?: <T>(html: string, fn: (origin: string) => Promise<T>) => Promise<T>;
}

/** Serve one page on a fresh loopback port, for the length of `fn`. */
export async function withServedPage<T>(html: string, fn: (origin: string) => Promise<T>): Promise<T> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": DESIGN_LOOK_CSP, "cache-control": "no-store" });
    res.end(html);
  });
  await new Promise<void>((ok, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => ok());
  });
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
}

const parentContext = async (parent: BrowseParent): Promise<TourRecordingContext> => {
  const { acquireChatHandle } = await import("../chat-handle");
  await acquireChatHandle(parent.path).catch(() => null);
  return resolveTourContext(await tourCallerBySession(parent.sessionId));
};

/** One screen of a walk through a design's page: its id (lowercase letters, digits and dashes) and the clicks reaching it. */
export interface DesignWalkStep {
  id: string;
  actions: TourWalkAction[];
}

/** A walk through a design's page that couldn't reach one of its screens: which, and why. */
export class DesignWalkFailure extends Error {
  constructor(
    message: string,
    readonly stepId: string | undefined,
  ) {
    super(message);
  }
}

/** The script a walk through a design's page runs: one step per screen, each loading the page fresh. */
export function walkScript(source: TourSource, sizes: readonly TourSize[], steps: readonly DesignWalkStep[]): TourScriptRequest {
  const one = browseScript(source, "/", sizes, FONT_ORIGINS, undefined);
  const view = one.steps[0]!.views[0]!;
  return { ...one, steps: steps.map((s) => ({ id: s.id, chapter: "look", title: s.id, summary: "A screen of the page.", views: [view] })) };
}

/**
 * Walk through a design's page (already in the form it is served in: its pictures put in, any test ids added), one
 * fresh load per step, and picture each screen at each size. One browser for every step. A step whose clicks fail ends
 * the walk with a DesignWalkFailure naming it.
 */
export async function walkDesign(parent: BrowseParent, label: string, html: string, sizes: readonly TourSize[], steps: readonly DesignWalkStep[], deps: DesignLookDeps = {}, limitMs = LOOK_MS): Promise<Map<string, { shots: { size: TourSize; png: Uint8Array }[]; outline: string }>> {
  const context = await (deps.context ?? parentContext)(parent);
  return (deps.serve ?? withServedPage)(html, async (origin) => {
    // A project source, so the sandbox's proxy admits this one loopback address; its identity is this very server.
    const source: TourSource = { kind: "project", projectId: "design", instanceId: label, checkout: context.cwd, serviceId: "design", endpoint: "page" };
    try {
      const result = await (deps.run ?? runTourAttempt)({
        context,
        script: walkScript(source, sizes, steps) as never,
        tourId: `design-look-${label}`,
        editionId: randomUUID(),
        dryRun: false,
        walk: Object.fromEntries(sizes.map((s) => [s, []])),
        walkSteps: Object.fromEntries(steps.map((st) => [st.id, Object.fromEntries(sizes.map((s) => [s, st.actions]))])),
        limitMs,
        target: (async () => ({ origin, assertCurrent: async () => {} })) as never,
        beforeContact: async (o: string) => {
          if (o !== origin && !FONT_ORIGINS.includes(o)) throw new TourCaptureFailure({ message: `This page tried to reach ${o}, which designs may not do.`, guidance: "Remove that address from the page." });
        },
      });
      const out = new Map<string, { shots: { size: TourSize; png: Uint8Array }[]; outline: string }>();
      for (const [i, step] of steps.entries()) {
        const view = result.steps[i]?.views[0];
        const shots = sizes.map((size) => {
          const image = view?.captures[size]?.image;
          const png = image ? result.assets.get(image) : undefined;
          if (!png) throw new DesignWalkFailure(`This look took no picture at ${size} width.`, step.id);
          return { size, png };
        });
        const page = result.look?.pages[i];
        out.set(step.id, { shots, outline: page ? browseOutline({ pages: [page] }, sizes) : "" });
      }
      return out;
    } catch (err) {
      if (err instanceof TourCaptureFailure) throw new DesignWalkFailure(`${err.failure.message}${err.failure.guidance ? ` ${err.failure.guidance}` : ""}`, err.failure.stepId);
      throw err;
    }
  });
}

/** Pictures of a stored page at both widths (or those asked for) and its outline for a model that reads no images.
    actions walk to a screen first; prepare rewrites the page this browser is served (its views' test ids), never the stored one. */
export async function lookAtDesign(parent: BrowseParent, label: string, a: { version?: number; sizes?: TourSize[]; html?: string; actions?: TourWalkAction[]; prepare?: (html: string) => string } = {}, deps: DesignLookDeps = {}): Promise<{ shots: { size: TourSize; png: Uint8Array }[]; outline: string }> {
  const written = a.html ?? (deps.readPage ?? readPage)(parent.sessionId, label, a.version);
  if (!written) throw new Error(`Design ${label} has no finished page to look at.`);
  // The real pictures, carried inside the page: this browser refuses any answer from a Sova, so it can't fetch them.
  const html = (deps.showAssets ?? showAssets)(parent.sessionId, a.prepare ? a.prepare(written) : written, "full");
  const sizes: TourSize[] = a.sizes?.length ? [...new Set(a.sizes)] : ["desktop", "phone"];
  try {
    const out = await walkDesign(parent, label, html, sizes, [{ id: "page", actions: a.actions ?? [] }], deps);
    return out.get("page")!;
  } catch (err) {
    if (err instanceof DesignWalkFailure) throw new Error(err.message);
    throw err;
  }
}
