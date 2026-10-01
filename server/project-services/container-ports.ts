/**
 * Which host ports a container publishes, asked of its engine (docker or podman), never of the
 * listener: with rootful Docker the listener is `docker-proxy` (root, outside the unit), rootless
 * engines listen through `rootlessport` or `pasta`, Docker Desktop through its own process, and an
 * engine that publishes by firewall rules alone shows no listener at all
 * (§app.project-services/up counts a port its own container publishes as the instance's own).
 */

/** Run a container engine command to completion by argv (tests fake it). */
export type ContainerQuery = (engine: string, args: string[]) => Promise<{ code: number; stdout: string }>;

/** `8814`, or a range `8000-8003`, as the ports it covers; anything else is none. */
function hostPorts(spec: string): number[] {
  const m = /^(\d+)(?:-(\d+))?$/.exec(spec.trim());
  if (!m) return [];
  const lo = Number(m[1]);
  const hi = m[2] ? Number(m[2]) : lo;
  if (!(lo > 0 && hi >= lo && hi <= 65535)) return [];
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

/** The port after an address's last colon: `127.0.0.1:8814`, `[::]:8814`, `0.0.0.0:8000-8003`. */
const afterLastColon = (addr: string) => hostPorts(addr.slice(addr.lastIndexOf(":") + 1));

/** `<engine> port <name>`: one `8080/tcp -> 127.0.0.1:8814` line per binding (docker and podman alike). */
export function parsePortOutput(text: string): number[] {
  const out = new Set<number>();
  for (const line of text.split("\n")) {
    const i = line.indexOf("->");
    if (i < 0) continue;
    for (const p of afterLastColon(line.slice(i + 2).trim())) out.add(p);
  }
  return [...out];
}

type Bindings = Record<string, { HostIp?: unknown; HostPort?: unknown }[] | null> | null | undefined;

/**
 * `<engine> inspect <name>` (a JSON array, docker and podman alike): the host ports of a running
 * container, from `NetworkSettings.Ports`, else `HostConfig.PortBindings`. A stopped container
 * publishes nothing; output that is not an inspect array is `null`.
 */
export function parseInspect(text: string): number[] | null {
  let all: unknown;
  try {
    all = JSON.parse(text);
  } catch {
    return null;
  }
  const c = Array.isArray(all) ? (all[0] as { State?: { Running?: unknown }; NetworkSettings?: { Ports?: Bindings }; HostConfig?: { PortBindings?: Bindings } } | undefined) : undefined;
  if (!c || typeof c !== "object") return null;
  if (c.State?.Running !== true) return [];
  const from = (b: Bindings) => Object.values(b ?? {}).flatMap((list) => (Array.isArray(list) ? list : []).flatMap((x) => (typeof x?.HostPort === "string" ? hostPorts(x.HostPort) : [])));
  const live = from(c.NetworkSettings?.Ports);
  return [...new Set(live.length ? live : from(c.HostConfig?.PortBindings))];
}

/**
 * `<engine> ps --format '{{.Names}}\t{{.Ports}}'`: the running container whose ports column
 * (`127.0.0.1:8814->8080/tcp, [::]:8814->8080/tcp`) publishes `port`, or `null`.
 */
export function publisherIn(text: string, port: number): string | null {
  for (const line of text.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const name = line.slice(0, tab).trim();
    for (const binding of line.slice(tab + 1).split(",")) {
      const i = binding.indexOf("->");
      if (i >= 0 && afterLastColon(binding.slice(0, i).trim()).includes(port)) return name;
    }
  }
  return null;
}

/** The host ports container `name` publishes now: `port`, else `inspect`; none when it doesn't run or the engine can't say. */
export async function publishedPorts(query: ContainerQuery, engine: string, name: string): Promise<Set<number>> {
  const p = await query(engine, ["port", name]);
  if (p.code === 0) return new Set(parsePortOutput(p.stdout));
  const i = await query(engine, ["inspect", name]);
  return new Set(i.code === 0 ? (parseInspect(i.stdout) ?? []) : []);
}

/** The running container of `engine` that publishes `port`, or `null`. */
export async function publisherOf(query: ContainerQuery, engine: string, port: number): Promise<string | null> {
  const r = await query(engine, ["ps", "--format", "{{.Names}}\t{{.Ports}}"]);
  return r.code === 0 ? publisherIn(r.stdout, port) : null;
}
