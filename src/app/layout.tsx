import type { Metadata, Viewport } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { I18nProvider } from '@/lib/i18n'

const inter = Inter({
  variable: '--font-sans',
  subsets: ['latin'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'OpenHive',
  description: '开源自托管团队沟通平台',
}

// viewportFit: 'cover' —— 内容延伸到 iPhone 刘海/底部小黑条区域,
// 再由各贴边元素自己用 env(safe-area-inset-*) 留出安全距离。
// 不设 cover 的话,独立安装(PWA)时底部这些 inset 永远是 0,补了内边距也不生效。
// 桌面浏览器 env() 取值为 0,无任何副作用。
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="zh-CN">
      <body className={`${inter.variable} antialiased`} style={{ fontFamily: 'var(--font-sans), system-ui, sans-serif' }}>
        <I18nProvider>{children}</I18nProvider>
      </body>
    </html>
  )
}
