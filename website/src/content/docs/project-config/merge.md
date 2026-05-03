---
title: Merge Strategies
description: How profile + project + run-level config combine.
---

ccpod merges configuration in layers. Each asset has a documented strategy so the result is predictable.

Merging happens across three independent axes — each has its own control:

| Axis | Controlled by | Configurable? |
|---|---|---|
| ccpod settings (network, ports, services, env, claudeArgs) | `merge` in `.ccpod.yml` | yes |
| `CLAUDE.md` content | `config.claudeMd` in `.ccpod.yml` | yes |
| `.claude/settings.json` | — | no — always deep-merged, project wins on conflicts |

They are separate flags because the assets have different merge semantics: CLAUDE.md is text (append vs. replace), settings.json is always deep-merged, and ccpod settings vary per asset type.

## Strategy switches

| Setting | Where | Values | Default |
|---|---|---|---|
| `merge` | `.ccpod.yml` | `deep` \| `override` | `deep` |
| `config.claudeMd` | `.ccpod.yml` | `append` \| `override` | `append` |
| `isolation` | `profile.yml` | `true` \| `false` | `false` |

`merge: override` makes the project config replace the profile entirely for the listed sections. `merge: deep` (default) layers the project on top of the profile per asset, with the rules below.

When the profile sets `isolation: true`, **all project config is ignored** — merge strategy, CLAUDE.md, settings.json, env keys, MCP ports, and `.claude/` assets. The profile config is used as-is. See [Profile Configuration](../profiles/configuration/#isolation).

## Per-asset rules (deep merge)

| Asset | Rule |
|---|---|
| `settings.json` | Deep merge. Project wins on conflicting keys. |
| `CLAUDE.md` | Profile content first, then project appended. Set `config.claudeMd: override` to replace. |
| `skills/` | Union. Symlinks are skipped. |
| `enabledPlugins` | Union. Project can add but not remove profile plugins (use `merge: override` to remove). |
| `hooks/` | Arrays merged by event type. |
| `marketplaces` | Object spread; project keys win. |
| `services` | Merged by key. Project can add or replace specific sidecars. |
| `env` (forwarded var names) | Union of both lists. |
| `ports.list` | Concatenated. |
| `network.allow` | Concatenated. |
| `network.policy` | Project value wins if set. |

## CLI overrides

Run-level flags take final precedence:

| Flag | Effect |
|---|---|
| `--profile <name>` | Override which profile to use. |
| `--env KEY=VALUE` | Inject an env var (or override one already forwarded). |
| `--rebuild` | Force image rebuild / repull regardless of cache. |
| `--no-state` | Force `state: ephemeral` for this run only. |
| `--file <path>` | Headless mode via file. Path is normalized; absolute paths and `..` traversals are rejected. |
| `"prompt text"` | Headless mode via inline prompt. Mutually exclusive with `--file`. |
| `-- <args>` | Flags appended verbatim to the `claude` command. Appended after `claudeArgs` from profile/project. |

## Inspecting the result

```sh
ccpod config show
```

The output shows the fully resolved `ResolvedConfig`: image, env (resolved key→value), ports, services, mounts, and the final merged config dir under `/tmp/ccpod-<hash>/`.
