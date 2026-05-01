---
title: Network Policy
description: Restrict the Claude container's outbound network with an allow-list.
---

By default the Claude container has full outbound network access. For sensitive work, switch to **restricted mode** and explicitly allow-list the destinations Claude is permitted to reach.

## Full mode (default)

```yaml
network:
  policy: full
```

The container is attached to a standard bridge network with normal outbound. Use this for everyday development.

## Restricted mode

```yaml
network:
  policy: restricted
  allow:
    - api.github.com
    - registry.npmjs.org
    - api.anthropic.com
```

What happens:

1. ccpod adds `--cap-add NET_ADMIN` to the container so the entrypoint can write iptables rules.
2. At container start, the entrypoint applies these OUTPUT rules **before** launching Claude:
   - `ACCEPT` loopback and established/related connections
   - `ACCEPT` DNS (UDP + TCP port 53) so hostname resolution works
   - For each entry in `allow`: resolve hostname → IPs via `getent hosts`, then `ACCEPT` each IP. IPs and CIDRs are used directly.
   - `DROP` all other outbound
3. The resolution happens once at startup — if a domain's IPs rotate during your session, reconnection to new IPs will be blocked until you restart the container.

## Combining with project config

A project's `.ccpod.yml` can tighten the policy or extend the allow-list:

```yaml
# .ccpod.yml
network:
  policy: restricted
  allow:
    - api.stripe.com
```

Under deep merge, `allow` lists are concatenated. Under `merge: override`, the project replaces the profile's network block entirely.

## Caveats

- Resolution is done **once at container start**. IPs resolved at startup remain allowed even if DNS changes; new IPs for the same hostname are blocked until container restart.
- `getent hosts` returns both IPv4 and IPv6 addresses — both are allowed when present.
- Loopback (`lo`) is always allowed, so MCP servers and sidecar containers on the same network remain reachable.
- Restricted mode is a defense-in-depth tool, not a sandbox. Combine with ephemeral state and no SSH agent forwarding for sensitive work.
