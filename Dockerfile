# syntax=docker/dockerfile:1
#
# Restock server: a small image (node:22-alpine) that runs as the "node" user (uid 1000), keeps
# everything in /data, and works with a read-only root filesystem.
#
# The web app is the Restock web build from the Restock repo (https://github.com/d-plenty/Restock).
#   WEB=auto  (default) use public/app/ from the build context if it's there, otherwise fetch
#             Restock at RESTOCK_REF and build it (needs network)
#   WEB=fetch always fetch and build
#   WEB=local only use public/app/ from the build context (no network), fail if it's missing
# For a local build: in a Restock checkout run `npm run build:server-web` (it writes
# server/public/app/), copy that folder here as public/app/, then `docker build -t restock-server .`

ARG NODE_IMAGE=node:22-alpine
# The web app is built on Debian: Vite's native helpers are surest there. Nothing from it ships but the built files.
ARG WEB_BUILD_IMAGE=node:22-bookworm-slim

# ---- 1. the web app (built once, on the build machine's own platform: it's the same files for every platform) ----
FROM --platform=$BUILDPLATFORM ${WEB_BUILD_IMAGE} AS web
ARG WEB=auto
ARG RESTOCK_REF=v0.9.2
ARG RESTOCK_REPO=https://github.com/d-plenty/Restock
ARG RESTOCK_WEB_OUT=server/public/app
WORKDIR /work
COPY public/ ./context-public/
RUN set -eu; \
    if [ "$WEB" != "fetch" ] && [ -f context-public/app/index.html ]; then \
      echo "Web app: using public/app/ from the build context"; \
      mv context-public/app /web; \
    elif [ "$WEB" = "local" ]; then \
      echo "WEB=local, but public/app/index.html isn't in the build context. Build it in Restock with: npm run build:server-web" >&2; \
      exit 1; \
    else \
      echo "Web app: building Restock $RESTOCK_REF"; \
      apt-get update; apt-get install -y --no-install-recommends git ca-certificates; \
      git clone --depth 1 --branch "$RESTOCK_REF" "$RESTOCK_REPO" restock; \
      cd restock; \
      npm ci --no-audit --no-fund; \
      npm run build:server-web; \
      test -f "$RESTOCK_WEB_OUT/index.html"; \
      mv "$RESTOCK_WEB_OUT" /web; \
    fi; \
    find /web -name '*.map' -delete; \
    rm -rf /work

# ---- 2. the server ----
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Restock server" \
      org.opencontainers.image.description="Self-hosted, end-to-end encrypted sync and web app for a Restock household" \
      org.opencontainers.image.licenses="GPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/d-plenty/restock-server"
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
WORKDIR /app
# No npm packages: the server only needs Node itself.
COPY package.json LICENSE ./
COPY src ./src
COPY public/setup ./public/setup
COPY --from=web /web ./public/app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/v2/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/server.mjs"]
