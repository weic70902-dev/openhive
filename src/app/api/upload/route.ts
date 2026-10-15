import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getStorageProvider, KNOWN_BUCKETS } from '@/lib/storage'

// Allowed MIME types for uploads
const ALLOWED_MIME_TYPES = new Set([
  // Images
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml',
  // Documents
  'application/pdf', 'text/plain', 'text/csv',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Archives
  'application/zip', 'application/gzip',
  // Audio/Video
  'audio/mpeg', 'audio/wav', 'audio/ogg', 'video/mp4', 'video/webm',
  // Code
  'application/json', 'application/xml', 'text/html', 'text/css', 'text/javascript',
])

const MAX_FILE_SIZE = 50 * 1024 * 1024 // 50 MB
const MAX_AVATAR_SIZE = 5 * 1024 * 1024 // 5 MB

/** 上传结果缓存一年 —— 对象键含时间戳与随机串,内容不会变 */
const CACHE_CONTROL = '31536000'

// POST: Upload a file using the configured storage backend
export async function POST(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  // Supabase 在这里只承担「校验调用者身份」的职责,与文件存到哪里无关
  if (!url || !anonKey) {
    return NextResponse.json(
      { error: 'Server not configured: missing Supabase URL or anon key' },
      { status: 500 }
    )
  }

  // SECURITY: Verify caller is authenticated
  const authHeader = request.headers.get('authorization')
  if (!authHeader) {
    return NextResponse.json({ error: 'Not authenticated' }, { status: 401 })
  }

  const supabaseAuth = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: { user }, error: authError } = await supabaseAuth.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
  }

  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const bucket = (formData.get('bucket') as string) || 'attachments'
    const path = formData.get('path') as string

    if (!file || !path) {
      return NextResponse.json(
        { error: 'Missing file or path' },
        { status: 400 }
      )
    }

    // Validate bucket name
    if (!KNOWN_BUCKETS.includes(bucket as (typeof KNOWN_BUCKETS)[number])) {
      return NextResponse.json(
        { error: 'Invalid bucket name' },
        { status: 400 }
      )
    }

    // SECURITY: Validate file size
    const maxSize = bucket === 'avatars' ? MAX_AVATAR_SIZE : MAX_FILE_SIZE
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: `File too large. Maximum size is ${maxSize / 1024 / 1024} MB` },
        { status: 400 }
      )
    }

    // SECURITY: Validate MIME type
    if (file.type && !ALLOWED_MIME_TYPES.has(file.type)) {
      return NextResponse.json(
        { error: `File type "${file.type}" is not allowed` },
        { status: 400 }
      )
    }

    // SECURITY: Sanitize path — prevent directory traversal
    const sanitizedPath = path.replace(/\.\./g, '').replace(/\/\//g, '/')
    if (sanitizedPath !== path || path.includes('..')) {
      return NextResponse.json(
        { error: 'Invalid file path' },
        { status: 400 }
      )
    }

    // 交由存储后端处理。可能是 Supabase Storage,也可能是 S3 兼容对象存储
    const provider = getStorageProvider()
    const buffer = await file.arrayBuffer()

    const result = await provider.upload(buffer, {
      path: sanitizedPath,
      contentType: file.type || 'application/octet-stream',
      bucket,
      cacheControl: CACHE_CONTROL,
    })

    return NextResponse.json({
      success: true,
      publicUrl: result.url,
      provider: result.provider,
      path: result.path,
    })
  } catch (error) {
    console.error('[api/upload] 上传失败:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Upload failed' },
      { status: 500 }
    )
  }
}
