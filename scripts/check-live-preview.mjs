#!/usr/bin/env node
/**
 * 输入实时预览(草稿广播)的回归测试。
 *
 * 为什么需要它:
 *  1. 节流器是「首帧立即 + 尾随补发」,不是纯 debounce。写成 debounce 的话
 *     连续打字期间一次都不发,对方要等你停手才看得到 —— 实时预览就废了。
 *     这个行为差异肉眼很难察觉,必须固化成测试。
 *  2. 空串是「清空草稿」的控制信号,必须绕过节流立刻送达;
 *     否则发送消息后对方那边会多挂 180ms 的幽灵草稿。
 *  3. pruneDrafts 在无过期项时必须**原样返回同一个对象引用**。
 *     它被 setState 每秒调用一次,引用一变就会让整个消息列表每秒重渲染。
 *  4. 这个功能的语义是「预发布」,容易被写错:
 *     · 开关是**按会话**的(不是全局布尔),因为用户是「和谁聊才开」;
 *     · 只有**发送方**需要开启,接收方什么都不用做就该看到 ——
 *       订阅一旦被开关守卫住,功能就废了(这正是修过的 bug);
 *     · 草稿气泡会自己长高,不跟着滚到底部就会藏在列表下方,
 *       用户得手动往下拉才看得见(这也是修过的 bug)。
 *  5. 预览的**作用范围**由心跳划定:只要会话页面开着、开关开着,
 *     草稿常驻,失焦/切页/长时间停顿都不熄灭;只有「关掉当前对话页面」
 *     「关掉预览开关」两种情况才隐藏。TTL 因此只是崩溃/断网的兜底,
 *     不再是「停手就撤」的计时器。
 *
 * 用法:  npm run live:check
 * 退出码: 0 = 通过  1 = 有失败项
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  createDraftBroadcaster,
  pruneDrafts,
  isStaleClear,
  draftTopic,
  DRAFT_TTL_MS,
  DRAFT_THROTTLE_MS,
  DRAFT_HEARTBEAT_MS,
} from '../src/lib/live-preview.ts'

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 用很短的节流窗口,让测试跑得快
const TH = 40

function makeRecorder() {
  const sent = []
  return { sent, send: (c) => sent.push(c) }
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 1 · 主题命名 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const a = draftTopic('chan-a')
  const b = draftTopic('chan-b')
  check('主题包含 channelId', a, 'draft:chan-a')
  assert('不同会话主题不同(不会串台)', a !== b, `${a} vs ${b}`)
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 2 · 节流器:首帧立即 + 尾随补发 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const { sent, send } = makeRecorder()
  const b = createDraftBroadcaster(send, TH)

  b.push('你')
  check('首次输入立即发出(不等节流窗口)', sent, ['你'])

  b.push('你好')
  b.push('你好啊')
  check('窗口内的连续输入不重复发送', sent, ['你'])

  await sleep(TH + 30)
  check('窗口结束后补发最后一次内容(尾随发送)', sent, ['你', '你好啊'])

  b.dispose()
}

{
  const { sent, send } = makeRecorder()
  const b = createDraftBroadcaster(send, TH)

  b.push('a')
  await sleep(TH + 20)
  b.push('b')
  check('超过节流窗口后再次立即发送', sent, ['a', 'b'])

  b.dispose()
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 3 · 空串 = 清空信号,必须绕过节流 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const { sent, send } = makeRecorder()
  const b = createDraftBroadcaster(send, TH)

  b.push('草稿')
  b.push('')
  check('紧接着的空串立刻送达,不等窗口', sent, ['草稿', ''])

  await sleep(TH + 30)
  check('空串不会在窗口结束后被重复发送', sent, ['草稿', ''])

  b.dispose()
}

{
  const { sent, send } = makeRecorder()
  const b = createDraftBroadcaster(send, TH)

  // 窗口内先排一个待发内容,再清空 —— 清空必须把待发内容顶掉
  b.push('x')
  b.push('xy')
  b.push('')
  await sleep(TH + 30)
  check('清空会顶掉窗口内待发的内容', sent, ['x', ''])

  b.dispose()
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 4 · flush 与 dispose ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const { sent, send } = makeRecorder()
  const b = createDraftBroadcaster(send, TH)

  b.push('a')
  b.push('ab')
  b.flush('ab')
  check('flush 跳过窗口立即发送', sent, ['a', 'ab'])

  await sleep(TH + 30)
  check('flush 之后不会再有补发', sent, ['a', 'ab'])

  b.dispose()
}

{
  const { sent, send } = makeRecorder()
  const b = createDraftBroadcaster(send, TH)

  b.push('a')
  b.push('ab') // 进入待发
  b.dispose()
  await sleep(TH + 30)
  check('dispose 取消待发内容(退出会话不再打扰对方)', sent, ['a'])
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 5 · pruneDrafts(过期清理) ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const now = 1_000_000
  const mk = (userId, ageMs, content = 'x') => [userId, { userId, displayName: userId, avatarUrl: null, content, sentAt: now - ageMs }]

  const fresh = Object.fromEntries([mk('u1', 0), mk('u2', DRAFT_TTL_MS - 1)])
  const same = pruneDrafts(fresh, now)
  assert(
    '没有过期项时返回同一个对象引用(避免每秒重渲染)',
    same === fresh
  )

  const mixed = Object.fromEntries([mk('u1', 0), mk('u2', DRAFT_TTL_MS + 1)])
  const pruned = pruneDrafts(mixed, now)
  check('过期项被剔除', Object.keys(pruned), ['u1'])

  const boundary = Object.fromEntries([mk('u1', DRAFT_TTL_MS)])
  check('正好到 TTL 即视为过期', Object.keys(pruneDrafts(boundary, now)), [])

  const allGone = Object.fromEntries([mk('u1', DRAFT_TTL_MS + 1), mk('u2', DRAFT_TTL_MS + 2)])
  check('全部过期 → 空对象', pruneDrafts(allGone, now), {})

  check('空输入不报错', pruneDrafts({}, now), {})
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 6 · 常量护栏 ══════\n')
// ═════════════════════════════════════════════════════════════
{
  assert('TTL 足够长(不短于 15 秒,正常停顿/切页不熄灭预览)', DRAFT_TTL_MS >= 15000, `${DRAFT_TTL_MS}ms`)
  assert('TTL 不过长(不超过 60 秒,崩溃/断网的幽灵草稿有界)', DRAFT_TTL_MS <= 60000, `${DRAFT_TTL_MS}ms`)
  assert('节流窗口足够短(不超过 400ms 才算实时)', DRAFT_THROTTLE_MS <= 400, `${DRAFT_THROTTLE_MS}ms`)
  assert('节流窗口不为 0(否则每个字符都发一次)', DRAFT_THROTTLE_MS > 0, `${DRAFT_THROTTLE_MS}ms`)
  assert('心跳间隔合理(1~5 秒:够保活又不吵闹)', DRAFT_HEARTBEAT_MS >= 1000 && DRAFT_HEARTBEAT_MS <= 5000, `${DRAFT_HEARTBEAT_MS}ms`)
  assert(
    'TTL 至少覆盖 3 个心跳周期(后台标签页定时器降频也不误杀)',
    DRAFT_TTL_MS >= DRAFT_HEARTBEAT_MS * 3,
    `TTL=${DRAFT_TTL_MS} vs 3×HB=${DRAFT_HEARTBEAT_MS * 3}`
  )
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 7 · 「不落库 / 按会话独立 / 接收方免开关」护栏(静态扫描) ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

  // ── 7.1 核心模块不落库 ────────────────────────────────────
  const lib = read('src/lib/live-preview.ts')
  assert('核心模块完全不碰数据库', !/from\(['"]messages['"]\)/.test(lib))
  assert('核心模块不引入 supabase 客户端', !/supabase/.test(lib))

  // ── 7.2 语义:接收方不需要开启开关 ────────────────────────
  const view = read('src/components/chat/channel-view.tsx')

  assert(
    '订阅只受「预览频道」限制,不再受开关限制(接收方无需开启)',
    /if \(isPreview \|\| !user\) \{/.test(view)
  )
  assert(
    '订阅守卫里已不存在 livePreviewEnabled(旧语义残留)',
    !/if \(isPreview \|\| !livePreviewEnabled/.test(view)
  )
  assert(
    '未加入的预览频道也不订阅',
    /唯一的例外是预览\(未加入\)的频道/.test(view)
  )
  assert(
    '开关按会话判定(不是全局布尔)',
    /const livePreviewEnabled = livePreviewChannelIds\.includes\(channel\.id\)/.test(view)
  )
  assert(
    '发送端仍受开关守卫(关闭时不广播)',
    /if \(!livePreviewEnabled\) return/.test(view)
  )
  assert(
    '输入框始终接收草稿回调(不再条件传 undefined)',
    /onDraftChange=\{handleDraftChange\}/.test(view)
  )
  assert(
    '已无「按开关决定是否传回调」的旧写法',
    !/onDraftChange=\{livePreviewEnabled \?/.test(view)
  )
  assert(
    '关闭开关时立刻通知对方撤掉草稿(不等 TTL)',
    /draftBroadcasterRef\.current\?\.flush\(''\)/.test(view)
  )
  assert('订阅时不接收自己的广播(self: false)', /broadcast: \{ self: false \}/.test(view))
  assert('渲染草稿气泡', /<DraftBubble key=\{d\.userId\} draft=\{d\} \/>/.test(view))

  // ── 7.3 草稿气泡自动滚动(本次修复的 bug) ──────────────────
  assert(
    '滚动位置被持续记录(判定用户是否贴底)',
    /nearBottomRef\.current =\s*container!\.scrollHeight - container!\.scrollTop - container!\.clientHeight < NEAR_BOTTOM_MARGIN/.test(
      view
    )
  )
  assert('打开会话时默认视为贴底', /nearBottomRef\.current = true/.test(view))

  const scrollEffect =
    view.match(/const draftSignature = JSON\.stringify\(drafts\)[\s\S]{0,700}?\}, \[draftSignature\]\)/)?.[0] ?? ''
  assert('存在草稿变更 → 滚动到底部的 effect', scrollEffect.length > 0)
  assert('草稿更新时滚到底部', /container\.scrollTop = container\.scrollHeight/.test(scrollEffect))
  assert(
    '只在用户贴着底部时才跟随(不打断正在翻历史的人)',
    /if \(!nearBottomRef\.current\) return/.test(scrollEffect)
  )
  assert(
    '空草稿时不滚动(避免无谓的滚动抖动)',
    /if \(draftSignature === '\{\}'\) return/.test(scrollEffect)
  )
  assert('用瞬时跳转而非平滑滚动(避免被 180ms 高频更新打断)', !/behavior:/.test(scrollEffect))

  // ── 7.4 开关放在会话头部(按会话独立) ─────────────────────
  assert(
    '会话头部渲染 LivePreviewToggle 并接上按会话的开关',
    /\{!isPreview && \(\s*<LivePreviewToggle enabled=\{livePreviewEnabled\} onToggle=\{handleToggleLivePreview\} \/>/.test(
      view
    )
  )

  const toggle = read('src/components/chat/live-preview-toggle.tsx')
  assert('开关组件存在', /export function LivePreviewToggle/.test(toggle))
  assert('开关有 aria-pressed 无障碍状态', /aria-pressed=\{enabled\}/.test(toggle))
  assert('开关按状态切换图标(Eye / EyeOff)', /<Eye /.test(toggle) && /<EyeOff /.test(toggle))
  assert('开关文案区分开/关两种语义', /Live typing preview is on/.test(toggle) && /Live typing preview is off/.test(toggle))

  // ── 7.5 草稿气泡只渲染,不写库 ────────────────────────────
  const bubble = read('src/components/chat/draft-bubble.tsx')
  assert('草稿气泡只渲染,不写库', !/from\(['"]messages['"]\)/.test(bubble))
  assert('草稿气泡走 DOMPurify 消毒', /DOMPurify\.sanitize/.test(bubble))

  // ── 7.6 store:按会话 id 数组持久化 ────────────────────────
  const store = read('src/lib/store/app-store.ts')
  assert('默认值为空数组(全部会话默认关闭)', /livePreviewChannelIds: \[\],/.test(store))
  assert('已无全局布尔开关(旧语义残留)', !/livePreviewEnabled: false/.test(store))
  assert(
    '开启时把会话 id 并入集合(去重)',
    /Array\.from\(new Set\(\[\.\.\.state\.livePreviewChannelIds, channelId\]\)\)/.test(store)
  )
  assert(
    '关闭时只移除该会话(不影响其他会话)',
    /state\.livePreviewChannelIds\.filter\(\(id\) => id !== channelId\)/.test(store)
  )
  assert(
    '存储键是「频道集合」而非全局开关',
    /LIVE_PREVIEW_STORAGE_KEY = 'openhive:live-preview-channels'/.test(store)
  )
  assert('水合时过滤脏数据(非字符串/空串)', /typeof v === 'string' && v\.length > 0/.test(store))
  assert('水合时清理旧版全局开关键', /removeItem\(LEGACY_LIVE_PREVIEW_KEY\)/.test(store))
  assert('水合方法在挂载后调用', /hydrateLivePreview\(\)/.test(read('src/components/sidebar/sidebar.tsx')))
  assert('侧边栏已无全局开关 UI', !/livePreviewEnabled/.test(read('src/components/sidebar/sidebar.tsx')))
  assert('退出登录不清空该偏好(它是本机设置)', /不清空 livePreviewChannelIds/.test(store))

  // ── 7.7 输入框 ────────────────────────────────────────────
  const input = read('src/components/chat/message-input.tsx')
  assert('发送成功后立刻清空对方草稿', /onDraftChangeRef\.current\?\.\(''\)/.test(input))
  assert('输入变化时回调草稿', /onDraftChangeRef\.current\?\.\(text\)/.test(input))
  // IME 组合(中文等输入法)的实时预览路径:
  //  · onUpdate 只管非组合态(组合中 getText() 可能读到空串/半截,
  //    误发空串 = 误发「清空草稿」,会抹掉对方的活草稿);
  //  · 组合期逐拍推送由 compositionupdate 负责(读 DOM 当前文本,
  //    中文边打边看,无延时);
  //  · compositionend 补发最终文本(含空串 = 正常清空)。
  assert('onUpdate 内组合态不广播(guard: composing)', /if \(!editor\.view\.composing\) \{/.test(input))
  const onUpdate = input.match(/onUpdate: \(\{ editor \}\) => \{[\s\S]*?editorProps:/)?.[0] ?? ''
  assert('组合守卫位于 onUpdate 内,且包住草稿回调', /if \(!editor\.view\.composing\) \{[\s\S]*?onDraftChangeRef\.current\?\.\(text\)/.test(onUpdate))
  assert('监听 IME compositionupdate(组合期逐拍实时推送)', /compositionupdate: \(view\) =>/.test(input))
  const compUpdate = input.match(/compositionupdate: \(view\) => \{[\s\S]*?return false/)?.[0] ?? ''
  assert('compositionupdate 读编辑区当前文本(读到正在输入的字)', /view\.dom\.textContent/.test(compUpdate))
  assert('组合期空文本不推送(防止误发清空信号)', /if \(imeText !== ''\) onDraftChangeRef\.current\?\.\(imeText\)/.test(input))
  assert('监听 IME compositionend(组合结束补发最终文本)', /compositionend: \(view\) =>/.test(input))
  const compEnd = input.match(/compositionend: \(view\) => \{[\s\S]*?return false/)?.[0] ?? ''
  assert('compositionend 补发编辑区文本(允许空串 = 正常清空)', /onDraftChangeRef\.current\?\.\(view\.dom\.textContent \?\? ''\)/.test(compEnd))
  assert('组合事件挂在 editorProps.handleDOMEvents 上', /handleDOMEvents: \{[\s\S]*?compositionupdate/.test(input))

  // ── 7.8 i18n 文案齐备 ─────────────────────────────────────
  const dict = read('src/lib/i18n/dictionary.ts')
  assert('状态条文案已入词典', /'Live typing preview is on — what you type is visible before you send it\.'/.test(dict))
  assert('开关 title 文案已入词典(开)', /'Live typing preview is on — others see what you type before you send'/.test(dict))
  assert('开关 title 文案已入词典(关)', /'Live typing preview is off — others only see messages you send'/.test(dict))

  // ── 7.9 乱序/迟到的「清空」不得抹掉活草稿 ─────────────────
  // Supabase broadcast 会乱序/重复投递;迟到的旧空串若照收,会把正在打字的草稿清掉。
  check('从未有过内容 → 清空照常生效', isStaleClear(Date.now(), undefined), false)
  check('清空与内容同一毫秒 → 清空生效', isStaleClear(100, 100), false)
  check('清空晚于内容(正常清空)→ 生效', isStaleClear(200, 100), false)
  check('清空早于最新内容(迟到/乱序)→ 忽略,保住活草稿', isStaleClear(100, 200), true)
  assert(
    '接收处记下每个用户最后一次有效内容的 sentAt',
    /lastContentSentAtRef\.current\[p\.userId\] = p\.sentAt/.test(view)
  )
  assert(
    '收到空串前先用 isStaleClear 过滤迟到的旧清空',
    /if \(isStaleClear\(p\.sentAt, lastContentSentAtRef\.current\[p\.userId\]\)\) return/.test(view)
  )
  assert(
    '换会话时重置 lastContentSentAt(避免上一会话污染判定)',
    /lastContentSentAtRef\.current = \{\}/.test(view)
  )
  assert(
    '正常清空成功后清理该用户的 lastContentAt',
    /delete lastContentSentAtRef\.current\[p\.userId\]/.test(view)
  )

  // ── 7.10 作用范围:预览常驻,失焦/切页不清空 ─────────────────
  // 用户要求:只要开着预览、开着对话页面,草稿就一直显示在对方聊天里;
  // 只有「关掉当前对话页面」「关掉预览开关」两种情况才隐藏。
  assert('输入框没有 onBlur 清空逻辑(失焦不清草稿)', !/onBlur/.test(input))
  assert('输入框不监听 visibilitychange(切页不清草稿)', !/visibilitychange/.test(input))
  assert('发送端有心跳保活机制(停顿也不熄灭预览)', /DRAFT_HEARTBEAT_MS/.test(lib))
  assert('广播器按节奏重发最后内容(心跳实现)', /send\(lastContent\)/.test(lib))
  assert('没有草稿时心跳停摆(不空转、不清空后反复发)', /if \(heartbeatMs <= 0 \|\| lastContent === ''\)/.test(lib))
  assert('dispose 时停掉心跳(销毁后不再广播)', /clearTimer\(\)\s*\n\s*stopHeartbeat\(\)/.test(lib))
  assert('关标签页时尽力撤草稿(pagehide 监听)', /addEventListener\('pagehide'/.test(view))
  assert('pagehide 里走 flush 立即送达(跳过节流)', /const onPageHide = \(\) => \{[\s\S]*?flush\(''\)/.test(view))
  assert('pagehide 监听在清理时移除(不漏监听)', /removeEventListener\('pagehide', onPageHide\)/.test(view))
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 8 · 双方共存:打字绝不抹掉对方预览(运行时) ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const longSleep = (ms) => new Promise((r) => setTimeout(r, ms))

  // 复刻 channel-view 的接收状态机(含乱序守卫)、频道订阅(self:false)与投递
  function mkClient(userId, hub) {
    let drafts = {}
    const lastContentAt = {}
    const ch = { selfDeliver: true }
    function recv(fromId, content, sentAt) {
      if (!fromId || fromId === userId) return
      if (content) {
        lastContentAt[fromId] = sentAt
        drafts = { ...drafts, [fromId]: { userId: fromId, content, sentAt: Date.now() } }
        return
      }
      if (isStaleClear(sentAt, lastContentAt[fromId])) return // 迟到的旧清空 → 忽略
      delete lastContentAt[fromId]
      if (fromId in drafts) { const n = { ...drafts }; delete n[fromId]; drafts = n }
    }
    const bc = createDraftBroadcaster((content) => {
      const sentAt = Date.now()
      for (const peer of hub) {
        if (peer.userId === userId && !peer.ch.selfDeliver) continue
        peer.recv(userId, content, sentAt)
      }
    }, 40, 60) // 节流 40ms / 心跳 60ms:测试跑得快,又能验证保活
    return { userId, ch, recv, type: (c) => bc.push(c), clear: () => bc.push(''), get drafts() { return drafts } }
  }
  const show = (c) => JSON.stringify(Object.fromEntries(Object.entries(c.drafts).map(([k, v]) => [k, v.content])))

  const hub = []
  const A = mkClient('A', hub); const B = mkClient('B', hub)
  hub.push(A, B)

  for (const selfDeliver of [true, false]) {
    A.ch.selfDeliver = selfDeliver; B.ch.selfDeliver = selfDeliver
    const tag = selfDeliver ? 'self:false 生效' : 'self:false 失效(sender 收到自己)'

    A.type('h'); A.type('he'); A.type('hel'); A.type('hello')
    await longSleep(90)
    check(`A打完hello → B显示A预览 [${tag}]`, B.drafts.A?.content, 'hello')

    B.type('h'); B.type('hi')
    await longSleep(90)
    check(`B打完hi → A显示B预览 [${tag}]`, A.drafts.B?.content, 'hi')
    check(`B打字后仍保留A的预览(核心诉求)[${tag}]`, B.drafts.A?.content, 'hello')

    // 双方都停了手 —— 模拟失焦、切到别的标签页、长时间停顿。
    // 旧行为(无心跳 + 6s TTL)下此时预览已进入死亡倒计时;
    // 新行为靠心跳每 60ms 续命,两边都应还在。
    await longSleep(250)
    check(`停手 250ms(多个心跳周期)后双方预览仍在 [${tag}]`, [A.drafts.B?.content, B.drafts.A?.content], ['hi', 'hello'])

    // 迟到的旧清空:模拟 A 早先的内容,现在乱序收到一条 sentAt 明显更旧的 clear,
    // 它应当被 isStaleClear 判为过期而忽略,不抹掉 A 的活草稿。
    B.recv('A', '', Date.now() - 5000)
    check(`迟到的旧清空不抹掉A的活草稿(乱序守卫)[${tag}]`, B.drafts.A?.content, 'hello')

    // 正常清空:A 发送/清空(此刻 sentAt 最新),应真正移除
    A.clear(); await longSleep(20)
    check(`A正常清空后 B 的预览被移除 [${tag}]`, B.drafts.A, undefined)
  }
}

// ═════════════════════════════════════════════════════════════
console.log('\n══════ 9 · 停顿不失活:心跳保活(运行时) ══════\n')
// ═════════════════════════════════════════════════════════════
{
  const HB = 60
  const { sent, send } = makeRecorder()
  const b = createDraftBroadcaster(send, TH, HB)

  b.push('hello')
  check('首次输入立即发出', sent, ['hello'])

  // 之后**完全不再输入** —— 模拟失焦、切到别的标签页、长时间停顿。
  // 旧行为(无心跳)下预览 6 秒后熄灭;新行为应靠心跳持续重发。
  await sleep(HB * 4 + 40)
  const beats = sent.filter((c) => c === 'hello').length
  assert(`无输入 ${HB * 4}ms(约 4 个心跳周期)后内容仍在持续重发`, beats >= 4, `hello 共 ${beats} 次`)

  b.push('')
  const afterClear = sent.length
  await sleep(HB * 4 + 40)
  check('清空后心跳停摆,不再有任何发送', sent.length, afterClear)

  b.dispose()
  const afterDispose = sent.length
  await sleep(HB * 3 + 40)
  check('dispose 后心跳彻底停止', sent.length, afterDispose)
}

// ═════════════════════════════════════════════════════════════
console.log('')
if (fail > 0) {
  console.log(`${RED}✗ 输入实时预览检查未通过:${pass} 通过 / ${fail} 失败${RST}\n`)
  process.exit(1)
}
console.log(`${GRN}✓ 输入实时预览检查通过:${pass} 项全部通过${RST}`)
console.log(`${DIM}  数据来源: src/lib/live-preview.ts${RST}\n`)
process.exit(0)
