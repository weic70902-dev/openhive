/**
 * 消息悬停工具栏(表情回应/线程/收藏/更多)的朝向决策。
 *
 * 为什么单独一个文件:message-bubble.tsx 是 .tsx,Node 的
 * --experimental-strip-types 不认(JSX 无法静态剥离),回归脚本
 * (scripts/check-message-toolbar.mjs)就 import 不到里面的纯函数。
 * 决策逻辑本身与 React 无关,放这里两头都干净。
 */

/**
 * 气泡高度超过这个值,悬停工具栏就翻到消息**下方**。
 * 长内容的工具栏贴在上沿会让人找不到(得望到底部才知道在哪),
 * 放下方并用三角标识指回来更干净。
 */
export const TOOLBAR_FLIP_HEIGHT_PX = 72

/** 工具栏估算高度(px),用于判断视口里放不放得下。 */
export const TOOLBAR_APPROX_H = 44

export interface ToolbarSideInput {
  /** 这条消息是否带「名字 + 时间」行(即一组消息里的第一条) */
  hasHeader: boolean
  /** 气泡(内容区)在视口中的高度 */
  bubbleHeight: number
  /** 气泡顶边在视口中的 y */
  topInViewport: number
  /** 气泡底边在视口中的 y */
  bottomInViewport: number
  /** 视口高度 */
  viewportHeight: number
}

/**
 * 工具栏朝向决策。优先级从高到低:
 *  1. **下方放不下**(列表滚到底了)→ 翻到上方。硬约束,否则工具栏被裁掉。
 *  2. **带名字行的消息 → 下方**。用户明确反馈:工具栏飘在「名字/时间」
 *     上方很违和(像贴错了消息),必须跟在气泡下面。
 *  3. **内容多**(气泡超过阈值)→ 下方。
 *  4. **上方放不下**(贴着视口顶)→ 下方。
 *  5. 其余(短消息、无名字行)→ 悬在气泡上方,不遮挡后续消息。
 *
 * 注意:上下都是相对**气泡**而非整行 —— 行底部还有阅后即焚时钟等元素,
 * 锚在行上会让工具栏离气泡很远(用户反馈「太靠下、点不到」)。
 */
export function pickToolbarSide(
  input: ToolbarSideInput,
  flipHeightPx: number = TOOLBAR_FLIP_HEIGHT_PX,
  toolbarApproxH: number = TOOLBAR_APPROX_H
): 'top' | 'bottom' {
  // 1. 下方放不下 → 上方(硬约束)
  if (input.viewportHeight - input.bottomInViewport < toolbarApproxH + 8) return 'top'
  // 2. 带名字行:绝不出现在名称上方
  if (input.hasHeader) return 'bottom'
  // 3. 内容多 → 下方
  if (input.bubbleHeight > flipHeightPx) return 'bottom'
  // 4. 上方放不下 → 下方
  if (input.topInViewport < toolbarApproxH + 12) return 'bottom'
  // 5. 短消息无名字行 → 上方
  return 'top'
}

/** 三角标识方块边长(px),与 Tailwind `h-2.5 w-2.5` 对应。 */
export const TRIANGLE_SIZE_PX = 10

/**
 * 把「三角相对工具栏锚定边的距离」夹进工具栏范围内。
 *
 * 消息窄(如「测试」两个字)时工具栏会比消息宽,若三角还固定在工具栏中心,
 * 就会指向消息旁边的一片空白 —— 用户反馈「位置不够时三角还是固定位置,
 * 显示怪异」。夹取保证三角永远落在工具栏内、且贴近消息。
 */
export function clampTriangleOffset(
  desiredFromEdge: number,
  toolbarWidth: number,
  minPx = 6,
  maxInsetPx = 16
): number {
  const max = Math.max(minPx, toolbarWidth - maxInsetPx)
  return Math.min(Math.max(desiredFromEdge, minPx), max)
}

/**
 * 计算三角的水平偏移(相对工具栏锚定边的 px)。
 *
 * 目标点取**消息首行的水平中心**(用 Range 量第一行文字得到)——
 * 它才是「这条消息」在人眼中的位置;气泡整体中心在窄消息、
 * 多行消息下都会偏。拿不到首行时退化为气泡中心。
 * `alignRight`(自己的消息靠右展开)时距离从工具栏右缘量,否则从左缘量。
 */
export function resolveTriangleOffset(params: {
  /** 首行中心的视口 x;null = 没有量到,用气泡中心兜底 */
  targetX: number | null
  bubbleRect: { left: number; right: number }
  toolbarRect: { left: number; right: number; width: number }
  alignRight: boolean
}): number {
  const targetX =
    params.targetX ?? (params.bubbleRect.left + params.bubbleRect.right) / 2
  const desired = params.alignRight
    ? params.toolbarRect.right - targetX
    : targetX - params.toolbarRect.left
  return clampTriangleOffset(desired, params.toolbarRect.width)
}
