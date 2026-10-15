-- ╔══════════════════════════════════════════════════════════════╗
-- ║  附件桶私有化 —— 让「私密聊天」真的私密                        ║
-- ╚══════════════════════════════════════════════════════════════╝
--
-- 现状:avatars / attachments 两个桶都是 public —— 文件直链
-- **不需要登录**就能被任何人读取,拿到 URL 即可永久访问。
--
-- 本脚本做什么:
--   1. attachments 桶转私有;
--   2. 给 storage.objects 加一条 SELECT 策略:已登录用户可读/可签。
--
-- 不改什么:
--   · 上传/删除:走服务端 service_role(/api/upload),天然绕过 RLS,无需策略;
--   · avatars 桶:**保持 public**。头像渲染点遍布 12 个文件(49 处),
--     一次性私有化改动面与回归风险都太大,而头像是低敏感资料
--     (路径还是 userId),收益不成比例。后续要收紧可单独做。
--
-- 执行方式(项目 ref: dkiyumhhvfwltvcdjykr):
--   ./apply-sql.sh <sbp_令牌> private-attachments.sql
-- 或粘贴到 Supabase SQL Editor。令牌用完请立刻吊销。
--
-- 副作用(私有化的目的,不是 bug):
--   · 粘到过外部的旧公开直链会 403 —— 这正是私有化要的效果;
--   · 数据库消息正文里存的仍是公开直链(作为**持久引用**),
--     客户端渲染时现换签名 URL(src/lib/attachment-url.ts +
--     hooks/use-signed-text.ts),历史消息无需迁移。

-- 1) 已登录用户可读/可签附件(幂等)
DROP POLICY IF EXISTS "attachments_read_authenticated" ON storage.objects;
CREATE POLICY "attachments_read_authenticated" ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'attachments');

-- 2) 桶转私有
UPDATE storage.buckets
SET public = false
WHERE id = 'attachments';

-- 3) 校验(执行后应看到:attachments 的 public = false,策略存在)
-- SELECT id, public FROM storage.buckets ORDER BY id;
-- SELECT policyname, cmd, roles FROM pg_policies
--  WHERE schemaname = 'storage' AND tablename = 'objects';
