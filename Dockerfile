###############################################################################
# Stage 1: Builder
###############################################################################
# daocloud 镜像源（m.daocloud.io）2026-09 起匿名拉取返回 401，改回官方 Docker Hub 源
# Keep the glibc distribution stable for impit and Patchright on amd64/arm64.
# Build each stage for the target platform so npm selects matching native packages.
FROM node:24-bookworm-slim AS builder

ARG TARGETARCH
RUN case "$TARGETARCH" in amd64|arm64) ;; *) echo "Unsupported target architecture: $TARGETARCH" >&2; exit 1 ;; esac

WORKDIR /usr/src/microsoft-rewards-script

ENV PLAYWRIGHT_BROWSERS_PATH=0

# Copy package files
COPY package.json package-lock.json tsconfig.json ./

# Install all dependencies required to build the script
RUN npm ci --include=optional --ignore-scripts

# Copy source and build
COPY . .
RUN npm run build

# Remove build dependencies, and reinstall only runtime dependencies
RUN rm -rf node_modules \
    && npm ci --omit=dev --include=optional --ignore-scripts \
    && npm cache clean --force

###############################################################################
# Stage 2: Runtime
###############################################################################
FROM node:24-bookworm-slim AS runtime

WORKDIR /usr/src/microsoft-rewards-script

# Set production environment variables
ENV NODE_ENV=production \
    TZ=UTC \
    PLAYWRIGHT_BROWSERS_PATH=0 \
    FORCE_HEADLESS=1 \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning

# Application tools and fonts; Patchright installs the browser libraries below
# from its versioned Debian/architecture dependency map.
RUN apt-get update && apt-get install -y --no-install-recommends \
    cron \
    procps \
    util-linux \
    coreutils \
    gettext-base \
    jq \
    tzdata \
    ca-certificates \
    fonts-liberation \
    fonts-noto-core \
    fonts-noto-color-emoji \
    fonts-freefont-ttf \
    fonts-droid-fallback \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Copy compiled application and dependencies from builder stage
COPY --from=builder /usr/src/microsoft-rewards-script/dist ./dist
COPY --from=builder /usr/src/microsoft-rewards-script/package*.json ./
COPY --from=builder /usr/src/microsoft-rewards-script/node_modules ./node_modules

# Install patchright's stealth-patched Chromium headless shell.
# The container is headless-only so the full browser isn't needed; then clean up
RUN set -eux; \
    node node_modules/patchright/cli.js install --with-deps --only-shell chromium; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

# Copy config example into the image so entrypoint can use it as a fallback
# when the user hasn't mounted their own config.json
COPY config.example.json ./config.example.json
COPY LICENSE THIRD-PARTY-NOTICES.md ./

# config.json is managed via the ./config bind mount (compose.yaml mounts
# ./config to /usr/src/microsoft-rewards-script/config). On first run the
# entrypoint generates config/config.json from this example if none exists,
# then symlinks it to the project root where the script expects it.
# Accounts come from ACCOUNT_N_* env vars, so no accounts.json is needed.

# Copy runtime scripts with proper permissions from the start
COPY --chmod=755 scripts/docker/run_daily.sh ./scripts/docker/run_daily.sh
COPY --chmod=755 scripts/docker/healthcheck.sh ./scripts/docker/healthcheck.sh
COPY --chmod=755 scripts/api/ ./scripts/api/
COPY --chmod=644 scripts/env.js scripts/credentialEnv.cjs scripts/rewardForecast.cjs scripts/forecastHistory.cjs ./scripts/
COPY --chmod=644 scripts/package.json ./scripts/package.json
COPY --chmod=644 src/crontab.template /etc/cron.d/microsoft-rewards-cron.template
COPY --chmod=755 scripts/docker/entrypoint.sh /usr/local/bin/entrypoint.sh

# CI invokes this directly with the entrypoint overridden; it never starts the app.
COPY --chmod=644 scripts/tests/platform-smoke.mjs ./scripts/tests/platform-smoke.mjs

# Entrypoint handles TZ, accounts/config generation, initial run toggle,
# cron templating & launch, or API server startup when API_MODE=true
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["sh", "-c", "echo 'Container started; cron is running.'"]