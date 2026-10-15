'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { getSupabaseClient } from '@/lib/supabase/client'
import { useAppStore } from '@/lib/store/app-store'
import { MessageBubble } from './message-bubble'
import { MessageInput } from './message-input'
import { ThreadPanel } from './thread-panel'
import { UserProfilePanel } from './user-profile-panel'
import { ChannelSettingsDialog } from './channel-settings-dialog'
import { DisappearTimerMenu } from './disappear-timer-menu'
import { LivePreviewToggle } from './live-preview-toggle'
import { ClearConversationButton } from './clear-conversation-button'
import { DraftBubble } from './draft-bubble'
import { CallSetupDialog } from '@/components/calls/call-setup-dialog'
import type { Channel, Message, ActiveCall } from '@/types/database'
import { Hash, Lock, Users, Loader2, LogIn, Phone, PhoneOff, Video, Menu, Clock, Eye, AlertCircle, X } from 'lucide-react'
import { useMobile } from '@/hooks/use-mobile'
import { useT } from '@/lib/i18n'
import { formatDuration, isExpired } from '@/lib/disappearing-messages'
import { filterVisibleMessages, parseClearedAt } from '@/lib/clear-conversation'
import {
  DRAFT_EVENT,
  createDraftBroadcaster,
  draftTopic,
  isStaleClear,
  pruneDrafts,
  type DraftPayload,
} from '@/lib/live-preview'
import { describeSupabaseError, isSchemaNotMigrated } from '@/lib/supabase/errors'
import type { RealtimeChannel } from '@supabase/supabase-js'

const PAGE_SIZE = 50

/**
 * 判定「用户正贴着底部」的容差(px)。
 * 消息列表的自动滚动、以及草稿气泡的跟随滚动都用它,
 * 抽成常量是为了两处口径一致 —— 否则会出现「新消息会跟、草稿不跟」这种怪现象。
 */
const NEAR_BOTTOM_MARGIN = 200

interface ChannelViewProps {
  channel: Channel
  isPreview?: boolean
}

