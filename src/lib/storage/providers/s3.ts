import { AwsClient } from 'aws4fetch'
import type { StorageProvider, UploadOptions, UploadResult } from '../types'

/**
 * 任意 S3 兼容对象存储 —— 一个实现覆盖多种后端。
 *
 * 已验证/适用的后端:
 * - **Cloudflare R2**   10 GB 免费存储 + **零出口流量费**(推荐,激活需绑定支付方式)
 * - **Backblaze B2**    10 GB 免费存储
 * - **MinIO**           自建,完全可控
 * - **AWS S3 / 阿里云 OSS / 七牛**(S3 兼容模式)
 *
 * 需要以下环境变量:
 *   STORAGE_PROVIDER=s3
 *   S3_ENDPOINT           如 https://<accountid>.r2.cloudflarestorage.com
 *   S3_BUCKET             桶名
 *   S3_ACCESS_KEY_ID
 *   S3_SECRET_ACCESS_KEY
 *   S3_REGION             默认 auto(R2 用 auto)
 *   S3_PUBLIC_BASE_URL    可选。公开访问前缀,用于拼接最终 URL。
 *                         若桶已绑定自定义域名,填该域名;
 *                         否则留空,回退为 `<endpoint>/<bucket>`(要求桶为公开读)。
 *
 * 注意:R2 的 S3 端点仅用于**写入**,不能直接读取。
 * 对外可访问的地址必须通过 S3_PUBLIC_BASE_URL(绑定域名)或桶的公开开发域名提供。
 */
export function createS3Provider(): StorageProvider {
  const endpoint = (process.env.S3_ENDPOINT || '').replace(/\/+$/, '')
  const bucket = process.env.S3_BUCKET || ''
  const accessKeyId = process.env.S3_ACCESS_KEY_ID || ''
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || ''
  const region = process.env.S3_REGION || 'auto'
  const publicBase = (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/+$/, '')

  const client = new AwsClient({
    accessKeyId,
    secretAccessKey,
    service: 's3',
    region,
  })

  /** 把逻辑分区映射为对象键前缀:附件保持原路径,其余(如头像)加桶名前缀 */
  function objectKey(opts: UploadOptions): string {
    const bucketName = opts.bucket || 'attachments'
    if (bucketName === 'attachments') return opts.path
    return `${bucketName}/${opts.path}`
  }

  function publicUrlFor(key: string): string {
    const base = publicBase || `${endpoint}/${bucket}`
    return `${base}/${key}`
  }

  return {
    name: 's3',

    async upload(body: ArrayBuffer, opts: UploadOptions): Promise<UploadResult> {
      const key = objectKey(opts)
      const target = `${endpoint}/${bucket}/${key}`

      const headers: Record<string, string> = {
        'Content-Type': opts.contentType,
      }
      if (opts.cacheControl) headers['Cache-Control'] = opts.cacheControl

      const res = await client.fetch(target, { method: 'PUT', body, headers })

      if (!res.ok) {
        // 读取响应体有助于定位问题(如签名错误、桶不存在、权限不足)
        const detail = await res.text().catch(() => '')
        throw new Error(
          `S3 上传失败 (HTTP ${res.status})${detail ? `: ${detail.slice(0, 300)}` : ''}`
        )
      }

      return { url: publicUrlFor(key), path: key, provider: 's3' }
    },

    async delete(path: string, opts?: { bucket?: string }): Promise<void> {
      const bucketName = opts?.bucket || 'attachments'
      const key = bucketName === 'attachments' ? path : `${bucketName}/${path}`
      await client.fetch(`${endpoint}/${bucket}/${key}`, { method: 'DELETE' })
    },
  }
}
