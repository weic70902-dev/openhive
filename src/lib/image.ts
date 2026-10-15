/**
 * 客户端图片处理工具
 *
 * 核心目的有两个:
 * 1. **剥离 EXIF 元数据** —— 手机拍摄的照片通常带 GPS 经纬度,原图直传会在
 *    存储里泄露拍摄地点。canvas 重编码只保留像素数据,所有 EXIF / IPTC / XMP
 *    元数据自然消失。
 * 2. **压缩体积** —— 输出 WebP(同画质下比 JPEG 小 30-50%,且原生支持透明通道),
 *    并限制最大边长。相当于在不换存储服务的前提下把可用容量放大约 3 倍。
 */

/** 最大边长,超过则等比缩放(px)。1920 可保留 1080p 截图的文字清晰度 */
const MAX_DIMENSION = 1920

/** WebP 首选质量 */
const QUALITY = 0.82

/** 体积不降反增时的兜底质量 */
const QUALITY_FALLBACK = 0.7

/**
 * 输出格式优先级。
 * WebP 在 2026 年已获全部主流浏览器支持,且支持 alpha,因此无需再为 PNG 单独保留分支。
 */
const PREFERRED_TYPE = 'image/webp'
const FALLBACK_TYPE = 'image/jpeg'

/**
 * 这些类型跳过重编码:
 * - gif : canvas 重编码会丢失动画
 * - svg : 矢量格式,canvas 无法无损还原,且本身就是文本
 */
const PASSTHROUGH_TYPES = new Set(['image/gif', 'image/svg+xml'])

export interface SanitizeResult {
  file: File
  /** 是否真的做了重编码 */
  sanitized: boolean
  /** 重编码前的原始字节数 */
  originalSize: number
  /** 实际输出的 MIME 类型 */
  outputType?: string
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('image decode failed'))
    }
    img.src = url
  })
}

function encode(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob | null> {
  try {
    return new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, type, quality)
    })
  } catch {
    return Promise.resolve(null)
  }
}

function extensionFor(mime: string): string {
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/png') return 'png'
  return 'jpg'
}

/**
 * 剥离图片元数据 + 压缩体积。
 *
 * 非图片、GIF、SVG,以及任何解码/编码失败的场景都会**原样返回**原文件,
 * 保证上传流程永不因图片处理而中断。
 */
export async function sanitizeImageFile(file: File): Promise<SanitizeResult> {
  const passthrough: SanitizeResult = {
    file,
    sanitized: false,
    originalSize: file.size,
  }

  if (typeof window === 'undefined' || typeof document === 'undefined') return passthrough
  if (!file.type.startsWith('image/')) return passthrough
  if (PASSTHROUGH_TYPES.has(file.type)) return passthrough

  let img: HTMLImageElement
  try {
    img = await loadImage(file)
  } catch {
    return passthrough
  }

  const { naturalWidth: srcW, naturalHeight: srcH } = img
  if (!srcW || !srcH) return passthrough

  const scale = Math.min(1, MAX_DIMENSION / Math.max(srcW, srcH))
  const width = Math.max(1, Math.round(srcW * scale))
  const height = Math.max(1, Math.round(srcH * scale))

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height

  const ctx = canvas.getContext('2d')
  if (!ctx) return passthrough

  // 不铺底色 —— 让透明区域保持透明,WebP 能完整保留 alpha
  ctx.drawImage(img, 0, 0, width, height)

  // 首选 WebP;浏览器不支持时回退 JPEG
  let outputType = PREFERRED_TYPE
  let blob = await encode(canvas, PREFERRED_TYPE, QUALITY)

  if (!blob || blob.size === 0) {
    outputType = FALLBACK_TYPE
    // JPEG 没有 alpha,透明区域会变黑,先铺白底
    const flat = document.createElement('canvas')
    flat.width = width
    flat.height = height
    const flatCtx = flat.getContext('2d')
    if (!flatCtx) return passthrough
    flatCtx.fillStyle = '#ffffff'
    flatCtx.fillRect(0, 0, width, height)
    flatCtx.drawImage(canvas, 0, 0)
    blob = await encode(flat, FALLBACK_TYPE, QUALITY)
  }

  if (!blob || blob.size === 0) return passthrough

  // 极端情况下(如原本就是高度优化的小图)重编码反而更大 —— 降一档质量再试。
  // 注意:这里不会退回原文件,因为原文件带着 EXIF,隐私优先于体积。
  if (blob.size >= file.size) {
    const smaller = await encode(canvas, outputType, QUALITY_FALLBACK)
    if (smaller && smaller.size > 0 && smaller.size < blob.size) {
      blob = smaller
    }
  }

  const base = file.name.replace(/\.[^.]+$/, '') || 'image'
  const nextName = `${base}.${extensionFor(outputType)}`

  return {
    file: new File([blob], nextName, {
      type: outputType,
      lastModified: Date.now(),
    }),
    sanitized: true,
    originalSize: file.size,
    outputType,
  }
}
