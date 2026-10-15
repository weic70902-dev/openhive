import { create } from 'zustand'
import type { Profile, Workspace, Channel, Message, Reaction, WorkspaceMember, ActiveCall } from '@/types/database'

export interface ActivityItem {
  id: string
  type: 'mention' | 'dm' | 'reaction' | 'thread_reply'
  message: Message
  channelId: string
  channelName: string
  timestamp: string
  read: boolean
}

interface AppState {
  // Auth
  user: Profile | null
  workspace: Workspace | null
  workspaceRole: 'owner' | 'admin' | 'member' | null
  channels: Channel[]
  dmChannels: (Channel & { otherUser?: Profile; memberProfiles?: Profile[] })[]
  currentChannelId: string | null

  // Preview channel (public channel user hasn't joined yet)
  previewChannel: Channel | null

  // Thread
  threadParentMessage: Message | null

  // User profile panel
  profileUserId: string | null

  // Activity panel
  activityOpen: boolean
  activities: ActivityItem[]
  unreadActivityCount: number

  // Hidden DM channel IDs (conversations user closed)
  hiddenDmIds: string[]

  // Unread message counts per channel
  unreadCounts: Record<string, number>

  // Muted channel IDs
  mutedChannelIds: string[]

  // Reactions cache: messageId -> Reaction[]
  reactions: Record<string, Reaction[]>

  // Calls
  activeCall: ActiveCall | null
  isInCall: boolean
  callToken: string | null
  callUrl: string | null
  channelActiveCalls: Record<string, ActiveCall> // channelId -> ActiveCall

  // Saved items (bookmarks)
  savedItemIds: Set<string> // set of message IDs that are saved

  // Mobile / sidebar
  sidebarOpen: boolean

  // Actions
  setUser: (user: Profile | null) => void
  setWorkspace: (workspace: Workspace | null) => void
  setWorkspaceRole: (role: 'owner' | 'admin' | 'member' | null) => void
  setPreviewChannel: (channel: Channel | null) => void
  setChannels: (channels: Channel[]) => void
  setDmChannels: (channels: (Channel & { otherUser?: Profile; memberProfiles?: Profile[] })[]) => void
  addChannel: (channel: Channel) => void
  removeChannel: (channelId: string) => void
  updateChannel: (channelId: string, updates: Partial<Channel>) => void
  addDmChannel: (channel: Channel & { otherUser?: Profile; memberProfiles?: Profile[] }) => void
  setCurrentChannelId: (id: string | null) => void
  openThread: (message: Message) => void
  closeThread: () => void
  openProfile: (userId: string) => void
  closeProfile: () => void
  toggleActivity: () => void
  closeActivity: () => void
  addActivity: (item: ActivityItem) => void
  markActivityRead: (id: string) => void
  markAllActivitiesRead: () => void
  hideDm: (channelId: string) => void
  unhideDm: (channelId: string) => void
  incrementUnread: (channelId: string) => void
  clearUnread: (channelId: string) => void
  muteChannel: (channelId: string) => void
  unmuteChannel: (channelId: string) => void
  setReactions: (messageId: string, reactions: Reaction[]) => void
  addReaction: (messageId: string, reaction: Reaction) => void
  removeReaction: (messageId: string, reactionId: string) => void
  joinCall: (call: ActiveCall, token: string, url: string) => void
  leaveCall: () => void
  setChannelActiveCall: (channelId: string, call: ActiveCall | null) => void
  setSavedItemIds: (ids: Set<string>) => void
  toggleSavedItem: (messageId: string) => void
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
  /**
   * 输入实时预览:已开启的**会话 id 集合**。
   *
   * 语义是「预发布」——开启后,我打字的内容会实时广播给这个会话里的其他人,
   * 对方**不需要**开启任何开关就能看到。所以这只是「我要不要广播」的个人选择,
   * 与频道设置无关,不进数据库,按会话独立记录在本机。
   */
  livePreviewChannelIds: string[]
  setLivePreviewEnabled: (channelId: string, enabled: boolean) => void
  hydrateLivePreview: () => void
  signOut: () => void
}

/** 输入实时预览开关在 localStorage 里的键(值是会话 id 的 JSON 数组) */
export const LIVE_PREVIEW_STORAGE_KEY = 'openhive:live-preview-channels'

/** 早期版本用的是全局开关(单个 '1' / '0'),已废弃 —— 读取时顺手清掉 */
const LEGACY_LIVE_PREVIEW_KEY = 'openhive:live-preview'

