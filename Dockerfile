# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV npm_config_fund=false npm_config_audit=false

# ---- 依赖（仅运行时）----
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- 后端构建 ----
FROM base AS build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build

# ---- 前端构建 ----
FROM base AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- 运行 ----
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=web /app/web/dist ./web/dist
COPY migrations ./migrations
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
