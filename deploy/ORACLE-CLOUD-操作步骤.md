# Oracle Cloud 免费层部署 — 一步步操作清单

> 目标：**0 元**拿到一台亚洲区域的 Linux 服务器，跑我们的 OpenHive 镜像。
> 免费额度是**永久**的（不是试用），但有几个坑，按本清单走能避开 90%。

---

## 开始前必须知道的 4 件事

| # | 事项 | 说明 |
|---|---|---|
| 1 | **要信用卡** | 注册时绑 Visa / Mastercard 做身份验证，**不扣费**。国内的 Visa/Mastercard 可以用 |
| 2 | **主区域（Home Region）注册时选一次，永久不能改** | 免费资源只在主区域内有效。选错 = 白注册 |
| 3 | **ARM 实例经常「Out of host capacity」** | 东京区域最严重。备好重试脚本（第 4 步给） |
| 4 | **空闲实例可能被回收** | 官方规则：连续 7 天 CPU/网络/内存利用率都低于 20% 的实例，Oracle 有权回收。测试项目要注意 |

**免费额度（永久）**：
- Ampere A1 **ARM 实例：2 OCPU + 12 GB 内存**（可拆成 1~2 台）
- 另加 2 台 AMD 微实例（1/8 OCPU + 1 GB）
- 块存储 200 GB（启动卷最小 47 GB）
- **出站流量每月 10 TB**（非常大方的额度）
- 证书 5 个 CA + 150 张（我们用 Caddy 自己签，不需要）

---

## 第 1 步：注册（约 15 分钟）

打开 👉 **https://signup.cloud.oracle.com**

1. 选 **China / 中国**，国家代码 +86，填能收短信的**手机号**
2. 填邮箱（建议 Gmail/Outlook，QQ 邮箱偶发收不到验证码）
3. **验证手机**：收短信验证码
4. **填信用卡**：Visa/Mastercard，会冻结一小笔预授权（约 1 美元或等值），验证后释放
5. **地址信息**：填英文或拼音
6. 点 **Start my free trial**（这会同时激活 30 天 $300 试用金 + 永久免费额度）

> ⚠️ 如果卡在「support 验证」或收不到短信，换个浏览器/网络重试，别反复提交（可能触发风控）。

---

## 第 2 步：选主区域 —— ⚠️ 最关键、不可逆

注册最后一步会让你选 **Home Region（主区域）**。

**给国内用户的建议排序：**

| 优先级 | 区域 | 说明 |
|---|---|---|
| ① | **Japan Central（大阪）** | 离国内近，比东京宽松，ARM 有货概率高 |
| ② | **Singapore（新加坡）** | 华南用户友好；可用性通常不错 |
| ③ | **Japan East（东京）** | 理论延迟最低，但**ARM 容量常年紧张**，很可能创建失败 |

> ⚠️ **不要选美国/欧洲区域**，大陆访问会很难受。
> ⚠️ 这个选择**永久生效，之后无法更改**。想清楚再点。

---

## 第 3 步：创建 ARM 实例

登录 👉 **https://cloud.oracle.com** → 左上角菜单 **Compute → Instances → Create instance**

| 配置项 | 选什么 |
|---|---|
| Name | `openhive` |
| **Image** | **Ubuntu 24.04**（Canonical Ubuntu，不要选 Oracle Linux） |
| **Shape** | 点 **Change shape** → **Ampere（VM.Standard.A1.Flex）** → **1 OCPU / 6 GB 内存** |
| **SSH key** | 选 **Save private key** 下载私钥，或 **Paste public key** 填你自己的公钥 |
| Boot volume | 默认 47 GB 就行（别加大，免费块存储总共才 200 GB） |
| VCN / 子网 | 默认新建 |

点 **Create**。

### 如果报 `Out of host capacity`

这是最常见的卡点。解决办法——装一个自动重试脚本，有货就抢：

```bash
# 在实例创建页报错后，用 Cloud Shell 或本机跑（需要装 oci-cli）
git clone https://github.com/mingcheng/oci-arm-host-capacity.git
cd oci-arm-host-capacity
pip install -r requirements.txt
python oci-arm-host-capacity.py --region ap-osaka-1 --shape VM.Standard.A1.Flex --ocpus 1 --memory-in-gbs 6
```

它会一直重试直到抢到。**换可用域（Availability Domain）和换时间段重试**成功率最高。

> 如果抢了半小时还不行，退回第 2 步思路：新建一个账号选 Singapore 当主区域（每个手机号/卡通常可注册一个账号，多账号有被判定滥用的风险，谨慎）。

---

## 第 4 步：放行 80/443 —— ⚠️ 两层都要改

**这一层漏了，Caddy 签证书会失败，网站打不开。**

### 第一层：Oracle 控制台的安全列表

`Networking → Virtual Cloud Networks → 你的 VCN → Subnet → Security List → Add Ingress Rules`

