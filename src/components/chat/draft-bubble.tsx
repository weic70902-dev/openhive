'use client'

import DOMPurify from 'dompurify'
import { Eye } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { renderMessageContent } from './message-bubble'
import { useSignedText } from '@/hooks/use-signed-text'
import type { DraftPayload } from '@/lib/live-preview'

/**
 * 「输入实时预览」的草稿气泡。
 *
 * 刻意做成**虚线描边 + 淡背景**,和真实消息拉开视觉差 ——
 * 必须让人一眼看出「这条还没发出去」,否则对方会误以为收到了一条消息。
 */
export function DraftBubble({ draft }: { draft: DraftPayload }) {
  const t = useT()
  const initial = draft.displayName[0]?.toUpperCase() || '?'
  // 附件桶已私有化:草稿里若带了图片/文件直链,先换成签名 URL 再渲染
  const signedContent = useSignedText(draft.content)

  return (
    <div className="flex justify-start">
      <div className="relative flex gap-2.5 max-w-[78%] px-2 py-1">
        {draft.avatarUrl ? (
          <img
            src={draft.avatarUrl}
            alt=""
            className="h-9 w-9 rounded-xl object-cover shrink-0 mt-0.5"
          />
        ) : (
          <div
            className="h-9 w-9 rounded-xl flex items-center justify-center text-sm font-bold text-white shrink-0 mt-0.5"
            style={{ background: '#7C5CFC' }}
          >
            {initial}
          </div>
        )}

        <div className="min-w-0 max-w-full flex flex-col items-start">
          <div className="flex items-baseline gap-1.5 mb-1">
            <span className="font-semibold text-[13px]" style={{ color: '#2D2B3D' }}>
              {draft.displayName}
            </span>
            <span
              className="inline-flex items-center gap-1 text-[11px]"
              style={{ color: '#7C5CFC' }}
            >
              <Eye className="h-3 w-3" />
              {t('Live typing — not sent')}
            </span>
          </div>

          <div
            className="rounded-xl border border-dashed px-3 py-1.5 text-[15px] leading-[1.5] whitespace-pre-wrap break-words message-content"
            style={{ borderColor: '#C4BAE8', background: '#FAF8FF', color: '#2D2B3D' }}
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(renderMessageContent(signedContent)),
            }}
          />
        </div>
      </div>
    </div>
  )
}