export function ChannelView({ channel, isPreview = false }: ChannelViewProps) {
  const { user, workspace, threadParentMessage, profileUserId, dmChannels, openProfile, addChannel, updateChannel, setCurrentChannelId, setPreviewChannel, channelActiveCalls, setChannelActiveCall, joinCall, isInCall, toggleSidebar, livePreviewChannelIds, setLivePreviewEnabled } = useAppStore()
  const { isMobile, isDesktop } = useMobile()
  const t = useT()
  const isDm = channel.name.startsWith('dm-')
  const isGroupDm = channel.name.startsWith('gdm-')
  const isDirectMessage = isDm || isGroupDm
  const dmInfo = isDirectMessage ? dmChannels.find((d) => d.id === channel.id) : null
  const displayChannelName = isGroupDm
    ? (dmInfo?.memberProfiles || []).map(m => m.display_name).join(', ') || t('Group DM')
    : isDm && dmInfo?.otherUser
      ? dmInfo.otherUser.display_name
      : channel.name
  const [channelSettingsOpen, setChannelSettingsOpen] = useState(false)
  const [joiningChannel, setJoiningChannel] = useState(false)
  const [startingCall, setStartingCall] = useState(false)
  const [callSetupOpen, setCallSetupOpen] = useState(false)
  const channelCall = channelActiveCalls[channel.id] || null
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const messagesRef = useRef<Message[]>([])
  const isInitialLoad = useRef(true)
  /**
   * 阅后即焚:已经请求过 mark_messages_seen 的消息 id。
   * 用 ref 而不是 state —— 它只用来去重,不该触发渲染;
   * 而且 realtime 把 expires_at 回包后会再次进入 effect,没有它会重复打请求。
   */
  const seenRequestedRef = useRef<Set<string>>(new Set())

  /**
   * 清空会话:我在这个会话里的**视图截止点**。null = 从未清空过。
   * 早于它的消息只对我不可见 —— 这是「隐藏」,不是删除,对方的记录一条没少。
   * 存在 channel_members.cleared_at 里,所以换设备、重开浏览器都还在。
   */
  const [clearedAt, setClearedAt] = useState<string | null>(null)

  /** 清空失败时的提示。清空是用户主动发起的,失败必须说出来,不能默默没反应。 */
  const [clearError, setClearError] = useState<string | null>(null)

  /** 当前会话的阅后即焚时长(秒)。null = 关闭。 */
  const disappearSeconds = channel.disappear_seconds ?? null

  /**
   * 列表里是否还有「正在倒计时」的消息。
   * 开关关掉之后,已经开跑的倒计时仍然要走完 —— 否则那些消息会永远留在界面上。
   */
  const hasScheduledExpiry = messages.some((m) => m.expires_at !== null)

  // ── 输入实时预览(草稿广播)────────────────────────────────
  /**
   * 是否开启。**按会话独立**,存在本机 localStorage 里。
   *
   * 注意语义:这是「预发布」——开启只代表「我打的内容要实时广播出去」,
   * 对方无需开启任何东西就能看到。所以它不参与「接收」的判断。
   */
  const livePreviewEnabled = livePreviewChannelIds.includes(channel.id)
  /** 别人正在打的字。key = userId,过期由 pruneDrafts 剔除。 */
  const [drafts, setDrafts] = useState<Record<string, DraftPayload>>({})
  const draftChannelRef = useRef<RealtimeChannel | null>(null)
  const draftBroadcasterRef = useRef<ReturnType<typeof createDraftBroadcaster> | null>(null)
  /**
   * 每个用户最后一次被接受的**有效内容**的 sentAt。
   * 用来抵御 Supabase broadcast 的乱序/重复:迟到的旧「清空」信号
   * 不能抹掉正在打字的活草稿。用 ref 而不进 state —— 只参与接收判定,不触发渲染。
   */
  const lastContentSentAtRef = useRef<Record<string, number>>({})
  /**
   * 用户是否正贴着列表底部。
   * 用 ref 而不是 state:它只被滚动回调写、被滚动决策读,不该触发渲染。
   */
  const nearBottomRef = useRef(true)

  useEffect(() => {
    messagesRef.current = messages
  }, [messages])

  const scrollToBottom = useCallback(() => {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }, [])

  const loadOlderMessages = useCallback(async () => {
    if (loadingMore || !hasMore || messages.length === 0) return

    const client = getSupabaseClient()
    if (!client) return

    setLoadingMore(true)
    const oldestMessage = messages[0]
    const scrollContainer = scrollContainerRef.current
    const prevScrollHeight = scrollContainer?.scrollHeight || 0

    let query = client
      .from('messages')
      .select('*, sender:profiles(*)')
      .eq('channel_id', channel.id)
      .is('parent_id', null)
      .lt('created_at', oldestMessage.created_at)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE)

    // 清空过:截止点之前的消息对我不可见,不能再往更早翻。
    // 加上这个条件后,翻到边界时这一页会不足 PAGE_SIZE,
    // 下面的 `data.length < PAGE_SIZE` 自然就把 hasMore 关掉了。
    if (clearedAt !== null) query = query.gt('created_at', clearedAt)

    const { data } = await query

    if (data) {
      const now = Date.now()
      const olderMessages = (data as Message[])
        .reverse()
        .filter((m) => !isExpired(m.expires_at, now))
      // 用 data.length 而不是过滤后的长度判断还有没有更早的消息 ——
      // 被过滤掉的是「已过期」的行,不代表这一页已经翻到头了。
      if (data.length < PAGE_SIZE) {
        setHasMore(false)
      }
      if (olderMessages.length > 0) {
        setMessages((prev) => {
          const existingIds = new Set(prev.map((m) => m.id))
          const unique = olderMessages.filter((m) => !existingIds.has(m.id))
          return [...unique, ...prev]
        })
        requestAnimationFrame(() => {
          if (scrollContainer) {
            const newScrollHeight = scrollContainer.scrollHeight
            scrollContainer.scrollTop = newScrollHeight - prevScrollHeight
          }
        })
      }
    }

    setLoadingMore(false)
  }, [loadingMore, hasMore, messages, channel.id, clearedAt])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) return

    function handleScroll() {
      // 持续记录「是否贴着底部」。滚到底之后插入新内容不会改变 scrollTop,
      // 因此不会触发 scroll 事件,这个标记会一直保持准确。
      nearBottomRef.current =
        container!.scrollHeight - container!.scrollTop - container!.clientHeight < NEAR_BOTTOM_MARGIN

      if (container!.scrollTop < 100 && !loadingMore && hasMore && !loading) {
        loadOlderMessages()
      }
    }

    container.addEventListener('scroll', handleScroll)
    return () => container.removeEventListener('scroll', handleScroll)
  }, [loadOlderMessages, loadingMore, hasMore, loading])

  useEffect(() => {
    const client = getSupabaseClient()
    if (!client) return

    async function loadMessages() {
      setLoading(true)
      setHasMore(true)
      isInitialLoad.current = true

      // 先取「我清到哪一刻」,再按它过滤消息。顺序不能反 ——
      // 先拉消息的话,清空之前的那些会先闪一下再被过滤掉,
      // 而那恰恰是用户明确要求隐藏的内容。
      const { data: memberRow, error: memberError } = await client!
        .from('channel_members')
        .select('cleared_at')
        .eq('channel_id', channel.id)
        .eq('profile_id', user?.id ?? '')
        .maybeSingle()

      if (memberError) {
        console.error('Failed to load cleared_at:', describeSupabaseError(memberError))
      }
      const since = parseClearedAt(memberRow?.cleared_at)
      setClearedAt(since)

      let query = client!
        .from('messages')
        .select('*, sender:profiles(*)')
        .eq('channel_id', channel.id)
        .is('parent_id', null)
        .order('created_at', { ascending: false })
        .limit(PAGE_SIZE)

      if (since !== null) query = query.gt('created_at', since)

      const { data } = await query

      if (data) {
        const now = Date.now()
        const loaded = (data as Message[]).reverse()
        // 过滤掉「已经到点、但上次没人在线所以没被清掉」的行。
        const notExpired = loaded.filter((m) => !isExpired(m.expires_at, now))
        // 再兜一层「清空」过滤:SQL 那边已经带了条件,但万一
        // cleared_at 是刚写进去的、PostgREST 读到的还是旧快照,
        // 也不至于把用户要求隐藏的消息漏出来。
        const msgs = filterVisibleMessages(notExpired, since)
        setMessages(msgs)
        if (data.length < PAGE_SIZE) {
          setHasMore(false)
        }

        // 确实有该清没清的行,顺手让数据库删掉 —— 否则它们会一直躺着,
        // 每次打开会话都要被过滤一遍。RPC 只删调用者所在会话里已过期的行。
        if (notExpired.length !== loaded.length) {
          client!.rpc('purge_expired_messages').then(({ error }) => {
            if (error) console.error('Failed to purge expired messages:', describeSupabaseError(error))
          })
        }

        setTimeout(() => {
          bottomRef.current?.scrollIntoView({ behavior: 'instant' })
          isInitialLoad.current = false
        }, 100)
      }
      setLoading(false)
    }

    async function fetchMessage(id: string): Promise<Message | null> {
      const { data } = await client!
        .from('messages')
        .select('*, sender:profiles(*)')
        .eq('id', id)
        .single()
      return data as Message | null
    }

    loadMessages()

    const channelSub = client
      .channel(`messages:${channel.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channel.id}`,
        },
        async (payload) => {
          if (payload.new.parent_id) return

          const fullMessage = await fetchMessage(payload.new.id)
          if (fullMessage) {
            setMessages((prev) => {
              if (prev.some((m) => m.id === fullMessage.id)) return prev
              return [...prev, fullMessage]
            })
            const container = scrollContainerRef.current
            if (container) {
              const isNearBottom =
                container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_BOTTOM_MARGIN
              if (isNearBottom || payload.new.sender_id === user?.id) {
                scrollToBottom()
              }
            }
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channel.id}`,
        },
        async (payload) => {
          // 撤回后不再把消息从列表里抹掉,而是就地更新成「XXX 撤回了一条消息」占位,
          // 否则对方只会看到消息凭空消失,不知道发生了什么。
          const updated = await fetchMessage(payload.new.id)
          if (updated) {
            setMessages((prev) =>
              prev.map((m) => (m.id === updated.id ? updated : m))
            )
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'messages',
          filter: `channel_id=eq.${channel.id}`,
        },
        (payload) => {
          // 阅后即焚到点后由 purge_expired_messages() 硬删除,这里同步摘掉本地那条。
          // 依赖 messages 的 REPLICA IDENTITY FULL —— 否则 payload.old 只剩主键,
          // 连 channel_id 都拿不到,按频道过滤和定位都无从谈起。
          const removed = payload.old as { id?: string }
          if (removed?.id) {
            setMessages((prev) => prev.filter((m) => m.id !== removed.id))
          }
        }
      )
      .subscribe()

    // 阅后即焚是**频道级共享开关**:对方在另一个客户端改了它,本地必须立刻同步。
    // 少了这条订阅,「我开了、对方没开」时对方界面仍显示关闭(状态条、菜单勾选、
    // 消息角标全不对),用户会以为功能没生效又去开一次。
    // RLS 下频道成员即可收到 channels 的 UPDATE(payload.new 带整行)。
    const settingsSub = client
      .channel(`channel-settings:${channel.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'channels',
          filter: `id=eq.${channel.id}`,
        },
        (payload) => {
          updateChannel(channel.id, payload.new as Channel)
        }
      )
      .subscribe()

    return () => {
      channelSub.unsubscribe()
      settingsSub.unsubscribe()
    }
  }, [channel.id, scrollToBottom, user?.id, updateChannel])

  // 切换会话时清空去重表,免得把上一个会话的消息 id 带过来
  useEffect(() => {
    seenRequestedRef.current.clear()
  }, [channel.id])

  /**
   * 阅后即焚 · 阅读触发。
   *
   * 倒计时由**阅读方**发起:把「别人的、还没开始计时的」消息交给
   * mark_messages_seen(),由它在数据库侧写 expires_at。
   *
   * **不拿本地开关状态做闸门** —— 任一方开启即对整个会话生效,不需要对方也开。
   * 曾经的 bug:这里用 `disappearSeconds === null` 早退,而 channels 表没有实时
   * 订阅,对方客户端根本不知道开关已被打开 → 没人调用本 RPC → 消息永远不烧,
   * 表现为「要双方都开才生效」。校验全部在数据库侧完成(会话成员 + 非本人 +
   * 频道开着计时 + 消息在生效起点之后),没开计时的会话里它就是空转一次;
   * 但只要有人开了,阅读这边一定能触发。
   */
  useEffect(() => {
    if (loading || !user) return

    const client = getSupabaseClient()
    if (!client) return

    const pending = messages
      .filter(
        (m) =>
          m.sender_id !== user.id &&
          !m.is_deleted &&
          m.expires_at === null &&
          !seenRequestedRef.current.has(m.id)
      )
      .map((m) => m.id)

    if (pending.length === 0) return

    // 先记账再发请求:即便失败也不要每次渲染都重试,轰炸数据库。
    // 失败时撤销记账,等下一次消息变化再试。
    for (const id of pending) seenRequestedRef.current.add(id)

    client.rpc('mark_messages_seen', { p_message_ids: pending }).then(({ error }) => {
      if (error) {
        for (const id of pending) seenRequestedRef.current.delete(id)
        console.error('Failed to mark messages as seen:', describeSupabaseError(error))
      }
    })
  }, [messages, loading, user])

  /**
   * 阅后即焚 · 到点销毁。
   *
   * 本地先摘掉,界面立刻干净;再让数据库执行硬删除。
   * 本地这一步不能省 —— 等 RPC 往返回来会有肉眼可见的延迟。
   * 其他端的同步由上面那条 DELETE 订阅负责。
   */
  useEffect(() => {
    if (disappearSeconds === null && !hasScheduledExpiry) return

    const client = getSupabaseClient()
    if (!client) return

    let purging = false

    const timer = setInterval(() => {
      if (purging) return

      const now = Date.now()
      const hasExpired = messagesRef.current.some((m) => isExpired(m.expires_at, now))
      if (!hasExpired) return

      setMessages((prev) => prev.filter((m) => !isExpired(m.expires_at, now)))

      purging = true
      client.rpc('purge_expired_messages').then(({ error }) => {
        if (error) console.error('Failed to purge expired messages:', describeSupabaseError(error))
        purging = false
      })
    }, 1000)

    return () => clearInterval(timer)
  }, [disappearSeconds, hasScheduledExpiry])

  /**
   * 输入实时预览 · 订阅。
   *
   * **只要会话开着就订阅**,不受开关影响 ——
   * 这个功能的语义是「预发布」:发起方打开开关,接收方什么都不用做就能看到。
   * 开关只决定「我要不要广播自己打的字」,不决定「我能不能看到别人打的字」。
   *
   * 作用范围:草稿气泡常驻到「关掉当前对话页面」或「关掉预览开关」为止,
   * 失焦、切到别的标签页、长时间停顿都不会熄灭它(发送端有心跳保活,
   * 见 lib/live-preview.ts 的 DRAFT_HEARTBEAT_MS)。
   *
   * 唯一的例外是预览(未加入)的频道:还没加入就不该看到别人的草稿。
   */
  useEffect(() => {
    if (isPreview || !user) {
      setDrafts({})
      return
    }

    const client = getSupabaseClient()
    if (!client) return

    // 换会话时忘了清,上一个会话的 lastContentSentAt 会污染这一轮的乱序判定
    lastContentSentAtRef.current = {}

    // self: false —— 不接收自己的广播,否则自己打的字会以「草稿气泡」再出现一次
    const ch = client.channel(draftTopic(channel.id), {
      config: { broadcast: { self: false } },
    })

    ch.on('broadcast', { event: DRAFT_EVENT }, ({ payload }) => {
      const p = payload as DraftPayload
      if (!p?.userId || p.userId === user.id) return

      if (p.content) {
        // 有效内容:永远接受,并记下发送时刻供乱序判定
        lastContentSentAtRef.current[p.userId] = p.sentAt
        setDrafts((prev) => ({ ...prev, [p.userId]: { ...p, sentAt: Date.now() } }))
        return
      }

      // 空串 = 对方清空/发送。先看它是不是迟到的旧清空:
      // 是的话说明对方其实还在打字(有更新的内容),绝不能把活草稿抹掉。
      if (isStaleClear(p.sentAt, lastContentSentAtRef.current[p.userId])) return
      delete lastContentSentAtRef.current[p.userId]
      setDrafts((prev) => {
        if (!(p.userId in prev)) return prev
        const next = { ...prev }
        delete next[p.userId]
        return next
      })
    })

    ch.subscribe()
    draftChannelRef.current = ch

    draftBroadcasterRef.current = createDraftBroadcaster((content) => {
      ch.send({
        type: 'broadcast',
        event: DRAFT_EVENT,
        payload: {
          userId: user.id,
          displayName: user.display_name,
          avatarUrl: user.avatar_url,
          content,
          sentAt: Date.now(),
        } satisfies DraftPayload,
      })
    })

    // 打开会话时默认贴着底部,先置位避免首屏判断成「在翻历史」
    nearBottomRef.current = true

    // 关标签页/刷新页面时 React 的卸载清理不一定来得及(页面直接销毁),
    // 用 pagehide 补一刀:尽力把草稿撤掉,别让对方干等 TTL 兜底。
    const onPageHide = () => {
      try {
        draftBroadcasterRef.current?.flush('')
      } catch {
        /* 页面正在销毁,websocket 可能已断;发不出去就交给 TTL 兜底 */
      }
    }
    window.addEventListener('pagehide', onPageHide)

    return () => {
      // 退出会话前把草稿撤掉,免得对方那边挂着一条要等 TTL 兜底才消失的气泡
      draftBroadcasterRef.current?.flush('')
      draftBroadcasterRef.current?.dispose()
      draftBroadcasterRef.current = null
      window.removeEventListener('pagehide', onPageHide)
      ch.unsubscribe()
      draftChannelRef.current = null
      setDrafts({})
    }
  }, [channel.id, isPreview, user])

  /**
   * 输入实时预览 · 崩溃/断网兜底。
   *
   * 正常路径下心跳每 3 秒续一次命,预览常驻,永远碰不到这里。
   * 只有两种异常会走到 TTL:对方浏览器崩溃、网络长时间断开 ——
   * 心跳确实拍不过来了,不能让我这边永远挂着一条幽灵草稿。
   */
  useEffect(() => {
    const timer = setInterval(() => {
      // pruneDrafts 在无过期项时原样返回,setState 不会触发重渲染
      setDrafts((prev) => pruneDrafts(prev, Date.now()))
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  /**
   * 输入实时预览 · 自动滚动。
   *
   * 草稿气泡是「会动的」内容 —— 对方每敲一下高度就会变。不跟着滚的话,
   * 预览就藏在列表下方,用户得手动往下拉才看得到(这正是之前的 bug)。
   *
   * 两个细节:
   *  · 只在用户本来就贴着底部时才跟。否则会把正在翻历史的用户硬拽回底部。
   *  · 用瞬时跳转而不是平滑滚动。草稿最快每 180ms 更新一次,
   *    平滑动画会被反复打断,看起来一顿一顿的。
   */
  const draftSignature = JSON.stringify(drafts)

  useEffect(() => {
    if (draftSignature === '{}') return
    if (!nearBottomRef.current) return
    const container = scrollContainerRef.current
    if (!container) return
    container.scrollTop = container.scrollHeight
  }, [draftSignature])

  /**
   * 输入框内容变化 → 按会话开关决定是否广播。
   * 订阅与广播共用同一条 realtime 通道,所以这里只做「要不要发」的判断。
   */
  const handleDraftChange = useCallback(
    (content: string) => {
      if (!livePreviewEnabled) return
      draftBroadcasterRef.current?.push(content)
    },
    [livePreviewEnabled]
  )

  /** 关掉开关时立刻通知对方撤掉草稿气泡,不必等 6 秒 TTL 自然过期 */
  const handleToggleLivePreview = useCallback(() => {
    const next = !livePreviewEnabled
    if (!next) draftBroadcasterRef.current?.flush('')
    setLivePreviewEnabled(channel.id, next)
  }, [livePreviewEnabled, channel.id, setLivePreviewEnabled])

  /**
   * 一键清空会话(仅私聊)。
   *
   * 只写我自己那一行的 cleared_at —— 对方的消息一条不动。
   *
   * 走 RPC 而不是直接 UPDATE:channel_members 没有 UPDATE 策略,
   * 直接改会被 RLS 拒掉。函数是 SECURITY DEFINER,且只写 cleared_at 一个字段。
   */
  const handleClearConversation = useCallback(async () => {
    const client = getSupabaseClient()
    if (!client || !user) return

    setClearError(null)

    const { data, error } = await client.rpc('clear_channel_for_me', { p_channel_id: channel.id })

    if (error) {
      console.error('Failed to clear conversation:', describeSupabaseError(error))
      setClearError(
        isSchemaNotMigrated(error)
          ? t('This needs a database update. Open the timer menu and apply it with your access token.')
          : describeSupabaseError(error)
      )
      return
    }

    // 用数据库返回的时刻当新的截止点,而不是本地 Date.now():
    // 本地时钟和服务器有偏差,拿本地时间会出现「刚清空完,
    // 最新那条又冒出来」(本地快)或「清空没生效」(本地慢)。
    setClearedAt(parseClearedAt(data))
    setMessages([])
    setHasMore(false)
    seenRequestedRef.current.clear()
  }, [channel.id, user, t])

  async function handleSendMessage(content: string) {
    const client = getSupabaseClient()
    if (!client || !user) return

    await client.from('messages').insert({
      channel_id: channel.id,
      sender_id: user.id,
      content,
    })
  }

  async function handleJoinPreview() {
    const client = getSupabaseClient()
    if (!client || !user) return

    setJoiningChannel(true)
    try {
      await client.from('channel_members').insert({
        channel_id: channel.id,
        profile_id: user.id,
        role: 'member',
      })

      // Add to sidebar and switch to it
      addChannel(channel)
      setPreviewChannel(null)
      setCurrentChannelId(channel.id)
    } catch (err) {
      console.error('Failed to join channel:', err)
    }
    setJoiningChannel(false)
  }

  // Load active call for this channel
  useEffect(() => {
    const client = getSupabaseClient()
    if (!client || !workspace) return

    async function loadActiveCall() {
      const { data } = await client!
        .from('active_calls')
        .select('*')
        .eq('channel_id', channel.id)
        .is('ended_at', null)
        .order('started_at', { ascending: false })
        .limit(1)

      if (data && data.length > 0) {
        setChannelActiveCall(channel.id, data[0] as ActiveCall)
      } else {
        setChannelActiveCall(channel.id, null)
      }
    }

    loadActiveCall()

    // Subscribe to active_calls changes for this channel
    const callSub = client
      .channel(`calls:${channel.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'active_calls',
          filter: `channel_id=eq.${channel.id}`,
        },
        async (payload) => {
          if (payload.eventType === 'INSERT') {
            setChannelActiveCall(channel.id, payload.new as ActiveCall)
          } else if (payload.eventType === 'UPDATE') {
            const call = payload.new as ActiveCall
            if (call.ended_at) {
              setChannelActiveCall(channel.id, null)
            } else {
              setChannelActiveCall(channel.id, call)
            }
          } else if (payload.eventType === 'DELETE') {
            setChannelActiveCall(channel.id, null)
          }
        }
      )
      .subscribe()

    return () => {
      callSub.unsubscribe()
    }
  }, [channel.id, workspace])

  async function handleStartOrJoinCall() {
    const client = getSupabaseClient()
    if (!client || !user || !workspace || isInCall) return

    setStartingCall(true)

    // Pre-flight: check if LiveKit is configured before creating any DB records
    if (!channelCall) {
      const { data: settings } = await client
        .from('workspace_settings')
        .select('*')
        .eq('workspace_id', workspace.id)
        .single()

      if (!settings?.calls_enabled || !settings?.livekit_url || !settings?.livekit_api_key || !settings?.livekit_api_secret) {
        setCallSetupOpen(true)
        setStartingCall(false)
        return
      }
    }

    let createdNewCall = false
    let call = channelCall

    try {
      // First, check if LiveKit is configured by requesting a pre-flight check
      const { data: { session } } = await client.auth.getSession()
      if (!session) throw new Error('No session')

      // If no active call, create one
      if (!call) {
        const roomName = `${workspace.id}-${channel.id}-${Date.now()}`
        const { data: newCall, error } = await client
          .from('active_calls')
          .insert({
            channel_id: channel.id,
            workspace_id: workspace.id,
            type: 'huddle',
            livekit_room_name: roomName,
            started_by: user.id,
          })
          .select()
          .single()

        if (error) throw error
        call = newCall as ActiveCall
        createdNewCall = true
        setChannelActiveCall(channel.id, call)
      }

      // Add participant record
      await client
        .from('call_participants')
        .upsert({
          call_id: call.id,
          profile_id: user.id,
          joined_at: new Date().toISOString(),
          left_at: null,
          is_muted: false,
          is_camera_on: false,
          is_sharing_screen: false,
        })

      // Request LiveKit token from API
      const response = await fetch('/api/livekit/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          roomName: call.livekit_room_name,
          workspaceId: workspace.id,
          identity: user.id,
          displayName: user.display_name,
        }),
      })

      if (!response.ok) {
        const errData = await response.json()
        throw new Error(errData.error || 'Failed to get call token')
      }

      const { token, url } = await response.json()
      joinCall(call, token, url)
    } catch (err) {
      console.error('Failed to start/join call:', err)

      // Cleanup: if we created a new call but token failed, end the call
      if (createdNewCall && call) {
        try {
          await client
            .from('active_calls')
            .update({ ended_at: new Date().toISOString() })
            .eq('id', call.id)
        } catch { /* ignore cleanup errors */ }
        setChannelActiveCall(channel.id, null)
      } else if (call) {
        // Just remove our participant
        try {
          await client
            .from('call_participants')
            .update({ left_at: new Date().toISOString() })
            .eq('call_id', call.id)
            .eq('profile_id', user.id)
        } catch { /* ignore cleanup errors */ }
      }

      alert(err instanceof Error ? err.message : t('Failed to start call'))
    }
    setStartingCall(false)
  }

  return (
    <div className="flex-1 flex h-full">
      {/* Main channel area */}
      <div className="flex-1 flex flex-col h-full min-w-0" style={{ background: '#ffffff' }}>
        {/* Channel header */}
        <div className="px-5 pb-3 flex items-center justify-between shrink-0 pt-[calc(0.75rem+env(safe-area-inset-top))]" style={{ background: '#ffffff', borderBottom: '1px solid #E5E1EE' }}>
          <div className="flex items-center gap-2.5">
            {!isDesktop && (
              <button
                onClick={toggleSidebar}
                className="h-8 w-8 rounded-lg flex items-center justify-center hover:bg-[#F5F2FF] transition-colors mr-1"
              >
                <Menu className="h-5 w-5" style={{ color: '#8E8EA0' }} />
              </button>
            )}
            {isGroupDm ? (
              <>
                <div className="relative h-7 w-7 shrink-0">
                  {dmInfo?.memberProfiles?.[0]?.avatar_url ? (
                    <img src={dmInfo.memberProfiles[0].avatar_url} alt="" className="absolute top-0 left-0 h-[18px] w-[18px] rounded-md object-cover border-2 border-white" />
                  ) : (
                    <div className="absolute top-0 left-0 h-[18px] w-[18px] rounded-md flex items-center justify-center text-[8px] font-bold text-white border-2 border-white" style={{ background: '#7C5CFC' }}>
                      {dmInfo?.memberProfiles?.[0]?.display_name?.[0]?.toUpperCase() || '?'}
                    </div>
                  )}
                  {dmInfo?.memberProfiles?.[1]?.avatar_url ? (
                    <img src={dmInfo.memberProfiles[1].avatar_url} alt="" className="absolute bottom-0 right-0 h-[18px] w-[18px] rounded-md object-cover border-2 border-white" />
                  ) : (
                    <div className="absolute bottom-0 right-0 h-[18px] w-[18px] rounded-md flex items-center justify-center text-[8px] font-bold text-white border-2 border-white" style={{ background: '#9B7DFF' }}>
                      {dmInfo?.memberProfiles?.[1]?.display_name?.[0]?.toUpperCase() || '+'}
                    </div>
                  )}
                </div>
                <h2 className="font-bold text-[17px] truncate max-w-md" style={{ color: '#2D2B3D' }}>
                  {displayChannelName}
                </h2>
                <span className="text-xs shrink-0 px-1.5 py-0.5 rounded-full font-medium" style={{ background: '#EDE5FF', color: '#7C5CFC' }}>
                  {(dmInfo?.memberProfiles?.length || 0) + 1}
                </span>
              </>
            ) : isDm ? (
              <>
                {dmInfo?.otherUser?.avatar_url ? (
                  <img
                    src={dmInfo.otherUser.avatar_url}
                    alt={displayChannelName}
                    className="h-7 w-7 rounded-lg object-cover"
                  />
                ) : (
                  <div className="h-7 w-7 rounded-lg flex items-center justify-center text-xs font-bold text-white" style={{ background: '#7C5CFC' }}>
                    {dmInfo?.otherUser?.display_name?.[0]?.toUpperCase() || '?'}
                  </div>
                )}
                <button
                  onClick={() => dmInfo?.otherUser?.id && openProfile(dmInfo.otherUser.id)}
                  className="font-bold text-[17px] hover:underline cursor-pointer"
                  style={{ color: '#2D2B3D' }}
                >
                  {displayChannelName}
                </button>
              </>
            ) : (
              <>
                <div className="h-7 w-7 rounded-lg flex items-center justify-center" style={{ background: '#EDE5FF' }}>
                  {channel.is_private ? (
                    <Lock className="h-4 w-4" style={{ color: '#7C5CFC' }} />
                  ) : (
                    <Hash className="h-4 w-4" style={{ color: '#7C5CFC' }} />
                  )}
                </div>
                <h2 className="font-bold text-[17px]" style={{ color: '#2D2B3D' }}>{channel.name}</h2>
                {channel.description && (
                  <>
                    <span style={{ color: '#E5E1EE' }}>|</span>
                    <span className="text-sm truncate max-w-md" style={{ color: '#8E8EA0' }}>
                      {channel.description}
                    </span>
                  </>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-1">
            {/* 输入实时预览(按会话独立)。放在头部而不是全局用户菜单里 ——
                用户是「和这个人聊的时候要不要开」,属于会话级选择。 */}
            {!isPreview && (
              <LivePreviewToggle enabled={livePreviewEnabled} onToggle={handleToggleLivePreview} />
            )}
            {/* 阅后即焚计时器。放在头部而不是「频道设置」里,
                是为了让私聊也能用 —— 私聊没有频道设置对话框。 */}
            {!isPreview && <DisappearTimerMenu channel={channel} />}
            {/* 一键清空会话。只对私聊开放:频道是公共空间,
                「只清我这边」在频道里意义不大,反而容易让人误以为
                把别人的记录也一起清了。 */}
            {!isPreview && isDirectMessage && (
              <ClearConversationButton displayName={displayChannelName} onClear={handleClearConversation} />
            )}
            {/* Call button */}
            {!isPreview && (
              <>
                {channelCall ? (
                  <button
                    onClick={handleStartOrJoinCall}
                    disabled={startingCall || isInCall}
                    className="h-8 px-3 rounded-lg flex items-center justify-center gap-1.5 transition-colors text-[12px] font-semibold"
                    style={{ background: '#DCFCE7', color: '#16A34A' }}
                    title={t('Join active call')}
                  >
                    {startingCall ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <>
                        <Phone className="h-3.5 w-3.5" />
                        <span className="h-2 w-2 rounded-full animate-pulse" style={{ background: '#16A34A' }} />
                        {t('Join')}
                      </>
                    )}
                  </button>
                ) : (
                  <button
                    onClick={handleStartOrJoinCall}
                    disabled={startingCall || isInCall}
                    className="h-8 w-8 rounded-lg flex items-center justify-center hover:bg-[#F5F2FF] transition-colors"
                    title={t('Start a call')}
                  >
                    {startingCall ? (
                      <Loader2 className="h-4 w-4 animate-spin" style={{ color: '#7C5CFC' }} />
                    ) : (
                      <Phone className="h-4 w-4" style={{ color: '#8E8EA0' }} />
                    )}
                  </button>
                )}
              </>
            )}
            {!isDirectMessage && (
              <button
                onClick={() => setChannelSettingsOpen(true)}
                className="h-8 w-8 rounded-lg flex items-center justify-center hover:bg-[#F5F2FF] transition-colors"
                title={t('Channel settings & members')}
              >
                <Users className="h-4 w-4" style={{ color: '#8E8EA0' }} />
              </button>
            )}
          </div>
        </div>

        {/* 输入实时预览状态条。开启后自己打的每个字都会实时出现在对方那里,
            不摆一条提示很容易忘记自己开着,把没想好的话也漏出去。 */}
        {!isPreview && livePreviewEnabled && (
          <div
            className="px-5 py-1.5 flex items-center gap-1.5 shrink-0 text-[11px]"
            style={{ background: '#F5F2FF', borderBottom: '1px solid #E5E1EE', color: '#7C5CFC' }}
          >
            <Eye className="h-3 w-3 shrink-0" />
            <span>{t('Live typing preview is on — what you type is visible before you send it.')}</span>
          </div>
        )}

        {/* 清空会话失败。清空是用户主动点出来的动作,失败必须说出来 ——
            点完没反应会让人以为已经清空了,反而更糟。 */}
        {!isPreview && clearError !== null && (
          <div
            className="px-5 py-1.5 flex items-center gap-1.5 shrink-0 text-[11px]"
            style={{ background: '#FEF2F2', borderBottom: '1px solid #FECACA', color: '#B91C1C' }}
          >
            <AlertCircle className="h-3 w-3 shrink-0" />
            <span className="truncate">{t('Failed to clear conversation')}: {clearError}</span>
            <button
              onClick={() => setClearError(null)}
              className="ml-auto shrink-0 h-4 w-4 rounded flex items-center justify-center hover:bg-[#FEE2E2]"
              title={t('Dismiss')}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}

        {/* 阅后即焚状态条。计时器是个「隐形」开关,不摆一条提示很容易忘记自己开着,
            等消息真的消失了才反应过来。 */}
        {!isPreview && disappearSeconds !== null && (
          <div
            className="px-5 py-1.5 flex items-center gap-1.5 shrink-0 text-[11px]"
            style={{ background: '#F5F2FF', borderBottom: '1px solid #E5E1EE', color: '#7C5CFC' }}
          >
            <Clock className="h-3 w-3 shrink-0" />
            <span>
              {t('Disappearing messages are on. New messages disappear {value} after being read.', {
                value: formatDuration(disappearSeconds, t),
              })}
            </span>
          </div>
        )}

        {/* Messages
            必须显式写 overflow-x-hidden:只设 overflow-y-auto 时,
            CSS 会把 overflow-x 的 visible 计算成 auto,悬停工具栏一旦探出
            容器右缘就会顶出一条横向滚动条。 */}
        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto overflow-x-hidden px-5">
          <div className="py-4 space-y-2">
            {loadingMore && (
              <div className="flex items-center justify-center py-3">
                <Loader2 className="h-4 w-4 animate-spin mr-2" style={{ color: '#7C5CFC' }} />
                <span className="text-xs" style={{ color: '#8E8EA0' }}>{t('Loading older messages...')}</span>
              </div>
            )}

            {!hasMore && messages.length > 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                {isDirectMessage ? (
                  <>
                    {isGroupDm ? (
                      <div className="relative h-14 w-14 mb-3">
                        {dmInfo?.memberProfiles?.[0]?.avatar_url ? (
                          <img src={dmInfo.memberProfiles[0].avatar_url} alt="" className="absolute top-0 left-0 h-9 w-9 rounded-xl object-cover border-2 border-white" />
                        ) : (
                          <div className="absolute top-0 left-0 h-9 w-9 rounded-xl flex items-center justify-center text-sm font-bold text-white border-2 border-white" style={{ background: '#7C5CFC' }}>
                            {dmInfo?.memberProfiles?.[0]?.display_name?.[0]?.toUpperCase() || '?'}
                          </div>
                        )}
                        {dmInfo?.memberProfiles?.[1]?.avatar_url ? (
                          <img src={dmInfo.memberProfiles[1].avatar_url} alt="" className="absolute bottom-0 right-0 h-9 w-9 rounded-xl object-cover border-2 border-white" />
                        ) : (
                          <div className="absolute bottom-0 right-0 h-9 w-9 rounded-xl flex items-center justify-center text-sm font-bold text-white border-2 border-white" style={{ background: '#9B7DFF' }}>
                            {dmInfo?.memberProfiles?.[1]?.display_name?.[0]?.toUpperCase() || '+'}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="h-14 w-14 rounded-2xl flex items-center justify-center text-xl font-bold text-white mb-3" style={{ background: '#7C5CFC' }}>
                        {dmInfo?.otherUser?.avatar_url ? (
                          <img src={dmInfo.otherUser.avatar_url} alt="" className="h-14 w-14 rounded-2xl object-cover" />
                        ) : (
                          dmInfo?.otherUser?.display_name?.[0]?.toUpperCase() || '?'
                        )}
                      </div>
                    )}
                    <h3 className="text-base font-bold" style={{ color: '#2D2B3D' }}>{displayChannelName}</h3>
                    <p className="text-sm" style={{ color: '#8E8EA0' }}>
                      {t('This is the beginning of your conversation.')}
                    </p>
                  </>
                ) : (
                  <>
                    <div className="h-14 w-14 rounded-2xl flex items-center justify-center mb-3" style={{ background: '#EDE5FF' }}>
                      <Hash className="h-7 w-7" style={{ color: '#7C5CFC' }} />
                    </div>
                    <h3 className="text-base font-bold" style={{ color: '#2D2B3D' }}>{t('Welcome to #{name}!', { name: channel.name })}</h3>
                    <p className="text-sm" style={{ color: '#8E8EA0' }}>
                      {t('This is the start of the #{name} channel.', { name: channel.name })}
                    </p>
                  </>
                )}
              </div>
            )}

            {loading ? (
              <div className="flex items-center justify-center py-12" style={{ color: '#8E8EA0' }}>
                <Loader2 className="h-5 w-5 animate-spin mr-2" style={{ color: '#7C5CFC' }} />
                {t('Loading messages...')}
              </div>
            ) : messages.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 text-center">
                {isDirectMessage ? (
                  <>
                    {isGroupDm ? (
                      <div className="relative h-16 w-16 mb-4">
                        {dmInfo?.memberProfiles?.[0]?.avatar_url ? (
                          <img src={dmInfo.memberProfiles[0].avatar_url} alt="" className="absolute top-0 left-0 h-10 w-10 rounded-xl object-cover border-2 border-white" />
                        ) : (
                          <div className="absolute top-0 left-0 h-10 w-10 rounded-xl flex items-center justify-center text-lg font-bold text-white border-2 border-white" style={{ background: '#7C5CFC' }}>
                            {dmInfo?.memberProfiles?.[0]?.display_name?.[0]?.toUpperCase() || '?'}
                          </div>
                        )}
                        {dmInfo?.memberProfiles?.[1]?.avatar_url ? (
                          <img src={dmInfo.memberProfiles[1].avatar_url} alt="" className="absolute bottom-0 right-0 h-10 w-10 rounded-xl object-cover border-2 border-white" />
                        ) : (
                          <div className="absolute bottom-0 right-0 h-10 w-10 rounded-xl flex items-center justify-center text-lg font-bold text-white border-2 border-white" style={{ background: '#9B7DFF' }}>
                            {dmInfo?.memberProfiles?.[1]?.display_name?.[0]?.toUpperCase() || '+'}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="h-16 w-16 rounded-2xl flex items-center justify-center text-2xl font-bold text-white mb-4" style={{ background: '#7C5CFC' }}>
                        {dmInfo?.otherUser?.avatar_url ? (
                          <img src={dmInfo.otherUser.avatar_url} alt="" className="h-16 w-16 rounded-2xl object-cover" />
                        ) : (
                          dmInfo?.otherUser?.display_name?.[0]?.toUpperCase() || '?'
                        )}
                      </div>
                    )}
                    <h3 className="text-lg font-bold" style={{ color: '#2D2B3D' }}>{displayChannelName}</h3>
                    <p style={{ color: '#8E8EA0' }}>
                      {isGroupDm
                        ? t('This is the start of your group conversation.')
                        : t('This is the start of your conversation with {name}.', { name: displayChannelName })
                      }
                    </p>
                  </>
                ) : (
                  <>
                    <div className="h-16 w-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: '#EDE5FF' }}>
                      <Hash className="h-8 w-8" style={{ color: '#7C5CFC' }} />
                    </div>
                    <h3 className="text-lg font-bold" style={{ color: '#2D2B3D' }}>{t('Welcome to #{name}!', { name: channel.name })}</h3>
                    <p style={{ color: '#8E8EA0' }}>
                      {t('This is the start of the #{name} channel.', { name: channel.name })}
                      {channel.description && ` ${channel.description}`}
                    </p>
                  </>
                )}
                {/* 清空过的话说明一句 —— 否则「明明聊过的会话却一片空白」
                    会让人以为消息被删掉了(其实对方那边一条没少)。 */}
                {clearedAt !== null && (
                  <p className="mt-3 text-[12px]" style={{ color: '#8E8EA0' }}>
                    {t('Earlier messages are hidden from your view.')}
                  </p>
                )}
              </div>
            ) : (
              messages.map((message, i) => {
                const prevMessage = i > 0 ? messages[i - 1] : null
                const showHeader =
                  !prevMessage ||
                  prevMessage.sender_id !== message.sender_id ||
                  new Date(message.created_at).getTime() -
                    new Date(prevMessage.created_at).getTime() >
                    5 * 60 * 1000

                return (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    showHeader={showHeader}
                    isOwn={message.sender_id === user?.id}
                    layout="bubble"
                    disappearSeconds={disappearSeconds}
                  />
                )
              })
            )}

            {/* 输入实时预览:对方正在打、还没发出去的内容。
                走内存广播、不落库,对方停手 6 秒后气泡自动消失。 */}
            {Object.values(drafts).map((d) => (
              <DraftBubble key={d.userId} draft={d} />
            ))}

            <div ref={bottomRef} />
          </div>
        </div>

        {/* Active call banner */}
        {!isPreview && channelCall && !isInCall && (
          <div className="px-5 py-2 shrink-0" style={{ borderTop: '1px solid #E5E1EE' }}>
            <div className="flex items-center gap-3 px-4 py-2.5 rounded-xl" style={{ background: '#DCFCE7' }}>
              <div className="h-2.5 w-2.5 rounded-full animate-pulse shrink-0" style={{ background: '#16A34A' }} />
              <span className="text-[13px] font-medium flex-1" style={{ color: '#166534' }}>
                {isDirectMessage ? t('{name} is in a call', { name: displayChannelName }) : t('A call is in progress in this channel')}
              </span>
              <button
                onClick={handleStartOrJoinCall}
                disabled={startingCall}
                className="px-4 py-1.5 rounded-lg text-[12px] font-semibold text-white transition-all hover:opacity-90 flex items-center gap-1.5"
                style={{ background: '#16A34A' }}
              >
                {startingCall ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Phone className="h-3 w-3" />
                )}
                {t('Join Call')}
              </button>
            </div>
          </div>
        )}

        {/* Message input or Join banner */}
        {isPreview ? (
          <div className="px-5 pt-4 shrink-0 pb-[calc(1rem+env(safe-area-inset-bottom))]" style={{ borderTop: '1px solid #E5E1EE' }}>
            <div className="flex items-center gap-4 p-4 rounded-xl" style={{ background: '#F5F2FF' }}>
              <div className="flex-1 min-w-0">
                <p className="text-[14px] font-semibold" style={{ color: '#2D2B3D' }}>
                  {t("You're previewing")} <strong>#{channel.name}</strong>
                </p>
                <p className="text-[13px]" style={{ color: '#8E8EA0' }}>
                  {t('Join this channel to start sending messages')}
                </p>
              </div>
              <button
                onClick={handleJoinPreview}
                disabled={joiningChannel}
                className="px-6 py-2.5 rounded-xl text-[14px] font-semibold text-white transition-all hover:opacity-90 flex items-center gap-2 shrink-0"
                style={{ background: '#7C5CFC' }}
              >
                {joiningChannel ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <LogIn className="h-4 w-4" />
                )}
                {t('Join Channel')}
              </button>
            </div>
          </div>
        ) : (
          <MessageInput
            channelId={channel.id}
            channelName={displayChannelName}
            onSend={handleSendMessage}
            // 始终传入:是否真的广播由 handleDraftChange 按会话开关判断
            onDraftChange={handleDraftChange}
            placeholder={isDirectMessage ? t('Message {name}', { name: displayChannelName }) : undefined}
          />
        )}
      </div>

      {/* Thread panel */}
      {!isPreview && threadParentMessage && <ThreadPanel />}

      {/* User profile panel */}
      {!isPreview && profileUserId && <UserProfilePanel />}

      {/* Channel settings dialog */}
      {!isPreview && !isDirectMessage && (
        <ChannelSettingsDialog
          open={channelSettingsOpen}
          onOpenChange={setChannelSettingsOpen}
          channel={channel}
        />
      )}

      {/* Call setup dialog (shown when LiveKit is not configured) */}
      <CallSetupDialog
        open={callSetupOpen}
        onOpenChange={setCallSetupOpen}
      />
    </div>
  )
}
