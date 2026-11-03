/**
 * The wire words for a pull or merge request on its host (al_3), shared by the server's host adapters
 * (server/merge-queue/hosts/) and the queue's card and tab. Types only.
 */

export type HostKind = "github" | "gitlab";

export type RequestState = "open" | "draft" | "merged" | "closed";
/** The host's own checks. No check reported is "not-reported", never "pass". */
export type RequestChecks = "pending" | "pass" | "fail" | "not-reported";
export type RequestReview = "approved" | "changes-requested" | "review-required" | "none";
export type RequestMergeable = "mergeable" | "conflicts" | "unknown";

/** What the host last said about one request, as the queue stores and shows it. */
export interface HostFactsWire {
  state: RequestState;
  checks: RequestChecks;
  review: RequestReview;
  mergeable: RequestMergeable;
  /** The request's head commit on the host. */
  headSha?: string;
}
