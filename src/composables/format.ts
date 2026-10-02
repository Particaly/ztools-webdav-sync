/** 字节格式化：B / KB / MB / GB（与设计稿一致的 1 位小数风格） */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 时钟格式化：HH:MM */
export function fmtClock(ts: number): string {
  const d = new Date(ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 同一天的判断 */
function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

/** 相对时间：刚刚 / N 分钟前 / 今天 HH:MM / 昨天 HH:MM / N 天前 / YYYY-MM-DD */
export function fmtRelTime(ts: number | null | undefined): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 30 * 1000) return '刚刚'
  if (diff < 60 * 1000) return '1 分钟内'
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`
  const now = new Date()
  const d = new Date(ts)
  if (isSameDay(now, d)) return `今天 ${fmtClock(ts)}`
  const yesterday = new Date(now.getTime() - 86400 * 1000)
  if (isSameDay(yesterday, d)) return `昨天 ${fmtClock(ts)}`
  if (diff < 7 * 86400 * 1000) return `${Math.floor(diff / 86400 / 1000)} 天前`
  const p = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 冲突弹窗中的大小展示（如 4.2 KB） */
export const fmtSize = fmtBytes
