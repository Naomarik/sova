import { execFile } from "node:child_process";
import { createSocket } from "node:dgram";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { DetectedNetwork } from "../../shared/networks";
import { getIdentity } from "../mesh/localapi";
import { classifyNetworks, needsRoutes, type DetectInput, type IfaceAddress, type IfaceFacts } from "./detect";
import { canonicalIp } from "../share/security";

// Reads what detection classifies (server/networks/detect.ts) from this computer: the interface
// table, Linux's /sys/class/net facts, the routes of a point-to-point interface (`ip -j route`,
// macOS `netstat -rn`), and Tailscale's own addresses from LocalAPI when it answers. No dependency.

const SYS = "/sys/class/net";

function linuxFacts(name: string): IfaceFacts | undefined {
  const dir = join(SYS, name);
  if (!existsSync(dir)) return undefined;
  const facts: IfaceFacts = {};
  try {
    const devtype = /^DEVTYPE=(.*)$/m.exec(readFileSync(join(dir, "uevent"), "utf8"))?.[1]?.trim();
    if (devtype) facts.devtype = devtype;
  } catch {
    // no uevent: go by the rest
  }
  facts.tun = existsSync(join(dir, "tun_flags"));
  facts.wireless = existsSync(join(dir, "wireless")) || existsSync(join(dir, "phy80211"));
  facts.physical = existsSync(join(dir, "device"));
  facts.bridgePort = existsSync(join(dir, "brport")) || existsSync(join(dir, "master"));
  try {
    facts.virtual = realpathSync(dir).includes("/devices/virtual/");
  } catch {
    // unknown
  }
  try {
    facts.up = (Number(readFileSync(join(dir, "flags"), "utf8").trim()) & 1) === 1;
  } catch {
    // unknown: listed
  }
  return facts;
}

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 2000, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? "" : String(stdout)));
  });

/** `ip -j route show dev <if>` → its destinations. */
export function parseIpRoutes(json: string): string[] {
  try {
    const rows = JSON.parse(json) as Array<{ dst?: unknown }>;
    return Array.isArray(rows) ? rows.map((r) => (typeof r?.dst === "string" ? r.dst : "")).filter((d) => d && d !== "default") : [];
  } catch {
    return [];
  }
}

/** macOS `netstat -rn` → destinations per interface ("10.8/16" style shortened networks expanded). */
export function parseNetstatRoutes(text: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[0] === "Destination" || cols[0] === "default") continue;
    const dest = cols[0]!;
    const iface = cols[3]!;
    let cidr: string | null = null;
    const m = /^(\d+(?:\.\d+){0,3})(?:\/(\d+))?$/.exec(dest);
    if (m) {
      const parts = m[1]!.split(".");
      const prefix = m[2] ?? String(parts.length * 8);
      cidr = `${[...parts, "0", "0", "0"].slice(0, 4).join(".")}/${prefix}`;
    } else if (/^[0-9a-f:]+(?:%\S+)?\/\d+$/i.test(dest)) cidr = dest.replace(/%[^/]+/, "");
    if (!cidr) continue;
    (out[iface] ??= []).push(cidr);
  }
  return out;
}

/** Whether Tailscale's LocalAPI may be asked: only while the mesh is on (server/index.ts says so). Otherwise
    detection names Tailscale by its ranges alone, and a Sova with the mesh off never calls Tailscale. */
let mayAskTailscale: () => boolean = () => false;
export function setTailscaleAsk(allowed: () => boolean): void {
  mayAskTailscale = allowed;
}

let tsCache: { at: number; addresses: string[] | null } | null = null;
async function tailscaleAddresses(): Promise<string[] | null> {
  try {
    if (!mayAskTailscale()) return null;
  } catch {
    return null;
  }
  if (tsCache && Date.now() - tsCache.at < 60_000) return tsCache.addresses;
  let addresses: string[] | null = null;
  try {
    const status = await Promise.race([getIdentity().status(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("slow")), 1500).unref())]);
    addresses = status.self.addresses.map((a) => canonicalIp(a.replace(/\/\d+$/, "")) ?? "").filter(Boolean);
    if (!addresses.length) addresses = null;
  } catch {
    addresses = null;
  }
  tsCache = { at: Date.now(), addresses };
  return addresses;
}

/** The system's table, facts and routes, as detection reads them. */
export async function readSystem(): Promise<DetectInput> {
  const platform = process.platform;
  const interfaces = networkInterfaces() as Record<string, IfaceAddress[] | undefined>;
  const facts: Record<string, IfaceFacts | undefined> = {};
  const routes: Record<string, string[]> = {};
  if (platform === "linux") {
    for (const name of Object.keys(interfaces)) facts[name] = linuxFacts(name);
    await Promise.all(
      Object.entries(interfaces)
        .filter(([, addrs]) => needsRoutes(addrs))
        .map(async ([name]) => {
          routes[name] = [...parseIpRoutes(await run("ip", ["-j", "route", "show", "dev", name])), ...parseIpRoutes(await run("ip", ["-j", "-6", "route", "show", "dev", name]))];
        }),
    );
  } else if (platform === "darwin" && Object.values(interfaces).some((a) => needsRoutes(a))) {
    Object.assign(routes, parseNetstatRoutes(await run("netstat", ["-rn"])));
  }
  return { platform, interfaces, facts, routes, tailscale: await tailscaleAddresses() };
}

/** Tests: stand-ins for reading the system and for the route probe (the unit tier opens no socket and runs no
    program); null restores the real ones. */
let probeForTest: { system?: () => DetectInput | Promise<DetectInput>; route?: (address: string) => string | null | Promise<string | null> } | null = null;
export function setProbeForTest(probe: typeof probeForTest): void {
  probeForTest = probe;
}

/** This computer's networks now: a reading younger than 5 s is reused, so a page or script polling the list
    runs no more route reads or Tailscale calls than that. */
let lastRead: { at: number; networks: Promise<DetectedNetwork[]> } | null = null;
export async function detectNetworks(): Promise<DetectedNetwork[]> {
  if (probeForTest?.system) return classifyNetworks(await probeForTest.system());
  if (!lastRead || Date.now() - lastRead.at > 5000) {
    const networks = readSystem().then(classifyNetworks);
    lastRead = { at: Date.now(), networks };
    networks.catch(() => {
      if (lastRead?.networks === networks) lastRead = null;
    });
  }
  return lastRead.networks;
}

/** The local address the system routes traffic for `address` from: a UDP connect, which sends no packet.
    Null when there is no route. */
export function routedFrom(address: string): Promise<string | null> {
  if (probeForTest?.route) return Promise.resolve(probeForTest.route(address));
  return new Promise((resolve) => {
    const v6 = address.includes(":");
    const socket = createSocket(v6 ? "udp6" : "udp4");
    const done = (value: string | null) => {
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(value);
    };
    socket.once("error", () => done(null));
    try {
      socket.connect(9, address, () => {
        try {
          done(canonicalIp(socket.address().address));
        } catch {
          done(null);
        }
      });
    } catch {
      done(null);
    }
  });
}
