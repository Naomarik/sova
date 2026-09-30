// `pnpm org-charts rebuild --verify <org> [--workspace <dir>]`: replay every session's transition log
// on the current charts and list each whose states, links, timers or holds differ from its snapshot
// (server/org-host/rebuild.ts). Reads only; exit 1 when a session differs, 2 on a usage error.
// There is no plain rebuild (operator ruling r9): the log never holds message text, contact values
// or About text, so a session can't be restored from it.
import { formatReport, verifyOrg } from "../server/org-host/rebuild";
import { stateRoot } from "../server/state-root";

const USAGE = "usage: org-charts rebuild --verify <org> [--workspace <dir>]";

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd !== "rebuild") {
    console.error(USAGE);
    return 2;
  }
  const verify = rest.includes("--verify");
  const w = rest.indexOf("--workspace");
  const workspace = w >= 0 ? rest[w + 1] : undefined;
  const orgId = rest.filter((a, i) => !a.startsWith("--") && !(w >= 0 && i === w + 1))[0];
  if (!verify) {
    console.error("Only `rebuild --verify` exists: the log holds no message text, contact values or About text, so it can't restore a session.");
    return 2;
  }
  if (!orgId || (w >= 0 && !workspace)) {
    console.error(USAGE);
    return 2;
  }
  // the attach index names the org's workspace (loaded only when it isn't given)
  const workspaceDir = workspace ?? (await import("../server/orgs")).orgDir(orgId);
  const report = verifyOrg({ orgId, workspaceDir, stateDir: stateRoot() });
  console.log(formatReport(report));
  return report.differing.length || report.problems.length ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
