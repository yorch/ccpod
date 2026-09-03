---
title: Sidecar Services
description: Run Postgres, Redis, queues, or any container alongside Claude.
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
```

## How they wire up

Before starting the Claude container, ccpod:

1. Creates a shared Docker network: `ccpod-net-<projectHash>`.
2. Starts each declared sidecar with `docker run -d --network ccpod-net-<projectHash>`.
3. Labels each container so `ccpod ps` and `ccpod down` can find them.

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

- **Sidecar env values** are passed to Docker as bare `-e KEY` flags with the values injected into the Docker CLI's own environment — they never appear in the process command line (`ps` / `/proc/<pid>/cmdline`).
- **Project-declared services** are ignored unless the profile sets `allowProjectServices: true`. When enabled, project service volumes and ports are still sanitized (named volumes only, loopback-only ports) unless `allowProjectHostMounts` is also set.
- **Sidecar startup failure** rolls back any sidecars started earlier in the same call, so a partial failure does not leave orphaned containers.
