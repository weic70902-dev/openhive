'use client'

import { useAppStore } from '@/lib/store/app-store'
import { ChannelView } from '@/components/chat/channel-view'
import { UserProfilePanel } from '@/components/chat/user-profile-panel'
import { Hash } from 'lucide-react'
import { useT } from '@/lib/i18n'

export default function WorkspacePage() {
  const { channels, dmChannels, currentChannelId, previewChannel, profileUserId } = useAppStore()
  const t = useT()

  // Preview mode: viewing a channel the user hasn't joined yet
  if (previewChannel) {
    return <ChannelView channel={previewChannel} isPreview />
  }

  const currentChannel =
    channels.find((c) => c.id === currentChannelId) ||
    dmChannels.find((c) => c.id === currentChannelId)

  if (!currentChannel) {
    return (
      <div className="flex-1 flex h-full min-w-0">
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center space-y-2">
            <Hash className="mx-auto h-12 w-12 opacity-30" />
            <p>{t('Select a channel to start chatting')}</p>
          </div>
        </div>
        {/* 未选中频道时也要能查看个人资料(从侧边栏用户菜单进入) */}
        {profileUserId && <UserProfilePanel />}
      </div>
    )
  }

  return <ChannelView channel={currentChannel} />
}
