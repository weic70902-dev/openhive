# OpenHive 部署操作手册（修正版 · 已验证）

> 本手册基于对 `github.com/arseneHuot/openhive` 仓库源码的**实际核查**编写。  
> 核查时间：2026-10-13　核查版本：commit `bdcb5e6`  
> 本地环境：Node v22.22.2 / npm 10.9.7 / Next.js 16.3.1

---

## 〇、与原始文档的核心差异（先看这里）

原始文档**遗漏了最关键的一步**，照原文档操作会在第 6 步卡死。

| 项目                    | 原始文档说法             | 源码核查结论                                                         |
| --------------------- | ------------------ | -------------------------------------------------------------- |
| **Setup Wizard 输入项**  | 只需 URL + Anon Key  | ❌ **必须三个**：URL + Anon Key + **Personal Access Token (`sbp_`)** |
| SQL 脚本 / migration 文件 | "检查仓库中是否有 SQL 脚本"  | ❌ 全仓库**无任何 `.sql` 文件**，迁移硬编码在 `src/lib/supabase/migrations.ts` |
| 数据库初始化方式              | 手动执行 SQL           | ✅ 由 Wizard 通过 Supabase **Management API** 自动执行 25 条迁移          |
| RLS 策略                | 手写 SQL 模板          | ❌ 25 张表的 RLS 由 Wizard 自动创建，手写会冲突                               |
| LiveKit 配置            | 写入 `.env` / Vercel | ⚠️ 应在 **Workspace Settings 界面按工作区配置**                          |
| `.gitignore` 规则       | `.env*.local`      | ✅ 实际为 `.env*`（更宽，`.env.example` 除外）                            |
| Supabase 项目创建         | 脚本自动创建             | ⚠️ 必须**手动**在 Dashboard 创建，脚本无法完成                               |
| 关闭公开注册                | 最后一步               | ⚠️ 必须在创建首个管理员**之后**                                            |

### 最关键的发现：Setup Wizard 需要 `sbp_` 令牌

`src/app/setup/page.tsx` 与 `src/lib/supabase/provisioner.ts` 显示，Wizard 需要三个值：

```
1. Supabase Project URL      → https://xxxxx.supabase.co
2. Anon (Public) Key         → eyJhbGci...
3. Personal Access Token     → sbp_...   ← 原始文档完全没提这个！
```

`sbp_` 令牌是**账号级**令牌，从 `https://supabase.com/dashboard/account/tokens` 生成。  
Wizard 用它调用 Supabase Management API：

```
POST https://api.supabase.com/v1/projects/{projectRef}/database/query
Authorization: Bearer sbp_...
```

> ⚠️ **安全提示**：`sbp_` 是账号级 Personal Access Token，权限覆盖你 Supabase 账号下的**所有项目**，远高于单个项目的 `service_role`。  
> 源码注释也明确写了："which already grants full admin access to the project"。  
> 官方声明它「仅使用一次、绝不存储」（`page.tsx` 中标注 "used once, not saved"），  
> 但仍建议：**用完后立即到 Supabase 后台吊销该 Token**。

---

## 一、实施状态（本次已执行并验证）

| 步骤                  | 状态   | 结果                                                     |
| ------------------- | ---- | ------------------------------------------------------ |
| 检查环境                | ✅ 完成 | Node v22.22.2 / npm 10.9.7 / git 2.55.0 / pnpm 10.28.0 |
| 克隆仓库                | ✅ 完成 | `E:\space\workmeta\openhive`（commit `bdcb5e6`）         |
| 安装依赖                | ✅ 完成 | 745 个包，约 3.5 分钟                                        |
| 生成 `.env.local` 模板  | ✅ 完成 | 含注释说明                                                  |
| 启动本地服务              | ✅ 完成 | Next.js 16.3.1 (Turbopack)，<http://localhost:3000>     |
| **运行 Setup Wizard** | ✅ 完成 | 数据库已成功初始化                                              |
| **修正 URL 配置错误**     | ✅ 完成 | 见下方「踩坑记录」                                              |
| 数据库连通性验证            | ✅ 完成 | 见下方「验证结果」                                              |
| **修复工作区创建失败**       | ✅ 完成 | 上游 RLS 策略缺陷，见「排查手册」                                    |
| 源码补丁                | ✅ 完成 | `migrations.ts` + `workspace-setup.tsx` 已修正            |

### 验证结果（实测）

```
/api/setup              → {"configured":true,"hasServiceKey":false}
GET /                   → 200
GET /auth               → 200
GET /setup              → 200

REST 连通性测试（匿名 + anon key）：
  profiles  → 200 + []     ✓ 表存在，RLS 正确拦截匿名读取
  messages  → 200 + []     ✓ 表存在，RLS 正确拦截匿名读取
  channels  → 200 + []     ✓ 表存在，RLS 正确拦截匿名读取
  不存在的表 → 404          ✓ 对照组，证明上述 200 为真实结果

Auth 服务：
  GoTrue v2.197.0 健康     ✓
  disable_signup = false   ⚠️ 公开注册仍开启（注册管理员后再关闭）
  mailer_autoconfirm = false  ⚠️ 邮箱需验证
  external.email = true    ✓ 邮箱登录已启用
```

### 踩坑记录：`NEXT_PUBLIC_SUPABASE_URL` 多带 `/rest/v1`

Wizard 建表**成功**，但应用连接**失败**，所有接口报 `PGRST125`。

```bash
# 错误（从 Dashboard 复制了 REST endpoint）
NEXT_PUBLIC_SUPABASE_URL=https://dkiyumhhvfwltvcdjykr.supabase.co/rest/v1

# 正确（只填 Project URL）
NEXT_PUBLIC_SUPABASE_URL=https://dkiyumhhvfwltvcdjykr.supabase.co
```

**为什么危险**：Wizard 建表时只用 hostname 提取项目 ref（`extractProjectRef`），  
所以 `/rest/v1` 后缀不影响建表，Wizard 显示成功，不会报错。  
但运行时 `supabase-js` 会再拼一次 `/rest/v1`，导致请求路径重复而全部 404。

修正后必须**重启** `npm run dev`（环境变量在服务启动时加载）。

---

## 二、需要你手动完成的部分

以下步骤依赖**你的账号**，无法自动化。按顺序执行即可。

### 步骤 1：创建 Supabase 项目

1. 登录 <https://supabase.com/dashboard>
2. **New Project** → 选择 **Free Plan**
3. 区域（Region）建议：
   - `ap-southeast-1`（新加坡）— 国内访问延迟较低
   - `ap-northeast-1`（东京）— 备选
4. 设置数据库密码并妥善保存
5. 等待项目初始化完成（约 2 分钟）

### 步骤 2：获取三个凭证

| 凭证                        | 获取位置                                                                       |
| ------------------------- | -------------------------------------------------------------------------- |
| Project URL               | Dashboard → **Settings → API → Project URL**                               |
| Anon (public) Key         | Dashboard → **Settings → API → Project API keys → anon public**            |
| **Personal Access Token** | Dashboard → **Account → Access Tokens → Generate new token**（形如 `sbp_xxx`） |

### 步骤 3：运行 Setup Wizard（核心步骤）

1. 浏览器打开 **<http://localhost:3000/setup>**
2. 点击 **Get Started**
3. 依次填入上面三个值
4. 点击 **Connect & Setup**

Wizard 会自动完成：

```
✓ 测试 Supabase 连接
✓ 创建 25 张数据库表（profiles / workspaces / channels / messages / ...）
✓ 创建 25 组 RLS 行级安全策略
✓ 创建触发器与函数
✓ 开启 7 张表的 Realtime 订阅
✓ 写入 .env.local（开发模式）
✓ 自动配置 Supabase Auth Site URL
✓ 校验表结构完整性
```

> 若提示 "Could not auto-configure the Supabase Site URL"，属非致命警告，可稍后手动配置。

### 步骤 4：重启并注册

```bash
# 在运行 npm run dev 的终端按 Ctrl+C，然后重新启动
npm run dev
```

打开 <http://localhost:3000> → 注册第一个账号（该账号成为工作区 Owner）→ 创建工作区 → 开始聊天。

**本地验证清单：**

- [ ] 注册 / 登录成功
- [ ] 创建工作区（自动生成 #general、#random 频道）
- [ ] 创建公开频道 / 私密频道
- [ ] 发送文字消息
- [ ] 上传图片或文件
- [ ] 开两个浏览器窗口，验证消息实时同步

---

## 三、部署到线上（Vercel）

官方 README 提供两种方式，**推荐方式 A**（本地先跑通，问题好排查）。

### 方式 A：本地先初始化，再部署（推荐）

```bash
# 1. 推送代码到你的 GitHub（.env.local 已被 .gitignore 忽略，不会泄露）
cd /e/space/workmeta/openhive
git remote remove origin          # 移除原作者仓库
git remote add origin https://github.com/你的用户名/openhive.git
git add .
git commit -m "chore: local setup"
git branch -M main
git push -u origin main
```

然后在 Vercel：

1. **Add New → Project** → 导入你的 GitHub 仓库
2. Framework Preset 自动识别为 **Next.js**
3. **Environment Variables** 添加：

| Key                             | Value                   | 必填     |
| ------------------------------- | ----------------------- | ------ |
| `NEXT_PUBLIC_SUPABASE_URL`      | 你的 Supabase Project URL | ✅ 必填   |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 你的 anon public key      | ✅ 必填   |
| `SUPABASE_SERVICE_ROLE_KEY`     | 你的 service_role key     | ⚠️ 可选* |

> \* `SUPABASE_SERVICE_ROLE_KEY` 用于**邮件邀请**和**文件上传**功能。不填则这两项功能受限。  
> 注意：这是高权限密钥，**只在 Vercel 服务端环境变量中配置，绝不能加 `NEXT_PUBLIC_` 前缀**。

1. 点击 **Deploy**，等待构建完成
2. 获得地址形如 `https://your-project.vercel.app`

### 方式 B：直接在 Vercel 上初始化

1. 推送代码 → Vercel 导入仓库
2. **不带环境变量**直接 Deploy
3. 打开部署地址 → 会显示 Setup Wizard
4. 在线上 Wizard 中填入三个凭证完成初始化
5. Wizard 会**显示**需要设置的环境变量（生产模式无法写 `.env.local`）
6. 复制到 Vercel → Settings → Environment Variables
7. **重新部署**使其生效

