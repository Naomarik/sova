import type { OrgClaudeLogin } from "../shared/projects";
import { readAssignments, registerLoginUsers, updateAssignments } from "./claude-login-store";
import { readIndex, readOrg, readOrgOrPlaceholder } from "./orgs";
import { contributeProjectPart } from "./projects/contributions";

/**
 * An organization's Claude login for its projects (§app.claude-logins/project-login): kept host-local in
 * claude-login-assignments.json, never in the workspace repo. The org layer contributes it to the projects
 * it places (the project layer's `claudeLogin` part), so the project layer never reads an org.
 */

const isOrg = (id: string): boolean => readIndex().orgs.some((o) => o.id === id);

export function orgLoginView(orgId: string): OrgClaudeLogin {
  readOrg(orgId); // 404 for an org not here
  return { setting: readAssignments().orgs[orgId] ?? "none" };
}

/** Save the org's login for its projects ("none": no preference). The caller validated `value`. */
export function setOrgLogin(orgId: string, value: string): OrgClaudeLogin {
  readOrg(orgId);
  updateAssignments((a) => {
    if (value === "none") delete a.orgs[orgId];
    else a.orgs[orgId] = value;
  });
  return orgLoginView(orgId);
}

contributeProjectPart({
  claudeLogin(engine) {
    if (!isOrg(engine)) return null;
    const login = readAssignments().orgs[engine];
    return login ? { login, name: readOrgOrPlaceholder(engine).name } : null;
  },
});

// Settings → Accounts names the organizations that set a login for their projects.
registerLoginUsers(() => {
  const a = readAssignments();
  return readIndex().orgs.flatMap((o) => (a.orgs[o.id] ? [{ login: a.orgs[o.id]!, name: `Organization ${readOrgOrPlaceholder(o.id).name}` }] : []));
});
