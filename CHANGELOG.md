# ccpod

## 0.7.0

### Minor Changes

- [#33](https://github.com/yorch/ccpod/pull/33) [`13c321d`](https://github.com/yorch/ccpod/commit/13c321d6c7f981e5cbe25edd97fdbe27b9bed4dc) Thanks [@yorch](https://github.com/yorch)! - Security hardening, bug fixes, and new commands from a full code review ([#29](https://github.com/yorch/ccpod/issues/29)).
  
  **Security**
  - Project `.ccpod.yml` `env` can no longer set `PATH`/`HOME`/`LD_*`/`DYLD_*`/`BASH_ENV` and similar; bare host-var forwarding from project env now only works for variables the profile lists in its new `allowProjectEnvForward`.
  - Symlinked project `.claude/`, `CLAUDE.md`, and `settings.json` are rejected, and `post-init.sh` is never copied (it bypassed `allowProjectInit`).
  - The docker binary is resolved to an absolute path, entrypoint root commands use a fixed root `PATH`, and `/ccpod/credentials` is no longer chowned.
  - A project-selected profile needs a one-time remembered approval (`~/.ccpod/trusted-projects.json`).
  - `image.dockerfile` relative paths resolve against the profile directory, so a cloned repo's Dockerfile is never built with the profile's credentials.
  - Auth proxy hardening: constant-time sentinel check, bind to the bridge gateway on Linux, upstream stream error handling, port-scoped firewall rule, no reattach in proxy mode.
  - `profile install` now shows a "This profile:" summary and asks for confirmation for every source type (local file and pasted base64 included, not just git and url), and accepts `--force` as an alias for `--yes`.
  - `ccpod shell` uses its own container; `install.sh` aborts on unverifiable downloads.
  
  **New**
  - `ccpod doctor`, `ccpod exec`, `ccpod profile edit`, `--json` on list commands, and a `--yes` alias.
  
  **Fixes**
  - `--no-state`, headless mode (`claude -p`), `prune` no longer deleting history of live projects, `down`/`state clear` failing closed when docker is unreachable, `down --all --profile`, `claudeMd: override` wiping the profile CLAUDE.md, git sync offline fallback and SHA refs, multi-binding ports, `DOCKER_HOST` and rootless Docker, repeatable `--env`, Linux host-uid remap, rootless Docker, the `mountSshDir` path, and lowercased image tags (which can trigger a one-time rebuild).
  
  **Behavior changes**
  - Project `env` bare names, project-chosen profiles, and relative `image.dockerfile` now need the new opt-ins or one-time approval.
  - `--file` now means "read the prompt from this file" (it was forwarded to `claude --file`).
  - `ccpod profile delete` now requires the profile name, refuses while the profile has running containers, fails closed when docker is unreachable, and removes the profile's `ccpod-plugins-<profile>` volume.
  - A profile's identity is its directory name; a differing `name:` in `profile.yml` is overridden with a warning.
  - On Linux the entrypoint remaps the container user to the host uid/gid, so bind-mounted files keep host ownership. Per-project state dirs get a `.ccpod-project` marker that `prune` uses to avoid deleting state for live projects.
  - `ccpod config show` marks ignored project env entries.
  - `ccpod state clear <name>`, `image build <name>`, etc. now error instead of silently using the default profile; use `--profile`.

### Patch Changes

- [#28](https://github.com/yorch/ccpod/pull/28) [`c50b1c9`](https://github.com/yorch/ccpod/commit/c50b1c942705d889f6c0d1b859a8f141b21be8e4) Thanks [@yorch](https://github.com/yorch)! - Move releases to a Changesets-driven, PR-gated flow: merging the generated version PR builds the binaries, attests their provenance, publishes the GitHub release, and pushes the versioned Docker image.

- [#32](https://github.com/yorch/ccpod/pull/32) [`1dd5647`](https://github.com/yorch/ccpod/commit/1dd5647387616224f710abd40e127fba13e5d6ef) Thanks [@yorch](https://github.com/yorch)! - Fix the generated version PR being empty: Changesets now versions the private `ccpod` package.

- [#31](https://github.com/yorch/ccpod/pull/31) [`bf6cca7`](https://github.com/yorch/ccpod/commit/bf6cca77e486728db1db843eea697601ed04b0db) Thanks [@yorch](https://github.com/yorch)! - Fix the release workflow failing on ordinary merges to `main` after a version has already been released.

- [#33](https://github.com/yorch/ccpod/pull/33) [`13c321d`](https://github.com/yorch/ccpod/commit/13c321d6c7f981e5cbe25edd97fdbe27b9bed4dc) Thanks [@yorch](https://github.com/yorch)! - Expand a leading `~` in a profile's `config.path` ([#26](https://github.com/yorch/ccpod/issues/26)), and set `meta.name` on all commands so usage output no longer shows the internal bunfs path.
