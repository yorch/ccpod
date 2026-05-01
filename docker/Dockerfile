FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    openssh-client \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

WORKDIR /workspace

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["claude"]
