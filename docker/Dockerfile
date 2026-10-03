# uv is copied from its official image; the tag is pinned so builds are
# reproducible; bump deliberately. PRs touching docker/ build and smoke-test
# the image (.github/workflows/docker-check.yml).
FROM ghcr.io/astral-sh/uv:0.12.22 AS uv

FROM node:24-slim

# bun is installed with its official script at a pinned release.
ARG BUN_VERSION=1.4.2

# Install system deps + tools Claude Code actively uses:
#   ripgrep  — Grep tool falls back to system rg
#   gh       — GitHub operations (Claude Code uses gh CLI directly)
#   jq       — JSON processing
#   fd-find  — fast find alternative
#   fzf      — fuzzy search (in Anthropic's official devcontainer)
#   procps   — ps/process inspection
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fd-find \
    fzf \
    git \
    gnupg \
    gosu \
    iptables \
    jq \
    openssh-client \
    procps \
    ripgrep \
    unzip \
    wget \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | gpg --dearmor -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends gh \
  && apt-get autoremove -y && apt-get clean -y \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf /tmp/*

# Install uv
COPY --from=uv /uv /uvx /bin/

USER node

# Install claude as the node user so it lands in /home/node/.local/bin —
# user-writable, allowing auto-updates without root. Deliberately NOT pinned:
# Claude Code updates itself, and a stale pinned version would only fall behind
# on fixes; the image is rebuilt on every ccpod release.
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/node/.local/bin:${PATH}"

# Install bun
RUN curl -fsSL https://bun.com/install | bash -s "bun-v${BUN_VERSION}"
ENV PATH="/home/node/.bun/bin:${PATH}"

USER root

WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["claude"]
