#!/usr/bin/env node
/**
 * 「清空会话」的回归测试。
 *
 * 为什么需要它:
 *  1. 这个功能的语义是**只对我隐藏**,不是删除。一旦实现跑偏成
 *     `DELETE FROM messages`,用户以为在「隐藏」,实际把对方的聊天记录也毁了 ——
 *     不可逆。所以必须有护栏盯着「不得出现真删」。
 *  2. `channel_members` 没有 UPDATE 策略,直接 UPDATE 会被 RLS 拒掉。
 *     而「顺手补一条 cm_update 策略」是条错路:策略只能限制改哪些行,
 *     拦不住改哪些列 —— 那会顺带允许成员把自己的 role 改成 admin。
 *     测试要盯住「只写 cleared_at 一个字段」。
 *  3. 边界必须是 `created_at` **严格大于** `cleared_at`。
 *     写成「大于等于」会让恰好在同一毫秒发出的那条漏出来。
 *  4. 取 cleared_at 必须**先于**拉消息。反过来的话,清空前的消息会先闪一下
 *     再被过滤掉 —— 那恰恰是用户明确要求隐藏的内容。
 *
 * 用法:  npm run clear:check
 * 退出码: 0 = 通过  1 = 有失败项
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  isVisibleAfterClear,
  parseClearedAt,
  filterVisibleMessages,
} from '../src/lib/clear-conversation.ts'

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

const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 1 · 可见性边界(严格大于) ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const T = '2026-10-13T12:00:00.000Z'

  assert('从未清空过 → 全部可见', isVisibleAfterClear('2020-01-01T00:00:00.000Z', null))
  assert('清空时刻之前 → 不可见', !isVisibleAfterClear('2026-10-13T11:59:59.999Z', T))
  assert(
    '正好等于清空时刻 → 不可见(严格大于,否则同毫秒那条会漏出来)',
    !isVisibleAfterClear(T, T)
  )
  assert('清空时刻之后 → 可见', isVisibleAfterClear('2026-10-13T12:00:00.001Z', T))

  assert('created_at 解析不出来 → 宁可显示', isVisibleAfterClear('not-a-date', T))
  assert('cleared_at 解析不出来 → 宁可显示', isVisibleAfterClear(T, 'not-a-date'))
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 2 · parseClearedAt(脏数据兜底) ══════\n')
// ═════════════════════════════════════════════════════════════
{
  check('null → null', parseClearedAt(null), null)
  check('undefined → null', parseClearedAt(undefined), null)
  check('空串 → null', parseClearedAt(''), null)
  check('数字 → null', parseClearedAt(12345), null)
  check('对象 → null', parseClearedAt({}), null)
  check('非法日期串 → null', parseClearedAt('nope'), null)

  const iso = '2026-10-13T12:00:00.000Z'
  check('合法 ISO 串 → 原样返回', parseClearedAt(iso), iso)
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 3 · filterVisibleMessages ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const T = '2026-10-13T12:00:00.000Z'
  const msgs = [
    { id: 'a', created_at: '2026-10-13T11:00:00.000Z' },
    { id: 'b', created_at: '2026-10-13T11:30:00.000Z' },
    { id: 'c', created_at: '2026-10-13T12:30:00.000Z' },
  ]

  const same = filterVisibleMessages(msgs, null)
  assert('无截止点时返回**同一个数组引用**(避免无谓重渲染)', same === msgs)

  const kept = filterVisibleMessages(msgs, T)
  check('截止点之前的被滤掉', kept.map((m) => m.id), ['c'])

  const allHidden = filterVisibleMessages(msgs, '2027-01-01T00:00:00.000Z')
  check('全部早于截止点 → 空数组', allHidden, [])

  const noneHidden = filterVisibleMessages(msgs, '2020-01-01T00:00:00.000Z')
  assert('全部晚于截止点 → 返回同一引用', noneHidden === msgs)

  check('空数组不报错', filterVisibleMessages([], T), [])
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 4 · 数据库护栏:只隐藏,不删除 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const sqlFile = read('add-cleared-at.sql')
  const tsCopy = read('src/lib/supabase/cleared-migration.ts')
  const migrations = read('src/lib/supabase/migrations.ts')

  // migrations.ts 是个大文件,里面 purge_expired_messages 本来就有合法的
  // `DELETE FROM messages`(阅后即焚到点硬删)。所以「不得真删」这条
  // 只能针对清空功能那一段来断言,不能对整个文件。
  const migrationsClearSection =
    migrations.slice(migrations.indexOf('027 - 清空会话')) || ''

  assert('能从 migrations.ts 里切出清空功能的段落', migrationsClearSection.length > 0)

  for (const [label, src] of [
    ['独立 SQL 脚本', sqlFile],
    ['应用内 TS 副本', tsCopy],
    ['migrations.ts(仅清空段落)', migrationsClearSection],
  ]) {
    assert(
      `${label}: 新增 cleared_at 列(幂等)`,
      /ALTER TABLE channel_members ADD COLUMN IF NOT EXISTS cleared_at timestamptz;/.test(src)
    )
    assert(
      `${label}: 函数是 SECURITY DEFINER`,
      /CREATE OR REPLACE FUNCTION public\.clear_channel_for_me\(p_channel_id uuid\)/.test(src) &&
        /SECURITY DEFINER/.test(src)
    )
    assert(
      `${label}: 授权给 authenticated`,
      /GRANT EXECUTE ON FUNCTION public\.clear_channel_for_me\(uuid\) TO authenticated;/.test(src)
    )
    assert(
      `${label}: **不得**出现真删消息的语句`,
      !/DELETE\s+FROM\s+messages/i.test(src)
    )
    assert(
      `${label}: **不得**补 cm_update 策略(会顺带放开 role 等列的写入)`,
      !/POLICY\s+"?cm_update"?/.test(src)
    )
  }

  // 函数体:只允许写 cleared_at 一个字段
  const fnBody =
    sqlFile.match(
      /CREATE OR REPLACE FUNCTION public\.clear_channel_for_me[\s\S]*?\$\$;/
    )?.[0] ?? ''
  assert('能取出函数体', fnBody.length > 0)
  assert('函数体写入 cleared_at', /SET cleared_at = now\(\)/.test(fnBody))
  assert(
    '函数体不得写入其他业务列(role / notification_pref / joined_at)',
    !/\brole\b/.test(fnBody) && !/notification_pref/.test(fnBody) && !/joined_at/.test(fnBody)
  )
  assert('函数内校验已登录', /auth\.uid\(\) IS NULL/.test(fnBody))
  assert('函数内校验是本人那一行', /profile_id = auth\.uid\(\)/.test(fnBody))
  assert(
    '非成员时显式报错(而不是静默成功)',
    /RAISE EXCEPTION 'not a member of this channel'/.test(fnBody)
  )
  assert('限制了 search_path', /SET search_path = public/.test(fnBody))
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 5 · 客户端接线 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const view = read('src/components/chat/channel-view.tsx')

  assert(
    '走 RPC 而不是直接 UPDATE',
    /client\.rpc\('clear_channel_for_me', \{ p_channel_id: channel\.id \}\)/.test(view)
  )
  assert(
    '**不得**直接 update channel_members(没有 UPDATE 策略,必被 RLS 拒)',
    !/\.from\('channel_members'\)[\s\S]{0,80}\.update\(/.test(view)
  )

  const loadBody =
    view.match(/async function loadMessages\(\) \{[\s\S]*?setLoading\(false\)\n    \}/)?.[0] ?? ''
  assert('能取出 loadMessages 函数体', loadBody.length > 0)
  assert(
    'loadMessages:先取 cleared_at,再拉消息(顺序不能反)',
    loadBody.indexOf("from('channel_members')") >= 0 &&
      loadBody.indexOf("from('channel_members')") < loadBody.indexOf("from('messages')")
  )
  assert('loadMessages:读的是自己那一行', /\.eq\('profile_id', user\?\.id \?\? ''\)/.test(loadBody))
  assert('loadMessages:按截止点过滤消息', /query = query\.gt\('created_at', since\)/.test(loadBody))
  assert('loadMessages:客户端再兜一层过滤', /filterVisibleMessages\(notExpired, since\)/.test(loadBody))
  assert(
    'loadMessages:清空时不误触发「清理过期消息」的 RPC',
    /notExpired\.length !== loaded\.length/.test(loadBody)
  )

  assert(
    'loadOlderMessages:也按截止点过滤(否则能往前翻出隐藏的消息)',
    /query = query\.gt\('created_at', clearedAt\)/.test(view)
  )

  assert(
    '清空后用**数据库返回的时刻**当截止点(不用本地 Date.now())',
    /setClearedAt\(parseClearedAt\(data\)\)/.test(view)
  )
  assert('清空后本地列表立即置空', /setMessages\(\[\]\)/.test(view))
  assert('清空后关掉「还有更早消息」', /setHasMore\(false\)/.test(view))
  assert('清空后重置已请求过的阅后即焚去重集合', /seenRequestedRef\.current\.clear\(\)/.test(view))

  assert('失败时输出可读错误', /Failed to clear conversation:', describeSupabaseError\(error\)/.test(view))
  assert('失败时提示用户(不是默默无反应)', /setClearError\(/.test(view))

  assert(
    '仅私聊显示该按钮',
    /\{!isPreview && isDirectMessage && \(\s*<ClearConversationButton displayName=\{displayChannelName\} onClear=\{handleClearConversation\} \/>/.test(
      view
    )
  )
  assert(
    '清空过之后空状态有说明文案',
    /Earlier messages are hidden from your view\./.test(view)
  )
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 6 · 组件与类型 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const btn = read('src/components/chat/clear-conversation-button.tsx')
  assert('组件存在', /export function ClearConversationButton/.test(btn))
  assert('有确认对话框(清空不可逆,不能一键直落)', /<AlertDialog open=\{open\} onOpenChange=\{setOpen\}>/.test(btn))
  assert('确认文案点明「对方的记录不受影响」', /This only hides messages for you\. \{name\} keeps their copy/.test(btn))
  assert('有取消按钮', /AlertDialogCancel/.test(btn))
  assert('提交中禁用按钮(避免重复点)', /disabled=\{busy\}/.test(btn))
  assert('有 aria-label', /aria-label=\{t\('Clear conversation'\)\}/.test(btn))

  const types = read('src/types/database.ts')
  assert('ChannelMember 增加 cleared_at', /cleared_at: string \| null/.test(types))
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 7 · i18n 文案齐备 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const dict = read('src/lib/i18n/dictionary.ts')
  for (const key of [
    'Clear conversation',
    'Clear conversation?',
    'This only hides messages for you. {name} keeps their copy — nothing is deleted.',
    'Messages before now will be hidden from your view, and you will not be able to read them again.',
    'Clear',
    'Clearing…',
    'Earlier messages are hidden from your view.',
    'Failed to clear conversation',
  ]) {
    assert(`词典含「${key}」`, dict.includes(`'${key}'`))
  }
}

// ═════════════════════════════════════════════════════════════
console.log('')
if (fail > 0) {
  console.log(`${RED}✗ 清空会话检查未通过:${pass} 通过 / ${fail} 失败${RST}\n`)
  process.exit(1)
}
console.log(`${GRN}✓ 清空会话检查通过:${pass} 项全部通过${RST}`)
console.log(`${DIM}  数据来源: src/lib/clear-conversation.ts${RST}\n`)
process.exit(0)
