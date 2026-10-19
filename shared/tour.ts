/** Versioned, harness-neutral tour authoring and presentation contracts. */
export const RECORD_TOUR_TOOL = "record_tour";
export const SHOW_TOUR_TOOL = "show_tour";
export const TOUR_TOOLS: ReadonlySet<string> = new Set([RECORD_TOUR_TOOL, SHOW_TOUR_TOOL]);
export const TOUR_ATTACHMENT_ENTRY = "sova-tour-attachment";
export const TOUR_DETACHMENT_ENTRY = "sova-tour-detachment";
/** A record request whose login value also appears in what the tour would write (§app.tours/recording). */
export const TOUR_CREDENTIALS_IN_SCRIPT = "A sign-in detail appears in the tour itself (a username that also appears in a route counts). Keep logins only in credentials.";
export const TOUR_SIZES = ["desktop", "phone"] as const;
export type TourSize = (typeof TOUR_SIZES)[number];
export const TOUR_LIMITS = Object.freeze({ steps: 40, views: 8, chapters: 12, actions: 30, marks: 6, masks: 12, scriptBytes: 262_144, assetBytes: 15 * 1024 * 1024, totalBytes: 256 * 1024 * 1024, assets: 672 });
export const TOUR_VIEWPORTS = Object.freeze({ desktop: { w: 1440, h: 960 }, phone: { w: 390, h: 844 } });
export type TourSource =
  | { kind: "project"; projectId: string; instanceId: string; checkout: string; serviceId: string; endpoint: string }
  | { kind: "site"; origin: string };
/**
 * A source as an agent may name it: a project's running copy by its instance, service and endpoint
 * alone. The server derives projectId and the canonical checkout from its own registry (a supplied one
 * must match exactly) and stores the full TourSource; nothing downstream sees this form.
 */
export type TourSourceRequest =
  | { kind: "project"; instanceId: string; serviceId: string; endpoint: string; projectId?: string; checkout?: string }
  | { kind: "site"; origin: string };
export type TourTarget = { kind: "role"; role: string; name: string } | { kind: "text"; text: string } | { kind: "testId"; testId: string };
/** `reveal` scrolls whichever containers hold its target until it is fully on screen (§app.tours/recording); `scroll` moves the page itself only. */
export type TourAction = { op: "open"; target: TourTarget } | { op: "fill"; target: TourTarget; value: string } | { op: "scroll"; x: number; y: number } | { op: "wait"; target: TourTarget } | { op: "reveal"; target: TourTarget };
export const TOUR_ACTION_OPS = ["open", "fill", "wait", "reveal", "scroll"] as const;
export interface TourComparison { group: string; phase: "before" | "after" }
export interface TourScriptMark { target: TourTarget; label: string; side: "left" | "right" | "top" | "bottom" }
export interface TourChapter { id: string; title: string }
interface TourScriptViewBase { id: string; title: string; note: string; comparison?: TourComparison }
export type TourScriptView = TourScriptViewBase & (
  | { kind: "page"; route: string; sizes: TourSize[]; unavailableReason?: string; actions: Partial<Record<TourSize, TourAction[]>>; marks: TourScriptMark[]; masks: TourTarget[] }
  | { kind: "reference"; reference: string }
);
export interface TourScriptStep { id: string; chapter: string; title: string; summary: string; views: TourScriptView[] }
/**
 * A form sign-in the recorder may perform (§app.tours/recording): the sign-in page's route on the source,
 * the username and password boxes (by role or test id only, so no login value can sit in a script), optionally
 * an `account` box a site asks for before the username (cleared first: a site may pre-fill it), the submit
 * control and a control visible only once signed in. `origins`: the exact origins the sign-in may send to
 * (default: the source's own), counted as declared sites. Never an account, username, password or code.
 */
export interface TourSignIn { route: string; account?: TourTarget; username: TourTarget; password: TourTarget; submit: TourTarget; signedIn: TourTarget; origins?: string[] }
/**
 * A login supplied beside a script (record_tour `credentials`), per sign-in origin. It lives only in the
 * per-tour memory store: never in a script, job, attempt, edition, report, log or tool result.
 */
export type TourCredentials = Record<string, { account?: string; username: string; password: string; code?: string }>;
export const TOUR_CREDENTIAL_LIMITS = Object.freeze({ origins: 4, account: 512, username: 512, password: 4096, code: 64 });
/** What every view of record_tour's arguments shows in place of supplied credentials. */
export const TOUR_HIDDEN = "[hidden]";
export interface TourScript {
  v: 1; title: string; summary: string; audience: string; outcome: string; source: TourSource;
  /** Additional exact origins needed for declared subresources, redirects or popups. */
  sites?: string[];
  /** An opaque test-account reference. Passwords and storage state never belong here. */
  accountId?: string;
  /** A form sign-in (§app.tours/recording); a managed Sova copy refuses it (its sign-in is its cookie). */
  signIn?: TourSignIn;
  chapters: TourChapter[]; steps: TourScriptStep[];
}
/** A script as an agent authors it (record_tour dry-run): only its source differs from a stored one. */
export type TourScriptRequest = Omit<TourScript, "source"> & { source: TourSourceRequest };
export interface TourMark { n: number; x: number; y: number; w: number; h: number; side: "left" | "right" | "top" | "bottom"; label: string }
export interface TourCapture { image: string; marks: TourMark[] }
export interface TourView {
  id: string; title: string; kind: "page" | "reference"; note: string; route: string | null;
  reference?: string; comparison?: TourComparison; unavailableReason?: string;
  captures: Partial<Record<TourSize, TourCapture>>;
}
export interface TourStep { n: number; id: string; chapter: string; title: string; summary: string; views: TourView[] }
export interface TourAsset { file: string; mime: "image/png"; bytes: number; sha256: string }
export interface TourVerification { overviewReviewed: true; suspiciousCapturesReviewed: string[]; notes: string }
export interface TourCheck extends TourVerification { status: "passed"; checkedAt: string; dryRun: true; captureCount: number; contactSheets: string[] }
/** Safe presentation data, also consumed by the shared owner/public viewer. No source or account. */
export interface TourPresentation {
  v: 2; id: string; editionId: string; title: string; summary: string;
  viewports: Record<TourSize, { w: number; h: number }>; recordedAt: string;
  chapters: TourChapter[]; steps: TourStep[]; assets: TourAsset[];
}
export interface TourManifest extends TourPresentation { scriptDigest: string; check: TourCheck }
/** Authorized storage only. Never send this wrapper to the shared viewer or an outsider. */
export interface TourEdition {
  v: 1; sessionId: string; source: TourSource; manifest: TourManifest;
  /** `signedIn`: recorded after a form sign-in of its tour; it stays in its chat (no share, no hand-off). */
  provenance: { origin: string; recordedAt: string; generation?: number; publicOrigins?: string[]; signedIn?: true };
}
export type TourPublicManifest = TourPresentation;
export const TOUR_JOB_PHASES = ["queued", "needs-site-approval", "needs-test-account", "needs-sign-in", "dry-run", "recording", "checking", "ready", "failed", "cancelled", "interrupted"] as const;
export type TourJobPhase = (typeof TOUR_JOB_PHASES)[number];
/** A control near a failing target, as a target the script can use, and how many visible controls it matches now. */
export interface TourNearby { target: TourTarget; matches: number }
/** Where a dry-run problem happened: `action` is the index in that size's actions; none means a mark or mask. */
export interface TourProblemPlace { stepId: string; viewId: string; size: TourSize; action?: number }
/** One group of identical dry-run problems (same message, target and match count), with up to 8 of its places; `count` when there were more. */
export interface TourProblem { message: string; guidance: string; at: TourProblemPlace[]; count?: number; target?: TourTarget; matches?: number; nearby?: TourNearby[] }
export const TOUR_PROBLEM_LIMITS = Object.freeze({ problems: 12, places: 8, nearby: 8 });
/** `nearest`: names only, from recorders before `nearby`; still read. `problems`/`more`: a dry run's full report. */
export interface TourFailure { message: string; guidance: string; stepId?: string; viewId?: string; size?: TourSize; action?: number; target?: TourTarget; matches?: number; nearest?: string[]; nearby?: TourNearby[]; problems?: TourProblem[]; more?: number; blockedOrigin?: string }
export interface TourJob {
  v: 1; id: string; tourId: string; sessionId: string; title: string; phase: TourJobPhase;
  completed: number; total: number; queuePosition?: number; stepId?: string; viewId?: string; size?: TourSize;
  failure?: TourFailure; editionId?: string; createdAt: string; updatedAt: string;
  requirements?: { origins?: string[]; testAccount?: { origin: string; kind: "http-basic"; reason?: string }; signIn?: TourSignInRequirement };
  /** Writes the page sent by itself that this job stopped quietly (never reaching the site). */
  quietAborts?: number;
}
/** What a recording waiting in `needs-sign-in` asks for: a username and password (after an account, when the
    script declares an account box), or a one-time code. */
