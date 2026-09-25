# Sova mesh lab: one image per Sova host. lab.mjs builds it from `git archive <rev>` (default HEAD),
# or with --dirty from the working tree as it is on disk; either way /sova/BUILD_COMMIT records
# which. The ignore list is Dockerfile.dockerignore beside this file (BuildKit per-Dockerfile ignore).
#
#   target plain — Sova + tools, NO tailscale binaries at all (the parity / non-tailnet host)
#   target host  — plain + tailscaled/tailscale (TUN mode, needs NET_ADMIN + /dev/net/tun)
#
# Built and tagged by scripts/mesh-lab/lab (sovamesh-plain:lab, sovamesh-host:lab); `lab destroy`
# removes them.

ARG NODE_IMAGE=node:25.2.1-bookworm-slim
ARG TAILSCALE_IMAGE=tailscale/tailscale:v1.102.5

FROM ${TAILSCALE_IMAGE} AS tailscale

FROM ${NODE_IMAGE} AS deps
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl dnsutils git iproute2 iptables iputils-ping jq openssl procps socat \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@12.6.0 && npm cache clean --force
WORKDIR /sova
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS plain
LABEL sova.mesh-lab=1
COPY . /sova
# The frontend only (no tsc): a lab run must not be blocked by a typecheck error mid-branch.
RUN pnpm exec vite build >/dev/null
COPY scripts/mesh-lab/host/entrypoint.sh /usr/local/bin/lab-entrypoint
COPY scripts/mesh-lab/host/fixture-session.mjs /usr/local/lib/lab/fixture-session.mjs
RUN chmod 0755 /usr/local/bin/lab-entrypoint && mkdir -p /root/work
# What this image was built from (lab.mjs build: commit, source, dirty paths). Last, so a new
# provenance never invalidates the cached layers above.
ARG LAB_PROVENANCE={}
RUN printf '%s\n' "$LAB_PROVENANCE" > /sova/BUILD_COMMIT
ENV PI_CODING_AGENT_DIR=/sova/.agent PORT=4800 HOST=127.0.0.1 LAB_TAILSCALE=0
EXPOSE 4900
ENTRYPOINT ["/usr/local/bin/lab-entrypoint"]

FROM plain AS host
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscale /usr/local/bin/
ENV LAB_TAILSCALE=1
