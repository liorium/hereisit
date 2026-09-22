# syntax=docker/dockerfile:1.7

ARG RUST_IMAGE=rust@sha256:af306cfa71d987911a781c37b59d7d67d934f49684058f96cf72079c3626bfe0
ARG NODE_IMAGE=node@sha256:036dfa7e82a1e867b09248440a2b6635b3f8de557f69e60bac923a10c6e696a8
ARG NODE_RUNTIME_IMAGE=node@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
ARG UBUNTU_IMAGE=ubuntu@sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3

FROM --platform=linux/amd64 ${NODE_IMAGE} AS node-distribution
FROM --platform=linux/amd64 ${NODE_RUNTIME_IMAGE} AS node-runtime-distribution

FROM --platform=linux/amd64 ${RUST_IMAGE} AS rust-build
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN sed -i \
      -e 's|http://deb.debian.org/debian-security|http://snapshot.debian.org/archive/debian-security/20260918T000000Z|g' \
      -e 's|http://deb.debian.org/debian|http://snapshot.debian.org/archive/debian/20260918T000000Z|g' \
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

FROM --platform=linux/amd64 ${UBUNTU_IMAGE} AS native-build
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
COPY --from=node-distribution /usr/local/ /usr/local/
COPY --from=rust-build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
RUN sed -i \
      -e 's|^URIs:.*|URIs: https://snapshot.ubuntu.com/ubuntu/20260918T000000Z/|' \
      -e 's/ noble-backports//' \
      -e 's/Components: .*/Components: main universe/' \
      /etc/apt/sources.list.d/ubuntu.sources \
  && printf 'Acquire::Check-Valid-Until "false";\nAPT::Update::Error-Mode "any";\n' >/etc/apt/apt.conf.d/99snapshot \
  && apt-get update \
  && apt-get upgrade -y \
  && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      cmake \
      git \
      jq \
      libexif-dev \
      libglib2.0-dev \
      liblcms2-dev \
      libpng-dev \
      meson \
      nasm \
      ninja-build \
      pkg-config \
      python3 \
  && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libc6)" ge 2.39-0ubuntu8.9 \
  && test "$(node --version)" = v24.13.0 \
  && rm -rf /var/lib/apt/lists/*
COPY apps/image-engine/native/build-common.sh /build/native/
COPY apps/image-engine/native/build-mozjpeg.sh /build/native/
RUN /build/native/build-mozjpeg.sh
COPY apps/image-engine/native/build-libwebp.sh /build/native/
RUN /build/native/build-libwebp.sh
COPY apps/image-engine/native/build-expat.sh /build/native/
RUN /build/native/build-expat.sh
RUN apt-get update \
  && apt-get install -y --no-install-recommends bison flex \
  && rm -rf /var/lib/apt/lists/*
COPY apps/image-engine/native/build-util-linux.sh /build/native/
RUN /build/native/build-util-linux.sh
COPY apps/image-engine/native/build-libvips.sh /build/native/
RUN /build/native/build-libvips.sh
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
RUN corepack enable pnpm \
  && corepack prepare pnpm@11.11.0 --activate \
  && pnpm install --filter @hereisit/image-engine... --frozen-lockfile --no-optional --ignore-scripts \
  && test "$(apps/image-engine/node_modules/esbuild/bin/esbuild --version)" = "0.28.1" \
  && test "$(apps/image-engine/node_modules/@esbuild/linux-x64/bin/esbuild --version)" = "0.28.1" \
  && ! find node_modules apps/image-engine/node_modules -path '*/@img/sharp-*' -print -quit | grep .
