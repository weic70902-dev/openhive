'use client'

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'

/**
 * 锚定在某个元素上的浮层。
 *
 * 为什么必须用 portal + fixed:
 * 消息列表容器带 `overflow-y-auto overflow-x-hidden`,浮层若留在原地,
 * 一旦宽/高超过容器就会被裁掉 —— 移动端表情面板被切掉半截就是这个原因。
 * 挂到 body 上再用 fixed 定位,并夹取到视口内,才能保证任何屏宽都完整可见。
 *
 * SSR 期间用 useEffect 兜底,避免 useLayoutEffect 在服务端报警告
 * (Radix 同款 useIsomorphicLayoutEffect 写法)。
 */
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

/** 浮层与视口边缘的最小留白 */
const VIEWPORT_MARGIN = 12

interface FloatingPanelProps {
  /** 锚点元素,浮层据此定位 */
  anchorRef: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  /** `end`:浮层右缘贴锚点右缘;`start`:浮层左缘贴锚点左缘 */
  align?: 'start' | 'end'
  /** 浮层与锚点的间距(px) */
  gap?: number
  /** 优先展开方向,空间不足会自动翻到另一侧 */
  side?: 'top' | 'bottom'
  className?: string
  children: ReactNode
}

export function FloatingPanel({
  anchorRef,
  open,
  onClose,
  align = 'end',
  gap = 8,
  side = 'bottom',
  className = '',
  children,
}: FloatingPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  const reposition = useCallback(() => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!panel) return

    const { width: w, height: h } = panel.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    const a = anchor?.getBoundingClientRect() ?? null

    let left: number
    let top: number

    if (!a) {
      // 锚点不存在(例如工具栏此刻没渲染)时退化为居中,保证面板仍然可见
      left = (vw - w) / 2
      top = (vh - h) / 2
    } else {
      // 水平:先按对齐方式取位,再夹进视口。夹取是移动端不溢出屏幕的关键。
      left = align === 'end' ? a.right - w : a.left

      // 垂直:优先按 side 展开,放不下就翻到另一侧,再不行就贴边
      if (side === 'top') {
        top = a.top - gap - h
        if (top < VIEWPORT_MARGIN) {
          const below = a.bottom + gap
          top = below + h <= vh - VIEWPORT_MARGIN ? below : VIEWPORT_MARGIN
        }
      } else {
        top = a.bottom + gap
        if (top + h > vh - VIEWPORT_MARGIN) {
          const above = a.top - gap - h
          top = above >= VIEWPORT_MARGIN ? above : Math.max(VIEWPORT_MARGIN, vh - h - VIEWPORT_MARGIN)
        }
      }
    }

    const maxLeft = Math.max(VIEWPORT_MARGIN, vw - w - VIEWPORT_MARGIN)
    const maxTop = Math.max(VIEWPORT_MARGIN, vh - h - VIEWPORT_MARGIN)
    setPos({
      left: Math.min(Math.max(left, VIEWPORT_MARGIN), maxLeft),
      top: Math.min(Math.max(top, VIEWPORT_MARGIN), maxTop),
    })
  }, [anchorRef, align, gap, side])

  useIsoLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    reposition()
  }, [open, reposition])

  // 滚动 / 旋转屏幕时跟随锚点。capture 阶段监听,容器内滚动也能收到。
  useEffect(() => {
    if (!open) return
    const handle = () => reposition()
    window.addEventListener('resize', handle)
    window.addEventListener('scroll', handle, true)
    return () => {
      window.removeEventListener('resize', handle)
      window.removeEventListener('scroll', handle, true)
    }
  }, [open, reposition])

  // 点击浮层与锚点之外的区域关闭
  useEffect(() => {
    if (!open) return
    function handlePointerDown(e: MouseEvent) {
      const target = e.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchorRef.current?.contains(target)) return
      onClose()
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [open, onClose, anchorRef])

  if (!open) return null

  return createPortal(
    <div
      ref={panelRef}
      className={`fixed z-[80] ${className}`}
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        // 首帧还没量到尺寸,先隐藏,避免从左上角闪一下
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  )
}
