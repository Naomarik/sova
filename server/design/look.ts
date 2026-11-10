// A look at a design's own finished page, for the coordinator's design_browse by label and for Refine's
// look-and-fix passes. The page is model-written, so it runs where a tour's browser runs: in the confined child,
// behind the attempt's proxy. It is served once, on a loopback port of its own, for this one look, under the same
// rules as its frame: its own scripts and styles, Google Fonts, nothing else.
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { TourSize, TourSource } from "../../shared/tour";
import { resolveTourContext, tourCallerBySession } from "../tours/context";
import { runTourAttempt } from "../tours/runner";
import type { TourRecordingContext } from "../tours/sandbox";
import { TourCaptureFailure } from "../tours/targets";
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

/** Pictures of a stored page at both widths (or those asked for) and its outline for a model that reads no images. */
export async function lookAtDesign(parent: BrowseParent, label: string, a: { version?: number; sizes?: TourSize[] } = {}, deps: DesignLookDeps = {}): Promise<{ shots: { size: TourSize; png: Uint8Array }[]; outline: string }> {
  const written = (deps.readPage ?? readPage)(parent.sessionId, label, a.version);
  if (!written) throw new Error(`Design ${label} has no finished page to look at.`);
  // The real pictures, carried inside the page: this browser refuses any answer from a Sova, so it can't fetch them.
  const html = (deps.showAssets ?? showAssets)(parent.sessionId, written, "full");
  const sizes: TourSize[] = a.sizes?.length ? [...new Set(a.sizes)] : ["desktop", "phone"];
  const context = await (deps.context ?? parentContext)(parent);
  return withServedPage(html, async (origin) => {
    // A project source, so the sandbox's proxy admits this one loopback address; its identity is this very server.
    const source: TourSource = { kind: "project", projectId: "design", instanceId: label, checkout: context.cwd, serviceId: "design", endpoint: "page" };
    try {
      const result = await (deps.run ?? runTourAttempt)({
        context,
        script: browseScript(source, "/", sizes, FONT_ORIGINS, undefined) as never,
        tourId: `design-look-${label}`,
        editionId: randomUUID(),
        dryRun: false,
        walk: Object.fromEntries(sizes.map((s) => [s, []])),
        limitMs: LOOK_MS,
        target: (async () => ({ origin, assertCurrent: async () => {} })) as never,
        beforeContact: async (o: string) => {
          if (o !== origin && !FONT_ORIGINS.includes(o)) throw new TourCaptureFailure({ message: `This page tried to reach ${o}, which designs may not do.`, guidance: "Remove that address from the page." });
        },
      });
      const view = result.steps[0]?.views[0];
      const shots = sizes.map((size) => {
        const image = view?.captures[size]?.image;
        const png = image ? result.assets.get(image) : undefined;
        if (!png) throw new Error(`This look took no picture at ${size} width.`);
        return { size, png };
      });
      return { shots, outline: result.look ? browseOutline(result.look, sizes) : "" };
    } catch (err) {
      if (err instanceof TourCaptureFailure) throw new Error(`${err.failure.message}${err.failure.guidance ? ` ${err.failure.guidance}` : ""}`);
      throw err;
    }
  });
}
