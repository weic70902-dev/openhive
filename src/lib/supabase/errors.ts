/**
 * Supabase / PostgREST 错误的可读化。
 *
 * 为什么需要这个:
 * PostgrestError 继承自 Error,但字段分布很反直觉 ——
 * `message` 来自 Error(不可枚举),`code` / `details` / `hint` 才是自有可枚举属性。
 * 直接 `console.error('失败:', err)` 时,Next.js 的开发浮层会把它序列化成 `{}`,
 * 屏幕上只剩一句「Failed to ... : {}」,排查时等于什么都没说。
 * 所以统一走这里,把关键字段拼成一行可读文本。
 */

/** 把任意抛出物整理成一行可读的错误描述。 */
export function describeSupabaseError(err: unknown): string {
  if (err === null || err === undefined) return 'unknown error'
  if (typeof err === 'string') return err

  if (err instanceof Error) {
    const extra = err as Error & { code?: string; details?: string; hint?: string }
    return [
      extra.message,
      extra.code ? `code=${extra.code}` : '',
      extra.details ? `details=${extra.details}` : '',
      extra.hint ? `hint=${extra.hint}` : '',
    ]
      .filter(Boolean)
      .join(' | ')
  }

  if (typeof err === 'object') {
    const o = err as Record<string, unknown>
    const text = [
      typeof o.message === 'string' ? o.message : '',
      o.code ? `code=${String(o.code)}` : '',
      o.details ? `details=${String(o.details)}` : '',
      o.hint ? `hint=${String(o.hint)}` : '',
    ]
      .filter(Boolean)
      .join(' | ')
    if (text) return text
    try {
      return JSON.stringify(err)
    } catch {
      return 'unknown error'
    }
  }

  return String(err)
}

/**
 * 数据库结构还没迁移到位时 Postgres / PostgREST 给出的错误码。
 * 命中这些码说明「代码已更新、数据库还没跟上」,应当引导用户执行迁移,
 * 而不是把原始报错甩给他。
 */
const SCHEMA_MISSING_CODES = new Set([
  '42P01', // Postgres: undefined_table
  '42703', // Postgres: undefined_column
  '42883', // Postgres: undefined_function
  'PGRST202', // PostgREST: 找不到该函数
  'PGRST204', // PostgREST: 请求体里带了表里没有的列
])

/** 错误是否属于「数据库结构缺失」。 */
export function isSchemaNotMigrated(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && SCHEMA_MISSING_CODES.has(code)
}

/**
 * 从 NEXT_PUBLIC_SUPABASE_URL 里取出 project ref。
 * 形如 https://abcdefghijklmn.supabase.co → abcdefghijklmn
 * 尾部斜杠是可选的 —— 环境变量里手写时很常见。
 */
export function extractProjectRef(supabaseUrl: string | undefined): string | null {
  if (!supabaseUrl) return null
  const match = supabaseUrl.trim().match(/^https:\/\/([a-z0-9-]+)\.supabase\.(co|in)\/?$/)
  return match ? match[1] : null
}
