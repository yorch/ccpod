---
title: Installation
description: Install the ccpod binary or build it from source.
---

ccpod is a single static binary. You need a container runtime — Docker, OrbStack, Colima, or Podman — installed and running on the host. ccpod auto-detects the socket.

## From a release binary

```sh
curl -fsSL https://ccpod.brnby.com/install.sh | sh
ccpod --version
```

Installs to `/usr/local/bin` by default. Override with env vars:

```sh
# Custom install directory
CCPOD_INSTALL_DIR=~/.local/bin curl -fsSL https://ccpod.brnby.com/install.sh | sh

# Pin a specific version
CCPOD_VERSION=v0.2.0 curl -fsSL https://ccpod.brnby.com/install.sh | sh
```

Pre-built binaries are published for Linux and macOS on x86_64 and arm64.

## From source

You need [Bun](https://bun.sh) 1.x.

```sh
git clone https://github.com/yorch/ccpod.git
cd ccpod
bun install
bun run build      # outputs dist/ccpod
./dist/ccpod --version
```

To run without building:

```sh
bun run dev -- --version
```

## Verifying the runtime

ccpod looks for a Docker-compatible socket in the following order:

1. OrbStack (`~/.orbstack/run/docker.sock`)
2. Docker (`/var/run/docker.sock`, `~/.docker/run/docker.sock`)
3. Colima (`~/.colima/default/docker.sock`, `~/.colima/docker.sock`)
4. Podman (`$XDG_RUNTIME_DIR/podman/podman.sock`, `~/.local/share/containers/podman/machine/podman.sock`)

You can override the path with `DOCKER_SOCKET_PATH` if you run a non-standard setup.

## Next: [Quick Start](../quick-start/)
