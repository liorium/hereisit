# syntax=docker/dockerfile:1.19
FROM node:24.13.0-bookworm-slim AS app-build
WORKDIR /src
ENV COREPACK_HOME=/opt/corepack PNPM_HOME=/opt/pnpm PATH=/opt/pnpm:$PATH
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY patches/ patches/
COPY packages/server-contracts/ packages/server-contracts/
COPY packages/tool-contracts/ packages/tool-contracts/
COPY apps/pdf-engine/ apps/pdf-engine/
RUN corepack enable && corepack prepare pnpm@11.11.0 --activate \
  && pnpm install --filter @hereisit/pdf-engine... --frozen-lockfile --ignore-scripts \
  && pnpm --filter @hereisit/pdf-engine build

FROM debian:bookworm-slim AS native-build
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates cmake curl g++ jq libjpeg62-turbo-dev libssl-dev make ninja-build pkg-config zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*
COPY apps/pdf-engine/native/build-qpdf.sh /usr/local/src/build-qpdf.sh
COPY apps/pdf-engine/native/sources.lock.json /usr/local/src/sources.lock.json
RUN /usr/local/src/build-qpdf.sh

FROM node:24.13.0-bookworm-slim AS runtime
WORKDIR /app
COPY --from=app-build /src/apps/pdf-engine/dist/ /app/dist/
COPY --from=native-build /opt/qpdf/bin/qpdf /usr/local/bin/qpdf
COPY --from=native-build /opt/qpdf/lib/ /usr/local/lib/
COPY --from=native-build /usr/lib/x86_64-linux-gnu/libjpeg.so.62* /usr/local/lib/
COPY --from=native-build /usr/lib/x86_64-linux-gnu/libcrypto.so.3 /usr/lib/x86_64-linux-gnu/libssl.so.3 /usr/local/lib/
COPY --from=native-build /licenses/ /licenses/
COPY --from=native-build /usr/share/doc/libjpeg62-turbo/copyright /licenses/debian/libjpeg62-turbo/copyright
COPY --from=native-build /usr/share/doc/libssl3/copyright /licenses/debian/libssl3/copyright
COPY apps/pdf-engine/native/sources.lock.json /licenses/sources.lock.json
COPY apps/pdf-engine/licenses/policy.json /licenses/policy.json
RUN ldconfig \
  && rm -rf /opt/yarn-v1.22.22 /usr/local/lib/node_modules \
  && rm -f /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/docker-entrypoint.sh \
  && groupadd --gid 10001 hereisit \
  && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin hereisit \
  && install -d -m 0700 -o 10001 -g 10001 /tmp/hereisit-pdf-engine \
  && chmod -R a=rX /app /licenses /usr/local/bin/qpdf /usr/local/lib \
  && test "$(stat -c %a /app)" = 555 && test "$(stat -c %a /licenses)" = 555
ENV NODE_ENV=production LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
  WORKSPACE_ROOT=/tmp/hereisit-pdf-engine \
  ENGINE_BUILD_ID=hereisit-pdf-engine-qpdf-12.4.0 \
  QPDF_BUILD_ID=12.4.0
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "/app/dist/server.mjs"]
