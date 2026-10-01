import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInspect, parsePortOutput, publishedPorts, publisherIn, publisherOf, type ContainerQuery } from "./container-ports";

// Outputs as docker 27 and podman 5 print them.
const DOCKER_PORT = "8080/tcp -> 0.0.0.0:8814\n8080/tcp -> [::]:8814\n";
const PODMAN_PORT = "8080/tcp -> 127.0.0.1:8814\n9090/udp -> 127.0.0.1:9000\n";
const inspect = (running: boolean, ports: unknown, bindings: unknown = ports) =>
  JSON.stringify([{ Id: "abc", Name: "/pvsd-box-4", State: { Status: running ? "running" : "exited", Running: running }, HostConfig: { PortBindings: bindings }, NetworkSettings: { Ports: ports } }]);

test("port output: docker's dual-stack lines and podman's lines both give the host ports", () => {
  assert.deepEqual(parsePortOutput(DOCKER_PORT), [8814]);
  assert.deepEqual(parsePortOutput(PODMAN_PORT), [8814, 9000]);
  assert.deepEqual(parsePortOutput(""), [], "a stopped container prints nothing");
  assert.deepEqual(parsePortOutput("Error: No such container: x\n"), []);
});

test("inspect: a running container's published ports, from NetworkSettings, else HostConfig; a stopped one publishes none", () => {
  const ports = { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8814" }, { HostIp: "::1", HostPort: "8814" }], "9229/tcp": null };
  assert.deepEqual(parseInspect(inspect(true, ports)), [8814], "docker: exposed but unpublished (null) counts for nothing");
  assert.deepEqual(parseInspect(inspect(true, {}, { "8080/tcp": [{ HostIp: "", HostPort: "8000-8001" }] })), [8000, 8001], "podman with an empty NetworkSettings: its bindings, ranges expanded");
  assert.deepEqual(parseInspect(inspect(false, ports)), [], "not running: nothing published");
  assert.deepEqual(parseInspect(inspect(true, { "8080/tcp": [{ HostIp: "", HostPort: "" }] }, null)), [], "a binding still waiting for a random port publishes nothing");
  assert.equal(parseInspect("[]"), null);
  assert.equal(parseInspect("not json"), null);
});

test("ps: the running container whose ports column publishes the port, docker and podman alike", () => {
  const docker = "pvsd-box-4\t127.0.0.1:8814->8080/tcp\nother\t0.0.0.0:5432->5432/tcp, [::]:5432->5432/tcp\nnoports\t\n";
  assert.equal(publisherIn(docker, 8814), "pvsd-box-4");
  assert.equal(publisherIn(docker, 5432), "other");
  assert.equal(publisherIn(docker, 8080), null, "the container's own port is not a host port");
  const podman = "web-2\t0.0.0.0:8000-8003->8000-8003/tcp\n";
  assert.equal(publisherIn(podman, 8002), "web-2");
  assert.equal(publisherIn(podman, 8004), null);
});

test("publishedPorts asks `port`, falls back to `inspect` when `port` fails, and answers none when both fail", async () => {
  const calls: string[] = [];
  const fake =
    (answers: Record<string, { code: number; stdout: string }>): ContainerQuery =>
    async (engine, args) => {
      calls.push(`${engine} ${args.join(" ")}`);
      return answers[args[0]!] ?? { code: 1, stdout: "" };
    };
  assert.deepEqual([...(await publishedPorts(fake({ port: { code: 0, stdout: DOCKER_PORT } }), "docker", "pvsd-box-4"))], [8814]);
  assert.deepEqual(calls, ["docker port pvsd-box-4"]);
  calls.length = 0;
  const viaInspect = await publishedPorts(fake({ port: { code: 125, stdout: "" }, inspect: { code: 0, stdout: inspect(true, { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "8814" }] }) } }), "podman", "pvsd-box-4");
  assert.deepEqual([...viaInspect], [8814]);
  assert.deepEqual(calls, ["podman port pvsd-box-4", "podman inspect pvsd-box-4"]);
  assert.equal((await publishedPorts(fake({}), "docker", "gone")).size, 0);
  assert.equal(await publisherOf(fake({ ps: { code: 0, stdout: "x\t127.0.0.1:8814->80/tcp\n" } }), "podman", 8814), "x");
  assert.equal(await publisherOf(fake({}), "docker", 8814), null, "no engine: no name");
});
