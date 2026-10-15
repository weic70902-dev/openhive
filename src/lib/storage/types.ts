/**
 * 存储后端抽象层
 *
 * 目标:把「图片存哪里」从业务代码里解耦出来。
 * 切换后端只需改环境变量 STORAGE_PROVIDER,不需要改任何组件。
 */

export interface UploadOptions {
  /** 存储路径(对象键),如 `uploads/1712345-ab12.webp` */
  path: string
  contentType: string
  /** 逻辑分区。Supabase 用它选桶;S3 兼容后端用它做键前缀 */
  bucket?: string
  cacheControl?: string
}

export interface UploadResult {
  /** 可直接访问的公开 URL,会写进消息内容 */
  url: string
  /** 实际使用的对象键 */
  path: string
  /** 实际生效的后端名称 */
  provider: string
}

export interface StorageProvider {
  readonly name: string
  upload(body: ArrayBuffer, opts: UploadOptions): Promise<UploadResult>
  delete?(path: string, opts?: { bucket?: string }): Promise<void>
}

/** Supabase 的两个桶名,保持与原实现一致 */
export const KNOWN_BUCKETS = ['avatars', 'attachments'] as const
export type KnownBucket = (typeof KNOWN_BUCKETS)[number]
