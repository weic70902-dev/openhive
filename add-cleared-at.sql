-- ============================================================
-- 清空会话 —— 数据库结构
-- ============================================================
-- 三种执行方式,任选其一:
--   A.(推荐)在应用里点会话头部的清空图标 → 「用访问令牌初始化」,
--      粘贴 Supabase Personal Access Token(以 sbp_ 开头)即可自动执行。
--   B. 打开 Supabase 控制台 → SQL Editor → 粘贴本文件全文 → Run
--   C. 重新走一遍 /setup 流程(会按顺序执行 migrations.ts 里的全部迁移)
--
-- 本文件是幂等的,重复执行安全。
--
-- 注意:内容需与 src/lib/supabase/cleared-migration.ts 保持一致,
-- scripts/check-clear-conversation.mjs 会同时扫描两处并断言关键语句都在。
-- ============================================================

-- 1) 每个成员各自记录「我清到哪个时刻」。NULL = 从未清空过。
--    语义是「只对我隐藏」:清空后我看不到这之前的消息,对方的记录一条不少。
ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS cleared_at timestamptz;

-- 2) 把「我」在这个会话里的视图截止点推到当前时刻。
--
-- 为什么必须是 SECURITY DEFINER:
-- channel_members 只有 select / insert / delete 三条策略,**没有 UPDATE 策略** ——
-- RLS 的默认拒绝会让普通 UPDATE 直接失败。
--
-- 为什么不去补一条 cm_update 策略(那样更省事):
-- 策略只能限制「能改哪些行」,拦不住「能改哪些列」。
-- 开一条 USING (profile_id = auth.uid()) 之后,成员就能顺手把自己的
-- role 改成 admin。这里改成由函数精确地只写 cleared_at 一个字段,权限面最小。
CREATE OR REPLACE FUNCTION public.clear_channel_for_me(p_channel_id uuid)
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
$$;

GRANT EXECUTE ON FUNCTION public.clear_channel_for_me(uuid) TO authenticated;
