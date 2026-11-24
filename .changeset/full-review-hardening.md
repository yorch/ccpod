---
'ccpod': minor
---

Full-codebase review fixes (security, bugs, UX, docs).

Security:
- `auth.keyFile` now rejects any symlink below `~/.ccpod` and non-regular files. The credentials directory is writable from the container, so a planted symlink could previously make another profile's credentials be injected as the API key.
- The entrypoint refuses symlinked credential sources and replaces (rather than follows) symlinked destinations; the init wizard does the same on the host.
- `.credentials.json` and `.claude.json` are never copied into `/ccpod/config` (e.g. when `config.path` points at `~/.claude`), even in proxy auth mode.
- Env values containing CR/LF are refused when the key could steer the Docker CLI itself (`HOME`, `PATH`, `XDG_*`, `*_PROXY`, …), which also covers sidecar env.
- Project sidecars can no longer mount `ccpod-*` named volumes, only publish on `127.0.0.1`/`[::1]`, and service names and images are validated.
- `network: restricted` containers now start with `no-new-privileges`.
- `profile install` risk summary now also lists image, Dockerfile, claudeArgs, plugins, ports, config.path, permissive permissions, restricted allow-lists and key files; sources starting with `-` are rejected.
- `ccpod run --file` resolves symlinks and checks containment; a project `CLAUDE.md` symlink is honoured only when it stays inside the project.

Bug fixes:
- The entrypoint waits for Claude to exit before copying credentials back, keeps stdin attached, and classifies hostnames with 3+ dots correctly in the restricted allow-list.
- The local image tag now also hashes `entrypoint.sh` and the ccpod version, so upgrades rebuild.
- Proxy auth: a symlinked credential file is refused before a refresh token is consumed, malformed `expires_in` is rejected, a failed start cleans up, shutdown waits for an in-flight refresh, and Keychain write errors no longer include the credential.
- `ccpod update` refuses to run from `bun run dev` and has network timeouts; `install.sh` stages downloads in a private temp directory.
- `ccpod profile update` fails when the git sync fails; `down` exits non-zero on failures; `config get/set` ignore prototype keys; `config validate` runs the same merge as `run`; empty `.ccpod.yml` is accepted; extra positionals to `shell`/`exec` are rejected; no wizard is launched in non-interactive runs; the update notice goes to stderr (TTY only).

Docs and CI: fixed the invalid demo cast (raw ESC bytes broke the homepage player), corrected network/DNS, storage, runtime-detection and migration docs, improved website contrast, reduced-motion and footer/table accessibility, and added least-privilege permissions to CI.

Upgrade notes:
- If you relied on `config.path: ~/.claude` to carry OAuth credentials into the container, they are no longer copied. Run `ccpod init` or set `auth.type` (`oauth`, `api-key` or `proxy`) on the profile.
- A headless `ccpod run --file`/prompt with no default profile now errors with a pointer to `ccpod init` instead of launching the wizard.
- Profiles that build from a Dockerfile rebuild once after each ccpod upgrade (the local image tag now includes the ccpod version); old `ccpod-local-*` tags are not pruned automatically.
- Not done (follow-ups): SHA-pinning the remaining third-party GitHub Actions (could not be resolved offline), aligning CI/release Bun versions with `engines`, root-only credentials mount, and entrypoint integration tests.

