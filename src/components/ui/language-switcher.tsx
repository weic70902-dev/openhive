'use client'

import { useI18n, type Locale } from '@/lib/i18n'
import { Languages } from 'lucide-react'

const OPTIONS: { value: Locale; label: string }[] = [
  { value: 'zh', label: '中文' },
  { value: 'en', label: 'English' },
]

interface LanguageSwitcherProps {
  /** compact 用于侧边栏等空间受限处 */
  variant?: 'compact' | 'full'
}

export function LanguageSwitcher({ variant = 'full' }: LanguageSwitcherProps) {
  const { locale, setLocale } = useI18n()

  if (variant === 'compact') {
    return (
      <button
        type="button"
        onClick={() => setLocale(locale === 'zh' ? 'en' : 'zh')}
        className="h-8 w-8 flex items-center justify-center rounded-xl text-[#8E8EA0] hover:bg-[#F5F2FF] hover:text-[#7C5CFC] transition-colors"
        title={locale === 'zh' ? 'Switch to English' : '切换为中文'}
        aria-label={locale === 'zh' ? 'Switch to English' : '切换为中文'}
      >
        <Languages className="h-4 w-4" />
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <Languages className="h-4 w-4 text-[#8E8EA0] shrink-0" />
      <div className="inline-flex rounded-xl border border-[#E5E1EE] bg-[#F5F2FF] p-0.5">
        {OPTIONS.map((opt) => {
          const active = locale === opt.value
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setLocale(opt.value)}
              className={`px-3 py-1 text-xs rounded-[10px] transition-colors ${
                active
                  ? 'bg-white text-[#7C5CFC] font-medium shadow-sm'
                  : 'text-[#8E8EA0] hover:text-[#2D2B3D]'
              }`}
              aria-pressed={active}
            >
              {opt.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
