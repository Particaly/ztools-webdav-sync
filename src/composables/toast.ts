import { ref } from 'vue'

/** 通知类型：成功 / 错误 / 警告 / 信息 */
export type ToastType = 'success' | 'error' | 'warning' | 'info'

/** 单条顶部通知 */
export interface ToastItem {
  id: number
  type: ToastType
  /** 主标题（如「连接成功」） */
  title: string
  /** 次要信息（如「服务器响应 128 ms」） */
  detail?: string
  /** 自动关闭时长（ms） */
  duration: number
  /** 创建时间（悬停暂停时计算剩余时长用） */
  createdAt: number
}

/** 同时最多展示的条数，超出时收起最早的 */
const MAX_VISIBLE = 3

/** 各类型的默认停留时长（ms）：错误信息给用户更长的阅读时间 */
const DEFAULT_DURATION: Record<ToastType, number> = {
  success: 2800,
  info: 3200,
  warning: 4200,
  error: 5200,
}

const toasts = ref<ToastItem[]>([])

let nextId = 1
/** 运行中的自动关闭定时器（id → timer） */
const timers = new Map<number, ReturnType<typeof setTimeout>>()
/** 悬停暂停时记录的剩余时长（id → ms） */
const remaining = new Map<number, number>()

function clearTimer(id: number) {
  const t = timers.get(id)
  if (t !== undefined) {
    clearTimeout(t)
    timers.delete(id)
  }
}

/** 立即移除一条通知（出场动画由 AppToasts 的 TransitionGroup 处理） */
function dismiss(id: number) {
  clearTimer(id)
  remaining.delete(id)
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

function startTimer(id: number, ms: number) {
  clearTimer(id)
  timers.set(id, setTimeout(() => dismiss(id), ms))
}

function push(type: ToastType, title: string, detail?: string, duration?: number): number {
  const item: ToastItem = {
    id: nextId++,
    type,
    title,
    detail,
    duration: duration ?? DEFAULT_DURATION[type],
    createdAt: Date.now(),
  }
  toasts.value.push(item)
  while (toasts.value.length > MAX_VISIBLE) {
    dismiss(toasts.value[0].id)
  }
  startTimer(item.id, item.duration)
  return item.id
}

/** 鼠标悬停时暂停自动关闭，记录剩余时长 */
function pause(id: number) {
  if (!timers.has(id)) return
  clearTimer(id)
  const item = toasts.value.find((t) => t.id === id)
  if (item) remaining.set(id, Math.max(600, item.duration - (Date.now() - item.createdAt)))
}

/** 鼠标移出后按剩余时长恢复倒计时 */
function resume(id: number) {
  const left = remaining.get(id)
  remaining.delete(id)
  if (left !== undefined) startTimer(id, left)
  else if (toasts.value.some((t) => t.id === id)) startTimer(id, 1200)
}

/** 全局通知入口：toast.success('连接成功', '服务器响应 128 ms') */
export const toast = {
  success: (title: string, detail?: string) => push('success', title, detail),
  error: (title: string, detail?: string) => push('error', title, detail),
  warning: (title: string, detail?: string) => push('warning', title, detail),
  info: (title: string, detail?: string) => push('info', title, detail),
}

/** 通知列表（供 AppToasts 渲染） */
export function useToasts() {
  return toasts
}

export { dismiss as dismissToast, pause as pauseToast, resume as resumeToast }
