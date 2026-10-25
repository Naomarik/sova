// A stand-in server for supervisor.integration.test.ts: it runs the chat supervisor as the server
// would, with a stand-in chat (a Bun one-liner that writes a heartbeat) instead of main.ts. Never run
// on the live agent dir: PI_CODING_AGENT_DIR must name a scratch dir.
//
//   bun server/chat-runtime/supervisor-standin.ts start <out-dir>   start the chat, print its record, then hold
//   bun server/chat-runtime/supervisor-standin.ts adopt <out-dir>   adopt, print {adopted, died}, exit
//   bun server/chat-runtime/supervisor-standin.ts stop <out-dir>    adopt, stop the chat, exit
//
// SOVA_CHAT_DRIVER and SOVA_CHAT_SLICE choose the driver and slice, as for the server.
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chatDriver, ChatSupervisor, chatEnv, nextEpoch, supervisorConfig } from "./supervisor";

const [mode, outDir] = process.argv.slice(2);
const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? "");
if (!process.env.PI_CODING_AGENT_DIR || agentDir.startsWith(join(homedir(), ".pi"))) {
  console.error("supervisor-standin: PI_CODING_AGENT_DIR must name a scratch dir outside ~/.pi");
  process.exit(2);
}
if (!outDir) throw new Error("usage: supervisor-standin.ts start|adopt|stop <out-dir>");

/** The stand-in chat: its pid and a heartbeat every 200 ms in <out>/chat.txt; an orderly end on SIGTERM. */
const CHAT = `const fs=require("fs");const f=process.env.SOVA_STANDIN_OUT+"/chat.txt";const w=(s)=>fs.appendFileSync(f,s+"\\n");w("pid "+process.pid);setInterval(()=>w("beat "+Date.now()),200);process.on("SIGTERM",()=>{w("disposed");process.exit(0)});`;

const config = supervisorConfig();
const sup = new ChatSupervisor({
  driver: chatDriver(config),
  epoch: nextEpoch(),
  launch: (c) => ({
    argv: [process.execPath, "-e", CHAT],
    env: chatEnv({ serverEnv: process.env, bun: process.execPath, home: homedir(), agentDir, extra: { SOVA_STANDIN_OUT: outDir, SOVA_CHAT_ID: c.chatId, SOVA_CHAT_SOCK: c.sock } }),
  }),
  log: (l) => console.error(`[standin] ${l}`),
});

const chat = { chatId: "standin-chat-1", sessionPath: join(outDir, "chat.jsonl"), cwd: outDir };
if (mode === "start") {
  // As the server: adopt at boot first, so a restarted server finds its chat running and starts nothing.
  await sup.adopt();
  const rec = await sup.start(chat);
  console.log(JSON.stringify(rec));
  // Hold, as a server does, until killed.
  setInterval(() => {}, 1 << 30);
} else if (mode === "adopt") {
  console.log(JSON.stringify(await sup.adopt()));
  sup.detach();
} else if (mode === "stop") {
  await sup.adopt();
  await sup.stop(chat.chatId, "operator");
  sup.detach();
} else throw new Error(`unknown mode ${mode}`);