export const useAppStore = create<AppState>((set) => ({
  user: null,
  workspace: null,
  workspaceRole: null,
  channels: [],
  dmChannels: [],
  currentChannelId: null,
  previewChannel: null,
  threadParentMessage: null,
  profileUserId: null,
  activityOpen: false,
  activities: [],
  unreadActivityCount: 0,
  hiddenDmIds: [],
  unreadCounts: {},
  mutedChannelIds: [],
  reactions: {},
  activeCall: null,
  isInCall: false,
  callToken: null,
  callUrl: null,
  channelActiveCalls: {},
  savedItemIds: new Set(),
  sidebarOpen: false,
  livePreviewChannelIds: [],

  setUser: (user) => set({ user }),
  setWorkspace: (workspace) => set({ workspace }),
  setWorkspaceRole: (workspaceRole) => set({ workspaceRole }),
  setPreviewChannel: (previewChannel) => set({ previewChannel, threadParentMessage: null, profileUserId: null }),
  setChannels: (channels) => set({ channels }),
  setDmChannels: (dmChannels) => set({ dmChannels }),
  addChannel: (channel) =>
    set((state) => ({
      channels: [...state.channels, channel].sort((a, b) => a.name.localeCompare(b.name)),
    })),
  removeChannel: (channelId) =>
    set((state) => ({
      channels: state.channels.filter((c) => c.id !== channelId),
      currentChannelId: state.currentChannelId === channelId ? null : state.currentChannelId,
    })),
  updateChannel: (channelId, updates) =>
    set((state) => ({
      channels: state.channels.map((c) =>
        c.id === channelId ? { ...c, ...updates } : c
      ).sort((a, b) => a.name.localeCompare(b.name)),
      // 私聊没有「频道设置」对话框,阅后即焚这类开关直接改在会话头部,
      // 所以这里必须同时覆盖 dmChannels —— 否则私聊里改了本地不生效。
      dmChannels: state.dmChannels.map((c) =>
        c.id === channelId ? { ...c, ...updates } : c
      ),
    })),
  addDmChannel: (channel) =>
    set((state) => ({
      dmChannels: [...state.dmChannels.filter((c) => c.id !== channel.id), channel],
      // Auto-unhide if a new message caused this DM to appear
      hiddenDmIds: state.hiddenDmIds.filter((id) => id !== channel.id),
    })),
  setCurrentChannelId: (currentChannelId) => set((state) => {
    // Mark activities for this channel as read
    let readCount = 0
    const updatedActivities = state.activities.map((a) => {
      if (currentChannelId && a.channelId === currentChannelId && !a.read) {
        readCount++
        return { ...a, read: true }
      }
      return a
    })

    return {
      currentChannelId,
      previewChannel: null,
      threadParentMessage: null,
      profileUserId: null,
      unreadCounts: currentChannelId
        ? { ...state.unreadCounts, [currentChannelId]: 0 }
        : state.unreadCounts,
      activities: updatedActivities,
      unreadActivityCount: Math.max(0, state.unreadActivityCount - readCount),
    }
  }),
  openThread: (message) => set({ threadParentMessage: message, profileUserId: null }),
  closeThread: () => set({ threadParentMessage: null }),
  openProfile: (userId) => set({ profileUserId: userId, threadParentMessage: null }),
  closeProfile: () => set({ profileUserId: null }),
  toggleActivity: () => set((state) => ({
    activityOpen: !state.activityOpen,
    threadParentMessage: null,
    profileUserId: null,
  })),
  closeActivity: () => set({ activityOpen: false }),
  addActivity: (item) =>
    set((state) => ({
      activities: [item, ...state.activities].slice(0, 100), // keep max 100
      unreadActivityCount: state.activityOpen ? state.unreadActivityCount : state.unreadActivityCount + 1,
    })),
  markActivityRead: (id) => set((state) => {
    const found = state.activities.find((a) => a.id === id && !a.read)
    if (!found) return state
    return {
      activities: state.activities.map((a) => a.id === id ? { ...a, read: true } : a),
      unreadActivityCount: Math.max(0, state.unreadActivityCount - 1),
    }
  }),
  markAllActivitiesRead: () => set((state) => ({
    activities: state.activities.map((a) => ({ ...a, read: true })),
    unreadActivityCount: 0,
  })),
  hideDm: (channelId) =>
    set((state) => ({
      hiddenDmIds: [...state.hiddenDmIds, channelId],
      currentChannelId: state.currentChannelId === channelId ? null : state.currentChannelId,
    })),
  unhideDm: (channelId) =>
    set((state) => ({
      hiddenDmIds: state.hiddenDmIds.filter((id) => id !== channelId),
    })),
  incrementUnread: (channelId) =>
    set((state) => ({
      unreadCounts: {
        ...state.unreadCounts,
        [channelId]: (state.unreadCounts[channelId] || 0) + 1,
      },
    })),
  clearUnread: (channelId) =>
    set((state) => ({
      unreadCounts: { ...state.unreadCounts, [channelId]: 0 },
    })),
  muteChannel: (channelId) =>
    set((state) => ({
      mutedChannelIds: [...state.mutedChannelIds, channelId],
    })),
  unmuteChannel: (channelId) =>
    set((state) => ({
      mutedChannelIds: state.mutedChannelIds.filter((id) => id !== channelId),
    })),
  setReactions: (messageId, reactions) =>
    set((state) => ({
      reactions: { ...state.reactions, [messageId]: reactions },
    })),
  addReaction: (messageId, reaction) =>
    set((state) => ({
      reactions: {
        ...state.reactions,
        [messageId]: [...(state.reactions[messageId] || []), reaction],
      },
    })),
  removeReaction: (messageId, reactionId) =>
    set((state) => ({
      reactions: {
        ...state.reactions,
        [messageId]: (state.reactions[messageId] || []).filter((r) => r.id !== reactionId),
      },
    })),
  joinCall: (call, token, url) =>
    set({ activeCall: call, callToken: token, callUrl: url, isInCall: true }),
  leaveCall: () =>
    set({ activeCall: null, callToken: null, callUrl: null, isInCall: false }),
  setChannelActiveCall: (channelId, call) =>
    set((state) => {
      const updated = { ...state.channelActiveCalls }
      if (call) {
        updated[channelId] = call
      } else {
        delete updated[channelId]
      }
      return { channelActiveCalls: updated }
    }),
  setSavedItemIds: (savedItemIds) => set({ savedItemIds }),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  toggleSidebar: () => set(state => ({ sidebarOpen: !state.sidebarOpen })),
  setLivePreviewEnabled: (channelId, enabled) =>
    set((state) => {
      const next = enabled
        ? Array.from(new Set([...state.livePreviewChannelIds, channelId]))
        : state.livePreviewChannelIds.filter((id) => id !== channelId)

      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(LIVE_PREVIEW_STORAGE_KEY, JSON.stringify(next))
        } catch {
          // 隐私模式下 localStorage 可能不可写 —— 仅本次会话生效即可
        }
      }

      return { livePreviewChannelIds: next }
    }),
  // 客户端挂载后调用。默认值是空数组,所以服务端渲染与首次渲染都一致,不会 hydration 不匹配。
  hydrateLivePreview: () => {
    if (typeof window === 'undefined') return
    try {
      const raw = window.localStorage.getItem(LIVE_PREVIEW_STORAGE_KEY)
      const parsed: unknown = raw ? JSON.parse(raw) : []
      // 存进去的一定是字符串数组;外部改坏了就当空处理,不要让脏数据进 state
      const ids = Array.isArray(parsed)
        ? parsed.filter((v): v is string => typeof v === 'string' && v.length > 0)
        : []
      set({ livePreviewChannelIds: ids })
      // 旧版的全局开关已经没人读了,顺手删掉,免得留在用户的 localStorage 里
      window.localStorage.removeItem(LEGACY_LIVE_PREVIEW_KEY)
    } catch {
      // 读不到就保持默认(全关)
    }
  },
  toggleSavedItem: (messageId) => set(state => {
    const newSet = new Set(state.savedItemIds)
    if (newSet.has(messageId)) {
      newSet.delete(messageId)
    } else {
      newSet.add(messageId)
    }
    return { savedItemIds: newSet }
  }),
  signOut: () =>
    set({
      user: null,
      workspace: null,
      workspaceRole: null,
      channels: [],
      dmChannels: [],
      currentChannelId: null,
      previewChannel: null,
      threadParentMessage: null,
      profileUserId: null,
      activityOpen: false,
      activities: [],
      unreadActivityCount: 0,
      hiddenDmIds: [],
      unreadCounts: {},
      mutedChannelIds: [],
      reactions: {},
      activeCall: null,
      isInCall: false,
      callToken: null,
      callUrl: null,
      channelActiveCalls: {},
      savedItemIds: new Set(),
      sidebarOpen: false,
      // 注意:不清空 livePreviewChannelIds —— 它是本机偏好,退出登录后应保留
    }),
}))
