#!/bin/sh
set -e

# Entrypoint runs as root for setup (iptables, file seeding), then drops to
# the 'node' user (uid 1000) before exec'ing claude. This satisfies Claude
# Code's refusal to run --dangerously-skip-permissions as root.
NODE_HOME=/home/node
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-${NODE_HOME}/.claude}"
mkdir -p "${CLAUDE_DIR}"

# 1. Seed config (CLAUDE.md, settings.json, skills/, extensions/) — ro source → rw dest
if [ -d /ccpod/config ]; then
  cp -r /ccpod/config/. "${CLAUDE_DIR}/"
fi

# 2. Restore persisted auth files:
#   .credentials.json — OAuth access/refresh tokens (lives inside CLAUDE_CONFIG_DIR)
#   .claude.json      — account state, migration flags (fixed at $HOME, not in CLAUDE_CONFIG_DIR)
if [ -f /ccpod/credentials/.credentials.json ]; then
  cp -f /ccpod/credentials/.credentials.json "${CLAUDE_DIR}/.credentials.json"
fi
if [ -f /ccpod/credentials/.claude.json ]; then
  cp -f /ccpod/credentials/.claude.json "${NODE_HOME}/.claude.json"
fi

# 3. Plugins — symlink named volume so installs persist across runs
mkdir -p /ccpod/plugins
rm -rf "${CLAUDE_DIR}/plugins"
ln -sf /ccpod/plugins "${CLAUDE_DIR}/plugins"

# 4. State — symlink named volume or tmpfs mount
mkdir -p /ccpod/state/projects /ccpod/state/todos /ccpod/state/statsig
for dir in projects todos statsig; do
  rm -rf "${CLAUDE_DIR}/${dir}"
  ln -sf "/ccpod/state/${dir}" "${CLAUDE_DIR}/${dir}"
done

# Fix ownership so the node user can read/write everything
chown -R node:node "${CLAUDE_DIR}" "${NODE_HOME}" /ccpod/plugins /ccpod/state /ccpod/credentials 2>/dev/null || true

# 5. Run user-defined init commands (as node user, in /workspace)
if [ -f /ccpod/config/post-init.sh ]; then
  echo "ccpod: running init commands..."
  HOME="${NODE_HOME}" PATH="${PATH}" gosu node sh -c 'cd /workspace && sh /ccpod/config/post-init.sh'
fi

# 6. Delta-install missing plugins (comma-separated list from env)
if [ -n "${CCPOD_PLUGINS_TO_INSTALL}" ]; then
  for plugin in $(printf '%s' "${CCPOD_PLUGINS_TO_INSTALL}" | tr ',' '\n'); do
    if [ -n "${plugin}" ] && [ ! -d "${CLAUDE_DIR}/plugins/${plugin}" ]; then
      echo "ccpod: installing plugin: ${plugin}"
      HOME="${NODE_HOME}" PATH="${PATH}" gosu node claude plugin install "${plugin}" 2>/dev/null || true
    fi
  done
fi

