#!/usr/bin/env node
/**
 * i18n 检查脚本(两部分)
 *
 *   第 1 部分 · 词典完整性
 *     比对 dictionary.ts 中已定义的 key 与代码里 t('...') 的实际调用,
 *     找出「调用了但没定义」(会回退显示英文)以及「定义了但没用到」。
 *
 *   第 2 部分 · 未包装文案扫描
 *     静态扫描 JSX 纯文本、placeholder/title/aria-label/alt 属性、
 *     alert()/confirm() 裸字符串,找出「压根没走 t()」的用户可见英文。
 *     这部分是第 1 部分的盲区 —— 没调用 t() 的文案不会出现在 key 比对里。
 *
 * 用法:  npm run i18n:check
 * 退出码: 0 = 通过(无缺漏)  1 = 存在缺漏
 */

import fs from 'fs'
import path from 'path'

// ─────────────────────────────────────────────────────────────
// 收集源码文件
// ─────────────────────────────────────────────────────────────
const root = 'src'
const files = []
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.tsx?$/.test(e.name)) files.push(p.replace(/\\/g, '/'))
  }
}
walk(root)

const RED = '\x1b[31m'
const YEL = '\x1b[33m'
const GRN = '\x1b[32m'
const DIM = '\x1b[2m'
const RST = '\x1b[0m'

let failed = false

// ═════════════════════════════════════════════════════════════
// 第 1 部分 · 词典完整性
// ═════════════════════════════════════════════════════════════
console.log('\n══════ 第 1 部分 · 词典完整性 ══════\n')

const dictSrc = fs.readFileSync('src/lib/i18n/dictionary.ts', 'utf8')
const zhStart = dictSrc.indexOf('export const zh')
const zhEnd = dictSrc.indexOf('\n}', zhStart)
const zhBody = dictSrc.slice(zhStart, zhEnd)

