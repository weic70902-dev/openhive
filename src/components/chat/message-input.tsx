'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent, Extension } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import Mention from '@tiptap/extension-mention'
import { SendHorizonal, Paperclip, Bold, Italic, Code, CodeSquare, ChevronUp, Clock, Smile } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { FloatingPanel } from '@/components/ui/floating-panel'
import { getSupabaseClient } from '@/lib/supabase/client'
import { useAppStore } from '@/lib/store/app-store'
import type { Profile, SlashCommand } from '@/types/database'
import { SlashCommandPicker } from './slash-command-picker'
import { EmojiPicker } from './emoji-picker'
import { BUILTIN_COMMANDS, type BuiltinCommand } from '@/lib/slash-commands'
import { ScheduleMessageDialog } from './schedule-message-dialog'
import { useT } from '@/lib/i18n'
import { sanitizeImageFile } from '@/lib/image'
import { SIGNED_TTL_SECONDS, cacheSignedUrl } from '@/lib/attachment-url'

interface MessageInputProps {
  channelId?: string
  channelName: string
  onSend: (content: string, attachments?: string[]) => Promise<void>
  placeholder?: string
  /**
   * 输入实时预览。传入时,每次输入变化都会回调当前文本(可能是空串 = 已清空);
   * 不传 = 该功能关闭,输入框不做任何广播。
   */
  onDraftChange?: (content: string) => void
}

// Convert TipTap HTML to our storage format (simplified markdown-like)
function htmlToContent(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html

  function walk(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''

    const el = node as HTMLElement
    const tag = el.tagName?.toLowerCase()
    const children = Array.from(el.childNodes).map(walk).join('')

    switch (tag) {
      case 'strong':
      case 'b':
        return `**${children}**`
      case 'em':
      case 'i':
        return `_${children}_`
      case 'code':
        if (el.parentElement?.tagName?.toLowerCase() === 'pre') return children
        return `\`${children}\``
      case 'pre':
        return `\`\`\`\n${children}\n\`\`\``
      case 'p':
        return children + '\n'
      case 'br':
        return '\n'
      case 'span':
        // Handle mentions
        if (el.dataset.type === 'mention') {
          return `@${el.dataset.id || children}`
        }
        return children
      default:
        return children
    }
  }

  return walk(div).replace(/\n+$/, '').trim()
}

/**
 * 从剪贴板取出图片文件。
 * 截图在剪贴板里表现为 kind === 'file' 的 image/png 项,
 * 从文件管理器复制的图片文件同理。
 * 只取图片,避免把 Excel/网页复制时夹带的临时文件也传上去。
 */
function extractClipboardImages(data: DataTransfer | null): File[] {
  if (!data) return []
  const out: File[] = []
  for (const item of Array.from(data.items)) {
    if (item.kind !== 'file') continue
    const f = item.getAsFile()
    if (f && f.type.startsWith('image/')) out.push(f)
  }
  return out
}

