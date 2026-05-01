---
title: Installation
description: Install the ccpod binary or build it from source.
---

ccpod is a single static binary. You need a container runtime — Docker, OrbStack, Colima, or Podman — installed and running on the host. ccpod auto-detects the socket.

## From a release binary

```sh
curl -fsSL https://raw.githubusercontent.com/yorch/ccpod/main/install.sh | bash
ccpod --version
```

Installs to `/usr/local/bin` by default. Override with env vars:

```sh
# Custom install directory
CCPOD_INSTALL_DIR=~/.local/bin curl -fsSL https://raw.githubusercontent.com/yorch/ccpod/main/install.sh | bash

# Pin a specific version
CCPOD_VERSION=v0.2.0 curl -fsSL https://raw.githubusercontent.com/yorch/ccpod/main/install.sh | bash
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

1. Docker (`/var/run/docker.sock`, `~/.docker/run/docker.sock`)
2. OrbStack (`~/.orbstack/run/docker.sock`)
3. Colima (`~/.colima/default/docker.sock`)
4. Podman (`$XDG_RUNTIME_DIR/podman/podman.sock`)

You can override the path with `DOCKER_SOCKET_PATH` if you run a non-standard setup.

## Next: [Quick Start](/ccpod/getting-started/quick-start/)
