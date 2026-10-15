/**
 * 清空会话所需的数据库结构(可在应用内执行的版本)。
 *
 * 为什么要有一份 TS 里的副本:
 * 用户不一定愿意去 Supabase 控制台粘 SQL。项目里已经有「粘贴访问令牌 → 走
 * /api/provision 直接执行 DDL」的先例(saved_items、阅后即焚),这里沿用同一套流程。
 *
 * 与 `add-cleared-at.sql` 必须保持一致 ——
 * `scripts/check-clear-conversation.mjs` 会同时扫描两处,断言关键语句都在,
 * 漏改任何一边都会让测试失败。
 */

export const CLEARED_AT_SQL = `
-- 1) 每个成员各自记录「我清到哪个时刻」。NULL = 从未清空过。
ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS cleared_at timestamptz;

-- 2) 把「我」在这个会话里的视图截止点推到当前时刻。
--    channel_members 没有 UPDATE 策略,所以必须是 SECURITY DEFINER 函数;
--    而不用补 cm_update 策略,是因为策略拦不住「改哪些列」——
--    那会顺带允许成员把自己的 role 改成 admin。
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

  IF cleared IS NULL THEN
    RAISE EXCEPTION 'not a member of this channel';
  END IF;

  RETURN cleared;
END;
$$;

GRANT EXECUTE ON FUNCTION public.clear_channel_for_me(uuid) TO authenticated;
`