ENV PKG_CONFIG_PATH=/opt/hereisit-native/libvips/lib/pkgconfig:/opt/hereisit-native/expat/lib/pkgconfig:/opt/hereisit-native/mozjpeg/lib/pkgconfig:/opt/hereisit-native/libwebp/lib/pkgconfig
ENV LD_LIBRARY_PATH=/opt/hereisit-native/libvips/lib:/opt/hereisit-native/expat/lib:/opt/hereisit-native/util-linux/lib:/opt/hereisit-native/libwebp/lib
RUN cd apps/image-engine/node_modules/sharp \
  && PATH=/src/apps/image-engine/node_modules/.bin:$PATH SHARP_FORCE_GLOBAL_LIBVIPS=1 \
    node install/build.js \
  && cd /src \
  && node -e 'const sharp = require("./apps/image-engine/node_modules/sharp"); if (sharp.versions.vips !== "8.18.6") throw new Error(`unexpected libvips ${sharp.versions.vips}`)' \
  && pnpm --filter @hereisit/image-engine build \
  && test -f apps/image-engine/dist/server.mjs \
  && test -f apps/image-engine/dist/job/job-runner.mjs \
  && pnpm --filter @hereisit/image-engine deploy --prod --no-optional --legacy /opt/app \
  && ! find /opt/app/node_modules -path '*/@img/sharp-*' -print -quit | grep . \
  && install -Dm755 apps/image-engine/node_modules/sharp/src/build/Release/sharp-linux-x64-0.35.4.node \
      "$(readlink -f /opt/app/node_modules/sharp)/src/build/Release/sharp-linux-x64-0.35.4.node" \
  && node -e 'const sharp = require("/opt/app/node_modules/sharp"); if (sharp.versions.vips !== "8.18.6") throw new Error(`unexpected deployed libvips ${sharp.versions.vips}`)' \
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
COPY --from=node-runtime-distribution /usr/local/bin/node /runtime-root/nodejs/bin/node
COPY --from=node-runtime-distribution /usr/local/LICENSE /runtime-root/licenses/node/LICENSE
COPY --from=rust-build /opt/hereisit-native/oxipng/bin/ /runtime-root/usr/local/bin/
COPY --from=rust-build /opt/hereisit-native/png-smart/bin/ /runtime-root/usr/local/bin/
COPY --from=rust-build /licenses/ /runtime-root/licenses/
COPY --from=rust-build /build-metadata/ /runtime-root/build-metadata/
RUN install -d /runtime-root/usr/local/lib /runtime-root/usr/lib /runtime-root/usr/lib64 /runtime-root/etc/ssl/certs \
  && ln -s usr/lib /runtime-root/lib \
  && ln -s usr/lib64 /runtime-root/lib64 \
  && cp /etc/os-release /etc/nsswitch.conf /runtime-root/etc/ \
  && cp /etc/ssl/certs/ca-certificates.crt /runtime-root/etc/ssl/certs/ \
  && printf 'hereisit:x:10001:10001:HereIsIt:/home/hereisit:/sbin/nologin\n' >/runtime-root/etc/passwd \
  && printf 'hereisit:x:10001:\n' >/runtime-root/etc/group \
  && cp -a /usr/lib/locale /runtime-root/usr/lib/ \
  && cp -a /opt/app /runtime-root/app \
  && cp -a /opt/hereisit-native/mozjpeg/bin/. /runtime-root/usr/local/bin/ \
  && cp -a /opt/hereisit-native/libwebp/bin/. /runtime-root/usr/local/bin/ \
  && cp -a /opt/hereisit-native/libwebp/lib/. /runtime-root/usr/local/lib/ \
  && cp -a /opt/hereisit-native/libvips/lib/. /runtime-root/usr/local/lib/ \
  && cp -a /opt/hereisit-native/expat/lib/. /runtime-root/usr/local/lib/ \
  && cp -a /opt/hereisit-native/util-linux/lib/libblkid.so* \
      /opt/hereisit-native/util-linux/lib/libmount.so* /runtime-root/usr/local/lib/ \
  && cp -a /licenses/. /runtime-root/licenses/ \
  && cp -a /build-metadata/. /runtime-root/build-metadata/ \
  && cp apps/image-engine/native/sources.lock.json /runtime-root/licenses/sources.lock.json \
  && cp -a apps/image-engine/licenses /runtime-root/licenses/hereisit-policy \
  && LD_LIBRARY_PATH=/runtime-root/usr/local/lib \
    bash scripts/copy-distroless-runtime-deps.sh /runtime-root \
      /runtime-root/app /runtime-root/nodejs /runtime-root/usr/local/bin /runtime-root/usr/local/lib \
      >/tmp/debian-packages.tsv \
  && find /runtime-root/usr/share/doc -name copyright -type f -printf '/usr/share/doc/%P\n' \
      | sort >/tmp/debian-copyright-paths.txt \
  && node apps/image-engine/scripts/write-debian-inventory.mjs \
      /tmp/debian-packages.tsv /tmp/debian-copyright-paths.txt \
      /runtime-root/build-metadata/debian-packages.json \
  && node scripts/create-image-native-sbom.mjs /runtime-root \
  && chmod -R a=rX /runtime-root/app /runtime-root/licenses \
      /runtime-root/build-metadata /runtime-root/usr \
  && install -d -m 1777 /runtime-root/tmp \
  && install -d -m 0700 -o 10001 -g 10001 /runtime-root/work /runtime-root/home/hereisit \
  && chown -R 10001:10001 /runtime-root/app \
  && LD_LIBRARY_PATH=/usr/local/lib chroot --userspec=10001:10001 /runtime-root \
      /nodejs/bin/node /app/dist/server.mjs --self-test

FROM scratch AS runtime
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
