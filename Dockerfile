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
RUN mkdir -p /workspace /workspaces /usr/local/cargo/registry /usr/local/cargo/git \
    && chown -R vscode:vscode /usr/local/cargo

# Set default working directory used by docker-compose and devcontainers.
WORKDIR /workspace

# Use the non-root "vscode" user that ships with the base image for day-to-day work.
USER vscode

# Ensure cargo installs go into the vscode user's home directory for proper permissions.
ENV CARGO_HOME=/home/vscode/.cargo \
    RUSTUP_HOME=/home/vscode/.rustup

# Create cargo directories in user home with correct permissions
RUN mkdir -p /home/vscode/.cargo /home/vscode/.rustup

# Default command keeps the container alive for interactive shells.
CMD ["sleep", "infinity"]
