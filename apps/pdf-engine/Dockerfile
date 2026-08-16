# syntax=docker/dockerfile:1.19
ARG NODE_IMAGE=node@sha256:036dfa7e82a1e867b09248440a2b6635b3f8de557f69e60bac923a10c6e696a8
ARG DEBIAN_IMAGE=debian@sha256:3a39a0592364683e6bab97937b72cad5a8fa6dcbbee90edb3bb48c7f8e94f258
ARG DISTROLESS_NODE_IMAGE=gcr.io/distroless/nodejs24-debian13@sha256:fbbdda866ea71aef98c4abece17e3d61fbf820cc2ef3961522caa2478716171a

FROM ${DISTROLESS_NODE_IMAGE} AS distroless

FROM ${NODE_IMAGE} AS app-build
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

FROM ${DEBIAN_IMAGE} AS native-build
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20260815T000000Z|g' \
      -e 's|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/20260815T000000Z|g' \
      /etc/apt/sources.list.d/debian.sources \
  && printf 'Acquire::Check-Valid-Until "false";\n' >/etc/apt/apt.conf.d/99snapshot \
  && apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates cmake curl g++ jq libjpeg62-turbo-dev libssl-dev make ninja-build pkg-config zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*
COPY apps/pdf-engine/native/build-qpdf.sh /usr/local/src/build-qpdf.sh
COPY apps/pdf-engine/native/sources.lock.json /usr/local/src/sources.lock.json
RUN /usr/local/src/build-qpdf.sh

FROM native-build AS runtime-files
COPY --from=app-build /src/apps/pdf-engine/dist/ /runtime-root/app/dist/
COPY --from=distroless /usr/share/doc/libssl3t64/copyright /runtime-root/licenses/debian/libssl3/copyright
COPY scripts/copy-distroless-runtime-deps.sh /usr/local/src/copy-distroless-runtime-deps.sh
COPY apps/pdf-engine/native/sources.lock.json /runtime-root/licenses/sources.lock.json
COPY apps/pdf-engine/licenses/policy.json /runtime-root/licenses/policy.json
RUN install -d /runtime-root/usr/local/bin /runtime-root/usr/local/lib \
  && cp -a /opt/qpdf/bin/qpdf /runtime-root/usr/local/bin/qpdf \
  && cp -a /opt/qpdf/lib/. /runtime-root/usr/local/lib/ \
  && cp -a /licenses/. /runtime-root/licenses/ \
  && LD_LIBRARY_PATH=/runtime-root/usr/local/lib \
    bash /usr/local/src/copy-distroless-runtime-deps.sh /runtime-root \
      /runtime-root/usr/local/bin /runtime-root/usr/local/lib \
      >/tmp/debian-packages.tsv \
  && install -Dm644 /usr/share/doc/libjpeg62-turbo/copyright \
      /runtime-root/licenses/debian/libjpeg62-turbo/copyright \
  && chmod -R a=rX /runtime-root/app /runtime-root/licenses /runtime-root/usr \
  && install -d -m 0700 -o 10001 -g 10001 /runtime-root/tmp/hereisit-pdf-engine \
  && test "$(stat -c %a /runtime-root/app)" = 555 \
  && test "$(stat -c %a /runtime-root/licenses)" = 555

FROM ${DISTROLESS_NODE_IMAGE} AS runtime
COPY --from=runtime-files /runtime-root /
ENV NODE_ENV=production LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC \
  LD_LIBRARY_PATH=/usr/local/lib \
  WORKSPACE_ROOT=/tmp/hereisit-pdf-engine \
  ENGINE_BUILD_ID=hereisit-pdf-engine-qpdf-12.4.0 \
  QPDF_BUILD_ID=12.4.0
USER 10001:10001
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/server.mjs"]

FROM runtime AS production
