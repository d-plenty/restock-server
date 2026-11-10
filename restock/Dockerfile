# Home Assistant builds this on install. It's the published Restock server image, run with the
# app's options (see run.mjs). Home Assistant gives apps a /data folder owned by root, so this runs
# as root inside its own container.
ARG BUILD_FROM
FROM ghcr.io/d-plenty/restock-server:0.9.3
USER root
COPY run.mjs /app/run.mjs
CMD ["node", "/app/run.mjs"]
