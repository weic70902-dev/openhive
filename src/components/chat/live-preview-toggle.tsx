'use client'

import { Eye, EyeOff } from 'lucide-react'
import { useT } from '@/lib/i18n'

interface LivePreviewToggleProps {
  enabled: boolean
  onToggle: () => void
  disabled?: boolean
}

/**
 * 输入实时预览开关(按会话独立)。
 *
 * 放在会话头部而不是用户菜单里:它是**单个会话**的功能,
 * 用户会针对「和谁聊」来决定要不要开,放在全局菜单里语义不对。
 *
 * 语义要点:这是「预发布」——只有**发送方**需要开启。
 * 接收方什么都不用做就能看到,所以这里只管「我要不要广播自己打的内容」。
 */
export function LivePreviewToggle({ enabled, onToggle, disabled = false }: LivePreviewToggleProps) {
  const t = useT()

  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={enabled}
      aria-label={t('Live typing preview')}
      className="h-8 w-8 rounded-lg flex items-center justify-center hover:bg-[#F5F2FF] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      style={{ color: enabled ? '#7C5CFC' : '#8E8EA0' }}
      title={
        enabled
          ? t('Live typing preview is on — others see what you type before you send')
          : t('Live typing preview is off — others only see messages you send')
      }
    >
      {enabled ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
    </button>
  )
}
