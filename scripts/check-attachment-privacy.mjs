#!/usr/bin/env node
/**
 * 附件桶私有化(签名 URL)的回归测试。
 *
 * 为什么需要它:
 *  1. 数据库消息正文里存的是**公开直链**(持久引用),渲染时必须换成签名 URL,
 *     否则桶转私有后所有历史图片/文件全部裂图 —— 这是不可逆的用户可见事故。
 *  2. 解析必须**只认公开直链**:已签名的 URL、其它域名的 URL、空串都不能误判,
 *     否则会把无关 URL 也拿去签名(请求全失败)或把签名 URL 二次签名。
 *  3. 签失败时必须**保留原 URL**(降级),绝不能返回空 —— 空 src = 裂图。
 *  4. 待发送的预览 chip 用签名 URL,但**写进消息正文的必须还是公开直链**:
 *     签名 URL 会过期,存进数据库 7 天后就死了。这条最容易写反。
 *
 * 用法:  npm run attachment-privacy:check
 * 退出码: 0 = 通过  1 = 有失败项
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  parseStorageUrl,
  extractStorageRefs,
  rewriteStorageUrls,
  signStorageRefs,
  getCachedSignedUrl,
  cacheSignedUrl,
  clearSignCacheForTesting,
  SIGNED_TTL_SECONDS,
} from '../src/lib/attachment-url.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const RED = '\x1b[31m'
const GRN = '\x1b[32m'
const DIM = '\x1b[2m'
const RST = '\x1b[0m'

let pass = 0
let fail = 0

function section(title) {
  console.log(`\n══════ ${title} ══════\n`)
}

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass++
  else fail++
  const mark = ok ? `${GRN}✓${RST}` : `${RED}✗${RST}`
  const suffix = ok ? '' : `  ${RED}(期望 ${JSON.stringify(expected)})${RST}`
  console.log(`  ${mark} ${name}  ->  ${JSON.stringify(actual)}${suffix}`)
}

function assert(name, cond) {
  if (cond) pass++
  else fail++
  const mark = cond ? `${GRN}✓${RST}` : `${RED}✗${RST}`
  console.log(`  ${mark} ${name}`)
}

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8')

const PUBLIC_A = 'https://dkiyumhhvfwltvcdjykr.supabase.co/storage/v1/object/public/attachments/uploads/1729000000000-abc123.png'
const PUBLIC_B = 'https://dkiyumhhvfwltvcdjykr.supabase.co/storage/v1/object/public/attachments/uploads/1729000000001-def456.pdf'
const SIGNED = 'https://dkiyumhhvfwltvcdjykr.supabase.co/storage/v1/object/sign/attachments/uploads/x.png?token=eyJhbGciOi'

// ═════════════════════════════════════════════════════════════
section('1 · parseStorageUrl 解析')
// ═════════════════════════════════════════════════════════════
check('公开直链 → bucket + path', parseStorageUrl(PUBLIC_A), {
  bucket: 'attachments',
  path: 'uploads/1729000000000-abc123.png',
})
check('已签名的 URL → null(不能二次签名)', parseStorageUrl(SIGNED), null)
check('非 storage 域名 → null', parseStorageUrl('https://example.com/a.png'), null)
check('协议相对/缺协议 → null', parseStorageUrl('//x.supabase.co/storage/v1/object/public/attachments/a'), null)
check('空串 → null', parseStorageUrl(''), null)
check('头像桶也认(将来私有化不用改解析)', parseStorageUrl('https://dkiyumhhvfwltvcdjykr.supabase.co/storage/v1/object/public/avatars/u1/avatar.webp'), {
  bucket: 'avatars',
  path: 'u1/avatar.webp',
})

// ═════════════════════════════════════════════════════════════
section('2 · extractStorageRefs 提取(去重/保序)')
// ═════════════════════════════════════════════════════════════
check(
  'markdown 文本提取全部引用',
  extractStorageRefs(`看这张图 ![one](${PUBLIC_A}) 还有这个 [two](${PUBLIC_B})`),
  [
    { bucket: 'attachments', path: 'uploads/1729000000000-abc123.png' },
    { bucket: 'attachments', path: 'uploads/1729000000001-def456.pdf' },
  ]
)
check('重复引用去重', extractStorageRefs(`${PUBLIC_A} ${PUBLIC_A} ${PUBLIC_A}`).length, 1)
check('无引用 → 空数组(零开销快路)', extractStorageRefs('普通消息,没有链接'), [])
check('空文本 → 空数组', extractStorageRefs(''), [])

// ═════════════════════════════════════════════════════════════
section('3 · rewriteStorageUrls 改写与降级')
// ═════════════════════════════════════════════════════════════
check(
  '全部替换为签名 URL',
  rewriteStorageUrls(`x ${PUBLIC_A} y ${PUBLIC_B}`, () => 'SIGNED'),
  'x SIGNED y SIGNED'
)
check(
  'resolver 返回 null → 保留原 URL(核心降级,不能裂图)',
  rewriteStorageUrls(`x ${PUBLIC_A} y`, () => null),
  `x ${PUBLIC_A} y`
)
check(
  '无引用文本原样返回(同一引用)',
  (() => {
    const t = '纯文本'
    return rewriteStorageUrls(t, () => 'X') === t
  })(),
  true
)

// ═════════════════════════════════════════════════════════════
section('4 · 批量签名(缓存 + 失败降级)')
// ═════════════════════════════════════════════════════════════
{
  clearSignCacheForTesting()

  // 假 client:A 签得到,B 签不到(服务端对该对象返回 null)
  const fakeClient = {
    from(bucket) {
      return {
        async createSignedUrls(paths) {
          return {
            data: paths.map((p) => ({
              path: p,
              signedURL: p.includes('def456') ? null : `https://signed.example/${bucket}/${p}?token=t`,
            })),
            error: null,
          }
        },
      }
    },
  }

  const refs = extractStorageRefs(`${PUBLIC_A} ${PUBLIC_B}`)
  const result = await signStorageRefs(fakeClient, refs, SIGNED_TTL_SECONDS)
  check('签到的进了结果', result.get('attachments/uploads/1729000000000-abc123.png'), 'https://signed.example/attachments/uploads/1729000000000-abc123.png?token=t')
  check('服务端拒签的不进结果', result.has('attachments/uploads/1729000000001-def456.pdf'), false)

  // 缓存命中后不应再请求(第二次用会抛错的 client)
  const cached = getCachedSignedUrl({ bucket: 'attachments', path: 'uploads/1729000000000-abc123.png' })
  check('签名结果进了缓存', cached, 'https://signed.example/attachments/uploads/1729000000000-abc123.png?token=t')

  const boomClient = { from() { throw new Error('network down') } }
  const again = await signStorageRefs(boomClient, [{ bucket: 'attachments', path: 'uploads/1729000000000-abc123.png' }])
  check('缓存命中不发请求(throws 的 client 也安全)', again.size, 0)

  // 整批异常 → 静默降级,不抛出
  const deadClient = {
    from() {
      return {
        async createSignedUrls() {
          throw new Error('network down')
        },
      }
    },
  }
  let threw = false
  try {
    await signStorageRefs(deadClient, extractStorageRefs(PUBLIC_A))
  } catch {
    threw = true
  }
  check('网络异常整体降级不抛出', threw, false)

  // 空 refs → 不发请求
  const empty = await signStorageRefs(fakeClient, [])
  check('无引用时不发请求', empty.size, 0)

  clearSignCacheForTesting()
}

// ═════════════════════════════════════════════════════════════
section('5 · 渲染管线接线(静态扫描)')
// ═════════════════════════════════════════════════════════════
{
  const bubble = read('src/components/chat/message-bubble.tsx')
  assert('消息气泡走 useSignedText', /useSignedText\(message\.content\)/.test(bubble))
  assert('渲染用的是签名后的内容', /renderMessageContent\(signedContent, mentionNames\)/.test(bubble))
  assert('签名 hook 在 is_deleted 提前返回之前(hook 不能条件调用)', bubble.indexOf('useSignedText(message.content)') < bubble.indexOf('if (message.is_deleted)'))

  const draft = read('src/components/chat/draft-bubble.tsx')
  assert('草稿气泡也走签名', /useSignedText\(draft\.content\)/.test(draft) && /renderMessageContent\(signedContent\)/.test(draft))

  const input = read('src/components/chat/message-input.tsx')
  assert('预览 chip 用签名 URL', /a\.previewUrl \?\? a\.url/.test(input))
  // 最关键的一条:写进正文的必须是公开直链,不是签名 URL
  assert('消息正文嵌入的是公开直链(非 previewUrl)', /a\.isImage \? `!\[\$\{a\.name\}\]\(\$\{a\.url\}\)`/.test(input))
  assert('上传后即时签一个预览 URL', /createSignedUrl\(data\.path, SIGNED_TTL_SECONDS\)/.test(input))
  assert('签失败回落公开直链(不挡发送)', /let previewUrl = data\.publicUrl as string/.test(input))

  const hook = read('src/hooks/use-signed-text.ts')
  assert('无引用时原样返回(零渲染)', /if \(refs\.length === 0\) return text/.test(hook))
  assert('effect 依赖用稳定签名而非数组引用', /refsSignature/.test(hook))
}

// ═════════════════════════════════════════════════════════════
section('6 · 数据库迁移文件')
// ═════════════════════════════════════════════════════════════
{
  assert('迁移文件存在', fs.existsSync(path.join(root, 'private-attachments.sql')))
  const sql = fs.existsSync(path.join(root, 'private-attachments.sql')) ? read('private-attachments.sql') : ''
  assert('桶转私有', /UPDATE storage\.buckets\s+SET public = false\s+WHERE id = 'attachments'/.test(sql))
  assert('读取策略只给 authenticated(不是 public/anon)', /FOR SELECT\s+TO authenticated/.test(sql))
  assert('策略幂等(先 DROP 再 CREATE)', /DROP POLICY IF EXISTS "attachments_read_authenticated"/.test(sql))
  assert('avatars 明确保持 public(有意为之)', /avatars.*保持 public|保持 public/s.test(sql))
  assert('迁移文件不碰上传路径(service_role 绕过 RLS)', !/FOR (INSERT|UPDATE|DELETE)/.test(sql))
}

console.log('')
console.log(`${DIM}──────────────────────────────${RST}`)
console.log(`  ${GRN}通过 ${pass}${RST}  ${fail > 0 ? `${RED}失败 ${fail}${RST}` : `${DIM}失败 0${RST}`}`)
console.log(`${DIM}──────────────────────────────${RST}`)
process.exit(fail > 0 ? 1 : 0)
