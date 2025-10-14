# syntax=docker/dockerfile:1.5
FROM mcr.microsoft.com/devcontainers/rust-node:1-22-bullseye

# Install additional build tooling and libraries used across the workspace.
RUN apt-get update \
    && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends \
        pkg-config \
        libsqlite3-dev \
        libssl-dev \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Pre-create cargo target and npm cache directories to avoid permission mismatches
# when mounting from the host.
RUN mkdir -p /workspace /workspaces /usr/local/cargo/registry /usr/local/cargo/git

# Set default working directory used by docker-compose and devcontainers.
WORKDIR /workspace

# Use the non-root "vscode" user that ships with the base image for day-to-day work.
USER vscode

# Ensure cargo installs go into the standard location for the vscode user.
ENV CARGO_HOME=/usr/local/cargo \
    RUSTUP_HOME=/usr/local/rustup

# Default command keeps the container alive for interactive shells.
CMD ["sleep", "infinity"]
