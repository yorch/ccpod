#!/bin/sh
set -e

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
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
  cp -f /ccpod/credentials/.claude.json "${HOME}/.claude.json"
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

# 5. Delta-install missing plugins (comma-separated list from env)
if [ -n "${CCPOD_PLUGINS_TO_INSTALL}" ]; then
  for plugin in $(printf '%s' "${CCPOD_PLUGINS_TO_INSTALL}" | tr ',' '\n'); do
    if [ -n "${plugin}" ] && [ ! -d "${CLAUDE_DIR}/plugins/${plugin}" ]; then
      echo "ccpod: installing plugin: ${plugin}"
      claude plugin install "${plugin}" 2>/dev/null || true
    fi
  done
fi

# 6. Network restriction — apply iptables rules before launching claude
if [ "${CCPOD_NETWORK_POLICY}" = "restricted" ]; then
  # Allow loopback and established connections
  iptables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
  iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || \
    iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
  # Allow DNS so hostname resolution works
  iptables -A OUTPUT -p udp --dport 53 -j ACCEPT 2>/dev/null || true
  iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT 2>/dev/null || true
  # Allow declared hosts (resolve domains to IPs at startup)
  for host in $(printf '%s' "${CCPOD_ALLOWED_HOSTS:-}" | tr ',' '\n'); do
    [ -z "$host" ] && continue
    case "$host" in
      *.*.*.*|*:*|*/*)
        # IP address or CIDR — use directly
        iptables -A OUTPUT -d "$host" -j ACCEPT 2>/dev/null || true
        ;;
      *)
        # Hostname — resolve to IPs
        for ip in $(getent hosts "$host" 2>/dev/null | awk '{print $1}'); do
          iptables -A OUTPUT -d "$ip" -j ACCEPT 2>/dev/null || true
        done
        ;;
    esac
  done
  # Drop all other outbound
  iptables -A OUTPUT -j DROP 2>/dev/null || true
  echo "ccpod: restricted network active (allowed: ${CCPOD_ALLOWED_HOSTS:-none})"
fi

"$@" &
CHILD_PID=$!
trap "kill -TERM $CHILD_PID 2>/dev/null" TERM INT HUP
wait $CHILD_PID || STATUS=$?
STATUS=${STATUS:-0}

# Write both auth files back so they persist across container restarts
cp -f "${CLAUDE_DIR}/.credentials.json" /ccpod/credentials/.credentials.json 2>/dev/null || true
cp -f "${HOME}/.claude.json" /ccpod/credentials/.claude.json 2>/dev/null || true

exit $STATUS
