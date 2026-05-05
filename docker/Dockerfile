FROM node:24-slim

# Install system deps + tools Claude Code actively uses:
#   ripgrep  — Grep tool falls back to system rg
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
  && rm -rf /tmp/*

# Install claude as the node user so it lands in /home/node/.local/bin —
# user-writable, allowing auto-updates without root.
USER node
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/node/.local/bin:$PATH"
USER root

WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["claude"]
