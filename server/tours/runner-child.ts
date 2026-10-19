import { createInterface } from "node:readline";
import { launchTourBrowser, TourBrowserSetupError } from "./browser";
import { TourBrowserAddresses } from "./browser-addresses";
import { createTourContactSheets } from "./contact-sheet";
import { TourCaptureFailure, TOUR_TARGET_OUTSIDE, revealTourTarget, settledBox, stableTourBox, tourLocator, tourMark, tourNearby, uniqueTourTarget } from "./targets";
import { TOUR_LIMITS, TOUR_PROBLEM_LIMITS, TOUR_VIEWPORTS, normalizeTourScript, tourOnSignInRoute, tourSignInViewProblem, type TourFailure, type TourProblem, type TourSignInRequirement, type TourSize, type TourStep, type TourTarget } from "../../shared/tour";
import { TOUR_DRY_RUN_BLIND, TOUR_SIGN_IN_BOX_SIGNED_IN, TOUR_SIGN_IN_HUMAN, TOUR_SIGN_IN_LANDED, TOUR_SIGN_IN_STALE, TOUR_SIGN_IN_WRONG, type TourAttemptInput, type TourChildMessage, type TourParentMessage, type TourStorageState } from "./runner-protocol";
import { filterTourStorage } from "./signin-store";
import { tourLookControls, tourLookLinks, tourLookUrl, type TourLookPage, type TourLookProblem, type TourLookSize } from "./look";
import type { Locator, Page, WebSocketRoute } from "playwright-core";
import { SOVA_SERVER_HEADER, TOUR_RECORDER_HEADER, TOUR_SOVA_REFUSAL } from "./runner-header";

declare global {
  interface Window { __sovaTourBlocked: (kind: string) => Promise<void>; __sovaTourAllowSubmit?: (form: HTMLFormElement | null) => void; __sovaTourScrolls?: number }
}
/** A view's target or capture problem (no match, several, moving, outside, covered, an action not allowed on it): a dry run notes it and goes on. */
class TourTargetProblem extends TourCaptureFailure {}
/** A sign-in that couldn't go on (its boxes gone): reported for the sign-in route, not a step or view. */
class TourSignInFailure extends TourCaptureFailure {}
const GENERIC_GUIDANCE = "Review this step's semantic targets, allowed actions, site consent and sandbox. Repair the script or use reference text, then run the dry run again.";

const send = (message: TourChildMessage) => process.stdout.write(`${JSON.stringify(message)}\n`);
type SignInAnswer = { account?: string; username?: string; password?: string; code?: string };
const awaiting = new Map<number, { resolve: (answer?: SignInAnswer) => void; reject: (error: Error) => void }>();
let nextId = 0;
/** Ask the server for this sign-in's login or code: from the tour's memory, or once the user answers. */
function askSignIn(origin: string, fields: TourSignInRequirement["fields"]): Promise<SignInAnswer> {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    awaiting.set(id, { resolve: answer => resolve(answer ?? {}), reject });
    send({ type: "sign-in-needed", id, origin, fields });
  });
}
function request(type: "contact" | "checkpoint", origin?: string): Promise<void> {
  if (awaiting.size > 256) return Promise.reject(new Error("The page exceeded the recording request limit."));
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    awaiting.set(id, { resolve: () => resolve(), reject });
    send(type === "contact" ? { type, id, origin: origin! } : { type, id });
  });
}
let started = false;
let finished = false;
let activeBrowser: Awaited<ReturnType<typeof launchTourBrowser>> | undefined;
const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  try {
    if (line.length > 400_000) throw new Error("Oversized recording command.");
    const msg = JSON.parse(line) as TourParentMessage;
    if (msg.type === "answer") {
      const entry = awaiting.get(msg.id); awaiting.delete(msg.id);
      if (entry) msg.failure ? entry.reject(new TourCaptureFailure(msg.failure)) : entry.resolve();
    } else if (msg.type === "sign-in") {
      const entry = awaiting.get(msg.id); awaiting.delete(msg.id);
      entry?.resolve({ ...(typeof msg.account === "string" ? { account: msg.account } : {}), ...(typeof msg.username === "string" ? { username: msg.username } : {}), ...(typeof msg.password === "string" ? { password: msg.password } : {}), ...(typeof msg.code === "string" ? { code: msg.code } : {}) });
    } else if (msg.type === "start" && !started) { started = true; void run(msg.input); }
  } catch { process.exitCode = 1; lines.close(); }
});
lines.on("close", () => {
  if (finished) return;
  process.exitCode = 1;
  for (const entry of awaiting.values()) entry.reject(new Error("Recording server disconnected."));
  awaiting.clear();
  // The parent may have crashed. Do not wait forever for another policy response or orphan
  // the installed browser; pipe closure is an interruption, never permission to continue.
  const deadline = setTimeout(() => process.exit(1), 2000);
  deadline.unref();
  void activeBrowser?.close().finally(() => process.exit(1));
});

