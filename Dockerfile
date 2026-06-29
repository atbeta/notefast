FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bunfig.toml bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN bun install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules node_modules
COPY . .
RUN bun run build

FROM base AS runner
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=builder /app/packages/server/dist ./server-dist
COPY --from=builder /app/packages/web/dist ./web-dist
COPY --from=deps /app/package.json ./

ENV NODE_ENV=production
ENV PORT=3140
ENV DATA_DIR=/app/data
ENV WEB_DIST=/app/web-dist
ENV AUTO_EXPORT_DIR=/app/export

RUN mkdir -p /app/data /app/export

EXPOSE 3140

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3140/health || exit 1

CMD ["bun", "run", "server-dist/index.js"]
