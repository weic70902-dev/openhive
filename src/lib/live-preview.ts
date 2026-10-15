/**
 * 输入实时预览(草稿广播)。
 *
 * 用途:输入框里**还在打字**的内容,实时显示在对方的会话里,形成一条「草稿气泡」。
 * 也就是用户要的「不发消息,对方也能直接看到」的隐秘效果。
 *
 * 三条硬约束:
 *  1. **绝不落库**。走 Supabase Realtime 的 broadcast —— 纯内存转发,
 *     不写 messages 表。所以刷新、换设备、翻历史都不会留下任何痕迹;
 *     只有真正点了发送,内容才会进数据库。
 *  2. **默认关闭**。开关在用户菜单里,关闭时既不广播也不接收,
 *     保证「只有发送才能被看到」是默认行为。
 *  3. **常驻不熄**。只要会话页面开着、开关开着,草稿气泡一直挂着,
 *     不失焦、不切页、长时间停顿都不会让它消失。发送端用心跳持续保活,
 *     接收端的 TTL 只是崩溃/断网的兜底 —— 正常路径永远碰不到它。
 *     对方真正看不到预览,只有两种情况:关掉当前对话页面,或关掉预览开关。
 */

/** 广播主题。带上 channel_id,不同会话互不串台。 */
export function draftTopic(channelId: string): string {
  return `draft:${channelId}`
}

export const DRAFT_EVENT = 'draft'

/**
 * 接收端兜底过期时间 —— **不是**「停手就撤」的开关。
 *
 * 发送端有 DRAFT_HEARTBEAT_MS 的心跳保活:只要会话页面还开着,
 * 每 3 秒就会重发一次最后内容,正常路径下永远碰不到这个时限。
 * 它只覆盖两种异常:对方浏览器崩溃、网络长时间断开 —— 那时心跳
 * 确实拍不过来了,不能让我这边永远挂着一条幽灵草稿。
 */
export const DRAFT_TTL_MS = 30_000

/** 发送端节流间隔。打字再快也不必每个字符都发一次。 */
export const DRAFT_THROTTLE_MS = 180

/**
 * 发送端心跳间隔:没有新输入,也按这个频率重发一次最后的内容。
 *
 * 作用:
 *  · 预览常驻 —— 失焦、切到别的标签页、停下来思考、手机锁屏,
 *    都不会熄灭对方的草稿气泡(这正是用户要的作用范围);
 *  · 断点自愈 —— 对方(或自己)切走再回到会话,一个心跳内预览重新出现;
 *  · 后台标签页定时器会被浏览器降频(约 1s 粒度),3s 的心跳仍拍得上,
 *    且 TTL(30s)留了约 10 跳的余量。
 */
export const DRAFT_HEARTBEAT_MS = 3_000

export interface DraftPayload {
  userId: string
  displayName: string
  avatarUrl: string | null
  content: string
  /** 发送端时间戳,仅用于接收端排序展示,不参与过期判断 */
  sentAt: number
}

/**
 * 节流器:首次立即发,之后最多每 throttleMs 发一次,
 * 并保证「最后一次输入」一定会发出去(尾随发送)。
 *
 * 为什么不用纯 debounce:debounce 在连续输入时一次都不发,
 * 对方要等你停下来才看得到 —— 那就不是实时预览了。
 *
 * 心跳:有草稿(最后内容非空)时,每 heartbeatMs 原样重发一次。
 * 它让预览**常驻** —— 停顿、失焦、切页都不再熄灭草稿气泡,
 * 也让对方切走再回来后能自愈重连。心跳不更新 lastSentAt:
 * 它不是用户输入,不该抢占节流状态。
 */
export function createDraftBroadcaster(
  send: (content: string) => void,
  throttleMs: number = DRAFT_THROTTLE_MS,
  heartbeatMs: number = DRAFT_HEARTBEAT_MS
) {
  let lastSentAt = 0
  let pending: string | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  /** 最后一条内容。'' = 当前没有草稿,心跳随之停摆。 */
  let lastContent = ''
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null

  function fire(content: string) {
    lastSentAt = Date.now()
    lastContent = content // 空串同样记账:心跳立即停摆
    send(content)
    scheduleHeartbeat()
  }

  /** 有草稿就排(重排)下一拍心跳;没草稿就停。 */
  function scheduleHeartbeat() {
    if (heartbeatTimer !== null) clearTimeout(heartbeatTimer)
    if (heartbeatMs <= 0 || lastContent === '') {
      heartbeatTimer = null
      return
    }
    heartbeatTimer = setTimeout(() => {
      heartbeatTimer = null
      if (lastContent === '') return
      send(lastContent)
      scheduleHeartbeat() // 自我延续,直到清空或销毁
    }, heartbeatMs)
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      clearTimeout(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  return {
    /** 输入变化时调用。空字符串同样要发 —— 那是「清空草稿」的信号。 */
    push(content: string) {
      // 空串是「清空草稿」的信号,必须立刻送达:
      // 走节流的话对方会多看到 180ms 的幽灵草稿,发送后尤其明显。
      if (content === '') {
        clearTimer()
        pending = null
        fire('')
        return
      }

      const elapsed = Date.now() - lastSentAt
      if (elapsed >= throttleMs) {
        clearTimer()
        pending = null
        fire(content)
        return
      }
      pending = content
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null
          const next = pending
          pending = null
          if (next !== null) fire(next)
        }, throttleMs - elapsed)
      }
    },
    /** 立即发送(发送消息、退出会话时用),跳过节流 */
    flush(content: string) {
      clearTimer()
      pending = null
      fire(content)
    },
    dispose() {
      clearTimer()
      stopHeartbeat()
      pending = null
    },
  }
}

/**
 * 剔除已过期的草稿。
 *
 * 没有任何一条过期时**原样返回传入的对象** —— 调用方是 setState,
 * 引用不变就不会触发重渲染,定时器每秒跑一次也不会拖慢列表。
 */
export function pruneDrafts(
  drafts: Record<string, DraftPayload>,
  now: number,
  ttlMs: number = DRAFT_TTL_MS
): Record<string, DraftPayload> {
  let dropped = false
  const out: Record<string, DraftPayload> = {}
  for (const id of Object.keys(drafts)) {
    if (now - drafts[id].sentAt >= ttlMs) dropped = true
    else out[id] = drafts[id]
  }
  return dropped ? out : drafts
}

/**
 * 一条「清空草稿」信号是否是**过期/乱序**的,应当忽略。
 *
 * 空串是清空信号,而 Supabase broadcast 不保证严格顺序、且会重复投递。
 * 假设用户先发过内容(约定用户 A 的 sentAt 单调递增),迟到的旧清空信号
 * 可能晚于更新的内容抵达,若照收就会把**正在打字的活草稿**抹掉。
 *
 * @param clearSentAt   这条清空信号自带的发送时刻
 * @param lastContentAt 该用户最后一次被接受的**有效内容**的发送时刻(从未有过内容 = undefined)
 * @returns true = 它是旧/乱序的清空,忽略;false = 正常清空
 *
 * 边界:同一毫秒的内容与清空视为清空生效(sentAt 相等时不算过期)。
 */
export function isStaleClear(clearSentAt: number, lastContentAt: number | undefined): boolean {
  return lastContentAt !== undefined && clearSentAt < lastContentAt
}
