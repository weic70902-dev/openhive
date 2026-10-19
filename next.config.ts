import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 内置的开发指示器(Route / Bundler / Turbopack / Route Info / Preferences)
  // 是框架自带的英文浮层,不经过本项目的 i18n 词典,也无法翻译。
  // 它只在 `next dev` 下出现,生产构建本来就不存在 —— 这里直接关闭以保持界面纯净。
  // 需要排查路由/打包信息时,改回 `{ position: 'bottom-right' }` 即可恢复。
  devIndicators: false,

  // 容器化部署(Docker / ClawCloud Run / 任意 VPS)时输出自包含的 standalone 产物,
  // 运行阶段不再需要 node_modules,镜像体积从 ~1.2GB 降到 ~180MB。
  // 仅在构建时显式设置 DOCKER_BUILD=1 才启用,不影响 Vercel / EdgeOne 的既有构建方式。
  output: process.env.DOCKER_BUILD === "1" ? "standalone" : undefined,
};

export default nextConfig;
