-- ============================================================
-- OpenHive 修复脚本：workspaces_insert 策略死循环
-- ============================================================
-- 问题：原策略要求「插入工作区时，你必须是该工作区的成员」
--       但客户端是先建工作区、后加成员，导致首次创建永远被拒绝，
--       界面报 "Failed to create workspace"。
--
-- 执行方式：Supabase Dashboard → SQL Editor → 粘贴全文 → Run
-- ============================================================

-- 1) 删除有缺陷的旧策略
DROP POLICY IF EXISTS "workspaces_insert" ON workspaces;

-- 2) 重建为正确策略
--    任何已登录用户都可创建工作区；之后只能把自己加入成员表
--    （这一限制由已有的 wm_insert 策略 profile_id = auth.uid() 保证）
CREATE POLICY "workspaces_insert" ON workspaces
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);

-- ============================================================
-- 验证：确认策略已更新
-- ============================================================
SELECT policyname, cmd, roles, with_check
FROM pg_policies
WHERE tablename = 'workspaces'
ORDER BY policyname;

-- 期望看到 workspaces_insert 的 with_check 为：
--   (auth.uid() IS NOT NULL)
-- ============================================================
