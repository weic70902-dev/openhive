#!/usr/bin/env node
/**
 * 阅后即焚的回归测试。
 *
 * 为什么需要它:
 *  1. 倒计时用**向上取整**。一旦改成 Math.round,「刚发出」会显示 9 秒而不是 10 秒,
 *     而且在剩余 0.4 秒时就显示 0 秒 —— 这是肉眼很难发现、但用户一定能察觉的错。
 *  2. 时长单位靠 `{n}s` 这类占位 key 拼装。若词典里漏了一条,
 *     界面上会直接冒出英文 "10s",而且 i18n 检查脚本扫不到动态拼出来的 key。
 *  3. 计时「只在开启之后发出的消息」才生效 —— 靠 SQL 里的 disappear_since 条件兜底。
 *     这条一旦被删,用户开一次开关就会把全部历史消息烧掉,属于不可逆的数据事故。
 *     而起点必须由数据库触发器用 now() 写,不能取客户端时钟,否则时钟偏差会误伤边界消息。
 *  4. 阅后即焚是**单方开启即生效**的频道级开关:任一方打开,整个会话的消息
 *     到期即焚,不需要对方也开。触发(mark_messages_seen)与校验都在数据库侧,
 *     本地绝不拿 disappearSeconds 做闸门 —— 那正是「双方都开才生效」bug 的根源。
 *
 * 用法:  npm run disappearing:check
 * 退出码: 0 = 通过  1 = 有失败项
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  DISAPPEAR_OPTIONS,
  compactDuration,
  countdownDuration,
  formatDuration,
  formatCountdown,
  isExpired,
} from '../src/lib/disappearing-messages.ts'
import {
  describeSupabaseError,
  isSchemaNotMigrated,
  extractProjectRef,
} from '../src/lib/supabase/errors.ts'
import { DISAPPEARING_MESSAGES_SQL } from '../src/lib/supabase/disappearing-migration.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const RED = '\x1b[31m'
const GRN = '\x1b[32m'
const DIM = '\x1b[2m'
const RST = '\x1b[0m'

let pass = 0
let fail = 0

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) pass++
  else fail++
  const mark = ok ? `${GRN}✓${RST}` : `${RED}✗${RST}`
  const suffix = ok ? '' : `  ${RED}(期望 ${JSON.stringify(expected)})${RST}`
  console.log(`  ${mark} ${name}  ->  ${JSON.stringify(actual)}${suffix}`)
}

function assert(name, cond, detail = '') {
  if (cond) pass++
  else fail++
  const mark = cond ? `${GRN}✓${RST}` : `${RED}✗${RST}`
  console.log(`  ${mark} ${name}${detail ? `  ${DIM}${detail}${RST}` : ''}`)
}

// ─────────────────────────────────────────────────────────────
// 词典(直接读源码,不 import —— dictionary.ts 里没有运行时依赖,
// 但保持与 check-i18n.mjs 一致的解析方式更稳妥)
// ─────────────────────────────────────────────────────────────
const dictSrc = fs.readFileSync(path.join(root, 'src/lib/i18n/dictionary.ts'), 'utf8')
const zhStart = dictSrc.indexOf('export const zh')
const zhBody = dictSrc.slice(zhStart, dictSrc.indexOf('\n}', zhStart))
const dict = new Map()
for (const m of zhBody.matchAll(/^\s{2}(?:'((?:[^'\\]|\\.)*)'|([A-Za-z_$][\w$]*))\s*:\s*'((?:[^'\\]|\\.)*)'/gm)) {
  const key = (m[1] ?? m[2]).replace(/\\'/g, "'").replace(/\\\\/g, '\\')
  dict.set(key, m[3].replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
}

/** 与运行时同款翻译(未命中回退 key) */
function t(key, vars) {
  let out = dict.get(key) ?? key
  if (vars) for (const k of Object.keys(vars)) out = out.split(`{${k}}`).join(String(vars[k]))
  return out
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 1 · 时长选项表 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  check('选项数量', DISAPPEAR_OPTIONS.length, 7)
  check('第一项是「关闭」', DISAPPEAR_OPTIONS[0].seconds, null)

  const secs = DISAPPEAR_OPTIONS.slice(1).map((o) => o.seconds)
  assert('除关闭外均为正整数', secs.every((s) => Number.isInteger(s) && s > 0), secs.join(' / '))
  assert(
    '严格递增(菜单顺序不能乱)',
    secs.every((s, i) => i === 0 || s > secs[i - 1]),
    secs.join(' < ')
  )
  assert('无重复时长', new Set(secs).size === secs.length)

  const missingLabels = DISAPPEAR_OPTIONS.filter((o) => !dict.has(o.label)).map((o) => o.label)
  assert('每个选项文案都有中文', missingLabels.length === 0, missingLabels.join(', ') || '全部命中')
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 2 · compactDuration(固定时长) ══════\n')
// ═════════════════════════════════════════════════════════════
check('10 秒', compactDuration(10), { value: 10, unit: 's' })
check('59 秒仍是秒', compactDuration(59), { value: 59, unit: 's' })
check('60 秒进位为分', compactDuration(60), { value: 1, unit: 'm' })
check('300 秒 = 5 分', compactDuration(300), { value: 5, unit: 'm' })
check('3599 秒仍是分', compactDuration(3599), { value: 60, unit: 'm' })
check('3600 秒进位为时', compactDuration(3600), { value: 1, unit: 'h' })
check('86400 秒进位为天', compactDuration(86400), { value: 1, unit: 'd' })
check('0 秒不报错', compactDuration(0), { value: 0, unit: 's' })
check('负数被夹到 0', compactDuration(-5), { value: 0, unit: 's' })

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 3 · countdownDuration(实时倒计时,必须向上取整) ══════\n')
// ═════════════════════════════════════════════════════════════
check('刚发出(整 10 秒)', countdownDuration(10_000), { value: 10, unit: 's' })
check('剩 9.999 秒仍显示 10', countdownDuration(9_999), { value: 10, unit: 's' })
check('剩 0.001 秒显示 1(而不是 0)', countdownDuration(1), { value: 1, unit: 's' })
check('剩 0 毫秒显示 0', countdownDuration(0), { value: 0, unit: 's' })
check('负数夹到 0', countdownDuration(-1000), { value: 0, unit: 's' })
check('剩 59 秒', countdownDuration(59_000), { value: 59, unit: 's' })
check('剩整 1 分钟进位为分', countdownDuration(60_000), { value: 1, unit: 'm' })
check('剩 1 分 1 秒向上取整为 2 分', countdownDuration(61_000), { value: 2, unit: 'm' })
check('剩 1 小时', countdownDuration(3_600_000), { value: 1, unit: 'h' })
check('剩 1 天', countdownDuration(86_400_000), { value: 1, unit: 'd' })

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 4 · isExpired(销毁判定) ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const now = Date.parse('2026-01-01T00:00:00.000Z')
  const at = (offsetMs) => new Date(now + offsetMs).toISOString()

  check('未设置销毁时刻 → 不过期', isExpired(null, now), false)
  check('销毁时刻已过 → 过期', isExpired(at(-1), now), true)
  check('销毁时刻未到 → 不过期', isExpired(at(1), now), false)
  check('正好到点 → 过期(边界必须算过期)', isExpired(at(0), now), true)
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 5 · 文案组装(单位必须本地化) ══════\n')
// ═════════════════════════════════════════════════════════════check('10 秒 → 中文', formatDuration(10, t), '10秒')
check('5 分钟 → 中文', formatDuration(300, t), '5分')
check('1 小时 → 中文', formatDuration(3600, t), '1时')
check('24 小时 → 1天', formatDuration(86400, t), '1天')
check('倒计时 9.2 秒', formatCountdown(9_200, t), '10秒')
check('倒计时 0', formatCountdown(0, t), '0秒')

const unitKeys = ['{n}s', '{n}m', '{n}h', '{n}d']
const missingUnits = unitKeys.filter((k) => !dict.has(k))
assert('四个单位占位 key 都在词典里', missingUnits.length === 0, missingUnits.join(', ') || '全部命中')

// 英文回退:词典里没命中时应当原样输出,不能拼出 "10undefined"
const raw = formatDuration(300, (k, v) => (v ? k.split('{n}').join(String(v.n)) : k))
check('英文界面回退为 5m', raw, '5m')

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 6 · 数据库侧护栏(静态扫描) ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const files = [
    'src/lib/supabase/migrations.ts',
    'src/lib/supabase/disappearing-migration.ts',
    'add-disappearing-messages.sql',
  ]
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), 'utf8')
    const name = path.basename(f)

    assert(
      `${name} · 有 disappear_since 列`,
      /disappear_since\s+timestamptz/.test(src)
    )
    assert(
      `${name} · mark_messages_seen 校验生效起点`,
      /c\.disappear_since IS NULL OR m\.created_at >= c\.disappear_since/.test(src)
    )
    assert(
      `${name} · mark_messages_seen 排除本人消息`,
      /m\.sender_id IS DISTINCT FROM auth\.uid\(\)/.test(src)
    )
    assert(
      `${name} · purge 只删过期消息`,
      /m\.expires_at <= now\(\)/.test(src)
    )
    assert(
      `${name} · messages 开启 REPLICA IDENTITY FULL(DELETE 同步需要)`,
      /ALTER TABLE messages REPLICA IDENTITY FULL/.test(src)
    )
    assert(
      `${name} · 有 channels_disappear_since 触发器`,
      /CREATE TRIGGER channels_disappear_since/.test(src) &&
        /BEFORE INSERT OR UPDATE ON channels/.test(src)
    )
    assert(
      `${name} · 触发器用 now() 写起点(不用客户端时钟)`,
      /NEW\.disappear_since := CASE WHEN NEW\.disappear_seconds IS NULL THEN NULL ELSE now\(\) END/.test(src)
    )
    assert(
      `${name} · 两个函数都是 SECURITY DEFINER`,
      (src.match(/SECURITY DEFINER/g) || []).length >= 2
    )
  }
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 7 · 错误可读化与结构探测 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  // 这一节防的是真实踩过的坑:PostgrestError 的 message 继承自 Error(不可枚举),
  // 直接 console.error(err) 在 Next.js 开发浮层里显示成 `{}`,报错等于没报。
  const real = {
    code: '42703',
    details: null,
    hint: null,
    message: 'column channels.disappear_seconds does not exist',
  }
  const described = describeSupabaseError(real)
  assert(
    '真实 PostgrestError 能读出 message(而不是 `{}`)',
    described.includes('column channels.disappear_seconds does not exist'),
    described
  )
  assert('同时带上错误码', described.includes('code=42703'), described)

  check('null → unknown error', describeSupabaseError(null), 'unknown error')
  check('字符串原样返回', describeSupabaseError('boom'), 'boom')
  check('Error 实例取 message', describeSupabaseError(new Error('boom')), 'boom')
  check('空对象兜底为 JSON', describeSupabaseError({}), '{}')

  const withHint = describeSupabaseError({ message: 'm', code: 'X', details: 'd', hint: 'h' })
  assert('details / hint 一并带上', withHint === 'm | code=X | details=d | hint=h', withHint)

  // ── 结构缺失判定 ──
  check('42703 未定义列 → 视为未迁移', isSchemaNotMigrated({ code: '42703' }), true)
  check('42P01 未定义表 → 视为未迁移', isSchemaNotMigrated({ code: '42P01' }), true)
  check('42883 未定义函数 → 视为未迁移', isSchemaNotMigrated({ code: '42883' }), true)
  check('PGRST204 未知列 → 视为未迁移', isSchemaNotMigrated({ code: 'PGRST204' }), true)
  check('PGRST202 未知函数 → 视为未迁移', isSchemaNotMigrated({ code: 'PGRST202' }), true)
  check('23505 唯一键冲突 → 不是结构问题', isSchemaNotMigrated({ code: '23505' }), false)
  check('null → 不是结构问题', isSchemaNotMigrated(null), false)
  check('非字符串 code → 不是结构问题', isSchemaNotMigrated({ code: 42703 }), false)
  check('无 code → 不是结构问题', isSchemaNotMigrated({ message: 'x' }), false)

  // ── project ref 解析 ──
  check('.co 域名', extractProjectRef('https://abcdefghijklmn.supabase.co'), 'abcdefghijklmn')
  check('.in 域名(印度区)', extractProjectRef('https://abcdefghijklmn.supabase.in'), 'abcdefghijklmn')
  check('带尾部斜杠', extractProjectRef('https://abcdefghijklmn.supabase.co/'), 'abcdefghijklmn')
  check('undefined → null', extractProjectRef(undefined), null)
  check('空串 → null', extractProjectRef(''), null)
  check('非 Supabase 域名 → null', extractProjectRef('https://example.com'), null)
  check('http(非 https)→ null', extractProjectRef('http://x.supabase.co'), null)

  // ── 应用内可执行的迁移脚本 ──
  assert(
    'TS 里的迁移脚本包含 REPLICA IDENTITY FULL',
    /ALTER TABLE messages REPLICA IDENTITY FULL/.test(DISAPPEARING_MESSAGES_SQL)
  )
  assert(
    'TS 里的迁移脚本包含 mark_messages_seen',
    /CREATE OR REPLACE FUNCTION public\.mark_messages_seen/.test(DISAPPEARING_MESSAGES_SQL)
  )
  assert(
    'TS 里的迁移脚本包含 purge_expired_messages',
    /CREATE OR REPLACE FUNCTION public\.purge_expired_messages/.test(DISAPPEARING_MESSAGES_SQL)
  )
  assert(
    'TS 里的迁移脚本包含 GRANT',
    /GRANT EXECUTE ON FUNCTION public\.mark_messages_seen/.test(DISAPPEARING_MESSAGES_SQL)
  )
  assert(
    '迁移脚本不包含模板插值残留',
    !/\$\{/.test(DISAPPEARING_MESSAGES_SQL)
  )

  // ── 组件侧护栏:不许再把错误原样丢进 console ──
  const menu = fs.readFileSync(path.join(root, 'src/components/chat/disappear-timer-menu.tsx'), 'utf8')
  assert('计时器菜单用 describeSupabaseError 输出错误', /describeSupabaseError\(updateError\)/.test(menu))
  assert('计时器菜单会探测数据库结构', /isSchemaNotMigrated\(probeError\)/.test(menu))
  assert('计时器菜单提供迁移入口', /DISAPPEARING_MESSAGES_SQL/.test(menu))

  const view = fs.readFileSync(path.join(root, 'src/components/chat/channel-view.tsx'), 'utf8')
  assert(
    '会话视图的 RPC 报错也已可读化',
    (view.match(/describeSupabaseError\(error\)/g) || []).length >= 3
  )
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 8 · 「单方开启即生效」护栏 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const view = fs.readFileSync(path.join(root, 'src/components/chat/channel-view.tsx'), 'utf8')

  // 曾经的 bug:阅读触发被本地 disappearSeconds 闸门挡着,而 channels 没有实时
  // 订阅 —— 对方不开(或本地数据过期)就永远没人调 mark_messages_seen,
  // 消息永远不烧,表现为「要双方都开才生效」。
  assert(
    '阅读触发不再被本地开关闸门挡住(disappearSeconds === null || loading 已拆除)',
    !/if \(disappearSeconds === null \|\| loading/.test(view)
  )
  assert(
    '阅读触发仍会调 mark_messages_seen',
    /client\.rpc\('mark_messages_seen', \{ p_message_ids: pending \}\)/.test(view)
  )
  assert('订阅 channels 的 UPDATE(对方开开关,本地立刻同步)', /table: 'channels'/.test(view))
  assert('订阅只听当前会话(带 id 过滤)', /filter: `id=eq\.\$\{channel\.id\}`/.test(view))
  assert('收到 UPDATE 后写回 store', /updateChannel\(channel\.id, payload\.new as Channel\)/.test(view))
  assert('该订阅在清理时退订(不漏 channel)', /settingsSub\.unsubscribe\(\)/.test(view))

  // 「单方开启」的底气在 SQL:本地可以无脑调,由数据库决定到底写不写 expires_at。
  const sql = fs.readFileSync(path.join(root, 'src/lib/supabase/migrations.ts'), 'utf8')
  const fnStart = sql.indexOf('CREATE OR REPLACE FUNCTION public.mark_messages_seen')
  const fnEnd = sql.indexOf('CREATE OR REPLACE FUNCTION', fnStart + 10)
  const fn = sql.slice(fnStart, fnEnd === -1 ? undefined : fnEnd)
  assert('RPC 只认数据库里的频道开关(c.disappear_seconds IS NOT NULL)', /AND c\.disappear_seconds IS NOT NULL/.test(fn))
  assert('RPC 排除本人消息(只有阅读方触发)', /AND m\.sender_id IS DISTINCT FROM auth\.uid\(\)/.test(fn))
  assert('RPC 校验调用者是会话成员', /EXISTS \(\s*SELECT 1 FROM channel_members cm/.test(fn))
  assert('RPC 不重复计时(已有时刻不覆盖)', /AND m\.expires_at IS NULL/.test(fn))

  const store = fs.readFileSync(path.join(root, 'src/lib/store/app-store.ts'), 'utf8')
  assert(
    'updateChannel 同时覆盖 channels 与 dmChannels(私聊也跟着同步)',
    /updateChannel: \(channelId, updates\) =>[\s\S]*?dmChannels: state\.dmChannels\.map/.test(store)
  )
}

// ═════════════════════════════════════════════════════════════
console.log('')
if (fail > 0) {
  console.log(`${RED}✗ 阅后即焚检查未通过:${pass} 通过 / ${fail} 失败${RST}\n`)
  process.exit(1)
}
console.log(`${GRN}✓ 阅后即焚检查通过:${pass} 项全部通过${RST}`)
console.log(`${DIM}  数据来源: src/lib/disappearing-messages.ts${RST}\n`)
process.exit(0)
