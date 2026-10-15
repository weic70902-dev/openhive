/**
 * 清空会话 —— 共享逻辑。
 *
 * 语义:**只对我隐藏**。
 * `cleared_at` 是「我的视图截止点」,不是删除标记 ——
 * 对方的记录一条不少,只是我看不到这之前的了。
 *
 * 为什么要有客户端侧的过滤函数(而不是全交给 SQL):
 * 数据库查询已经带了 `created_at > cleared_at`,但清空功能一旦漏掉一条,
 * 就是**用户明确要求隐藏的内容又冒出来了** —— 这类 bug 比多显示一条更严重。
 * 所以这里再做一层兜底,并且它是纯函数,可以单独测边界。
 */

/**
 * 这条消息对我可见吗?
 *
 * 边界用 `created_at` **严格大于** `cleared_at`:
 * 清空发生在某一刻,那一刻之前发出的消息全部隐藏。
 * 若用「大于等于」,恰好在同一毫秒发出的那条会漏出来。
 */
export function isVisibleAfterClear(createdAt: string, clearedAt: string | null): boolean {
  if (clearedAt === null) return true
  const created = new Date(createdAt).getTime()
  const cleared = new Date(clearedAt).getTime()
  // 解析不出来就当「没清空过」,宁可多显示也不要整片空白
  if (Number.isNaN(created) || Number.isNaN(cleared)) return true
  return created > cleared
}

/**
 * 从数据库返回值里安全地取出 `cleared_at`。
 * 脏数据(空串、非字符串、非法日期)一律当「没清空过」处理。
 */
export function parseClearedAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  return Number.isNaN(new Date(value).getTime()) ? null : value
}

/**
 * 按视图截止点过滤一批消息。
 * 无截止点时**原样返回同一个数组引用**,避免无谓的重渲染。
 */
export function filterVisibleMessages<T extends { created_at: string }>(
  messages: T[],
  clearedAt: string | null
): T[] {
  if (clearedAt === null) return messages
  const filtered = messages.filter((m) => isVisibleAfterClear(m.created_at, clearedAt))
  return filtered.length === messages.length ? messages : filtered
}
