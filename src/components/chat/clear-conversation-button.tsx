'use client'

import { useState } from 'react'
import { Eraser, Loader2 } from 'lucide-react'
import { useT } from '@/lib/i18n'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'

interface ClearConversationButtonProps {
  /** 会话名(私聊对方的名字),用在确认文案里让对方明确「对方的记录不受影响」。 */
  displayName: string
  onClear: () => Promise<void>
  disabled?: boolean
}

/**
 * 一键清空会话(仅私聊)。
 *
 * 语义是**只对我隐藏**,不是删除 —— 所以文案里必须写清楚
 * 「对方的记录不受影响」。否则用户会以为自己在删对方的消息,
 * 要么不敢用,要么误以为对方也看不到了。
 *
 * 虽然不删数据,仍然加了确认对话框:清空之后自己就再也翻不到之前的记录了,
 * 这不可逆。放在头部而不是塞进某个二级菜单,是为了「一键」够得着。
 */
export function ClearConversationButton({
  displayName,
  onClear,
  disabled = false,
}: ClearConversationButtonProps) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  async function handleConfirm() {
    setBusy(true)
    try {
      await onClear()
    } finally {
      // 无论成功失败都要收起来并解除 loading —— 失败时调用方会把错误显示在会话里,
      // 卡在 loading 状态反而让人以为还在跑。
      setBusy(false)
      setOpen(false)
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        disabled={disabled || busy}
        aria-label={t('Clear conversation')}
        title={t('Clear conversation')}
        className="h-8 w-8 rounded-lg flex items-center justify-center hover:bg-[#F5F2FF] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        style={{ color: '#8E8EA0' }}
      >
        <Eraser className="h-4 w-4" />
      </AlertDialogTrigger>

      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-3 mb-2">
            <div className="h-10 w-10 rounded-xl flex items-center justify-center" style={{ background: '#EDE5FF' }}>
              <Eraser className="h-5 w-5" style={{ color: '#7C5CFC' }} />
            </div>
            <AlertDialogTitle>{t('Clear conversation?')}</AlertDialogTitle>
          </div>
          <AlertDialogDescription className="text-left">
            {t('This only hides messages for you. {name} keeps their copy — nothing is deleted.', {
              name: displayName,
            })}
            <br />
            <br />
            {t('Messages before now will be hidden from your view, and you will not be able to read them again.')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleConfirm}
            disabled={busy}
            style={{ background: '#7C5CFC' }}
          >
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t('Clearing…')}
              </>
            ) : (
              t('Clear')
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
