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

## 2. Copy only the configuration into a new directory

`~/.claude/` holds more than configuration. It can contain conversation history under `projects/`, caches, and, on Linux, `.credentials.json` with your OAuth tokens. Do not point a profile at it directly. Copy only the parts that define your environment into a separate directory, and check that the result is what you expect:

```sh
mkdir -p ~/.my-claude-config
for f in settings.json CLAUDE.md; do
  [ -f ~/.claude/$f ] && cp ~/.claude/$f ~/.my-claude-config/
done
for d in skills hooks; do
  [ -d ~/.claude/$d ] && cp -R ~/.claude/$d ~/.my-claude-config/
done
ls -la ~/.my-claude-config
```

The `[ -f ]` and `[ -d ]` checks skip files and directories that do not exist on your machine. Do not add `.credentials.json`, `.claude.json`, or `projects/` to this directory.

## 3. Point the profile at the trimmed directory

Edit the profile's `config` block to use the new directory:

```yaml
config:
  source: local
  path: ~/.my-claude-config
```

ccpod copies that directory into a temporary directory, mounts the copy read-only at `/ccpod/config`, and the container entrypoint copies it into the container's own `~/.claude/`. Your host directory is not modified.

ccpod skips `.credentials.json` and `.claude.json` when it copies a config directory, and it prints a warning when a configured `path` contains them. Use `auth` in the profile to supply credentials. Keep the trimmed directory free of those files anyway, so the warning does not fire and no token sits on disk in a second place.

Run it:

```sh
cd path/to/your/project
ccpod run
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

Before you push, check that the repo contains no API keys, tokens, or credential files, and that it is not a copy of `~/.claude/` with its history. Settings files and hooks sometimes embed secrets. Pass those through `env:` in the profile instead.

## What carries over, and what does not

| Carries over | Does not |
|---|---|
| `settings.json`, `CLAUDE.md`, skills, hooks | Conversation history (unless you set `state: persistent`) |
| Plugins listed in the profile's `plugins:` | Plugins installed by hand on the host |
| MCP servers declared in the project's `.mcp.json` | Host-only tools the container image does not include |
| Credentials, through `auth` in the profile | `.credentials.json` and `.claude.json` from the config directory (skipped) |

## Next steps

- [Shared team profile](../../profiles/team/): the same flow for a whole team.
- [Profile configuration](../../profiles/configuration/): every field in `profile.yml`.
- [Project config](../../project-config/overview/): override the profile per repository.
