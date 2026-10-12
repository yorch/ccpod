---
"ccpod": patch
---

Fix a proxy refresh-lock livelock and other follow-up review findings.

- The auth proxy now bounds credential read-back reconciliation instead of retrying forever while holding the cross-process refresh lock. When the store cannot be verified it keeps serving the refreshed token from memory and warns, remembers every consumed generation so a lagging store can never resurrect one, and `stop()` waits on its own bounded budget.
- A second Ctrl+C in proxy mode exits instead of being ignored, and synchronously (bounded) removes any container the process still owns — including one whose `docker create` had not returned yet, found through its cidfile — so a forced exit cannot orphan it.
- Multi-line forwarded env values (PEM blobs, JSON credentials) work again: values containing CR/LF fall back to a bare `-e KEY` read from the Docker CLI's own environment instead of hard-failing, while NUL stays rejected. Private env-file directories are PID-tagged, and dead-owner leftovers from SIGKILL are reclaimed on the next start.
- Profile config sync no longer blocks on untracked files or a trailing-slash remote spelling, while still refusing `.git`-suffixed, scp-style, and ssh-URL spellings that can name different repositories; a reset that would overwrite an untracked file, directory, or ignored path is refused, and the error names the path to remove for a re-clone.
- Proxy runs say when a detached container is being stopped, and a container already in `removing` no longer turns cleanup into an error.
- `ccpod doctor` reports non-secret locations and the first line of a daemon error, with credentials embedded in a remote daemon URL redacted before any truncation; `ccpod logs` prints each container header directly before that container's logs; `ccpod state clear` is no longer blocked by running sidecars (they never mount state).
- Keychain fallback parsing decodes hex-encoded and quote-containing accounts, and credential-store read failures report a non-secret reason code.
