// Run the many-chats bench once and print its numbers (scripts/bench-chat-homes/bench.ts). A scratch folder only:
// it sets the agent dir and homes folder before Sova's code loads, and removes them after.
//   bun scripts/bench-chat-homes/run.ts [homes=5000] [active=150]   (active=all: the worst case, every chat active)
import { benchHomes } from "./bench";

const homes = Number(process.argv[2]) || 5000;
const active = process.argv[3] === "all" ? homes : Number(process.argv[3]) || 150;
const r = await benchHomes({ homes, active });
const ms = (v: number) => `${v.toFixed(2)} ms`;
console.log(
  JSON.stringify(
    {
      homes: r.homes,
      active: r.active,
      check: ms(r.checkMs),
      newChat: ms(r.newChatMs),
      listFiles: ms(r.listFilesMs),
      start: ms(r.startMs),
      firstLoad: ms(r.firstLoadMs),
      strays: ms(r.straysMs),
      ...(r.sweepMs !== undefined ? { sweep: ms(r.sweepMs) } : {}),
      ...(r.io ? { io: r.io } : {}),
    },
    null,
    2,
  ),
);
process.exit(0);