async function run(input: TourAttemptInput): Promise<void> {
  let browser: Awaited<ReturnType<typeof launchTourBrowser>> | undefined;
  let location: Partial<TourFailure> = {};
  /** Writes the pages sent by themselves (outside any action, or while being left), stopped quietly. */
  let quietAborts = 0;
  try {
    const script = normalizeTourScript(input.script);
    if (!script) throw new Error("Invalid recording script.");
    // Sandbox off: the attempt's own proxy is the browser's only way out; without it, nothing runs.
    const ownProxy = !input.proxied ? process.env.HTTPS_PROXY : undefined;
    if (!input.proxied && !(ownProxy && /^http:\/\/127\.0\.0\.1:\d+$/.test(ownProxy))) throw new TourCaptureFailure({ message: "Recording couldn't start its network guard, so nothing ran.", guidance: "Retry in a moment. Recording never runs with a direct connection." });
    try { browser = await launchTourBrowser(); }
    catch (error) { throw new TourCaptureFailure({ message: error instanceof TourBrowserSetupError ? error.message : "The installed Chrome or Chromium could not launch inside the recording policy.", guidance: "Check the installed browser and this chat's sandbox on the recording host. Sova never downloads a browser or disables the sandbox to make recording work." }); }
    activeBrowser = browser;
    const addresses = new TourBrowserAddresses(undefined, input.proxied === true);
    const assets = new Map<string, Uint8Array>();
    let totalBytes = 0;
    const save = (file: string, bytes: Buffer) => {
      totalBytes += bytes.length;
      if (bytes.length > TOUR_LIMITS.assetBytes || totalBytes > TOUR_LIMITS.totalBytes || assets.size >= TOUR_LIMITS.assets) throw new Error("The tour exceeds its image limit. Split it into smaller tours.");
      assets.set(file, bytes); send({ type: "asset", file, base64: bytes.toString("base64") });
    };
    const steps: TourStep[] = script.steps.map((s, i) => ({ n: i + 1, id: s.id, chapter: s.chapter, title: s.title, summary: s.summary, views: s.views.map(v => ({ id: v.id, title: v.title, kind: v.kind, note: v.note, route: v.kind === "page" ? v.route : null, ...(v.comparison ? { comparison: v.comparison } : {}), ...(v.kind === "reference" ? { reference: v.reference } : {}), ...(v.kind === "page" && v.unavailableReason ? { unavailableReason: v.unavailableReason } : {}), captures: {} })) }));
    const total = script.steps.reduce((n, s) => n + s.views.reduce((m, v) => m + (v.kind === "page" ? v.sizes.length : 0), 0), 0);
    let completed = 0;
    let sovaServer = false;
    const suspicious: string[] = [];
    // The script's form sign-in: its origins, and the tour's signed-in session carried between sizes.
    const signInConf = input.signIn ? script.signIn : undefined;
    const signInOrigins = new Set(signInConf ? input.signIn!.origins : []);
    let storage: TourStorageState | undefined = signInConf ? input.signIn?.storage : undefined;
    let signedIn = !!storage;
    let signIns = 0;
    // A dry run's target problems, grouped (same message, target and match count), and how many views in a
    // row found none of their targets (§app.tours/recording).
    const groups = new Map<string, TourProblem & { count: number }>();
    const problemViews = new Set<string>();
    let blindStreak = 0;
    const noteProblem = (failure: TourFailure, at: TourProblem["at"][number]) => {
      const key = JSON.stringify([failure.message, failure.target ?? null, failure.matches ?? null]);
      const group = groups.get(key) ?? { message: failure.message, guidance: failure.guidance, at: [], count: 0, ...(failure.target ? { target: failure.target } : {}), ...(failure.matches !== undefined ? { matches: failure.matches } : {}), ...(failure.nearby?.length ? { nearby: failure.nearby } : {}) };
      if (group.at.length < TOUR_PROBLEM_LIMITS.places) group.at.push(at);
      group.count++; groups.set(key, group);
      problemViews.add(`${at.stepId}/${at.viewId}`);
    };
    const report = (stop?: string): TourFailure => {
      const list = [...groups.values()];
      const first = list[0]!.at[0]!;
      const total = list.reduce((n, g) => n + g.count, 0), views = problemViews.size;
      const fix = "Fix every problem below, then run the dry run again. Each nearby entry is a ready-to-use target and how many visible controls it matches now.";
      return {
        message: stop ?? `The dry run found ${total} problem${total === 1 ? "" : "s"} in ${views} view${views === 1 ? "" : "s"}.`,
        guidance: stop ? `The page drawn there is probably not the one the script expects (a sign-in page, an error page or a redirect): check the routes and the sign-in (vis_guide tour-signin). ${fix}` : fix,
        stepId: first.stepId, viewId: first.viewId, size: first.size,
        problems: list.slice(0, TOUR_PROBLEM_LIMITS.problems).map(({ count, ...g }) => ({ ...g, ...(count > g.at.length ? { count } : {}) })),
        ...(list.length > TOUR_PROBLEM_LIMITS.problems ? { more: list.length - TOUR_PROBLEM_LIMITS.problems } : {}),
      };
    };
    // A look (§app.tours/look): the signed-out sign-in page first, when its route is known, then each page per size.
    const lookSignInRoute = input.look ? input.look.signInRoute ?? script.signIn?.route : undefined;
    const lookPages = new Map<number, TourLookPage>();
    if (input.look) for (const [si, step] of script.steps.entries()) { const v = step.views[0]; if (v?.kind === "page") lookPages.set(si, { route: v.route }); }
    let lookSignIn: (TourLookSize & { route: string }) | undefined;
    const passes: ("sign-in-page" | TourSize)[] = [...(lookSignInRoute ? ["sign-in-page" as const] : []), "desktop", "phone"];
    for (const pass of passes) {
      /** A look's signed-out visit to the sign-in page: a fresh browser without the tour's session, nothing typed. */
      const signedOutPass = pass === "sign-in-page";
      const size: TourSize = pass === "sign-in-page" ? "desktop" : pass;
      const viewport = TOUR_VIEWPORTS[size];
      /** This size's browser starts from the session the tour holds (a stored sign-in). */
      const heldSession = !!storage && !signedOutPass;
      /** This size went on from the held session without seeing it signed in: every view is checked for the form. */
      let unconfirmed = false;
      const context = await browser.newContext({ viewport: { width: viewport.w, height: viewport.h }, deviceScaleFactor: 1, colorScheme: "light", serviceWorkers: "block", acceptDownloads: false, ...(storage && !signedOutPass ? { storageState: storage } : {}), ...(input.account ? { httpCredentials: { origin: input.account.origin, username: input.account.username, password: input.account.password } } : {}) });
      // Every request says it is a tour recorder, so no Sova it reaches hands it an install's identity.
      await context.setExtraHTTPHeaders({ [TOUR_RECORDER_HEADER]: "1" });
      // A verified managed Sova copy signs in only by its own cookie, before the first navigation.
      // Its recorder marker rides beside it: a socket handshake carries no added header.
      if (input.sova) await context.addCookies([{ name: input.sova.name, value: input.sova.value, url: input.sova.origin, httpOnly: true, sameSite: "Strict" }, { name: input.sova.marker, value: "1", url: input.sova.origin, httpOnly: true, sameSite: "Strict" }]);
      let blocked: TourFailure | undefined;
      let localDraftOnly = false;
      /**
       * The one sign-in exception, held here in Node and never visible to the page: opened only by the
       * recorder's own click on the sign-in's submit control, it admits a few non-GET requests to the
       * sign-in origins, still through consent and identity, until signed in or 15 seconds pass.
       */
      let signInWindow: { nonGetLeft: number; closesAt: number } | null = null;
      const refuse = (message: string, origin?: string) => { blocked ??= { message, guidance: "Use a read-only disclosure/local draft, seeded data or a reference view. Recording never submits or mutates the application.", ...(origin ? { blockedOrigin: origin } : {}) }; };
      try {
        // Every request the page makes waits for the server's live approval and source-owner check.
        // Routing sees only the first URL of a redirect chain: a hop is watched below, and its
        // connection goes through the attempt's proxy, which admits only this tour's origins.
        const declared = new Set(input.declared ?? [input.origin]);
        const requested = new Set<string>();
        /** Bumped each time the recorder leaves a view: a route handler can tell its view has gone. */
        let generation = 0;
        /** True while the recorder leaves a view for the blank page before the next one. */
        let leaving = false;
        context.on("request", req => {
          if (!req.redirectedFrom()) return;
          let hop: string;
          try { hop = new URL(req.url()).origin; } catch { return; }
          if (!declared.has(hop) && !requested.has(hop)) refuse(`This page redirects to ${hop}, which this tour didn't declare. Declare it in sites, or use reference text.`, hop);
        });
        await context.route("**/*", async route => {
          const entered = generation;
          let plumbing = false;
          try {
            const req = route.request(); const url = new URL(req.url());
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error("A request used an unsupported destination.");
            const sovaCopy = !!input.sova && url.origin === input.sova.origin;
            if (req.method() !== "GET" && signInWindow && Date.now() < signInWindow.closesAt && signInWindow.nonGetLeft > 0 && signInOrigins.has(url.origin) && !sovaCopy) signInWindow.nonGetLeft--;
            else if (req.method() !== "GET" && leaving) { quietAborts++; return await route.abort("blockedbyclient"); }
            // A write the page sends by itself, outside any action (analytics, "mark seen"), is stopped
            // without reaching the site and counted. A form submission, a write after an open or fill,
            // and any write to a Sova copy still fail the attempt.
            else if (req.method() !== "GET" && !localDraftOnly && !req.isNavigationRequest() && !sovaCopy) { quietAborts++; return await route.abort("blockedbyclient"); }
            else if (req.method() !== "GET" || localDraftOnly) { refuse(localDraftOnly ? "An opening or draft action tried to contact the application; a GET is not assumed to be a safe mutation." : `Blocked ${req.method()} request during read-only recording.`, url.origin); return await route.abort("blockedbyclient"); }
            await request("contact", url.origin);
            requested.add(url.origin);
            await addresses.beforeContact(url.origin);
            plumbing = true;
            await route.continue();
          } catch (error) {
            // A request the previous view left in flight is cancelled when the recorder leaves it: only
            // the browser plumbing failing for that reason is ignored. A refused contact (consent,
            // identity, policy) stays fatal whichever view's request it was.
            if (plumbing && entered !== generation) return;
            blocked ??= error instanceof TourCaptureFailure ? error.failure : { message: "A destination could not be approved safely.", guidance: "Review site consent and the chat's sandbox, then retry." };
            await route.abort("blockedbyclient").catch(() => {});
          }
        });
        // Any other site: a socket the page opens (a dev server's live reload) is admitted like a request:
        // the live per-contact check, then the address check, then the attempt's proxy, never after an open
        // or fill. It may open and receive; each frame the page sends is dropped and counted, never sent.
        const sovaAnswered = new Set<string>();
        const admitSocket = async (socket: WebSocketRoute, path: string) => {
          let origin: string;
          try {
            const u = new URL(socket.url());
            if (!["ws:", "wss:"].includes(u.protocol) || u.username || u.password) throw new Error("unsupported");
            origin = `${u.protocol === "wss:" ? "https" : "http"}://${u.host}`;
          } catch { refuse("A live connection used an unsupported destination."); socket.close(); return; }
          // A Sova's live chat socket never opens on any origin: opening it starts a chat.
          if (path === "/ws/chat") { refuse("Blocked a live chat connection (/ws/chat): this page opens a live chat; record it as reference text or choose an idle view."); socket.close(); return; }
          if (localDraftOnly) { refuse(`An opening or draft action opened a live connection (${path}); a connection is not assumed to be read-only.`, origin); socket.close(); return; }
          try {
            await request("contact", origin);
            requested.add(origin);
            await addresses.beforeContact(origin);
            // An origin that answered as a Sova gets no socket: only a verified managed copy's own feed opens.
            if (sovaAnswered.has(origin)) throw new TourCaptureFailure({ message: TOUR_SOVA_REFUSAL, guidance: "Record a managed test copy of this branch, never the live install or another Sova.", blockedOrigin: origin });
          } catch (error) {
            blocked ??= error instanceof TourCaptureFailure ? error.failure : { message: "A destination could not be approved safely.", guidance: "Review site consent and the chat's sandbox, then retry." };
            socket.close(); return;
          }
          // Both handlers before the connection exists: nothing the page sends, its close code and reason
          // included, is ever forwarded. connectToServer opens the real socket from the page's own native
          // WebSocket, so it goes out through the browser's proxy like every other contact.
          let server: WebSocketRoute | undefined;
          socket.onMessage(() => { quietAborts++; });
          socket.onClose(() => { server?.close(); });
          server = socket.connectToServer();
        };
        await context.routeWebSocket("**/*", socket => {
          if (!input.sova) { void admitSocket(socket, socketPath(socket.url())); return; }
          // Only a verified managed Sova copy's own /ws/watch opens; its answers pass, and any frame
          // the page sends aborts the attempt (the allowed client-to-server set is empty).
          // Failures name the socket's path only, never its query or any frame.
          const path = socketPath(socket.url());
          if (!input.sova || !sovaWatch(socket.url(), input.sova.origin)) {
            refuse(path === "/ws/chat" ? "Blocked a live chat connection (/ws/chat): this page opens a live chat; record it as reference text or choose an idle view." : `Blocked a WebSocket connection to ${path} during read-only recording.`);
            socket.close(); return;
          }
          const server = socket.connectToServer();
          socket.onMessage(() => { refuse(`Blocked a message the page tried to send on its live connection (${path}).`); socket.close(); server.close(); });
        });
        // While the recorder leaves a view, a write the page tries on its way out (a pagehide beacon) is
        // stopped without failing the attempt: the recorder's own navigation provoked it.
        await context.exposeBinding("__sovaTourBlocked", (_source, kind: string) => {
          // A beacon the page sends by itself is stopped quietly, like its other own writes.
          if (leaving || kind === "beacon" && !localDraftOnly && !input.sova) { quietAborts++; return; }
          refuse(`Blocked ${String(kind).slice(0, 40)} during read-only recording.`);
        });
        await context.addInitScript(() => {
          const blocked = (kind: string) => { void window.__sovaTourBlocked(kind); };
          // The sign-in form may submit once, after the recorder names it. The page could name it too:
          // that grants nothing, since its request still meets the Node-held route rule above.
          let allowed: HTMLFormElement | null = null;
          Object.defineProperty(window, "__sovaTourAllowSubmit", { value: (form: HTMLFormElement | null) => { allowed = form; }, enumerable: false });
          const once = (form: unknown) => { if (allowed && form === allowed) { allowed = null; return true; } return false; };
          const nativeSubmit = HTMLFormElement.prototype.submit, nativeRequest = HTMLFormElement.prototype.requestSubmit;
          document.addEventListener("submit", e => { if (once(e.target)) return; e.preventDefault(); e.stopImmediatePropagation(); blocked("form submission"); }, true);
          HTMLFormElement.prototype.submit = function () { if (once(this)) return nativeSubmit.call(this); blocked("form submission"); };
          HTMLFormElement.prototype.requestSubmit = function (submitter?: HTMLElement | null) { if (allowed === this) return nativeRequest.call(this, submitter); blocked("form submission"); };
          // Every scroll in the page, an inner panel's too, for the capture's settle check.
          let scrolls = 0;
          addEventListener("scroll", () => { scrolls++; }, { capture: true, passive: true });
          Object.defineProperty(window, "__sovaTourScrolls", { get: () => scrolls, enumerable: false });
          navigator.sendBeacon = () => { blocked("beacon"); return false; };
          window.open = () => { blocked("popup"); return null; };
          // Second layer behind the attempt's proxy: speculation rules a page declares or injects are
          // removed as they appear (an observer can lose a race with the parser; the proxy cannot).
          new MutationObserver(records => { for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLScriptElement && n.type.trim().toLowerCase() === "speculationrules") n.remove(); }).observe(document, { childList: true, subtree: true });
          // No data-channel/UDP path outside the request guard.
          Object.defineProperty(window, "RTCPeerConnection", { value: class { constructor() { blocked("WebRTC"); throw new Error("WebRTC unavailable during recording"); } } });
        });
        const responseChecks = new Set<Promise<void>>();
        context.on("response", response => {
          // An answer from a Sova: this is a tour of Sova, which only a verified managed test copy may be.
          if (response.headers()[SOVA_SERVER_HEADER] === "sova") {
            sovaServer = true; sovaAnswered.add(new URL(response.url()).origin);
            if (!input.sova || new URL(response.url()).origin !== input.sova.origin) blocked ??= { message: TOUR_SOVA_REFUSAL, guidance: "Record a managed test copy of this branch, never the live install or another Sova.", blockedOrigin: new URL(response.url()).origin };
          }
          const check = (async () => {
            // Behind the attempt's own proxy the peer is the proxy; it checks the address it dials.
            try { if (!ownProxy) addresses.response(new URL(response.url()).origin, (await response.serverAddr().catch(() => null))?.ipAddress); }
            catch (error) { blocked ??= error instanceof TourCaptureFailure ? error.failure : { message: "The recording browser could not verify a response address.", guidance: "Review this site's network policy, then retry." }; }
          })();
          responseChecks.add(check);
          void check.finally(() => responseChecks.delete(check));
        });
        const page = await context.newPage();
        page.setDefaultTimeout(6000);
        let pageErrors = 0;
        page.on("pageerror", () => { pageErrors++; });
        page.on("download", download => { refuse("Blocked a download during recording."); void download.cancel(); });
        // Leaving a view for the next one's fresh load may ask "leave this page?" (a page with user
        // activation, after an open): that leave is the recorder's own, so it goes ahead. Any other
        // dialog wants the user's input and stops the attempt.
        page.on("dialog", dialog => {
          if (dialog.type() === "beforeunload") { void dialog.accept(); return; }
          refuse("Blocked a dialog requiring user input during recording."); void dialog.dismiss();
        });
        context.on("page", popup => { if (popup !== page) { refuse("Blocked an unexpected popup during recording."); void popup.close(); } });
        const assertSafe = () => { if (blocked) throw new TourCaptureFailure(blocked); };
        /** A target or capture step: what it throws is a target problem, unless a safety stop is pending. */
        const targeted = async <T>(fn: () => Promise<T>): Promise<T> => {
          try { return await fn(); } catch (error) {
            if (blocked || error instanceof TourTargetProblem) throw error;
            throw new TourTargetProblem(error instanceof TourCaptureFailure ? error.failure : { message: error instanceof Error ? error.message.slice(0, 1800) : "Recording failed.", guidance: GENERIC_GUIDANCE });
          }
        };
        /** Sign in on the page now showing the sign-in form: at most twice per attempt (once, plus one re-sign-in). */
        const signInNow = async () => {
          const origin = new URL(page.url()).origin;
          if (!signInOrigins.has(origin)) throw new TourCaptureFailure({ message: `The sign-in page is on ${origin}, which isn't one of this sign-in's origins.`, guidance: "If that page is this app's own sign-in, list its origin in signIn.origins and record again; otherwise tell the user. Never sign in to the app any other way.", blockedOrigin: origin });
          if (++signIns > 2) throw new TourCaptureFailure({ message: "The site signed the recorder out again, so recording stopped.", guidance: "Record again. If it keeps happening, tell the user, or use reference text for those views. Never sign in to the app any other way.", blockedOrigin: origin });
          await signInHere(page, origin, signInConf!, signInOrigins, w => { signInWindow = w; }, assertSafe);
          const state = filterTourStorage(await context.storageState() as TourStorageState, [...signInOrigins]);
          if (state) { storage = state; send({ type: "signed-in", origin, storage: state }); }
          signedIn = true;
        };
        // The controls the sign-in page does show, as targets, so the chat can fix its sign-in targets in one go.
        const neither = async () => new TourCaptureFailure({ message: "The sign-in page showed neither its signed-in control nor its password box, so recording stopped.", guidance: "Nothing was typed. Check signIn.route, signIn.signedIn and signIn.password against the controls this page shows (nearby), then record again; see vis_guide tour-signin. If they are right, tell the user; never change the app.", blockedOrigin: new URL(page.url()).origin, nearby: await tourNearby(page).catch(() => []) });
        /** Open the sign-in route (never pictured) and report whichever shows first within 10 s: the signed-in control or the password box. */
        const openSignInRoute = async (): Promise<"signed-in" | "form" | null> => {
          await request("checkpoint");
          const opened = await page.goto(new URL(signInConf!.route, input.origin).href, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(error => { assertSafe(); throw error; });
          assertSafe();
          if (opened?.status() === 401) throw new TourCaptureFailure({ message: "This page requires a test account.", guidance: "Store an HTTP Basic test account for this exact origin, then retry. Never use a personal account.", blockedOrigin: new URL(page.url()).origin });
          await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
          assertSafe();
          const shown = await Promise.any([
            tourLocator(page, signInConf!.signedIn).filter({ visible: true }).first().waitFor({ state: "visible", timeout: 10_000 }).then(() => "signed-in" as const),
            tourLocator(page, signInConf!.password).filter({ visible: true }).first().waitFor({ state: "visible", timeout: 10_000 }).then(() => "form" as const),
          ]).catch(() => null);
          assertSafe();
          return shown === "form" ? await settleForm() : shown;
        };
        /**
         * The password box showed first: an app may draw its form while it checks a session it holds. Wait for
         * the network to go quiet, then give the signed-in control about 1.5 s more (§app.tours/recording).
         */
        const settleForm = async (): Promise<"signed-in" | "form" | null> => {
          await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
          assertSafe();
          const signed = await tourLocator(page, signInConf!.signedIn).filter({ visible: true }).first().waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false);
          assertSafe();
          if (signed) return "signed-in";
          return await tourLocator(page, signInConf!.password).filter({ visible: true }).count().catch(() => 0) > 0 ? "form" : null;
        };
        /**
         * Leave the view for a blank page, as before every fresh load: nothing the view did (an open or fill,
         * which refuses every later request) carries over, and a write it tries on its way out is stopped quietly.
         */
        const leaveView = async () => {
          pageErrors = 0; localDraftOnly = false;
          generation++;
          leaving = true;
          try { await page.goto("about:blank", { timeout: 6000 }).catch(error => { assertSafe(); throw error; }); }
          finally { leaving = false; }
          await Promise.all(responseChecks); assertSafe();
          pageErrors = 0; localDraftOnly = false;
        };
        /**
         * A sign-out the site shows in place: given up to 2 s (the time an app takes to draw its form after its
         * session check), the declared password box shows before the signed-in control, and no signed-in control
         * beside it. A size that went on unconfirmed from the tour's held session stops there (that session is
         * gone: the server forgets it, keeping the login); any other size signs in again. Nothing is typed here.
         */
        const signedOutHere = async () => {
          if (!signInConf) return false;
          const first = await Promise.any([
            tourLocator(page, signInConf.password).filter({ visible: true }).first().waitFor({ state: "visible", timeout: 2000 }).then(() => "form" as const),
            tourLocator(page, signInConf.signedIn).filter({ visible: true }).first().waitFor({ state: "visible", timeout: 2000 }).then(() => "signed-in" as const),
          ]).catch(() => null);
          if (first !== "form" || await tourLocator(page, signInConf.signedIn).filter({ visible: true }).count() > 0) return false;
          // The same settle as up front: a form drawn while the app checks its session is no sign-out.
          if (await settleForm() !== "form") return false;
          if (unconfirmed) throw new TourCaptureFailure({ message: TOUR_SIGN_IN_STALE, guidance: "Nothing was typed or pictured. Recording again signs in up front.", blockedOrigin: new URL(page.url()).origin });
          return true;
        };
        /** Sign in again on the sign-in route, never on the view; the caller then loads the view fresh. */
        const reSignIn = async () => {
          await leaveView();
          const shown = await openSignInRoute();
          if (shown === "signed-in") throw new TourCaptureFailure({ message: TOUR_SIGN_IN_BOX_SIGNED_IN, guidance: "Nothing was typed or pictured. Make signIn.password name only the sign-in form's box, or record this view as reference text.", blockedOrigin: new URL(page.url()).origin });
          if (!shown) throw await neither();
          await signInNow();
        };
        // Up front, before this size's first view: open the sign-in route (never pictured). A session the
        // tour holds shows the signed-in control and goes on; otherwise sign in now, so a site that shows its
        // sign-in form in place of any page is signed in before any view.
        /** This page as the look lists it, at this size, as it is now. */
        const lookHere = async (problem?: TourLookProblem): Promise<TourLookSize> => ({ url: tourLookUrl(page.url(), input.origin), ...(await tourLookControls(page, viewport)), links: await tourLookLinks(page, input.origin), ...(problem ? { problem } : {}) });
        if (signedOutPass) {
          location = { size };
          await request("checkpoint");
          const opened = await page.goto(new URL(lookSignInRoute!, input.origin).href, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(error => { assertSafe(); throw error; });
          assertSafe();
          if (opened?.status() === 401) throw new TourCaptureFailure({ message: "This page requires a test account.", guidance: "Store an HTTP Basic test account for this exact origin, then retry. Never use a personal account.", blockedOrigin: new URL(page.url()).origin });
          await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
          // An app may draw its form after a check of its own: give a box up to 3 s to show.
          await page.locator("input:visible, textarea:visible").first().waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
          await Promise.all(responseChecks); assertSafe();
          lookSignIn = { route: lookSignInRoute!, ...(await lookHere()) };
          await Promise.all(responseChecks); assertSafe();
          continue;
        }
        if (signInConf) {
          location = { size };
          // Whichever shows first, within 10 s: the signed-in control (a session it holds: go on) or the
          // password box (sign in, or wait on the card). Neither: stop, typing nothing.
          const shown = await openSignInRoute();
          // A site whose sign-in route shows neither once signed in (a "no such page" there): a size that
          // started from the tour's held session goes on, typing nothing. Without one, it stops.
          if (!shown && heldSession) unconfirmed = true;
          if (!shown && !heldSession) throw await neither();
          if (shown === "form") await signInNow();
        }
        for (const [si, step] of script.steps.entries()) for (const [vi, view] of step.views.entries()) {
          if (view.kind !== "page" || !view.sizes.includes(size)) continue;
          location = { stepId: step.id, viewId: view.id, size };
          // The sign-in page itself is never a view: signed in there, a fresh load would only sign in again. The
          // script check refuses it; a script stored before that check stops here, nothing loaded (§app.tours/recording).
          if (signInConf && tourOnSignInRoute(view.route, signInConf.route)) throw new TourCaptureFailure({ message: tourSignInViewProblem(`steps[${si}] "${step.id}" \u203a views[${vi}] "${view.id}"`), guidance: "Nothing was loaded for this view. Replace it with a reference view describing the sign-in page, then run the dry run again." });
          send({ type: "progress", progress: { completed, total, ...location } });
          await request("checkpoint");
          await Promise.all(responseChecks); assertSafe();
          // Each view starts from a fresh document load. Leaving for a blank page first (no request, so
          // no route, consent or redirect check sees it; it is never an origin) makes the view's own
          // goto a full load even when its route differs from the last only after "#", which would
          // otherwise be a same-document navigation without a response. Nothing the previous view did
          // in the page carries over; the size's context (cookies, site storage) does.
          // A sign-out the site shows in place, before the view's actions or its capture: sign in again on the
          // sign-in route, then run the whole view again from a fresh load (at most twice: the attempt's cap).
          try {
          attempt: for (;;) {
            const load = async () => {
              await leaveView();
              const loaded = await page.goto(new URL(view.route, input.origin).href, { waitUntil: "domcontentloaded", timeout: 15_000 }).catch(error => { assertSafe(); throw error; });
              assertSafe();
              return loaded;
            };
            let response = await load();
            // The script's sign-in page, reached directly or by a redirect (a 401 stays HTTP Basic): sign
            // in, then load the view fresh, so the sign-in page itself is never captured.
            // A page may send itself to its sign-in after loading (a hash-routed app checking its session): settle first.
            const atSignIn = async () => {
              if (!signInConf || response?.status() === 401) return false;
              await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
              assertSafe();
              return onSignInRoute(page.url(), signInConf.route, signInOrigins);
            };
            while (await atSignIn()) {
              await signInNow();
              response = await load();
            }
            if (response?.status() === 401) throw new TourCaptureFailure({ message: "This page requires a test account.", guidance: "Store an HTTP Basic test account for this exact origin, then retry. Never use a personal account.", blockedOrigin: new URL(page.url()).origin });
            if (!response || !response.ok()) throw new Error("The recorded page did not return a successful response.");
            await page.setViewportSize({ width: viewport.w, height: viewport.h });
            await page.waitForFunction(({ w, h }) => innerWidth === w && innerHeight === h && document.readyState !== "loading" && !!document.body?.getClientRects().length, viewport, { timeout: 6000 });
            await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(error => { assertSafe(); throw error; });
            assertSafe();
            if ((view.actions[size] ?? []).length && await signedOutHere()) { await reSignIn(); continue attempt; }
            for (const [ai, action] of (view.actions[size] ?? []).entries()) {
              location = { stepId: step.id, viewId: view.id, size, action: ai, ...("target" in action ? { target: action.target } : {}) };
              await request("checkpoint");
              if (action.op === "scroll") await page.evaluate(({ x, y }) => scrollBy({ left: x, top: y, behavior: "instant" }), action);
              else await targeted(async () => {
                const loc = await uniqueTourTarget(page, action.target);
                if (action.op === "reveal") { await revealTourTarget(loc, viewport); return; }
                if (action.op === "open") {
                  localDraftOnly = true;
                  const safe = await loc.evaluate(el => el.tagName === "SUMMARY" && el.parentElement?.tagName === "DETAILS" || el.tagName === "BUTTON" && el.getAttribute("type") === "button" && el.hasAttribute("aria-expanded") && !!el.getAttribute("aria-controls") && !!document.getElementById(el.getAttribute("aria-controls")!));
                  if (!safe) throw new Error("Only native details or explicit disclosure buttons with a controlled region can be opened. Use a reference view for other actions.");
                  await loc.click();
                } else if (action.op === "fill") {
                  localDraftOnly = true;
                  // Local draft only: native setter without input/change events cannot trigger an
                  // autosave handler. It is not represented as an application-accepted edit.
                  const safe = await loc.evaluate((el, value) => {
                    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || !el.closest("form") || el instanceof HTMLInputElement && !["text", "search", "email", "url", "tel"].includes(el.type) || el.readOnly || el.disabled) return false;
                    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
                    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value); return true;
                  }, action.value);
                  if (!safe) throw new Error("Fill only supports a local text draft in a form, without events or submission. Use seeded data or a reference view for autosaving controls.");
                }
                await stableTourBox(loc, viewport);
              });
              assertSafe();
            }
            location = { stepId: step.id, viewId: view.id, size };
            if (await signedOutHere()) { await reSignIn(); continue attempt; }
            if (input.look) {
              lookPages.get(si)![size] = await lookHere();
              await Promise.all(responseChecks); assertSafe();
              completed++; send({ type: "progress", progress: { completed, total, stepId: step.id, viewId: view.id, size } });
              break;
            }
            await page.evaluate(() => document.fonts.ready);
            // Password and username boxes are always blacked out, whatever the script names (BRIEF q7).
            for (const box of await loginBoxes(page, [signInConf?.username, signInConf?.account])) await page.evaluate(b => { const mask = document.createElement("div"); Object.assign(mask.style, { position: "fixed", left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px`, background: "#242a30", zIndex: "2147483647", pointerEvents: "none" }); document.documentElement.append(mask); }, box);
            const marks = [];
            for (const [mi, mark] of view.marks.entries()) marks.push(await targeted(async () => {
              try { return await tourMark(page, mark.target, viewport, { n: mi + 1, label: mark.label, side: mark.side }); }
              catch (error) { throw await splitAdvice(page, error, view.marks.map(m => m.target), viewport); }
            }));
            // Rectangular opaque masks are burned into the only image bytes sent to storage.
            for (const target of view.masks) {
              const box = await targeted(async () => stableTourBox(await uniqueTourTarget(page, target), viewport));
              await page.evaluate(b => { const mask = document.createElement("div"); Object.assign(mask.style, { position: "fixed", left: `${b.x}px`, top: `${b.y}px`, width: `${b.width}px`, height: `${b.height}px`, background: "#242a30", zIndex: "2147483647", pointerEvents: "none" }); document.documentElement.append(mask); }, box);
            }
            await request("checkpoint"); await Promise.all(responseChecks); assertSafe();
            // Require stable body geometry, not a fixed delay standing in for readiness.
            // The page as a whole: its body's screen box and the scroll position hold still for two frames (a
            // page still smooth-scrolling isn't settled); then its box in document coordinates, where the view's
            // scroll left it, must lie within the document.
            // Any scroll inside the page (an inner panel's too) since the last frame means it hasn't settled.
            await targeted(async () => settledBox(page, () => page.evaluate(() => { const r = document.body.getBoundingClientRect(); return { box: { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height }, still: [r.x, r.y, r.width, r.height, scrollX, scrollY, window.__sovaTourScrolls ?? 0] }; }), await page.evaluate(({ w, h }) => ({
              // Scroll sizes are whole pixels and a body may end mid-pixel: one pixel of slack.
              w: Math.max(w, document.body.scrollWidth, document.documentElement.scrollWidth) + 1,
              h: Math.max(h, document.body.scrollHeight, document.documentElement.scrollHeight) + 1,
            }), { w: viewport.w, h: viewport.h }), "The page"));
            if (!input.dryRun) {
              const image = `capture-${si + 1}-${vi + 1}-${size}.png`;
              const bytes = await page.screenshot({ fullPage: false, animations: "disabled", scale: "css" });
              assertSafe(); save(image, bytes);
              steps[si]!.views[vi]!.captures[size] = { image, marks };
              if (pageErrors || bytes.length < 5000) suspicious.push(image);
            }
            completed++; send({ type: "progress", progress: { completed, total, stepId: step.id, viewId: view.id, size } });
            break;
          }
          blindStreak = 0;
          } catch (error) {
            // A look notes a page that failed to load or whose actions failed, lists what it shows, and goes on.
            if (input.look && !blocked && (error instanceof TourTargetProblem || !(error instanceof TourCaptureFailure))) {
              const f = error instanceof TourCaptureFailure ? error.failure : { message: error instanceof Error ? error.message.slice(0, 1000) : "This page couldn't be looked at." };
              const problem: TourLookProblem = { message: f.message, ...("target" in f && f.target ? { target: f.target } : {}), ...("nearby" in f && f.nearby?.length ? { nearby: f.nearby } : {}) };
              lookPages.get(si)![size] = await lookHere(problem).catch(() => ({ url: "", controls: [], links: [], problem }));
              assertSafe();
              completed++; send({ type: "progress", progress: { completed, total, stepId: step.id, viewId: view.id, size } });
              continue;
            }
            // A dry run notes a target problem and goes on to the next view; a safety stop, and any problem in a recording, stops here.
            if (!(error instanceof TourTargetProblem) || !input.dryRun || blocked) throw error;
            noteProblem(error.failure, { stepId: step.id, viewId: view.id, size, ...(location.action !== undefined ? { action: location.action } : {}) });
            const named: TourTarget[] = [...(view.actions[size] ?? []).flatMap(a => "target" in a ? [a.target] : []), ...view.marks.map(m => m.target), ...view.masks];
            let blind = named.length > 0;
            for (const target of named) if (blind && await tourLocator(page, target).filter({ visible: true }).count().catch(() => 0) > 0) blind = false;
            blindStreak = blind ? blindStreak + 1 : 0;
            if (blindStreak >= 2) { location = {}; throw new TourCaptureFailure(report(TOUR_DRY_RUN_BLIND)); }
            completed++; send({ type: "progress", progress: { completed, total, stepId: step.id, viewId: view.id, size } });
          }
        }
        await Promise.all(responseChecks); assertSafe();
      } finally { await context.close(); }
    }
    if (groups.size) { location = {}; throw new TourCaptureFailure(report()); }
    const contactSheets = input.dryRun ? [] : await createTourContactSheets(browser, steps, assets, save);
    send({ type: "result", steps, contactSheets, suspicious, publicOrigins: addresses.attestations(), sovaServer, quietAborts, ...(signInConf ? { signedIn } : {}), ...(input.look ? { look: { ...(lookSignIn ? { signInPage: lookSignIn } : {}), pages: [...lookPages.values()] } } : {}) });
  } catch (error) {
    const failure: TourFailure = error instanceof TourCaptureFailure ? error.failure : { message: error instanceof Error ? error.message.slice(0, 1800) : "Recording failed.", guidance: "Review this step's semantic targets, allowed actions, site consent and sandbox. Repair the script or use reference text, then run the dry run again." };
    // A sign-in failure is the sign-in's, never the view that led to it: it names the size alone.
    const where = error instanceof TourSignInFailure ? (location.size ? { size: location.size } : {}) : location;
    send({ type: "failure", failure: { ...where, ...failure }, quietAborts });
    process.exitCode = 1;
  } finally { if (browser) await browser.close(); finished = true; lines.close(); process.stdin.destroy(); }
}

/**
 * A mark outside the screen, in a view whose marks together span more than one screen's height at this size:
 * no scroll shows them all, so the advice is to split the view (§app.tours/recording). Any other error as it is.
 */
async function splitAdvice(page: Page, error: unknown, targets: TourTarget[], viewport: { w: number; h: number }): Promise<unknown> {
  if (!(error instanceof TourCaptureFailure) || error.failure.message !== TOUR_TARGET_OUTSIDE || targets.length < 2) return error;
  const tops: number[] = [], bottoms: number[] = [];
  for (const target of targets) {
    const box = await tourLocator(page, target).filter({ visible: true }).first().evaluate(el => { const r = el.getBoundingClientRect(); return { top: r.top + scrollY, bottom: r.bottom + scrollY }; }, undefined, { timeout: 1000 }).catch(() => null);
    if (box) { tops.push(box.top); bottoms.push(box.bottom); }
  }
  const span = tops.length >= 2 ? Math.round(Math.max(...bottoms) - Math.min(...tops)) : 0;
  if (span <= viewport.h) return error;
  return new TourCaptureFailure({ ...error.failure, guidance: `This view's marks span ${span} px, more than one ${viewport.h} px screen at this size, so no scroll shows them all: split this view into two at this size, each with the marks that fit one screen (reveal the lower ones in the second), and keep every mark; never drop marks.` });
}
/** The one socket a managed Sova copy's page may open: its own /ws/watch, with only Sova's read query keys. */
function sovaWatch(url: string, origin: string): boolean {
  try {
    const u = new URL(url);
    if (!["ws:", "wss:"].includes(u.protocol) || `${u.protocol === "wss:" ? "https" : "http"}://${u.host}` !== origin || u.pathname !== "/ws/watch" || u.username || u.password || u.hash) return false;
    const keys = [...u.searchParams.keys()];
    if (new Set(keys).size !== keys.length || keys.some(k => !["path", "feed", "tail", "wire", "have", "claude"].includes(k))) return false;
    return !u.searchParams.has("feed") || u.searchParams.get("feed") === "sessions";
  } catch { return false; }
}

/** A socket URL's path, bounded, for a failure message: never its query, credentials or frames. */
function socketPath(url: string): string {
  try { return new URL(url).pathname.slice(0, 120); } catch { return "an unreadable address"; }
}

/** The page is the script's sign-in page on one of its sign-in origins: its path, and its hash route when the route names one ("/#/login"). */
function onSignInRoute(url: string, route: string, origins: Set<string>): boolean {
  try {
    return origins.has(new URL(url).origin) && tourOnSignInRoute(url, route);
  } catch { return false; }
}

const HUMAN_CHECK = 'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], [data-sitekey], .g-recaptcha, .h-captcha, .cf-turnstile';
const humanCheck = async (page: Page) => (await page.locator(HUMAN_CHECK).count().catch(() => 0)) > 0;
async function codeBox(page: Page): Promise<Locator | null> {
  const otp = page.locator('input[autocomplete="one-time-code"]').filter({ visible: true });
  if (await otp.count().catch(() => 0) === 1) return otp;
  const numeric = page.locator('input[inputmode="numeric"]').filter({ visible: true });
  return await numeric.count().catch(() => 0) === 1 ? numeric : null;
}
/** Real typing: fill fires input events; a box that rejects it is typed key by key. */
async function typeInto(box: Locator, value: string): Promise<void> {
  await box.fill(value);
  if (await box.inputValue() !== value) { await box.fill(""); await box.pressSequentially(value); }
  if (await box.inputValue() !== value) throw new TourCaptureFailure({ message: "The sign-in box didn't take what was typed, so recording stopped.", guidance: "Check the sign-in's username and password targets, then record again. If they are right, tell the user; never change the app." });
}
const HUMAN_FAILURE = { message: TOUR_SIGN_IN_HUMAN, guidance: "Nothing was sent to the site. Tell the user: this site needs a person to sign in. Never try to get around the check or sign in another way." };
const LANDED_FAILURE = { message: TOUR_SIGN_IN_LANDED, guidance: "The login worked: the sign-in form went away, and the tour keeps the login, so the next run signs in without asking. Choose signIn.signedIn from a control every signed-in page shows (the app's home link in its header, say), not one only some pages show, matched as it appears after sign-in: the app's language may differ from the sign-in page's. Each nearby entry is a ready-to-use target on the page the app landed on (record_tour look lists more); then run the dry run again. Never sign in to the app another way." };
const WRONG_FAILURE = { message: TOUR_SIGN_IN_WRONG, guidance: "Nothing else was sent to the site, and the details were forgotten. Tell the user the login didn't work and ask for the right one; never sign in to the app another way." };

/**
 * One sign-in on this page: ask for the login, type it, submit once through the scoped exception, and
 * wait until the signed-in control shows (or a code is asked for, or a human check appears). One
 * attempt: wrong details fail, never retried.
 */
async function signInHere(page: Page, origin: string, conf: NonNullable<TourAttemptInput["script"]["signIn"]>, origins: Set<string>, setWindow: (w: { nonGetLeft: number; closesAt: number } | null) => void, assertSafe: () => void): Promise<void> {
  // Whatever the page did by itself on load (a submit of its own) is judged before the window opens.
  await page.waitForLoadState("load", { timeout: 6000 }).catch(() => {});
  assertSafe();
  if (await humanCheck(page)) throw new TourCaptureFailure({ ...HUMAN_FAILURE, blockedOrigin: origin });
  // Before asking for a login and again once it comes: boxes gone with the signed-in control showing is signed in.
  if (await boxesGone(page, conf, origin)) return;
  const login = await askSignIn(origin, conf.account ? ["account", "username", "password"] : ["username", "password"]);
  assertSafe();
  if (await boxesGone(page, conf, origin)) return;
  if (!login.username || !login.password || (conf.account ? !login.account : login.account !== undefined)) throw new TourCaptureFailure({ ...WRONG_FAILURE, blockedOrigin: origin });
  // An account box a site pre-fills (from its address, say) is cleared, then typed first.
  if (conf.account) { const box = await uniqueTourTarget(page, conf.account); await box.fill(""); await typeInto(box, login.account!); }
  const user = await uniqueTourTarget(page, conf.username), pass = await uniqueTourTarget(page, conf.password);
  await typeInto(user, login.username); await typeInto(pass, login.password);
  const submit = async (form: Locator, click: () => Promise<void>) => {
    await form.evaluate(el => window.__sovaTourAllowSubmit?.(el.closest("form")));
    assertSafe();
    setWindow({ nonGetLeft: 4, closesAt: Date.now() + 15_000 });
    try { await click(); return await outcome(page, conf, origins); }
    finally { setWindow(null); }
  };
  let result = await submit(pass, async () => (await uniqueTourTarget(page, conf.submit)).click());
  assertSafe();
  if (result === "code") {
    const { code } = await askSignIn(origin, ["code"]);
    const box = await codeBox(page);
    if (!code || !box) throw new TourCaptureFailure({ ...WRONG_FAILURE, blockedOrigin: origin });
    await typeInto(box, code);
    result = await submit(box, () => box.press("Enter"));
    assertSafe();
    if (result === "code") result = "wrong";
  }
  if (result === "human") throw new TourCaptureFailure({ ...HUMAN_FAILURE, blockedOrigin: origin });
  if (result === "wrong") throw new TourCaptureFailure({ ...WRONG_FAILURE, blockedOrigin: origin });
  if (result === "landed") {
    const named = conf.signedIn.kind === "role" ? conf.signedIn.name : conf.signedIn.kind === "text" ? conf.signedIn.text : conf.signedIn.testId;
    throw new TourSignInFailure({ ...LANDED_FAILURE, blockedOrigin: origin, nearby: await tourNearby(page, named, conf.signedIn.kind, conf.signedIn.kind === "role" ? conf.signedIn.role : undefined).catch(() => []) });
  }
}
/**
 * True when the sign-in boxes are gone and the signed-in control shows (nothing to type: signed in). Gone with
 * no signed-in control stops as a sign-in failure naming the route. False while every box is still there.
 */
async function boxesGone(page: Page, conf: NonNullable<TourAttemptInput["script"]["signIn"]>, origin: string): Promise<boolean> {
  const count = (t: TourTarget) => tourLocator(page, t).filter({ visible: true }).count().catch(() => 0);
  const boxes = [...(conf.account ? [conf.account] : []), conf.username, conf.password];
  let gone = false;
  for (const box of boxes) if (await count(box) === 0) gone = true;
  if (!gone) return false;
  if (await count(conf.signedIn) > 0) return true;
  throw new TourSignInFailure({ message: `The sign-in page ${conf.route} stopped showing its sign-in boxes, so recording stopped.`, guidance: "Nothing was typed. The page drew its sign-in form, then took it away without showing signIn.signedIn. Check signIn.route, its boxes and signIn.signedIn against what that page shows (record_tour look lists it); if they are right, tell the user. Never change the app or sign in to it another way.", blockedOrigin: origin });
}
/**
 * After the submit: signed in once the signed-in control shows; a code box or a human check as they appear. When
 * none shows within 15 s, the details were wrong only while the page still shows the password box on the
 * sign-in route (or beside a visible alert); with the box gone or the route left, the login worked and only
 * signIn.signedIn is off ("landed": the login is kept, §app.tours/recording).
 */
async function outcome(page: Page, conf: NonNullable<TourAttemptInput["script"]["signIn"]>, origins: Set<string>): Promise<"signed" | "code" | "human" | "wrong" | "landed"> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if (await tourLocator(page, conf.signedIn).filter({ visible: true }).count() === 1) return "signed";
      if (await humanCheck(page)) return "human";
      if (await codeBox(page)) return "code";
    } catch { /* a navigation in progress */ }
    await new Promise(r => setTimeout(r, 250));
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 3000 }).catch(() => {});
  const visible = (t: TourTarget) => tourLocator(page, t).filter({ visible: true }).count().catch(() => 0);
  const form = await visible(conf.password) > 0;
  if (!form) return "landed";
  if (onSignInRoute(page.url(), conf.route, origins)) return "wrong";
  return await page.getByRole("alert").filter({ visible: true }).count().catch(() => 0) > 0 ? "wrong" : "landed";
}
/** Every visible password box, every username box (autocomplete=username, the sign-in's own) and the sign-in's account box, as viewport boxes. */
async function loginBoxes(page: Page, named: (Parameters<typeof tourLocator>[1] | undefined)[]): Promise<{ x: number; y: number; width: number; height: number }[]> {
  const boxes = await page.evaluate(() => [...document.querySelectorAll('input[type="password"], input[autocomplete="username"]')].map(el => el.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0).map(r => ({ x: r.x, y: r.y, width: r.width, height: r.height })));
  for (const target of named) if (target) for (const box of await tourLocator(page, target).filter({ visible: true }).all()) { const b = await box.boundingBox(); if (b && b.width > 0 && b.height > 0) boxes.push(b); }
  return boxes;
}
