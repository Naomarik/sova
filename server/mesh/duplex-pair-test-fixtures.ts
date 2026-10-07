// Tests: a connection with no socket under it, for HTTP and HTTP/2 run in-process (as the reverse
// channel's streams are in production: plain Duplexes, never a native handle).
import { Duplex } from "node:stream";

/** Two streams wired to each other: what one writes, the other reads, with backpressure (a write
    waits until the reader wants more), and destroying either end ends the other. */
export function duplexPair(): [Duplex, Duplex] {
  const ends: Duplex[] = [];
  const waiting: Array<(() => void) | null> = [null, null];
  const end = (i: number) =>
    new Duplex({
      read() {
        const go = waiting[i];
        waiting[i] = null;
        go?.();
      },
      write(c, _e, cb) {
        if (ends[1 - i]!.push(c)) cb();
        else waiting[1 - i] = cb;
      },
      final(cb) {
        ends[1 - i]!.push(null);
        cb();
      },
      destroy(err, cb) {
        ends[1 - i]!.destroy();
        cb(err);
      },
    });
  ends.push(end(0), end(1));
  return [ends[0]!, ends[1]!];
}
