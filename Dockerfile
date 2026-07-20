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
RUN bun install --frozen-lockfile
RUN bun run build

FROM base AS runner
WORKDIR /app

ARG VERSION
ARG COMMIT
ARG BUILD_TIME

ENV APP_VERSION=${VERSION}
ENV APP_COMMIT=${COMMIT}
ENV APP_BUILD_TIME=${BUILD_TIME}

# server-dist 是 `bun build --target=bun` 的单文件 bundle（hono/zod/aws-sdk/
# @notefast/core 全部 inline），web-dist 是 vite 产物。两者都不依赖
# node_modules；带 node_modules 反而会引入 devDeps 里的 esbuild linux-x64
# 等 go binary，导致 Trivy 误报 CRITICAL CVE。
COPY --from=builder /app/packages/server/dist ./server-dist
COPY --from=builder /app/packages/web/dist ./web-dist

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
