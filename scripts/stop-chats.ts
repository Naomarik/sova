#!/usr/bin/env bun
// Stop every chat process a Sova install left running (§app.chat-processes/idle-stop): for Sova stopped
// for good (a teardown, a removed install), whose chats would otherwise run until each goes idle.
// Through the chat supervisor's records and its driver (systemd units of this state root's prefix, or
// the detached sessions it recorded, checked against their start time), never a process found by name.
// Each chat closes as an operator stop does; the next server, if any, reads no death.
//
//   bun scripts/stop-chats.ts [--agent-dir <dir>]     (default: $PI_CODING_AGENT_DIR, else ~/.pi/agent)
import { resolve } from "node:path";

const at = process.argv.indexOf("--agent-dir");
if (at !== -1) {
  const dir = process.argv[at + 1];
  if (!dir) {
    console.error("usage: bun scripts/stop-chats.ts [--agent-dir <dir>]");
    process.exit(2);
  }
  process.env.PI_CODING_AGENT_DIR = resolve(dir);
}

// After the agent dir is set: the state root and its unit prefix come from it.
const { chatDriver, ChatSupervisor, supervisorConfig } = await import("../server/chat-runtime/supervisor");
const { SystemdDriver } = await import("../server/project-services/drivers");

const cfg = supervisorConfig();
const drivers = [chatDriver({ ...cfg, driver: "detached" })];
if (process.platform === "linux" && (await new SystemdDriver().available()).ok) drivers.unshift(chatDriver({ ...cfg, driver: "systemd" }));

let stopped = 0;
for (const driver of drivers) {
  const sup = new ChatSupervisor({ driver, epoch: 0, log: () => {}, launch: () => {
    throw new Error("stop-chats starts nothing");
  } });
  for (const rec of await sup.stopAll("operator")) {
    console.log(`stopped ${rec.unit} (${rec.sessionPath})`);
    stopped++;
  }
}
console.log(stopped ? `${stopped} chat process${stopped === 1 ? "" : "es"} stopped` : "no chat process was recorded as running");