加两条：

| Source CIDR | IP Protocol | Destination Port |
|---|---|---|
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

（SSH 的 22 默认已放行）

### 第二层：实例自带的 iptables

OCI 的 Ubuntu 镜像**自带只放行 22 的 iptables 规则**，80/443 会被静默丢弃。
**我们的 `bootstrap.sh` 会自动处理这一层**，所以直接进第 5 步即可。

---

## 第 5 步：拿到免费域名（HTTPS 必需）

**为什么必须有域名**：浏览器只在 HTTPS 或 localhost 下才提供 `crypto.subtle`，
Supabase 登录依赖它。`http://IP` 会导致登录功能直接坏掉。所以必须上 HTTPS，必须
有域名才能签 Let's Encrypt 证书。

推荐 **DuckDNS**（免费、无需审核、支持 Let's Encrypt）：

1. 打开 👉 **https://www.duckdns.org** → 用 GitHub / Google / Twitter 登录
2. 输入一个子域名，例如 `openhive`，点 **add domain**
3. 记住你的 **token**（页面顶部那一长串）
4. 把域名指向服务器：在 DuckDNS 页面把当前 IP 设成你的实例公网 IP

最终域名就是 **`openhive.duckdns.org`**。

> 已经有自己的域名？在第 5 步直接加一条 A 记录指向实例公网 IP，跳过 DuckDNS。

---

## 第 6 步：SSH 连上服务器，跑一键脚本

```bash
# 把下载的私钥放到 ~/.ssh/ 并设权限（Windows  PowerShell 里）
mkdir -p $env:USERPROFILE\.ssh
copy "你的私钥.key" "$env:USERPROFILE\.ssh\oracle.pem"
icacls "$env:USERPROFILE\.ssh\oracle.pem" /inheritance:r /grant:r "$($env:USERNAME):(R)"

# 连接（默认用户是 ubuntu）
ssh -i $env:USERPROFILE\.ssh\oracle.pem ubuntu@<实例公网IP>
```

连上后，一条命令拉脚本并执行：

```bash
curl -fsSL https://raw.githubusercontent.com/weic70902-dev/openhive/main/deploy/oracle/bootstrap.sh \
  | sudo bash -s -- openhive.duckdns.org latest --duckdns <你的DuckDNS token>
```

脚本会自动完成：装 Docker → 装 Caddy 并配好自动 HTTPS → 放行 iptables 80/443 →
拉多架构镜像 → 起容器（`--restart unless-stopped`）→ 装 DuckDNS 定时同步。

第一次运行会先生成 `/etc/openhive/env` 模板并停下，等你填 4 个变量：

```bash
sudo nano /etc/openhive/env
# 填入后重跑同一条命令即可
```

---

## 第 7 步：验收

```bash
# 本地
curl https://openhive.duckdns.org/api/setup
# 期望：{"configured":true,"hasServiceKey":true,"storageProvider":"supabase"}

# 或跑完整验收（5 项）
cd E:\space\workmeta\openhive
python scripts/verify-deployment.py https://openhive.duckdns.org
```

然后把**域名发我**，我接着做：
1. 改 Supabase Auth 的 `site_url` / `uri_allow_list`
2. 全国多点测速（电信/联通/移动）
3. 确认浏览器端 Supabase 真的通（不是只通服务端）

---

## 常见问题

| 现象 | 原因 |
|---|---|
| 创建实例报 `Out of host capacity` | ARM 容量不足，用第 3 步的重试脚本；或换可用域/换时段 |
| 网站打不开，但 `docker ps` 显示 Up | 99% 是第 4 步漏了。控制台安全列表 + iptables 两层都要放行 |
| Caddy 日志报 `acme: ... timeout` / DNS 问题 | 域名没解析到服务器 IP，或 80 端口没放行 |
| `curl /api/setup` 通了但网页登录不了 | 证书/域名没问题，是 Supabase 回调没配 —— 把域名发我改 |
| 机器用了几天被停了 | 触发了「空闲回收」。跑个 `cron` 每 6 小时 `curl` 一下自己的 `/api/setup` 保持活跃度 |
| 内存吃紧 | 我们限了 768MB。ARM 给 6GB，够用；如果用的是 AMD 微实例（1GB），把 `--memory 768m` 改成 `--memory 512m` |
| 镜像拉取慢/失败 | GHCR 在国内不稳定。可在服务器上配镜像加速，或让我推一份到 Docker Hub |

---

## 费用自查（应该是 0）

`Billing → Cost Analysis` 里看，只要没有创建**非 Always Free** 的资源（比如第二个区域
的机器、超大存储、付费 shape），账单就是 **$0.00**。

> 30 天的 $300 试用金**不要主动去用**——只用 Always Free 资源，试用期结束后
> 账户不升级也不会被收费，但资源也不会停。
