#!/usr/bin/env node
/**
 * 消息悬停工具栏(表情回应/线程/收藏/更多)的回归测试。
 *
 * 为什么需要它:
 *  1. 工具栏**不做整行选中**。曾经悬停时给整条消息行铺 bg-[#F5F2FF],
 *     长消息被整片刷紫,用户反馈「内容过多时选中样式难看」。
 *  2. 工具栏必须锚在**气泡**上(不是整行)。行底部还有阅后即焚时钟等元素,
 *     锚在行上工具栏会沉到老远 —— 用户原话「太靠下、距离远导致无法选中」。
 *  3. **带名字/时间行的消息,工具栏只出现在气泡下方** —— 飘在名称上方
 *     像贴错了消息(用户第二张截图的原话:「不应该在名称的上面」)。
 *  4. 必须有**悬停桥**。工具栏与气泡之间有 6px 视觉间距,鼠标穿过间距的
 *     瞬间 hovered 置 false、工具栏直接消失,用户就永远点不到按钮 ——
 *     「只能看不能点」的根因。before: 伪元素把这座桥焊死。
 *  5. 三角标识必须随朝向翻转尖角(上方→朝下,下方→朝上),
 *     **并且始终指向消息首行** —— 固定死在工具栏中心的话,窄消息
 *     (工具栏比消息宽)时三角会指向一片空白(用户第三张截图)。
 *  6. 水平锚点贴气泡同侧边,不能越出列表容器外缘。
 *
 * 用法:  npm run toolbar:check
 * 退出码: 0 = 通过  1 = 有失败项
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { pickToolbarSide, resolveTriangleOffset, clampTriangleOffset } from '../src/lib/message-toolbar.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const RED = '\x1b[31m'
const GRN = '\x1b[32m'
const DIM = '\x1b[2m'
const RST = '\x1b[0m'

let pass = 0
let fail = 0

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass++
  else fail++
  const mark = ok ? `${GRN}✓${RST}` : `${RED}✗${RST}`
  const suffix = ok ? '' : `  ${RED}(期望 ${JSON.stringify(expected)})${RST}`
  console.log(`  ${mark} ${name}  ->  ${JSON.stringify(actual)}${suffix}`)
}

function assert(name, cond, detail = '') {
  if (cond) pass++
  else fail++
  const mark = cond ? `${GRN}✓${RST}` : `${RED}✗${RST}`
  console.log(`  ${mark} ${name}${detail ? `  ${DIM}${detail}${RST}` : ''}`)
}

const bubble = fs.readFileSync(path.join(root, 'src/components/chat/message-bubble.tsx'), 'utf8')
const toolbarLib = fs.readFileSync(path.join(root, 'src/lib/message-toolbar.ts'), 'utf8')

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 1 · 不做整行选中 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  // 整行高亮的两种写法都不允许再出现:showToolbar 时的「选中态」和 hover 态
  assert('消息行不再挂「选中态」背景', !/showToolbar \? 'bg-\[#F5F2FF\]'/.test(bubble))
  assert('消息行不再挂 hover 背景', !/hover:bg-\[#F5F2FF\]'/.test(bubble))
  assert('消息行 className 就是纯 rowClass(无拼接背景)', /className=\{rowClass\}/.test(bubble))
  // 行元素不再挂 ref(定位上下文换成了气泡锚点)
  assert('消息行已不再被 ref 引用(定位换锚点)', !/ref=\{rowRef\}/.test(bubble))
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 2 · 锚在气泡上(不是整行) ══════\n')
// ═════════════════════════════════════════════════════════════
{
  assert(
    '气泡外包了 relative 定位容器',
    /<div ref=\{bubbleAnchorRef\} className="relative">/.test(bubble)
  )
  assert(
    '工具栏渲染在气泡锚点内部(ACTION TOOLBAR 注释在锚点开标签之后)',
    bubble.indexOf('ref={bubbleAnchorRef}') < bubble.indexOf('{/* ACTION TOOLBAR')
  )
  assert(
    '度量的是气泡锚点而非行',
    /const anchor = bubbleAnchorRef\.current/.test(bubble) &&
      /const rect = anchor\.getBoundingClientRect\(\)/.test(bubble)
  )
  assert(
    '把 hasHeader 喂给决策函数(名字行 → 只走下方)',
    /hasHeader: showHeader/.test(bubble)
  )
  assert(
    '悬停期间持续监听滚动/缩放并正确清理',
    /window\.addEventListener\('resize', measure\)/.test(bubble) &&
      /window\.addEventListener\('scroll', measure, true\)/.test(bubble) &&
      /window\.removeEventListener\('resize', measure\)/.test(bubble) &&
      /window\.removeEventListener\('scroll', measure, true\)/.test(bubble)
  )
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 3 · 悬停桥(点不到按钮的根因) ══════\n')
// ═════════════════════════════════════════════════════════════
{
  assert(
    '工具栏带 before: 伪元素铺满横向',
    /before:absolute before:left-0 before:right-0 before:h-1\.5 before:content-\[''\]/.test(bubble)
  )
  // 桥必须落在**工具栏与气泡之间**的那 6px:上方时在下沿,下方时在上沿
  assert(
    '翻到上方时,桥补在工具栏下沿(before:-bottom-1.5)',
    /'bottom-full mb-1\.5 before:-bottom-1\.5'/.test(bubble)
  )
  assert(
    '翻到下方时,桥补在工具栏上沿(before:-top-1.5)',
    /'top-full mt-1\.5 before:-top-1\.5'/.test(bubble)
  )
  // 桥是伪元素,不占布局、不影响下方消息
  assert('桥用伪元素而非真实占位(不推开后续消息)', !/<div[^>]*className="[^"]*h-1\.5[^"]*"/.test(bubble))
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 4 · 朝向决策边界值 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const flipThreshold = toolbarLib.match(/TOOLBAR_FLIP_HEIGHT_PX = (\d+)/)
  check('翻转阈值存在且合理(60~120px)', flipThreshold ? Number(flipThreshold[1]) > 60 && Number(flipThreshold[1]) < 120 : false, true)
  assert('决策是纯函数且导出', /export function pickToolbarSide\(/.test(toolbarLib))

  // 基准:短消息、无名字行、视口里上下都宽敞
  const base = { hasHeader: false, bubbleHeight: 48, topInViewport: 300, bottomInViewport: 348, viewportHeight: 900 }
  check('短消息无名字行、空间足 → 上方', pickToolbarSide(base), 'top')

  // 用户第二张截图:带名字行的消息,工具栏绝不能跑到名称上方
  check('带名字行(空间足)→ 下方', pickToolbarSide({ ...base, hasHeader: true }), 'bottom')
  check('带名字行 + 贴视口顶 → 下方', pickToolbarSide({ ...base, hasHeader: true, topInViewport: 10 }), 'bottom')

  // 内容多少 → 上下自动
  check('内容多(气泡 160px)→ 下方', pickToolbarSide({ ...base, bubbleHeight: 160 }), 'bottom')
  check('气泡正好 72px(阈值不翻)', pickToolbarSide({ ...base, bubbleHeight: 72 }), 'top')
  check('气泡 73px(超一像素即翻)', pickToolbarSide({ ...base, bubbleHeight: 73 }), 'bottom')

  // 视口硬约束
  check('上方放不下(top=40)→ 下方', pickToolbarSide({ ...base, topInViewport: 40 }), 'bottom')
  check('下方放不下(贴底)→ 翻身到上方', pickToolbarSide({ ...base, bottomInViewport: 880 }), 'top')
  check('带名字行但贴底 → 仍翻上(裁剪是硬约束)', pickToolbarSide({ ...base, hasHeader: true, bottomInViewport: 880 }), 'top')

  // 自定义阈值参数生效
  check('自定义翻转阈值(50 > 40 → 下方)', pickToolbarSide({ ...base, bubbleHeight: 50 }, 40, 10), 'bottom')
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 5 · 三角标识 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  assert('三角是旋转 45° 的方块(rotate-45)', /h-2\.5 w-2\.5 rotate-45/.test(bubble))
  assert('三角填充与边框色同工具栏(白底 #E5E1EE 边)', /border-\[#E5E1EE\] bg-white/.test(bubble))
  // 朝下的三角给右下两条边;朝上的给左上两条边 —— 边给反了尖角就指向天空
  assert('上方时尖角朝下(border-r border-b)', /bottom-0 translate-y-1\/2 border-b border-r/.test(bubble))
  assert('下方时尖角朝上(border-l border-t)', /top-0 -translate-y-1\/2 border-l border-t/.test(bubble))
  assert('三角水平位置由 --tri-x 驱动(默认 50% 仍居中)', /left-1\/2/.test(bubble) === false && /var\(--tri-x\)/.test(bubble))
  assert('三角不拦截点击(pointer-events-none)', /pointer-events-none absolute/.test(bubble))
  assert('三角对辅助技术隐藏(aria-hidden)', /aria-hidden="true"/.test(bubble))
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 5b · 三角指向消息(不是工具栏中心) ══════\n')
// ═════════════════════════════════════════════════════════════
{
  // 用户第三张截图:窄消息(「测试」)工具栏比消息宽,三角若固定在工具栏中心,
  // 就指向消息旁边的一片空白 ——「位置不够时三角还是固定位置,显示怪异」。
  assert(
    '三角不再固定死 left-1/2(改用 --tri-x 变量驱动)',
    !/left-1\/2/.test(bubble)
  )
  assert(
    '自己的消息:三角从工具栏右缘量(right-[var(--tri-x)])',
    /right-\[var\(--tri-x\)\]/.test(bubble)
  )
  assert(
    '对方的消息:三角从左缘量(left-[var(--tri-x)])',
    /left-\[var\(--tri-x\)\]/.test(bubble)
  )
  assert(
    '三角仍以 -translate-x-1/2 自居中(变量即三角中心)',
    /-translate-x-1\/2 h-2\.5 w-2\.5 rotate-45/.test(bubble)
  )
  assert(
    '工具栏用内联样式写入 --tri-x(未量到时 50% 兜底)',
    /style=\{\{ '--tri-x': triOffset === null \? '50%' : `\$\{triOffset\}px` \} as React\.CSSProperties\}/.test(bubble)
  )
  // 目标点必须是消息首行文字,而不是气泡中心(窄消息/多行消息下气泡中心会偏)
  assert(
    '用 Range 量首行文字中心作为指向目标',
    /document\.createRange\(\)/.test(bubble) &&
      /range\.selectNodeContents\(content\)/.test(bubble) &&
      /range\.getClientRects\(\)\[0\]/.test(bubble)
  )
  assert(
    '量不到首行时退化为气泡中心(有兜底)',
    /const targetX =\s*\n?\s*params\.targetX \?\? \(params\.bubbleRect\.left \+ params\.bubbleRect\.right\) \/ 2/.test(toolbarLib) ||
      /targetX \?\? \(params\.bubbleRect\.left \+ params\.bubbleRect\.right\) \/ 2/.test(toolbarLib)
  )
  assert(
    '工具栏挂了 ref 以测量宽度',
    /ref=\{toolbarRef\}/.test(bubble) && /const toolbar = toolbarRef\.current/.test(bubble)
  )
}

// 边界值:三角要落在「消息首行」正上方,且不越出工具栏
{
  // 窄消息:「测试」宽 70px,工具栏 250px,锚定左缘(对方消息)
  check(
    '窄消息(对方):三角落在首行中心(35px 处)',
    resolveTriangleOffset({
      targetX: 1000 + 35,           // 首行中心
      bubbleRect: { left: 1000, right: 1070 },
      toolbarRect: { left: 1000, right: 1250, width: 250 },
      alignRight: false,
    }),
    35
  )
  // 自己的消息靠右展开:同样的窄消息,距离改从右缘量
  check(
    '窄消息(自己):三角从右缘量,同样落在首行中心',
    resolveTriangleOffset({
      targetX: 1180 + 35,           // 气泡右边 1250,宽 70 → 中心距右缘 35
      bubbleRect: { left: 1180, right: 1250 },
      toolbarRect: { left: 1000, right: 1250, width: 250 },
      alignRight: true,
    }),
    35
  )
  // 消息比工具栏宽:三角夹进工具栏内,不飞到工具栏外
  check(
    '宽消息:三角夹到工具栏内(不越界)',
    resolveTriangleOffset({
      targetX: 1300,                // 首行中心远在工具栏右侧之外
      bubbleRect: { left: 1000, right: 1600 },
      toolbarRect: { left: 1000, right: 1250, width: 250 },
      alignRight: false,
    }),
    clampTriangleOffset(300, 250)
  )
  check(
    '夹取函数:小于下界抬到下界',
    clampTriangleOffset(-40, 250),
    6
  )
  check(
    '夹取函数:大于上界压到上界',
    clampTriangleOffset(999, 250),
    234
  )
  // 兜底:量不到首行 → 用气泡中心
  check(
    '量不到首行 → 退化为气泡中心',
    resolveTriangleOffset({
      targetX: null,
      bubbleRect: { left: 1000, right: 1100 },
      toolbarRect: { left: 1000, right: 1250, width: 250 },
      alignRight: false,
    }),
    50
  )
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 6 · 锚点不溢出容器 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  assert(
    '自己的消息工具栏贴气泡右缘,不越出容器',
    /const toolbarPosClass = alignRight \? 'right-0' : 'left-0'/.test(bubble)
  )
  assert('工具栏在悬停/打开面板时才渲染', /showToolbar && !editing/.test(bubble))
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 7 · 移动端长按手势 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  assert('长按状态并入 showToolbar', /const showToolbar = hovered \|\| longPressed/.test(bubble))
  assert('500ms 长按阈值', /LONG_PRESS_MS = 500/.test(bubble))
  assert('长按定时器挂在 touchstart 上', /setTimeout\(\(\) => \{[\s\S]*?setLongPressed\(true\)/.test(bubble))
  assert('长按成功后触发震动反馈', /navigator\.vibrate\(10\)/.test(bubble))
  assert('移动容差内取消长按(touchmove 即滚动意图)', /LONG_PRESS_MOVE_TOLERANCE/.test(bubble))
  assert('可交互元素(链接/按钮/图片)放行,不抢原生点击', /target\.closest\('a, button, img, input, textarea, select'\)/.test(bubble))
  assert('touchend/touchcancel 取消未触发的定时器', /onTouchEnd=\{cancelLongPress\}/.test(bubble) && /onTouchCancel=\{cancelLongPress\}/.test(bubble))
  assert('卸载时清理长按定时器', /useEffect\(\(\) => cancelLongPress, \[\]\)/.test(bubble))
  // 外部收起必须绑定在 touchstart 上而不是 click —— 手指一按就收
  assert('长按唤出后 touchstart 外部即收起', /document\.addEventListener\('touchstart', dismiss, true\)/.test(bubble))
  assert('混合设备用 mousedown 兜底收起', /document\.addEventListener\('mousedown', dismiss, true\)/.test(bubble))
  assert('滚动列表时收起长按工具栏', /window\.addEventListener\('scroll', dismiss, true\)/.test(bubble))
  assert('收起监听在 cleanup 中全部移除', /removeEventListener\('touchstart', dismiss, true\)/.test(bubble) && /removeEventListener\('scroll', dismiss, true\)/.test(bubble))
  assert('桌面 hover 路径原样保留', /onMouseEnter=\{\(\) => setHovered\(true\)\}/.test(bubble) && /onMouseLeave=\{\(\) => setHovered\(false\)\}/.test(bubble))
}

console.log('')
console.log(`${DIM}──────────────────────────────${RST}`)
console.log(`  ${GRN}通过 ${pass}${RST}  ${fail > 0 ? `${RED}失败 ${fail}${RST}` : `${DIM}失败 0${RST}`}`)
console.log(`${DIM}──────────────────────────────${RST}`)
process.exit(fail > 0 ? 1 : 0)
