'use client'

import { useEffect, useRef, useState } from 'react'
import { Clock, Check, Loader2, Wrench, AlertTriangle } from 'lucide-react'
import { FloatingPanel } from '@/components/ui/floating-panel'
import { getSupabaseClient } from '@/lib/supabase/client'
import { useAppStore } from '@/lib/store/app-store'
import { useT } from '@/lib/i18n'
import { DISAPPEAR_OPTIONS, formatDuration } from '@/lib/disappearing-messages'
import { DISAPPEARING_MESSAGES_SQL } from '@/lib/supabase/disappearing-migration'
import { describeSupabaseError, extractProjectRef, isSchemaNotMigrated } from '@/lib/supabase/errors'
import type { Channel } from '@/types/database'

interface DisappearTimerMenuProps {
  channel: Channel
  /** 预览未加入的频道时禁用 —— 改的是频道级设置,没加入就没资格改。 */
  disabled?: boolean
}

/**
 * 阅后即焚计时器开关。
 *
 * 放在会话头部而不是「频道设置」里,是为了让**私聊也能用** ——
 * 私聊没有频道设置对话框,而用户明确要求「每个会话单独设置」。
 *
 * 改动只写 channels.disappear_seconds;disappear_since(计时生效起点)
 * 由数据库触发器用 now() 写入,避免客户端时钟偏差误伤边界消息。
 *
 * 打开面板时会先探测一次数据库结构:功能所需的列/函数如果还没迁移,
 * 这里直接给出「粘贴访问令牌 → 执行迁移」的入口,而不是等用户点了时长
 * 再甩一个看不懂的报错。
 */
