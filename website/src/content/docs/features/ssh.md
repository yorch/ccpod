---
title: SSH Forwarding
description: Forward your SSH agent or mount ~/.ssh into the container.
---

Claude often needs to clone private repos or push commits. ccpod offers two ways to give the container access to your SSH credentials.

## Agent forwarding (recommended)

```yaml
ssh:
  agentForward: true
  mountSshDir: false
```

ccpod forwards your host's `SSH_AUTH_SOCK` into the container. Claude can use any key your local agent has loaded — without those keys ever touching the container filesystem.

Requires `ssh-agent` to be running on the host with your keys added (`ssh-add ~/.ssh/id_ed25519`).

### Safety check

If `SSH_AUTH_SOCK` contains `:`, ccpod **rejects** it before starting the container. The colon would corrupt the Docker bind-mount spec, so we fail fast rather than mount the wrong path.

### Podman limitation

Agent forwarding is **not supported with Podman**. Podman on macOS runs inside a Linux VM, so the host's Unix socket is inaccessible from within the VM. ccpod skips the bind and prints a warning. Use `mountSshDir: true` instead.

## Mount `~/.ssh` read-only

```yaml
ssh:
  agentForward: false
  mountSshDir: true
```

Mounts your `~/.ssh` directory read-only at `/root/.ssh`. Use this when:

- The host doesn't run an agent.
- You need access to `~/.ssh/config` or `known_hosts` patterns.
- Agent forwarding doesn't work for your setup (rare).

This is broader access than agent forwarding — the container can read every key file. Prefer agent forwarding when possible.

## Both off

```yaml
ssh:
  agentForward: false
  mountSshDir: false
```

The container has no SSH access. Cloning private repos won't work. Use HTTPS + a token forwarded as an env var instead:

```yaml
env:
  - GITHUB_TOKEN
```

## Combining with restricted network

If you set `network.policy: restricted`, remember to add `github.com` (or your git host) to `network.allow` — SSH still needs to reach the host.
