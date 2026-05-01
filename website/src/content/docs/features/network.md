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

1. ccpod creates an isolated Docker network with `--internal`, blocking the default internet route.
2. The container's entrypoint resolves each `allow` entry to IP addresses **at startup** and writes iptables rules:
   - `ACCEPT` for each resolved IP.
   - `DROP` for everything else.
3. DNS still resolves via the bridge gateway, but only the allowed IPs are reachable.

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

- Allow-list resolution is done **once at container start**. If a domain's IPs rotate during your session, you'll lose connectivity to the new ones until you restart.
- IPv6 is allow-listed alongside IPv4 when the resolver returns AAAA records.
- `localhost` and the bridge gateway are always reachable so MCP servers and sidecars work.
- Restricted mode is a defense-in-depth tool, not a sandbox. Combine it with other isolation (separate profile, ephemeral state, no SSH agent forward) for sensitive work.