# 7. Network restriction — apply iptables rules before launching claude (requires root)
if [ "${CCPOD_NETWORK_POLICY}" = "restricted" ]; then
  # Fail CLOSED: a restricted profile must never silently run wide open. If the
  # firewall cannot be enforced, abort rather than expose the credential-bearing
  # container to unrestricted egress.
  fail_closed() {
    echo "ccpod: FATAL: restricted network requested but could not be enforced ($1)." >&2
    echo "ccpod: refusing to start with unrestricted egress." >&2
    exit 1
  }

  command -v iptables >/dev/null 2>&1 || fail_closed "iptables not available"

  # Is IPv6 filtering in play? Only when the kernel has IPv6; then ip6tables is
  # mandatory (fail closed if missing, or IPv6 egress would leak past IPv4-only
  # rules).
  HAVE_IP6=0
  if [ -d /proc/sys/net/ipv6 ]; then
    command -v ip6tables >/dev/null 2>&1 || fail_closed "ip6tables not available"
    HAVE_IP6=1
  fi

  # Resolve the iptables binary for an address by family, or empty when that
  # family isn't being filtered (IPv6 literals contain ':'; IPv6 is skipped when
  # the kernel has no IPv6). `return 0` keeps `_ipt=$(ipt_bin …)` from tripping
  # `set -e` on the no-match case. ACCEPTs below are fail-safe, so tolerated.
  ipt_bin() {
    case "$1" in
      *:*) [ "$HAVE_IP6" = "1" ] && echo ip6tables ;;
      *) echo iptables ;;
    esac
    return 0
  }
  allow_dst() {
    _ipt=$(ipt_bin "$1"); [ -n "$_ipt" ] || return 0
    "$_ipt" -A OUTPUT -d "$1" -j ACCEPT 2>/dev/null || true
  }
  allow_dns() {
    _ipt=$(ipt_bin "$1"); [ -n "$_ipt" ] || return 0
    "$_ipt" -A OUTPUT -p udp -d "$1" --dport 53 -j ACCEPT 2>/dev/null || true
    "$_ipt" -A OUTPUT -p tcp -d "$1" --dport 53 -j ACCEPT 2>/dev/null || true
  }

  # Allow loopback and established connections (both families).
  iptables -A OUTPUT -o lo -j ACCEPT || fail_closed "loopback rule"
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || \
    iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT || \
    fail_closed "established/related rule"
  if [ "$HAVE_IP6" = "1" ]; then
    ip6tables -A OUTPUT -o lo -j ACCEPT || fail_closed "IPv6 loopback rule"
    ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || \
      ip6tables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT || \
      fail_closed "IPv6 established/related rule"
  fi

  # Allow DNS only to the container's configured resolvers, not to any host —
  # an open :53 to the world is a ready-made exfiltration channel.
  for ns in $(awk '/^nameserver/ {print $2}' /etc/resolv.conf 2>/dev/null); do
    allow_dns "$ns"
  done

  # Allow declared hosts (resolve domains to IPs at startup), dispatching each
  # resolved address to the matching IPv4/IPv6 table.
  for host in $(printf '%s' "${CCPOD_ALLOWED_HOSTS:-}" | tr ',' '\n'); do
    [ -z "$host" ] && continue
    case "$host" in
      *.*.*.*|*:*|*/*)
        # IP address or CIDR — use directly
        allow_dst "$host"
        ;;
      *)
        # Hostname — resolve to IPs (may return both A and AAAA)
        for ip in $(getent hosts "$host" 2>/dev/null | awk '{print $1}'); do
          allow_dst "$ip"
        done
        ;;
    esac
  done

  # Drop all other outbound — the load-bearing rules; if they do not install,
  # we are not actually restricted.
  iptables -A OUTPUT -j DROP || fail_closed "default-deny rule"
  if [ "$HAVE_IP6" = "1" ]; then
    ip6tables -A OUTPUT -j DROP || fail_closed "IPv6 default-deny rule"
  fi

  echo "ccpod: restricted network active (allowed: ${CCPOD_ALLOWED_HOSTS:-none})"
fi

# Drop to node user. In shell mode exec directly so bash gets TTY process group
# control (backgrounding prevents tcsetpgrp and causes immediate exit).
if [ "${CCPOD_SHELL_MODE}" = "1" ]; then
  exec env HOME="${NODE_HOME}" PATH="${PATH}" gosu node "$@"
fi

HOME="${NODE_HOME}" PATH="${PATH}" gosu node "$@" &
CHILD_PID=$!
trap "kill -TERM $CHILD_PID 2>/dev/null" TERM INT HUP
wait $CHILD_PID || STATUS=$?
STATUS=${STATUS:-0}

# Write both auth files back so they persist across container restarts
# (root can read node-owned files, so no permission issue here)
cp -f "${CLAUDE_DIR}/.credentials.json" /ccpod/credentials/.credentials.json 2>/dev/null || true
cp -f "${NODE_HOME}/.claude.json" /ccpod/credentials/.claude.json 2>/dev/null || true

exit $STATUS
