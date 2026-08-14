# Native-host build of Piston. The published image is amd64-only; running its
# isolate binary through emulation on an arm64 Docker host makes clone(2) fail.

FROM alpine/git:2.49.1 AS piston-source
RUN git clone https://github.com/engineer-man/piston.git /src \
    && cd /src \
    && git checkout 0a844d0a3c040dfe3adf1e9d903b9ad4e5ede155

FROM buildpack-deps:buster AS isolate
RUN sed -i \
      -e 's|deb.debian.org/debian|archive.debian.org/debian|g' \
      -e 's|security.debian.org/debian-security|archive.debian.org/debian-security|g' \
      -e '/buster-updates/d' \
      /etc/apt/sources.list \
    && printf 'Acquire::Check-Valid-Until "false";\n' >/etc/apt/apt.conf.d/99archive \
    && apt-get update \
    && apt-get install -y --no-install-recommends git libcap-dev \
    && rm -rf /var/lib/apt/lists/* \
    && git clone https://github.com/envicutor/isolate.git /tmp/isolate \
    && cd /tmp/isolate \
    && git checkout af6db68042c3aa0ded80787fbb78bc0846ea2114 \
    && make -j"$(nproc)" install \
    && rm -rf /tmp/*

FROM rust:1.80.1-bookworm AS rust-toolchain

FROM node:22.18.0-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends libxml2 gnupg tar coreutils util-linux libc6-dev \
      binutils build-essential locales libpcre3-dev libevent-dev libgmp3-dev \
      libncurses6 libncurses-dev libedit-dev libseccomp-dev rename procps python3 \
      python3-pip python3-venv libreadline-dev libcap-dev \
    && test -s /usr/lib/gcc/aarch64-linux-gnu/12/collect2 \
    && /usr/lib/gcc/aarch64-linux-gnu/12/collect2 --version >/dev/null \
    && rm -rf /var/lib/apt/lists/*

RUN /usr/sbin/useradd --system --no-create-home piston && /usr/bin/id piston
COPY --from=isolate /usr/local/bin/isolate /usr/local/bin/isolate
COPY --from=isolate /usr/local/etc/isolate /usr/local/etc/isolate
COPY --from=rust-toolchain /usr/local/cargo /usr/local/cargo
COPY --from=rust-toolchain /usr/local/rustup /usr/local/rustup
ENV PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin
RUN npm install --global typescript@5.9.2
RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen

WORKDIR /piston_api
COPY --from=piston-source /src/api/package.json /src/api/package-lock.json ./
RUN npm install
COPY --from=piston-source /src/api/src ./src
COPY deploy/piston/install-system-python.sh /opt/foundry/install-system-python.sh
COPY deploy/piston/install-foundry-product.sh /opt/foundry/install-foundry-product.sh
COPY deploy/piston/product-runtime.js /opt/foundry/product-runtime.js

CMD ["/piston_api/src/docker-entrypoint.sh"]
EXPOSE 2000/tcp
