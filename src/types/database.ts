// Types for all 23 OpenHive database tables

export interface Profile {
  id: string
  email: string | null
  display_name: string
  avatar_url: string | null
  status_emoji: string | null
  status_text: string | null
  is_online: boolean
  last_seen_at: string | null
  created_at: string
}

export interface Workspace {
  id: string
  name: string
  slug: string
  icon_url: string | null
  created_at: string
}

export interface WorkspaceMember {
  workspace_id: string
  profile_id: string
  role: 'owner' | 'admin' | 'member'
  joined_at: string
  workspace?: Workspace
  profile?: Profile
}

export interface Channel {
  id: string
  workspace_id: string
  name: string
  description: string | null
  topic: string | null
  is_private: boolean
  is_archived: boolean
  created_by: string | null
  created_at: string
  /**
   * 阅后即焚时长(秒)。NULL = 关闭。
   * 计时不在发送时开始,而是等**对方阅读**后由 mark_messages_seen() 写入 expires_at。
   * 频道级共享设置:**任一方开启即对整个会话生效,不需要双方都开** ——
   * 触发与校验全在数据库侧,与对方客户端开着什么无关。
   */
  disappear_seconds: number | null
  /**
   * 计时生效起点。每次改动 disappear_seconds 都会重置为当前时刻,
   * 保证只有「开启之后发出的」消息才计入 —— 否则一开开关会烧掉全部历史消息。
   */
  disappear_since: string | null
}

export interface ChannelMember {
  channel_id: string
  profile_id: string
  role: string
  notification_pref: string
  joined_at: string
  /**
   * 「我」在这个会话里的视图截止点。NULL = 从未清空过。
   * 早于该时刻的消息只对我不可见 —— 对方的消息完整保留(清空不是删除)。
   * 由 clear_channel_for_me() 写入。
   */
  cleared_at: string | null
}

export interface Message {
  id: string
  channel_id: string
  sender_id: string | null
  content: string
  parent_id: string | null
  thread_reply_count: number
  is_edited: boolean
  /** 已撤回。撤回时会同时清空 content,避免内容残留。 */
  is_deleted: boolean
  /**
   * 阅后即焚的销毁时刻。NULL = 不销毁(普通消息,或阅后即焚会话里对方尚未阅读)。
   * 由 mark_messages_seen() 在对方阅读后写入,到点由 purge_expired_messages() 硬删除。
   */
  expires_at: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
  // Joined
  sender?: Profile
}

export interface Reaction {
  id: string
  message_id: string
  profile_id: string
  emoji: string
  created_at: string
}

export interface FileAttachment {
  id: string
  message_id: string
  file_name: string
  file_url: string
  file_size: number | null
  mime_type: string | null
  created_at: string
}

export interface Pin {
  id: string
  channel_id: string
  message_id: string
  pinned_by: string
  created_at: string
}

export interface ReadReceipt {
  profile_id: string
  channel_id: string
  last_read_at: string
}

export interface WorkspaceSettings {
  workspace_id: string
  livekit_url: string | null
  livekit_api_key: string | null
  livekit_api_secret: string | null
  calls_enabled: boolean
}

export interface ActiveCall {
  id: string
  channel_id: string
  workspace_id: string
  type: 'huddle' | 'video_call'
  livekit_room_name: string
  started_by: string
  started_at: string
  ended_at: string | null
}

export interface CallParticipant {
  call_id: string
  profile_id: string
  joined_at: string
  left_at: string | null
  is_muted: boolean
  is_camera_on: boolean
  is_sharing_screen: boolean
}

export interface IncomingWebhook {
  id: string
  workspace_id: string
  channel_id: string
  name: string
  token: string
  avatar_url: string | null
  display_name: string | null
  is_active: boolean
  created_by: string
  created_at: string
}

export interface OutgoingWebhook {
  id: string
  workspace_id: string
  name: string
  url: string
  signing_secret: string
  events: string[]
  channel_filter: string[] | null
  is_active: boolean
  retry_count: number
  created_by: string
  created_at: string
}

export interface WebhookDeliveryLog {
  id: string
  webhook_id: string
  event_type: string
  status_code: number | null
  response_body: string | null
  latency_ms: number | null
  attempt: number
  error: string | null
  created_at: string
}

export interface Bot {
  id: string
  workspace_id: string
  name: string
  display_name: string
  avatar_url: string | null
  description: string | null
  bot_token: string
  scopes: string[]
  is_active: boolean
  created_by: string
  created_at: string
}

export interface SlashCommand {
  id: string
  workspace_id: string
  command: string
  description: string
  usage_hint: string | null
  type: 'builtin' | 'custom' | 'bot'
  handler_url: string | null
  bot_id: string | null
  is_active: boolean
}

export interface Reminder {
  id: string
  workspace_id: string
  created_by: string
  target_user_id: string
  channel_id: string
  message: string
  remind_at: string
  is_delivered: boolean
  created_at: string
}

export interface ScheduledMessage {
  id: string
  user_id: string
  channel_id: string
  workspace_id: string
  content: string
  scheduled_for: string
  sent: boolean
  created_at: string
}

export interface SavedItem {
  id: string
  user_id: string
  message_id: string
  workspace_id: string
  note: string | null
  created_at: string
  message?: Message
}
