#!/usr/bin/env node
/**
 * iOS 安全区(刘海/底部小黑条)适配的回归测试。
 *
 * 为什么需要它:
 *  1. `viewport-fit=cover` 必须显式声明,否则独立安装(PWA/加到主屏)时
 *     env(safe-area-inset-*) 恒为 0 —— 补再多内边距都不生效。
 *  2. 声明 viewport 时必须带上 width/initialScale,Next.js 会整体覆盖
 *     默认 viewport,漏写会导致移动端不能按设备宽度渲染(用户反馈过类似缩放问题)。
 *  3. 所有**贴屏幕边缘**的元素都要自己留安全距离:
 *     底部输入框(含线程回复)、预览横幅、抽屉、全屏面板、频道头部。
 *     漏一个,那个元素在 iPhone 上就被小黑条盖住。
 *
 * 用法:  npm run safe-area:check
 * 退出码: 0 = 通过  1 = 有失败项
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const RED = '\x1b[31m'
const GRN = '\x1b[32m'
const DIM = '\x1b[2m'
const RST = '\x1b[0m'

let pass = 0
let fail = 0

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function section(title) {
  console.log(`\n══════ ${title} ══════\n`)
}

function assert(name, cond) {
  if (cond) pass++
  else fail++
  const mark = cond ? `${GRN}✓${RST}` : `${RED}✗${RST}`
  console.log(`  ${mark} ${name}`)
}

// ═════════════════════════════════════════════════════════════
section('1 · viewport 声明')
// ═════════════════════════════════════════════════════════════
const layout = read('src/app/layout.tsx')
assert('导出了 viewport 配置', /export const viewport: Viewport/.test(layout))
assert('viewportFit: cover(安全区 inset 才会生效)', /viewportFit: 'cover'/.test(layout))
assert('保留 width: device-width(不破坏移动端缩放)', /width: 'device-width'/.test(layout))
assert('保留 initialScale(不破坏移动端缩放)', /initialScale: 1/.test(layout))
assert('未限制 userScalable(不破坏无障碍放大)', !/userScalable|maximumScale/.test(layout))

// ═════════════════════════════════════════════════════════════
section('2 · 底部贴边元素(小黑条会盖住的地方)')
// ═════════════════════════════════════════════════════════════
const input = read('src/components/chat/message-input.tsx')
assert(
  '输入框(主聊天 + 线程回复共用)底部留安全区',
  /pb-\[calc\(1rem\+env\(safe-area-inset-bottom\)\)\]/.test(input)
)
assert(
  '输入框原 1rem 基础内边距没被吞掉(不是裸 env)',
  /calc\(1rem\+env\(safe-area-inset-bottom\)\)/.test(input)
)

const view = read('src/components/chat/channel-view.tsx')
assert(
  '预览模式底部横幅留安全区',
  /pb-\[calc\(1rem\+env\(safe-area-inset-bottom\)\)\]/.test(view)
)
assert(
  '预览横幅原有 pt-4 没被吞掉',
  /px-5 pt-4 shrink-0 pb-\[calc\(1rem\+env\(safe-area-inset-bottom\)\)\]/.test(view)
)

// ═════════════════════════════════════════════════════════════
section('3 · 顶部贴边元素(状态栏/刘海)')
// ═════════════════════════════════════════════════════════════
assert(
  '频道头部留顶部安全区(原 py-3 拆成 pt+pb)',
  /pt-\[calc\(0\.75rem\+env\(safe-area-inset-top\)\)\]/.test(view) &&
    /px-5 pb-3 flex items-center justify-between shrink-0/.test(view)
)

const wsLayout = read('src/app/workspace/layout.tsx')
assert('移动端抽屉顶部留安全区', /pt-\[env\(safe-area-inset-top\)\]/.test(wsLayout))
assert('移动端抽屉底部留安全区', /pb-\[env\(safe-area-inset-bottom\)\]/.test(wsLayout))
assert(
  '抽屉安全区类只加在 fixed 浮层那个分支(桌面静态栏不受影响)',
  /fixed left-0 top-0 h-full z-50 transition-transform duration-200 ease-out pt-\[env\(safe-area-inset-top\)\] pb-\[env\(safe-area-inset-bottom\)\]/.test(wsLayout)
)

for (const [file, label, width] of [
  ['src/components/chat/user-profile-panel.tsx', '个人资料面板', 'w-80'],
  ['src/components/chat/thread-panel.tsx', '线程面板', 'w-96'],
  ['src/components/activity/activity-panel.tsx', '动态面板', 'w-[380px]'],
]) {
  const panel = read(file)
  assert(
    `${label}全屏浮层顶部留安全区`,
    new RegExp(`fixed inset-0 z-30 flex flex-col h-full bg-white md:static md:z-auto md:${width.replace('[', '\\[').replace(']', '\\]')}`).test(panel) &&
      /pt-\[env\(safe-area-inset-top\)\]/.test(panel)
  )
}

// ═════════════════════════════════════════════════════════════
section('4 · 环境安全性')
// ═════════════════════════════════════════════════════════════
// env() 在极老的浏览器里求值失败,整条 padding 声明会失效。
// 因此只允许两种形态:
//   · calc(固定值 + env(三个点)) —— env 失效还剩固定值(输入框/横幅/头部的既有内边距);
//   · 纯 env() 的任意值类(pt/pb 后跟方括号),且该元素本来就没有内边距 ——
//     失效等于改动前的效果,不会更糟。
// 不允许「裸 env() 顶掉一个已有的 Tailwind 内边距类」。
// 先剥掉注释再扫 —— 注释里提到 env() 不计入。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

const envFiles = [
  'src/components/chat/message-input.tsx',
  'src/components/chat/channel-view.tsx',
  'src/app/workspace/layout.tsx',
  'src/components/chat/user-profile-panel.tsx',
  'src/components/chat/thread-panel.tsx',
  'src/components/activity/activity-panel.tsx',
]
for (const f of envFiles) {
  const src = stripComments(read(f))
  const matches = [...src.matchAll(/env\(safe-area-inset-[a-z]+\)/g)]
  const unguarded = matches.filter((m) => {
    const before = src.slice(Math.max(0, m.index - 24), m.index)
    const inCalc = /calc\([^)]*$/.test(before)
    const isArbitraryClass = /\[$/.test(before) // pt-[env(...
    return !inCalc && !isArbitraryClass
  })
  assert(`${f} 无裸 env()(共 ${matches.length} 处,未兜底 0 处)`, matches.length > 0 && unguarded.length === 0)
}

// ═════════════════════════════════════════════════════════════
section('5 · 防回归:注释里不许出现会被扫成类名的字面量')
// ═════════════════════════════════════════════════════════════
// Tailwind 4 会自动扫描项目里所有源文件(含 scripts/)找候选类名。
// 注释里写 "pt-[env(三个点)]" 这种示例 → 生成 padding-bottom: env(三个点) →
// 非法 CSS → 整个样式表解析失败 → 每个页面 500。踩过一次,这里焊死。
{
  const scanDirs = ['src', 'scripts']
  const offenders = []
  for (const dir of scanDirs) {
    const base = path.join(root, dir)
    if (!fs.existsSync(base)) continue
    const walk = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|tsx|mjs|js|css)$/.test(entry.name)) {
          const text = fs.readFileSync(full, 'utf8')
          if (/env\(\.\.\.\)/.test(text)) offenders.push(path.relative(root, full))
        }
      }
    }
    walk(base)
  }
  assert('没有任何文件包含 env(三点) 字面量(会被扫成非法 CSS)', offenders.length === 0)
  if (offenders.length > 0) console.log(`    违规文件: ${offenders.join(', ')}`)
}
console.log(`  ${GRN}通过 ${pass}${RST}  ${fail > 0 ? `${RED}失败 ${fail}${RST}` : `${DIM}失败 0${RST}`}`)
console.log(`${DIM}──────────────────────────────${RST}`)
process.exit(fail > 0 ? 1 : 0)
