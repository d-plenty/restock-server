# Home Assistant builds this on install. It's the published Restock server image, run with the
# app's options (see run.mjs). Home Assistant gives apps a /data folder owned by root, so run.mjs
# starts as root, gives the server's own folder (/data/restock) to user 1000 and runs the server as it.
ARG BUILD_FROM
FROM ghcr.io/d-plenty/restock-server:0.9.12
USER root
COPY run.mjs /app/run.mjs
CMD ["node", "/app/run.mjs"]