export function MessageInput({ channelId, channelName, onSend, placeholder, onDraftChange }: MessageInputProps) {
  const { workspace } = useAppStore()
  const [sending, setSending] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  // 附件分两个 URL:
  //  · url        —— 公开直链,**写进消息正文的那一个**。数据库里存的是它,
  //                 渲染时由 useSignedText 现换签名 URL(见 hooks/use-signed-text)。
  //  · previewUrl —— 签名 URL,**只给发送前的预览 chip 用**。桶私有后公开直链
  //                 直接 <img> 会 403,预览必须用签名版。
  const [attachments, setAttachments] = useState<{ name: string; url: string; previewUrl?: string; isImage?: boolean }[]>([])
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [members, setMembers] = useState<Profile[]>([])
  const membersRef = useRef<Profile[]>([])
  const [showSlashPicker, setShowSlashPicker] = useState(false)
  const [slashQuery, setSlashQuery] = useState('')
  const [slashPosition, setSlashPosition] = useState({ left: 0, bottom: 0 })
  const showSlashPickerRef = useRef(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [showSendMenu, setShowSendMenu] = useState(false)
  const [showEmojiPicker, setShowEmojiPicker] = useState(false)
  // 表情按钮本身作为 portal 浮层的定位锚点(浮层挂在 body 上,不再受输入框 overflow 影响)
  const emojiAnchorRef = useRef<HTMLButtonElement>(null)
  const t = useT()

  // 粘贴/拖拽发生在 TipTap 的 editorProps 里,而 editorProps 只在创建编辑器时捕获一次。
  // 用 ref 持有最新的 uploadFiles,避免闭包停留在首次渲染的版本。
  const uploadFilesRef = useRef<((files: FileList | File[]) => Promise<void>) | null>(null)

  // onUpdate 同样只在创建编辑器时捕获一次,所以回调也必须走 ref,
  // 否则开关切换后广播的还是旧闭包(可能指向已销毁的 channel)。
  const onDraftChangeRef = useRef(onDraftChange)
  useEffect(() => {
    onDraftChangeRef.current = onDraftChange
  }, [onDraftChange])

  // Keep ref in sync with state so TipTap suggestion callback always sees latest
  useEffect(() => {
    membersRef.current = members
  }, [members])

  // Keep slash picker ref in sync
  useEffect(() => {
    showSlashPickerRef.current = showSlashPicker
  }, [showSlashPicker])

  // Load channel members (or workspace members as fallback) for @mentions
  useEffect(() => {
    const client = getSupabaseClient()
    if (!client || !workspace) return

    async function loadMembers() {
      if (channelId) {
        // Load members of the current channel
        const { data } = await client!
          .from('channel_members')
          .select('profile:profiles(*)')
          .eq('channel_id', channelId)

        if (data && data.length > 0) {
          const profiles = data
            .map((d: Record<string, unknown>) => d.profile as Profile)
            .filter(Boolean)
          setMembers(profiles)
          return
        }
      }

      // Fallback: load all workspace members
      const { data } = await client!
        .from('workspace_members')
        .select('profile:profiles(*)')
        .eq('workspace_id', workspace!.id)

      if (data) {
        const profiles = data
          .map((d: Record<string, unknown>) => d.profile as Profile)
          .filter(Boolean)
        setMembers(profiles)
      }
    }

    loadMembers()
  }, [workspace, channelId])

  // Custom Enter key extension
  const EnterSubmit = Extension.create({
    name: 'enterSubmit',
    addKeyboardShortcuts() {
      return {
        Enter: ({ editor }) => {
          // Shift+Enter for newline
          return false // let default handle, we check in onKeyDown
        },
      }
    },
  })

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        horizontalRule: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
      }),
      Placeholder.configure({
        placeholder: placeholder || t('Message #{name}', { name: channelName }),
      }),
      Mention.configure({
        HTMLAttributes: {
          class: 'mention',
        },
        suggestion: {
          items: ({ query }: { query: string }) => {
            return membersRef.current
              .filter((m) =>
                m.display_name.toLowerCase().includes(query.toLowerCase())
              )
              .slice(0, 8)
          },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          render: () => {
            let popup: HTMLDivElement | null = null
            let selectedIndex = 0
            let items: Profile[] = []
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let command: any = null

            // SECURITY: Escape HTML entities to prevent XSS via display names
            function escapeHtml(str: string): string {
              return str
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;')
            }

            function updatePopup() {
              if (!popup) return
              popup.innerHTML = items
                .map(
                  (item, i) => {
                    const safeName = escapeHtml(item.display_name || '')
                    const initial = escapeHtml(item.display_name?.[0]?.toUpperCase() || '?')
                    return `<button class="mention-item ${i === selectedIndex ? 'is-selected' : ''}" data-index="${i}">
                      <span class="mention-avatar">${initial}</span>
                      <span>${safeName}</span>
                    </button>`
                  }
                )
                .join('')

              popup.querySelectorAll('.mention-item').forEach((btn) => {
                btn.addEventListener('mousedown', (e) => {
                  e.preventDefault()
                  const idx = parseInt((btn as HTMLElement).dataset.index || '0')
                  const item = items[idx]
                  if (item && command) {
                    command({ id: item.id, label: item.display_name })
                  }
                })
              })
            }

            return {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onStart: (props: any) => {
                items = props.items
                command = props.command
                selectedIndex = 0

                popup = document.createElement('div')
                popup.className = 'mention-popup'
                document.body.appendChild(popup)

                updatePopup()

                if (props.clientRect) {
                  const rect = props.clientRect?.()
                  if (rect && popup) {
                    popup.style.left = `${rect.left}px`
                    popup.style.top = `${rect.top - popup.offsetHeight - 8}px`
                  }
                }
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onUpdate: (props: any) => {
                items = props.items
                selectedIndex = 0
                updatePopup()

                if (props.clientRect && popup) {
                  const rect = props.clientRect?.()
                  if (rect) {
                    popup.style.left = `${rect.left}px`
                    popup.style.top = `${rect.top - popup.offsetHeight - 8}px`
                  }
                }
              },
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              onKeyDown: (props: any) => {
                if (props.event.key === 'ArrowUp') {
                  selectedIndex = (selectedIndex - 1 + items.length) % items.length
                  updatePopup()
                  return true
                }
                if (props.event.key === 'ArrowDown') {
                  selectedIndex = (selectedIndex + 1) % items.length
                  updatePopup()
                  return true
                }
                if (props.event.key === 'Enter') {
                  const item = items[selectedIndex]
                  if (item && command) {
                    command({ id: item.id, label: item.display_name })
                  }
                  return true
                }
                return false
              },
              onExit: () => {
                if (popup) {
                  popup.remove()
                  popup = null
                }
              },
            }
          },
        },
      }),
    ],
    onUpdate: ({ editor }) => {
      const text = editor.getText()

      // 输入实时预览(非 IME 组合态):把当前文本广播出去(不落库)。
      //
      // IME 组合态(中文等输入法)**不在这里推**,交给 editorProps 的
      // compositionupdate / compositionend:
      //  · 组合中 getText() 会读到空串或半截文本,而空串是「清空草稿」
      //    控制信号,误发会把对方的活草稿抹掉(双方同时打字时尤为明显);
      //  · 组合态下文档未必同步,读 DOM 才是用户眼前正在输入的内容 ——
      //    中文必须「边打边实时预览」,不能等组合结束:那既不是实时,
      //    也可能永远不来(组合最后一刻若没有新事务,onUpdate 不再触发,
      //    中文就卡在输入框里、对方永远看不到)。
      if (!editor.view.composing) {
        // 空串也要发 —— 那是「我清空了输入框」的信号,对方据此撤掉草稿气泡。
        // 注意:只有「内容真的变成空」才发空串。失焦、切页、停手不发任何信号 ——
        // 草稿的保活由发送端心跳负责(见 lib/live-preview.ts),预览会一直挂着,
        // 直到关掉当前对话页面或关掉预览开关。
        onDraftChangeRef.current?.(text)
      }

      if (text.startsWith('/') && !text.includes(' ')) {
        setSlashQuery(text)
        setShowSlashPicker(true)
        // Position the picker above the input
        const editorEl = editor.view.dom.closest('.rounded-2xl')
        if (editorEl) {
          const rect = editorEl.getBoundingClientRect()
          setSlashPosition({ left: rect.left + 16, bottom: window.innerHeight - rect.top + 8 })
        }
      } else {
        setShowSlashPicker(false)
      }
    },
    editorProps: {
      attributes: {
        class: 'tiptap-editor',
      },
      // 粘贴图片 / 截图 —— 直接读剪贴板里的图片文件并上传。
      // 纯文本和表情不拦截,交给浏览器默认行为插入到光标处。
      handlePaste: (_view, event) => {
        const files = extractClipboardImages(event.clipboardData)
        if (files.length === 0) return false
        event.preventDefault()
        uploadFilesRef.current?.(files)
        return true
      },
      // 拖拽落在编辑器内部时 ProseMirror 会先接管,这里补一道,
      // 保证与容器上的 onDrop 行为一致。
      handleDrop: (_view, event) => {
        const dt = (event as DragEvent).dataTransfer
        if (!dt || dt.files.length === 0) return false
        event.preventDefault()
        uploadFilesRef.current?.(dt.files)
        return true
      },
      handleKeyDown: (_view, event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          // Check if mention popup is open
          const mentionPopup = document.querySelector('.mention-popup')
          if (mentionPopup) return false // Let mention handle it

          // Don't submit if slash picker is open (handled by picker's keydown)
          if (showSlashPickerRef.current) {
            return false
          }

          event.preventDefault()
          handleSend()
          return true
        }
        return false
      },
      // 输入法(IME)组合事件 —— 中文实时预览的关键路径。
      handleDOMEvents: {
        // 组合期逐拍推送编辑区当前文本:拼音/候选每变一次就广播一次,
        // 对方「边打边看」,不等组合结束。
        // 组合态下文档可能还没同步,读 DOM 才拿得到用户眼前正在输入的字。
        // 空串不发 —— 那是「清空草稿」控制信号,组合过渡的瞬时读空会误伤对方。
        compositionupdate: (view) => {
          const imeText = view.dom.textContent ?? ''
          if (imeText !== '') onDraftChangeRef.current?.(imeText)
          return false
        },
        // 组合结束(提交 / 取消 / 删空):补发一次最终文本。
        // 空串也发 —— 此刻「空」就是真实状态,该撤草稿。
        // 之后 onUpdate 还会带文档同步后的权威文本到达,内容一致,无副作用。
        compositionend: (view) => {
          onDraftChangeRef.current?.(view.dom.textContent ?? '')
          return false
        },
      },
    },
    content: '',
    immediatelyRender: false,
  })

  // Update placeholder when prop changes
  useEffect(() => {
    if (editor) {
      editor.extensionManager.extensions
        .filter((ext) => ext.name === 'placeholder')
        .forEach((ext) => {
          (ext.options as { placeholder: string }).placeholder = placeholder || t('Message #{name}', { name: channelName })
          editor.view.dispatch(editor.state.tr)
        })
    }
  }, [channelName, placeholder, editor])

  const handleSend = useCallback(async () => {
    if (!editor || sending) return

    const html = editor.getHTML()
    const content = htmlToContent(html)
    if (!content.trim() && attachments.length === 0) return

    // Build final content with attachments
    let finalContent = content
    if (attachments.length > 0) {
      // 图片走 markdown 图片语法(消息气泡会渲染成内联预览),
      // 其余文件仍走附件链接语法
      const fileLines = attachments
        .map((a) => (a.isImage ? `![${a.name}](${a.url})` : `📎 [${a.name}](${a.url})`))
        .join('\n')
      finalContent = finalContent ? `${finalContent}\n${fileLines}` : fileLines
    }

    setSending(true)
    try {
      await onSend(finalContent)
      editor.commands.clearContent()
      setAttachments([])
      // 发送成功 = 草稿已变成正式消息,立刻撤掉对方那边的草稿气泡
      onDraftChangeRef.current?.('')
    } finally {
      setSending(false)
      editor.commands.focus()
    }
  }, [editor, sending, onSend, attachments])

  function handleSlashCommand(command: BuiltinCommand | SlashCommand) {
    if (!editor) return
    setShowSlashPicker(false)

    if ('handler' in command) {
      // Built-in command
      const currentText = editor.getText()
      const args = currentText.slice(command.command.length).trim()
      const result = command.handler(args)

      if (result.type === 'replace') {
        editor.commands.clearContent()
        // Set the content and send
        editor.commands.setContent(`<p>${result.text}</p>`)
        // Auto-send
        setTimeout(() => handleSend(), 50)
      }
    } else {
      // Custom slash command (from DB) - send as is for now
      const text = `/${command.command}`
      editor.commands.clearContent()
      editor.commands.setContent(`<p>${text}</p>`)
      setTimeout(() => handleSend(), 50)
    }
  }

  // File upload handler — uses server-side API route to bypass RLS
  async function uploadFiles(files: FileList | File[]) {
    setUploading(true)
    const newAttachments: { name: string; url: string; previewUrl?: string; isImage?: boolean }[] = []

    // Get auth session for upload authentication
    const client = getSupabaseClient()
    const session = client ? (await client.auth.getSession()).data.session : null

    for (const rawFile of Array.from(files)) {
      try {
        // 图片先经 canvas 重编码:剥离 EXIF(含 GPS 定位)并限制最大边长。
        // 非图片、GIF、SVG 或解码失败时原样返回,不会中断上传。
        const { file, sanitized, originalSize } = await sanitizeImageFile(rawFile)
        if (sanitized) {
          console.info(
            `[upload] 已剥离图片元数据: ${rawFile.name} ` +
              `${(originalSize / 1024).toFixed(0)}KB → ${(file.size / 1024).toFixed(0)}KB`
          )
        }
        const isImage = file.type.startsWith('image/')

        const ext = file.name.split('.').pop()
        const safeName = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
        const path = `uploads/${safeName}`

        const formData = new FormData()
        formData.append('file', file)
        formData.append('bucket', 'attachments')
        formData.append('path', path)

        const headers: Record<string, string> = {}
        if (session?.access_token) {
          headers.Authorization = `Bearer ${session.access_token}`
        }

        const res = await fetch('/api/upload', { method: 'POST', body: formData, headers })
        const data = await res.json()

        if (!res.ok || !data.publicUrl) {
          throw new Error(data.error || 'Upload failed')
        }

        // 附件桶已私有化:上传返回的仍是公开直链(数据库里也存它),
        // 但预览这里要能立刻看到图 —— 换成签名 URL。
        // 签失败(网络/桶还是 public)就沿用原 URL,不会挡住发送。
        let previewUrl = data.publicUrl as string
        try {
          const client = getSupabaseClient()
          if (client && data.path) {
            const { data: signed } = await client.storage
              .from('attachments')
              .createSignedUrl(data.path, SIGNED_TTL_SECONDS)
            if (signed?.signedUrl) {
              previewUrl = signed.signedUrl
              cacheSignedUrl({ bucket: 'attachments', path: data.path }, signed.signedUrl, SIGNED_TTL_SECONDS)
            }
          }
        } catch {
          // 忽略:回落原 URL
        }

        newAttachments.push({ name: file.name, url: data.publicUrl, previewUrl, isImage })
      } catch (err) {
        console.error('Failed to upload file:', err)
        alert(t('File upload failed: {error}', { error: err instanceof Error ? err.message : t('Unknown error') }))
      }
    }

    setAttachments((prev) => [...prev, ...newAttachments])
    setUploading(false)
  }

  // 每次渲染后把最新的 uploadFiles 写进 ref,供 editorProps 里的粘贴/拖拽回调使用
  useEffect(() => {
    uploadFilesRef.current = uploadFiles
  })

  // Drag & drop
  const dragCounterRef = useRef(0)

  function handleDragEnter(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) {
      setIsDragging(true)
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
  }

  function handleDragLeave(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) {
      setIsDragging(false)
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current = 0
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files)
    }
  }

  const isEmpty = !editor?.getText().trim() && attachments.length === 0

  return (
    // 底部内边距叠加 iOS 安全区:独立安装(PWA/主屏)时,小黑条会盖住输入框,
    // 用 env(safe-area-inset-bottom) 把输入框顶出危险区;桌面浏览器该值为 0,无副作用。
    // (配合 app/layout.tsx 的 viewportFit: 'cover' 才会生效)
    <div className="px-5 pt-2 pb-[calc(1rem+env(safe-area-inset-bottom))]">
      <div
        className={`rounded-2xl transition-all ${
          isDragging ? 'border-2 border-[#7C5CFC] bg-[#EDE5FF]' : 'border border-[#E5E1EE] shadow-sm'
        }`}
        style={{ background: isDragging ? undefined : '#fff' }}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Drag overlay */}
        {isDragging && (
          <div className="px-4 py-6 text-center text-sm font-medium" style={{ color: '#7C5CFC' }}>
            {t('Drop files here to upload')}
          </div>
        )}

        {/* Editor area */}
        {!isDragging && (
          <>
            <div className="px-4 pt-3 pb-1">
              <EditorContent editor={editor} />
            </div>

            {/* Attachments preview */}
            {attachments.length > 0 && (
              <div className="px-4 pb-1 flex flex-wrap gap-2">
                {attachments.map((a, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs"
                    style={{ background: '#F5F2FF', color: '#4A4860' }}
                  >
                    {a.isImage ? (
                      <img
                        src={a.previewUrl ?? a.url}
                        alt={a.name}
                        className="h-8 w-8 rounded-md object-cover shrink-0"
                        style={{ border: '1px solid #E5E1EE' }}
                      />
                    ) : (
                      <Paperclip className="h-3 w-3" />
                    )}
                    <span className="truncate max-w-[150px]">{a.name}</span>
                    <button
                      onClick={() =>
                        setAttachments((prev) => prev.filter((_, j) => j !== i))
                      }
                      className="hover:text-[#E55B5B] ml-1 transition-colors"
                      style={{ color: '#8E8EA0' }}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Toolbar */}
            <div className="px-2 pb-2 flex items-center justify-between">
              <div className="flex items-center gap-0.5">
                <button
                  className={`h-7 w-7 rounded-lg flex items-center justify-center transition-all ${
                    editor?.isActive('bold')
                      ? 'text-[#7C5CFC] bg-[#EDE5FF]'
                      : 'text-[#8E8EA0] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]'
                  }`}
                  onClick={() => editor?.chain().focus().toggleBold().run()}
                  title={t('Bold (Ctrl+B)')}
                >
                  <Bold className="h-4 w-4" />
                </button>
                <button
                  className={`h-7 w-7 rounded-lg flex items-center justify-center transition-all ${
                    editor?.isActive('italic')
                      ? 'text-[#7C5CFC] bg-[#EDE5FF]'
                      : 'text-[#8E8EA0] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]'
                  }`}
                  onClick={() => editor?.chain().focus().toggleItalic().run()}
                  title={t('Italic (Ctrl+I)')}
                >
                  <Italic className="h-4 w-4" />
                </button>
                <button
                  className={`h-7 w-7 rounded-lg flex items-center justify-center transition-all ${
                    editor?.isActive('code')
                      ? 'text-[#7C5CFC] bg-[#EDE5FF]'
                      : 'text-[#8E8EA0] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]'
                  }`}
                  onClick={() => editor?.chain().focus().toggleCode().run()}
                  title={t('Inline code')}
                >
                  <Code className="h-4 w-4" />
                </button>
                <button
                  className={`h-7 w-7 rounded-lg flex items-center justify-center transition-all ${
                    editor?.isActive('codeBlock')
                      ? 'text-[#7C5CFC] bg-[#EDE5FF]'
                      : 'text-[#8E8EA0] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]'
                  }`}
                  onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
                  title={t('Code block')}
                >
                  <CodeSquare className="h-4 w-4" />
                </button>
                <div className="w-px h-4 mx-1" style={{ background: '#E5E1EE' }} />
                {/* 表情:选中后插入光标处,面板保持打开以便连续插入 */}
                <button
                  ref={emojiAnchorRef}
                  className={`h-7 w-7 rounded-lg flex items-center justify-center transition-all ${
                    showEmojiPicker
                      ? 'text-[#7C5CFC] bg-[#EDE5FF]'
                      : 'text-[#8E8EA0] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]'
                  }`}
                  onClick={() => setShowEmojiPicker((v) => !v)}
                  title={t('Insert emoji')}
                >
                  <Smile className="h-4 w-4" />
                </button>
                <button
                  className="h-7 w-7 rounded-lg flex items-center justify-center transition-all text-[#8E8EA0] hover:text-[#2D2B3D] hover:bg-[#F5F2FF]"
                  onClick={() => fileInputRef.current?.click()}
                  title={t('Attach file')}
                  disabled={uploading}
                >
                  <Paperclip className="h-4 w-4" />
                </button>
              </div>
              <div className="flex items-center">
                <button
                  className={`h-8 w-8 rounded-l-xl flex items-center justify-center transition-all ${
                    isEmpty || sending
                      ? 'text-[#DDD6F3] cursor-not-allowed'
                      : 'bg-[#7C5CFC] text-white hover:bg-[#6B4EE6] shadow-sm'
                  }`}
                  disabled={isEmpty || sending}
                  onClick={handleSend}
                >
                  <SendHorizonal className="h-4 w-4" />
                </button>
                <div className="relative">
                  <button
                    className={`h-8 w-5 rounded-r-xl flex items-center justify-center transition-all border-l ${
                      isEmpty || sending
                        ? 'text-[#DDD6F3] cursor-not-allowed border-[#E5E1EE]'
                        : 'bg-[#7C5CFC] text-white hover:bg-[#6B4EE6] shadow-sm border-[#6B4EE6]'
                    }`}
                    disabled={isEmpty || sending}
                    onClick={() => setShowSendMenu(!showSendMenu)}
                  >
                    <ChevronUp className="h-3 w-3" />
                  </button>
                  {showSendMenu && (
                    <div className="absolute bottom-full right-0 mb-1 py-1 min-w-[180px] rounded-xl border bg-white shadow-lg" style={{ borderColor: '#E5E1EE' }}>
                      <button
                        onClick={() => {
                          setShowSendMenu(false)
                          setScheduleOpen(true)
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-[#F5F2FF] text-left text-[#2D2B3D]"
                      >
                        <Clock className="h-3.5 w-3.5" style={{ color: '#7C5CFC' }} />
                        {t('Schedule message')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {showSlashPicker && (
        <SlashCommandPicker
          query={slashQuery}
          onSelect={handleSlashCommand}
          onClose={() => setShowSlashPicker(false)}
          position={slashPosition}
        />
      )}

      <ScheduleMessageDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        content={editor ? htmlToContent(editor.getHTML()) : ''}
        channelId={channelId || ''}
        onScheduled={() => {
          editor?.commands.clearContent()
          setAttachments([])
        }}
      />

      {/* 表情面板
          portal 到 body 并用 fixed 定位:输入框本身处在带 overflow 的容器里,
          面板留在原地会在窄屏上被裁掉。side="top" 让它默认向上展开。 */}
      <FloatingPanel
        anchorRef={emojiAnchorRef}
        open={showEmojiPicker}
        onClose={() => setShowEmojiPicker(false)}
        align="start"
        gap={8}
        side="top"
      >
        <EmojiPicker
          stayOpen
          searchable
          onSelect={(emoji) => editor?.chain().focus().insertContent(emoji).run()}
          onClose={() => setShowEmojiPicker(false)}
        />
      </FloatingPanel>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) uploadFiles(e.target.files)
          e.target.value = ''
        }}
      />
    </div>
  )
}