const defined = new Set()
const keyRe = /^\s{2}(?:'((?:[^'\\]|\\.)*)'|([A-Za-z_$][\w$]*))\s*:/gm
for (const m of zhBody.matchAll(keyRe)) {
  const raw = m[1] !== undefined ? m[1] : m[2]
  defined.add(raw.replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
}

const used = new Map() // key -> Set<file>
const callRe = /\bt\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")\s*(?:,|\))/g

for (const f of files) {
  if (f.endsWith('lib/i18n/dictionary.ts')) continue
  const src = fs.readFileSync(f, 'utf8')
  for (const m of src.matchAll(callRe)) {
    const raw = m[1] !== undefined ? m[1] : m[2]
    const key = raw.replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    if (!used.has(key)) used.set(key, new Set())
    used.get(key).add(f)
  }
}

const missing = [...used.keys()].filter((k) => !defined.has(k)).sort()
const unused = [...defined].filter((k) => !used.has(k)).sort()

// 有意保留英文的 key —— 它们是需要用户去第三方控制台逐一对照的字段名/产品名,
// 翻译反而增加匹配成本。在此登记后不计入缺漏。
const INTENTIONAL_EN = new Set(['API Key', 'API Secret', 'Supabase', 'LiveKit'])

const realMissing = missing.filter((k) => !INTENTIONAL_EN.has(k))
const coverage = used.size ? ((used.size - realMissing.length) / used.size) * 100 : 100

console.log(`词典条目数        : ${defined.size}`)
console.log(`代码中 t() 调用键 : ${used.size}`)
console.log(
  `覆盖率            : ${coverage >= 99.9 ? GRN : YEL}${coverage.toFixed(1)}%${RST}`,
)

console.log('')
if (missing.length) {
  const intentional = missing.filter((k) => INTENTIONAL_EN.has(k))
  const real = missing.filter((k) => !INTENTIONAL_EN.has(k))

  if (intentional.length) {
    console.log(`${DIM}── 有意保留英文 ${intentional.length} 条(第三方控制台字段名) ──${RST}`)
    console.log('  ' + DIM + intentional.join(' / ') + RST)
    console.log('')
  }

  if (real.length) {
    failed = true
    console.log(`${RED}── 未命中词典(将回退显示英文) ${real.length} 条 ──${RST}`)
    for (const k of real) {
      const where = [...used.get(k)].map((f) => f.replace('src/', '')).join(', ')
      console.log(`  · ${k}\n      ${DIM}${where}${RST}`)
    }
  } else {
    console.log(`${GRN}✓ 除有意保留英文外,所有 t() 调用键均已在词典中定义${RST}`)
  }
} else {
  console.log(`${GRN}✓ 所有 t() 调用键均已在词典中定义${RST}`)
}

console.log('')
console.log(
  `${DIM}── 词典中已定义但代码未使用 ${unused.length} 条(无害,可后续清理) ──${RST}`,
)
if (unused.length) console.log('  ' + DIM + unused.join(' / ') + RST)

// ═════════════════════════════════════════════════════════════
// 第 2 部分 · 未包装文案扫描
// ═════════════════════════════════════════════════════════════
console.log('\n══════ 第 2 部分 · 未包装文案扫描 ══════\n')

// 明确豁免:URL、终端命令、产品名、技术标识符、已本地化文本
const WHITELIST = [
  /^https?:\/\//,
  /^wss?:\/\//,
  /^sbp_/,
  /^eyJ/,
  /^APIxxxxxxxxx$/,
  /^npm run /,
  /^npx /,
  /^Ctrl\+/,
  /^⌘/,
  /^Settings /,
  /^Supabase /,
  /^OpenHive$/,
  /^LiveKit/,
  /^localhost/,
  /^you@example\.com$/,
  /^colleague@company\.com$/,
  /^API Key$/,
  /^API Secret$/,
  /^service_role/,
  /^sb_secret/,
  /^#general$/,
  /^#random$/,
  /^\/[a-z]+$/, // slash command
  /^[A-Z_]{2,}$/, // 全大写常量
  /^[a-z0-9._-]+$/, // 纯小写标识符/文件名
  /^\d/, // 以数字开头
  /^[^\x00-\x7F]+$/, // 纯非 ASCII(已是中文/符号)
  /^&[a-z]+;$/, // 孤立 HTML 实体,如 &middot;
  /^& /, // 类型交叉,如 & VariantProps
  /^[=<>!+\-*/%|]{1,2}\s/, // 以运算符开头的表达式片段,如 = 768 && …
  /^\([a-z]+$/, // 箭头函数参数片段,如 (prev
  /^(Promise|Record|Partial|Readonly|Array|Map|Set|Pick|Omit)$/, // TS 内置类型
]

function whitelisted(s) {
  return WHITELIST.some((re) => re.test(s))
}

function looksLikeCopy(s) {
  const t = s.trim()
  if (t.length < 2 || t.length > 160) return false
  if (!/[A-Za-z]{2}/.test(t)) return false // 必须含至少两个字母
  if (whitelisted(t)) return false
  if (/^[a-z][a-zA-Z]*$/.test(t)) return false // 单个驼峰/小写单词
  if (/[{}<>]/.test(t)) return false // 含表达式
  if (/^(className|useState|useEffect|useMemo|useRef|import|export)/.test(t)) return false
  return true
}

const findings = []
function report(file, line, kind, text) {
  findings.push({ file: file.replace('src/', ''), line, kind, text: text.trim() })
}

for (const f of files) {
  if (f.includes('lib/i18n/')) continue
  const src = fs.readFileSync(f, 'utf8')

  // 1) JSX 纯文本节点: >文案<  且内部不含 {…}
  for (const m of src.matchAll(/>([^<>{}\n]{2,160})</g)) {
    if (!looksLikeCopy(m[1])) continue
    const line = src.slice(0, m.index).split('\n').length
    report(f, line, 'JSX文本', m[1])
  }

  // 2) 用户可见字符串属性
  for (const m of src.matchAll(/\b(placeholder|title|aria-label|alt)="([^"]{2,160})"/g)) {
    if (!looksLikeCopy(m[2])) continue
    const line = src.slice(0, m.index).split('\n').length
    report(f, line, `属性 ${m[1]}`, m[2])
  }

  // 3) 裸字符串提示
  for (const m of src.matchAll(/\b(alert|confirm)\s*\(\s*['"]([^'"]{4,160})['"]/g)) {
    if (!looksLikeCopy(m[2])) continue
    const line = src.slice(0, m.index).split('\n').length
    report(f, line, `${m[1]}()`, m[2])
  }
}

const byFile = new Map()
for (const f of findings) {
  if (!byFile.has(f.file)) byFile.set(f.file, [])
  byFile.get(f.file).push(f)
}

// 未接入 i18n 的 .tsx 文件(信息级,不计入失败 —— 有些组件确实没有文案)
const noI18n = files.filter(
  (f) => /\.tsx$/.test(f) && !f.includes('lib/i18n/') && !/useT|useI18n/.test(fs.readFileSync(f, 'utf8')),
)

if (findings.length) {
  console.log(
    `${YEL}发现 ${findings.length} 处疑似未翻译,分布在 ${byFile.size} 个文件${RST}`,
  )
  console.log(`${DIM}(含正则误报,请人工复核;确属文案的请用 t() 包裹)${RST}\n`)
  const sorted = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length)
  for (const [file, items] of sorted) {
    console.log(`── ${file}  (${items.length}) ──`)
    for (const it of items) {
      const loc = it.line ? `L${it.line}` : '—'
      console.log(`   [${it.kind}] ${loc}  ${JSON.stringify(it.text)}`)
    }
    console.log('')
  }
} else {
  console.log(`${GRN}✓ 未发现未包装的用户可见文案${RST}`)
}

if (noI18n.length) {
  console.log(`${DIM}── 未接入 useT 的 .tsx 组件 ${noI18n.length} 个(信息级) ──${RST}`)
  console.log('  ' + DIM + noI18n.map((f) => f.replace('src/', '')).join(' / ') + RST)
}

// ═════════════════════════════════════════════════════════════
// 结论
// ═════════════════════════════════════════════════════════════
console.log('')
if (failed) {
  console.log(`${RED}✗ i18n 检查未通过:存在 ${realMissing.length} 条词典缺漏${RST}\n`)
  process.exit(1)
}
console.log(`${GRN}✓ i18n 检查通过${RST}\n`)
process.exit(0)
