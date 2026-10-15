# SPDX-License-Identifier: AGPL-3.0-or-later
# Self-hosted Someday (docs/self-hosting.md): one Bun process serving the API
# and the PWA, data in SQLite on the /data volume.
#
#   BUILDAH_FORMAT=docker podman build \
#     --build-arg BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
#     --build-arg GIT_REVISION="$(git describe --always --dirty --abbrev=40)" \
#     --build-arg APP_VERSION="$(jq -r .version package.json)" \
#     -t someday .
#
# BUILDAH_FORMAT=docker keeps the HEALTHCHECK (the OCI format drops it).

ARG BUN_VERSION=1.4.2

FROM docker.io/oven/bun:${BUN_VERSION} AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
ARG APP_VERSION=0.0.0-dev
ARG GIT_REVISION=unknown
ARG SOURCE_URL=https://github.com/olemd/someday
# Version, SHA and source URL are baked into the PWA footer at build time.
ENV APP_VERSION=${APP_VERSION} GIT_SHA=${GIT_REVISION} SOURCE_URL=${SOURCE_URL}
RUN bun scripts/i18n-index.ts \
 && bun --bun node_modules/vite/bin/vite.js build \
 && bun build src/platform/bun/server.ts --target bun --outfile dist/server/server.js

FROM docker.io/oven/bun:${BUN_VERSION}-slim
ARG BUILD_DATE=unknown
ARG GIT_REVISION=unknown
ARG APP_VERSION=0.0.0-dev
ARG SOURCE_URL=https://github.com/olemd/someday
LABEL org.opencontainers.image.title="Someday" \
      org.opencontainers.image.description="Things to do or find out about some day, self-hosted" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later" \
      org.opencontainers.image.source="${SOURCE_URL}" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.revision="${GIT_REVISION}"
# The bun image's `bun` user is uid 1000.
RUN printf 'build_date=%s\ngit_revision=%s\napp_version=%s\n' "${BUILD_DATE}" "${GIT_REVISION}" "${APP_VERSION}" > /etc/build-info \
 && mkdir -p /data && chown 1000:1000 /data
WORKDIR /app
COPY --from=build /src/dist/web ./web
COPY --from=build /src/dist/server/server.js ./server.js
COPY --from=build /src/migrations ./migrations
ENV HOST=0.0.0.0 \
    PORT=8080 \
    DATABASE_PATH=/data/someday.db \
    STATIC_DIR=/app/web \
    MIGRATIONS_DIR=/app/migrations \
    APP_VERSION=${APP_VERSION} \
    GIT_SHA=${GIT_REVISION} \
    SOURCE_URL=${SOURCE_URL}
USER 1000:1000
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/healthz`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "server.js"]
