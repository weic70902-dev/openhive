#!/usr/bin/env bash
# =============================================================================
# OpenHive — Oracle Cloud（或任意 Ubuntu VPS）一键部署脚本
#
# 用法：
#   sudo ./bootstrap.sh <域名> [镜像tag] [--duckdns <token>]
#
# 示例：
#   sudo ./bootstrap.sh openhive.duckdns.org
#   sudo ./bootstrap.sh openhive.duckdns.org latest --duckdns a1b2c3d4-....
#   sudo ./bootstrap.sh app.example.com sha-8cc8aa7
#
# 做的事：
#   1. 安装 Docker（官方源）
#   2. 安装 Caddy（自动申请并续期 Let's Encrypt 证书，自动 HTTP→HTTPS 跳转）
#   3. 容器只监听 127.0.0.1:3000，对外由 Caddy 反代（不暴露 3000）
#   4. docker --restart unless-stopped，重启/掉电自动拉起
#   5. 可选：安装 DuckDNS 定时更新任务（没有自有域名时用免费二级域名）
#
# 前提：/etc/openhive/env 已存在并含 4 个运行期变量，脚本会检查。
# =============================================================================
set -euo pipefail

DOMAIN="${1:-}"
TAG="${2:-latest}"
DUCKDNS_TOKEN=""
shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --duckdns) DUCKDNS_TOKEN="${2:?--duckdns 需要跟 token}"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
done

if [[ -z "$DOMAIN" ]]; then
  echo "用法：sudo ./bootstrap.sh <域名> [镜像tag] [--duckdns <token>]" >&2
  exit 2
fi

IMAGE="ghcr.io/weic70902-dev/openhive:${TAG}"
ENV_FILE="/etc/openhive/env"
SUBDOMAIN="${DOMAIN%%.*}"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行（sudo ./bootstrap.sh ...）"

# ---------------------------------------------------------------- 0. 环境变量
log "检查运行期环境变量"
if [[ ! -f "$ENV_FILE" ]]; then
  install -d -m 700 /etc/openhive
  cat > "$ENV_FILE" <<'EOF'
# OpenHive 运行期环境变量 —— 逐条填好再重新运行本脚本
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
STORAGE_PROVIDER=supabase
EOF
  chmod 600 "$ENV_FILE"
  echo "已生成模板 $ENV_FILE"
  echo "请填入 4 个变量后重新执行："
  echo "    nano $ENV_FILE && sudo ./bootstrap.sh $DOMAIN"
  exit 3
fi

# 校验关键变量非空
while IFS='=' read -r k v; do
  [[ "$k" =~ ^[A-Z_]+$ ]] || continue
  if [[ -z "${v// /}" ]]; then
    case "$k" in
      NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY)
        die "$ENV_FILE 里 $k 还是空的，请先填好" ;;
    esac
  fi
done < <(grep -vE '^\s*(#|$)' "$ENV_FILE")
echo "✓ 4 个变量已就位"

# ---------------------------------------------------------------- 1. Docker
log "安装 Docker"
if ! command -v docker >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
    -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  echo "Docker 已安装，跳过"
fi
docker --version

# ---------------------------------------------------------------- 2. Caddy
log "安装并配置 Caddy（自动 HTTPS）"
if ! command -v caddy >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

cat > /etc/caddy/Caddyfile <<EOF
# OpenHive — 由 bootstrap.sh 生成
${DOMAIN} {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000

	# 上传体积上限（附件、头像）
	request_body {
		max_size 64MB
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
	}

	log {
		output file /var/log/caddy/openhive.access.log {
			roll_size 10MiB
			roll_keep 5
		}
	}
}
EOF

systemctl enable --now caddy >/dev/null 2>&1 || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy
echo "✓ Caddy 已为 ${DOMAIN} 配置（证书会在首次访问时自动签发）"

# ---------------------------------------------------------------- 3. 防火墙
log "放行本机防火墙端口"
# OCI 的 Ubuntu 镜像自带 iptables 规则，只放行 22 端口，80/443 会被静默丢弃。
# 这是 Oracle 上最常见的「控制台安全列表明明放开了却还是打不开」的原因。
if command -v iptables >/dev/null 2>&1; then
  for P in 80 443; do
    if ! iptables -C INPUT -m state --state NEW -p tcp --dport "$P" -j ACCEPT 2>/dev/null; then
      iptables -I INPUT -m state --state NEW -p tcp --dport "$P" -j ACCEPT
      echo "  + iptables 放行 $P"
    fi
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then
    netfilter-persistent save >/dev/null 2>&1 || true
  fi
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 22/tcp  >/dev/null
  ufw allow 80/tcp  >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw reload >/dev/null || true
  echo "✓ ufw 已放行 22/80/443"
fi
echo "✓ 本机防火墙已处理"

# ---------------------------------------------------------------- 4. 容器
log "拉取镜像并启动容器"
docker pull "$IMAGE"
docker rm -f openhive >/dev/null 2>&1 || true
docker run -d \
  --name openhive \
  --restart unless-stopped \
  --memory 768m \
  -p 127.0.0.1:3000:3000 \
  --env-file "$ENV_FILE" \
  "$IMAGE"

sleep 3
if docker ps --filter name=openhive --format '{{.Status}}' | grep -q Up; then
  echo "✓ 容器已启动"
else
  echo "容器日志："
  docker logs --tail 40 openhive || true
  die "容器启动失败，请看上面的日志"
fi

# ---------------------------------------------------------------- 5. DuckDNS
if [[ -n "$DUCKDNS_TOKEN" ]]; then
  log "安装 DuckDNS 定时更新（子域：${SUBDOMAIN}.duckdns.org）"
  cat > /etc/cron.d/duckdns <<EOF
*/5 * * * * root echo url="https://www.duckdns.org/update/${SUBDOMAIN}/${DUCKDNS_TOKEN}" | curl -s -K - >/dev/null 2>&1
EOF
  chmod 644 /etc/cron.d/duckdns
  # 立即执行一次
  echo url="https://www.duckdns.org/update/${SUBDOMAIN}/${DUCKDNS_TOKEN}" | curl -s -K - || true
  echo "✓ DuckDNS 每 5 分钟同步一次 IP"
fi

# ---------------------------------------------------------------- 汇总
log "部署完成"
cat <<EOF

  域名      https://${DOMAIN}
  健康检查  curl https://${DOMAIN}/api/setup
  容器状态  docker ps --filter name=openhive
  容器日志  docker logs -f openhive
  更新镜像  docker pull ${IMAGE} && docker rm -f openhive \\
              && docker run -d --name openhive --restart unless-stopped \\
                 --memory 768m -p 127.0.0.1:3000:3000 \\
                 --env-file ${ENV_FILE} ${IMAGE}

  下一步（在 Oracle 控制台做）：
    VCN → 安全列表 → 添加入站规则 0.0.0.0/0，端口 80 和 443

EOF
echo "⚠️ 别忘了：Oracle 控制台的安全列表必须放行 80/443，否则 Caddy 签证书会失败。"
