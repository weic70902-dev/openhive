-- ============================================================
-- 阅后即焚 —— 数据库结构
-- ============================================================
-- 三种执行方式,任选其一:
--   A.(推荐)在应用里点会话头部的时钟图标 → 「用访问令牌初始化」,
--      粘贴 Supabase Personal Access Token(以 sbp_ 开头)即可自动执行。
--   B. 打开 Supabase 控制台 → SQL Editor → 粘贴本文件全文 → Run
--   C. 重新走一遍 /setup 流程(会按顺序执行 migrations.ts 里的全部迁移)
--
-- 本文件是幂等的,重复执行安全。
-- 「撤回」功能不需要本文件,它复用已有的 messages.is_deleted。
--
-- 注意:内容需与 src/lib/supabase/disappearing-migration.ts 保持一致,
-- scripts/check-disappearing.mjs 会同时扫描两处并断言关键语句都在。
-- ============================================================

-- 1) 消息的销毁时刻。NULL = 不销毁。
ALTER TABLE messages ADD COLUMN IF NOT EXISTS expires_at timestamptz;

CREATE INDEX IF NOT EXISTS messages_expires_at_idx
  ON messages (expires_at) WHERE expires_at IS NOT NULL;

-- 2) 会话级的阅后即焚时长(秒)。NULL = 关闭。
ALTER TABLE channels ADD COLUMN IF NOT EXISTS disappear_seconds int;

-- 2.1) 计时生效起点。开关每次变更都会重置,保证只有「开启之后发出的」消息才计入 ——
--      否则一开开关,历史消息会被一并烧掉。
ALTER TABLE channels ADD COLUMN IF NOT EXISTS disappear_since timestamptz;

-- 2.2) DELETE 事件的 payload.old 默认只带主键,拿不到 channel_id 就没法按频道过滤,
--      多端同步时也认不出该删哪一条。
ALTER TABLE messages REPLICA IDENTITY FULL;

-- 2.3) 计时起点由数据库写入,而不是客户端传 now()。
--      原因:mark_messages_seen 比较的是 m.created_at(服务器时钟)与 disappear_since,
--      起点若取自客户端时钟,两台机器的偏差会让边界附近的消息被误判 ——
--      客户端慢一点,刚发的消息就永远不销毁;快一点,历史消息被误烧。
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
--
-- 为什么必须是 SECURITY DEFINER:
-- 倒计时由「阅读方」触发,而阅读方不是消息作者 —— messages 的 UPDATE 策略
-- 只允许作者改自己的消息,普通 UPDATE 会被 RLS 挡掉。
-- 函数内显式校验「调用者是该会话成员」且「消息不是自己发的」,
-- 并且只写 expires_at 一个字段,不会放大权限。
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
-- 只删除调用者所在会话里的消息,避免任意用户触发全库删除。
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
