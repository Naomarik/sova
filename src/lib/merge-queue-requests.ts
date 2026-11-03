// How a branch lands (merge locally, a GitHub pull request, a GitLab merge request, push the branch only) as words:
// the settings row, the request review before it is published (q10), the queue rows and the chat card's host states,
// and "Local main is N commits behind" (q11). Pure: no Solid, no DOM.
//
// The shapes are the queue's (shared/merge-queue.ts MergeRequestInfo, shared/merge-queue-hosts.ts HostFactsWire);
// LandHowSetting is the settings block's (shared/merge-queue-settings.ts).
import type { LandHow, MergeRequestInfo } from "../../shared/merge-queue";
import type { HostFactsWire, HostKind } from "../../shared/merge-queue-hosts";
import { settingsWaitingWords, type LandHowSetting } from "../../shared/merge-queue-settings";
export { LAND_HOWS } from "../../shared/merge-queue";
export type { HostKind, LandHow };
const sentence = (s: string): string => {
  const t = s.trim();
  return /[.!?…]$/.test(t) ? t : `${t}.`;
};

/** The settings row's facts: the way in effect, where it comes from, what origin suggests, the host's sign-in. */
export type { LandHowSetting };

/** The radio's words, in the order the row lists them. */
export const HOW_LABEL: Record<LandHow, string> = {
  local: "Merge locally",
  "github-pr": "Pull request on GitHub",
  "gitlab-mr": "Merge request on GitLab",
  "push-branch": "Push branch only",
};

/** The short form the "in effect" line uses. */
export const HOW_SHORT: Record<LandHow, string> = {
  local: "Merge locally",
  "github-pr": "Pull request",
  "gitlab-mr": "Merge request",
  "push-branch": "Push branch only",
};

/** One line under each choice: what Land does once Sova's checks and review pass. */
export const HOW_HINT: Record<LandHow, string> = {
  local: "Main moves to exactly the tested commit on this computer.",
  "github-pr": "Your branch is pushed and a pull request opens. You merge it on GitHub.",
  "gitlab-mr": "Your branch is pushed and a merge request opens. You merge it on GitLab.",
  "push-branch": "Your branch is pushed to origin. You open the request yourself.",
};

const FROM_WORD: Record<LandHowSetting["from"], string> = { computer: "this computer", project: "project file", default: "Sova's default" };

/** "Pull request · this computer, overrides project: Merge locally", "Merge locally · project file", "Merge locally · Sova's default". */
export function inEffectWords(s: Pick<LandHowSetting, "effective" | "from" | "project">): string {
  const head = `${HOW_SHORT[s.effective]} · ${FROM_WORD[s.from]}`;
  if (s.from === "computer") return `${head}, overrides project: ${HOW_SHORT[s.project ?? "local"]}`;
  return head;
}

/** "Suggested from origin: github.com"; null when origin suggests nothing new (no remote, unknown host, or already in effect). */
export function suggestionWords(s: Pick<LandHowSetting, "suggested" | "effective">): string | null {
  const g = s.suggested;
  if (!g || g.how === s.effective) return null;
  if (g.how === "local" && !g.why.trim()) return null;
  const why = g.why.trim().replace(/^suggested from origin:\s*/i, "");
  return `Suggested from origin: ${why || HOW_SHORT[g.how]}`;
}

/** "Push to origin" means something only when main moves on this computer. */
export const showsPushToOrigin = (how: LandHow | undefined): boolean => !how || how === "local";

/** The host a way of landing opens its request on. */
export const hostOf = (how: LandHow): HostKind | null => (how === "github-pr" ? "github" : how === "gitlab-mr" ? "gitlab" : null);

export const HOST_NAME: Record<HostKind, string> = { github: "GitHub", gitlab: "GitLab" };
/** "PR" on GitHub, "MR" on GitLab. */
export const REQUEST_NOUN: Record<HostKind, string> = { github: "PR", gitlab: "MR" };

/** The sign-in line under the row when the effective host isn't signed in: the adapter's own words (a11). */
export function signInWords(s: Pick<LandHowSetting, "effective" | "signIn">): string | null {
  const h = hostOf(s.effective);
  if (!h || !s.signIn || s.signIn.ok) return null;
  return s.signIn.why?.trim() || `Sign in to ${HOST_NAME[h]} on this computer first (${h === "github" ? "gh" : "glab"} auth login).`;
}

// ---- a request on the host ---------------------------------------------------------------------

/** What the host last said about a request. "not-reported" checks never read as passed. */
export type HostFacts = HostFactsWire;
/** An entry's request (or pushed branch) as the queue keeps it. */
export type RequestView = MergeRequestInfo;
export type RequestTextCheck = NonNullable<NonNullable<MergeRequestInfo["text"]>["checks"]>[number];