export interface TourSignInRequirement { origin: string; kind: "form"; fields: ["username", "password"] | ["account", "username", "password"] | ["code"]; reason?: string }
/** The only eagerly retained tour-tool result. All authoring input/report/images are separate. */
export interface TourCardDetails {
  v: 1; tourId: string; title: string; steps: number; status: TourJobPhase;
  jobId?: string; editionId?: string; cover?: string;
}
export type ShowTourDetails = TourCardDetails;
export interface TourProgress { v: 1; tourId: string; editionId: string; stepId: string; viewId: string; size: TourSize; updatedAt: string }
export interface TourAttachment { v: 1; handle: string; title: string; summary: string; steps: number; edition: string; files: string[] }
export interface TourDetachment { v: 1; handle: string }

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) => Object.keys(v).every(k => allowed.includes(k));
const shape = (v: unknown, allowed: readonly string[]): v is Record<string, unknown> => object(v) && keys(v, allowed);
const text = (v: unknown, max = 4000): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v);
const note = (v: unknown, max = 4000): v is string => v === "" || text(v, max);
const int = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const num = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const list = (v: unknown, max: number): v is unknown[] => Array.isArray(v) && v.length <= max;
const date = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) && Number.isFinite(Date.parse(v));
const hash = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const size = (v: unknown): v is TourSize => TOUR_SIZES.includes(v as TourSize);
const side = (v: unknown) => ["left", "right", "top", "bottom"].includes(String(v));
const copy = <T>(v: unknown): T => JSON.parse(JSON.stringify(v)) as T;
const safe = <T>(v: unknown, check: (x: unknown) => boolean): T | undefined => { try { return check(v) ? copy<T>(v) : undefined; } catch { return undefined; } };
export const isTourId = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,99}$/.test(v);
export const isTourHandle = (v: unknown): v is string => typeof v === "string" && /^tr_[A-Za-z0-9_-]{16}$/.test(v);
export const isTourFile = (v: unknown): v is string => typeof v === "string" && /^[a-z0-9][a-z0-9-]{0,119}\.png$/.test(v);
const identity = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(v);
export function isTourOrigin(v: unknown): v is string {
  if (typeof v !== "string" || v.length > 2048) return false;
  try { const u = new URL(v); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && v === u.origin; } catch { return false; }
}
export function isTourRoute(v: unknown): v is string {
  if (typeof v !== "string" || !v.startsWith("/") || v.startsWith("//") || v.length > 2048 || /[\\\u0000-\u0020]/.test(v)) return false;
  try { const decoded = decodeURIComponent(v); return !/[\\\u0000-\u001f]/.test(decoded) && !decoded.startsWith("//") && !decoded.split(/[/?#]/).some(p => p === "." || p === ".."); } catch { return false; }
}
/**
 * `at` (a route, or a full address) is the sign-in page `route` names: the same path, and the same hash route
 * too when `route` names one ("/#/login"); a query never matters. The recorder matches pages this way.
 */
export function tourOnSignInRoute(at: string, route: string): boolean {
  try {
    const base = "http://route.invalid", u = new URL(at, base), want = new URL(route, base);
    return u.pathname === want.pathname && (!want.hash || u.hash.split("?")[0] === want.hash.split("?")[0]);
  } catch { return false; }
}
/** Why a page view on the sign-in route is refused: the recorder signs in there and never pictures it. */
export const tourSignInViewProblem = (at: string) => `${at} is the sign-in page; it is never pictured. The look lists it signed out; describe it in a reference view.`;
const checkoutOk = (v: unknown): v is string => text(v, 4096) && v.startsWith("/") && !v.split("/").some(p => p === "." || p === "..");
const SOURCE_FIELD_HINT: Record<string, string> = {
  instanceId: "the instance id the project's running-copy status reports",
  serviceId: "the service's name from that status (for example server)",
  endpoint: "the endpoint's name from that status (for example http), not a port number or URL",
};
/**
 * Why a tour source is unusable, naming the field and what it expects; null when it is fine. A request
 * (`resolved` false) may leave out projectId and checkout; a stored source (`resolved`) must carry both.
 */
export function tourSourceProblem(v: unknown, resolved = false): string | null {
  const shapes = `{kind:"project", instanceId, serviceId, endpoint} for a project's running copy, or {kind:"site", origin} for another site`;
  if (!object(v)) return `source must be an object: ${shapes}.`;
  if (v.kind === "site") {
    const extra = Object.keys(v).filter(k => k !== "kind" && k !== "origin");
    if (extra.length) return `source has a field a site source doesn't take: ${extra.join(", ")}. A site source is {kind:"site", origin}.`;
    return isTourOrigin(v.origin) ? null : "source.origin must be an exact http(s) origin such as https://example.test, with no path.";
  }
  if (v.kind !== "project") return `source.kind must be "project" or "site": ${shapes}.`;
  const extra = Object.keys(v).filter(k => !["kind", "projectId", "instanceId", "checkout", "serviceId", "endpoint"].includes(k));
  if (extra.length) return `source has a field a project source doesn't take: ${extra.join(", ")}. A project source is {kind:"project", instanceId, serviceId, endpoint}.`;
  for (const field of ["instanceId", "serviceId", "endpoint"] as const) {
    if (v[field] === undefined) return `source.${field} is required: ${SOURCE_FIELD_HINT[field]}.`;
    if (!identity(v[field])) return `source.${field} must be ${SOURCE_FIELD_HINT[field]}.`;
  }
  // The running-copy status lists ports as "<service>.<port>"; the source splits that pair.
  const dotted = String(v.endpoint).split(".");
  if (dotted.length === 2 && dotted.every(identity)) return `source.endpoint is the port's name alone: for "${v.endpoint}" use serviceId "${dotted[0]}" and endpoint "${dotted[1]}".`;
  if (v.projectId === undefined ? resolved : !identity(v.projectId)) return "source.projectId must be an id like prj_…, not a path; omit it and Sova fills it in.";
  if (v.checkout === undefined ? resolved : !checkoutOk(v.checkout)) return "source.checkout must be the copy's absolute canonical checkout path; omit it and Sova fills it in.";
  return null;
}
const sourceOk = (v: unknown): boolean => tourSourceProblem(v, true) === null;
const sourceRequestOk = (v: unknown): boolean => tourSourceProblem(v) === null;
export const normalizeTourSource = (v: unknown) => safe<TourSource>(v, sourceOk);
export const normalizeTourSourceRequest = (v: unknown) => safe<TourSourceRequest>(v, sourceRequestOk);
/** The roles a role target may name. */
export const TOUR_ROLES: readonly string[] = ["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "tab", "menuitem", "heading", "region", "dialog", "group", "list", "listitem", "status", "img", "cell", "columnheader", "row"];
const ROLES = TOUR_ROLES;
const targetOk = (v: unknown): boolean => {
  if (!object(v)) return false;
  if (v.kind === "role") return keys(v, ["kind", "role", "name"]) && ROLES.includes(String(v.role)) && text(v.name, 200);
  if (v.kind === "text") return keys(v, ["kind", "text"]) && text(v.text, 200);
  return v.kind === "testId" && keys(v, ["kind", "testId"]) && text(v.testId, 200);
};
export const normalizeTourTarget = (v: unknown) => safe<TourTarget>(v, targetOk);
/** A login box: by accessible role or test id, never by text (a text target could carry the value itself). */
const boxTargetOk = (v: unknown): boolean => object(v) && v.kind !== "text" && targetOk(v);
const SIGN_IN_KEYS = ["route", "account", "username", "password", "submit", "signedIn", "origins"] as const;
const SIGN_IN_REQUIRED = ["route", "username", "password", "submit", "signedIn"] as const;
const originsOk = (v: unknown, max: number): boolean => list(v, max) && v.length > 0 && v.every(isTourOrigin) && new Set(v).size === v.length;
/** Why a script's `signIn` is unusable, naming the field; null when it is fine. */
export function tourSignInProblem(v: unknown): string | null {
  const form = "signIn is {route, account?, username, password, submit, signedIn, origins?}";
  if (!object(v)) return `${form}.`;
  const extra = Object.keys(v).filter(k => !(SIGN_IN_KEYS as readonly string[]).includes(k));
  if (extra.length) return `signIn has ${extra.length === 1 ? "a field" : "fields"} it doesn't take: ${extra.slice(0, 5).map(echoKey).join(", ")}. ${form}; a login never goes in the script, only in credentials.`;
  const missing = SIGN_IN_REQUIRED.find(k => v[k] === undefined);
  if (missing) return `signIn needs ${missing}. ${form}.`;
  if (!isTourRoute(v.route)) return "signIn.route must be the sign-in page's path on the source, starting with /.";
  for (const box of ["account", "username", "password"] as const) {
    if (box === "account" && v.account === undefined) continue;
    if (object(v[box]) && v[box].kind === "text") return `signIn.${box} must name the box by role or testId, never by text.`;
    if (!boxTargetOk(v[box])) return `signIn.${box} must be a target {kind:"role", role, name} or {kind:"testId", testId}.`;
  }
  for (const control of ["submit", "signedIn"] as const) if (!targetOk(v[control])) return `signIn.${control} must be a target.`;
  if (v.origins !== undefined && !originsOk(v.origins, TOUR_CREDENTIAL_LIMITS.origins)) return `signIn.origins must list 1 to ${TOUR_CREDENTIAL_LIMITS.origins} different exact http(s) origins.`;
  return null;
}
const signInOk = (v: unknown): boolean => tourSignInProblem(v) === null;
/** The origins a script's sign-in may send to: its `origins`, else the source's own (given by the caller, once resolved). */
export const tourSignInOrigins = (signIn: TourSignIn, sourceOrigin: string): string[] => signIn.origins ? [...signIn.origins] : [sourceOrigin];
const login = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);
/**
 * Why supplied credentials are unusable, naming only the field and its origin (never a value); null when fine.
 * `allowed`: the script's sign-in origins when known (a site source, or explicit `signIn.origins`).
 */
export function tourCredentialsProblem(v: unknown, signIn: TourSignIn | undefined, allowed?: readonly string[]): string | null {
  if (!signIn) return "credentials need a signIn in the script: the sign-in page, its boxes and its submit control.";
  const shape = tourCredentialsShapeProblem(v, allowed);
  if (shape) return shape;
  for (const [origin, entry] of Object.entries(v as TourCredentials)) {
    if (signIn.account && entry.account === undefined) return `credentials for ${origin} need an account: the script's signIn declares an account box.`;
    if (!signIn.account && entry.account !== undefined) return `credentials for ${origin} carry an account, but the script's signIn declares no account box.`;
  }
  return null;
}
/** The shape alone (for `record`, whose script the runtime holds): origins, fields and lengths. */
export function tourCredentialsShapeProblem(v: unknown, allowed?: readonly string[]): string | null {
  if (!object(v)) return "credentials must be an object of sign-in origins, each {account?, username, password, code?}.";
  const origins = Object.keys(v);
  if (!origins.length || origins.length > TOUR_CREDENTIAL_LIMITS.origins) return `credentials must name 1 to ${TOUR_CREDENTIAL_LIMITS.origins} sign-in origins.`;
  for (const origin of origins) {
    if (!isTourOrigin(origin)) return "credentials are keyed by exact http(s) origins such as https://example.test; one of its keys isn't one.";
    if (allowed && !allowed.includes(origin)) return `credentials for ${origin}: that isn't one of this script's sign-in origins (${allowed.join(", ")}).`;
    const entry = v[origin];
    if (!object(entry)) return `credentials for ${origin} must be {account?, username, password, code?}.`;
    const extra = Object.keys(entry).filter(k => !["account", "username", "password", "code"].includes(k));
    if (extra.length) return `credentials for ${origin} take only account, username, password and code.`;
    if (entry.account !== undefined && (typeof entry.account !== "string" || !login(entry.account.trim(), TOUR_CREDENTIAL_LIMITS.account))) return `credentials for ${origin}: account must be 1 to ${TOUR_CREDENTIAL_LIMITS.account} characters.`;
    if (typeof entry.username !== "string" || !login(entry.username.trim(), TOUR_CREDENTIAL_LIMITS.username)) return `credentials for ${origin} need a username of 1 to ${TOUR_CREDENTIAL_LIMITS.username} characters.`;
    if (!login(entry.password, TOUR_CREDENTIAL_LIMITS.password)) return `credentials for ${origin} need a password of 1 to ${TOUR_CREDENTIAL_LIMITS.password} characters.`;
    if (entry.code !== undefined && !login(entry.code, TOUR_CREDENTIAL_LIMITS.code)) return `credentials for ${origin}: code must be 1 to ${TOUR_CREDENTIAL_LIMITS.code} characters.`;
  }
  return null;
}
/**
 * Supplied credentials, normalized (accounts and usernames trimmed), or undefined. Checks the shape and `allowed`; whether the
 * script has a signIn is tourCredentialsProblem's. Never log or persist the result.
 */
export function normalizeTourCredentials(v: unknown, allowed?: readonly string[]): TourCredentials | undefined {
  if (tourCredentialsShapeProblem(v, allowed) !== null) return undefined;
  const out: TourCredentials = {};
  for (const [origin, entry] of Object.entries(v as TourCredentials)) out[origin] = { ...(entry.account !== undefined ? { account: entry.account.trim() } : {}), username: entry.username.trim(), password: entry.password, ...(entry.code !== undefined ? { code: entry.code } : {}) };
  return out;
}
/**
 * `v` with record_tour's credentials hidden at any depth, in the two shapes a tool call takes on Sova's paths:
 * a message block `{type:"toolCall", name, arguments}` and a tool event `{toolName, args}`. `v` itself when
 * it holds none, so the common case copies nothing.
 */
export function hideTourCredentialsDeep<T>(v: T): T {
  if (Array.isArray(v)) {
    let out: unknown[] | null = null;
    v.forEach((x, i) => { const y = hideTourCredentialsDeep(x); if (y !== x) (out ??= v.slice())[i] = y; });
    return (out ?? v) as T;
  }
  if (!object(v)) return v;
  let out: Record<string, unknown> | null = null;
  if (v.type === "toolCall" && v.name === RECORD_TOUR_TOOL && v.arguments !== undefined) { const a = redactTourToolArgs(RECORD_TOUR_TOOL, v.arguments); if (a !== v.arguments) out = { ...v, arguments: a }; }
  if (v.toolName === RECORD_TOUR_TOOL && v.args !== undefined) { const a = redactTourToolArgs(RECORD_TOUR_TOOL, v.args); if (a !== v.args) (out ??= { ...v }).args = a; }
  for (const [k, x] of Object.entries(out ?? v)) {
    if (k === "arguments" || k === "args") continue;
    const y = hideTourCredentialsDeep(x);
    if (y !== x) (out ??= { ...v })[k] = y;
  }
  return (out ?? v) as T;
}
/** record_tour's arguments as every view shows them: supplied credentials replaced by "[hidden]". */
export function redactTourToolArgs(name: unknown, args: unknown): unknown {
  if (name !== RECORD_TOUR_TOOL || !object(args) || !("credentials" in args)) return args;
  return { ...args, credentials: TOUR_HIDDEN };
}
const actionOk = (v: unknown): boolean => {
  if (!object(v)) return false;
  if (v.op === "scroll") return keys(v, ["op", "x", "y"]) && int(v.x, -10000, 10000) && int(v.y, -10000, 10000);
  if (v.op === "fill") return keys(v, ["op", "target", "value"]) && targetOk(v.target) && note(v.value, 1000);
  return ["open", "wait", "reveal"].includes(String(v.op)) && keys(v, ["op", "target"]) && targetOk(v.target);
};
const comparisonOk = (v: unknown): boolean => shape(v, ["group", "phase"]) && isTourId(v.group) && ["before", "after"].includes(String(v.phase));
function chaptersOk(v: unknown): v is TourChapter[] { return list(v, TOUR_LIMITS.chapters) && v.length > 0 && v.every(c => shape(c, ["id", "title"]) && isTourId(c.id) && text(c.title, 200)) && new Set(v.map(c => (c as TourChapter).id)).size === v.length; }
function stepsOk(v: unknown, chapters: TourChapter[], viewOk: (x: unknown) => boolean, numbered: boolean): boolean {
  if (!list(v, TOUR_LIMITS.steps) || !v.length) return false;
  const ids = new Set<string>();
  return v.every((s, i) => {
    if (!shape(s, ["id", "chapter", "title", "summary", "views", ...(numbered ? ["n"] : [])]) || !isTourId(s.id) || ids.has(s.id) || !chapters.some(c => c.id === s.chapter) || !text(s.title, 200) || !text(s.summary) || !list(s.views, TOUR_LIMITS.views) || !s.views.length || (numbered && s.n !== i + 1)) return false;
    ids.add(s.id);
    return new Set(s.views.map(w => object(w) ? w.id : null)).size === s.views.length && s.views.every(viewOk);
  });
}
const scriptViewOk = (v: unknown): boolean => {
  if (!object(v) || !isTourId(v.id) || !text(v.title, 200) || !note(v.note) || (v.comparison !== undefined && !comparisonOk(v.comparison))) return false;
  const base = ["id", "title", "note", "comparison", "kind"];
  if (v.kind === "reference") return keys(v, [...base, "reference"]) && text(v.reference, 10000);
  if (v.kind !== "page" || !keys(v, [...base, ...PAGE_VIEW_REQUIRED, "unavailableReason"]) || !isTourRoute(v.route) || !list(v.sizes, 2) || !v.sizes.length || !v.sizes.every(size) || new Set(v.sizes).size !== v.sizes.length || (v.sizes.length === 1 ? !text(v.unavailableReason, 300) : v.unavailableReason !== undefined)) return false;
  if (!object(v.actions) || !keys(v.actions, v.sizes as string[]) || !Object.values(v.actions).every(a => list(a, TOUR_LIMITS.actions) && a.every(actionOk))) return false;
  return list(v.marks, TOUR_LIMITS.marks) && v.marks.every(m => shape(m, ["target", "label", "side"]) && targetOk(m.target) && text(m.label, 300) && side(m.side)) && (v.masks === undefined || list(v.masks, TOUR_LIMITS.masks) && v.masks.every(targetOk));
};
/** A page view's masks may be left out (none): the stored script always holds the list. Never changes `v`. */
function withMasks(v: unknown): unknown {
  if (!object(v) || !Array.isArray(v.steps) || !v.steps.some(s => object(s) && Array.isArray(s.views) && s.views.some(w => object(w) && w.kind === "page" && w.masks === undefined))) return v;
  return { ...v, steps: v.steps.map(s => !object(s) || !Array.isArray(s.views) ? s : { ...s, views: s.views.map(w => object(w) && w.kind === "page" && w.masks === undefined ? { ...w, masks: [] } : w) }) };
}
/** The fields a script takes, and the fields every page view needs: the validator and its named errors share them. */
const SCRIPT_KEYS = ["v", "title", "summary", "audience", "outcome", "source", "sites", "accountId", "signIn", "chapters", "steps"] as const;
const PAGE_VIEW_REQUIRED = ["route", "sizes", "actions", "marks", "masks"] as const;
const scriptOk = (source: (v: unknown) => boolean) => (x: unknown): boolean => {
  if (!shape(x, SCRIPT_KEYS) || x.v !== 1 || !text(x.title, 200) || ![x.summary, x.audience, x.outcome].every(t => text(t)) || !source(x.source) || !chaptersOk(x.chapters)) return false;
  if (x.sites !== undefined && (!list(x.sites, 16) || !x.sites.every(isTourOrigin) || new Set(x.sites).size !== x.sites.length)) return false;
  if (x.signIn !== undefined && !signInOk(x.signIn)) return false;
  return (x.accountId === undefined || identity(x.accountId)) && stepsOk(x.steps, x.chapters, scriptViewOk, false) && new TextEncoder().encode(JSON.stringify(x)).byteLength <= TOUR_LIMITS.scriptBytes;
};
/** The first page view whose route is the script's sign-in page, named by place, or null. */
function signInViewPlace(x: unknown): string | null {
  if (!object(x) || !object(x.signIn) || typeof x.signIn.route !== "string" || !Array.isArray(x.steps)) return null;
  for (const [i, step] of x.steps.entries()) if (object(step) && Array.isArray(step.views)) for (const [j, view] of step.views.entries())
    if (object(view) && view.kind === "page" && typeof view.route === "string" && tourOnSignInRoute(view.route, x.signIn.route)) return `${placeName("steps", i, step)} \u203a ${placeName("views", j, view)}`;
  return null;
}
/** A stored script: its source is the full, server-resolved identity. A sign-in-page view stored before that was refused still loads (the recorder stops it). */
export const normalizeTourScript = (v: unknown) => safe<TourScript>(withMasks(v), scriptOk(sourceOk));
/** A script as an agent authors it: a project source may leave out projectId and checkout. No page view is the sign-in page. */
export const normalizeTourScriptRequest = (v: unknown) => safe<TourScriptRequest>(withMasks(v), x => scriptOk(sourceRequestOk)(x) && !signInViewPlace(x));
/** A field name as an error may echo it: control characters dropped, at most 40 characters. */
const echoKey = (k: string): string => { const clean = k.replace(/[\u0000-\u001f\u007f]/g, ""); return clean.length > 40 ? `${clean.slice(0, 40)}…` : clean; };
/**
 * The named reason an authored script is unusable, or null when the validator would accept it. It names
 * the place (step and view by position and id) and the field at fault (§app.tours/authoring).
 */
export function tourScriptProblem(v: unknown): string | null {
  if (!object(v)) return null;
  const unknown = Object.keys(v).filter(k => !(SCRIPT_KEYS as readonly string[]).includes(k));
  if (unknown.length) {
    const named = unknown.slice(0, 5).map(echoKey).join(", ") + (unknown.length > 5 ? ` and ${unknown.length - 5} more` : "");
    return `The script has ${unknown.length === 1 ? "a field" : "fields"} it doesn't take: ${named}. A script takes ${SCRIPT_KEYS.join(", ")}; a view's fields (${PAGE_VIEW_REQUIRED.join(", ")}) belong on a view inside steps.`;
  }
  if (v.source === undefined) return "The script needs source: {kind:\"project\", instanceId, serviceId, endpoint} for a project's running copy, or {kind:\"site\", origin}.";
  const source = tourSourceProblem(v.source);
  if (source) return source;
  if (v.signIn !== undefined) { const signIn = tourSignInProblem(v.signIn); if (signIn) return signIn; }
  if (v.v !== 1) return "The script needs v: 1.";
  if (!text(v.title, 200)) return "title must be 1 to 200 characters.";
  for (const k of ["summary", "audience", "outcome"] as const) if (!text(v[k])) return `${k} must be 1 to 4000 characters of text.`;
  if (v.sites !== undefined && (!list(v.sites, 16) || !v.sites.every(isTourOrigin) || new Set(v.sites).size !== v.sites.length)) return "sites must list up to 16 different exact http(s) origins such as https://cdn.example, with no path.";
  if (v.accountId !== undefined && !identity(v.accountId)) return "accountId must be a stored test account's id; leave it out unless you were given one.";
  if (!list(v.chapters, TOUR_LIMITS.chapters) || !v.chapters.length) return `chapters must list 1 to ${TOUR_LIMITS.chapters} chapters, each {id, title}.`;
  const chapterIds = new Set<string>();
  for (const [i, c] of v.chapters.entries()) {
    if (!shape(c, ["id", "title"]) || !isTourId(c.id) || !text(c.title, 200)) return `chapters[${i}] must be {id, title}: an id of lowercase letters, digits and dashes, and a title of 1 to 200 characters.`;
    if (chapterIds.has(c.id)) return `chapters[${i}] has the id "${c.id}" again: chapter ids must be different.`;
    chapterIds.add(c.id);
  }
  if (!list(v.steps, TOUR_LIMITS.steps) || !v.steps.length) return `steps must list 1 to ${TOUR_LIMITS.steps} steps, each {id, chapter, title, summary, views}.`;
  const stepIds = new Set<string>();
  for (const [i, step] of v.steps.entries()) {
    const problem = stepProblem(step, i, chapterIds, stepIds);
    if (problem) return problem;
  }
  const signInView = signInViewPlace(v);
  if (signInView) return tourSignInViewProblem(signInView);
  if (new TextEncoder().encode(JSON.stringify(v)).byteLength > TOUR_LIMITS.scriptBytes) return `The script is over ${TOUR_LIMITS.scriptBytes / 1024} KiB. Split it into smaller tours.`;
  return null;
}
const kindOf = (v: unknown): string => v === null ? "null" : Array.isArray(v) ? "a list" : typeof v === "string" ? "a string" : typeof v === "number" ? "a number" : typeof v === "boolean" ? "a boolean" : "an object";
/** `steps[2] "billing"`: a place by position, and by id when it has a usable one. */
const placeName = (list: string, i: number, v: unknown): string => `${list}[${i}]${object(v) && isTourId(v.id) ? ` "${v.id}"` : ""}`;
const TARGET_FORM = `a target is {kind:"role", role, name}, {kind:"text", text} or {kind:"testId", testId}`;
function targetProblem(v: unknown, at: string): string | null {
  if (targetOk(v)) return null;
  if (object(v) && v.kind === "role" && !ROLES.includes(String(v.role))) return `${at}: role must be one of ${ROLES.join(", ")}.`;
  if (object(v) && ["role", "text", "testId"].includes(String(v.kind))) {
    const field = v.kind === "role" ? "name" : v.kind === "text" ? "text" : "testId";
    const extra = Object.keys(v).filter(k => !["kind", field, ...(v.kind === "role" ? ["role"] : [])].includes(k));
    if (extra.length) return `${at} has ${extra.length === 1 ? "a field" : "fields"} it doesn't take: ${extra.slice(0, 5).map(echoKey).join(", ")}; ${TARGET_FORM}.`;
    return `${at}: ${field} must be 1 to 200 characters.`;
  }
  return `${at}: ${TARGET_FORM}.`;
}
function stepProblem(step: unknown, i: number, chapters: Set<string>, ids: Set<string>): string | null {
  const at = placeName("steps", i, step);
  if (!object(step)) return `${at} is ${kindOf(step)}, not a step: a step is {id, chapter, title, summary, views}.`;
  const extra = Object.keys(step).filter(k => !["id", "chapter", "title", "summary", "views"].includes(k));
  if (extra.length) return `${at} has ${extra.length === 1 ? "a field" : "fields"} it doesn't take: ${extra.slice(0, 5).map(echoKey).join(", ")}. A step is {id, chapter, title, summary, views}.`;
  if (!isTourId(step.id)) return `${at} needs an id of lowercase letters, digits and dashes.`;
  if (ids.has(step.id)) return `${at} has the id "${step.id}" again: step ids must be different.`;
  ids.add(step.id);
  if (typeof step.chapter !== "string" || !chapters.has(step.chapter)) return `${at}: chapter must be the id of one of the script's chapters (${[...chapters].join(", ")}).`;
  if (!text(step.title, 200)) return `${at}: title must be 1 to 200 characters.`;
  if (!text(step.summary)) return `${at}: summary must be 1 to 4000 characters.`;
  if (!list(step.views, TOUR_LIMITS.views) || !step.views.length) return `${at}: views must list 1 to ${TOUR_LIMITS.views} views.`;
  const viewIds = new Set<string>();
  for (const [j, view] of step.views.entries()) {
    const problem = viewProblem(view, `${at} \u203a ${placeName("views", j, view)}`, viewIds);
    if (problem) return problem;
  }
  return null;
}
function viewProblem(view: unknown, at: string, ids: Set<string>): string | null {
  const page = `{id, title, kind:"page", note, route, sizes, actions, marks, masks}`, reference = `{id, title, kind:"reference", note, reference}`;
  if (!object(view)) return `${at} is ${kindOf(view)}, not a view: a view is ${page} or ${reference}.`;
  if (view.kind !== "page" && view.kind !== "reference") return `${at}: kind must be "page" or "reference".`;
  const allowed = ["id", "title", "note", "comparison", "kind", ...(view.kind === "page" ? [...PAGE_VIEW_REQUIRED, "unavailableReason"] : ["reference"])];
  const extra = Object.keys(view).filter(k => !allowed.includes(k));
  if (extra.length) return `${at} has ${extra.length === 1 ? "a field" : "fields"} a ${view.kind} view doesn't take: ${extra.slice(0, 5).map(echoKey).join(", ")}. A ${view.kind} view is ${view.kind === "page" ? page : reference}.`;
  if (!isTourId(view.id)) return `${at} needs an id of lowercase letters, digits and dashes.`;
  if (ids.has(view.id)) return `${at} has the id "${view.id}" again: view ids within a step must be different.`;
  ids.add(view.id);
  if (!text(view.title, 200)) return `${at}: title must be 1 to 200 characters.`;
  if (!note(view.note)) return `${at}: note must be text of at most 4000 characters ("" for none).`;
  if (view.comparison !== undefined && !comparisonOk(view.comparison)) return `${at}: comparison must be {group, phase:"before"|"after"}.`;
  if (view.kind === "reference") return text(view.reference, 10000) ? null : `${at}: reference must be 1 to 10000 characters.`;
  const missing = PAGE_VIEW_REQUIRED.find(k => k !== "masks" && view[k] === undefined);
  if (missing) return `${at} is a page view and needs ${missing}.`;
  if (!isTourRoute(view.route)) return `${at}: route must be a path on the source starting with /, such as /settings.`;
  if (!list(view.sizes, 2) || !view.sizes.length || !view.sizes.every(size) || new Set(view.sizes).size !== view.sizes.length) return `${at}: sizes must be ["desktop", "phone"], or one of them with an unavailableReason.`;
  if (view.sizes.length === 1 ? !text(view.unavailableReason, 300) : view.unavailableReason !== undefined) return view.sizes.length === 1 ? `${at} shows one size, so it needs unavailableReason: why the other size isn't pictured (1 to 300 characters).` : `${at} shows both sizes, so it takes no unavailableReason.`;
  if (!object(view.actions)) return `${at}: actions must be an object of lists per size, such as {"desktop": [], "phone": []}.`;
  const sizes = view.sizes as string[];
  const stray = Object.keys(view.actions).filter(k => !sizes.includes(k));
  if (stray.length) return `${at}: actions has ${stray.slice(0, 3).map(echoKey).join(", ")}, which isn't one of this view's sizes (${sizes.join(", ")}).`;
  for (const [sz, actions] of Object.entries(view.actions)) {
    if (!list(actions, TOUR_LIMITS.actions)) return `${at} \u203a actions.${sz} must be a list of at most ${TOUR_LIMITS.actions} actions.`;
    for (const [k, action] of actions.entries()) {
      const where = `${at} \u203a actions.${sz}[${k}]`;
      if (actionOk(action)) continue;
      if (!object(action) || !(TOUR_ACTION_OPS as readonly string[]).includes(String(action.op))) return `${where}: op must be one of ${TOUR_ACTION_OPS.join(", ")}.`;
      if (action.op === "scroll") return `${where}: scroll is {op:"scroll", x, y} with whole pixels from -10000 to 10000; to bring a target into view use {op:"reveal", target}.`;
      const fields = action.op === "fill" ? ["op", "target", "value"] : ["op", "target"];
      const extraA = Object.keys(action).filter(f => !fields.includes(f));
      if (extraA.length) return `${where} has ${extraA.length === 1 ? "a field" : "fields"} ${action.op} doesn't take: ${extraA.slice(0, 5).map(echoKey).join(", ")}. It is {${fields.join(", ")}}.`;
      const target = targetProblem(action.target, `${where}.target`);
      if (target) return target;
      return `${where}: value must be text of at most 1000 characters.`;
    }
  }
  if (!list(view.marks, TOUR_LIMITS.marks)) return `${at}: marks must be a list of at most ${TOUR_LIMITS.marks} marks.`;
  for (const [k, mark] of view.marks.entries()) {
    const where = `${at} \u203a marks[${k}]`;
    if (!shape(mark, ["target", "label", "side"])) return `${where} must be {target, label, side}.`;
    const target = targetProblem(mark.target, `${where}.target`);
    if (target) return target;
    if (!text(mark.label, 300)) return `${where}: label must be 1 to 300 characters.`;
    if (!side(mark.side)) return `${where}: side must be "left", "right", "top" or "bottom".`;
  }
  if (view.masks === undefined) return null;
  if (!list(view.masks, TOUR_LIMITS.masks)) return `${at}: masks must be a list of at most ${TOUR_LIMITS.masks} targets.`;
  for (const [k, mask] of view.masks.entries()) { const target = targetProblem(mask, `${at} \u203a masks[${k}]`); if (target) return target; }
  return null;
}
/** A mark's box as a published picture takes it: inside the picture, in fractions of its size. The recorder checks its marks with this too. */
export const tourMarkBoxFits = (v: { x: number; y: number; w: number; h: number }): boolean => boxOk(v as unknown as Record<string, unknown>);
const boxOk = (v: Record<string, unknown>) => [v.x, v.y, v.w, v.h].every(n => num(n, 0, 1)) && Number(v.w) > 0 && Number(v.h) > 0 && Number(v.x) + Number(v.w) <= 1.000001 && Number(v.y) + Number(v.h) <= 1.000001;
const captureOk = (v: unknown): boolean => shape(v, ["image", "marks"]) && isTourFile(v.image) && list(v.marks, TOUR_LIMITS.marks) && v.marks.every((m, i) => shape(m, ["n", "x", "y", "w", "h", "side", "label"]) && m.n === i + 1 && boxOk(m) && side(m.side) && text(m.label, 300));
const viewOk = (v: unknown): boolean => {
  if (!shape(v, ["id", "title", "kind", "note", "route", "reference", "comparison", "unavailableReason", "captures"]) || !isTourId(v.id) || !text(v.title, 200) || !note(v.note) || (v.comparison !== undefined && !comparisonOk(v.comparison)) || !shape(v.captures, TOUR_SIZES)) return false;
  if (v.kind === "reference") return v.route === null && text(v.reference, 10000) && v.unavailableReason === undefined && Object.keys(v.captures).length === 0;
  if (v.kind !== "page" || (v.route !== null && !isTourRoute(v.route)) || v.reference !== undefined || !Object.values(v.captures).every(captureOk)) return false;
  const count = Object.keys(v.captures).length;
  return count === 2 ? v.unavailableReason === undefined : count === 1 && text(v.unavailableReason, 300);
};
const assetOk = (v: unknown): v is TourAsset => shape(v, ["file", "mime", "bytes", "sha256"]) && isTourFile(v.file) && v.mime === "image/png" && int(v.bytes, 1, TOUR_LIMITS.assetBytes) && hash(v.sha256);
function presentationOk(v: unknown): v is TourPresentation {
  if (!object(v) || v.v !== 2 || !isTourId(v.id) || !isTourId(v.editionId) || !text(v.title, 200) || !text(v.summary) || !date(v.recordedAt) || !shape(v.viewports, TOUR_SIZES) || !TOUR_SIZES.every(k => shape((v.viewports as Record<string, unknown>)[k], ["w", "h"]) && int(((v.viewports as Record<string, any>)[k]).w, 240, 4096) && int(((v.viewports as Record<string, any>)[k]).h, 240, 4096)) || !chaptersOk(v.chapters) || !stepsOk(v.steps, v.chapters, viewOk, true) || !list(v.assets, TOUR_LIMITS.assets) || !v.assets.every(assetOk)) return false;
  const assets = v.assets as TourAsset[];
  if (new Set(assets.map(a => a.file)).size !== assets.length || assets.reduce((n, a) => n + a.bytes, 0) > TOUR_LIMITS.totalBytes) return false;
  const captures = (v.steps as TourStep[]).flatMap(s => s.views.flatMap(w => Object.values(w.captures).map(c => c.image)));
  return captures.every(f => assets.some(a => a.file === f));
}
const PRESENTATION_KEYS = ["v", "id", "editionId", "title", "summary", "viewports", "recordedAt", "chapters", "steps", "assets"];
export const normalizeTourPresentation = (v: unknown) => safe<TourPresentation>(v, x => shape(x, PRESENTATION_KEYS) && presentationOk(x));
export const normalizeTourVerification = (v: unknown) => safe<TourVerification>(v, x => shape(x, ["overviewReviewed", "suspiciousCapturesReviewed", "notes"]) && x.overviewReviewed === true && list(x.suspiciousCapturesReviewed, TOUR_LIMITS.assets) && x.suspiciousCapturesReviewed.every(isTourFile) && new Set(x.suspiciousCapturesReviewed).size === x.suspiciousCapturesReviewed.length && text(x.notes, 2000));
export const normalizeTourManifest = (v: unknown) => safe<TourManifest>(v, x => {
  if (!shape(x, [...PRESENTATION_KEYS, "scriptDigest", "check"]) || !presentationOk(x) || !hash(x.scriptDigest) || !shape(x.check, ["overviewReviewed", "suspiciousCapturesReviewed", "notes", "status", "checkedAt", "dryRun", "captureCount", "contactSheets"])) return false;
  const c = x.check;
  if (c.status !== "passed" || !date(c.checkedAt) || c.dryRun !== true || !normalizeTourVerification({ overviewReviewed: c.overviewReviewed, suspiciousCapturesReviewed: c.suspiciousCapturesReviewed, notes: c.notes })) return false;
  const captures = x.steps.flatMap(s => s.views.flatMap(w => Object.values(w.captures).map(a => a.image)));
  if (c.captureCount !== captures.length || !list(c.contactSheets, 32) || !c.contactSheets.every(isTourFile) || new Set(c.contactSheets).size !== c.contactSheets.length || (captures.length > 0 && !c.contactSheets.length) || !c.contactSheets.every(f => x.assets.some(a => a.file === f))) return false;
  const used = new Set([...captures, ...c.contactSheets]);
  return (c.suspiciousCapturesReviewed as string[]).every(f => captures.includes(f)) && x.assets.every(a => used.has(a.file));
});
export const normalizeTourEdition = (v: unknown) => safe<TourEdition>(v, x => shape(x, ["v", "sessionId", "source", "manifest", "provenance"]) && x.v === 1 && identity(x.sessionId) && sourceOk(x.source) && !!normalizeTourManifest(x.manifest) && shape(x.provenance, ["origin", "recordedAt", "generation", "publicOrigins", "signedIn"]) && (x.provenance.signedIn === undefined || x.provenance.signedIn === true) && isTourOrigin(x.provenance.origin) && date(x.provenance.recordedAt) && (x.provenance.generation === undefined || int(x.provenance.generation, 0)) && (x.provenance.publicOrigins === undefined || list(x.provenance.publicOrigins, 64) && x.provenance.publicOrigins.every(isTourOrigin) && new Set(x.provenance.publicOrigins).size === x.provenance.publicOrigins.length));
const nearbyOk = (v: unknown) => v === undefined || list(v, TOUR_PROBLEM_LIMITS.nearby) && v.every(n => shape(n, ["target", "matches"]) && targetOk(n.target) && int(n.matches, 0, 100000));
const placeOk = (v: unknown) => shape(v, ["stepId", "viewId", "size", "action"]) && isTourId(v.stepId) && isTourId(v.viewId) && size(v.size) && (v.action === undefined || int(v.action, 0, TOUR_LIMITS.actions));
const problemOk = (v: unknown) => shape(v, ["message", "guidance", "at", "count", "target", "matches", "nearby"]) && text(v.message, 2000) && text(v.guidance, 2000) && list(v.at, TOUR_PROBLEM_LIMITS.places) && v.at.length > 0 && v.at.every(placeOk) && (v.count === undefined || int(v.count, 1, 100000)) && (v.target === undefined || targetOk(v.target)) && (v.matches === undefined || int(v.matches, 0, 100000)) && nearbyOk(v.nearby);
const failureOk = (v: unknown) => shape(v, ["message", "guidance", "stepId", "viewId", "size", "action", "target", "matches", "nearest", "nearby", "problems", "more", "blockedOrigin"]) && text(v.message, 2000) && text(v.guidance, 2000) && (v.stepId === undefined || isTourId(v.stepId)) && (v.viewId === undefined || isTourId(v.viewId)) && (v.size === undefined || size(v.size)) && (v.action === undefined || int(v.action, 0, TOUR_LIMITS.actions)) && (v.target === undefined || targetOk(v.target)) && (v.matches === undefined || int(v.matches, 0, 100000)) && (v.nearest === undefined || list(v.nearest, 8) && v.nearest.every(n => text(n, 200))) && nearbyOk(v.nearby) && (v.problems === undefined || list(v.problems, TOUR_PROBLEM_LIMITS.problems) && v.problems.every(problemOk)) && (v.more === undefined || int(v.more, 1, 100000)) && (v.blockedOrigin === undefined || isTourOrigin(v.blockedOrigin));
const signInRequirementOk = (v: unknown): boolean => shape(v, ["origin", "kind", "fields", "reason"]) && isTourOrigin(v.origin) && v.kind === "form" && Array.isArray(v.fields) && v.fields.every(f => typeof f === "string" && !f.includes(",")) && ["username,password", "account,username,password", "code"].includes(v.fields.join()) && (v.reason === undefined || text(v.reason, 300));
/** A job's sign-in requirement goes with its `needs-sign-in` phase, both ways, and never beside a test-account one. */
const jobSignInOk = (x: Record<string, unknown>): boolean => {
  const signIn = object(x.requirements) ? x.requirements.signIn : undefined;
  if (x.phase !== "needs-sign-in") return signIn === undefined;
  return object(x.requirements) && x.requirements.testAccount === undefined && signInRequirementOk(signIn);
};
export const normalizeTourJob = (v: unknown) => safe<TourJob>(v, x => shape(x, ["v", "id", "tourId", "sessionId", "title", "phase", "completed", "total", "queuePosition", "stepId", "viewId", "size", "failure", "editionId", "createdAt", "updatedAt", "requirements", "quietAborts"]) && (x.quietAborts === undefined || int(x.quietAborts, 0, 1_000_000)) && jobSignInOk(x) && x.v === 1 && isTourId(x.id) && isTourId(x.tourId) && identity(x.sessionId) && text(x.title, 200) && TOUR_JOB_PHASES.includes(x.phase as TourJobPhase) && int(x.completed, 0, 10000) && int(x.total, x.completed as number, 10000) && (x.queuePosition === undefined || x.phase === "queued" && int(x.queuePosition, 1, 10000)) && (x.stepId === undefined || isTourId(x.stepId)) && (x.viewId === undefined || isTourId(x.viewId)) && (x.size === undefined || size(x.size)) && (x.failure === undefined || failureOk(x.failure)) && (x.editionId === undefined || isTourId(x.editionId)) && date(x.createdAt) && date(x.updatedAt) && (x.requirements === undefined || shape(x.requirements, ["origins", "testAccount", "signIn"]) && (x.requirements.origins === undefined || list(x.requirements.origins, 16) && x.requirements.origins.every(isTourOrigin) && new Set(x.requirements.origins).size === x.requirements.origins.length) && (x.requirements.testAccount === undefined || shape(x.requirements.testAccount, ["origin", "kind", "reason"]) && isTourOrigin(x.requirements.testAccount.origin) && x.requirements.testAccount.kind === "http-basic" && (x.requirements.testAccount.reason === undefined || text(x.requirements.testAccount.reason, 500)))));
export const normalizeTourCardDetails = (v: unknown) => safe<TourCardDetails>(v, x => shape(x, ["v", "tourId", "title", "steps", "status", "jobId", "editionId", "cover"]) && x.v === 1 && isTourId(x.tourId) && text(x.title, 200) && int(x.steps, 1, TOUR_LIMITS.steps) && TOUR_JOB_PHASES.includes(x.status as TourJobPhase) && (x.jobId === undefined || isTourId(x.jobId)) && (x.editionId === undefined || isTourId(x.editionId)) && (x.cover === undefined || isTourFile(x.cover)) && (x.status !== "ready" || isTourId(x.editionId)) && (x.cover === undefined || x.status === "ready"));
export const normalizeShowTourDetails = normalizeTourCardDetails;
export const normalizeTourProgress = (v: unknown) => safe<TourProgress>(v, x => shape(x, ["v", "tourId", "editionId", "stepId", "viewId", "size", "updatedAt"]) && x.v === 1 && [x.tourId, x.editionId, x.stepId, x.viewId].every(isTourId) && size(x.size) && date(x.updatedAt));
export function tourProgressFits(p: TourProgress, m: TourPresentation): boolean { return p.tourId === m.id && p.editionId === m.editionId && m.steps.some(s => s.id === p.stepId && s.views.some(v => v.id === p.viewId && (v.kind === "reference" || !!v.captures[p.size]))); }
export const normalizeTourAttachment = (v: unknown) => safe<TourAttachment>(v, x => shape(x, ["v", "handle", "title", "summary", "steps", "edition", "files"]) && x.v === 1 && isTourHandle(x.handle) && text(x.title, 200) && text(x.summary) && int(x.steps, 1, TOUR_LIMITS.steps) && isTourId(x.edition) && list(x.files, TOUR_LIMITS.assets) && x.files.every(isTourFile) && new Set(x.files).size === x.files.length);
export const normalizeTourDetachment = (v: unknown) => safe<TourDetachment>(v, x => shape(x, ["v", "handle"]) && x.v === 1 && isTourHandle(x.handle));
/** Field-by-field share projection: no source, routes, authoring/check notes or internal ids. */
export function projectTourPublic(m: TourManifest, ids: { id: string; editionId: string }): TourPublicManifest {
  const checked = normalizeTourManifest(m);
  if (!checked || !isTourId(ids.id) || !isTourId(ids.editionId)) throw new Error("Cannot project an invalid tour edition.");
  return { v: 2, id: ids.id, editionId: ids.editionId, title: checked.title, summary: checked.summary, viewports: copy(checked.viewports), recordedAt: checked.recordedAt, chapters: copy(checked.chapters), steps: checked.steps.map(s => ({ n: s.n, id: s.id, chapter: s.chapter, title: s.title, summary: s.summary, views: s.views.map(w => ({ id: w.id, title: w.title, kind: w.kind, note: w.note, route: null, ...(w.reference !== undefined ? { reference: w.reference } : {}), ...(w.comparison ? { comparison: copy<TourComparison>(w.comparison) } : {}), ...(w.unavailableReason ? { unavailableReason: w.unavailableReason } : {}), captures: copy(w.captures) })) })), assets: copy(checked.assets.filter(a => checked.steps.some(s => s.views.some(v => Object.values(v.captures).some(c => c.image === a.file))))) };
}
/** Authoring arguments are deliberately not an eager tool-row payload. */
export function tourCardArgs(v: unknown): Record<string, string> {
  if (!object(v)) return {};
  const out: Record<string, string> = {};
  for (const k of ["tourId", "editionId", "jobId", "dryRunId"]) if (isTourId(v[k])) out[k] = v[k] as string;
  if (typeof v.op === "string" && ["dry-run", "record", "status", "cancel", "inspect", "check"].includes(v.op)) out.op = v.op;
  return out;
}
export const tourUrl = (sessionId: string, id: string, editionId: string, file?: string) => `/api/tours/${encodeURIComponent(sessionId)}/${encodeURIComponent(id)}/editions/${encodeURIComponent(editionId)}${file ? `/assets/${encodeURIComponent(file)}` : ""}`;
