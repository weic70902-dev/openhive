'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { X, Loader2, ArrowLeft } from 'lucide-react'
import { getSupabaseClient } from '@/lib/supabase/client'
import { useAppStore } from '@/lib/store/app-store'
import { MessageBubble } from './message-bubble'
import { MessageInput } from './message-input'
import type { Message } from '@/types/database'
import { useT } from '@/lib/i18n'

export function ThreadPanel() {
  const { threadParentMessage, closeThread, user, channels, dmChannels } = useAppStore()
  const [replies, setReplies] = useState<Message[]>([])
  const [loading, setLoading] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const repliesRef = useRef<Message[]>([])
  const t = useT()

  // 话题里也要显示阅后即焚标记,而话题面板本身不知道所属会话的设置,
  // 所以按 channel_id 回查一次(频道和私聊各查一遍)。
  const parentChannelId = threadParentMessage?.channel_id
  const parentChannel =
    channels.find((c) => c.id === parentChannelId) ||
    dmChannels.find((c) => c.id === parentChannelId)
  const disappearSeconds = parentChannel?.disappear_seconds ?? null

  useEffect(() => {
    repliesRef.current = replies
  }, [replies])

  const scrollToBottom = useCallback(() => {
    setTimeout(() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' }), 50)
  }, [])

  useEffect(() => {
    if (!threadParentMessage) return

    const client = getSupabaseClient()
    if (!client) return

    async function loadReplies() {
      setLoading(true)
      const { data } = await client!
        .from('messages')
        .select('*, sender:profiles(*)')
        .eq('parent_id', threadParentMessage!.id)
        .order('created_at', { ascending: true })

      if (data) {
        setReplies(data as Message[])
        scrollToBottom()
      }
      setLoading(false)
    }

    loadReplies()

    const sub = client
      .channel(`thread:${threadParentMessage.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `parent_id=eq.${threadParentMessage.id}`,
        },
        async (payload) => {
          const { data } = await client
            .from('messages')
            .select('*, sender:profiles(*)')
            .eq('id', payload.new.id)
            .single()

          if (data && !repliesRef.current.find((m) => m.id === data.id)) {
            setReplies((prev) => [...prev, data as Message])
            scrollToBottom()
          }
        }
      )
      .subscribe()

    return () => {
      sub.unsubscribe()
    }
  }, [threadParentMessage, scrollToBottom])

  if (!threadParentMessage) return null

  async function handleSendReply(content: string) {
    const client = getSupabaseClient()
    if (!client || !user || !threadParentMessage) return

    await client.from('messages').insert({
      channel_id: threadParentMessage.channel_id,
      sender_id: user.id,
      content,
      parent_id: threadParentMessage.id,
    })
  }

  // 移动端:整屏浮层(z-30,低于侧边栏抽屉的 z-50);桌面端:右侧固定宽度面板。
  return (
    <div className="fixed inset-0 z-30 flex flex-col h-full bg-white md:static md:z-auto md:w-96 md:shrink-0 md:border-l md:border-[#E5E1EE] pt-[env(safe-area-inset-top)]">
      {/* Header */}
      <div className="px-4 md:px-5 py-3 flex items-center gap-1.5 shrink-0 border-b border-[#E5E1EE]">
        <button
          className="md:hidden h-8 w-8 -ml-1.5 rounded-lg flex items-center justify-center hover:bg-[#F5F2FF] transition-colors"
          onClick={closeThread}
          aria-label={t('Back')}
        >
          <ArrowLeft className="h-5 w-5" style={{ color: '#2D2B3D' }} />
        </button>
        <h3 className="font-bold text-[17px] flex-1" style={{ color: '#2D2B3D' }}>{t('Thread')}</h3>
        <button
          className="hidden md:flex h-8 w-8 rounded-lg items-center justify-center hover:bg-[#F5F2FF] transition-colors"
          onClick={closeThread}
        >
          <X className="h-4 w-4" style={{ color: '#8E8EA0' }} />
        </button>
      </div>

      {/* Parent message */}
      <div className="px-4 pt-3 pb-2" style={{ borderBottom: '1px solid #E5E1EE' }}>
        <MessageBubble message={threadParentMessage} showHeader isOwn={threadParentMessage.sender_id === user?.id} isThread disappearSeconds={disappearSeconds} />
      </div>

      {/* Reply count */}
      <div className="px-5 py-2 text-xs font-medium" style={{ color: '#8E8EA0', borderBottom: '1px solid #E5E1EE' }}>
        {replies.length} {t(replies.length === 1 ? 'reply' : 'replies')}
      </div>

      {/* Replies */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-4">
        <div className="py-2 space-y-1">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin" style={{ color: '#7C5CFC' }} />
            </div>
          ) : (
            replies.map((reply, i) => {
              const prev = i > 0 ? replies[i - 1] : null
              const showHeader =
                !prev ||
                prev.sender_id !== reply.sender_id ||
                new Date(reply.created_at).getTime() - new Date(prev.created_at).getTime() >
                  5 * 60 * 1000

              return (
                <MessageBubble
                  key={reply.id}
                  message={reply}
                  showHeader={showHeader}
                  isOwn={reply.sender_id === user?.id}
                  isThread
                  disappearSeconds={disappearSeconds}
                />
              )
            })
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Reply input */}
      <MessageInput channelId={threadParentMessage?.channel_id} channelName="thread" onSend={handleSendReply} placeholder={t('Reply...')} />
    </div>
  )
}
