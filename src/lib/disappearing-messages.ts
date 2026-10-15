/**
 * 阅后即焚 —— 共享常量与格式化工具。
 *
 * 口径(已与用户确认):
 *  · 计时**不在发送时**开始,而是等对方**阅读后**才开始。
 *  · 开关是**每个会话单独设置**,存在 channels.disappear_seconds ——
 *    **任一方开启即对整个会话生效,不需要双方都开**;
 *    触发与校验全在数据库侧,与对方客户端的状态无关。
 *  · 到点由 purge_expired_messages() 硬删除,不留痕。
 *  · 只对「开启计时之后发出的」消息生效(channels.disappear_since),
 *    否则一开开关就会把历史消息全部烧掉。
 */

export interface DisappearOption {
  /** 秒数。null = 关闭 */
  seconds: number | null
  /** i18n key —— 英文原文即 key,词典里补中文 */
  label: string
}

export const DISAPPEAR_OPTIONS: DisappearOption[] = [
  { seconds: null, label: 'Off' },
  { seconds: 10, label: '10 seconds' },
  { seconds: 30, label: '30 seconds' },
  { seconds: 60, label: '1 minute' },
  { seconds: 300, label: '5 minutes' },
  { seconds: 3600, label: '1 hour' },
  { seconds: 86400, label: '24 hours' },
]

export type DurationUnit = 's' | 'm' | 'h' | 'd'

export interface CompactDuration {
  value: number
  unit: DurationUnit
}

/**
 * 把秒数压成「数值 + 单位」。
 * 不足 1 分钟用秒,再往上依次用分/时/天 —— 直接显示 3599s 没人看得懂。
 */
export function compactDuration(seconds: number): CompactDuration {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return { value: s, unit: 's' }
  if (s < 3600) return { value: Math.round(s / 60), unit: 'm' }
  if (s < 86400) return { value: Math.round(s / 3600), unit: 'h' }
  return { value: Math.round(s / 86400), unit: 'd' }
}

/**
 * 由**剩余毫秒数**得到倒计时显示值。
 * 一律向上取整:刚发出时应显示「10秒」而不是「9秒」,
 * 归零后再取整会得到 0,由调用方负责把 0 的消息摘掉。
 */
export function countdownDuration(remainingMs: number): CompactDuration {
  const s = Math.max(0, Math.ceil(remainingMs / 1000))
  if (s < 60) return { value: s, unit: 's' }
  if (s < 3600) return { value: Math.ceil(s / 60), unit: 'm' }
  if (s < 86400) return { value: Math.ceil(s / 3600), unit: 'h' }
  return { value: Math.ceil(s / 86400), unit: 'd' }
}

type TFn = (key: string, vars?: Record<string, string | number>) => string

/**
 * 「10秒」/「5分」/「1时」/「1天」。
 * 单位走词典,不在这里硬编码中文 —— 英文界面下会回退成 10s / 5m / 1h / 1d。
 * 写成 switch 而不是拼字符串,是为了让 i18n 检查脚本能静态扫到这四个 key。
 */
export function formatCompact(d: CompactDuration, t: TFn): string {
  switch (d.unit) {
    case 's':
      return t('{n}s', { n: d.value })
    case 'm':
      return t('{n}m', { n: d.value })
    case 'h':
      return t('{n}h', { n: d.value })
    case 'd':
      return t('{n}d', { n: d.value })
  }
}

/** 固定时长,用于设置项与状态条上的「10秒」。 */
export function formatDuration(seconds: number, t: TFn): string {
  return formatCompact(compactDuration(seconds), t)
}

/** 实时倒计时,用于消息气泡上的「9秒」。 */
export function formatCountdown(remainingMs: number, t: TFn): string {
  return formatCompact(countdownDuration(remainingMs), t)
}

/**
 * 是否已到销毁时刻。
 *
 * 抽成函数有两个好处:一是「已过期」的判定在气泡、清理定时器、话题面板里
 * 口径必须完全一致;二是顺手避开 i18n 扫描脚本的误报 ——
 * 它的 JSX 文本正则会把同一行的 `=>` 和 `<=` 当成标签边界,
 * 所以这里刻意用 `now >= 时刻` 的写法,不出现小于号。
 */
export function isExpired(expiresAt: string | null, now: number): boolean {
  if (expiresAt === null) return false
  return now >= new Date(expiresAt).getTime()
}
