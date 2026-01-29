ARG BUN_IMAGE=oven/bun:1.1.38-alpine
FROM ${BUN_IMAGE}

WORKDIR /app

RUN apk add --no-cache python3 make g++ curl ca-certificates

COPY package.json bun.lock ./
RUN bun install --production --frozen-lockfile

COPY . .

RUN set -eux; \
    arch="$(uname -m)"; \
    if [ "$arch" = "x86_64" ]; then ngrok_arch="amd64"; \
    elif [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ]; then ngrok_arch="arm64"; \
    else echo "Unsupported arch: $arch" >&2; exit 1; fi; \
    curl -fsSL "https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${ngrok_arch}.tgz" -o /tmp/ngrok.tgz; \
    tar -xzf /tmp/ngrok.tgz -C /usr/local/bin; \
    rm /tmp/ngrok.tgz

ENV NODE_ENV=production
ENV HOME=/app/data

RUN mkdir -p /app/data

EXPOSE 8964 51121

CMD ["bun", "run", "src/main.ts", "start"]
