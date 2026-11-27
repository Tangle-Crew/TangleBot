FROM node:lts-slim

# @napi-rs/canvas ships its own graphics library; it only needs fonts for the text it draws.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY migrations/ ./migrations/

HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 CMD ["node", "src/healthcheck.js"]

CMD ["node", "src/index.js"]