/** The entry states al_3 adds (contract §8). */
export type RequestState = "request-review" | "requested" | "pushed" | "closed";
export const REQUEST_STATES: readonly RequestState[] = ["request-review", "requested", "pushed", "closed"];
export const isRequestState = (s: string): s is RequestState => (REQUEST_STATES as readonly string[]).includes(s);

export type Tone = "success" | "warn" | "error" | "info" | "accent" | "neutral";
export interface HostChip {
  label: string;
  tone: Tone;
  live?: boolean;
}

/** "PR #123" on GitHub, "MR !7" on GitLab (GitLab numbers merge requests with "!"). */
export function requestRef(host: HostKind, n: number | undefined): string {
  const noun = REQUEST_NOUN[host];
  return n === undefined ? noun : `${noun} ${host === "gitlab" ? "!" : "#"}${n}`;
}

const hostOfReq = (p: Pick<RequestView, "how" | "host">): HostKind | null => p.host ?? hostOf(p.how);

type ReqFacts = Pick<RequestView, "how" | "host" | "number" | "url" | "facts" | "text" | "publishRequested">;

/** A request-review entry already on its way out: Publish was given (or Land Again / Push branch only publishes by
 *  itself) and the queue hasn't sent or refused it yet. The queue's own flag says so; nothing is inferred. */
export const requestOnItsWay = (state: string, p: Pick<RequestView, "publishRequested"> | undefined): boolean => state === "request-review" && p?.publishRequested === true;

/**
 * An entry past Sova's checks, as one chip. The host's facts read the most pressing first: merged, closed, conflicts,
 * host checks failed, changes requested, approved, then open with its checks.
 */
export function requestChip(state: RequestState | "landed", p: ReqFacts | undefined, reason?: string): HostChip {
  const host = p ? hostOfReq(p) : null;
  const H = host ? HOST_NAME[host] : "the host";
  switch (state) {
    case "request-review":
      // After Publish the entry waits here for the chat to go idle (its reason says so) until the request is created.
      return requestOnItsWay(state, p) ? { label: host ? `Opening the ${REQUEST_NOUN[host]}` : "Pushing the branch", tone: "accent", live: true } : { label: "Review the request", tone: "warn" };
    case "pushed":
      return { label: "Pushed", tone: "success" };
    case "closed":
      return { label: `Closed on ${H}`, tone: "neutral" };
    case "landed":
      return { label: "Landed", tone: "success" };
    case "requested":
      break;
  }
  const f = p?.facts;
  if (f?.state === "merged") return { label: "Landed", tone: "success" };
  if (f?.state === "closed") return { label: `Closed on ${H}`, tone: "neutral" };
  if (f?.mergeable === "conflicts") return { label: `Conflicts on ${H}`, tone: "warn" };
  if (f?.checks === "fail") return { label: "Host checks failed", tone: "error" };
  if (f?.review === "changes-requested") return { label: "Changes requested", tone: "warn" };
  if (f?.review === "approved") return { label: "Approved", tone: "success" };
  const draft = f ? f.state === "draft" : !!p?.text?.draft;
  const ref = `${draft ? "Draft " : ""}${host ? requestRef(host, p?.number) : "Request"} open`;
  if (!f || f.checks === "pending") return { label: `${ref} · checks running on ${H}`, tone: "info" };
  if (f.checks === "not-reported") return { label: `${ref} · no checks reported on ${H}`, tone: "info" };
  return { label: `${ref} · checks passed on ${H}`, tone: "info" };
}

/** The line under the chip: what it means for you, and what you can do. The queue's own reason wins while it has one. */
export function requestReason(state: RequestState | "landed", p: (ReqFacts & Pick<RequestView, "branch">) | undefined, target: string, reason?: string): string | null {
  const host = p ? hostOfReq(p) : null;
  const H = host ? HOST_NAME[host] : "origin";
  const f = p?.facts;
  const merged = `Merged on ${H}. Sova checked it merged with ${target}; ${H}'s merge is final.`;
  switch (state) {
    case "request-review":
      if (requestOnItsWay(state, p)) return !reason?.trim() || reason.trim() === "publishing" ? `Publishing to ${H}.` : reason.trim();
      // Not on its way: a reason is why Sova couldn't draft the text (no text), or why the last Publish didn't go.
      if (reason?.trim()) return p?.text ? `${sentence(reason)} Fix it, then publish again.` : `${sentence(reason)} Write the title and description yourself, then publish.`;
      return `Sova's checks passed. Read the title and description, then publish; nothing goes to ${H} until you do.`;
    case "pushed":
      return p ? `Pushed to origin as ${p.branch}. Open the request yourself.` : "Pushed to origin. Open the request yourself.";
    case "closed":
      return `Closed on ${H} without merging. Land Again opens it again with what the branch has now.`;
    case "landed":
      return host && p?.number !== undefined ? merged : null;
    case "requested":
      break;
  }
  if (!f) return `Opened on ${H}. The line moved on.`;
  if (f.state === "merged") return merged;
  if (f.state === "closed") return `Closed on ${H} without merging. Land Again opens it again with what the branch has now.`;
  if (f.mergeable === "conflicts") return `${H} says it no longer merges cleanly into ${target}. Send it back to its chat to fix.`;
  if (f.checks === "fail") return `${H}'s own checks failed. Sova's checks passed, so nobody is blamed: look on ${H}, or send it back to its chat.`;
  if (f.review === "changes-requested") return `A reviewer on ${H} asked for changes.`;
  if (f.review === "approved") return `Approved on ${H}. Merge it there when you're ready.`;
  return `Waiting on ${H}. You or your team merge it there.`;
}

