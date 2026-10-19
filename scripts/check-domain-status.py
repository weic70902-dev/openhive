#!/usr/bin/env python3
"""
OpenHive 线上可用性自动检测

用途：一键判断「自定义域名 + EdgeOne」这条链路到底卡在哪一环，
      不需要人工去控制台反复点 Verify。

检测项：
  1. NS 委派         —— 是否还挂着坏掉的 ns2
  2. 各权威 NS 的 UDP 应答率 —— 定位「验证器随机撞上死节点」问题
  3. TXT 记录可见性   —— 多个公共解析器交叉验证
  4. 域名 HTTP 可达性 —— 是否已能访问
  5. EdgeOne 默认域名 —— 应用本体是否正常（401 = 签名保护，属预期）

用法：
  python scripts/check-domain-status.py
  python scripts/check-domain-status.py --rounds 5    # 加大采样次数
"""

import argparse
import json
import socket
import ssl
import subprocess
import sys
import time
import urllib.parse
import urllib.request

DOMAIN = "openhive.indevs.in"
TXT_NAME = "edgonereclaim.openhive.indevs.in"
TXT_VALUE = "reclaim-osqtnf62vxd0uhxpeyvkpfoqiu74x97t"
NS_LIST = ["ns1.stackryze.com", "ns2.stackryze.com", "ns3.stackryze.com"]
DEFAULT_HOST = "openhive.edgeone.dev"
VERIFY_FILE = "/.well-known/teo-verification/nautl3vopt.txt"

DOH_ENDPOINTS = [
    ("阿里 DoH", "https://dns.alidns.com/resolve"),
    ("腾讯 DoH", "https://doh.pub/dns-query"),
]
PLAIN_RESOLVERS = ["8.8.8.8", "1.1.1.1", "223.5.5.5"]

CTX = ssl.create_default_context()
CTX.check_hostname = False
CTX.verify_mode = ssl.CERT_NONE


def doh(name, rtype, endpoint):
    url = endpoint + "?" + urllib.parse.urlencode({"name": name, "type": rtype})
    req = urllib.request.Request(url, headers={"Accept": "application/dns-json",
                                               "User-Agent": "curl/8"})
    try:
        with urllib.request.urlopen(req, timeout=15, context=CTX) as r:
            return json.load(r)
    except Exception as e:
        return {"__err": type(e).__name__}


def nslookup(name, rtype, server, tcp=False):
    cmd = ["nslookup"]
    if tcp:
        cmd.append("-vc")
    cmd += ["-type=" + rtype, name, server]
    try:
        p = subprocess.run(cmd, capture_output=True, timeout=12)
        return (p.stdout or b"").decode("utf-8", "ignore")
    except Exception:
        return ""


def http_probe(url, timeout=25):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                                                         "AppleWebKit/537.36 Chrome/131.0 Safari/537.36"})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            body = r.read(400)
            return r.status, dict(r.headers), body
    except urllib.error.HTTPError as e:
        try:
            body = e.read(400)
        except Exception:
            body = b""
        return e.code, dict(e.headers), body
    except Exception as e:
        return None, {}, str(e).encode()


