'use client'

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { formatDistanceToNow } from 'date-fns'
import { zhCN } from 'date-fns/locale'
import { zh, en, type Locale } from './dictionary'

type Vars = Record<string, string | number>

/**
 * date-fns 的语言包。英文用 date-fns 内置默认值(传 undefined)。
 * 注意:必须显式传入,否则无论界面语言是什么,相对时间都会输出英文。
 */
const DATE_FNS_LOCALE: Record<Locale, typeof zhCN | undefined> = { zh: zhCN, en: undefined }

/** 供 toLocaleDateString / toLocaleTimeString 使用的 BCP-47 语言标签 */
const DATE_LOCALE_TAG: Record<Locale, string> = { zh: 'zh-CN', en: 'en-US' }

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string, vars?: Vars) => string
}

const I18nContext = createContext<I18nContextValue | null>(null)

const STORAGE_KEY = 'openhive-locale'
const DEFAULT_LOCALE: Locale = 'zh'

const DICTIONARIES: Record<Locale, Record<string, string>> = { zh, en }

function translate(locale: Locale, key: string, vars?: Vars): string {
  let out = DICTIONARIES[locale]?.[key] ?? key
  if (vars) {
    for (const k of Object.keys(vars)) {
      out = out.split(`{${k}}`).join(String(vars[k]))
    }
  }
  return out
}

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE)

  // 读取用户上次选择的语言(SSR 阶段用默认值,挂载后再同步)
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY)
      if (saved === 'zh' || saved === 'en') {
        setLocaleState(saved)
        document.documentElement.lang = saved === 'zh' ? 'zh-CN' : 'en'
      } else {
        document.documentElement.lang = 'zh-CN'
      }
    } catch {
      /* localStorage 不可用时静默降级为默认语言 */
    }
  }, [])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next)
      document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en'
    } catch {
      /* 忽略持久化失败 */
    }
  }, [])

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key: string, vars?: Vars) => translate(locale, key, vars),
    }),
    [locale, setLocale]
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

/** 需要同时读写语言时使用 */
export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n 必须在 <I18nProvider> 内使用')
  return ctx
}

/**
 * 组件内最常用的入口。返回的 t 引用随语言变化,
 * 可直接放进 useMemo/useEffect 依赖数组。
 */
export function useT() {
  return useI18n().t
}

/** 当前语言。用于需要按语言切换格式化行为的场景(如日期时间)。 */
export function useLocale(): Locale {
  return useI18n().locale
}

/**
 * 相对时间格式化(「32 分钟前」/「32 minutes ago」)。
 *
 * 直接用 date-fns 的 formatDistanceToNow 而不传 locale 会恒定输出英文,
 * 这是最容易漏掉的一类「未翻译」——它不在词典里,也不经过 t()。
 */
export function useRelativeTime() {
  const { locale } = useI18n()
  return useCallback(
    (value: Date | string | number) =>
      formatDistanceToNow(new Date(value), {
        addSuffix: true,
        locale: DATE_FNS_LOCALE[locale],
      }),
    [locale]
  )
}

/** BCP-47 语言标签,传给 toLocaleDateString / toLocaleTimeString */
export function useDateLocale(): string {
  const { locale } = useI18n()
  return DATE_LOCALE_TAG[locale]
}

export type { Locale }
export { zh, en }
