# syntax=docker/dockerfile:1.7

ARG RUST_IMAGE=rust@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0
ARG NODE_IMAGE=node@sha256:4660b1ca8b28d6d1906fd644abe34b2ed81d15434d26d845ef0aced307cf4b6f

FROM --platform=linux/amd64 ${RUST_IMAGE} AS rust-build
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20260716T000000Z|g' \
      -e 's|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/20260716T000000Z|g' \
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
      -e 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20260716T000000Z|g' \
      -e 's|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/20260716T000000Z|g' \
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
  && find /opt/app -mindepth 1 -maxdepth 1 \
      ! -name node_modules ! -name package.json -exec rm -rf {} +
RUN cp -a apps/image-engine/dist /opt/app/dist

FROM native-build AS benchmark-build
COPY apps/image-engine/native/build-jpegli.sh apps/image-engine/native/build-libjxl-metrics.sh \
  /build/native/
RUN /build/native/build-jpegli.sh \
  && /build/native/build-libjxl-metrics.sh

FROM --platform=linux/amd64 ${NODE_IMAGE} AS runtime
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20260716T000000Z|g' \
      -e 's|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/20260716T000000Z|g' \
      /etc/apt/sources.list.d/debian.sources \
  && printf 'Acquire::Check-Valid-Until "false";\n' >/etc/apt/apt.conf.d/99snapshot \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
      ca-certificates \
      libexif12 \
      libexpat1 \
      libglib2.0-0 \
      liblcms2-2 \
      libpng16-16 \
      libstdc++6 \
      zlib1g \
  && rm -rf /var/lib/apt/lists/*
COPY --from=node-build /opt/app /app
COPY --from=native-build /opt/hereisit-native/mozjpeg/bin/ /usr/local/bin/
COPY --from=native-build /opt/hereisit-native/libwebp/bin/ /usr/local/bin/
COPY --from=native-build /opt/hereisit-native/libwebp/lib/ /usr/local/lib/
COPY --from=native-build /opt/hereisit-native/libvips/lib/ /usr/local/lib/
COPY --from=rust-build /opt/hereisit-native/oxipng/bin/ /usr/local/bin/
COPY --from=rust-build /opt/hereisit-native/png-smart/bin/ /usr/local/bin/
COPY --from=native-build /licenses/ /licenses/
COPY --from=rust-build /licenses/ /licenses/
COPY --from=native-build /build-metadata/ /build-metadata/
COPY --from=rust-build /build-metadata/ /build-metadata/
COPY apps/image-engine/native/sources.lock.json /licenses/sources.lock.json
COPY apps/image-engine/licenses/ /licenses/hereisit-policy/
COPY apps/image-engine/security/ /security/
COPY apps/image-engine/scripts/write-debian-inventory.mjs /tmp/write-debian-inventory.mjs
RUN ldconfig \
  && rm -rf /opt/yarn-v1.22.22 /usr/local/lib/node_modules \
  && rm -f /usr/local/bin/corepack /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/docker-entrypoint.sh \
  && dpkg-query -W -f='${Package}\t${Version}\n' >/tmp/debian-packages.tsv \
  && find /usr/share/doc -name copyright -type f -print | sort >/tmp/debian-copyright-paths.txt \
  && node /tmp/write-debian-inventory.mjs \
      /tmp/debian-packages.tsv \
      /tmp/debian-copyright-paths.txt \
      /build-metadata/debian-packages.json \
  && rm -f /tmp/debian-packages.tsv /tmp/debian-copyright-paths.txt /tmp/write-debian-inventory.mjs \
  && chmod -R a=rX /licenses /security /build-metadata \
  && groupadd --gid 10001 hereisit \
  && useradd --uid 10001 --gid 10001 --create-home --shell /usr/sbin/nologin hereisit \
  && install -d -m 0700 -o 10001 -g 10001 /work \
  && chown -R 10001:10001 /app
ENV NODE_ENV=production LANG=C.UTF-8 LC_ALL=C.UTF-8 TZ=UTC
USER 10001:10001
WORKDIR /app
EXPOSE 8080
ENTRYPOINT ["node", "/app/dist/server.mjs"]

FROM runtime AS benchmark
USER 0:0
COPY --from=benchmark-build /opt/benchmark/ /opt/benchmark/
COPY --from=benchmark-build /licenses/ /licenses/
COPY --from=benchmark-build /build-metadata/ /build-metadata/
USER 10001:10001

FROM runtime AS production
