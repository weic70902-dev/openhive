'use client'

import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { useT } from '@/lib/i18n'
import { EMOJI_GROUPS, QUICK_REACTIONS, parseEmojiEntry, searchEmoji, isWideEntry } from '@/lib/emoji-data'

export { QUICK_REACTIONS }

interface EmojiPickerProps {
  onSelect: (emoji: string) => void
  onClose: () => void
  /** 选中后不关闭面板,便于连续插入多个表情(输入框场景) */
  stayOpen?: boolean
  /** 显示搜索框与分组标签(输入框场景) */
  searchable?: boolean
}

export function EmojiPicker({
  onSelect,
  onClose,
  stayOpen = false,
  searchable = false,
}: EmojiPickerProps) {
  const [query, setQuery] = useState('')
  const [activeGroup, setActiveGroup] = useState(EMOJI_GROUPS[0].id)
  const t = useT()

  const groups = useMemo(() => searchEmoji(query), [query])
  const searching = query.trim().length > 0

  // 搜索时平铺展示所有命中结果,否则只展示当前分组
  const visible = searching
    ? groups.flatMap((g) => g.emojis)
    : (groups.find((g) => g.id === activeGroup)?.emojis ?? EMOJI_GROUPS[0].emojis)

  // 颜文字这类「宽条目」按两列排,普通表情按方格排。
  // 列数必须跟着面板宽度走:窄面板(回应面板 w-72)固定 8 列,
  // 宽面板(输入框 w-[21rem]/sm:w-[24rem])在 ≥640px 时放宽到 10 列填满。
  const activeGroupDef = EMOJI_GROUPS.find((g) => g.id === activeGroup)
  const activeWide = !searching && activeGroupDef?.wide === true
  const gridCols = activeWide
    ? 'grid-cols-2 gap-1'
    : searchable
      ? 'grid-cols-8 sm:grid-cols-10'
      : 'grid-cols-8'

  function handlePick(emoji: string) {
    onSelect(emoji)
    if (!stayOpen) onClose()
  }

  return (
    <div
      className={`${
        searchable ? 'w-[21rem] sm:w-[24rem]' : 'w-72'
      } max-w-[calc(100vw_-_1.5rem)] bg-popover border rounded-lg shadow-lg p-2`}
      onClick={(e) => e.stopPropagation()}
    >
      {searchable && (
        <div className="relative mb-2">
          <Search
            className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5"
            style={{ color: '#8E8EA0' }}
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('Search emoji')}
            className="w-full h-8 pl-8 pr-2 text-xs rounded-lg border outline-none focus:ring-1 focus:ring-[#7C5CFC]"
            style={{ borderColor: '#E5E1EE', background: '#F5F2FF' }}
            autoFocus
          />
        </div>
      )}

      {/* 分组标签:始终单行,放不下就横向滑动(滚动条隐藏,移动端直接左右拖) */}
      {!searching && (
        <div className="flex gap-1 mb-2 border-b pb-2 overflow-x-auto no-scrollbar">
          {EMOJI_GROUPS.map((g) => (
            <button
              key={g.id}
              onClick={() => setActiveGroup(g.id)}
              className={`shrink-0 text-[11px] leading-none px-1.5 py-1 rounded transition-colors whitespace-nowrap ${
                activeGroup === g.id
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted'
              }`}
            >
              {t(g.id)}
            </button>
          ))}
        </div>
      )}

      {/* 表情网格
          高度同时受 rem 和视口高度约束,横屏 / 小屏手机上不会顶出屏幕 */}
      <div
        className={`grid gap-0.5 max-h-[min(14rem,50vh)] overflow-y-auto overflow-x-hidden ${gridCols}`}
      >
        {visible.map((entry) => {
          const { char, keywords } = parseEmojiEntry(entry)
          // 颜文字是多字素簇文本,搜索时混在表情里也要按宽条目排版
          const wide = activeWide || isWideEntry(char)
          return (
            <button
              key={entry}
              onClick={() => handlePick(char)}
              className={
                wide
                  ? `${searching ? 'col-span-8' : ''} h-8 px-1 flex items-center justify-center rounded hover:bg-muted text-[11px] leading-none transition-colors`
                  : 'h-8 w-8 flex items-center justify-center rounded hover:bg-muted text-lg transition-colors'
              }
              title={keywords}
            >
              <span className={wide ? 'truncate' : undefined}>{char}</span>
            </button>
          )
        })}
      </div>

      {searching && visible.length === 0 && (
        <p className="py-6 text-center text-xs" style={{ color: '#8E8EA0' }}>
          {t('No emoji found')}
        </p>
      )}
    </div>
  )
}
