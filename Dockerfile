# Hermetic image for running Sentinel in CI. Bundles Chromium + all OS deps.
FROM mcr.microsoft.com/playwright:v1.50.0-noble

WORKDIR /app

# Install deps first for layer caching.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev

# Build the TypeScript sources.
COPY tsconfig.json ./
COPY src ./src
RUN npm install --no-save typescript@^5.7.2 && npx tsc -p tsconfig.json

# Bring in example specs (override by mounting your own at /app/specs).
COPY specs ./specs

# ANTHROPIC_API_KEY is provided at run time, never baked into the image.
ENV SENTINEL_HEADED=false
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--help"]
