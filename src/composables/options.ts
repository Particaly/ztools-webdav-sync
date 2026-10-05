/**
 * 共享下拉选项：同步间隔 / 冲突处理策略。
 * 设置页（SettingsView）与「创建 / 修改同步目录」弹窗（DirFormModal）共用同一份，
 * 修改取值范围时只需改这里。
 */
import type { Prefs } from '../env.d'

/**
 * 自动同步轮询间隔的可选档位下限（分钟）：低于该值的选项已移除，历史持久化
 * 配置落在被移除档位时由渲染层归一到该值（store.init 的 normalizeLegacyIntervals）。
 * 调度器侧不做钳位 —— e2e 依赖 intervalMin:1 的快排程，语义上「配置什么跑什么」。
 */
export const MIN_INTERVAL_MIN = 15

/** 自动同步轮询间隔（检查频率）选项：15 / 30 分钟与 1–8 小时，小时档以「N 小时」列示 */
export const intervalOptions = [
  { value: 15, label: '15 分钟' },
  { value: 30, label: '30 分钟' },
  { value: 60, label: '1 小时' },
  { value: 120, label: '2 小时' },
  { value: 240, label: '4 小时' },
  { value: 480, label: '8 小时' },
]

/** 冲突处理策略：同一文件在本地与云端均被修改时的默认处理方式 */
export const strategyOptions = [
  { value: 'ask', label: '每次询问' },
  { value: 'local', label: '保留本地' },
  { value: 'remote', label: '保留云端' },
  { value: 'both', label: '同时保留' },
] satisfies { value: Prefs['conflictStrategy']; label: string }[]

/** 并发传输数选项：同时上传 / 下载的文件数量上限 */
export const concurrencyOptions = [1, 2, 3, 4, 6, 8].map((n) => ({ value: n, label: `${n}` }))
