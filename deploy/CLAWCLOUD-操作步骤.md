# ClawCloud 香港节点部署 — 一步步操作清单

> 按顺序做完约 10 分钟。镜像已构建、公开、验证通过，你只需在控制台点几下。
> 全部做完后，把域名发我，我接着做 Supabase 回调切换 + 大陆多点测速。

---

## 第 0 步：确认前置条件（1 分钟）

| 条件 | 状态 |
|---|---|
| GitHub 账号注册时间 **> 180 天** | 决定每月有没有 $5 免费额度。不满 180 天仍有一次性 $5，用完需充值 |
| 镜像 `ghcr.io/weic70902-dev/openhive:latest` | ✅ 已构建并设为 public |

---

## 第 1 步：打开控制台并用 GitHub 登录

地址：**https://console.run.claw.cloud**

（打不开就试 https://run.claw.cloud）

1. 点 **Get started for free** 或 **Sign in with GitHub**
2. 在 GitHub 授权页点 **Authorize**
3. 如果提示没有额度，说明你的 GitHub 账号不满 180 天 —— 依然可以继续（有一次性的 $5 余额）

---

## 第 2 步：创建 Workspace，⚠️ 区域选 **Hong Kong**

第一次进入会要求建 Workspace。

- **区域（Region）务必手动选 `Hong Kong`（中国香港）**
- ⚠️ **不要用「自动/就近分配」** —— 大陆用户会被分到日本，延迟和稳定性都差一截
- ⚠️ **这个选项建完就不能改**，选错了只能删掉 workspace 重建

| 可选区域 | 是否推荐 |
|---|---|
| **Hong Kong** | ✅ 选这个 |
| Tokyo / Singapore | 备选 |
| 美东 / 美西 / 欧洲 | ❌ 大陆访问太慢 |

---

## 第 3 步：Create App（最关键的一步）

左侧菜单 **App Launchpad → Create App**，按下表填：

| 字段 | 填什么 | 说明 |
|---|---|---|
| App Name | `openhive` | 随便取，但不能和其他应用重名 |
| **Image** | `ghcr.io/weic70902-dev/openhive:latest` | **一字不差照抄**。前面不要加 `docker.io/` |
| CPU | `0.5` vCPU | 别再调大，免费额度不够（见第 7 步费用测算） |
| Memory | `1` GiB | standalone 镜像不需要构建内存，1G 足够 |
| Storage | `1` GB | 本项目生产环境**不写盘**，数据全在 Supabase，1G 足够。写大了会超出免费额度 |
| Replicas | `1` | 单副本即可 |

### 网络（Network）—— 这步错了服务起得来但打不开

1. 勾选 **Enable Internet Access**（开启外部访问）
2. **端口填 `3000`**（与镜像 `EXPOSE 3000` 一致）
3. 如果看到 Protocol 选 HTTPS/HTTP，选 **HTTPS**

---

## 第 4 步：填环境变量（4 条）

在 Create App 页面的 **Environment Variables / Environment** 区域，点 Add，一条一条加。

我已经帮你在本地生成了现成的文件：
**`E:\space\workmeta\openhive\deploy\clawcloud.env`**
打开它，里面正好 4 行 `KEY=VALUE` 格式，逐行复制即可。

对照表（确认键名没拼错）：

| # | KEY | VALUE 从哪来 | 能不能填错 |
|---|---|---|---|
| 1 | `NEXT_PUBLIC_SUPABASE_URL` | `deploy/clawcloud.env` 第 1 行 | ❌ 错了前端连不上 Supabase |
| 2 | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `deploy/clawcloud.env` 第 2 行 | ❌ 同上 |
| 3 | `SUPABASE_SERVICE_ROLE_KEY` | `deploy/clawcloud.env` 第 3 行 | ⚠️ **这是最高权限密钥**，只在服务端用，绝不填错成别的 |
| 4 | `STORAGE_PROVIDER` | `supabase` | 固定值 |

> ⚠️ `NEXT_PUBLIC_*` 在镜像构建时已经打进浏览器 bundle 了，这里再配一遍只是冗余保险；
> **真正必须在运行时配的是 `SUPABASE_SERVICE_ROLE_KEY`**（邀请邮件、文件上传都靠它）。
> 漏配的后果：网页能打开，但发邀请/上传文件会失败。

---

## 第 5 步：Deploy

点 **Deploy / Create**，等约 **1–2 分钟**。

看状态变成 **Running / Active** 后，记下应用详情页里分配的域名（形如
`https://xxx-xxx.run.claw.cloud` 或类似）。

---

## 第 6 步：自测（30 秒）

把域名发给我之前，你可以先自己确认一下：

```bash
cd E:\space\workmeta\openhive
python scripts/verify-deployment.py https://你的域名
```

期望看到 5 项全 ✓。其中「客户端 bundle 内联」这项通过，说明前端真的连得上 Supabase。

---

## 第 7 步：费用测算（为什么别把配置调大）

平台计费：**vCPU $4/月、RAM $2/GB/月、磁盘 $0.12/GB/月、流量 $0.05/GB**

按第 3 步的配置：

| 资源 | 用量 | 费用/月 |
|---|---|---|
| vCPU | 0.5 | $2.00 |
| RAM | 1 GB | $2.00 |
| 磁盘 | 1 GB | $0.12 |
| 流量 | 10 GB 内（免费额度） | $0 |
| **合计** | | **≈ $4.12** |

✅ 落在每月 $5 免费额度内，**实际支出 0 元**。

⚠️ 如果把内存调到 2 GB，合计就到 $6.12，**会开始扣真实费用**。所以严格按上面的数字填。

另注意：免费层每月只有 **10 GB 流量**。本项目是一个聊天/协作应用，正常测试用远远够；如果之后要分享给很多人用，会超，需要提前规划（或迁到香港 VPS）。

---

## 常见问题

| 现象 | 原因 / 解法 |
|---|---|
| 域名能打开但一片白 / 控制台报 Supabase 错误 | 镜像里的 `NEXT_PUBLIC_*` 没配上。工作流的「Check build args」步骤必须为 success —— 当前是 success |
| 直接 502 / 连接被拒 | 漏了 **Enable Internet Access**，或端口不是 3000 |
| 拉镜像失败 `unauthorized` / `manifest unknown` | 包不是 public。当前已是 public；若复现，去 GitHub → 头像 → Your packages → openhive → Package settings → Public |
| 部署后重启，数据没了 | 正常。本项目**所有数据都在 Supabase**，容器只是无状态运行时，随便重启 |
| 想换区域 | workspace 区域不可改，只能重建 —— 所以第 2 步才强调必须一次选对 |

---

## 你做完后，交给我做的事

1. 跑验收脚本，出 5 项报告
2. 改 Supabase Auth：`site_url` → 新域名，`uri_allow_list` 追加新域名（保留 localhost + Vercel + EdgeOne 便于回滚）
3. 全国多点测速（电信/联通/移动，多地）
4. 超过 $2 的成本预警线我会在报告里标出来
