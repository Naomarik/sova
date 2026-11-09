// A stand-in for a test copy of Sova: the real guard imported first, as server/index.ts does, then a writer that keeps
// refilling its state folder for as long as it lives. Named by own-folder-guard's integration test.
import "./own-folder-guard-boot";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.PI_CODING_AGENT_DIR!;
const write = () => {
  mkdirSync(join(dir, "sessions"), { recursive: true });
  appendFileSync(join(dir, "sessions", "writer.jsonl"), "{}\n");
};
write();
setInterval(write, 20);
