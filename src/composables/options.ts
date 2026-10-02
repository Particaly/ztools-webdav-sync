/**
 * 共享下拉选项：同步间隔 / 冲突处理策略。
 * 设置页（SettingsView）与「创建 / 修改同步目录」弹窗（DirFormModal）共用同一份，
 * 修改取值范围时只需改这里。
 */
import type { Prefs } from '../env.d'

/** 自动同步轮询间隔（分钟） */
export const intervalOptions = [1, 5, 10, 15, 30, 60].map((m) => ({ value: m, label: `${m} 分钟` }))

/** 冲突处理策略：同一个文件在电脑和云端都被修改时的默认行为 */
export const strategyOptions = [
  { value: 'ask', label: '询问我' },
  { value: 'local', label: '保留电脑版本' },
  { value: 'remote', label: '保留云端版本' },
  { value: 'both', label: '两个都留' },
] satisfies { value: Prefs['conflictStrategy']; label: string }[]
