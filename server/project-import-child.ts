// The import's world for its tests (project-import.test.ts) and the kill tests' child (project-import-kill.integration.test.ts):
// an org "Acme" with one project of its own placed, and a standalone project "Solo" with an overseer conversation,
// its log rows and a cost file, in a throwaway PI_CODING_AGENT_DIR (set by the caller before this module loads).
//
// As a child: `<root> import <step>` builds the world, then imports Solo with the step's hook SIGKILLing the
// process ("mark", "copy", "adopt", "place"); `<root> boot` starts as the server does (the roll-forward
// copy, the orgs, the standalone projects, the rest of the import) and prints the state as one JSON line.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export interface World {
  orgId: string;
  ws: string;
  otherId: string;
  soloId: string;
  soloDir: string;
  overseer: { id: string; path: string };
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" }).toString();

function repo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "hi\n");
  git(dir, "add", "README.md");
  git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return dir;
}

export async function buildWorld(root: string): Promise<World> {
  mkdirSync(join(root, "agent", "sessions", "live"), { recursive: true });
  const orgs = await import("./orgs");
  const { editProject, registerProjectIn } = await import("./projects/spaces");
  const { ensureProjectOverseer } = await import("./project-overseer");
  const { projectOverseerPaths } = await import("./project-overseer-store");
  const org = await orgs.createOrg({ name: "Acme", dir: join(root, "ws") });
  const other = await orgs.addProject(org.id, { name: "Other", root: repo(join(root, "other")) });
  const solo = await registerProjectIn("standalone", repo(join(root, "solo")), { name: "Solo", origin: "folder" });
  const soloId = solo.project.id;
  const overseer = await ensureProjectOverseer(soloId);
  // a few more rows in its log, and a cost file beside its overseer files
  await editProject(soloId, { name: "Solo One" });
  const pdir = join(projectOverseerPaths(soloId).dir, "..");
  writeFileSync(join(pdir, "costs.json"), `${JSON.stringify({ version: 1, sessions: {} })}\n`);
  return { orgId: org.id, ws: join(root, "ws"), otherId: other.id, soloId, soloDir: join(root, "agent", "sova", "projects", soloId), overseer };
}

/** What a test checks after an import or a boot. */
export async function stateOf(w: Pick<World, "orgId" | "ws" | "otherId" | "soloId">): Promise<Record<string, unknown>> {
  const { readRegistry } = await import("./projects/registry");
  const { engineOf, listProjects } = await import("./projects/spaces");
  const { hostOf, isOrgHostOpen } = await import("./org-engine");
  const host = isOrgHostOpen(w.orgId) ? hostOf(w.orgId) : null;
  const rows = host ? host.log.rows() : [];
  const keys = rows.filter((r) => r.j).map((r) => `${r.j}|${r.session}|${r.event}|${r.at}`);
  const imported = join(w.ws, "..", "agent", "sova", "projects", ".imported");
  return {
    registry: readRegistry(),
    engine: engineOf(w.soloId),
    otherEngine: engineOf(w.otherId),
    placement: host?.data(`placement/${w.orgId}/${w.soloId}`) ?? null,
    projectData: host?.data(`project/${w.soloId}`) ?? null,
    watch: host?.configuration(`watch/${w.soloId}`) ?? null,
    soloRows: rows.filter((r) => r.project === w.soloId).length,
    dupRows: keys.length - new Set(keys).size,
    space: listProjects().find((p) => p.id === w.soloId)?.space ?? null,
    sessions: existsSync(join(w.ws, "sessions")) ? readdirSync(join(w.ws, "sessions")).filter((f) => f.endsWith(".jsonl")).sort() : [],
    costs: existsSync(join(w.ws, "projects", w.soloId, "costs.json")),
    aside: existsSync(imported) ? readdirSync(imported) : [],
    commits: git(w.ws, "log", "--format=%s").trim().split("\n"),
    problems: host?.problems() ?? null,
  };
}

const KILL_AT = ["mark", "copy", "adopt", "place"] as const;

async function main(): Promise<void> {
  const [root, mode, step] = process.argv.slice(2);
  process.env.PI_CODING_AGENT_DIR = join(root!, "agent");
  if (mode === "import") {
    const w = await buildWorld(root!);
    writeFileSync(join(root!, "world.json"), JSON.stringify(w));
    const { importProject, setImportHooksForTest } = await import("./project-import");
    const kill = () => process.kill(process.pid, "SIGKILL");
    if (!KILL_AT.includes(step as (typeof KILL_AT)[number])) throw new Error(`step must be one of ${KILL_AT.join(", ")}`);
    setImportHooksForTest({
      ...(step === "mark" ? { afterMark: kill } : {}),
      ...(step === "copy" ? { copied: (n: number) => n === 3 && kill() } : {}),
      ...(step === "adopt" ? { afterAdopt: kill } : {}),
      ...(step === "place" ? { beforePlace: kill } : {}),
    });
    await importProject(w.orgId, w.soloId, true);
    process.stdout.write("finished\n");
    process.exit(0);
  }
  if (mode === "boot") {
    const w = JSON.parse(readFileSync(join(root!, "world.json"), "utf8")) as World;
    const { rollForwardCopies, finishImports } = await import("./project-import");
    const { openAttachedOrgs } = await import("./orgs");
    const { openRegisteredProjects } = await import("./projects/spaces");
    rollForwardCopies();
    await openAttachedOrgs();
    await openRegisteredProjects();
    await finishImports();
    const { settled } = await import("./workspace-git");
    await settled(w.ws);
    process.stdout.write(`${JSON.stringify(await stateOf(w))}\n`);
    process.exit(0);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