/** What a request row offers. Every one is a merge verb or a link; none starts a chat turn by itself. */
export type RequestAction = "open-host" | "send-back" | "land-again" | "review";
export function requestActions(state: RequestState | "landed", p: ReqFacts | undefined, o: { newerCommits?: number; reason?: string } = {}): RequestAction[] {
  if (state === "request-review") return requestOnItsWay(state, p) ? [] : ["review"];
  const out: RequestAction[] = [];
  if (p?.url && hostOfReq(p)) out.push("open-host");
  const f = p?.facts;
  const open = state === "requested" && f?.state !== "merged" && f?.state !== "closed";
  if (open && (f?.mergeable === "conflicts" || f?.checks === "fail" || f?.review === "changes-requested")) out.push("send-back");
  if (state === "closed" || (state === "requested" && f?.state === "closed") || ((state === "requested" || state === "pushed") && o.newerCommits && f?.state !== "merged")) out.push("land-again");
  return out;
}

export function requestActionLabel(a: RequestAction, p: Pick<RequestView, "how" | "host"> | undefined): string {
  switch (a) {
    case "open-host": {
      const h = p ? hostOfReq(p) : null;
      return `Open on ${h ? HOST_NAME[h] : "the host"}`;
    }
    case "send-back":
      return "Send Back to Chat";
    case "land-again":
      return "Land Again";
    case "review":
      return "Review Request";
  }
}

// ---- the review before publishing (q10) ---------------------------------------------------------

/** "Publish Pull Request", "Publish Draft Merge Request": the primary button names exactly what goes out. */
export function publishLabel(how: Exclude<LandHow, "local">, draft: boolean): string {
  const noun = how === "gitlab-mr" ? "Merge Request" : how === "github-pr" ? "Pull Request" : "Branch";
  return `Publish ${draft ? "Draft " : ""}${noun}`;
}

/** Why Publish is held, or null. Only an empty title holds it: the words are yours, so a request folder check that
 *  failed is said beside them (requestChecksWords), never a lock. */
export function publishBlocked(title: string): string | null {
  return title.trim() ? null : "Give it a title first.";
}

/** "Written from .sova/playbooks/request · 3 checks passed", or Sova's plain default. */
export function requestChecksWords(folder: string | undefined, checks: readonly RequestTextCheck[] | undefined): string {
  const c = checks ?? [];
  if (!folder) return "No request folder: written in Sova's plain default.";
  if (c.length === 0) return `Written from ${folder}. It has no checks.`;
  const bad = c.filter((x) => !x.ok).length;
  const n = `${c.length} ${c.length === 1 ? "check" : "checks"}`;
  return bad === 0 ? `Written from ${folder} · ${n} passed` : `Written from ${folder} · ${bad} of ${n} failed`;
}

// ---- local main after a host merge (q11) --------------------------------------------------------

/** "Local main is 3 commits behind", with the target's own name; null when it isn't behind. */
export function behindWords(target: string, behind: number | undefined): string | null {
  if (!behind || behind <= 0) return null;
  return `Local ${target} is ${behind} ${behind === 1 ? "commit" : "commits"} behind`;
}

/** The Waiting on the host group's heading. */
export const waitingOnHostHead = (n: number): string => `Waiting on the host · ${n}`;

/** The tab's opening sentence: what happens to a branch after its checks, by the way in effect. */
export function introWords(target: string, how: LandHow | undefined): string {
  const head = `One branch at a time, in order. Each is merged onto ${target} in a separate copy and checked there; `;
  switch (how ?? "local") {
    case "local":
      return `${head}${target} then moves to exactly that commit.`;
    case "github-pr":
      return `${head}then its branch is pushed and a pull request opens on GitHub. You merge it there.`;
    case "gitlab-mr":
      return `${head}then its branch is pushed and a merge request opens on GitLab. You merge it there.`;
    case "push-branch":
      return `${head}then its branch is pushed to origin. You open the request yourself.`;
  }
}

/** A project-file save of How it lands that waits: the settings save's own words after the name. Pure. */
export const landHowWaitingWords = (how: LandHow, release?: string): string => `${HOW_SHORT[how]} saves to the project file ${settingsWaitingWords(release).replace(/^Saves /, "")}.`;
