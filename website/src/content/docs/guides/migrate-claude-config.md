---
title: Move Your ~/.claude Config into a ccpod Profile
description: Turn your existing Claude Code settings, CLAUDE.md, skills, and hooks into a portable ccpod profile you can reuse on any machine or share with a team.
---

If you already have a working Claude Code setup in `~/.claude/`, you do not need to rebuild it to use ccpod. This guide moves it into a profile in three steps, then shows how to make it portable.

## 1. Run the wizard

```sh
ccpod init
```

The wizard detects your container runtime, offers your existing auth (host OAuth, `ANTHROPIC_API_KEY`, or another profile), and creates a `default` profile at `~/.ccpod/profiles/default/profile.yml`.

## 2. Point the profile at your config

Edit the profile's `config` block. The quickest route is to reuse your existing directory:

```yaml
config:
  source: local
  path: ~/.claude
```

ccpod copies that directory into a temporary directory, mounts the copy read-only at `/ccpod/config`, and the container entrypoint copies it into the container's own `~/.claude/`. Your host copy is not modified, but everything in the directory is copied, including history and caches, which is why step 3 trims it.

Run it:

```sh
cd path/to/your/project
ccpod run
```

## 3. Trim what you point at

`~/.claude/` holds more than configuration: conversation history, caches, and possibly credentials. For a profile you intend to keep or share, copy only the parts that define your environment into a separate directory:

```sh
mkdir -p ~/.my-claude-config
cp ~/.claude/settings.json ~/.claude/CLAUDE.md ~/.my-claude-config/
cp -R ~/.claude/skills ~/.claude/hooks ~/.my-claude-config/
```

Copy only what exists on your machine, then point the profile at it:

```yaml
config:
  source: local
  path: ~/.my-claude-config
```

## 4. Make it portable

Put that directory in a git repo and switch the profile to `git`. Every machine, and every teammate, then gets the same environment:

```sh
cd ~/.my-claude-config
git init && git add -A && git commit -m "Claude config"
git remote add origin https://github.com/you/claude-config
git push -u origin main
```

```yaml
config:
  source: git
  repo: https://github.com/you/claude-config
  sync: daily
  ref: main
```

On a new machine, install ccpod, run `ccpod init`, and use the same `config` block, or export the whole profile with `ccpod profile export default` and install it with `ccpod profile install`.

Before you push, check that the repo contains no API keys, tokens, or credential files. Settings files and hooks sometimes embed secrets. Pass those through `env:` in the profile instead.

## What carries over, and what does not

| Carries over | Does not |
|---|---|
| `settings.json`, `CLAUDE.md`, skills, hooks | Conversation history (unless you set `state: persistent`) |
| Plugins listed in the profile's `plugins:` | Plugins installed by hand on the host |
| MCP servers declared in the project's `.mcp.json` | Host-only tools the container image does not include |

## Next steps

- [Shared team profile](../../profiles/team/): the same flow for a whole team.
- [Profile configuration](../../profiles/configuration/): every field in `profile.yml`.
- [Project config](../../project-config/overview/): override the profile per repository.
