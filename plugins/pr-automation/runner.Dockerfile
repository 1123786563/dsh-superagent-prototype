# Local runner for the configured OpenBot Linux jobs. Build and pin its image ID before enabling.
ARG BASE_IMAGE=act-bun:arm64
FROM ${BASE_IMAGE}
USER root
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql-client \
 && rm -rf /var/lib/apt/lists/*
