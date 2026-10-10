# syntax=docker/dockerfile:1

FROM oven/bun:1.4.2-debian@sha256:4f6e31d1a54d6a3dd312daef655fc998101b5043d52e12592ac293ef04b9bc73
WORKDIR /app
COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --ignore-scripts
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun protocol ./protocol
COPY --chown=bun:bun lifecycle ./lifecycle
USER bun
# The listeners' ports come from the configuration, named by
# HARNESS_GW_CONFIG_FILE or found at $XDG_CONFIG_HOME/harness-gw/config.yaml.
ENTRYPOINT ["bun", "run", "src/cli.ts"]
CMD ["serve"]
