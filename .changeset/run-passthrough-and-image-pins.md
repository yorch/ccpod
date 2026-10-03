---
"ccpod": patch
---

Fix `ccpod run -- <claude flags>`: the first token after `--` was also taken as a headless prompt, so `ccpod run -- --verbose` went headless and passed the flag twice. The prompt now comes only from arguments before `--`, and everything after it is forwarded to `claude` (an inline prompt still cannot be combined with bare positional values after `--`, e.g. `--model opus`). The container image now pins `uv` and `bun` versions, and `AuthProxy` token refresh, 401 retry and write-back are covered by tests.
