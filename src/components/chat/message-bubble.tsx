'use client'

import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import type { TouchEvent as ReactTouchEvent } from 'react'
import { MessageSquare, Smile, MoreHorizontal, Pencil, Trash2, Bookmark, X, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { getSupabaseClient } from '@/lib/supabase/client'
import DOMPurify from 'dompurify'
import { useAppStore } from '@/lib/store/app-store'
import { EmojiPicker, QUICK_REACTIONS } from './emoji-picker'
import { FloatingPanel } from '@/components/ui/floating-panel'
import { useT, useRelativeTime, useDateLocale } from '@/lib/i18n'
import { isEmojiOnly, countEmoji } from '@/lib/emoji-data'
import { formatCountdown, formatDuration } from '@/lib/disappearing-messages'
import { pickToolbarSide, resolveTriangleOffset } from '@/lib/message-toolbar'
import { useSignedText } from '@/hooks/use-signed-text'
import type { Message, Reaction } from '@/types/database'

// Global cache for resolved mention display names (userId -> displayName)
const mentionNameCache: Record<string, string> = {}

// SSR 期间用 useEffect 兜底,避免 useLayoutEffect 在服务端报警告
// (与 FloatingPanel 同一写法)
const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect

// Render message content with markdown-like formatting
// 导出供「输入实时预览」的草稿气泡复用,保证两处渲染结果完全一致
export function renderMessageContent(text: string, mentionNames?: Record<string, string>): string {
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')

  html = html.replace(/```\n?([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>')
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(?<!\w)_(.+?)_(?!\w)/g, '<em>$1</em>')
  html = html.replace(/@([a-f0-9-]{36})/g, (_match, uuid) => {
    const name = mentionNames?.[uuid] || mentionNameCache[uuid] || uuid.slice(0, 8)
    return `<span class="mention-highlight">@${name}</span>`
  })
  html = html.replace(/@(\w+)/g, '<span class="mention-highlight">@$1</span>')

  // 图片语法 ![alt](url) —— 必须排在普通链接语法之前,
  // 否则 [alt](url) 会先被下面那条规则吃掉,只留下一个孤立的 "!"
  // 仅接受 http(s) 源,拒绝 data: / javascript: 等
  html = html.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (match, alt: string, src: string) => {
    if (!/^https?:\/\//i.test(src)) return match
    const safeAlt = alt.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    return `<img src="${src}" alt="${safeAlt}" class="chat-image" loading="lazy" />`
  })

  html = html.replace(
    /📎\s*\[([^\]]+)\]\(([^)]+)\)/g,
    '📎 <a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  )
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  )
  html = html.replace(
    /(?<!["\w])(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>'
  )

  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ['strong', 'em', 'code', 'pre', 'a', 'span', 'img'],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class', 'src', 'alt', 'loading'],
  })
}

interface MessageBubbleProps {
  message: Message
  showHeader: boolean
  isOwn: boolean
  isThread?: boolean
  /**
   * 布局模式。
   * - `row`(默认): Discord/Slack 风格,所有消息左对齐成一行行,适合多人群聊频道。
   * - `bubble`: 常见 IM 风格,对方靠左、自己靠右,带气泡背景,适合私聊。
   */
  layout?: 'row' | 'bubble'
  /**
   * 所属会话的阅后即焚时长(秒),null = 关闭。
   * 只用于「自己发的、对方还没读」时显示一个等待中的小时钟 ——
   * 倒计时本身由 message.expires_at 驱动,不依赖这个值。
   */
  disappearSeconds?: number | null
}

export function MessageBubble({ message, showHeader, isOwn, isThread, layout = 'row', disappearSeconds = null }: MessageBubbleProps) {
  const { user, openThread, openProfile, reactions, setReactions, addReaction, removeReaction, savedItemIds, toggleSavedItem } = useAppStore()
  const [hovered, setHovered] = useState(false)
  // 移动端长按唤起的工具栏(与 hover 并存:触屏没有 hover,长按是通行做法)
  const [longPressed, setLongPressed] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState(message.content)
  const [saveError, setSaveError] = useState(false)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [mentionNames, setMentionNames] = useState<Record<string, string>>({})
  const containerRef = useRef<HTMLDivElement>(null)
  // 气泡(内容区)的定位容器,工具栏据此测量、决定翻到气泡上方还是下方。
  // 必须是气泡而不是整行:行底部还有阅后即焚时钟等元素,锚在行上工具栏会离气泡很远。
  const bubbleAnchorRef = useRef<HTMLDivElement>(null)
  // 工具栏朝向:'top' = 悬在气泡上方(适合无名字行的短消息);
  // 'bottom' = 落在气泡下方(带名字行/长消息/上方没空间时)
  const [toolbarSide, setToolbarSide] = useState<'top' | 'bottom'>('bottom')
  // ── 长按手势状态 ──────────────────────────────────────────
  // 触屏设备没有 hover,此前只能靠「点击时浏览器合成的 mouseenter」触发工具栏,
  // 既不直觉、工具栏出现位置还会盖住上一条消息。改为长按 500ms 弹出,
  // 与微信/QQ/Discord 移动端一致;桌面端 hover 路径完全不受影响。
  const LONG_PRESS_MS = 500
  const LONG_PRESS_MOVE_TOLERANCE = 10
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressStartRef = useRef<{ x: number; y: number } | null>(null)
  // 三角标识相对工具栏锚定边的水平偏移(px)。
  // 固定死在中心,窄消息(工具栏比消息宽)时三角就会指向一片空白。
  const [triOffset, setTriOffset] = useState<number | null>(null)
  // 工具栏本体,量它的宽度以把三角夹在范围内
  const toolbarRef = useRef<HTMLDivElement>(null)
  // 表情回应按钮,作为 portal 浮层的定位锚点
  const reactionAnchorRef = useRef<HTMLButtonElement>(null)
  const t = useT()
  const relativeTime = useRelativeTime()
  const dateLocale = useDateLocale()

  const sender = message.sender
  const displayName = sender?.display_name || t('Unknown')
  const initial = displayName[0]?.toUpperCase() || '?'
  const time = relativeTime(message.created_at)
  const messageReactions = reactions[message.id] || []

  // 纯表情消息放大显示,贴近常见 IM 的观感。
  // 限制 1-3 个:超过 3 个说明是「表情串」,放大后反而占满屏幕。
  const emojiCount = countEmoji(message.content)
  const emojiOnly = emojiCount > 0 && emojiCount <= 3 && isEmojiOnly(message.content)

  // ── 阅后即焚倒计时 ──────────────────────────────────────────
  // 只有带 expires_at 的消息才需要每秒重渲染,列表里其余气泡完全不受影响。
  // 初始为 null 而不是立刻算一次:服务端渲染时算出来的值和客户端不一致会引发 hydration 报警。
  const expiresAt = message.expires_at ? new Date(message.expires_at).getTime() : null
  const [remainingMs, setRemainingMs] = useState<number | null>(null)

  useEffect(() => {
    if (expiresAt === null) {
      setRemainingMs(null)
      return
    }
    setRemainingMs(Math.max(0, expiresAt - Date.now()))
    const timer = setInterval(() => {
      setRemainingMs(Math.max(0, expiresAt - Date.now()))
    }, 1000)
    return () => clearInterval(timer)
  }, [expiresAt])

  // Resolve @mention UUIDs to display names
  useEffect(() => {
    const uuids = [...message.content.matchAll(/@([a-f0-9-]{36})/g)].map((m) => m[1])
    if (uuids.length === 0) return

    // Check cache first
    const uncached = uuids.filter((id) => !mentionNameCache[id])
    if (uncached.length === 0) {
      setMentionNames({ ...mentionNameCache })
      return
    }

    const client = getSupabaseClient()
    if (!client) return

    client
      .from('profiles')
      .select('id, display_name')
      .in('id', uncached)
      .then(({ data }) => {
        if (data) {
          const resolved: Record<string, string> = { ...mentionNameCache }
          data.forEach((p: { id: string; display_name: string }) => {
            mentionNameCache[p.id] = p.display_name
            resolved[p.id] = p.display_name
          })
          setMentionNames(resolved)
        }
      })
  }, [message.content])

  useEffect(() => {
    const client = getSupabaseClient()
    if (!client) return
    client
      .from('reactions')
      .select('*')
      .eq('message_id', message.id)
      .then(({ data }) => {
        if (data) setReactions(message.id, data as Reaction[])
      })
  }, [message.id])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowMoreMenu(false)
      }
    }
    // 表情面板已 portal 到 body,由 FloatingPanel 自己处理外部点击,
    // 这里只负责「更多操作」菜单,否则点面板内部会被误判成外部点击。
    if (showMoreMenu) {
      document.addEventListener('mousedown', handleClick)
      return () => document.removeEventListener('mousedown', handleClick)
    }
  }, [showMoreMenu])

  // ── 长按手势 ─────────────────────────────────────────────
  // 手指落在**可交互元素**(链接/按钮/图片/输入框)上时直接放行,
  // 让原生点击行为优先 —— 否则长按会抢走「打开链接」「看大图」。
  function isInteractiveTouchTarget(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false
    return target.closest('a, button, img, input, textarea, select') !== null
  }

  function cancelLongPress() {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressStartRef.current = null
  }

  function handleTouchStart(e: ReactTouchEvent) {
    if (isInteractiveTouchTarget(e.target)) return
    const touch = e.touches[0]
    if (!touch) return
    longPressStartRef.current = { x: touch.clientX, y: touch.clientY }
    cancelLongPress()
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null
      setLongPressed(true)
      // 轻微震动反馈(Android 支持;iOS Safari 无此 API,静默降级)
      if (typeof navigator.vibrate === 'function') navigator.vibrate(10)
    }, LONG_PRESS_MS)
  }

  function handleTouchMove(e: ReactTouchEvent) {
    const start = longPressStartRef.current
    if (!start) return
    const touch = e.touches[0]
    if (!touch) return
    // 移动超过容差视为「在滚动列表」,取消长按,不能打断翻消息
    if (
      Math.abs(touch.clientX - start.x) > LONG_PRESS_MOVE_TOLERANCE ||
      Math.abs(touch.clientY - start.y) > LONG_PRESS_MOVE_TOLERANCE
    ) {
      cancelLongPress()
    }
  }

  // 卸载时清掉未触发的定时器,避免 setState 到已销毁组件
  useEffect(() => cancelLongPress, [])

  // 长按唤出后:点到**这条消息之外**(别的消息/空白处)即收起。
  // 用 touchstart 而不是 click —— 手指一按就收,手感更快;
  // capture 阶段执行,保证早于其它消息的长按定时器启动,不会两条同时开。
  useEffect(() => {
    if (!longPressed) return
    function dismiss(e: Event) {
      const node = e.target as Node | null
      if (node && containerRef.current?.contains(node)) return
      setLongPressed(false)
    }
    document.addEventListener('touchstart', dismiss, true)
    // 部分触屏笔记本/混合设备只会派发鼠标事件
    document.addEventListener('mousedown', dismiss, true)
    // 滚动列表时也收起:否则工具栏会漂到别的消息头上
    window.addEventListener('scroll', dismiss, true)
    return () => {
      document.removeEventListener('touchstart', dismiss, true)
      document.removeEventListener('mousedown', dismiss, true)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [longPressed])

  async function handleReaction(emoji: string) {
    const client = getSupabaseClient()
    if (!client || !user) return

    const existing = messageReactions.find(
      (r) => r.emoji === emoji && r.profile_id === user.id
    )

    if (existing) {
      await client.from('reactions').delete().eq('id', existing.id)
      removeReaction(message.id, existing.id)
    } else {
      const { data } = await client
        .from('reactions')
        .insert({ message_id: message.id, profile_id: user.id, emoji })
        .select()
        .single()
      if (data) addReaction(message.id, data as Reaction)
    }
    setShowEmojiPicker(false)
  }

  async function handleEdit() {
    const client = getSupabaseClient()
    if (!client || !editContent.trim()) return
    await client.from('messages').update({ content: editContent.trim(), is_edited: true }).eq('id', message.id)
    message.content = editContent.trim()
    message.is_edited = true
    setEditing(false)
  }

  /**
   * 撤回。不限时间,本人可撤回自己的任意消息。
   * 同时清空 content —— 撤回的意义就是内容不再留存,只保留一条占位提示。
   */
  async function handleRecall() {
    const client = getSupabaseClient()
    if (!client) return
    await client
      .from('messages')
      .update({ is_deleted: true, content: '' })
      .eq('id', message.id)
    message.content = ''
    message.is_deleted = true
    setShowMoreMenu(false)
  }

  const grouped = messageReactions.reduce<
    Record<string, { emoji: string; count: number; myReaction: boolean }>
  >((acc, r) => {
    if (!acc[r.emoji]) acc[r.emoji] = { emoji: r.emoji, count: 0, myReaction: false }
    acc[r.emoji].count++
    if (r.profile_id === user?.id) acc[r.emoji].myReaction = true
    return acc
  }, {})

  // 工具栏显示条件:hover(桌面)/ 长按(触屏)/ 子浮层开着
  const showToolbar = hovered || longPressed || showEmojiPicker || showMoreMenu

  // 附件桶已私有化:正文里的图片/文件直链先换成签名 URL 再渲染。
  // 没有附件时 useSignedText 原样返回同一字符串,零开销零渲染。
  // 注意必须放在 is_deleted 提前返回**之前** —— hook 不能有条件调用。
  const signedContent = useSignedText(message.content)

  // ── 布局计算 ──────────────────────────────────────────────
  // bubble 模式下,自己的消息靠右并镜像排列(头像跑到右边)。
  const isBubble = layout === 'bubble'
  const alignRight = isBubble && isOwn

  // 外层对齐容器:仅 bubble 模式需要,负责把整条消息推到左/右
  const alignWrapperClass = isBubble ? `flex ${alignRight ? 'justify-end' : 'justify-start'}` : ''

  // 单条消息本体
  const rowClass = isBubble
    ? `relative flex gap-2.5 max-w-[78%] px-2 py-1 rounded-xl ${alignRight ? 'flex-row-reverse' : ''}`
    : `relative flex gap-2.5 px-3 -mx-3 rounded-xl ${showHeader ? 'pt-2 py-1' : 'py-0.5'}`

  // 内容列:bubble 模式用 flex-col 让气泡按内容宽度收缩
  const contentColClass = isBubble
    ? `min-w-0 max-w-full flex flex-col ${alignRight ? 'items-end' : 'items-start'}`
    : 'min-w-0 flex-1'

  // 头像/时间槽的左边距,供表情回应、线程指示器对齐使用
  const gutterClass = alignRight ? 'mr-11' : 'ml-11'

  // 工具栏贴着气泡的同侧边生长:自己的消息(靠右)向右对齐、向左生长,
  // 否则向左对齐、向右生长 —— 无论哪种都不会越过列表容器外缘。
  // (锚点是气泡外的 relative 容器,left-0/right-0 即气泡的内容边缘。)
  const toolbarPosClass = alignRight ? 'right-0' : 'left-0'

  /**
   * 工具栏朝向自动决策 + 三角水平定位(详见 lib/message-toolbar.ts):
   *  · 带「名字+时间」行的消息 → 只在气泡下方,不出现在名称上方;
   *  · 内容多的消息 → 下方;
   *  · 视口里放不下 → 翻到另一侧(下方放不下翻上,上方放不下翻下);
   *  · 其余短消息 → 悬在气泡上方。
   * 三角指向消息**首行文字的中心**(Range 量第一行),拿不到时退化为
   * 气泡中心,并夹在工具栏范围内 —— 否则窄消息下三角指向空白,很怪。
   * 悬停期间持续监听滚动/缩放,消息滚到视口边缘时自动改向。
   */
  useIsoLayoutEffect(() => {
    if (!showToolbar) return
    const anchor = bubbleAnchorRef.current
    if (!anchor) return
    const measure = () => {
      const rect = anchor.getBoundingClientRect()
      setToolbarSide(pickToolbarSide({
        hasHeader: showHeader,
        bubbleHeight: rect.height,
        topInViewport: rect.top,
        bottomInViewport: rect.bottom,
        viewportHeight: window.innerHeight,
      }))

      // 三角定位:工具栏此刻一定已渲染(effect 在 DOM 提交后跑)
      const toolbar = toolbarRef.current
      if (!toolbar) return
      const tb = toolbar.getBoundingClientRect()
      const content = anchor.querySelector('.message-content')
      let targetX: number | null = null
      if (content) {
        const range = document.createRange()
        range.selectNodeContents(content)
        const first = range.getClientRects()[0]
        // 首行文字的中心就是「这条消息」在人眼中的位置
        if (first) targetX = first.left + first.width / 2
      }
      setTriOffset(resolveTriangleOffset({
        targetX,
        bubbleRect: rect,
        toolbarRect: tb,
        alignRight,
      }))
    }
    measure()
    window.addEventListener('resize', measure)
    // capture 阶段监听,滚动容器内滚动也能收到
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [showToolbar, showHeader, alignRight])

  // 已撤回:不再渲染内容,只留一行系统提示(微信/QQ 的通行做法),
  // 这样对方知道「这里原本有消息被撤回了」,而不是凭空少了一条。
  // 位置必须在所有 hooks 之后 —— 提前 return 会跳过后面的 hooks,React 会报错。
  if (message.is_deleted) {
    return (
      <div className={isBubble ? `flex ${alignRight ? 'justify-end' : 'justify-start'}` : ''}>
        <span
          className={`text-xs italic py-1 ${isBubble ? '' : 'pl-12'}`}
          style={{ color: '#8E8EA0' }}
        >
          {isOwn
            ? t('You recalled a message')
            : t('{name} recalled a message', { name: displayName })}
        </span>
      </div>
    )
  }

  return (
    <div ref={containerRef}>
      <div className={alignWrapperClass}>
      <div
        className={rowClass}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={cancelLongPress}
        onTouchCancel={cancelLongPress}
      >

        {/* AVATAR / TIMESTAMP */}
        {showHeader ? (
          <button
            onClick={() => message.sender_id && openProfile(message.sender_id)}
            className="h-9 w-9 rounded-xl shrink-0 mt-0.5 hover:opacity-80 transition-opacity cursor-pointer overflow-hidden"
          >
            {sender?.avatar_url ? (
              <img src={sender.avatar_url} alt={displayName} className="h-9 w-9 rounded-xl object-cover" />
            ) : (
              <div className="h-9 w-9 rounded-xl flex items-center justify-center text-sm font-bold text-white" style={{ background: '#7C5CFC' }}>
                {initial}
              </div>
            )}
          </button>
        ) : (
          <div className="w-9 shrink-0 flex items-center justify-center">
            <span className={`text-[10px] text-[#8E8EA0] transition-opacity ${showToolbar ? 'opacity-100' : 'opacity-0'}`}>
              {new Date(message.created_at).toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        )}

        {/* CONTENT */}
        <div className={contentColClass}>
          {showHeader && (
            isBubble ? (
              // 气泡模式:自己的消息不重复显示名字,只留时间戳
              <div className={`flex items-baseline gap-1.5 mb-1 ${alignRight ? 'flex-row-reverse' : ''}`}>
                {!isOwn && (
                  <button
                    onClick={() => message.sender_id && openProfile(message.sender_id)}
                    className="font-semibold text-[13px] hover:underline cursor-pointer"
                    style={{ color: '#2D2B3D' }}
                  >
                    {displayName}
                  </button>
                )}
                <span className="text-[11px]" style={{ color: '#8E8EA0' }}>{time}</span>
                {message.is_edited && <span className="text-[11px] italic" style={{ color: '#8E8EA0' }}>{t('(edited)')}</span>}
              </div>
            ) : (
              <div className="flex items-baseline gap-2">
                <button
                  onClick={() => message.sender_id && openProfile(message.sender_id)}
                  className="font-semibold text-[15px] hover:underline cursor-pointer"
                  style={{ color: '#2D2B3D' }}
                >
                  {displayName}
                </button>
                <span className="text-xs" style={{ color: '#8E8EA0' }}>{time}</span>
                {message.is_edited && <span className="text-xs italic" style={{ color: '#8E8EA0' }}>{t('(edited)')}</span>}
              </div>
            )
          )}
          {editing ? (
            <div className="mt-1">
              <textarea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                className="w-full text-[15px] bg-white rounded-xl p-3 border border-[#E5E1EE] focus:outline-none focus:ring-2 focus:ring-[#7C5CFC] focus:border-transparent"
                rows={2}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleEdit() }
                  if (e.key === 'Escape') setEditing(false)
                }}
              />
              <div className="flex gap-2 mt-1">
                <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>{t('Cancel')}</Button>
                <Button size="sm" onClick={handleEdit} style={{ background: '#7C5CFC', color: '#fff' }}>{t('Save')}</Button>
              </div>
            </div>
          ) : (
            <div ref={bubbleAnchorRef} className="relative">
              <div className={isBubble ? `message-bubble ${isOwn ? 'message-bubble-own' : ''}` : undefined}>
                <div
                  className={`text-[15px] leading-[1.5] whitespace-pre-wrap break-words message-content${emojiOnly ? ' is-emoji-only' : ''}`}
                  style={{ color: alignRight ? '#ffffff' : '#2D2B3D' }}
                  onClick={(e) => {
                    const el = e.target as HTMLElement
                    if (el instanceof HTMLImageElement && el.classList.contains('chat-image')) {
                      setLightboxSrc(el.src)
                    }
                  }}
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(renderMessageContent(signedContent, mentionNames)) }}
                />
              </div>
              {/* ACTION TOOLBAR —— 渲染在气泡的 relative 锚点里,不是整行:
                  ① 上下相对「气泡」而非整行,不会沉到阅后即焚时钟下面、
                     离消息老远(用户反馈「太靠下、距离远」);
                  ② before: 伪元素是「悬停桥」,填住工具栏与气泡之间的 6px 间距。
                     没有它,鼠标穿过间距的瞬间 hovered 置 false、工具栏直接消失,
                     用户就永远点不到上面的按钮 —— 「只能看不能点」就是这么来的。 */}
              {showToolbar && !editing && (
                <div
                  ref={toolbarRef}
                  className={`absolute ${toolbarPosClass} flex items-center bg-white border border-[#E5E1EE] rounded-xl shadow-sm z-10 before:absolute before:left-0 before:right-0 before:h-1.5 before:content-[''] ${
                    toolbarSide === 'top' ? 'bottom-full mb-1.5 before:-bottom-1.5' : 'top-full mt-1.5 before:-top-1.5'
                  }`}
                  style={{ '--tri-x': triOffset === null ? '50%' : `${triOffset}px` } as React.CSSProperties}
                >
                  {/* 三角标识:永远指向这条消息(首行文字中心),不是工具栏中心。
                      窄消息时工具栏比消息宽,固定在中心的三角会指向一片空白。
                      水平位置由 --tri-x 驱动(measure 里算出),自己消息从右缘量、
                      对方消息从左缘量;量到之前先用 50% 兜底不闪。 */}
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none absolute ${alignRight ? 'right-[var(--tri-x)]' : 'left-[var(--tri-x)]'} -translate-x-1/2 h-2.5 w-2.5 rotate-45 border-[#E5E1EE] bg-white ${
                      toolbarSide === 'top'
                        ? 'bottom-0 translate-y-1/2 border-b border-r'
                        : 'top-0 -translate-y-1/2 border-l border-t'
                    }`}
                  />
                  {QUICK_REACTIONS.slice(0, 3).map((emoji) => (
                    <button
                      key={emoji}
                      onClick={() => handleReaction(emoji)}
                      className="h-8 w-8 flex items-center justify-center hover:bg-[#F5F2FF] rounded-xl text-sm transition-colors"
                      title={t('React with {emoji}', { emoji })}
                    >
                      {emoji}
                    </button>
                  ))}
                  <div className="relative">
                    <button
                      ref={reactionAnchorRef}
                      onClick={() => { setShowEmojiPicker(!showEmojiPicker); setShowMoreMenu(false) }}
                      className="h-8 w-8 flex items-center justify-center hover:bg-[#F5F2FF] rounded-xl transition-colors text-[#8E8EA0]"
                      title={t('Add reaction')}
                    >
                      <Smile className="h-4 w-4" />
                    </button>
                  </div>
                  {!isThread && (
                    <button
                      onClick={() => openThread(message)}
                      className="h-8 w-8 flex items-center justify-center hover:bg-[#F5F2FF] rounded-xl transition-colors text-[#8E8EA0]"
                      title={t('Reply in thread')}
                    >
                      <MessageSquare className="h-4 w-4" />
                    </button>
                  )}
                  <button
                    onClick={async () => {
                      const client = getSupabaseClient()
                      if (!client || !user) return
                      const isSaved = savedItemIds.has(message.id)
                      try {
                        if (isSaved) {
                          const { error } = await client.from('saved_items').delete().eq('message_id', message.id).eq('user_id', user.id)
                          if (error) throw error
                          toggleSavedItem(message.id)
                        } else {
                          const workspaceId = useAppStore.getState().workspace?.id
                          if (!workspaceId) return
                          const { error } = await client.from('saved_items').insert({
                            user_id: user.id,
                            message_id: message.id,
                            workspace_id: workspaceId,
                          })
                          if (error) throw error
                          toggleSavedItem(message.id)
                        }
                      } catch (err) {
                        console.error('Failed to save/unsave item:', err)
                        setSaveError(true)
                        setTimeout(() => setSaveError(false), 3000)
                      }
                    }}
                    className={`h-8 w-8 flex items-center justify-center hover:bg-[#F5F2FF] rounded-xl transition-colors ${
                      savedItemIds.has(message.id) ? 'text-[#7C5CFC]' : 'text-[#8E8EA0]'
                    }`}
                    title={savedItemIds.has(message.id) ? t('Remove from saved') : t('Save message')}
                  >
                    <Bookmark className={`h-4 w-4 ${savedItemIds.has(message.id) ? 'fill-current' : ''}`} />
                  </button>
                  {saveError && (
                    <div className="absolute right-0 top-9 bg-red-50 border border-red-200 text-red-600 text-[11px] px-2 py-1 rounded-lg whitespace-nowrap z-50 shadow-sm">
                      {t('Failed — open Saved Items panel to fix')}
                    </div>
                  )}
                  <div className="relative">
                    <button
                      onClick={() => { setShowMoreMenu(!showMoreMenu); setShowEmojiPicker(false) }}
                      className="h-8 w-8 flex items-center justify-center hover:bg-[#F5F2FF] rounded-xl transition-colors text-[#8E8EA0]"
                      title={t('More actions')}
                    >
                      <MoreHorizontal className="h-4 w-4" />
                    </button>
                    {showMoreMenu && (
                      <div className="absolute right-0 top-9 bg-white border border-[#E5E1EE] rounded-xl shadow-lg py-1 min-w-[180px] z-50">
                        {isOwn && (
                          <button
                            onClick={() => { setEditing(true); setEditContent(message.content); setShowMoreMenu(false) }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-[#F5F2FF] text-left text-[#2D2B3D] rounded-lg mx-0"
                          >
                            <Pencil className="h-3.5 w-3.5" /> {t('Edit message')}
                          </button>
                        )}
                        {!isThread && (
                          <button
                            onClick={() => { openThread(message); setShowMoreMenu(false) }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-[#F5F2FF] text-left text-[#2D2B3D] rounded-lg"
                          >
                            <MessageSquare className="h-3.5 w-3.5" /> {t('Reply in thread')}
                          </button>
                        )}
                        {isOwn && (
                          <button
                            onClick={handleRecall}
                            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-red-50 text-[#E55B5B] text-left rounded-lg"
                          >
                            <Trash2 className="h-3.5 w-3.5" /> {t('Recall message')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* 阅后即焚标记:
              · 已开始倒计时 → 显示剩余时间(橙)
              · 自己发的、对方还没读 → 只留一个灰色小时钟,表示「读了才开始计时」 */}
          {remainingMs !== null ? (
            <span
              className={`inline-flex items-center gap-1 mt-0.5 text-[11px] ${alignRight ? 'flex-row-reverse' : ''}`}
              style={{ color: '#F59E0B' }}
              title={t('This message will disappear')}
            >
              <Clock className="h-3 w-3" />
              {formatCountdown(remainingMs, t)}
            </span>
          ) : isOwn && disappearSeconds !== null ? (
            <span
              className={`inline-flex items-center gap-1 mt-0.5 text-[11px] ${alignRight ? 'flex-row-reverse' : ''}`}
              style={{ color: '#8E8EA0' }}
              title={t('Disappears {value} after being read', {
                value: formatDuration(disappearSeconds, t),
              })}
            >
              <Clock className="h-3 w-3" />
            </span>
          ) : null}
        </div>
      </div>
      </div>

      {/* REACTIONS */}
      {Object.keys(grouped).length > 0 && (
        <div className={`flex flex-wrap gap-1 mt-1 ${gutterClass} ${isBubble ? (alignRight ? 'justify-end' : 'justify-start') : ''}`}>
          {Object.values(grouped).map((r) => (
            <button
              key={r.emoji}
              onClick={() => handleReaction(r.emoji)}
              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs border transition-all ${
                r.myReaction
                  ? 'bg-[#EDE5FF] border-[#7C5CFC]/30 text-[#7C5CFC]'
                  : 'bg-[#F5F2FF] border-[#E5E1EE] hover:border-[#DDD6F3]'
              }`}
            >
              <span>{r.emoji}</span>
              <span>{r.count}</span>
            </button>
          ))}
          <button
            onClick={() => setShowEmojiPicker(true)}
            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs border border-dashed border-[#DDD6F3] hover:border-[#7C5CFC] text-[#8E8EA0]"
          >
            <Smile className="h-3 w-3" />
          </button>
        </div>
      )}

      {/* THREAD INDICATOR */}
      {!isThread && message.thread_reply_count > 0 && (
        <div className={isBubble ? `flex ${alignRight ? 'justify-end' : 'justify-start'}` : ''}>
        <button
          onClick={() => openThread(message)}
          className={`flex items-center gap-1.5 ${gutterClass} mt-1 text-xs hover:underline font-semibold`}
          style={{ color: '#7C5CFC' }}
        >
          <MessageSquare className="h-3 w-3" />
          {message.thread_reply_count} {t(message.thread_reply_count === 1 ? 'reply' : 'replies')}
        </button>
        </div>
      )}

      {/* EMOJI REACTION PICKER
          portal 到 body 并用 fixed 定位,否则会被消息列表容器的
          overflow-x-hidden 裁掉(移动端尤其明显)。 */}
      <FloatingPanel
        anchorRef={reactionAnchorRef}
        open={showEmojiPicker}
        onClose={() => setShowEmojiPicker(false)}
        align={alignRight ? 'end' : 'start'}
        gap={6}
      >
        <EmojiPicker onSelect={handleReaction} onClose={() => setShowEmojiPicker(false)} />
      </FloatingPanel>

      {/* IMAGE LIGHTBOX */}
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-6 cursor-zoom-out"
          onClick={() => setLightboxSrc(null)}
          role="dialog"
          aria-modal="true"
        >
          <img
            src={lightboxSrc}
            alt=""
            className="max-h-full max-w-full rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setLightboxSrc(null)}
            className="absolute top-4 right-4 h-9 w-9 rounded-full bg-white/90 text-[#2D2B3D] flex items-center justify-center hover:bg-white transition-colors"
            aria-label={t('Close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  )
}
