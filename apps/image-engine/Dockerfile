# syntax=docker/dockerfile:1.7

ARG RUST_IMAGE=rust@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0
ARG NODE_IMAGE=node@sha256:036dfa7e82a1e867b09248440a2b6635b3f8de557f69e60bac923a10c6e696a8
ARG DISTROLESS_NODE_IMAGE=gcr.io/distroless/nodejs24-debian13@sha256:fbbdda866ea71aef98c4abece17e3d61fbf820cc2ef3961522caa2478716171a

FROM --platform=linux/amd64 ${RUST_IMAGE} AS rust-build
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20260815T000000Z|g' \
      -e 's|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/20260815T000000Z|g' \
      /etc/apt/sources.list.d/debian.sources \
  && printf 'Acquire::Check-Valid-Until "false";\n' >/etc/apt/apt.conf.d/99snapshot \
  && apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git jq \
  && rm -rf /var/lib/apt/lists/*
COPY apps/image-engine/native/build-common.sh apps/image-engine/native/build-oxipng.sh \
  apps/image-engine/native/build-png-smart.sh apps/image-engine/native/sources.lock.json \
  /build/native/
COPY apps/image-engine/native/png-smart /build/native/png-smart
RUN /build/native/build-oxipng.sh \
  && /build/native/build-png-smart.sh

FROM --platform=linux/amd64 ${NODE_IMAGE} AS native-build
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20260815T000000Z|g' \
      -e 's|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/20260815T000000Z|g' \
      /etc/apt/sources.list.d/debian.sources \
  && printf 'Acquire::Check-Valid-Until "false";\n' >/etc/apt/apt.conf.d/99snapshot \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      cmake \
      git \
      jq \
      libexif-dev \
      libexpat1-dev \
      libglib2.0-dev \
      liblcms2-dev \
      libpng-dev \
      meson \
      nasm \
      ninja-build \
      pkg-config \
      python3 \
  && rm -rf /var/lib/apt/lists/*
COPY apps/image-engine/native/build-common.sh apps/image-engine/native/build-mozjpeg.sh \
  apps/image-engine/native/build-libwebp.sh apps/image-engine/native/build-libvips.sh \
  apps/image-engine/native/sources.lock.json /build/native/
RUN /build/native/build-mozjpeg.sh \
  && /build/native/build-libwebp.sh \
  && /build/native/build-libvips.sh
COPY apps/image-engine/native/jpeg-coeff-verify.c /build/native/jpeg-coeff-verify.c
RUN cc -O2 -D_FORTIFY_SOURCE=2 -fstack-protector-strong \
      -I/opt/hereisit-native/mozjpeg/include /build/native/jpeg-coeff-verify.c \
      -L/opt/hereisit-native/mozjpeg/lib -Wl,-Bstatic -ljpeg -Wl,-Bdynamic -lm \
      -o /opt/hereisit-native/mozjpeg/bin/jpeg-coeff-verify \
  && strip /opt/hereisit-native/mozjpeg/bin/jpeg-coeff-verify \
  && source /build/native/build-common.sh \
  && record_build mozjpeg a2d2907ff023227e80c1e4efa809812410275a12 \
      "release static simd no-java no-turbojpeg" /opt/hereisit-native/mozjpeg

FROM native-build AS node-build
WORKDIR /src
COPY . .
RUN corepack enable \
  && corepack prepare pnpm@11.11.0 --activate \
  && pnpm install --filter @hereisit/image-engine... --frozen-lockfile --no-optional --ignore-scripts \
  && test "$(apps/image-engine/node_modules/esbuild/bin/esbuild --version)" = "0.28.1" \
  && test "$(apps/image-engine/node_modules/@esbuild/linux-x64/bin/esbuild --version)" = "0.28.1" \
  && ! find node_modules apps/image-engine/node_modules -path '*/@img/sharp-*' -print -quit | grep .
