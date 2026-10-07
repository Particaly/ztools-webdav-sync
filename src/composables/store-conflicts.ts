/* eslint-disable */
// store-conflicts.ts —— 冲突域：弹窗队列的消费
// （resolveConflict）、行内入口（openConflictFor）与手动落地（applyManualConflict，
// 真实路径复用 runSync 完整状态机）。等待表 conflictResolvers 在 core。
import { state, conflictResolvers, persist } from './store-core'
import { runSync } from './store-dirs'
import type { ConflictInfo, SyncDir } from '../env.d'

/**
 * 用户在冲突弹窗中做出选择。

 * 勾选「对本轮剩余冲突都这样处理」时向引擎回传 applyToRemaining，
 * 本轮后续冲突由引擎直接按该选择解决（不再进入弹窗队列）。
 */
export function resolveConflict(choice: 'local' | 'remote' | 'both') {
  const info = state.activeConflict
  if (!info) return
  const resolve = conflictResolvers.get(info)
  conflictResolvers.delete(info)
  state.conflictQueue = state.conflictQueue.filter((c) => c !== info)
  state.activeConflict = state.conflictQueue[0] ?? null
  if (!state.activeConflict) state.conflictApplyAll = false
  resolve?.(state.conflictApplyAll ? { choice, applyToRemaining: true } : choice)
}

/**
 * 手动打开某目录的冲突处理（行内「处理」按钮）。
 * 【demo/兼容路径】入口由 DirRow 的冲突提示条触发，而该提示条要求
 * status === 'conflict' && conflictFile —— 真实同步状态机从不产生该状态，
 * 只有 ?demo=conflict 场景与历史持久化数据会走到这里。
 * 即便被触发，applyManualConflict 的真实分支也会复用引擎完整状态机
 * （runSync + 固定冲突策略），不会绕过安全链路，因此保留不作删除。
 */
export function openConflictFor(dir: SyncDir) {
  if (!dir.conflictFile) return
  const info: ConflictInfo = {
    dirId: dir.id,
    rel: dir.conflictFile,
    local: { size: dir.conflictLocal?.size ?? 0, mtimeMs: dir.conflictLocal?.mtimeMs ?? Date.now() - 180000 },
    remote: { size: dir.conflictRemote?.size ?? 0, mtimeMs: dir.conflictRemote?.mtimeMs ?? Date.now() },
  }
  state.conflictQueue.push(info)
  state.activeConflict = info
  conflictResolvers.set(info, (rawChoice) => {
    // 行内打开的冲突在引擎外解决：直接按选择落地。
    // 'defer' 只可能来自调度器（后台轮），UI 弹窗从不产生 —— 此处忽略即可
    const choice = typeof rawChoice === 'string' ? rawChoice : rawChoice.choice
    if (choice === 'defer') return
    void applyManualConflict(dir.id, info, choice)
  })
}

export async function applyManualConflict(dirId: string, _info: ConflictInfo, choice: 'local' | 'remote' | 'both') {
  // 按 id 取响应式目录对象，保证状态变更触发渲染
  const dir = state.dirs.find((d) => d.id === dirId)
  if (!dir) return
  // 演示模式：直接按选择落地状态
  if (state.demo || !window.services) {
    dir.status = 'synced'
    dir.conflictFile = null
    dir.lastSyncAt = Date.now()
    dir.justCompleted = true
    dir.lastResult = { uploaded: choice === 'remote' ? 0 : 1, downloaded: choice === 'local' ? 0 : 1, deleted: 0, conflicts: 1, deferredConflicts: 0, adopted: 0, bytesUp: 0, bytesDown: 0, totalFiles: 2, warnings: [], errors: [], errorsDropped: 0 }
    setTimeout(() => {
      dir.justCompleted = false
    }, 12000)
    // 立即 persist（不防抖）：demo 冲突落地是单次低频操作，保持立即最简单
    persist()
    return
  }
  // 真实路径：以目录自身模式重跑引擎的完整状态机（SCAN→PLAN→EXECUTE→VERIFY→COMMIT），
  // 仅把冲突策略固定为用户的选择，与自动同步共用同一条安全链路 —— 不改用 upload
  // 模式整目录重传（会让本地删除在单向模式下意外传播到远端）；失败按整轮失败处理，
  // 不会出现部分提交。
  await runSync(dir, { conflictStrategy: choice })
}

