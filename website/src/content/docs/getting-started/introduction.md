---
title: Introduction to ccpod
description: What ccpod is, what problem it solves, and when to use it. ccpod runs Claude Code in Docker with portable profiles for reproducible AI development environments.
---

`ccpod` is a small CLI that runs [Claude Code](https://docs.claude.com/en/docs/claude-code) inside a container, with the entire Claude environment described by a portable **profile**.

## The problem

By default, Claude Code runs directly on your host. The agent has access to your full filesystem, your shell, and your network — and its configuration lives in `~/.claude/`: settings, plugins, skills, `CLAUDE.md`, MCP servers, and credentials. That setup has four sharp edges:

- **No isolation.** An autonomous agent has the same blast radius as you do.
- **Per-machine.** Move to a new laptop and you start over.
- **Hard to share.** Teammates each maintain their own copy and drift apart.
- **Hard to reproduce.** Open-source projects can't pin a known-good Claude setup for contributors.

## The model

ccpod splits configuration into two layers:

1. A **profile** at `~/.ccpod/profiles/<name>/profile.yml` that defines the complete Claude environment — image, auth, settings, plugins, `CLAUDE.md`, network policy, sidecar services.
2. A **project config** (`.ccpod.yml`) that lives in a repo and overlays the profile for that project.

`ccpod run` resolves both layers, merges them with documented strategies, and starts a Claude session inside a container with your project mounted at `/workspace`. Your host `~/.claude` is never touched.

## Who it's for

ccpod is most valuable when **at least one** of these applies:

- **Teams** that want one shared Claude setup, kept in sync via git.
- **Open-source maintainers** who want contributors to get a known-good Claude environment with a single command.
- **Developers who want a sandboxed agent** — restricted network, isolated filesystem — for autonomous or long-running runs.
- **Multi-machine developers** who want a single source of truth across laptops, desktops, and remote dev boxes.
- **Polyglot stacks** where Claude needs Postgres, Redis, or a queue running alongside it.

If you're a solo developer on a single laptop with a stable `~/.claude` you're happy with, plain Claude Code is probably enough. ccpod adds value when configuration becomes something you want to *version, share, or sandbox*.

## Tradeoffs to be honest about

- **Container startup cost.** Each `ccpod run` spins up a container — typically a second or two on a warm image, longer on first pull.
- **Docker/OrbStack/Podman dependency.** You need a container runtime installed.
- **Learning curve.** Two YAML layers, a merge model, and named volumes are more concepts than `claude` on its own.
- **Plugin install on first run.** New plugins are delta-installed into a per-profile volume; the first run after adding one is slower.

For many teams these are easy trades. For a five-minute solo experiment, they may not be.

## What ccpod does *not* do

- It does not replace Claude Code — it runs the official binary inside the container.
- It does not require Docker specifically. OrbStack, Colima, and Podman all work; the runtime is auto-detected.
- It does not lock you into a hosted service. Profiles are plain YAML in your home directory or a git repo of your choice.

Ready? Head to [Installation](../installation/).
