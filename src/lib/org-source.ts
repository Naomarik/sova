// One org's page data (§app.organizations/org-page): polled while the tab shows, so a hand-off
// session that finishes or changes hands elsewhere updates its row without a reload; reconciled in
// place (lib/poll), so rows keep their identity and an open form survives a poll.
import type { OrgDetail } from "../../shared/orgs";
import { getOrg } from "./api";
import { createPoll, type Poll } from "./poll";

export const ORG_POLL_MS = 10_000;

export const createOrgSource = (id: string, fetchOrg: (id: string) => Promise<OrgDetail> = getOrg): Poll<OrgDetail> =>
  createPoll(() => fetchOrg(id), ORG_POLL_MS);
