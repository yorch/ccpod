---
title: Introduction
description: What ccpod is, what problem it solves, and when to use it.
---

`ccpod` is a small CLI that runs [Claude Code](https://docs.claude.com/en/docs/claude-code) inside a container, with the entire Claude environment described by a portable **profile**.

## The problem

A typical Claude Code setup lives in `~/.claude/`: settings, plugins, skills, `CLAUDE.md`, MCP servers, and credentials. That directory is:

- **Per-machine.** Move to a new laptop and you start over.
- **Hard to share.** Teammates each maintain their own copy and drift apart.
- **Hard to reproduce.** Open-source projects can't pin a known-good Claude setup.
- **Hard to scope per project.** One `CLAUDE.md` shadows every repo.

## The model

ccpod splits configuration into two layers:

1. A **profile** at `~/.ccpod/profiles/<name>/profile.yml` that defines the complete Claude environment — image, auth, settings, plugins, `CLAUDE.md`, network policy, sidecar services.
2. A **project config** (`.ccpod.yml`) that lives in a repo and overlays the profile for that project.

`ccpod run` resolves both layers, merges them with documented strategies, and starts a Claude session inside a container with your project mounted at `/workspace`.

## When to reach for it

- You work on multiple machines and want a single source of truth.
- Your team wants a shared Claude config that updates daily from a git repo.
- An open-source project wants to ship a known-good Claude environment to contributors.
- You want sidecar services (Postgres, Redis) wired to Claude with one config file.
- You need a restricted-network mode for sensitive work.
- You want to keep your host's `~/.claude` untouched while experimenting.

## What ccpod does *not* do

- It does not replace Claude Code — it runs the official binary inside the container.
- It does not require Docker specifically. OrbStack, Colima, and Podman all work; the runtime is auto-detected.
- It does not lock you into a hosted service. Profiles are plain YAML in your home directory or a git repo of your choice.

Ready? Head to [Installation](/getting-started/installation/).