export function DisappearTimerMenu({ channel, disabled = false }: DisappearTimerMenuProps) {
  const { updateChannel } = useAppStore()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  /** null = 还没探测出结果 */
  const [migrated, setMigrated] = useState<boolean | null>(null)
  const [error, setError] = useState<string | null>(null)
  // 迁移流程
  const [showFix, setShowFix] = useState(false)
  const [pat, setPat] = useState('')
  const [fixing, setFixing] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const t = useT()

  const current = channel.disappear_seconds ?? null
  const enabled = current !== null
  const currentLabel = current !== null ? formatDuration(current, t) : t('Off')

  // 每次打开都重新探测一次:用户可能刚在另一个标签页里跑完迁移
  useEffect(() => {
    if (!open) {
      setError(null)
      setShowFix(false)
      return
    }

    let cancelled = false
    setMigrated(null)

    const client = getSupabaseClient()
    if (!client) return

    // 轻量探测:只取一列。列不存在时 PostgREST 直接回 42703,不会真的传输数据。
    client
      .from('channels')
      .select('disappear_seconds')
      .limit(1)
      .then(({ error: probeError }) => {
        if (cancelled) return
        setMigrated(!isSchemaNotMigrated(probeError))
      })

    return () => {
      cancelled = true
    }
  }, [open])

  async function handleSelect(seconds: number | null) {
    if (seconds === current) {
      setOpen(false)
      return
    }

    const client = getSupabaseClient()
    if (!client) return

    const prevSeconds = current

    // 乐观更新:计时器开关属于「点了就该立刻看到结果」的交互,
    // 失败时再回滚,而不是让按钮僵在那里等网络。
    updateChannel(channel.id, { disappear_seconds: seconds })
    setSaving(true)
    setError(null)

    const { error: updateError } = await client
      .from('channels')
      .update({ disappear_seconds: seconds })
      .eq('id', channel.id)

    if (updateError) {
      // 必须手动拼出可读文本:PostgrestError 直接丢给 console 会显示成 `{}`
      console.error('Failed to update disappearing messages:', describeSupabaseError(updateError))
      updateChannel(channel.id, { disappear_seconds: prevSeconds })
      // 结构缺失就地把面板切成「需要迁移」,而不是让用户反复点
      if (isSchemaNotMigrated(updateError)) setMigrated(false)
      else setError(describeSupabaseError(updateError))
    } else {
      setOpen(false)
    }
    setSaving(false)
  }

  async function handleFix() {
    if (!pat.trim()) return

    const projectRef = extractProjectRef(process.env.NEXT_PUBLIC_SUPABASE_URL)
    if (!projectRef) {
      setError(t('Could not extract project ref from Supabase URL.'))
      return
    }

    setFixing(true)
    setError(null)
    try {
      const res = await fetch('/api/provision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectRef,
          accessToken: pat.trim(),
          sql: DISAPPEARING_MESSAGES_SQL,
        }),
      })
      const result = await res.json()

      if (!res.ok) {
        setError(result.error || t('Failed to run migration'))
        return
      }

      // DDL 执行成功不代表 PostgREST 立刻认得新列(schema cache 有延迟),
      // 所以再探测一次,而不是直接宣布成功。
      const client = getSupabaseClient()
      if (client) {
        const { error: probeError } = await client
          .from('channels')
          .select('disappear_seconds')
          .limit(1)
        if (isSchemaNotMigrated(probeError)) {
          setError(
            t('Migration finished, but the schema cache has not refreshed yet. Wait a few seconds and reopen this menu.')
          )
          return
        }
      }

      setShowFix(false)
      setPat('')
      setMigrated(true)
    } catch (err) {
      setError(describeSupabaseError(err))
    } finally {
      setFixing(false)
    }
  }

  return (
    <>
      <button
        ref={anchorRef}
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="h-8 w-8 rounded-lg flex items-center justify-center hover:bg-[#F5F2FF] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ color: enabled ? '#7C5CFC' : '#8E8EA0' }}
        title={enabled ? t('Disappearing messages: {value}', { value: currentLabel }) : t('Disappearing messages')}
        aria-label={t('Disappearing messages')}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Clock className="h-4 w-4" />}
      </button>

      <FloatingPanel anchorRef={anchorRef} open={open} onClose={() => setOpen(false)} align="end" gap={6}>
        <div className="w-72 max-w-[calc(100vw_-_1.5rem)] bg-popover border rounded-lg shadow-lg p-1.5">
          <div
            className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider"
            style={{ color: '#8E8EA0' }}
          >
            {t('Disappearing messages')}
          </div>

          {migrated === null ? (
            <div className="flex items-center justify-center gap-2 py-5" style={{ color: '#8E8EA0' }}>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="text-[12px]">{t('Checking database…')}</span>
            </div>
          ) : migrated === false ? (
            /* 数据库还没迁移 —— 直接给修复入口,而不是让用户对着一个
               看不懂的报错发呆 */
            <div className="px-2 pb-1">
              <div className="flex items-center gap-1.5 mb-1.5">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" style={{ color: '#F59E0B' }} />
                <span className="text-[12px] font-semibold" style={{ color: '#2D2B3D' }}>
                  {t('Database update needed')}
                </span>
              </div>
              <p className="text-[11px] leading-snug mb-2" style={{ color: '#8E8EA0' }}>
                {t('Disappearing messages needs new database columns and functions. Run the migration once to enable it.')}
              </p>

              {!showFix ? (
                <button
                  onClick={() => { setShowFix(true); setError(null) }}
                  className="w-full h-8 rounded-md flex items-center justify-center gap-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                  style={{ background: '#7C5CFC' }}
                >
                  <Wrench className="h-3.5 w-3.5" />
                  {t('Set up with access token')}
                </button>
              ) : (
                <div className="space-y-1.5">
                  <input
                    type="password"
                    value={pat}
                    onChange={(e) => setPat(e.target.value)}
                    placeholder="sbp_..."
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') handleFix() }}
                    className="w-full h-8 px-2 text-[12px] rounded-md border focus:outline-none focus:ring-2 focus:ring-[#7C5CFC]"
                    style={{ borderColor: '#E5E1EE' }}
                  />
                  <p className="text-[10px] leading-snug" style={{ color: '#8E8EA0' }}>
                    {t('Get it from')}{' '}
                    <a
                      href="https://supabase.com/dashboard/account/tokens"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                      style={{ color: '#7C5CFC' }}
                    >
                      supabase.com/dashboard/account/tokens
                    </a>
                  </p>
                  <div className="flex gap-1.5">
                    <button
                      onClick={() => { setShowFix(false); setError(null) }}
                      className="flex-1 h-8 rounded-md text-[12px] font-medium transition-colors hover:bg-[#F5F2FF]"
                      style={{ color: '#4A4860', border: '1px solid #E5E1EE' }}
                    >
                      {t('Cancel')}
                    </button>
                    <button
                      onClick={handleFix}
                      disabled={fixing || !pat.trim()}
                      className="flex-1 h-8 rounded-md flex items-center justify-center gap-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                      style={{ background: '#7C5CFC' }}
                    >
                      {fixing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                      {t('Run migration')}
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <p className="text-[11px] leading-snug mt-2 p-1.5 rounded-md break-words" style={{ background: '#FEE2E2', color: '#E55B5B' }}>
                  {error}
                </p>
              )}
            </div>
          ) : (
            <>
              {DISAPPEAR_OPTIONS.map((opt) => {
                const active = opt.seconds === current
                return (
                  <button
                    key={opt.label}
                    onClick={() => handleSelect(opt.seconds)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] text-left transition-colors ${
                      active ? 'bg-[#EDE5FF]' : 'hover:bg-[#F5F2FF]'
                    }`}
                    style={{ color: active ? '#7C5CFC' : '#2D2B3D' }}
                  >
                    <span className="flex-1">{t(opt.label)}</span>
                    {active && <Check className="h-3.5 w-3.5" />}
                  </button>
                )
              })}

              {error && (
                <p className="text-[11px] leading-snug m-1 p-1.5 rounded-md break-words" style={{ background: '#FEE2E2', color: '#E55B5B' }}>
                  {error}
                </p>
              )}
            </>
          )}

          <p
            className="px-2 pt-2 pb-1 mt-1 text-[11px] leading-snug"
            style={{ color: '#8E8EA0', borderTop: '1px solid #E5E1EE' }}
          >
            {t('The timer starts when the other person reads the message. Only messages sent after turning it on are affected.')}
          </p>
        </div>
      </FloatingPanel>
    </>
  )
}
