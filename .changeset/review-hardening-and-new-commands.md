---
"ccpod": minor
---

Security hardening, bug fixes, and new commands from a full code review (#29).

**Security**
- Project `.ccpod.yml` `env` can no longer set `PATH`/`HOME`/`LD_*`/`DYLD_*`/`BASH_ENV` and similar; bare host-var forwarding from project env needs the profile's new `allowProjectEnvForward`.
- Symlinked project `.claude/`, `CLAUDE.md`, and `settings.json` are rejected, and `post-init.sh` is never copied (it bypassed `allowProjectInit`).
- The docker binary is resolved to an absolute path, entrypoint root commands use a fixed root `PATH`, and `/ccpod/credentials` is no longer chowned.
- A project-selected profile needs a one-time remembered approval (`~/.ccpod/trusted-projects.json`).
- `image.dockerfile` relative paths resolve against the profile directory, so a cloned repo's Dockerfile is never built with the profile's credentials.
- Auth proxy hardening: constant-time sentinel check, bind to the bridge gateway on Linux, upstream stream error handling, port-scoped firewall rule, no reattach in proxy mode.
- `ccpod shell` uses its own container; `install.sh` aborts on unverifiable downloads; `profile install` lists what a profile enables.

**New**
- `ccpod doctor`, `ccpod exec`, `ccpod profile edit`, `--json` on list commands, and a `--yes` alias.

**Fixes**
- `--no-state`, headless mode (`claude -p`), `prune` no longer deleting history of live projects, `down`/`state clear` failing closed when docker is unreachable, `down --all --profile`, `claudeMd: override` wiping the profile CLAUDE.md, git sync offline fallback and SHA refs, multi-binding ports, `DOCKER_HOST` and rootless Docker, repeatable `--env`, Linux host-uid remap, and more.

**Behavior changes**
- Project `env` bare names, project-chosen profiles, and relative `image.dockerfile` now need the new opt-ins or one-time approval.
- `--file` now means "read the prompt from this file" (it was forwarded to `claude --file`).
- `ccpod state clear <name>`, `image build <name>`, etc. now error instead of silently using the default profile; use `--profile`.
