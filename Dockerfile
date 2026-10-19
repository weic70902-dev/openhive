# OpenHive — 生产镜像（Next.js standalone）
# 用于 ClawCloud Run / 任意香港或海外 VPS 的容器化部署
#
# 构建（必须在构建期注入 NEXT_PUBLIC_*，它们会被打进客户端产物）：
#   docker build \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=... \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
#     -t openhive:latest .
#
# 运行（SUPABASE_SERVICE_ROLE_KEY 等私密变量只在运行时注入）：
#   docker run -p 3000:3000 --env-file .env.production openhive:latest

# ---------- 1. 依赖层 ----------
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------- 2. 构建层 ----------
FROM node:22-slim AS builder
WORKDIR /app

# 让 next.config.ts 输出 standalone 产物
ENV DOCKER_BUILD=1
ENV NEXT_TELEMETRY_DISABLED=1

# NEXT_PUBLIC_* 在 next build 时被内联进浏览器 bundle，只能构建期传入
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---------- 3. 运行层 ----------
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# standalone 产物自带精简后的 node_modules 与 server.js
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs
EXPOSE 3000

# /api/setup 的 GET 只读环境变量，不写盘，适合做存活探针
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/setup').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