def resolve_ips(host):
    try:
        return sorted({i[4][0] for i in socket.getaddrinfo(host, None)})
    except Exception:
        return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=3, help="每个权威 NS 的 UDP 采样次数")
    args = ap.parse_args()

    report = {"domain": DOMAIN, "checks": {}, "verdict": [], "ok": True}

    print("=" * 68)
    print(f" OpenHive 域名状态检测   {time.strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 68)

    # ---------- 1. NS 委派 ----------
    print("\n[1] NS 委派")
    ns_seen = {}
    for label, ep in DOH_ENDPOINTS:
        d = doh(DOMAIN, "NS", ep)
        ns = sorted(a["data"].rstrip(".") for a in d.get("Answer", [])) if "__err" not in d else []
        ns_seen[label] = ns
        print(f"    {label:<10} {len(ns)} 个: {', '.join(ns) if ns else '查询失败'}")
    bad_ns = any("ns2.stackryze.com" in v for v in ns_seen.values())
    ns_count = max((len(v) for v in ns_seen.values()), default=0)
    report["checks"]["ns"] = {"count": ns_count, "has_broken_ns2": bad_ns}
    print(f"    → 是否仍含 ns2(已知故障): {'是 ❌' if bad_ns else '否 ✅'}")

    # ---------- 2. 权威 NS 的 UDP 应答率 ----------
    print(f"\n[2] 各权威 NS 的 UDP 应答（每个 {args.rounds} 次）")
    ns_health = {}
    for ns in NS_LIST:
        ok = 0
        for _ in range(args.rounds):
            out = nslookup(TXT_NAME, "TXT", ns)
            if TXT_VALUE in out:
                ok += 1
            time.sleep(0.2)
        ns_health[ns] = ok
        flag = "✅" if ok == args.rounds else ("⚠️" if ok else "❌")
        print(f"    {ns:<22} {ok}/{args.rounds} {flag}")
    report["checks"]["ns_health"] = ns_health

    # ---------- 3. TXT 可见性 ----------
    print("\n[3] TXT 记录可见性")
    txt_ok = 0
    for label, ep in DOH_ENDPOINTS:
        d = doh(TXT_NAME, "TXT", ep)
        vals = [a["data"].strip('"') for a in d.get("Answer", [])] if "__err" not in d else []
        hit = TXT_VALUE in vals
        txt_ok += 1 if hit else 0
        print(f"    {label:<10} {'✅ 命中' if hit else '❌ 未命中'}")
    for r in PLAIN_RESOLVERS:
        hit = TXT_VALUE in nslookup(TXT_NAME, "TXT", r)
        txt_ok += 1 if hit else 0
        print(f"    {r:<10} {'✅ 命中' if hit else '❌ 未命中'}")
    total = len(DOH_ENDPOINTS) + len(PLAIN_RESOLVERS)
    report["checks"]["txt"] = {"hit": txt_ok, "total": total}
    print(f"    → {txt_ok}/{total} 个解析器可见")

    # ---------- 4. 自定义域名 HTTP ----------
    print("\n[4] 自定义域名可达性")
    for host in [DOMAIN, "www." + DOMAIN]:
        ips = resolve_ips(host)
        print(f"    {host:<28} 解析: {ips if ips else '无解析'}")
        if ips:
            code, _, _ = http_probe(f"https://{host}/")
            print(f"    {'':<28} HTTP: {code}")
    domain_ips = resolve_ips(DOMAIN)
    report["checks"]["domain_http"] = {"resolved": bool(domain_ips)}

    # ---------- 5. EdgeOne 默认域名 ----------
    print("\n[5] EdgeOne 默认域名（应用本体）")
    code, headers, body = http_probe(f"https://{DEFAULT_HOST}/")
    eop = headers.get("X-EOP-MSG") or headers.get("x-eop-msg") or ""
    print(f"    /            HTTP {code}" + (f"  (X-EOP-MSG: {eop})" if eop else ""))
    code2, _, body2 = http_probe(f"https://{DEFAULT_HOST}{VERIFY_FILE}")
    print(f"    验证文件      HTTP {code2}  内容匹配: {TXT_VALUE.encode() in body2}")
    code3, _, body3 = http_probe(f"https://{DEFAULT_HOST}/api/setup")
    try:
        api = json.loads(body3.decode("utf-8", "ignore"))
    except Exception:
        api = None
    print(f"    /api/setup   HTTP {code3}  {api if api else '（受签名保护）'}")
    report["checks"]["default_host"] = {
        "root": code, "verify_file": code2, "api_setup": code3,
        "app_healthy": isinstance(api, dict) and api.get("configured") is True,
    }

    # ---------- 结论 ----------
    print("\n" + "=" * 68)
    print(" 结论")
    print("=" * 68)
    if report["checks"]["default_host"]["app_healthy"]:
        print(" ✅ 应用本体正常：EdgeOne 上构建成功、环境变量生效、Supabase 连通")
    if bad_ns:
        print(" ❌ NS 委派仍包含已故障的 ns2 → EdgeOne 验证器有概率超时，这是验证失败的根因")
        report["ok"] = False
    if ns_health.get("ns2.stackryze.com", 0) == 0:
        print(" ❌ ns2.stackryze.com 的 UDP 53 仍完全无响应")
    if txt_ok == total:
        print(" ✅ TXT 记录在所有公共解析器均可见（记录本身没问题）")
    if not domain_ips:
        print(" ❌ 自定义域名尚无任何解析记录 → 还不能访问")
        report["ok"] = False

    print("\n 判定: " + ("链路已通 ✅" if report["ok"] else "链路未通 ❌"))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
