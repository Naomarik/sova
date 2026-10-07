import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests only (nothing in the server imports this). A block of ports reserved across processes: test
 * files in one run, and suites from other worktrees, that each picked a random free base once used to
 * collide (one's slot port was the other's listener). Blocks are aligned chunks of CHUNK ports below the
 * kernel's ephemeral range (32768+), where no outgoing connection's own port can take one. A chunk is
 * held by an exclusive lock file naming this pid, in the temp dir the runner shares with every file
 * (SOVA_TEST_SHARED_TMP: the runner gives each file its own TMPDIR), released at exit; a lock whose pid
 * is gone is reclaimed.
 */
const LOW = 20_000;
const HIGH = 32_000;
const CHUNK = 100;

const held: string[] = [];
let hooked = false;

const isFree = (port: number) => new Promise<boolean>((done) => { const s = createServer(); s.once("error", () => done(false)); s.listen(port, "127.0.0.1", () => s.close(() => done(true))); });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ours(file: string): boolean {
  try {
    return readFileSync(file, "utf8") === String(process.pid);
  } catch {
    return false;
  }
}

function release(file: string) {
  try {
    if (ours(file)) unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/** Takes `file`'s lock, reclaiming it once from a dead pid. */
function lock(file: string): boolean {
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    let pid = NaN;
    try {
      pid = Number(readFileSync(file, "utf8"));
    } catch {
      continue; // released meanwhile
    }
    // Empty: its holder is still writing it.
    if (!pid || alive(pid)) return false;
    try {
      unlinkSync(file);
    } catch {
      /* another process reclaimed it first */
    }
  }
  return false;
}

/** Reserves `size` consecutive free ports for this process's life; returns the first. */
export async function reservePorts(size: number): Promise<number> {
  const dir = join(process.env.SOVA_TEST_SHARED_TMP || tmpdir(), `sova-test-ports-${process.getuid?.() ?? "user"}`);
  mkdirSync(dir, { recursive: true });
  if (!hooked) {
    hooked = true;
    process.on("exit", () => held.forEach(release));
  }
  const chunks = Math.ceil(size / CHUNK);
  const starts = (HIGH - LOW) / CHUNK - chunks + 1;
  const from = Math.floor(Math.random() * starts);
  for (let i = 0; i < starts; i++) {
    const first = (from + i) % starts;
    const got: string[] = [];
    for (let c = first; c < first + chunks; c++) {
      const f = join(dir, `${LOW + c * CHUNK}.lock`);
      if (!lock(f)) break;
      got.push(f);
    }
    const base = LOW + first * CHUNK;
    if (got.length === chunks && (await Promise.all(Array.from({ length: size }, (_, o) => isFree(base + o)))).every(Boolean)) {
      held.push(...got);
      return base;
    }
    got.forEach(release);
  }
  throw new Error(`reservePorts: no free block of ${size} ports in ${LOW}-${HIGH} (locks in ${dir})`);
}
