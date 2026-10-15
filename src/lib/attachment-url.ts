/**
 * 附件 URL 私有化(签名 URL)的纯逻辑。
 *
 * 背景:存储桶原来是 public,消息正文里存的是**永久公开直链** ——
 * 任何人拿到 URL 都能看,不需要登录。对"私密聊天"是隐私弱化点。
 *
 * 方案:桶转私有,渲染时把正文里的公开直链**就地改写**成带签名的短时效 URL。
 * 签名由客户端用当前用户会话发起(RLS 保证只有登录用户能签),所以:
 *   · 数据库里存的还是原来的 URL,历史消息无需迁移,只是渲染时换皮;
 *   · 签名失败/桶还是 public 时,原样保留原 URL —— 任何中间态都不会白屏。
 *
 * 这里只放纯函数;发请求的签名器(需要 Supabase client)也在本文件,
 * 但 client 由调用方传入,不 import 任何 React/Next 模块,方便 node 测试。
 */

/** 签名 URL 有效期。取 7 天:够长(用户不会读到一半失效),又远小于任何已知上限。 */
export const SIGNED_TTL_SECONDS = 604800

/** 缓存里剩余有效期短于这个值就重新签,避免边界竞态。 */
export const SIGNED_REFRESH_MARGIN_SECONDS = 86400

export interface StorageRef {
  bucket: string
  path: string
}

/**
 * 匹配 Supabase Storage 公开直链:
 * https://<ref>.supabase.co/storage/v1/object/public/<bucket>/<path>
 * 路径字符集排除空白与常见分隔符(markdown 的 `)`、HTML 属性的引号)。
 */
const STORAGE_PUBLIC_URL_RE =
  /https?:\/\/[^\s/'"<>]+\/storage\/v1\/object\/public\/([A-Za-z0-9._-]+)\/([^\s'"<>)]+)/g

/** 已签名的 URL(object/sign/...)不需要再处理。 */
const STORAGE_SIGNED_URL_RE = /\/storage\/v1\/object\/sign\//

/**
 * 解析单个公开直链。不是 Storage 公开 URL / 已是签名 URL / 格式非法 → null。
 */
export function parseStorageUrl(url: string): StorageRef | null {
  if (!url || STORAGE_SIGNED_URL_RE.test(url)) return null
  const re = new RegExp(STORAGE_PUBLIC_URL_RE.source)
  const m = re.exec(url)
  if (!m) return null
  return { bucket: m[1], path: m[2] }
}

/**
 * 从一段文本里取出全部去重后的存储引用(保持出现顺序)。
 * 没有引用时返回空数组 —— 调用方据此完全跳过签名流程,零开销。
 */
export function extractStorageRefs(text: string): StorageRef[] {
  if (!text) return []
  const out: StorageRef[] = []
  const seen = new Set<string>()
  const re = new RegExp(STORAGE_PUBLIC_URL_RE.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const key = `${m[1]}/${m[2]}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ bucket: m[1], path: m[2] })
  }
  return out
}

/**
 * 把文本里所有公开直链替换成 resolver 的返回值。
 * resolver 返回 null(签不到)时**保留原 URL** —— 优雅降级,不会出现裂图。
 */
export function rewriteStorageUrls(
  text: string,
  resolver: (ref: StorageRef) => string | null
): string {
  if (!text) return text
  const re = new RegExp(STORAGE_PUBLIC_URL_RE.source, 'g')
  return text.replace(re, (matched) => {
    const ref = parseStorageUrl(matched)
    if (!ref) return matched
    const signed = resolver(ref)
    return signed ?? matched
  })
}

// ── 签名缓存(模块级,跨组件共享) ──────────────────────────────
// 同一条消息可能被消息气泡、草稿气泡、收藏面板同时渲染,
// 每个都去签一次纯属浪费;这里按 bucket/path 缓存,过期自动重签。

interface CacheEntry {
  signedUrl: string
  /** 过期时刻(epoch ms) */
  expiresAt: number
}

const signCache = new Map<string, CacheEntry>()

function cacheKey(ref: StorageRef): string {
  return `${ref.bucket}/${ref.path}`
}

/** 取缓存的签名 URL;没有/快过期了返回 null。 */
export function getCachedSignedUrl(ref: StorageRef): string | null {
  const hit = signCache.get(cacheKey(ref))
  if (!hit) return null
  if (Date.now() >= hit.expiresAt - SIGNED_REFRESH_MARGIN_SECONDS * 1000) {
    signCache.delete(cacheKey(ref))
    return null
  }
  return hit.signedUrl
}

/** 写入缓存。expiresInSeconds 为签名时声明的有效期。 */
export function cacheSignedUrl(ref: StorageRef, signedUrl: string, expiresInSeconds: number): void {
  signCache.set(cacheKey(ref), {
    signedUrl,
    expiresAt: Date.now() + expiresInSeconds * 1000,
  })
}

/** 只测试用:清空缓存。 */
export function clearSignCacheForTesting(): void {
  signCache.clear()
}

/** 签名器接口 —— Supabase client 的 storage 满足了它,传入即可,不耦合具体类型。 */
export interface SignedUrlSigner {
  from(bucket: string): {
    createSignedUrls(
      paths: string[],
      expiresIn: number
    ): Promise<{ data: { path: string; signedURL: string | null }[] | null; error: unknown }>
  }
}

/**
 * 批量签名:按 bucket 分组,一次请求签一批。
 * 单个失败不影响整批(失败的保留原 URL);整批请求异常时整体降级。
 *
 * @returns 每个 ref 对应的签名 URL(签不到的 ref 不出现在结果里)
 */
export async function signStorageRefs(
  client: SignedUrlSigner,
  refs: StorageRef[],
  expiresIn: number = SIGNED_TTL_SECONDS
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (refs.length === 0) return out

  const byBucket = new Map<string, string[]>()
  for (const ref of refs) {
    const paths = byBucket.get(ref.bucket) ?? []
    paths.push(ref.path)
    byBucket.set(ref.bucket, paths)
  }

  await Promise.all(
    [...byBucket.entries()].map(async ([bucket, paths]) => {
      try {
        const { data, error } = await client.from(bucket).createSignedUrls(paths, expiresIn)
        if (error || !data) return
        for (const item of data) {
          if (!item?.signedURL) continue
          const ref = { bucket, path: item.path }
          cacheSignedUrl(ref, item.signedURL, expiresIn)
          out.set(cacheKey(ref), item.signedURL)
        }
      } catch {
        // 网络失败等:静默降级,调用方会用原 URL
      }
    })
  )

  return out
}
