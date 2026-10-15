#!/usr/bin/env node
/**
 * 表情工具与粘贴逻辑的回归测试。
 *
 * 为什么需要它:`isEmojiOnly` 用 Unicode 属性正则判断「纯表情」,
 * 而 `\p{Emoji_Component}` 把数字 0-9 和 `#` `*` 也算进去了(它们用于组成 1️⃣ 这类键帽),
 * 单靠字符类会把 "123" 误判成纯表情,导致纯数字消息被放大成 2.25rem。
 * 这类 Unicode 边界很容易在重构时被破坏,所以固化成测试。
 *
 * 用法:  npm run emoji:check
 * 退出码: 0 = 通过  1 = 有失败项
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  EMOJI_GROUPS,
  QUICK_REACTIONS,
  parseEmojiEntry,
  searchEmoji,
  countEmoji,
  isEmojiOnly,
  isWideEntry,
} from '../src/lib/emoji-data.ts'

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

console.log('\n═══ 表情数据集完整性 ═══')
const total = EMOJI_GROUPS.reduce((n, g) => n + g.emojis.length, 0)
const chars = EMOJI_GROUPS.flatMap((g) => g.emojis.map((e) => parseEmojiEntry(e).char))
const noKeyword = EMOJI_GROUPS.flatMap((g) => g.emojis).filter((e) => !e.includes(' '))
console.log(`  分组数        : ${EMOJI_GROUPS.length}`)
console.log(`  表情总数      : ${total}`)
console.log(`  唯一表情      : ${new Set(chars).size}`)
console.log(`  缺少关键词    : ${noKeyword.length}${noKeyword.length ? ' -> ' + noKeyword.join(' ') : ''}`)
check('分组 id 唯一', new Set(EMOJI_GROUPS.map((g) => g.id)).size, EMOJI_GROUPS.length)
check('无重复表情', new Set(chars).size, total)
check('快捷回应数量', QUICK_REACTIONS.length, 6)

console.log('\n═══ 纯表情判断 isEmojiOnly ═══')
check('单个表情', isEmojiOnly('😀'), true)
check('两个表情', isEmojiOnly('😀😀'), true)
check('表情带空格', isEmojiOnly('😀 😀'), true)
check('表情 + 文字', isEmojiOnly('😀 hello'), false)
check('纯文字', isEmojiOnly('hello'), false)
check('空字符串', isEmojiOnly('   '), false)
check('肤色修饰符 👍🏽', isEmojiOnly('👍🏽'), true)
check('ZWJ 家庭 👨‍👩‍👧', isEmojiOnly('👨‍👩‍👧'), true)
check('变体选择符 ❤️', isEmojiOnly('❤️'), true)
check('数字键帽 1️⃣', isEmojiOnly('1️⃣'), true)
check('纯数字 123(关键回归点)', isEmojiOnly('123'), false)
check('纯符号 ###', isEmojiOnly('###'), false)
check('中文字', isEmojiOnly('你好'), false)

console.log('\n═══ 表情计数 countEmoji ═══')
check('0 个', countEmoji('hello'), 0)
check('1 个', countEmoji('😀'), 1)
check('3 个', countEmoji('😀👍🎉'), 3)
check('混合文本', countEmoji('好的😀收到'), 1)

console.log('\n═══ 关键词搜索 searchEmoji ═══')
check('中文「笑」有命中', searchEmoji('笑').length > 0, true)
check('英文 heart 有命中', searchEmoji('heart').length > 0, true)
check('英文 check 有命中', searchEmoji('check').length > 0, true)
check('英文 party 有命中', searchEmoji('party').length > 0, true)
check('空查询返回全部分组', searchEmoji('').length, EMOJI_GROUPS.length)
check('乱码查询返回空', searchEmoji('zzzzqqqq').length, 0)

console.log('\n═══ 关键词完整性 ═══')
// 颜文字内部若误写成半角空格,会被 parseEmojiEntry 当成分隔符:
// 字符被截断,后半截混进关键词。关键词只应出现中英文、数字和连字符
// (yo-yo / non-potable),颜文字本体里的 ╯ ° ＿ ᴥ 等符号一旦混进来就会被抓到。
const badKeyword = EMOJI_GROUPS.flatMap((g) => g.emojis)
  .map((e) => ({ e, kw: parseEmojiEntry(e).keywords }))
  .filter(({ kw }) => !/^[A-Za-z0-9\u4e00-\u9fff -]*$/.test(kw))
check('关键词无异常字符(颜文字未误用半角空格)', badKeyword.length, 0)
if (badKeyword.length > 0) {
  console.log(`    ${DIM}${badKeyword.slice(0, 8).map((b) => b.e).join('  |  ')}${RST}`)
}

console.log('\n═══ 宽条目判断 isWideEntry ═══')
check('单个表情', isWideEntry('😀'), false)
check('变体选择符 ❤️', isWideEntry('❤️'), false)
check('肤色修饰 👍🏽', isWideEntry('👍🏽'), false)
check('ZWJ 家庭 👨‍👩‍👧(5 码点仍是 1 个字素)', isWideEntry('👨‍👩‍👧'), false)
check('键帽 1️⃣', isWideEntry('1️⃣'), false)
check('颜文字 掀桌', isWideEntry('(╯°□°）╯︵┻━┻'), true)
check('颜文字 摊手', isWideEntry('¯\\_(ツ)_/¯'), true)
check('颜文字 含图形字符 (♥ω♥*)', isWideEntry('(♥ω♥*)'), true)
check('颜文字 无图形字符 ʕ•ᴥ•ʔ', isWideEntry('ʕ•ᴥ•ʔ'), true)
check('颜文字 T_T', isWideEntry('T_T'), true)

console.log('\n═══ 颜文字分组 ═══')
const kaomoji = EMOJI_GROUPS.find((g) => g.id === 'Kaomoji')
check('存在 Kaomoji 分组', !!kaomoji, true)
check('Kaomoji 标记为宽条目', kaomoji?.wide, true)
check('颜文字条数 > 80', (kaomoji?.emojis.length ?? 0) > 80, true)
check('颜文字可搜英文 shrug', searchEmoji('shrug').some((g) => g.id === 'Kaomoji'), true)
check('颜文字可搜中文 摊手', searchEmoji('摊手').some((g) => g.id === 'Kaomoji'), true)
check('颜文字可搜中文 掀桌', searchEmoji('掀桌').some((g) => g.id === 'Kaomoji'), true)
check('颜文字不触发纯表情放大', isEmojiOnly('(╯°□°）╯︵┻━┻'), false)
check('颜文字 countEmoji 为 0', countEmoji('(╯°□°）╯︵┻━┻'), 0)
check('搜索保留 wide 标记', searchEmoji('猫').find((g) => g.id === 'Kaomoji')?.wide, true)

console.log('\n═══ 剪贴板图片提取(从 message-input 源码抽取真实实现) ═══')
const inputSrc = fs.readFileSync(path.join(root, 'src/components/chat/message-input.tsx'), 'utf8')
const fnMatch = inputSrc.match(/function extractClipboardImages[\s\S]*?\n\}/)
if (!fnMatch) {
  console.log(`  ${RED}✗ 未能从源码中定位 extractClipboardImages${RST}`)
  fail++
} else {
  // 该函数只有两个类型标注,去掉即可在纯 JS 环境执行
  const src = fnMatch[0]
    .replace(/: DataTransfer \| null/g, '')
    .replace(/\): File\[\]/g, ')')
    .replace(/: File\[\]/g, '')
  const extract = new Function(`${src}; return extractClipboardImages`)()

  const mkItem = (kind, file) => ({ kind, getAsFile: () => file })
  const png = { type: 'image/png', name: 'screenshot.png' }
  const jpg = { type: 'image/jpeg', name: 'photo.jpg' }
  const pdf = { type: 'application/pdf', name: 'doc.pdf' }

  check('截图(png)', extract({ items: [mkItem('file', png)] }).length, 1)
  check('多张图片', extract({ items: [mkItem('file', png), mkItem('file', jpg)] }).length, 2)
  check('非图片被排除', extract({ items: [mkItem('file', pdf)] }).length, 0)
  check('图片 + PDF 只取图片', extract({ items: [mkItem('file', png), mkItem('file', pdf)] }).length, 1)
  check('纯文本粘贴不拦截', extract({ items: [mkItem('string', null)] }).length, 0)
  check('空剪贴板', extract(null).length, 0)
}

console.log('')
if (fail > 0) {
  console.log(`${RED}✗ 表情检查未通过:${pass} 通过 / ${fail} 失败${RST}\n`)
  process.exit(1)
}
console.log(`${GRN}✓ 表情检查通过:${pass} 项全部通过${RST}`)
console.log(`${DIM}  数据来源: src/lib/emoji-data.ts${RST}\n`)
process.exit(0)
