---
title: "Sidecar Services: Postgres, Redis and More"
description: Run Postgres, Redis, queues, or any container alongside Claude Code. ccpod puts sidecars on a shared Docker network and starts them before the main container.
---

Many projects need a database or queue to be useful. ccpod lets you declare those as **sidecars** in the same config that defines your Claude environment, so a single `ccpod run` brings everything up on a shared network.

## Declare in a profile or project config

```yaml
services:
  postgres:
    image: postgres:17
    env:
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: app
    volumes:
      - ccpod-pg-data:/var/lib/postgresql/data
    ports:
      - "5432:5432"   # optional — only needed if you want host access

  redis:
    image: redis:7
    ports:
      - "6379:6379"

  # Optional dependency ordering and image healthcheck readiness:
  worker:
    image: example/worker:latest
    dependsOn: [postgres, redis]
    ready:
      timeoutSeconds: 90   # requires an image HEALTHCHECK; default 60, range 1–3600
```

## How they wire up

Before starting the Claude container, ccpod:

1. Creates a shared Docker network: `ccpod-net-<projectHash>`.
2. Starts each declared sidecar with `docker run -d --network ccpod-net-<projectHash>`.
3. Labels each container so `ccpod ps` and `ccpod down` can find them.

Dependencies are checked for missing services and cycles before network/container changes, then started in deterministic dependency order. If `ready` is configured, ccpod bounds container creation/start and waits for the image healthcheck to report `healthy` within the timeout. Configuring `ready` on an image without a healthcheck is an error. Without `ready`, ccpod does not wait for health after Docker starts the container. A failed startup/readiness check rolls back only containers created by that invocation.

The Claude container joins the same network, so sidecars are reachable **by service name as hostname**:

```sh
# inside the Claude container
psql postgres://postgres:dev@postgres:5432/app
redis-cli -h redis
```

## Lifecycle

| Command | Effect |
|---|---|
| `ccpod run` | Start sidecars (idempotent), then start Claude. |
| `ccpod ps` | List all running ccpod containers (Claude + sidecars). |
| `ccpod down` | Stop and remove the Claude container and *all* sidecars for `$PWD`. |

`ccpod down` is scoped per-project (by `sha256($PWD)`), so multiple projects can run in parallel without interfering.

## Persistent service data

Use named volumes (e.g. `ccpod-pg-data:/var/lib/postgresql/data`) so service data survives `ccpod down` and `ccpod run` cycles. The volume is *not* deleted when you stop sidecars — wipe it explicitly with `docker volume rm` when you're done.

## When to use a profile sidecar vs. a project sidecar

- **Profile** (`~/.ccpod/profiles/<name>/profile.yml`): always-on services that every project using this profile expects.
- **Project** (`.ccpod.yml`): services specific to this repo. **Requires `allowProjectServices: true`** in the profile — project-declared services are ignored by default so a cloned repo cannot start arbitrary containers on the shared network.

Under deep merge, the two are combined by service name. A project entry with the same name as a profile entry replaces it.

## Security

- **Sidecar env values** are transported through a private temporary env-file (directory mode `0700`, file mode `0600`) supplied to Docker by path. Values are not put in Docker argv or the Docker client's process environment; NULs are rejected, a value containing a line break falls back to a bare `-e KEY` read from the Docker client's own environment (still not argv), and the file is removed after the Docker command completes.
- **Project-declared services** are ignored unless the profile sets `allowProjectServices: true`. When enabled, project service volumes and ports are still sanitized (named volumes only, loopback-only ports) unless `allowProjectHostMounts` is also set.
- **Sidecar startup failure** rolls back any sidecars started earlier in the same call, so a partial failure does not leave orphaned containers.
