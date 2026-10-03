---
title: Run Claude Code Safely on Untrusted Repos
description: Confine Claude Code to a container with a restricted network, no SSH access, and isolated state when working on code you did not write.
---

Pointing an AI agent at a repo you did not write is a trust problem: the repo's files, `CLAUDE.md`, and settings all end up in front of a tool that can run commands. ccpod does not make that risk disappear, but it lets you shrink what a bad repo can reach. This guide builds a dedicated `sandbox` profile for that job.

## 1. Create a separate profile

Keep untrusted work out of your everyday profile so loosening one never loosens the other.

```sh
ccpod profile create sandbox
```

Then edit `~/.ccpod/profiles/sandbox/profile.yml`:

```yaml
name: sandbox
description: Untrusted repos. Restricted network, no SSH, ephemeral state.

config:
  source: local
  path: ~/.my-claude-config

image:
  use: ghcr.io/yorch/ccpod:latest

auth:
  type: api-key
  keyEnv: ANTHROPIC_API_KEY_SANDBOX

state: ephemeral

ssh:
  agentForward: false
  mountSshDir: false

network:
  policy: restricted
  allow:
    - api.anthropic.com
```

`config.path` can point at an empty directory if you do not want your usual settings and skills inside the sandbox, or at a trimmed copy of your config as described in [Move your `~/.claude` config into a profile](../migrate-claude-config/).

Each section below explains one of these choices.

## 2. Restrict the network

With `policy: restricted`, the entrypoint installs firewall rules before Claude starts and drops all outbound traffic except loopback, DNS, and the hosts in `allow`. If the rules cannot be installed, the container exits instead of running open.

Start with only `api.anthropic.com` and add hosts as Claude needs them, for example a package registry:

```yaml
network:
  policy: restricted
  allow:
    - api.anthropic.com
    - registry.npmjs.org
```

Hostnames are resolved once at startup, so if a host's IPs change mid-session, restart the container. See [Network Policy](../../features/network/) for the details.

## 3. Give it no SSH access

Both `agentForward` and `mountSshDir` are off in the profile above, so the container cannot use your keys. If Claude needs to clone a private repo, pass a narrowly scoped token instead and add your git host to `network.allow`:

```yaml
env:
  - GITHUB_TOKEN
```

See [SSH Forwarding](../../features/ssh/) for why agent forwarding is still the better choice for repos you trust.

## 4. Keep state ephemeral, or isolate it per project

`state: ephemeral` wipes Claude's history and todos when the container exits. If you want history to persist, isolate it per project so one repo's conversations are never visible to another:

```yaml
state: persistent
stateIsolation: per-project
```

See [State Persistence](../../features/state/).

## 5. Use a dedicated API key

The profile above reads its key from `ANTHROPIC_API_KEY_SANDBOX`, so you can create a separate key with its own spend limit and revoke it without touching your main one. Using `auth.type: proxy` is another option: the container never receives your OAuth credentials at all.

## 6. Leave the project opt-ins off

A repo's `.ccpod.yml` is treated as untrusted. These profile flags default to `false`, so leave them off in the sandbox profile:

| Flag | What it would allow |
|---|---|
| `allowProjectServices` | The repo starts its own sidecar containers. |
| `allowProjectInit` | The repo runs its own init commands. |
| `allowProjectHostMounts` | The repo's sidecars mount host paths. Only matters when `allowProjectServices` is also on. |

The repo can never change the network policy or allow-list, and it cannot set environment variables such as `ANTHROPIC_API_KEY` or `HTTPS_PROXY` that would redirect your credentials.

## 7. Run it explicitly

Select the profile on the command line rather than relying on anything inside the repo:

```sh
cd path/to/untrusted-repo
ccpod run --profile sandbox
```

## What this does not protect against

- **The project is mounted read-write** at `/workspace`. Claude, or anything it runs, can modify or delete files in that directory. Work on a fresh clone or a branch.
- **Project Claude settings still apply.** A repo's `.claude/settings.json` merges into your profile's settings, so hooks defined there run inside the container. That is why the network, SSH, and state settings above matter.
- **Restricted mode is defense in depth, not a sandbox.** It limits where traffic can go, not what runs inside the container.

For a full list of what ccpod enforces, see [Internals](../../reference/internals/).
