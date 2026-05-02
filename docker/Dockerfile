FROM node:24-slim

# Install system deps + tools Claude Code actively uses:
#   ripgrep  — Grep tool falls back to system rg on npm builds
#   gh       — GitHub operations (Claude Code uses gh CLI directly)
#   jq       — JSON processing
#   fd-find  — fast find alternative
#   fzf      — fuzzy search (in Anthropic's official devcontainer)
#   procps   — ps/process inspection
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    gosu \
    iptables \
    openssh-client \
    curl \
    wget \
    ca-certificates \
    gnupg \
    ripgrep \
    jq \
    fd-find \
    fzf \
    procps \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && apt-get autoremove -y && apt-get clean -y \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /tmp/* \
  && npm install -g --no-fund --no-audit @anthropic-ai/claude-code \
  && npm cache clean --force

WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["claude"]
