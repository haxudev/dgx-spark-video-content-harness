# podcast-football hosted agent — single image bundling the Node harness
# pipeline (HTML report -> 9:16 narrated MP4) and the Python Microsoft Agent
# Framework "harness agent" that drives it over the Foundry RESPONSES protocol.
#
# Build context = repo root:  docker build -t podcast-football-agent .
FROM node:22-bookworm

# --- System deps: Python, ffmpeg, Chromium (for puppeteer + hyperframes), CJK fonts ---
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-venv python3-pip \
        ffmpeg \
        chromium \
        fonts-noto-cjk fonts-noto-color-emoji \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# --- Build the Node harness pipeline ---
# Use the verified system Chromium; never let puppeteer download its own browser.
ENV PUPPETEER_SKIP_DOWNLOAD=1 \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY templates ./templates
COPY config ./config
# Version-controlled avatar material library (pre-generated digital-human clips).
# The cache-only AVATAR phase consumes these; baking them in means the container
# ships the presenter with zero longcat calls.
COPY assets ./assets
RUN npm run build && npm prune --omit=dev

# Pre-install the pinned hyperframes used by the RENDER phase so runtime doesn't
# download it on first render. Bounded by `timeout` and best-effort (|| true) so
# a slow/hanging postinstall can never block or fail the image build; the RENDER
# phase falls back to `npx -y hyperframes@0.6.25` at runtime if absent.
RUN timeout 600 npm install -g hyperframes@0.6.25 || echo "hyperframes prewarm skipped (will npx at runtime)"

# --- Install the Python harness agent ---
ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"
COPY agent ./agent
# Install the fully-pinned, known-good transitive set first (agent/requirements.lock,
# captured from the verified-working container). Pinning every transitive dep to an
# exact == means pip has no versions to backtrack over, which sidesteps the newer
# pip resolver's `resolution-too-deep` failure on the (unpinned) agent-framework
# alpha dependency graph. Then install the local package itself without re-resolving.
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r ./agent/requirements.lock \
    && pip install --no-cache-dir --no-deps ./agent

# --- Runtime config (override via docker-compose / -e) ---
ENV HARNESS_BIN="node /app/dist/cli.js" \
    HARNESS_DIR=/app \
    HARNESS_WORK_DIR=/app/out \
    AGENT_HOST=0.0.0.0 \
    AGENT_PORT=8088 \
    OTEL_SDK_DISABLED=true \
    PYTHONUNBUFFERED=1

EXPOSE 8088

CMD ["python", "-m", "football_agent.server"]