ENV PKG_CONFIG_PATH=/opt/hereisit-native/libvips/lib/pkgconfig:/opt/hereisit-native/mozjpeg/lib/pkgconfig:/opt/hereisit-native/libwebp/lib/pkgconfig
ENV LD_LIBRARY_PATH=/opt/hereisit-native/libvips/lib:/opt/hereisit-native/libwebp/lib
RUN cd apps/image-engine/node_modules/sharp \
  && PATH=/src/apps/image-engine/node_modules/.bin:$PATH SHARP_FORCE_GLOBAL_LIBVIPS=1 \
    node install/build.js \
  && cd /src \
  && node -e 'const sharp = require("./apps/image-engine/node_modules/sharp"); if (sharp.versions.vips !== "8.18.4") throw new Error(`unexpected libvips ${sharp.versions.vips}`)' \
  && pnpm --filter @hereisit/image-engine build \
  && test -f apps/image-engine/dist/server.mjs \
  && test -f apps/image-engine/dist/job/job-runner.mjs \
  && pnpm --filter @hereisit/image-engine deploy --prod --no-optional --legacy /opt/app \
  && ! find /opt/app/node_modules -path '*/@img/sharp-*' -print -quit | grep . \
  && install -Dm755 apps/image-engine/node_modules/sharp/src/build/Release/sharp-linux-x64-0.35.3.node \
      "$(readlink -f /opt/app/node_modules/sharp)/src/build/Release/sharp-linux-x64-0.35.3.node" \
  && node -e 'const sharp = require("/opt/app/node_modules/sharp"); if (sharp.versions.vips !== "8.18.4") throw new Error(`unexpected deployed libvips ${sharp.versions.vips}`)' \
  && test "$(readlink /opt/app/node_modules/.pnpm/node_modules/@hereisit/image-engine)" = "../../../../../../src/apps/image-engine" \
  && unlink /opt/app/node_modules/.pnpm/node_modules/@hereisit/image-engine \
  && rm /opt/app/node_modules/.modules.yaml \
  && find /opt/app -mindepth 1 -maxdepth 1 \
      ! -name node_modules ! -name package.json -exec rm -rf {} +
RUN cp -a apps/image-engine/dist /opt/app/dist

FROM native-build AS benchmark-build
COPY apps/image-engine/native/build-jpegli.sh apps/image-engine/native/build-libjxl-metrics.sh \
  /build/native/
RUN /build/native/build-jpegli.sh \
  && /build/native/build-libjxl-metrics.sh

FROM node-build AS runtime-files
COPY --from=rust-build /opt/hereisit-native/oxipng/bin/ /runtime-root/usr/local/bin/
COPY --from=rust-build /opt/hereisit-native/png-smart/bin/ /runtime-root/usr/local/bin/
COPY --from=rust-build /licenses/ /runtime-root/licenses/
COPY --from=rust-build /build-metadata/ /runtime-root/build-metadata/
RUN install -d /runtime-root/usr/local/lib \
  && cp -a /opt/app /runtime-root/app \
  && cp -a /opt/hereisit-native/mozjpeg/bin/. /runtime-root/usr/local/bin/ \
  && cp -a /opt/hereisit-native/libwebp/bin/. /runtime-root/usr/local/bin/ \
  && cp -a /opt/hereisit-native/libwebp/lib/. /runtime-root/usr/local/lib/ \
  && cp -a /opt/hereisit-native/libvips/lib/. /runtime-root/usr/local/lib/ \
  && cp -a /licenses/. /runtime-root/licenses/ \
  && cp -a /build-metadata/. /runtime-root/build-metadata/ \
  && cp apps/image-engine/native/sources.lock.json /runtime-root/licenses/sources.lock.json \
  && cp -a apps/image-engine/licenses /runtime-root/licenses/hereisit-policy \
  && LD_LIBRARY_PATH=/runtime-root/usr/local/lib \
    bash scripts/copy-distroless-runtime-deps.sh /runtime-root \
      /runtime-root/app /runtime-root/usr/local/bin /runtime-root/usr/local/lib \
      >/tmp/debian-packages.tsv \
  && find /runtime-root/usr/share/doc -name copyright -type f -printf '/usr/share/doc/%P\n' \
      | sort >/tmp/debian-copyright-paths.txt \
  && node apps/image-engine/scripts/write-debian-inventory.mjs \
      /tmp/debian-packages.tsv /tmp/debian-copyright-paths.txt \
      /runtime-root/build-metadata/debian-packages.json \
  && chmod -R a=rX /runtime-root/app /runtime-root/licenses \
      /runtime-root/build-metadata /runtime-root/usr \
  && install -d -m 0700 -o 10001 -g 10001 /runtime-root/work /runtime-root/home/hereisit \
  && chown -R 10001:10001 /runtime-root/app

FROM ${DISTROLESS_NODE_IMAGE} AS runtime
COPY --from=runtime-files /runtime-root /
ENV NODE_ENV=production LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC HOME=/home/hereisit \
  LD_LIBRARY_PATH=/usr/local/lib
USER 10001:10001
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/server.mjs"]

FROM runtime AS benchmark
USER 0:0
COPY --from=benchmark-build /opt/benchmark/ /opt/benchmark/
COPY --from=benchmark-build /licenses/ /licenses/
COPY --from=benchmark-build /build-metadata/ /build-metadata/
USER 10001:10001

FROM runtime AS production
