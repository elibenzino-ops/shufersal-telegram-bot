# --- שלב 1: בניית קוד TypeScript ---
FROM node:24-bookworm-slim AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- שלב 2: סביבת ריצה קלה 24/7 עם Chromium ופונטים בעברית ---
FROM node:24-bookworm-slim AS runner

ENV NODE_ENV=production \
    TZ=Asia/Jerusalem \
    CHROME_PATH=/usr/bin/chromium \
    HEADLESS=true \
    DATA_DIR=/app/data

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-noto-core \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/data/screenshots && chown -R node:node /app
USER node

VOLUME ["/app/data"]
CMD ["node", "dist/index.js"]
