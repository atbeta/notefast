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

ARG VERSION
ARG COMMIT
ARG BUILD_TIME

ENV APP_VERSION=${VERSION}
ENV APP_COMMIT=${COMMIT}
ENV APP_BUILD_TIME=${BUILD_TIME}

COPY --from=deps /app/node_modules node_modules
COPY --from=builder /app/packages/server/dist ./server-dist
COPY --from=builder /app/packages/web/dist ./web-dist
COPY --from=deps /app/package.json ./

ENV NODE_ENV=production
ENV PORT=3140
ENV DATA_DIR=/app/data
ENV WEB_DIST=/app/web-dist
ENV AUTO_EXPORT_DIR=/app/export

RUN mkdir -p /app/data /app/export && chown -R bun:bun /app
USER bun

EXPOSE 3140

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:3140/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "run", "server-dist/index.js"]
