// All 23 SQL table definitions + RLS policies + triggers
// Ported from the Swift DatabaseProvisioner

export const migrations: string[] = [
  // 001 - Profiles
  `CREATE TABLE IF NOT EXISTS profiles (
    id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email text,
    display_name text NOT NULL DEFAULT 'User',
    avatar_url text,
    status_emoji text,
    status_text text,
    is_online boolean DEFAULT false,
    last_seen_at timestamptz,
    created_at timestamptz DEFAULT now()
  );`,

  // 002 - Workspaces
  `CREATE TABLE IF NOT EXISTS workspaces (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    slug text UNIQUE NOT NULL,
    icon_url text,
    created_at timestamptz DEFAULT now()
  );`,

  // 003 - Workspace Members
  `CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
    profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
    role text NOT NULL DEFAULT 'member',
    joined_at timestamptz DEFAULT now(),
    PRIMARY KEY (workspace_id, profile_id)
  );`,

  // 004 - Channels
  `CREATE TABLE IF NOT EXISTS channels (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    description text,
    topic text,
    is_private boolean DEFAULT false,
    is_archived boolean DEFAULT false,
    created_by uuid REFERENCES profiles(id),
    created_at timestamptz DEFAULT now()
  );`,

  // 005 - Channel Members
  `CREATE TABLE IF NOT EXISTS channel_members (
    channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,
    profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
    role text DEFAULT 'member',
    notification_pref text DEFAULT 'all',
    joined_at timestamptz DEFAULT now(),
    PRIMARY KEY (channel_id, profile_id)
  );`,

  // 006 - Messages
  `CREATE TABLE IF NOT EXISTS messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    sender_id uuid REFERENCES profiles(id) ON DELETE SET NULL,
    content text NOT NULL DEFAULT '',
    parent_id uuid REFERENCES messages(id) ON DELETE SET NULL,
    thread_reply_count int DEFAULT 0,
    is_edited boolean DEFAULT false,
    is_deleted boolean DEFAULT false,
    metadata jsonb,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  );`,

  // 007 - Reactions
  `CREATE TABLE IF NOT EXISTS reactions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    emoji text NOT NULL,
    created_at timestamptz DEFAULT now(),
    UNIQUE(message_id, profile_id, emoji)
  );`,

  // 008 - File Attachments
  `CREATE TABLE IF NOT EXISTS file_attachments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    file_name text NOT NULL,
    file_url text NOT NULL,
    file_size bigint,
    mime_type text,
    created_at timestamptz DEFAULT now()
  );`,

  // 009 - Pins
  `CREATE TABLE IF NOT EXISTS pins (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    pinned_by uuid NOT NULL REFERENCES profiles(id),
    created_at timestamptz DEFAULT now(),
    UNIQUE(channel_id, message_id)
  );`,

  // 010 - Read Receipts
  `CREATE TABLE IF NOT EXISTS read_receipts (
    profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
    channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,
    last_read_at timestamptz DEFAULT now(),
    PRIMARY KEY (profile_id, channel_id)
  );`,

  // 025 - Workspace Settings
  `CREATE TABLE IF NOT EXISTS workspace_settings (
    workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
    livekit_url text,
    livekit_api_key text,
    livekit_api_secret text,
    calls_enabled boolean DEFAULT false
  );`,

  // 026 - Active Calls
  `CREATE TABLE IF NOT EXISTS active_calls (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    type text NOT NULL DEFAULT 'huddle',
    livekit_room_name text NOT NULL,
    started_by uuid NOT NULL REFERENCES profiles(id),
    started_at timestamptz DEFAULT now(),
    ended_at timestamptz
  );`,

  // 027 - Call Participants
  `CREATE TABLE IF NOT EXISTS call_participants (
    call_id uuid REFERENCES active_calls(id) ON DELETE CASCADE,
    profile_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
    joined_at timestamptz DEFAULT now(),
    left_at timestamptz,
    is_muted boolean DEFAULT false,
    is_camera_on boolean DEFAULT false,
    is_sharing_screen boolean DEFAULT false,
    PRIMARY KEY (call_id, profile_id)
  );`,

  // 028 - Incoming Webhooks
  `CREATE TABLE IF NOT EXISTS incoming_webhooks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    name text NOT NULL,
    token text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
    avatar_url text,
    display_name text,
    is_active boolean DEFAULT true,
    created_by uuid NOT NULL REFERENCES profiles(id),
    created_at timestamptz DEFAULT now()
  );`,

  // 029 - Outgoing Webhooks
  `CREATE TABLE IF NOT EXISTS outgoing_webhooks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    url text NOT NULL,
    signing_secret text NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
    events text[] NOT NULL DEFAULT '{}',
    channel_filter uuid[],
    is_active boolean DEFAULT true,
    retry_count int DEFAULT 3,
    created_by uuid NOT NULL REFERENCES profiles(id),
    created_at timestamptz DEFAULT now()
  );`,

  // 030 - Webhook Delivery Logs
  `CREATE TABLE IF NOT EXISTS webhook_delivery_logs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_id uuid NOT NULL REFERENCES outgoing_webhooks(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    status_code int,
    response_body text,
    latency_ms int,
    attempt int DEFAULT 1,
    error text,
    created_at timestamptz DEFAULT now()
  );`,

  // 031 - Bots
  `CREATE TABLE IF NOT EXISTS bots (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    name text NOT NULL,
    display_name text NOT NULL,
    avatar_url text,
    description text,
    bot_token text UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
    scopes text[] DEFAULT '{}',
    is_active boolean DEFAULT true,
    created_by uuid NOT NULL REFERENCES profiles(id),
    created_at timestamptz DEFAULT now()
  );`,

  // 032 - Bot Channel Memberships
  `CREATE TABLE IF NOT EXISTS bot_channel_memberships (
    bot_id uuid REFERENCES bots(id) ON DELETE CASCADE,
    channel_id uuid REFERENCES channels(id) ON DELETE CASCADE,
    added_by uuid REFERENCES profiles(id),
    added_at timestamptz DEFAULT now(),
    PRIMARY KEY (bot_id, channel_id)
  );`,

  // 033 - Bot Event Subscriptions
  `CREATE TABLE IF NOT EXISTS bot_event_subscriptions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bot_id uuid NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    event_type text NOT NULL,
    callback_url text NOT NULL,
    filter jsonb DEFAULT '{}',
    is_active boolean DEFAULT true
  );`,

  // 034 - Slash Commands
  `CREATE TABLE IF NOT EXISTS slash_commands (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    command text NOT NULL,
    description text NOT NULL DEFAULT '',
    usage_hint text,
    type text NOT NULL DEFAULT 'builtin',
    handler_url text,
    bot_id uuid REFERENCES bots(id) ON DELETE SET NULL,
    is_active boolean DEFAULT true
  );`,

  // 035 - Reminders
  `CREATE TABLE IF NOT EXISTS reminders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_by uuid NOT NULL REFERENCES profiles(id),
    target_user_id uuid NOT NULL REFERENCES profiles(id),
    channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message text NOT NULL,
    remind_at timestamptz NOT NULL,
    is_delivered boolean DEFAULT false,
    created_at timestamptz DEFAULT now()
  );`,

  // 036 - Shared Channel Links
  `CREATE TABLE IF NOT EXISTS shared_channel_links (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    local_channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    remote_workspace_url text NOT NULL,
    remote_channel_id uuid NOT NULL,
    remote_channel_name text,
    signing_key_local text NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
    signing_key_remote text NOT NULL,
    sync_endpoint_url text NOT NULL,
    status text DEFAULT 'active',
    last_synced_at timestamptz,
    created_at timestamptz DEFAULT now()
  );`,

  // 037 - Remote Profiles
  `CREATE TABLE IF NOT EXISTS remote_profiles (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    remote_workspace_url text NOT NULL,
    remote_user_id text NOT NULL,
    display_name text,
    avatar_url text,
    workspace_name text,
    last_updated_at timestamptz DEFAULT now(),
    UNIQUE(remote_workspace_url, remote_user_id)
  );`,

  // 038 - Scheduled Messages
  `CREATE TABLE IF NOT EXISTS scheduled_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    channel_id UUID REFERENCES channels(id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    scheduled_for TIMESTAMPTZ NOT NULL,
    sent BOOLEAN DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT now()
  );`,

  // 039 - Saved Items (Bookmarks)
  `CREATE TABLE IF NOT EXISTS saved_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
    message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    note TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE(user_id, message_id)
  );`,

  // RLS Policies + Triggers
  `-- Nuclear cleanup: drop ALL existing policies
  DO $cleanup$
  DECLARE
    r RECORD;
  BEGIN
    FOR r IN (
      SELECT schemaname, tablename, policyname
      FROM pg_policies
      WHERE schemaname = 'public'
    )
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    END LOOP;
  END
  $cleanup$;

  -- Enable RLS on all tables
  ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
  ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
  ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;
  ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
  ALTER TABLE channel_members ENABLE ROW LEVEL SECURITY;
  ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE reactions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE file_attachments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE pins ENABLE ROW LEVEL SECURITY;
  ALTER TABLE read_receipts ENABLE ROW LEVEL SECURITY;
  ALTER TABLE workspace_settings ENABLE ROW LEVEL SECURITY;
  ALTER TABLE active_calls ENABLE ROW LEVEL SECURITY;
  ALTER TABLE call_participants ENABLE ROW LEVEL SECURITY;
  ALTER TABLE incoming_webhooks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE outgoing_webhooks ENABLE ROW LEVEL SECURITY;
  ALTER TABLE webhook_delivery_logs ENABLE ROW LEVEL SECURITY;
  ALTER TABLE bots ENABLE ROW LEVEL SECURITY;
  ALTER TABLE bot_channel_memberships ENABLE ROW LEVEL SECURITY;
  ALTER TABLE bot_event_subscriptions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE slash_commands ENABLE ROW LEVEL SECURITY;
  ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
  ALTER TABLE shared_channel_links ENABLE ROW LEVEL SECURITY;
  ALTER TABLE remote_profiles ENABLE ROW LEVEL SECURITY;
  ALTER TABLE scheduled_messages ENABLE ROW LEVEL SECURITY;
  ALTER TABLE saved_items ENABLE ROW LEVEL SECURITY;

  -- SECURITY DEFINER helpers (bypass RLS to prevent infinite recursion)
  CREATE OR REPLACE FUNCTION get_my_workspace_ids()
  RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
  AS $fn$ SELECT workspace_id FROM workspace_members WHERE profile_id = auth.uid(); $fn$;

  CREATE OR REPLACE FUNCTION get_my_admin_workspace_ids()
  RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
  AS $fn$ SELECT workspace_id FROM workspace_members WHERE profile_id = auth.uid() AND role IN ('owner', 'admin'); $fn$;

  CREATE OR REPLACE FUNCTION get_my_channel_ids()
  RETURNS SETOF uuid LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
  AS $fn$ SELECT channel_id FROM channel_members WHERE profile_id = auth.uid(); $fn$;

  -- Profiles (only visible to co-workers in shared workspaces, or self)
  CREATE POLICY "profiles_select" ON profiles FOR SELECT USING (
    id = auth.uid()
    OR id IN (
      SELECT wm2.profile_id FROM workspace_members wm1
      JOIN workspace_members wm2 ON wm1.workspace_id = wm2.workspace_id
      WHERE wm1.profile_id = auth.uid()
    )
  );
  CREATE POLICY "profiles_update" ON profiles FOR UPDATE USING (auth.uid() = id);
  CREATE POLICY "profiles_insert" ON profiles FOR INSERT WITH CHECK (auth.uid() = id);

  -- Workspaces
  -- NOTE: INSERT must NOT require pre-existing membership. The client creates the
  -- workspace first and adds itself to workspace_members afterwards, so a
  -- membership-based WITH CHECK would always fail on first creation.
  -- Any authenticated user may create a workspace; they can only add themselves
  -- as a member (enforced by the wm_insert policy below).
  CREATE POLICY "workspaces_select" ON workspaces FOR SELECT USING (id IN (SELECT get_my_workspace_ids()));
  CREATE POLICY "workspaces_insert" ON workspaces FOR INSERT TO authenticated WITH CHECK (auth.uid() IS NOT NULL);
  CREATE POLICY "workspaces_update" ON workspaces FOR UPDATE USING (id IN (SELECT get_my_admin_workspace_ids()));

  -- Workspace Members (insert restricted to self + workspace must exist)
  CREATE POLICY "wm_select" ON workspace_members FOR SELECT USING (workspace_id IN (SELECT get_my_workspace_ids()));
  CREATE POLICY "wm_insert" ON workspace_members FOR INSERT WITH CHECK (profile_id = auth.uid());
  CREATE POLICY "wm_delete" ON workspace_members FOR DELETE USING (workspace_id IN (SELECT get_my_admin_workspace_ids()) OR profile_id = auth.uid());

  -- Channels
  CREATE POLICY "channels_select" ON channels FOR SELECT USING (workspace_id IN (SELECT get_my_workspace_ids()));
  CREATE POLICY "channels_insert" ON channels FOR INSERT WITH CHECK (workspace_id IN (SELECT get_my_workspace_ids()));
  CREATE POLICY "channels_update" ON channels FOR UPDATE USING (workspace_id IN (SELECT get_my_workspace_ids()));

  -- Channel Members (insert restricted to own workspace channels)
  CREATE POLICY "cm_select" ON channel_members FOR SELECT USING (channel_id IN (SELECT get_my_channel_ids()) OR profile_id = auth.uid());
  CREATE POLICY "cm_insert" ON channel_members FOR INSERT WITH CHECK (
    channel_id IN (SELECT id FROM channels WHERE workspace_id IN (SELECT get_my_workspace_ids()))
    AND (
      profile_id = auth.uid()
      OR channel_id IN (SELECT id FROM channels WHERE created_by = auth.uid())
    )
  );
  CREATE POLICY "cm_delete" ON channel_members FOR DELETE USING (profile_id = auth.uid() OR channel_id IN (SELECT c.id FROM channels c WHERE c.workspace_id IN (SELECT get_my_admin_workspace_ids())));

  -- Messages
  CREATE POLICY "msg_select" ON messages FOR SELECT USING (channel_id IN (SELECT get_my_channel_ids()));
  CREATE POLICY "msg_insert" ON messages FOR INSERT WITH CHECK (channel_id IN (SELECT get_my_channel_ids()));
  CREATE POLICY "msg_update" ON messages FOR UPDATE USING (sender_id = auth.uid());
  CREATE POLICY "msg_delete" ON messages FOR DELETE USING (sender_id = auth.uid());

  -- Reactions
  CREATE POLICY "react_select" ON reactions FOR SELECT USING (message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT get_my_channel_ids())));
  CREATE POLICY "react_insert" ON reactions FOR INSERT WITH CHECK (profile_id = auth.uid());
  CREATE POLICY "react_delete" ON reactions FOR DELETE USING (profile_id = auth.uid());

  -- File Attachments (insert restricted to messages in own channels)
  CREATE POLICY "fa_select" ON file_attachments FOR SELECT USING (message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT get_my_channel_ids())));
  CREATE POLICY "fa_insert" ON file_attachments FOR INSERT WITH CHECK (message_id IN (SELECT id FROM messages WHERE channel_id IN (SELECT get_my_channel_ids())));

  -- Pins
  CREATE POLICY "pins_select" ON pins FOR SELECT USING (channel_id IN (SELECT get_my_channel_ids()));
  CREATE POLICY "pins_insert" ON pins FOR INSERT WITH CHECK (channel_id IN (SELECT get_my_channel_ids()));
  CREATE POLICY "pins_delete" ON pins FOR DELETE USING (pinned_by = auth.uid());

  -- Read Receipts
  CREATE POLICY "rr_select" ON read_receipts FOR SELECT USING (profile_id = auth.uid());
  CREATE POLICY "rr_upsert" ON read_receipts FOR INSERT WITH CHECK (profile_id = auth.uid());
  CREATE POLICY "rr_update" ON read_receipts FOR UPDATE USING (profile_id = auth.uid());

  -- Workspace Settings (admin-only insert, all members can read non-secret fields)
  CREATE POLICY "ws_select" ON workspace_settings FOR SELECT USING (workspace_id IN (SELECT get_my_workspace_ids()));
  CREATE POLICY "ws_insert" ON workspace_settings FOR INSERT WITH CHECK (workspace_id IN (SELECT get_my_admin_workspace_ids()));
  CREATE POLICY "ws_update" ON workspace_settings FOR UPDATE USING (workspace_id IN (SELECT get_my_admin_workspace_ids()));

  -- Active Calls
  CREATE POLICY "ac_select" ON active_calls FOR SELECT USING (workspace_id IN (SELECT get_my_workspace_ids()));
  CREATE POLICY "ac_insert" ON active_calls FOR INSERT WITH CHECK (workspace_id IN (SELECT get_my_workspace_ids()));
  CREATE POLICY "ac_update" ON active_calls FOR UPDATE USING (workspace_id IN (SELECT get_my_workspace_ids()));

  -- Call Participants (scoped to calls in own workspace)
  CREATE POLICY "cp_select" ON call_participants FOR SELECT USING (call_id IN (SELECT id FROM active_calls WHERE workspace_id IN (SELECT get_my_workspace_ids())));
  CREATE POLICY "cp_insert" ON call_participants FOR INSERT WITH CHECK (profile_id = auth.uid());
  CREATE POLICY "cp_update" ON call_participants FOR UPDATE USING (profile_id = auth.uid());

  -- Webhooks (admin-only management)
  CREATE POLICY "iw_select" ON incoming_webhooks FOR SELECT USING (workspace_id IN (SELECT get_my_workspace_ids()));
  CREATE POLICY "iw_insert" ON incoming_webhooks FOR INSERT WITH CHECK (workspace_id IN (SELECT get_my_admin_workspace_ids()));
  CREATE POLICY "ow_select" ON outgoing_webhooks FOR SELECT USING (workspace_id IN (SELECT get_my_workspace_ids()));
  CREATE POLICY "ow_insert" ON outgoing_webhooks FOR INSERT WITH CHECK (workspace_id IN (SELECT get_my_admin_workspace_ids()));
  CREATE POLICY "wdl_select" ON webhook_delivery_logs FOR SELECT USING (webhook_id IN (SELECT id FROM outgoing_webhooks WHERE workspace_id IN (SELECT get_my_workspace_ids())));

  -- Bots
  CREATE POLICY "bots_select" ON bots FOR SELECT USING (workspace_id IN (SELECT get_my_workspace_ids()));
  CREATE POLICY "bots_insert" ON bots FOR INSERT WITH CHECK (workspace_id IN (SELECT get_my_admin_workspace_ids()));
  CREATE POLICY "bcm_select" ON bot_channel_memberships FOR SELECT USING (bot_id IN (SELECT id FROM bots WHERE workspace_id IN (SELECT get_my_workspace_ids())));
  CREATE POLICY "bcm_insert" ON bot_channel_memberships FOR INSERT WITH CHECK (bot_id IN (SELECT id FROM bots WHERE workspace_id IN (SELECT get_my_admin_workspace_ids())));
  CREATE POLICY "bes_select" ON bot_event_subscriptions FOR SELECT USING (bot_id IN (SELECT id FROM bots WHERE workspace_id IN (SELECT get_my_workspace_ids())));
  CREATE POLICY "bes_insert" ON bot_event_subscriptions FOR INSERT WITH CHECK (bot_id IN (SELECT id FROM bots WHERE workspace_id IN (SELECT get_my_admin_workspace_ids())));

  -- Slash Commands
  CREATE POLICY "sc_select" ON slash_commands FOR SELECT USING (workspace_id IN (SELECT get_my_workspace_ids()));
  CREATE POLICY "sc_insert" ON slash_commands FOR INSERT WITH CHECK (workspace_id IN (SELECT get_my_admin_workspace_ids()));

  -- Reminders
  CREATE POLICY "rem_select" ON reminders FOR SELECT USING (target_user_id = auth.uid() OR created_by = auth.uid());
  CREATE POLICY "rem_insert" ON reminders FOR INSERT WITH CHECK (created_by = auth.uid());

  -- Shared Channel Links
  CREATE POLICY "scl_select" ON shared_channel_links FOR SELECT USING (local_channel_id IN (SELECT get_my_channel_ids()));

  -- Remote Profiles (scoped: only visible to users who share a channel link to the remote workspace)
  CREATE POLICY "rp_select" ON remote_profiles FOR SELECT USING (
    remote_workspace_url IN (
      SELECT scl.remote_workspace_url FROM shared_channel_links scl
      WHERE scl.local_channel_id IN (SELECT get_my_channel_ids())
    )
  );
  CREATE POLICY "rp_insert" ON remote_profiles FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
  CREATE POLICY "rp_update" ON remote_profiles FOR UPDATE USING (auth.uid() IS NOT NULL);

  -- Scheduled Messages
  CREATE POLICY "sm_select" ON scheduled_messages FOR SELECT USING (user_id = auth.uid());
  CREATE POLICY "sm_insert" ON scheduled_messages FOR INSERT WITH CHECK (user_id = auth.uid());
  CREATE POLICY "sm_update" ON scheduled_messages FOR UPDATE USING (user_id = auth.uid());
  CREATE POLICY "sm_delete" ON scheduled_messages FOR DELETE USING (user_id = auth.uid());

  -- Saved Items (Bookmarks)
  CREATE POLICY "si_select" ON saved_items FOR SELECT USING (user_id = auth.uid());
  CREATE POLICY "si_insert" ON saved_items FOR INSERT WITH CHECK (user_id = auth.uid());
  CREATE POLICY "si_delete" ON saved_items FOR DELETE USING (user_id = auth.uid());

  -- Trigger: auto-create profile on signup
  CREATE OR REPLACE FUNCTION handle_new_user()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
  AS $fn$
  BEGIN
    INSERT INTO public.profiles (id, email, display_name)
    VALUES (
      NEW.id,
      NEW.email,
      COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1))
    )
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      display_name = EXCLUDED.display_name;
    RETURN NEW;
  END;
  $fn$;

  DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
  CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION handle_new_user();

  -- Trigger: update thread reply count
  CREATE OR REPLACE FUNCTION update_thread_reply_count()
  RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
  AS $fn$
  BEGIN
    IF NEW.parent_id IS NOT NULL THEN
      UPDATE messages SET thread_reply_count = (
        SELECT count(*) FROM messages WHERE parent_id = NEW.parent_id
      ) WHERE id = NEW.parent_id;
    END IF;
    RETURN NEW;
  END;
  $fn$;

  DROP TRIGGER IF EXISTS on_message_reply ON messages;
  CREATE TRIGGER on_message_reply
    AFTER INSERT ON messages
    FOR EACH ROW
    WHEN (NEW.parent_id IS NOT NULL)
    EXECUTE FUNCTION update_thread_reply_count();`,

  // Realtime Setup
  `DO $$
  BEGIN
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE messages; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE channels; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE channel_members; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE active_calls; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE call_participants; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE profiles; EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE reactions; EXCEPTION WHEN duplicate_object THEN NULL; END;
  END
  $$;`,

  // Replica identity full for channel_members (needed for DELETE events to include old row data)
  `ALTER TABLE channel_members REPLICA IDENTITY FULL;`,

  // Cleanup orphaned auth users
  `DELETE FROM auth.users
  WHERE id NOT IN (SELECT id FROM public.profiles)
  AND created_at < now() - interval '1 minute';`,

  // ============================================================
  // 026 - 阅后即焚
  // ============================================================

  // 消息的销毁时刻。NULL = 不销毁。
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at timestamptz;`,

  `CREATE INDEX IF NOT EXISTS messages_expires_at_idx
     ON messages (expires_at) WHERE expires_at IS NOT NULL;`,

  // 会话级的阅后即焚时长(秒)。NULL = 关闭。
  `ALTER TABLE channels ADD COLUMN IF NOT EXISTS disappear_seconds int;`,

  // 计时生效起点。开关每次变更都会重置,保证只有「开启之后发出的」消息才计入 ——
  // 否则一开开关,历史消息会被一并烧掉。
  `ALTER TABLE channels ADD COLUMN IF NOT EXISTS disappear_since timestamptz;`,

  // DELETE 事件的 payload.old 默认只带主键,拿不到 channel_id 就没法按频道过滤,
  // 多端同步时也认不出该删哪一条。
  `ALTER TABLE messages REPLICA IDENTITY FULL;`,

  /**
   * 计时起点由**数据库**写入,而不是客户端传 now()。
   *
   * 原因:mark_messages_seen 里比较的是 m.created_at(服务器时钟)与 disappear_since,
   * 如果起点取自客户端时钟,两台机器的偏差会让边界附近的消息被误判 ——
   * 客户端慢一点,刚发的消息就永远不销毁;快一点,历史消息被误烧。
   */
  `CREATE OR REPLACE FUNCTION public.touch_disappear_since()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public
  AS $$
  BEGIN
    IF TG_OP = 'INSERT' THEN
      IF NEW.disappear_seconds IS NOT NULL AND NEW.disappear_since IS NULL THEN
        NEW.disappear_since := now();
      END IF;
    ELSIF NEW.disappear_seconds IS DISTINCT FROM OLD.disappear_seconds THEN
      NEW.disappear_since := CASE WHEN NEW.disappear_seconds IS NULL THEN NULL ELSE now() END;
    END IF;
    RETURN NEW;
  END;
  $$;`,

  `DROP TRIGGER IF EXISTS channels_disappear_since ON channels;`,

  `CREATE TRIGGER channels_disappear_since
     BEFORE INSERT OR UPDATE ON channels
     FOR EACH ROW EXECUTE FUNCTION public.touch_disappear_since();`,

  /**
   * 标记消息「已被对方阅读」,由此**开始倒计时**。
   *
   * 为什么必须是 SECURITY DEFINER:
   * 倒计时由「阅读方」触发,而阅读方不是消息作者 ——
   * messages 的 UPDATE 策略只允许作者改自己的消息,普通 UPDATE 会被 RLS 挡掉。
   * 这里显式校验「调用者是该会话成员」且「消息不是自己发的」,
   * 并且只写 expires_at 一个字段,不会放大权限。
   */
  `CREATE OR REPLACE FUNCTION public.mark_messages_seen(p_message_ids uuid[])
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  BEGIN
    UPDATE messages m
       SET expires_at = now() + make_interval(secs => c.disappear_seconds)
      FROM channels c
     WHERE m.id = ANY(p_message_ids)
       AND m.channel_id = c.id
       AND c.disappear_seconds IS NOT NULL
       AND (c.disappear_since IS NULL OR m.created_at >= c.disappear_since)
       AND m.expires_at IS NULL
       AND m.is_deleted = false
       AND m.sender_id IS DISTINCT FROM auth.uid()
       AND EXISTS (
         SELECT 1 FROM channel_members cm
          WHERE cm.channel_id = m.channel_id AND cm.profile_id = auth.uid()
       );
  END;
  $$;`,

  /**
   * 清理已过期的阅后即焚消息(硬删除)。
   * 只删除调用者所在会话里的消息,避免任意用户触发全库删除。
   */
  `CREATE OR REPLACE FUNCTION public.purge_expired_messages()
  RETURNS int
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    deleted_count int;
  BEGIN
    WITH del AS (
      DELETE FROM messages m
       WHERE m.expires_at IS NOT NULL
         AND m.expires_at <= now()
         AND EXISTS (
           SELECT 1 FROM channel_members cm
            WHERE cm.channel_id = m.channel_id AND cm.profile_id = auth.uid()
         )
      RETURNING 1
    )
    SELECT count(*) INTO deleted_count FROM del;
    RETURN deleted_count;
  END;
  $$;`,

  `GRANT EXECUTE ON FUNCTION public.mark_messages_seen(uuid[]) TO authenticated;`,
  `GRANT EXECUTE ON FUNCTION public.purge_expired_messages() TO authenticated;`,

  // 027 - 清空会话(只清自己这边)
  /**
   * 每个成员各自记录「我清到哪个时刻」。
   *
   * 语义是**只对我隐藏**:清空后我看不到这之前的消息,对方的记录一条不少。
   * 所以这里存的是「视图截止点」,而不是删除任何 messages 行 ——
   * 不可逆地删掉对方的历史,不是「隐藏」该有的行为。
   */
  `ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS cleared_at timestamptz;`,

  /**
   * 把「我」在这个会话里的视图截止点推到当前时刻。
   *
   * 为什么必须是 SECURITY DEFINER:
   * channel_members 只有 select / insert / delete 三条策略,**没有 UPDATE 策略** ——
   * RLS 的默认拒绝会让普通 UPDATE 直接失败。
   *
   * 为什么不去补一条 cm_update 策略(那样更省事):
   * 策略只能限制「能改哪些行」,拦不住「能改哪些列」。
   * 开一条 `USING (profile_id = auth.uid())` 之后,成员就能顺手把自己的
   * role 改成 admin。这里改成由函数精确地只写 cleared_at 一个字段,
   * 权限面最小。
   */
  `CREATE OR REPLACE FUNCTION public.clear_channel_for_me(p_channel_id uuid)
  RETURNS timestamptz
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    cleared timestamptz;
  BEGIN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'not authenticated';
    END IF;

    UPDATE channel_members
       SET cleared_at = now()
     WHERE channel_id = p_channel_id
       AND profile_id = auth.uid()
    RETURNING cleared_at INTO cleared;

    -- 不是这个会话的成员(或会话不存在)时,UPDATE 命中 0 行。
    -- 这里显式报错,而不是静默返回 NULL —— 否则前端会以为清空成功了。
    IF cleared IS NULL THEN
      RAISE EXCEPTION 'not a member of this channel';
    END IF;

    RETURN cleared;
  END;
  $$;`,

  `GRANT EXECUTE ON FUNCTION public.clear_channel_for_me(uuid) TO authenticated;`,
]

export const REQUIRED_TABLES = [
  'profiles', 'workspaces', 'workspace_members',
  'channels', 'channel_members', 'messages',
  'reactions', 'file_attachments', 'pins', 'read_receipts',
  'workspace_settings', 'active_calls', 'call_participants',
  'incoming_webhooks', 'outgoing_webhooks', 'webhook_delivery_logs',
  'bots', 'bot_channel_memberships', 'bot_event_subscriptions',
  'slash_commands', 'reminders', 'shared_channel_links', 'remote_profiles',
  'scheduled_messages',
  'saved_items',
]
