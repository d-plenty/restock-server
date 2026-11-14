# syntax=docker/dockerfile:1
#
# Restock server: a small image (node:22-alpine) that runs as the "node" user (uid 1000), keeps
# everything in /data, and works with a read-only root filesystem.
#
# Two things come from the Restock repo (https://github.com/d-plenty/Restock) at the same tag:
# the web app (the Restock web build) and the Restock core (core/restock-core.mjs: the merge,
# crypto and Home Assistant code the server runs for 0.9.4's server-first households).
#   WEB=auto  (default) use public/app/ and core/ from the build context if both are there,
#             otherwise fetch Restock at RESTOCK_REF and build them (needs network)
#   WEB=fetch always fetch and build
#   WEB=local only use public/app/ and core/ from the build context (no network), fail if missing
# For a local build: in a Restock checkout run `npm run build:server-web` (it writes
# server/public/app/) and `npm run build:server-core` (server/core/), copy both folders here,
# then `docker build -t restock-server .`

# Node 22.13 or newer (node:sqlite). Pinned to a minor so a rebuild doesn't change it underneath.
ARG NODE_IMAGE=node:22.23-alpine
# The web app is built on Debian: Vite's native helpers are surest there. Nothing from it ships but the built files.
ARG WEB_BUILD_IMAGE=node:22.23-bookworm-slim

# ---- 1. the web app and the core (built once, on the build machine's own platform: the same files for every platform) ----
FROM --platform=$BUILDPLATFORM ${WEB_BUILD_IMAGE} AS web
ARG WEB=auto
ARG RESTOCK_REF=v0.10.8
ARG RESTOCK_REPO=https://github.com/d-plenty/Restock
ARG RESTOCK_WEB_OUT=server/public/app
WORKDIR /work
COPY public/ ./context-public/
# core/ may be missing from the context: package.json makes the pattern match something either way.
COPY package.json core*/restock-core.mjs ./context-core/
RUN set -eu; \
    if [ "$WEB" != "fetch" ] && [ -f context-public/app/index.html ] && [ -f context-core/restock-core.mjs ]; then \
      echo "Web app and core: using public/app/ and core/ from the build context"; \
      mv context-public/app /web; \
      mkdir -p /core; mv context-core/restock-core.mjs /core/; \
    elif [ "$WEB" = "local" ]; then \
      echo "WEB=local, but public/app/index.html or core/restock-core.mjs isn't in the build context. Build them in Restock with: npm run build:server-web && npm run build:server-core" >&2; \
      exit 1; \
    else \
      echo "Web app and core: building Restock $RESTOCK_REF"; \
      apt-get update; apt-get install -y --no-install-recommends git ca-certificates; \
      git clone --depth 1 --branch "$RESTOCK_REF" "$RESTOCK_REPO" restock; \
      cd restock; \
      npm ci --no-audit --no-fund; \
      npm run build:server-web; \
      SERVER_CORE_OUT=/core npm run build:server-core; \
      test -f "$RESTOCK_WEB_OUT/index.html"; \
      test -f /core/restock-core.mjs; \
      mv "$RESTOCK_WEB_OUT" /web; \
    fi; \
    find /web -name '*.map' -delete; \
    rm -rf /work

# ---- 2. the server ----
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="Restock server" \
      org.opencontainers.image.description="Self-hosted server for a Restock household: sync at home and away, price history, Home Assistant and the web app" \
      org.opencontainers.image.licenses="GPL-3.0-only" \
      org.opencontainers.image.source="https://github.com/d-plenty/restock-server"
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
WORKDIR /app
# No npm packages: the server only needs Node itself.
COPY package.json LICENSE ./
COPY src ./src
COPY scripts ./scripts
COPY public/setup ./public/setup
COPY --from=web /web ./public/app
COPY --from=web /core ./core
# tzdata: so TZ (compose.yaml) is a real zone for the system too (the server itself works out
# months and days with Node's own time zone data). About 1.5 MB.
RUN apk add --no-cache tzdata && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=60s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/v2/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.mjs"]
