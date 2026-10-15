'use client'

import { useEffect, useRef, useState } from 'react'
import { getSupabaseClient } from '@/lib/supabase/client'
import {
  extractStorageRefs,
  getCachedSignedUrl,
  rewriteStorageUrls,
  signStorageRefs,
} from '@/lib/attachment-url'

/**
 * 把一段文本里的 Storage 公开直链替换为签名 URL(私有桶方案)。
 *
 * 设计要点:
 *  · 没有存储引用 → **原样返回同一个字符串**,父组件引用的 `content` 不变,
 *    不会引发任何多余渲染(消息列表里绝大多数消息走这条快路);
 *  · 签名在 effect 里异步做,首帧先用原 URL —— 私有桶下首帧可能闪一下裂图,
 *    但签回来立刻恢复,且我们尽量在挂载前同步吃缓存(见下),多数情况无感;
 *  · 请求合并:一个组件挂载只发一次请求,按 bucket 分组批量签;
 *  · 失败降级:签不到就继续用原 URL,绝不白屏。
 */
export function useSignedText(text: string): string {
  const [signed, setSigned] = useState<Record<string, string> | null>(null)
  // 记一下已经为哪个文本签过,避免 content 不变时反复 effect
  const signedForRef = useRef<string | null>(null)

  const refs = extractStorageRefs(text)
  // refs 每次渲染都是新数组,直接当依赖会让 effect 反复跑;
  // 用「内容签名」做依赖才稳定。
  const refsSignature = refs.map((r) => `${r.bucket}/${r.path}`).join('|')

  // 同步阶段先吃缓存:命中就直接有签名 URL,首帧就是对的
  const cached: Record<string, string> = {}
  let hasCacheMiss = false
  for (const ref of refs) {
    const hit = getCachedSignedUrl(ref)
    if (hit) cached[`${ref.bucket}/${ref.path}`] = hit
    else hasCacheMiss = true
  }

  const cacheSignature = Object.keys(cached)
    .sort()
    .map((k) => `${k}=${cached[k]}`)
    .join('|')

  useEffect(() => {
    if (!hasCacheMiss || refs.length === 0) return
    if (signedForRef.current === text) return
    let cancelled = false

    const client = getSupabaseClient()
    if (!client) return

    signStorageRefs(client as unknown as Parameters<typeof signStorageRefs>[0], refs)
      .then((result) => {
        if (cancelled || result.size === 0) return
        signedForRef.current = text
        setSigned((prev) => ({ ...(prev ?? {}), ...Object.fromEntries(result) }))
      })
      .catch(() => {
        // 静默:保持原 URL
      })

    return () => {
      cancelled = true
    }
    // cacheSignature 变化说明缓存刷新过;text 变了要重签
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, refsSignature, cacheSignature, hasCacheMiss])

  if (refs.length === 0) return text

  const all = { ...cached, ...(signed ?? {}) }
  if (Object.keys(all).length === 0) return text

  return rewriteStorageUrls(text, (ref) => all[`${ref.bucket}/${ref.path}`] ?? null)
}
