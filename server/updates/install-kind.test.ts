import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExecResult } from "./git";
import { detectInstall, parseLauncher, serviceProgram, unquoteShell, userUnitOfCgroup, type InstallProbe } from "./install-kind";

/**
 * Which kind of copy runs: the installer's checkout, a developer checkout
 * run by a user service, or check only. Every fact comes from a fake probe.
 */

const HOME = "/home/u";
const INSTALL = `${HOME}/.local/share/sova`;
const launcherText = (dir: string, port = 4800) => `#!/usr/bin/env bash\n# sova-launcher v1\n# Runs the built Sova server\nset -euo pipefail\ndir=${dir.replace(/ /g, "\\ ")}\nself=${HOME}/.local/bin/sova\ninstall_port=${port}\n`;
const UNIT = `# sova-service v1: written by Sova's install.sh\n[Service]\nExecStart="${HOME}/.local/bin/sova"\n`;

function probe(over: Partial<InstallProbe> & { files?: Record<string, string>; dirs?: string[]; cgroup?: string; mainPid?: number } = {}): InstallProbe {
  const files: Record<string, string> = { ...(over.files ?? {}) };
  if (over.cgroup) files["/proc/self/cgroup"] = over.cgroup;
  const dirs = new Set(over.dirs ?? []);
  const exec = async (file: string, args: string[]): Promise<ExecResult> => {
    if (file === "systemctl" && args.includes("--property=MainPID")) return { code: 0, stdout: `${over.mainPid ?? 0}\n`, stderr: "" };
    if (file === "launchctl") return { code: over.mainPid ? 0 : 113, stdout: over.mainPid ? `\tpid = ${over.mainPid}\n` : "", stderr: "" };
    return { code: 1, stdout: "", stderr: "" };
  };
  return {
    checkout: INSTALL,
    env: {},
    platform: "linux",
    home: HOME,
    pid: 4242,
    uid: 1000,
    agentDir: `${HOME}/.pi/agent`,
    readFile: (p) => files[p] ?? null,
    exists: (p) => p in files || dirs.has(p),
    isFile: (p) => p in files,
    realpath: (p) => p,
    links: (dir) => (dir === `${HOME}/.pi/agent/extensions` ? [[`${dir}/stamp`, `${INSTALL}/pi-config/extensions/stamp`]] : []),
    exec,
    ...over,
  };
}

const SVC_CGROUP = (unit: string) => `0::/user.slice/user-1000.slice/user@1000.service/app.slice/${unit}\n`;

test("the installer's checkout run by its service: an installed copy, with its launcher, port and service", async () => {
  const i = await detectInstall(
    probe({
      files: { [`${HOME}/.config/systemd/user/sova.service`]: UNIT, [`${HOME}/.local/bin/sova`]: launcherText(INSTALL, 4899), [`${INSTALL}/.bun/bin/bun`]: "" },
      dirs: [`${INSTALL}/.git`],
      cgroup: SVC_CGROUP("sova.service"),
      mainPid: 4242,
    }),
  );
  assert.equal(i.kind, "installer");
  assert.deepEqual(i.unit, { manager: "systemd", name: "sova.service" });
  assert.equal(i.launcher, `${HOME}/.local/bin/sova`);
  assert.equal(i.installPort, 4899);
  assert.equal(i.noExtensions, false, "its extensions are linked");
  assert.equal(i.noAppEntry, true, "no app entry was written");
});

test("the installer's checkout with no service, found by SOVA_LAUNCHER in a custom bin dir: the launcher restarts it", async () => {
  const launcher = "/opt/bin/sova";
  const i = await detectInstall(
    probe({
      env: { SOVA_LAUNCHER: launcher },
      files: { [launcher]: launcherText(INSTALL), [`${INSTALL}/.bun/bin/bun`]: "" },
      dirs: [`${INSTALL}/.git`],
      cgroup: "0::/user.slice/user-1000.slice/session-2.scope\n",
      links: () => [],
    }),
  );
  assert.equal(i.kind, "installer");
  assert.equal(i.unit, null);
  assert.equal(i.launcher, launcher);
  assert.equal(i.noExtensions, true, "installed with --no-extensions");
});

