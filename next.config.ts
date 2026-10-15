import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Next.js 内置的开发指示器(Route / Bundler / Turbopack / Route Info / Preferences)
  // 是框架自带的英文浮层,不经过本项目的 i18n 词典,也无法翻译。
  // 它只在 `next dev` 下出现,生产构建本来就不存在 —— 这里直接关闭以保持界面纯净。
  // 需要排查路由/打包信息时,改回 `{ position: 'bottom-right' }` 即可恢复。
  devIndicators: false,
};

export default nextConfig;