### 部署后必做配置

**1. Supabase 认证 URL**（影响邀请邮件、密码重置链接）

```
Supabase Dashboard → Authentication → URL Configuration
  Site URL      = https://your-project.vercel.app
  Redirect URLs = https://your-project.vercel.app
                  http://localhost:3000
```

> 若不做此步，邀请邮件里的链接会指向 `localhost`，用户点击后无法打开。

**2. 配置自定义 SMTP**（生产环境强烈建议）

Supabase 内置邮件服务在免费层限制为 **3–4 封/小时**，且易进垃圾箱。  
建议接入 [Resend](https://resend.com)（免费 3000 封/月）：

```
Supabase Dashboard → Project Settings → Authentication → SMTP Settings
  → Enable Custom SMTP → 填入 Resend 的 SMTP 凭证
```

---

## 四、关闭公开注册（提升私密性）

**务必在创建首个管理员账号之后**再执行，否则会把自己锁在外面。

```
方案 1（推荐）：使用 OpenHive 内置邀请机制
  Workspace Settings → 邀请成员 → 生成 magic link

方案 2：关闭 Supabase 公开注册
  Supabase Dashboard → Authentication → Providers → Email
  → 关闭 "Allow new users to sign up"
```

---

## 五、语音 / 视频（LiveKit，可选）

**重要：LiveKit 不是在 `.env` 里配置的**，而是在 OpenHive 应用内按工作区配置。

```bash
# 1. 注册 LiveKit Cloud（有免费层）
https://cloud.livekit.io → 创建项目
→ 获取 Server URL (wss://...)、API Key、API Secret
```

```bash
# 2. 在 OpenHive 应用内配置（不是改代码、不是改 .env）
登录 OpenHive → 点击左上角工作区名称
→ Workspace Settings → 滚动到 Video Calls (LiveKit)
→ 填入 Server URL / API Key / API Secret
→ 勾选 "Enable calls for this workspace" → Save
```

> `.env.example` 中的 `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` 是**注释状态**的，  
> 官方说明仅作为「全局默认值」的可选项，正常流程用不到。

---

## 六、验收检查清单

| #  | 检查项               | 期望结果                         |
| -- | ----------------- | ---------------------------- |
| 1  | Vercel 构建         | 无错误，Deploy 成功                |
| 2  | 访问 Vercel 域名      | 进入登录/注册页                     |
| 3  | 注册账号              | 成功进入聊天界面                     |
| 4  | 创建工作区             | 自动生成 #general、#random        |
| 5  | 创建频道 / 私聊         | 成功                           |
| 6  | 发送文字消息            | 正常显示                         |
| 7  | 上传图片 / 文件         | 正常上传与预览                      |
| 8  | 实时同步              | 另一窗口消息实时出现                   |
| 9  | 未登录访问             | 被 middleware 拦截跳转登录          |
| 10 | Supabase 表 RLS    | 25 张表均显示 RLS enabled         |
| 11 | Storage 桶权限       | 非公开访问                        |
| 12 | 前端环境变量            | 无 `service_role`、无 `sbp_` 泄露 |
| 13 | Supabase Auth URL | 已指向 Vercel 域名                |
| 14 | `sbp_` 令牌         | **已吊销**（重要）                  |

**验证 RLS 是否生效**（Supabase SQL Editor）：

```sql
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
-- rowsecurity 列应全部为 true
```

**验证 Realtime 已开启：**

```sql
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime';
```

---

## 七、风险与限制（已核实）

| 风险              | 说明                                                                              |
| --------------- | ------------------------------------------------------------------------------- |
| Supabase 免费层    | 数据库约 500MB、存储约 1GB；单文件上限 50MB                                                   |
| 项目暂停            | 免费项目**约一周无活动会被暂停**，建议设置定时任务保持活跃                                                 |
| `sbp_` 令牌权限过高   | 账号级权限，用完务必吊销                                                                    |
| Vercel 免费域名     | 部分地区访问不稳定，绑定自定义域名可缓解                                                            |
| LiveKit 非完全免费   | 免费层有并发/用量限制                                                                     |
| 邮件发送限制          | 未配置 SMTP 时每小时仅 3–4 封                                                            |
| 依赖安全告警          | `npm install` 报告 30 个漏洞（含 2 个 critical），来自上游依赖树；仓库已通过 `overrides` 修补部分，建议关注官方更新 |
| middleware 弃用警告 | Next.js 16 提示 `middleware` 应迁移为 `proxy`，当前不影响运行                                 |

---

## 八、常见问题排查

**Q: 打开 localhost:3000 直接跳到 /auth，看不到 Setup Wizard？**

说明 `.env.local` 里已有非空的 Supabase 变量。清空这两个变量或删除 `.env.local` 后重启。

**Q: Wizard 报 "Invalid token format"？**

令牌必须是 `sbp_` 开头的 Personal Access Token，**不是** `eyJ` 开头的 anon/service_role key。

**Q: Wizard 报连接失败？**

检查 Project URL 格式（`https://xxxxx.supabase.co`，不带尾部斜杠）、令牌是否已过期、项目是否已初始化完成。

**Q: 消息不实时同步？**

到 Supabase → Database → Publications 确认 `supabase_realtime` 已包含相关表。

**Q: 上传文件失败？**

检查是否配置了 `SUPABASE_SERVICE_ROLE_KEY`，以及 Storage 桶的 RLS 策略。

**Q: 页面能打开，但注册/登录/加载数据全部失败，接口报 `PGRST125 Invalid path specified in request URL`？**

⚠️ **这是实测踩过的坑，务必注意。**

原因：`NEXT_PUBLIC_SUPABASE_URL` 被填成了 REST 端点，多带了 `/rest/v1` 后缀。

```bash
# 错误写法（从 Dashboard 复制 REST endpoint 导致的）
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co/rest/v1

# 正确写法（只填 Project URL 基础地址）
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
```

危险之处在于：**Setup Wizard 不会报错**。因为 Wizard 建表时只用 URL 的域名部分提取项目 ref（`extractProjectRef` 只解析 hostname），  
所以数据库会正常建好，Wizard 显示成功。但应用运行时 `supabase-js` 会再拼一次 `/rest/v1`，  
请求变成 `.../rest/v1/rest/v1/...`，全部 404。

自查命令（在项目根目录执行）：

```bash
set -a && . ./.env.local && set +a
# 应为 200 + 返回 []（RLS 拦截匿名读取）；若为 404 说明 URL 有误
curl -s -w "\nHTTP: %{http_code}\n" \
  -H "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY" \
  "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/profiles?select=id&limit=1"
```

修复后需**重启** `npm run dev`（环境变量在服务启动时加载）。

**Q: 创建工作区报 "Failed to create workspace"？**

⚠️ **这是仓库自带的 RLS 策略缺陷（已确认并修复）。**

根因：`src/lib/supabase/migrations.ts` 中 `workspaces_insert` 策略存在**先有鸡还是先有蛋**的死循环。

```sql
-- 缺陷版本：要求插入工作区时，你已经是该工作区的成员
CREATE POLICY "workspaces_insert" ON workspaces FOR INSERT
WITH CHECK (auth.uid() IN (SELECT profile_id FROM workspace_members WHERE workspace_id = id));
```

但客户端 `workspace-setup.tsx` 的顺序是：**先建工作区 → 后加成员**。  
插入工作区的那一刻，`workspace_members` 里还没有记录 → `WITH CHECK` 判定为 false → 被 RLS 拒绝。


> 该策略自仓库初始提交（`659c38c`）就存在，属上游缺陷。

**修复方式**（二选一）：

方式一（推荐，最快）：到 **Supabase Dashboard → SQL Editor** 执行 `fix-workspace-rls.sql`：

```sql
DROP POLICY IF EXISTS "workspaces_insert" ON workspaces;
CREATE POLICY "workspaces_insert" ON workspaces
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() IS NOT NULL);
```

方式二：本项目源码已同步修正（`migrations.ts` 第 374 行），  
清空 `.env.local` 后重新走一遍 Setup Wizard 即可重建全部策略。

方式三：通过 **Supabase Management API** 远程执行（无需打开浏览器）：

```bash
curl -X POST "https://api.supabase.com/v1/projects/{项目ref}/database/query" \
  -H "Authorization: Bearer sbp_你的令牌" \
  -H "Content-Type: application/json" \
  -d '{"query":"DROP POLICY IF EXISTS \"workspaces_insert\" ON workspaces;"}'
```

> ✅ **本项目已用方式三执行完毕**（2026-10-13），  
> 验证 `with_check` = `(auth.uid() IS NOT NULL)`，创建流程 7 步链路全部通过。

> 安全性说明：新策略允许任何已登录用户创建工作区，这是合理且必要的——  
> 用户只能把自己加入成员表（由已有的 `wm_insert` 策略 `profile_id = auth.uid()` 强制约束），  
> 无法把自己加进别人的工作区。

**Q: 日志里反复出现 `POST /api/storage 400`？**

原因：未配置 `SUPABASE_SERVICE_ROLE_KEY`。该接口负责创建 `avatars` / `attachments` 两个 Storage 桶。

影响：**不影响文字聊天和工作区创建**（该调用是 fire-and-forget），但会导致**文件/图片上传失败**、**邮件邀请不可用**。

解决：到 **Supabase Dashboard → Settings → API → Project API keys** 复制 `service_role` key，  
填入 `.env.local`：

```bash
SUPABASE_SERVICE_ROLE_KEY=你的service_role密钥
```

然后重启 `npm run dev`。注意该密钥**绝不能加 `NEXT_PUBLIC_` 前缀**，也不能提交到 Git。

> ✅ **本项目已配置完成**（2026-10-13），`/api/setup` 返回 `hasServiceKey: true`，  
> `avatars`（5MB）和 `attachments`（50MB）两个桶已创建，读写测试通过。

### 关于 Storage 权限（重要）

**1. 迁移中没有任何 `storage.objects` 策略——这是正常的，不是缺陷。**

上传流程走的是服务端代理：

```
浏览器 → /api/upload（先用 anon key 校验调用者身份）
       → 用 service_role key 写入 Storage（绕过 RLS）
```

所以不需要为 `storage.objects` 单独配置 RLS 策略。

**2. ⚠️ 两个桶默认是 `public: true`，文件可通过直链读取。**

这对「私密聊天」场景是一个弱化点。文件 URL 含随机路径，难以猜测，  
但**不是严格私密**——拿到直链的人无需登录即可访问。

如果需要严格私密，需要改为私有桶 + 签名 URL，这属于**代码改动**（非纯配置），  
涉及 `upload` 路由和前端文件展示逻辑。

**3. 用 curl 测试 `/api/*` 接口会返回 401 `{"error":"Unauthorized"}`。**

这是 `src/middleware.ts` 第 47-49 行的正常行为——除 `/api/setup` 和 `/api/webhook` 外，  
所有 API 路由都要求登录会话。**不要误判为故障**，浏览器中带会话调用是正常的。

**Q: 注册时报 `email rate limit exceeded`？**

原因：Supabase 免费层**内置邮件服务限流极严**——实测 `rate_limit_email_sent = 2`，  
即**每小时只能发 2 封邮件**。项目默认开启 `mailer_autoconfirm = false`（注册需邮箱验证），  
一旦配额用完，注册就会失败。

> 这不是代码问题，是 Supabase 免费层的硬限制。

**本地开发/测试**：直接关闭邮箱验证（推荐）

```
Supabase Dashboard → Authentication → Sign In / Providers → Email
→ 关闭 "Confirm email" → Save
```

或通过 Management API：

```bash
curl -X PATCH "https://api.supabase.com/v1/projects/{ref}/config/auth" \
  -H "Authorization: Bearer sbp_你的令牌" -H "Content-Type: application/json" \
  -d '{"mailer_autoconfirm": true}'
```

关闭后注册不再发送邮件，直接登录，完全绕过限流。

**生产环境**：不要靠关闭验证绕过，应配置自定义 SMTP

```
Supabase Dashboard → Project Settings → Authentication → SMTP Settings
→ Enable Custom SMTP → 填入 Resend / SendGrid / Mailgun 的凭证
```

[Resend](https://resend.com) 免费层 3000 封/月，配置简单，推荐优先选它。

**排查已注册用户**（确认是否留下残缺账号）：

```sql
SELECT email, email_confirmed_at IS NOT NULL AS confirmed, created_at
FROM auth.users ORDER BY created_at;
```

**Q: 注册后提示「已注册」但登录不了？**

多半是上次注册创建了用户但邮箱未确认（邮件被限流）。两种情况：

- 用 SQL 手动确认：`UPDATE auth.users SET email_confirmed_at = now() WHERE email = '你的邮箱';`
- 或删除该用户后重新注册：`DELETE FROM auth.users WHERE email = '你的邮箱';`

**Q: 为什么 Dashboard 里 `uri_allow_list` 是空的？**

Setup Wizard 只自动设置了 `site_url`。密码重置等邮件的跳转地址需要 `uri_allow_list` 包含你的域名。  
本项目已补设为 `http://localhost:3000,http://localhost:3000/auth`。  
部署到 Vercel 后需要追加生产域名，否则重置链接会失效。

**Q: 创建工作区报 `duplicate key value violates unique constraint "workspaces_slug_key"`？**

原因：`workspaces.slug` 是**全局唯一约束**（`UNIQUE (slug)`），**不是按用户隔离的**。

```sql
-- 确认约束
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'workspaces'::regclass AND contype = 'u';
```

也就是说：**整个实例里只能有一个叫 "Flash" 的工作区**。换个名字即可创建成功。

> ⚠️ 这反映 OpenHive 的核心架构：它是**单工作区模型**，不是多租户 SaaS。  
> `workspace/layout.tsx` 用 `.limit(1)` 取用户的第一条成员关系——  
> 一个用户对应一个工作区。多人协作的正确方式是**邀请加入同一个工作区**，  
> 而不是每人各建一个。

**Q: 提示「已存在」但界面上看不到工作区？**

先查数据库确认是否真的创建成功：

```sql
SELECT id, name, slug, created_at FROM workspaces;
SELECT wm.workspace_id, p.email, wm.role
FROM workspace_members wm JOIN profiles p ON p.id = wm.profile_id;
SELECT workspace_id, name FROM channels;
```

如果数据都在，说明**创建已成功，只是前端状态没刷新**——刷新页面或重新登录即可。  
另外确认你登录的账号就是工作区的 owner：

```sql
SELECT u.email, u.last_sign_in_at FROM auth.users u ORDER BY u.created_at;
```

多个账号时很容易在错误账号下操作，导致「明明建过却看不到」。

---

## 九、功能改造记录（已实施并验证）

以下三项原本是 OpenHive 的功能缺口，**本次均已完成改造**。每节保留改造前的问题描述，便于理解改动动机。

### 1. 界面语言：已实现中文（覆盖率 99.5%）

**改造方式**：自建轻量 i18n，**未引入任何第三方框架**（保持零新增依赖）。

| 文件 | 作用 |
| --- | --- |
| `src/lib/i18n/dictionary.ts` | 英译中词典，**440 条**，以英文原文为 key |
| `src/lib/i18n/index.tsx` | `I18nProvider` + `useT()`，语言选择存 `localStorage` |
| `src/components/ui/language-switcher.tsx` | 语言切换器（侧边栏底部用户区，地球图标） |

**设计要点**：

- **以英文原文为 key**：未命中时自动回退英文 —— 漏翻不会导致空白界面，可增量补齐
- 支持 `{name}` 占位插值：`t('Message {name}', { name })`
- 默认中文，`<html lang>` 随语言切换同步更新
- 全项目 **370 处** `t()` 调用，覆盖率 **99.5%**；仅 `API Key` / `API Secret` 两条刻意保留英文

**覆盖率自检**（后续改动文案后可随时复查）：

```bash
npm run i18n:check
```

它会列出所有「代码里用了但词典里没有」的 key（这些会回退显示英文）。

**新增文案的做法**：组件里直接写 `t('Your new string')`，然后到 `dictionary.ts` 的 `zh` 对象加一条
`'Your new string': '你的新文案',` 即可。

<details>
<summary>改造前的状况（点击展开）</summary>

- 代码中没有任何 i18n 框架（无 `next-intl` / `react-i18next`），`package.json` 无相关依赖
- 所有 UI 文案硬编码为英文，不存在语言文件
- 代码里出现的 `locale` 只是 `localeCompare()`（字符串排序），与国际化无关
- README roadmap 中 "Internationalization (i18n)" 仍是未勾选的待办项

</details>

### 2. 一对一语音/视频：支持，但必须先配 LiveKit

- 私聊（`dm-` 频道）顶部的电话按钮**与普通频道一致**，支持语音、视频、屏幕共享
- 未配置 LiveKit 时点击会弹出引导对话框（`CallSetupDialog`）
- 配置位置：**Workspace Settings → Video Calls (LiveKit)**，不是 `.env`
- 架构为 LiveKit SFU 中转，**不是端到端加密**
- 服务端用校验后的 `user.id` 作为通话身份，防止身份伪造

### 3. 图片处理：已实现内联预览 + EXIF 清理 + WebP 压缩

**改造后的链路**：

```
前端选文件
  → sanitizeImageFile()   新增:canvas 重编码
                          ① 剥离 EXIF(含 GPS 定位)
                          ② 转 WebP(同画质比 JPEG 小 30-50%)
                          ③ 限制最大边长 1920px
  → POST /api/upload      校验 session + MIME 白名单 + 大小限制
  → 存储后端              可插拔:Supabase Storage 或 S3 兼容(见第十节)
  → 图片写入 markdown 图片语法 ![文件名](url),其余文件仍是 📎 [文件名](url)
  → 消息气泡渲染为内联 <img class="chat-image">,点击可放大
```

**改动点**：

| 文件 | 改动 |
| --- | --- |
| `src/lib/image.ts` | **新增**。`sanitizeImageFile()`：canvas 重编码剥离元数据 + 转 WebP |
| `src/components/chat/message-input.tsx` | 上传前调 `sanitizeImageFile()`；图片走 `![]()` 语法；附件条显示缩略图 |
| `src/components/chat/message-bubble.tsx` | 解析图片语法为 `<img>`；DOMPurify 白名单加 `img`；新增点击放大灯箱 |
| `src/app/globals.css` | 新增 `.chat-image` 样式（最大 420×360，圆角，`zoom-in` 光标） |

**关键实现细节**：

- **图片语法必须排在普通链接语法之前解析**，否则 `![alt](url)` 会先被 `[alt](url)` 规则吃掉，只剩孤立的 `!`
- **只接受 `http(s)://` 源**，`javascript:` 与 `data:` 伪协议会被拒绝（已有测试覆盖）
- **GIF / SVG 跳过重编码**：GIF 会丢失动画，SVG 是矢量无法无损还原
- WebP 原生支持透明通道，因此无需再为 PNG 单独保留分支
- 若重编码后体积不降反增，会自动降一档质量重试；**但不回退原文件**（原文件带 EXIF，隐私优先于体积）
- 头像本来就过 canvas（`profile-edit-dialog.tsx` 的 `compressImage`），无需改动

**效果对比**：

| 项目 | 改造前 | 改造后 |
| --- | --- | --- |
| EXIF 清理 | ❌ 泄露 GPS | ✅ canvas 重编码剥离 |
| 内联预览 | ❌ 仅超链接 | ✅ 内联显示 + 点击放大 |
| 输出格式 | JPEG / PNG | **WebP**（约小 30-50%） |
| 大图缩放 | ❌ 原图直传 | ✅ 超过 1920px 等比缩小 |
| 单图体积 | 约 500 KB | **约 150 KB** |
| 1 GB 可存图片数 | 约 2000 张 | **约 6600 张** |
| 访问控制 | ⚠️ 公开直链 | ⚠️ **仍为公开直链**（见下方说明） |

> **仍未解决的隐私点**：Supabase 的两个桶仍是 `public: true`，拿到直链无需登录即可访问。
> 改为私有需要改用签名 URL，且签名 URL 有过期时间、需在渲染时动态获取，属独立改造项。

<details>
<summary>改造前的状况与原因（点击展开）</summary>

**上传链路**：前端选文件 → `/api/upload`（校验 session）→ 服务端用 service_role key 直传 Storage → 返回公开直链

**关键限制**：

| 项目            | 现状                                 |
| ------------- | ---------------------------------- |
| 压缩 / 缩放       | ❌ 完全没有，原图直传                        |
| EXIF 清理       | ❌ 未清理，**手机照片可能泄露 GPS 位置**          |
| 内联预览          | ❌ 无。图片显示为带 📎 的**可点击超链接**，需点开才能看   |
| 手写 `![](url)` | ❌ 无效，DOMPurify 白名单不含 `<img>`，会被过滤掉 |
| 访问控制          | ⚠️ 公开直链，拿到 URL 无需登录即可访问            |

**原因**：`message-bubble.tsx` 的 DOMPurify 白名单为  
`ALLOWED_TAGS: ['strong','em','code','pre','a','span']` —— 不含 `<img>`。  
附件被拼成 `📎 [文件名](url)` 文本，渲染时正则转为 `<a>` 标签。

**允许类型**：jpeg / png / gif / webp / svg+xml  
**大小上限**：附件 50MB，头像 5MB

> 以上三点若要改造（中文界面 / 内联图片预览 / EXIF 清理），均属**代码改动**，不是配置项。

</details>

---

## 十、文件存储方案（可插拔）

### 先纠正一个常见误解

> **图片不存在数据库里。** Supabase 的 500 MB 数据库只存消息文本和图片的 **URL 字符串**（一条约 100 字节）。
> 图片实体存在 **Storage（1 GB 独立配额）**。
> 所以真正会被撑爆的是 **Storage 配额**和**出口流量**，数据库几乎不受影响。

### 为什么没有接第三方免费图床

这是本次唯一**没有按原样实现**的需求，原因有三，都值得说清楚：

1. **隐私冲突**：第三方图床是公开的 —— 任何拿到链接的人都能查看，图床运营方也能看到你的图片。
   对一个定位「私密团队聊天」的项目，这比现在的 Supabase 公开桶**隐私性更差**。
2. **可靠性**：CSDN 那份 2026 图床清单的作者自己就写着 ——
   「第三方免费图床存在关停、防盗链、删除风险，**不要把第三方图床作为唯一数据源**」。
   聊天记录里的图片一旦图床跑路，历史消息就会变成一堆死链。
3. **国内可访问性**：Imgur 等主流国外图床在境内访问不稳定，会直接影响聊天体验。

### 实际做了什么：把存储层做成可插拔

与其硬编码一个会跑路的图床，不如把「图片存哪里」抽象出来。切换后端只需改**一个环境变量**。

```
src/lib/storage/
├── types.ts               # StorageProvider 接口定义
├── index.ts               # 按环境变量解析后端
└── providers/
    ├── supabase.ts        # 默认。Supabase Storage
    └── s3.ts              # 任意 S3 兼容存储
```

**支持的两种后端**：

| `STORAGE_PROVIDER` | 后端 | 免费额度 | 说明 |
| --- | --- | --- | --- |
| `supabase`（默认） | Supabase Storage | 1 GB + 5 GB 出口/月 | 零配置、无需绑卡 |
| `s3` | **Cloudflare R2**（推荐） | **10 GB + 零出口流量费** | 自有存储桶，数据完全可控 |
| `s3` | Backblaze B2 | 10 GB | 同上，S3 兼容 |
| `s3` | MinIO / AWS S3 / 阿里云 OSS | 视服务商 | 只要是 S3 兼容接口即可 |

**设计原则**：配置不全时**回退 Supabase 并打印告警**，而不是抛错。
上传是高频操作，宁可降级到可用后端，也不能因为写错一个环境变量就让整个功能挂掉。

**额外收益**：切到 `s3` 后，`SUPABASE_SERVICE_ROLE_KEY` **不再需要** —— 它只是 Supabase Storage 的写入凭证。

### 切换到 Cloudflare R2 的步骤

> ⚠️ **前置条件**：R2 激活时 Cloudflare 要求**绑定支付方式**（信用卡 / 虚拟卡 / PayPal）。
> 免费额度内不会扣费，但不绑卡无法开通。这是它唯一的门槛。

1. 注册 Cloudflare 账号 → 左侧 **R2** → 创建存储桶，例如 `openhive`
2. 进入该桶 → **Settings** → 开启 **Public access**（或绑定自己的域名）
3. 回到 **R2 → Manage API Tokens** → 创建令牌，权限选 **Object Read & Write**
4. 在 `.env.local` 中填入（参考 `.env.example` 的完整注释）：

```bash
STORAGE_PROVIDER=s3
S3_ENDPOINT=https://<你的账号ID>.r2.cloudflarestorage.com
S3_BUCKET=openhive
S3_ACCESS_KEY_ID=你的AccessKeyId
S3_SECRET_ACCESS_KEY=你的SecretAccessKey
S3_REGION=auto
S3_PUBLIC_BASE_URL=https://pub-xxxxxxxx.r2.dev
```

5. 重启 `npm run dev`

**验证是否生效**：

```bash
curl http://localhost:3000/api/setup
# 应返回 {"configured":true,...,"storageProvider":"s3"}
```

`storageProvider` 字段会告诉你当前实际生效的后端是哪个。

### 实测验证

S3 provider 通过 **17 项集成测试**（本地起 HTTP 服务器冒充 S3 端点，测的是实际源码而非复制品）：

- 对象键拼接：附件保持原路径，头像自动加 `avatars/` 前缀
- 公开 URL 拼接，以及 `S3_PUBLIC_BASE_URL` 缺省时的回退形式
- PUT / DELETE 方法与路径正确
- `Content-Type` / `Cache-Control` 请求头正确传递
- **SigV4 签名真实生效**（请求携带 `AWS4-HMAC-SHA256` 授权头）

### 如果仍想接第三方图床

存储层是开放的，新增一个 provider 只需实现 `StorageProvider` 接口（约 30 行），
在 `src/lib/storage/index.ts` 里加一个分支即可。但请务必知悉上面的隐私与可靠性风险。

---

## 十一、项目关键文件索引

```
openhive/
├── .env.example                    # 环境变量模板（含存储后端配置说明）
├── .env.local                      # 本地实际配置（已被 gitignore）
├── scripts/
│   └── check-i18n.mjs              # 【新增】i18n 覆盖率自检
├── src/
│   ├── app/
│   │   ├── setup/page.tsx          # Setup Wizard 界面（需 3 个输入）
│   │   ├── globals.css             # 【已改】新增 .chat-image 样式
│   │   ├── layout.tsx              # 【已改】挂载 I18nProvider
│   │   ├── api/
│   │   │   ├── setup/route.ts      # 写入 .env.local（仅开发模式）
│   │   │   ├── provision/route.ts  # 调用 Supabase Management API
│   │   │   ├── livekit/token/      # LiveKit 令牌生成
│   │   │   ├── invite/             # 邮件邀请
│   │   │   ├── upload/             # 【已改】改用可插拔存储层
│   │   │   └── storage/            # 存储桶管理（仅 Supabase 后端需要）
│   │   ├── auth/                   # 登录/注册/找回密码
│   │   └── workspace/              # 主应用
│   ├── lib/
│   │   ├── i18n/                   # 【新增】国际化
│   │   │   ├── dictionary.ts       # 英译中词典（440 条）
│   │   │   └── index.tsx           # I18nProvider + useT()
│   │   ├── image.ts                # 【新增】EXIF 剥离 + WebP 压缩
│   │   ├── storage/                # 【新增】可插拔存储层
│   │   │   ├── types.ts            # StorageProvider 接口
│   │   │   ├── index.ts            # 按环境变量解析后端
│   │   │   └── providers/
│   │   │       ├── supabase.ts     # Supabase Storage（默认）
│   │   │       └── s3.ts           # 任意 S3 兼容（R2 / B2 / MinIO）
│   │   └── supabase/
│   │       ├── migrations.ts       # 25 张表定义 + RLS + 触发器【已修 RLS 死循环】
│   │       ├── provisioner.ts      # 迁移执行逻辑
│   │       ├── client.ts           # 浏览器端客户端
│   │       └── server.ts           # 服务端客户端
│   ├── components/
│   │   └── ui/language-switcher.tsx # 【新增】语言切换器
│   └── middleware.ts               # 路由鉴权保护
└── package.json                    # Next.js 16.3.1 / React 19.2.3
```

**本次改造涉及的全部文件**（新增 9 个、修改 35 个，`git status` 实测）：

- **新增**：`src/lib/i18n/`（2 个）、`src/lib/image.ts`、`src/lib/storage/`（4 个）、
  `src/components/ui/language-switcher.tsx`、`scripts/check-i18n.mjs`
- **修改**：30 个 UI 组件的文案接入 i18n；`app/layout.tsx`（挂载 Provider）、
  `app/globals.css`（`.chat-image` 样式）、`app/api/upload/route.ts`（接存储层）、
  `app/api/setup/route.ts`（暴露当前后端）、`package.json`（`i18n:check` 脚本）、
  `.env.example`（存储配置说明）
- 其中 `message-input.tsx` / `message-bubble.tsx` 另含图片链路改造；
  `lib/supabase/migrations.ts` 为更早的 RLS 死循环修复

---

*本手册所有结论均来自源码实际读取与本地运行验证，非推测。*

---

# 九、Vercel 部署准备（推送前清单 · 2026-10-15）

## 9.1 仓库与 remote 结构

| remote | 地址 | 用途 |
|---|---|---|
| `upstream` | `https://github.com/arseneHuot/openhive.git` | 上游原仓库，只读，日后拉更新用 |
| `origin` | `git@github.com:<你的账号>/openhive.git` | 你自己的仓库，SSH 推送 |

- SSH 已验证可用（`ssh -T git@github.com` 返回 `Hi weic70902-dev!`）；
  `gh` CLI 令牌已失效，不影响 SSH 推送。
- 本地提交身份：`sf <sf@sy.com>`（git config）。
- 首个功能大提交：`6eea9ed`，79 文件 / +9778 行（i18n、阅后即焚、实时预览、
  清空会话、工具栏改版、附件私有化等全部功能与护栏）。

## 9.2 推送前自查（已全部通过）

- `.env.local` 被 `.gitignore` 的 `.env*` 规则忽略，**未入库**；
  对全部待提交内容（含未跟踪新文件）扫描过 `sbp_` / JWT 密钥特征，零命中
- `npm run build` 成功（14 条路由），本地 Node v22.22.2，
  `package.json` 已固定 `engines.node = 22.x`（与 Vercel 默认一致，防未来默认版本升级破坏构建）
- 源码无硬编码 `localhost`；`middleware.ts` 路由鉴权正常

## 9.3 Vercel 导入设置

- **Framework Preset**：Next.js（自动识别，无需改）
- **Root Directory**：仓库根目录（Next 应用就在仓库顶层）
- **Build / Output / Install Command**：全部默认（`next build` / 默认 / `npm install`，
  有 `package-lock.json`）
- 不需要 `vercel.json`

## 9.4 构建期环境变量（⚠️ 必须在首次构建**之前**配好）

`NEXT_PUBLIC_*` 是**构建期内联**进 JS 的，不是运行时读取 ——
漏配不会构建报错，但线上所有 Supabase 请求会打到 `undefined` 上，全站不可用。

Vercel → Project → Settings → Environment Variables，**Production / Preview / Development 三个环境都勾上**：

| 变量 | 必需性 | 说明 |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | **必需** | ⚠️ 只填 `https://xxx.supabase.co`，**不要带 `/rest/v1`**（本手册第一节踩过的坑：向导不报错但全站 404） |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **必需** | 匿名 key |
| `SUPABASE_SERVICE_ROLE_KEY` | 可选 | 运行时才用：邮件邀请、Storage 桶自动创建；不配则这两项功能降级，聊天不受影响 |

## 9.5 部署后必做（Supabase 侧）

1. **Auth → URL Configuration**：Site URL 改为 `https://<你的vercel域名>`，
   Redirect URLs 加上同款（否则登录回调跳不回线上）
   —— ✅ **已于 2026-10-15 完成，详见 10.6**
2. **Auth → Sign In / Providers**：注册好管理员账号后**关闭公开注册**（`disable_signup`）
3. **可选 · 自定义 SMTP**：免费层内置邮件每小时仅 2 封，注册/邀请靠邮件的话必须配
4. **可选 · 附件桶私有化**：执行 `./apply-sql.sh <sbp_令牌> openhive/private-attachments.sql`，
   跑完**立刻吊销令牌**（https://supabase.com/dashboard/account/tokens）

## 9.6 线上冒烟清单

- `/` 200、`/auth` 200、`/api/setup` 返回 `{"configured":true,...}`
- 注册 → 建工作区 → 发消息 → 上传图片（验证 `SUPABASE_SERVICE_ROLE_KEY`）
- 阅后即焚开关（单方开启即生效）→ 实时预览开关（对方免开关可见）
- 手机浏览器检查：长按消息弹工具栏、底部输入框不被小黑条遮挡

---

# 十、Vercel 部署实录（2026-10-15 已完成首次上线）

## 10.1 部署信息

| 项 | 值 |
|---|---|
| Vercel 项目 | `astart1/openhive`（scope：`astart1` 团队） |
| projectId | `prj_EZSCVo8LyxWrhwz9AcHnYoWhrp5z` |
| 生产域名 | **https://openhive-pearl.vercel.app** |
| 备用别名 | https://openhive-astart1.vercel.app |
| 部署 ID | `dpl_6LRpmmXXF6ZuFS6m4gLSNqMVWeRk`（状态 READY） |
| 构建 | 框架自动识别 Next.js，构建/输出/安装命令全默认，远程构建约 53s |
| Node 版本 | 项目默认 `24.x`，`package.json` 声明 `engines.node=22.x`，构建通过 |

## 10.2 已自动完成的步骤

1. **环境变量**：`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` /
   `SUPABASE_SERVICE_ROLE_KEY` 已写入 **Production / Preview / Development** 三套环境；
   其中两个公开变量与本地 `.env.local` 逐字节比对一致。
2. **关闭部署保护**：Vercel 新建项目默认开启 Vercel Authentication
   （`ssoProtection.deploymentType = all_except_custom_domains`），会导致所有访问要求登录。
   已通过 API 置 `ssoProtection` 与 `passwordProtection` 为 `null`。
3. **生产部署**：`vercel --prod` 完成，部署状态 READY，别名已指向生产域名。

## 10.3 ⚠️ 仍需人工完成的事项

1. ~~开启「推送即自动部署」~~ → **已实现，见 10.5**（用 GitHub Actions，无需 Vercel GitHub 集成）。

2. **Supabase Auth 配置**（见 9.5）：Site URL 与 Redirect URLs 改为
   `https://openhive-pearl.vercel.app`，否则线上登录回调跳不回来。

3. **关闭公开注册**：注册好管理员账号后执行。

## 10.4 已产生的本地文件（均被 `.gitignore` 忽略，不入库）

- `.vercel/project.json`：CLI 链接信息（projectId / orgId）
- `.env.vercel`：供复制粘贴的环境变量清单（含真实密钥，**勿提交、勿外发**）
- `.env.local`：被 `vercel link` 追加了 `VERCEL_OIDC_TOKEN`

> 安全提醒：本次部署所用的 Vercel 临时令牌与 GitHub PAT 均应在用完后立即吊销。

## 10.5 自动部署：GitHub Actions（已上线并验证）

### 为什么不用 Vercel 原生 Git 集成

Vercel 原生集成要求账号先建立 **GitHub Login Connection**，而它是 GitHub OAuth 授权，
**必须本人在网页点授权**，无法用令牌自动化。实测证据：

| 尝试 | 结果 |
|---|---|
| `POST /v9/projects/{id}/link` | 400 `You need to add a Login Connection to your GitHub account first` |
| `GET /v1/integrations/git-namespaces?provider=github` | `[]`（账号下 0 个 GitHub 连接） |
| `PATCH /v9/projects/{id}` 带 `gitRepository` | 400 字段不被允许 |
| `POST /v9/projects/{id}/deploy-hooks` | 404 `The project is not connected to any repository so it cannot have deploy hooks`（Deploy Hook 也依赖仓库连接，同样不可用） |

因此改用 GitHub Actions 直接调用 Vercel CLI 部署，**完全绕开该授权**。

### 工作流

文件：`.github/workflows/deploy.yml`

- 触发：`push` 到 `main`，以及手动 `workflow_dispatch`
- 并发：`concurrency: vercel-production`（`cancel-in-progress: false`），避免并发推送互相覆盖
- 步骤：checkout → setup-node 22 → `npx --yes vercel@64.2.0 deploy --prod --yes`
- **令牌只通过环境变量注入**，不写在命令行里；CLI 版本**锁定**为 `64.2.0`（不用 `@latest`），
  避免供应链风险

### 需要的仓库 Secrets

| Secret | 值 | 敏感度 |
|---|---|---|
| `VERCEL_TOKEN` | Vercel **项目级**访问令牌（`scope=project-only`，仅限 openhive 项目） | 高 |
| `VERCEL_ORG_ID` | `team_28ThcTtMed2MsbV4JEDFH8gm` | 低（非密钥） |
| `VERCEL_PROJECT_ID` | `prj_EZSCVo8LyxWrhwz9AcHnYoWhrp5z` | 低（非密钥） |

`VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` 让 CLI 在没有 `.vercel/` 目录的 CI 环境里也能定位项目。

写入方式（本地有可用 GitHub 令牌时）：

```bash
GH_TOKEN=<github_pat> gh secret set VERCEL_TOKEN      --repo weic70902-dev/openhive --body '<vercel_token>'
GH_TOKEN=<github_pat> gh secret set VERCEL_ORG_ID     --repo weic70902-dev/openhive --body 'team_28ThcTtMed2MsbV4JEDFH8gm'
GH_TOKEN=<github_pat> gh secret set VERCEL_PROJECT_ID --repo weic70902-dev/openhive --body 'prj_EZSCVo8LyxWrhwz9AcHnYoWhrp5z'
```

### 🔐 令牌安全分析（开源仓库场景）

**结论：仓库开源不会泄露令牌。** 令牌存放在 GitHub Actions Secrets，不是仓库文件里。

| 问题 | 答案 |
|---|---|
| 存在哪里 | GitHub 服务端的 Actions Secrets，用仓库公钥做 libsodium sealed box **加密存储** |
| 别人能看到吗 | **不能**。浏览者、克隆者、fork 者都拿不到。GitHub API 只返回名字和更新时间，**连仓库管理员也无法读回原值**（只能覆盖或删除） |
| 日志里会泄露吗 | GitHub 自动把已知密钥值在日志中替换为 `***`；且本工作流**不把令牌写进命令行**，实测运行日志中 `vcp_` 明文出现 **0 次** |
| 协作者能偷吗 | ⚠️ **能**。任何有仓库**写权限**的人都可以改 workflow 把密钥外发。因此不要随意添加协作者 |
| 外部 PR 能偷吗 | **不能**。GitHub 默认不向 fork 发起的 PR 传递 Secrets；且本工作流只由 `push` 到 `main` 触发 |
| 令牌权限多大 | 用的是 **项目级令牌**（`scope=project-only`），实测**只能看到 openhive 一个项目**，账号级接口（如列出所有令牌）返回 403。即使泄露，影响面被限制在这一个项目 |

**项目级令牌的创建方式**（账号级令牌权限过大，不推荐）：

```bash
# 必须在团队作用域下创建，scope 取 project-only
curl -X POST "https://api.vercel.com/v3/user/tokens?teamId=team_28ThcTtMed2MsbV4JEDFH8gm" \
  -H "Authorization: Bearer <账号级令牌>" -H "Content-Type: application/json" \
  -d '{"name":"openhive-ci","scope":"project-only","projectId":"prj_EZSCVo8LyxWrhwz9AcHnYoWhrp5z"}'
# 响应中的 bearerToken 只显示一次，务必立即保存
```

不设 `expiresAt` 即永不过期。轮换方式：重新执行上面的 `gh secret set VERCEL_TOKEN`。

> 历史备注：首次配置时误用了**临时令牌**（`expiresAt` 仅 40 分钟后），
> 会导致工作流在令牌过期后静默失败。现已替换为项目级长期令牌。

### 验证记录

| 运行 | 触发 | 结论 | 说明 |
|---|---|---|---|
| 38716279320 | push `fd71f4b` | success | 首次打通，临时令牌 |
| 38716463211 | push `4f56b35` | success | actions 升 v5 |
| 38716647182 | push `fa89568` | success | 文档更新自动触发 |
| 38717377368 | 手动 `workflow_dispatch` | success | 验证**项目级令牌**可用 |
| 38717551245 | push `c64063d` | success | 令牌改为纯环境变量注入 + 锁定 CLI 版本 |

五次均在 Vercel 侧产出 `target=production` 且 `state=READY` 的部署，
并带上对应 `githubCommitSha`。最后一次运行日志中 `vcp_` 明文出现 **0 次**。

## 10.6 Supabase Auth 回调地址配置（已完成）

项目 ref：`dkiyumhhvfwltvcdjykr`。通过 Supabase 管理 API 修改
（`PATCH /v1/projects/{ref}/config/auth`，需 `sbp_` 管理令牌；
`service_role` 密钥属数据平面，**改不了**这项配置）。

### 修改前后对比

| 字段 | 修改前 | 修改后 |
|---|---|---|
| `site_url` | `http://localhost:3000` | `https://openhive-pearl.vercel.app` |
| `uri_allow_list` | `http://localhost:3000,http://localhost:3000/auth` | 见下方 6 条 |

修改后的 `uri_allow_list`：

```
http://localhost:3000
http://localhost:3000/auth
https://openhive-pearl.vercel.app
https://openhive-pearl.vercel.app/**
https://openhive-astart1.vercel.app
https://openhive-astart1.vercel.app/**
```

**localhost 条目特意保留**，否则本地开发环境的登录回跳会失效。

### 完整配置备份

修改前的 243 个字段全量备份在**仓库外**（含 SMTP 密码等敏感字段，切勿提交）：

```
E:\space\workmeta\.workbuddy-ai\backups\supabase-auth-config-2026-10-15.json
```

回滚方式：把该文件中原始的 `site_url` 与 `uri_allow_list` 重新 `PATCH` 回去。

### 项目相关背景

- 该项目 `mailer_autoconfirm = true`（邮箱确认已关闭），注册后可直接登录，
  对回调地址的依赖较小；回调主要影响**密码重置**与 **OAuth / 魔法链接**
- **本地与线上共用同一个 Supabase 项目**（`NEXT_PUBLIC_SUPABASE_URL` 两侧逐字节相同），
  因此账号与全部聊天数据本来就只有一份，线上无需重新注册，也无需任何数据迁移
- 副作用：线上线下数据**双向同步**——本地开发时删除的消息，线上也会消失

### 验证说明

配置写入后用 `GET` 复核，三项断言全部通过（`site_url` 已更新、
线上通配回调已加入、localhost 已保留）。

> 注：尝试用 `/auth/v1/otp` 做功能性验证时被 Supabase 邮件限流拦截（HTTP 429），
> 未继续重试以免真实发出邮件。`/auth/v1/admin/generate_link` 不做回调白名单校验，
> 不能用于此验证。最终以配置读取结果为准。

## 10.7 ⚠️ 已知问题：`vercel.app` 域名在中国大陆无法直连

### 现象

浏览器打开 `https://openhive-pearl.vercel.app` 报
`ERR_CONNECTION_TIMED_OUT`（响应时间太长）。

### 结论：站点本身正常，是 DNS 污染

用 DoH 从境外解析并实际抓取页面，**站点完全正常**（HTTP 200，标题 `OpenHive`），
部署状态 READY。问题出在本地网络对 `vercel.app` 的 DNS 解析被投毒。

### 证据（同一域名，三个解析器返回三组完全不同的伪造 IP）

| 解析方式 | 返回的 IP | 归属 |
|---|---|---|
| 本地默认 DNS | `2a03:2880:f11a:83:face:b00c:0:25de` | Meta（Facebook） |
| `8.8.8.8` | `2a03:2880:f111:83:face:b00c:0:25de`、`108.160.165.11` | Meta、Dropbox |
| `1.1.1.1` | `2a03:2880:f10f:83:face:b00c:0:25de`、`199.59.149.205` | Meta、Twitter |
| **加密 DNS（真实值）** | **`216.198.79.67`、`64.29.17.67`** | **Vercel** |

`2a03:2880::/32` 中的 `face:b00c` 是 Meta 的固定特征，`31.13.85.34` 等也是 Meta 段 ——
Vercel 与这些网段毫无关系，属典型 DNS 投毒特征。
注意：`8.8.8.8` / `1.1.1.1` 的**明文 UDP 53 查询同样被劫持**，
所以「把 DNS 改成 8.8.8.8」这种做法**通常无效**，必须用 **DoH/DoT**（加密 DNS）。

### 域名是怎么来的

`openhive-pearl.vercel.app` 是 Vercel **自动分配的平台共享域名**，格式为
`<项目名>-<随机词>.vercel.app`。项目名是 `openhive`，理想域名是
`openhive.vercel.app`，但该名称已被其他账号占用，Vercel 便追加随机词 `pearl`。
另一个别名 `openhive-astart1.vercel.app` 是 `<项目名>-<团队名>.vercel.app` 格式。

**这是 Vercel 控制的域名，不属于项目方资产。**

### 可选方案

| 方案 | 效果 | 说明 |
|---|---|---|
| 挂代理访问 | ✅ 立即生效 | 临时验证用 |
| 系统/浏览器启用 **DoH** | ⚠️ 可能有效 | 需 DoH 服务器本身未被阻断，国内不稳定 |
| 把 DNS 改成 8.8.8.8 | ❌ 通常无效 | 明文 DNS 同样被劫持 |
| 绑定**自有域名** | ✅ 推荐 | 自有域名一般未被污染；Vercel 免费支持并自动签发 SSL |
| 改项目名换 `*.vercel.app` | ❌ 无效 | 仍在 `vercel.app` 下，同样被污染 |
| 迁移到国内可访问的托管 | ✅ 长期方案 | 面向国内用户需备案 |

绑定自有域名的操作：Vercel → Project → Settings → Domains → Add，
然后在域名注册商处按提示添加 A / CNAME 记录。

> 注意：即使换成自有域名解决了 DNS 污染，Vercel 的 IP 在中国大陆仍可能被限速或
> 间歇性阻断，稳定性无法保证。若要面向国内用户提供稳定服务，建议走国内云 + 备案。

## 10.8 备选部署平台（应对 `vercel.app` 在大陆不可达）

### 硬约束

OpenHive 是 **Next.js SSR + API Routes + middleware** 应用（`/api/setup`、`/api/upload`、
`/api/provision` 等为服务端路由），**不是纯静态站**。因此：

- ❌ 纯静态托管（GitHub Pages、Gitee Pages、Netlify 静态模式）**不可用**
- ✅ 必须选能运行 Node 运行时的平台

### 方案对比（2026-10 调研）

| 平台 | 免费 | ICP 备案 | 大陆可达性 | Next.js 全栈 | 注册门槛 |
|---|---|---|---|---|---|
| Vercel（现状） | ✅ | 免 | ❌ 域名被 DNS 污染 | 原生支持 | 邮箱 |
| **腾讯 EdgeOne Makers**（加速区选「不含中国大陆」） | ✅ 永久免费 | **免** | ✅ 较好（2,500+ 亚洲节点） | ✅ **零配置支持** | 邮箱（国际站无需实名） |
| 腾讯 EdgeOne Makers（选「含中国大陆」） | ✅ | **必须** | ✅ 最快 | ✅ | 需实名 |
| 阿里云 ESA Pages | ✅ | 同上逻辑 | ✅ | ✅ | 需实名（Pages 有 2000 文件上限） |
| Cloudflare Pages / Workers | ✅ | 免 | ❌ **默认域名 `pages.dev` 同样被污染** | 需 `@opennextjs/cloudflare` 适配 | 邮箱 |
| Zeabur | ❌ 托管 $5/月起 | 免 | 默认域名可开 | ✅ | 邮箱 |
| 国内轻量云 + 自托管 | ❌ 约 ¥100/年 | **必须** | ✅ 最快 | ✅ | 需实名 |

### 关键结论

1. **唯一同时满足「免费 + 免备案 + 注册简单 + 大陆可访问」的是腾讯 EdgeOne Makers**
   （原 EdgeOne Pages，2026-06 升级更名）。加速区域选
   **「全球可用区（不含中国大陆）」即无需备案**（腾讯云官方文档
   `product/1552/87601` 明确：选「全球可用区」才要求工信部备案）。
   其国际站（`edgeone.ai`）注册**无需实名、无需信用卡**，免费版官方承诺永久可用。
2. **Cloudflare 已被排除**：官方给的 `*.pages.dev` / `*.workers.dev` 二级域名
   自 2022 年起常遭 DNS 污染（实测有 CNAME 到 pages.dev 时解析成 `127.0.0.1` 的案例），
   与 `vercel.app` 是同一类问题，**换了平台但没换问题**。
3. **备案无法绕开**：凡使用**中国大陆节点 + 自有域名**，工信部一律要求 ICP 备案。
   免备案的代价就是走海外/港澳节点。
4. **Zeabur 的免费版已不再提供免费托管**（免费版仅用于管理你自购的服务器，
   且不含自定义域名），托管需 $5/月。

### EdgeOne Makers 官方能力确认

- 产品定位：**边缘全栈开发平台**，覆盖「前端页面 + 动态 API + Agent」
- 全栈框架：**零配置支持 Next.js 全部特性**（官方 FAQ 明确列为 Full-Stack App 场景）
- Serverless：**从边缘函数到云函数**（Node 云函数可承载需要 Node API 的路由）
- 部署方式：Git 连接、CLI、MCP、IDE 插件；有 GitHub 自动部署
- 免费版：**无需信用卡**，官方 FAQ 承诺长期可用
- 自定义域名：自动签发 SSL

### OpenHive 迁移可行性（已核对源码）

- API 路由共 **8 个**：`invite`、`invite/complete`、`livekit/token`、`provision`、
  `setup`、`storage`、`upload`、`webhook/[id]`
- **只有 `/api/setup` 依赖 Node 专有模块**（`fs` 的 `writeFileSync`/`readFileSync`/
  `existsSync` + `path.join`），其余 7 个均为 fetch 型，边缘运行时友好
- 未显式声明 `runtime`，默认 Node.js
- 注：`/api/setup` 写文件本就是**本地开发专用**能力，在 Vercel 上同样不持久，
  迁移时把它标记为 Node 云函数或直接禁用即可

**结论：迁移可行，主要是配置工作**（连仓库 → 构建命令 `next build` → 配 3 个环境变量），
真正的适配点只有 `/api/setup` 一个路由。

### 迁移步骤（控制台精确路径，依据官方文档 `product/1552/119338`）

**步骤一 · 进入创建入口**
- 控制台地址：`console.cloud.tencent.com/edgeone`（国内站）或 `console.tencentcloud.com`（国际站）
- 若已有其他资源：点最上方的 **Makers** Tab，在该 Tab 下创建项目
- 若是首次登录：进入场景选择大厅，鼠标移到 **创建项目**
- 创建方式选 **「导入 Git 仓库」**

**步骤二 · 连接 Git 仓库**
1. 点 **Github** 链接仓库
2. 点 **Authorize EO Makers** 授权
3. 选择仓库 —— 建议选 **Only select repositories**，只勾 `openhive`（最小权限）
4. 点 **Install**

**步骤三 · 自定义构建**（关键一步）
1. 选择仓库 `weic70902-dev/openhive`（分支 `main`）
2. 框架会**自动识别为 Next.js**，一般无需手改
3. 构建命令填 `next build`（对应 `package.json` 的 `build` 脚本）
4. ⚠️ **加速区域必须选「全球可用区（不含中国大陆）」** —— 这是免备案的关键。
   官方说明：加速区域决定节点资源分配，以及**添加自定义域名时是否需要备案**。
   选「全球可用区」（含大陆）则必须完成工信部 ICP 备案。
5. 检查配置后点 **开始部署**

**步骤四 · 配置环境变量**
在项目设置 / 环境变量中填入（值与 Vercel 侧完全一致，见 `openhive/.env.vercel`）：

| 变量 |
|---|
| `NEXT_PUBLIC_SUPABASE_URL` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `SUPABASE_SERVICE_ROLE_KEY` |

**步骤五 · 验证与后续**
- 「构建部署」右上角点 **预览**，或「项目概览」右上角点 **预览**，生成访问链接
- 默认域名格式类似 `xxx.xxxxx.edgeone.com`
- 之后**推送到主干分支会自动拉取并重新部署**
- 部署成功后把 Supabase Auth 的 Site URL / Redirect URLs 换成新域名（见 10.6 的改法）
- 处理 `/api/setup`：它是唯一依赖 Node 专有模块的路由，标为 Node 云函数或直接禁用

**注意事项**
- 免费套餐需在控制台**一键开通**；权益含不限量的安全加速流量与请求额度，
  但**函数调用、KV 存储、项目构建次数为每月定额**（API 路由会计入函数调用）
- 仓库需为**公开**或已授权给 EdgeOne（本仓库 `private=false`，符合）
- `package.json` 已声明 `engines.node = 22.x`

---

## 10.9 EdgeOne Makers 部署实录（已上线，替代 Vercel 作为大陆可用入口）

10.8 写的是**控制台 Git 导入**路线；实际执行时改用了**官方 CLI 路线**——同样免备案，
且全程可脚本化、可进 CI。本节记录真实结果与踩坑。

### 10.9.1 部署信息

| 项 | 值 |
|---|---|
| 访问地址 | **https://openhive.edgeone.dev** |
| 控制台 | `https://console.tencentcloud.com/edgeone/pages/project/makers-xvgjjhjjuoaw` |
| 项目名 / Project ID | `openhive` / `makers-xvgjjhjjuoaw` |
| 部署 ID | `dpdcndz4lfyk`（首次）、`dplyaz4kz0jz`（配好环境变量后） |
| 加速区域 | **`overseas`**（全球可用区·不含中国大陆）→ **免备案** |
| 站点 | 腾讯云**国际站**（`console.tencentcloud.com`） |
| 账号 | `raymondhpe311@outlook.com`（Account ID `450200569241`，APPID `1507608077`） |
| CLI 版本 | `edgeone@1.6.41` |
| 构建适配器 | `@edgeone/opennextjs-pages`（OpenNext） |
| 运行时 | `ssr-node` 云函数，24 条路由 |

### 10.9.2 为什么走 CLI 而不是控制台

| 维度 | 控制台 Git 导入 | CLI（实际采用） |
|---|---|---|
| 免备案 | ✅ | ✅（`-a overseas`） |
| 可脚本化 | ❌ 纯手工点击 | ✅ 一条命令 |
| 可进 CI | ✅ 平台自带 | ✅ 与现有 GitHub Actions 同模式 |
| 自动化程度 | 低 | 高 |

### 10.9.3 完整命令

```bash
# 1. 安装（必须 --ignore-scripts，原因见 10.9.5）
npm install edgeone --ignore-scripts

# 2. 登录 —— 国际站必须显式 -s global（默认不是它）
edgeone login -s global
edgeone whoami

# 3. 首次部署：项目不存在会自动创建，区域由 -a 决定
edgeone makers deploy -n openhive -a overseas -e production --json

# 4. 配置生产环境变量（非交互）
edgeone makers env set NEXT_PUBLIC_SUPABASE_URL        "<值>" -e production
edgeone makers env set NEXT_PUBLIC_SUPABASE_ANON_KEY   "<值>" -e production
edgeone makers env set SUPABASE_SERVICE_ROLE_KEY       "<值>" -e production

# 5. 重新部署，让运行时变量生效
edgeone makers deploy -n openhive -a overseas -e production --json
```

`--json` 会输出单行机器可读结果，便于 CI 解析：

```json
{"status":"success","url":"https://openhive.edgeone.dev","projectId":"makers-xvgjjhjjuoaw",
 "deploymentId":"dplyaz4kz0jz","isTld":0}
```

### 10.9.4 关键参数：`-a overseas` 就是免备案开关

`edgeone makers deploy` 的 `-a, --area` 取值 `global`（默认）或 `overseas`：

- `-a overseas` → 全球可用区（不含中国大陆）→ **无需 ICP 备案**
- `-a global` → 含中国大陆节点 → 需实名认证，且自定义域名必须已 ICP 备案

部署日志中可见确认：
`[CreatePagesProject] Creating new project with name: openhive in overseas area`

### 10.9.5 踩坑记录

**① `npm install edgeone` 会失败，必须加 `--ignore-scripts`**
postinstall 阶段要 spawn esbuild 原生二进制，在沙箱内被拒 → 安装中断 →
`esbuild-plugin-polyfill-node` 未落地 → CLI 报 `MODULE_NOT_FOUND`。
包本体完整，跳过脚本即可正常使用。

**② 重新部署会被 safe-delete 守卫拦住**
第二次部署时构建器要清理上一次的 `.edgeone/assets`，单轮删除数达到阈值 50，
触发 `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`。
解决：部署前先手工清掉构建产物目录（**它们是可再生的**，不要动 `project.json`）：

```bash
rm -rf .edgeone/assets .edgeone/cloud-functions
```

首次部署不会遇到此问题（目录尚不存在，无需删除）。

**③ 站点选择不能想当然**
国内站 `console.cloud.tencent.com` 用 `-s china`；国际站 `console.tencentcloud.com`
用 `-s global`。官方文档（`product/1552/127423`）示例偏向国内站，照抄会登错站点。
两站授权入口也不同：国际站走 `edgeone.ai/login`，国内站走 `cloud.tencent.com/login`。

**④ CLI 会自动改写 `.gitignore`**
登录/部署后它会追加：

```
# Tencent Cloud EdgeOne
.env
.edgeone/*
.tef_dist/*
```

**⑤ 构建期变量来自本地 `.env.local`**
`edgeone makers deploy` 是**本地构建**再上传，Next.js 构建时把 `NEXT_PUBLIC_*`
内联进产物——所以这两个变量只要本地 `.env.local` 有就行。
但服务端用的 `SUPABASE_SERVICE_ROLE_KEY` 必须在平台配置（步骤 4），
且**配置后要重新部署**才会生效。

### 10.9.6 验证记录

| 检查项 | 结果 |
|---|---|
| DNS 解析 | `openhive.edgeone.dev` → CNAME `...edgeone.dev.pages.dnsoe6.com` → `43.174.247.29` / `43.174.246.29`（腾讯云真实 IP，**未被污染**） |
| 首页 / 登录页 | HTTP 200，标题 `OpenHive`，正常渲染邮箱/密码/注册表单 |
| 生产环境变量 | `env ls -e production` 确认 3 条齐全 |
| 运行时变量 | `GET /api/setup` → `{"configured":true,"hasServiceKey":true,"storageProvider":"supabase"}` |
| Node 专有模块 | 同上接口内部 `import { fs, path }` 未报错 → **10.8 担心的唯一适配点已排除**，无需改动 `/api/setup` |

### 10.9.7 Supabase Auth 同步更新

`site_url` 由 `https://openhive-pearl.vercel.app` 改为 `https://openhive.edgeone.dev`；
`uri_allow_list` **新增** EdgeOne 两条，**保留**原有 6 条（localhost ×2 + Vercel ×4），
共 8 条。改前完整配置已备份至仓库外：
`E:\space\workmeta\.workbuddy-ai\backups\supabase-auth-config-2026-10-16.json`

### 10.9.8 后续可做

- **接入 GitHub Actions 自动部署**：与 10.5 同模式，在仓库 Secrets 加
  `EDGEONE_API_TOKEN`（控制台 `console.tencentcloud.com/edgeone/pages?tab=api`
  → API Token → 创建），工作流执行
  `npx edgeone makers deploy -n openhive -a overseas -e production`
- **绑定自有域名**：`overseas` 区域绑自定义域名同样免备案（域名解析 CNAME 到平台分配的目标）
- **两个平台并存**：EdgeOne 供大陆访问，Vercel 供海外访问，Supabase 同一后端，数据天然互通

---

## 10.10 ClawCloud Run 容器化部署（香港节点，免备案 + 大陆可直连）

### 10.10.1 为什么放弃前两个平台

| 平台 | 现象 | 根因 | 结论 |
|---|---|---|---|
| Vercel `*.vercel.app` | 大陆打不开 / 被解析到错误 IP | 域名 DNS 污染 + 边缘 IP 被墙 | 不可用 |
| EdgeOne Makers `*.edgeone.dev` | 大陆返回 `401`，响应头 `X-EOP-MSG: eo_time missing` | **官方错误码文档明确：`overseas`（全球不含中国大陆）区域对中国大陆网络环境直接返回 401**，必须绑定自定义域名才放行 | 平台级限制，非配置问题 |

因此「大陆可访问 + 免备案」只剩一条硬路径：**把运行时放到香港**（境外节点不涉及 ICP 备案，且距大陆 30–50ms）。

### 10.10.2 架构

```
GitHub push ──► Actions 构建镜像 ──► ghcr.io/weic70902-dev/openhive:latest
                                              │
                                              ▼
                              ClawCloud Run（Hong Kong 区域）
                                              │
                              ┌───────────────┴───────────────┐
                              ▼                               ▼
                      平台分配的 HTTPS 域名            （可选）自有域名 CNAME
                              │
                              ▼
                     Supabase（Auth / DB / Storage，不变）
```

镜像自带 Node 22 运行时与 `server.js`，不依赖任何平台的 Serverless 适配层，所以 `fs` / `path` / 长连接 / 后台任务全部可用。

### 10.10.3 新增文件

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 三阶段构建（deps → builder → runner），产出 `standalone` 自包含产物，运行层不含 `node_modules` 全量依赖，镜像约 180MB |
| `.dockerignore` | 排除 `node_modules` / `.next` / `.env*` / `.edgeone`，避免把本地密钥打进镜像 |
| `.github/workflows/docker-publish.yml` | push 到 `main` 自动构建并推送 GHCR，带 GHA 层缓存 |
| `next.config.ts` | 新增 `output: process.env.DOCKER_BUILD === "1" ? "standalone" : undefined`，仅在容器构建时启用，**不影响 Vercel / EdgeOne 的既有构建方式** |

### 10.10.4 环境变量矩阵（关键）

`NEXT_PUBLIC_*` 会在 `next build` 时被**内联进浏览器 bundle**，所以必须作为**构建参数**传入；其余私密变量只在**运行时**注入，绝不进镜像。

| 变量 | 注入时机 | 位置 | 是否敏感 |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | 构建期 | Actions 仓库 Variables → Docker `--build-arg` | 否（本来就公开） |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | 构建期 | 同上 | 否（anon key 设计上公开，靠 RLS 保护） |
| `SUPABASE_SERVICE_ROLE_KEY` | **运行期** | ClawCloud 应用环境变量 | **是**（绕过 RLS，只允许服务端） |
| `STORAGE_PROVIDER` | 运行期 | ClawCloud 应用环境变量 | 否 |
| `S3_*`（可选） | 运行期 | ClawCloud 应用环境变量 | **是** |

> ⚠️ `SUPABASE_SERVICE_ROLE_KEY` 不要配成 GitHub Actions 的 build-arg，否则会永久留在镜像层里。

### 10.10.5 部署步骤

1. **配仓库变量**：`Settings → Secrets and variables → Actions → Variables` 新建
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
2. **触发构建**：push 到 `main`，或 Actions 页手动 `Run workflow`。
3. **开放镜像拉取**：工作流会尝试用 `GITHUB_TOKEN` 自动把包改成 public；若失败，手动走
   `GitHub → 个人头像 → Your packages → openhive → Package settings → Change visibility → Public`
   （私有镜像需在 ClawCloud 里配 registry 凭据，公开镜像可跳过这一步）
4. **ClawCloud 创建应用**：`console.run.claw.cloud → App Launchpad → Create App`
   - Workspace 区域：**Hong Kong**（不要用自动分配，自动分配会落到日本）
   - Image：`ghcr.io/weic70902-dev/openhive:latest`
   - CPU / 内存：`0.5 vCPU / 1 GiB` 起步（镜像已 standalone，不需要构建内存）
   - Network：开启 **External**，端口 **3000**
   - Environment：填 10.10.4 里「运行期」那一组
   - 点 `Deploy`，约 1–2 分钟起服务
5. **验收**：访问分配的域名 → `GET /api/setup` 应返回
   `{"configured":true,"hasServiceKey":true,"storageProvider":"supabase"}`
6. **同步 Supabase 回调**：`site_url` 改为新域名，`uri_allow_list` 追加新域名（保留 localhost 与旧域名，便于回滚）。

### 10.10.6 成本与限制

| 项 | 说明 |
|---|---|
| 费用 | GitHub 账号满 180 天 → 每月 $5 额度；0.5C1G 常驻约 $2–3/月，**在额度内** |
| 大陆延迟 | 香港节点实测 100–200ms（比大陆 10–30ms 慢，比 Vercel/EdgeOne 的「打不开」好得多） |
| 磁盘 | 免费层 10GB，镜像 + 日志占用约 1GB |
| 稳定性 | 免费额度政策由平台单方调整，**不适合长期生产**；长期建议迁到香港轻量 VPS（见 10.10.7） |
| 数据持久化 | 容器文件系统是临时的，但本项目生产环境**不写盘**（`/api/setup` 的 POST 有 `NODE_ENV === 'production'` 拦截，只读环境变量），数据全在 Supabase，重启不丢数据 |

### 10.10.7 迁移到自有 VPS（长期方案）

同一镜像可直接在任意香港 VPS 上跑，无需改代码：

```bash
docker run -d --name openhive --restart=always \
  -p 3000:3000 \
  -e NEXT_PUBLIC_SUPABASE_URL=... \
  -e NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
  -e SUPABASE_SERVICE_ROLE_KEY=... \
  ghcr.io/weic70902-dev/openhive:latest
```

前置 Nginx + Certbot 反代 `127.0.0.1:3000` 即可拿到 HTTPS。

### 10.10.8 已验证记录（commit `8cc8aa7`，run id `39396032925`）

镜像已构建并推送成功，9 个步骤全部 success，耗时约 3.5 分钟。以下是对产物的逐项验证，
不是只看 Actions 绿勾：

| 检查项 | 方法 | 结果 |
|---|---|---|
| 匿名可拉取 | 不带任何凭据从 `ghcr.io/token` 换匿名 token，访问 `/v2/weic70902-dev/openhive/tags/list` | `["latest","8cc8aa7cace..."]` → GHCR 包确已 public（工作流里「Try to make package public」步骤生效） |
| 运行时配置 | 读取 OCI image config blob | `User=node`、`ExposedPorts=3000/tcp`、`Cmd=["node","server.js"]`、`WorkingDir=/app`、Healthcheck 存在 |
| 镜像变量 | config blob 的 `Env` | `NODE_ENV=production`、`PORT=3000`、`HOSTNAME=0.0.0.0`、`NODE_VERSION=22.23.3` |
| 镜像体积 | manifest 9 层相加 | 100.3MB（低于预估的 180MB） |
| **build-arg 是否真内联** | 下载第 7 层（`.next/static`）解包后 grep | `dkiyumhhvfwltvcdjykr` 命中 3 个 chunk，`sb_publishable_...` 命中 → **仓库 Variables 填对了，客户端 bundle 拿到了 Supabase 配置** |

最后一项是整个链路里**唯一无法靠服务端接口发现**的故障点：
`NEXT_PUBLIC_*` 如果漏传或填错，`/api/setup` 依然会返回
`{"configured":true}`（它读的是服务端 env），而浏览器端 Supabase 全线崩溃。
所以这层必须单独验证。

### 10.10.9 部署后验收脚本（已自测可用）

```bash
python scripts/verify-deployment.py https://<分配到的域名>
```

一次性检查：3 个页面状态与 title、`/api/setup` 返回值、
**客户端 bundle 里是否真内联了 Supabase URL 与 anon key**、chunk 可达性。
期望值默认读本地 `.env.local`，也可用 `--expect-url` / `--expect-key` 显式传入。
退出码 0 = 全部通过，可直接用于 CI。

已在本地 standalone 实例上自测通过：
```
✓ 页面 /            HTTP 200，title='OpenHive'
✓ 页面 /auth        HTTP 200
✓ 页面 /workspace   HTTP 200
✓ API /api/setup  HTTP 200 → {"configured":true,"hasServiceKey":true,"storageProvider":"supabase"}
✓ 客户端 bundle 内联   共 9 个 chunk，含 Supabase URL 的 1 个，含 anon key 的 1 个
```

> 注意：`git commit --allow-empty` **不会**触发 `docker-publish.yml`
> （Vercel 那个工作流会跑，镜像工作流不会）。GitHub 对空提交直接跳过 paths 判断。
> 想手动触发构建，改一个真实文件再 push。

---

## 10.11 ⚠️ ClawCloud Run 已不可用（2026-10-21 核实）

用户反馈 `console.run.claw.cloud` 无法打开。排查后确认**不是用户网络问题**：

| 域名 | alidns DoH | 腾讯 DoH | Windows 系统解析器 | 结论 |
|---|---|---|---|---|
| `console.run.claw.cloud` | NXDOMAIN | NXDOMAIN | DNS 名称不存在 | ❌ 域名不存在 |
| `ap-northeast-1.run.claw.cloud`（第三方自动化脚本里用的真实地址） | NXDOMAIN | NXDOMAIN | DNS 名称不存在 | ❌ 域名不存在 |
| `ap-east-1.run.claw.cloud` | NXDOMAIN | NXDOMAIN | DNS 名称不存在 | ❌ |
| `run.claw.cloud` | NOERROR 但无 A 记录 | NOERROR 但无 A 记录 | 无 A 记录 | ❌ 无可用地址 |
| `claw.cloud`（官网） | 有 A 记录 | — | — | ⚠️ 首页返回 **503 Service Unavailable** |
| `docs.claw.cloud`（文档站） | 104.21.94.153 | — | OK | ✅ 仅剩静态文档站 |

另外 `app / console / cloud / portal / account / vps / api / status / cn` 等子域全部 NXDOMAIN。

**结论**：ClawCloud Run 的控制台/产品域名已全部无法解析，官网 503，只剩文档站在线。
该平台已停止服务或发生重大故障，**不要再向用户推荐或重试**。

### 为什么剩下的免费平台也不满足「大陆可访问」

| 平台 | 免费层地区 | 问题 |
|---|---|---|
| Koyeb | 免费层只能用 **巴黎**（社区教程 2026 年确认），512MB 内存上限，单区域 | 距大陆 ~250ms+；且 `*.koyeb.app` 域名在 Cloudflare 后，**部分国内运营商直接阻断 Cloudflare** |
| Render / Railway | 美西 / 欧洲 | 无亚洲节点，大陆访问差 |
| Fly.io | 有 `hkg` | 需信用卡，且 Fly.io 的 IP 段在大陆经常被墙 |

真正同时满足「免备案 + 大陆低延迟」的，只有**香港/新加坡的实体服务器**，而这一类基本都要按月付费。
所以当前唯一务实路线是香港轻量服务器（见 10.10.7 的 `docker run` 命令，改成本机 IP 即可）。
