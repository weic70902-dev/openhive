/**
 * 阅后即焚所需的数据库结构(可在应用内执行的版本)。
 *
 * 为什么要有一份 TS 里的副本:
 * 用户不一定愿意去 Supabase 控制台粘 SQL。项目里已经有「粘贴访问令牌 → 走
 * /api/provision 直接执行 DDL」的先例(saved_items),这里沿用同一套流程。
 *
 * 与 `add-disappearing-messages.sql` 必须保持一致 ——
 * `scripts/check-disappearing.mjs` 会同时扫描两处,断言关键语句都在,
 * 漏改任何一边都会让测试失败。
 */

export const DISAPPEARING_MESSAGES_SQL = `
-- 1) 消息的销毁时刻。NULL = 不销毁。
ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS messages_expires_at_idx
  ON messages (expires_at) WHERE expires_at IS NOT NULL;

-- 2) 会话级的阅后即焚时长(秒)。NULL = 关闭。
ALTER TABLE channels ADD COLUMN IF NOT EXISTS disappear_seconds int;

-- 2.1) 计时生效起点。开关每次变更都会重置,保证只有「开启之后发出的」消息才计入。
ALTER TABLE channels ADD COLUMN IF NOT EXISTS disappear_since timestamptz;

-- 2.2) DELETE 事件的 payload.old 默认只带主键,拿不到 channel_id 就没法按频道过滤。
ALTER TABLE messages REPLICA IDENTITY FULL;

-- 2.3) 计时起点由数据库写入,而不是客户端传 now() ——
--      它要和 messages.created_at(服务器时钟)比较,客户端时钟偏差会误伤边界消息。
CREATE OR REPLACE FUNCTION public.touch_disappear_since()
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
$$;

DROP TRIGGER IF EXISTS channels_disappear_since ON channels;

CREATE TRIGGER channels_disappear_since
  BEFORE INSERT OR UPDATE ON channels
  FOR EACH ROW EXECUTE FUNCTION public.touch_disappear_since();

-- 3) 标记消息「已被对方阅读」,由此开始倒计时。
--    必须是 SECURITY DEFINER:倒计时由阅读方触发,而阅读方不是消息作者,
--    messages 的 UPDATE 策略只允许作者改自己的消息,普通 UPDATE 会被 RLS 挡掉。
CREATE OR REPLACE FUNCTION public.mark_messages_seen(p_message_ids uuid[])
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
$$;

-- 4) 清理已过期的阅后即焚消息(硬删除)。
CREATE OR REPLACE FUNCTION public.purge_expired_messages()
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
$$;

GRANT EXECUTE ON FUNCTION public.mark_messages_seen(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_messages() TO authenticated;
`
