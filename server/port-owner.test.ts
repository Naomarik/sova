import assert from "node:assert/strict";
import { test } from "node:test";
import { listeningInodes } from "./port-owner";

const HEAD = "  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
const row = (addr: string, port: number, inode: string, st = "0A") =>
  `   0: ${addr}:${port.toString(16).toUpperCase().padStart(4, "0")} ${"0".repeat(addr.length)}:0000 ${st} 00000000:00000000 00:00000000 00000000  1000        0 ${inode} 1 0000000000000000 100 0 0 10 0`;

test("listeners a loopback start collides with: 127.x, ::1, any, and their IPv4-mapped forms (a JVM's dual-stack 'localhost')", () => {
  const tcp = [HEAD, row("0100007F", 4384, "11"), row("0200007F", 4385, "12"), row("00000000", 4386, "13"), row("0101A8C0", 4387, "14")].join("\n");
  const tcp6 = [
    HEAD,
    row("00000000000000000000000001000000", 7900, "21"),
    row("0000000000000000FFFF00000100007F", 9150, "22"),
    row("0000000000000000FFFF000000000000", 9151, "23"),
    row("00000000000000000000000000000000", 9152, "24"),
    row("0000000000000000FFFF00000101A8C0", 9153, "25"),
    row("0000000000000000FFFF00000100007F", 9154, "26", "01"),
  ].join("\n");
  const at = (port: number) => [...listeningInodes([tcp, tcp6], port)];
  assert.deepEqual(at(4384), ["11"], "127.0.0.1");
  assert.deepEqual(at(4385), ["12"], "127.0.0.2");
  assert.deepEqual(at(4386), ["13"], "0.0.0.0");
  assert.deepEqual(at(4387), [], "192.168.1.1 takes no loopback connection");
  assert.deepEqual(at(7900), ["21"], "::1");
  assert.deepEqual(at(9150), ["22"], "::ffff:127.0.0.1");
  assert.deepEqual(at(9151), ["23"], "::ffff:0.0.0.0");
  assert.deepEqual(at(9152), ["24"], "::");
  assert.deepEqual(at(9153), [], "::ffff:192.168.1.1");
  assert.deepEqual(at(9154), [], "an established socket is no listener");
});
