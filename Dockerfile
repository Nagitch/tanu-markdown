# syntax=docker/dockerfile:1.7
FROM rust:1.96.0-bookworm

ARG NODE_VERSION=24.17.0
ARG TARGETARCH

ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup \
    PATH=/usr/local/cargo/bin:/usr/local/node/bin:$PATH

# Install system libraries required by the Rust crates and basic devcontainer
# tooling expected by VS Code.
RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        libsqlite3-dev \
        libssl-dev \
        pkg-config \
        sudo \
        xz-utils \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install a fixed Node.js LTS release from the official Node.js binaries.
RUN set -eux; \
    case "${TARGETARCH}" in \
        "amd64") node_arch="x64" ;; \
        "arm64") node_arch="arm64" ;; \
        *) echo "Unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " node-v${NODE_VERSION}-linux-${node_arch}.tar.xz\$" SHASUMS256.txt | sha256sum -c -; \
    mkdir -p /usr/local/node; \
    tar -xJf "node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" -C /usr/local/node --strip-components=1; \
    rm "node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" SHASUMS256.txt; \
    ln -s /usr/local/node/bin/node /usr/local/bin/node; \
    ln -s /usr/local/node/bin/npm /usr/local/bin/npm; \
    ln -s /usr/local/node/bin/npx /usr/local/bin/npx; \
    ln -s /usr/local/node/bin/corepack /usr/local/bin/corepack; \
    node --version; \
    npm --version

# Keep formatting and lint components available without requiring post-create
# network access.
RUN rustup component add rustfmt clippy

# Expose Rust tools through the default system PATH as well as CARGO_HOME/PATH.
RUN ln -s /usr/local/cargo/bin/cargo /usr/local/bin/cargo \
    && ln -s /usr/local/cargo/bin/rustc /usr/local/bin/rustc \
    && ln -s /usr/local/cargo/bin/rustup /usr/local/bin/rustup \
    && ln -s /usr/local/cargo/bin/rustfmt /usr/local/bin/rustfmt \
    && ln -s /usr/local/cargo/bin/cargo-clippy /usr/local/bin/cargo-clippy

# Create the user expected by devcontainer.json.
RUN useradd --create-home --shell /bin/bash vscode \
    && echo "vscode ALL=(root) NOPASSWD:ALL" > /etc/sudoers.d/vscode \
    && chmod 0440 /etc/sudoers.d/vscode \
    && mkdir -p /workspace /workspaces /usr/local/cargo/registry /usr/local/cargo/git /usr/local/rustup \
    && chown -R vscode:vscode /workspace /workspaces /usr/local/cargo /usr/local/rustup

WORKDIR /workspace/tanu-markdown
USER vscode

CMD ["sleep", "infinity"]
