import { createClient } from '@supabase/supabase-js'
import type { StorageProvider, UploadOptions, UploadResult } from '../types'

/**
 * Supabase Storage —— 默认后端。
 *
 * 免费层额度:1 GB 存储 + 5 GB 出口流量/月。
 * 优点:零配置、无需绑卡、与现有 RLS 体系一致。
 *
 * 桶的可见性口径:
 *  · attachments 已私有(private-attachments.sql)。上传仍由本文件用
 *    service_role 完成(绕过 RLS),但**读取必须走签名 URL** ——
 *    getPublicUrl 返回的直链只作为数据库里的持久引用保存,
 *    客户端渲染时由 src/lib/attachment-url.ts 现换签名版。
 *  · avatars 仍是 public(头像低敏感、渲染点太多,私有化性价比低)。
 * 缺点:容量小;avatars 桶为 public,拿到直链无需登录即可访问。
 */
export function createSupabaseProvider(): StorageProvider {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !serviceKey) {
    throw new Error(
      'Supabase 存储后端需要 NEXT_PUBLIC_SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY'
    )
  }

  const client = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

  return {
    name: 'supabase',

    async upload(body: ArrayBuffer, opts: UploadOptions): Promise<UploadResult> {
      const bucket = opts.bucket || 'attachments'

      const { error } = await client.storage.from(bucket).upload(opts.path, body, {
        upsert: true,
        contentType: opts.contentType,
        ...(opts.cacheControl ? { cacheControl: opts.cacheControl } : {}),
      })

      if (error) throw new Error(error.message)

      const { data } = client.storage.from(bucket).getPublicUrl(opts.path)

      return { url: data.publicUrl, path: opts.path, provider: 'supabase' }
    },

    async delete(path: string, opts?: { bucket?: string }): Promise<void> {
      await client.storage.from(opts?.bucket || 'attachments').remove([path])
    },
  }
}