test("a launcher pointing at another install doesn't make this checkout the installer's", async () => {
  const i = await detectInstall(
    probe({
      files: { [`${HOME}/.local/bin/sova`]: launcherText("/elsewhere/sova"), [`${INSTALL}/.bun/bin/bun`]: "" },
      dirs: [`${INSTALL}/.git`],
    }),
  );
  assert.equal(i.kind, "check-only");
});

test("a developer checkout that is the main process of a user unit (an adopted sova-runtime.service) is a developer copy", async () => {
  const dev = "/home/u/webapps/sova";
  const i = await detectInstall(probe({ checkout: dev, dirs: [`${dev}/.git`], cgroup: SVC_CGROUP("sova-runtime.service"), mainPid: 4242 }));
  assert.equal(i.kind, "developer");
  assert.deepEqual(i.unit, { manager: "systemd", name: "sova-runtime.service" });
  // In a unit's cgroup but not its main process (a server a chat's unit started): check only.
  const child = await detectInstall(probe({ checkout: dev, dirs: [`${dev}/.git`], cgroup: SVC_CGROUP("sova-chat-1.service"), mainPid: 99 }));
  assert.equal(child.kind, "check-only");
});

test("macOS: a launchd agent whose pid is this server", async () => {
  const dev = "/Users/u/sova";
  const i = await detectInstall(probe({ platform: "darwin", checkout: dev, dirs: [`${dev}/.git`], env: { XPC_SERVICE_NAME: "sova-runtime" }, mainPid: 4242 }));
  assert.deepEqual([i.kind, i.unit], ["developer", { manager: "launchd", name: "sova-runtime" }]);
});

test("check only: a worktree, a terminal-started checkout, no checkout at all, each saying why", async () => {
  const wt = "/home/u/webapps/.worktrees/sova-x";
  const w = await detectInstall(probe({ checkout: wt, files: { [`${wt}/.git`]: "gitdir: /x\n" }, cgroup: SVC_CGROUP("sova-x.service"), mainPid: 4242 }));
  assert.deepEqual([w.kind, w.whyNot], ["check-only", "This copy runs from a worktree, so it updates with git, not from here."]);
  const term = await detectInstall(probe({ checkout: "/src/sova", dirs: ["/src/sova/.git"], cgroup: "0::/user.slice/user-1000.slice/session-3.scope\n" }));
  assert.equal(term.kind, "check-only");
  assert.match(term.whyNot!, /isn't run by a service/);
  const none = await detectInstall(probe({ checkout: null }));
  assert.equal(none.kind, "check-only");
});

test("parsers: the launcher's quoted dir, a cgroup's user unit, a unit's or plist's program", () => {
  assert.equal(unquoteShell("/home/u/my\\ apps/sova"), "/home/u/my apps/sova");
  assert.equal(unquoteShell("'/a b'"), "/a b");
  assert.deepEqual(parseLauncher(launcherText("/home/u/my apps/sova", 4811)), { dir: "/home/u/my apps/sova", port: 4811 });
  assert.equal(parseLauncher("#!/bin/sh\ndir=/x\n"), null, "no marker: not the installer's");
  assert.equal(userUnitOfCgroup(SVC_CGROUP("sova.service")), "sova.service");
  assert.equal(userUnitOfCgroup("0::/system.slice/sova.service\n"), null, "a system unit is not the user's");
  assert.equal(userUnitOfCgroup("0::/user.slice/user-1000.slice/user@1000.service/init.scope\n"), null);
  assert.equal(serviceProgram(UNIT), `${HOME}/.local/bin/sova`);
  assert.equal(serviceProgram("<key>ProgramArguments</key>\n\t<array><string>/Users/u/.local/bin/sova</string></array>"), "/Users/u/.local/bin/sova");
});
