import type { StorageProvider } from './types'
import { createSupabaseProvider } from './providers/supabase'
import { createS3Provider } from './providers/s3'

export type { StorageProvider, UploadOptions, UploadResult } from './types'
export { KNOWN_BUCKETS } from './types'

/** 选择 S3 兼容后端时必须存在的环境变量 */
const S3_REQUIRED_ENV = [
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const

/**
 * 按环境变量解析当前应使用的存储后端。
 *
 * - `STORAGE_PROVIDER=supabase`(默认)→ Supabase Storage
 * - `STORAGE_PROVIDER=s3`             → 任意 S3 兼容存储(推荐 Cloudflare R2)
 *
 * 设计原则:**配置不全时回退 Supabase 并打印告警,而不是抛错**。
 * 上传是高频操作,宁可降级到可用后端,也不能因为写错一个环境变量就让整个功能挂掉。
 */
export function getStorageProvider(): StorageProvider {
  const requested = (process.env.STORAGE_PROVIDER || 'supabase').trim().toLowerCase()

  if (requested === 's3') {
    const missing = S3_REQUIRED_ENV.filter((k) => !process.env[k])
    if (missing.length === 0) {
      return createS3Provider()
    }
    console.warn(
      `[storage] STORAGE_PROVIDER=s3,但缺少环境变量: ${missing.join(', ')} —— 已回退 Supabase`
    )
  } else if (requested !== 'supabase') {
    console.warn(
      `[storage] 未知的 STORAGE_PROVIDER="${requested}",可选值: supabase | s3 —— 已回退 Supabase`
    )
  }

  return createSupabaseProvider()
}

/** 当前生效的后端名,用于健康检查与日志 */
export function currentStorageProviderName(): string {
  try {
    return getStorageProvider().name
  } catch {
    return 'unavailable'
  }
}
