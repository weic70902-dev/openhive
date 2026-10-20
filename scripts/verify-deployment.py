#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
部署后一键验收 —— 对任意已上线的 OpenHive 实例做完整检查。

用法:
    python scripts/verify-deployment.py https://your-app.claw.cloud
    python scripts/verify-deployment.py https://your-app.claw.cloud --full

检查项:
    1. 首页 / 登录页 / 工作区页 HTTP 状态与标题
    2. GET /api/setup 是否返回 configured/hasServiceKey/storageProvider
    3. 客户端 bundle 里是否真的内联了 Supabase URL 与 anon key
       （这一项最关键：服务端 env 就算配对，build-arg 漏传也会让浏览器端全线崩溃）
    4. --full：额外检查每个 JS chunk 的 HTTP 可达性（排查 CDN 缓存错配）

退出码: 0 = 全部通过；1 = 有失败项
"""

import argparse
import re
import sys
import urllib.request
import urllib.error

DEFAULT_TIMEOUT = 20


def fetch(url: str, timeout: int = DEFAULT_TIMEOUT):
    """返回 (status, headers_dict, bytes)，网络错误返回 (None, {}, b'')"""
    req = urllib.request.Request(url, headers={
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept": "*/*",
    })
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), b""
    except Exception as e:
        print(f"    ! {type(e).__name__}: {e}")
        return None, {}, b""


def text_of(b: bytes) -> str:
    return b.decode("utf-8", errors="replace")


def check_pages(base: str, results: list) -> None:
    for path, title in (("/", "OpenHive"), ("/auth", None), ("/workspace", "OpenHive")):
        st, _, body = fetch(base + path)
        ok = st == 200
        html = text_of(body)
        has_title = re.search(r"<title>([^<]*)</title>", html)
        detail = f"HTTP {st}"
        if has_title:
            detail += f"，title={has_title.group(1).strip()!r}"
        if title and has_title and has_title.group(1).strip() == title:
            detail += " ✓"
        elif title and has_title and has_title.group(1).strip() != title:
            ok = False
            detail += f"（期望 {title!r}）"
        results.append((f"页面 {path or '/'}", ok, detail))


def check_api_setup(base: str, results: list) -> dict:
    st, _, body = fetch(base + "/api/setup")
    ok = st == 200
    detail = f"HTTP {st}"
    data = {}
    try:
        import json
        data = json.loads(text_of(body))
        detail += " → " + text_of(body).strip()
        if data.get("configured") is not True or data.get("hasServiceKey") is not True:
            ok = False
    except Exception as e:
        ok = False
        detail += f"（解析失败 {e}）"
    results.append(("API /api/setup", ok, detail))
    return data


def check_bundle_inlining(base: str, results: list, supabase_url: str | None, anon_key: str | None) -> None:
    """从首页抓取 JS chunk，确认 Supabase 配置真的被打进客户端 bundle"""
    st, _, body = fetch(base + "/")
    html = text_of(body)
    chunks = sorted(set(re.findall(r'src="(/_next/static/[^"]+\.js)"', html)))
    if not chunks:
        results.append(("客户端 bundle 内联", False, "首页未找到 /_next/static/*.js 引用"))
        return

    url_hits = key_hits = 0
    bad_chunks = []
    for c in chunks:
        st, _, cb = fetch(base + c)
        if st != 200:
            bad_chunks.append(f"{c} → HTTP {st}")
            continue
        js = text_of(cb)
        if supabase_url and supabase_url in js:
            url_hits += 1
        if anon_key and anon_key in js:
            key_hits += 1

    ok = (url_hits > 0 and key_hits > 0) and not bad_chunks
    parts = [f"共 {len(chunks)} 个 chunk，含 Supabase URL 的 {url_hits} 个，含 anon key 的 {key_hits} 个"]
    if bad_chunks:
        parts.append("不可达：" + ", ".join(bad_chunks[:3]))
    if url_hits == 0:
        parts.append("← build-arg 漏传！服务端正常但浏览器端 Supabase 全断，需在 Vercel/ClawCloud 配好构建变量后重建")
    results.append(("客户端 bundle 内联", ok, "；".join(parts)))


def read_local_env(path: str = ".env.local"):
    """从本地 .env.local 读期望值，用于和线上比对。读不到就跳过内联检查。"""
    import os
    url = key = None
    p = os.path.join(os.getcwd(), path)
    if not os.path.exists(p):
        return None, None
    try:
        for line in open(p, encoding="utf-8"):
            if line.startswith("NEXT_PUBLIC_SUPABASE_URL="):
                url = line.split("=", 1)[1].strip().strip('"')
            elif line.startswith("NEXT_PUBLIC_SUPABASE_ANON_KEY="):
                key = line.split("=", 1)[1].strip().strip('"')
    except Exception:
        pass
    return url, key


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("base", help="例：https://your-app.claw.cloud")
    ap.add_argument("--full", action="store_true", help="额外检查每个 JS chunk 的可达性")
    ap.add_argument("--expect-url", default=None, help="期望的 NEXT_PUBLIC_SUPABASE_URL，不传则读本地 .env.local")
    ap.add_argument("--expect-key", default=None, help="期望的 NEXT_PUBLIC_SUPABASE_ANON_KEY，不传则读本地 .env.local")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    expect_url = args.expect_url
    expect_key = args.expect_key
    if not expect_url and not expect_key:
        expect_url, expect_key = read_local_env()

    print(f"\n=== OpenHive 部署验收：{base} ===\n")
    results = []
    check_pages(base, results)
    data = check_api_setup(base, results)
    check_bundle_inlining(base, results, expect_url, expect_key)

    width = max(len(n) for n, _, _ in results)
    failed = 0
    for name, ok, detail in results:
        print(f"  {'✓' if ok else '✗'} {name.ljust(width)}  {detail}")
        if not ok:
            failed += 1

    print()
    if failed:
        print(f"结果：{failed} 项未通过（共 {len(results)} 项）")
        return 1
    print(f"结果：全部通过（{len(results)} 项）")
    if data.get("storageProvider"):
        print(f"      存储后端：{data['storageProvider']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
