/* eslint-disable */
// store-pending.ts —— 待处理中心域：后台轮 defer 冲突与
// 批量删除确认的统一处理（挂起刷新 / 待处理面板与中心 / 范围决策 / 根丢失决策）。
import { computed } from 'vue'
import { state, MAX_LIST_ITEMS, uid } from './store-core'
import { openConflictFor } from './store-conflicts'
import { syncDir } from './store-dirs'
import { toast } from './toast'
import type { ConflictInfo, SyncDir } from '../env.d'


// ---------- 待处理挂起（后台轮 defer 冲突 + 批量删除确认的统一处理） ----------
//
// 后台（interval/watch）轮的冲突一律 defer 挂起（调度器侧，绝不等待一个看不见的
// 弹窗）；轮末经 pending-conflicts 事件外发清单 + ztools.showNotification 提醒一次
//（同批不重复）。批量删除超阈值（max(50, 基线×20%)）时引擎整批登记「待确认删除」
// 挂起（kind='delete'，无 choice），确认前零删除。用户回窗口后在此面板统一处理：
// 冲突逐条或批量三选一（setPendingChoice 落 choice，下一轮自动解决）；删除确认类
// 逐条或批量「确认删除 / 保留不删」；或「暂时忽略」（clearPendingConflict —— 冲突
// 再出现时才重新询问，删除类下一轮按阈值重新登记；永久失败的文件走失败退避表，
// 不进此通道，不会反复弹窗）。

/** pending-conflicts 事件 → 目录面板数据（choice 已选的条目仍展示，标注待下轮生效） */
export function applyPendingConflicts(dirId: string, items: Array<{ rel: string; createdAt: number; choice?: string; kind?: string }>) {
  const dir = state.dirs.find((d) => d.id === dirId)
  if (!dir) return
  dir.pendingConflicts = items.slice(0, MAX_LIST_ITEMS)
  // 「云端文件夹丢失」待决策的自动弹窗不认事件上的 newlyNotified（只在轮末发一次，
  // 渲染层不在场时即永久丢失）：数据到手即交给 autoPromptRootLost 判定是否补弹
  autoPromptRootLost()
}

/**
 * 「云端文件夹丢失」决策弹窗的统一自动触发，任一数据到手路径都会调用（事件 /
 * 冷启动 / 回窗口 / 轮末兜底 / 面板打开刷新）：发现未决策的 root-lost 挂起、且弹窗
 * 从未为这条登记展示过（rootLostPromptedAt ≠ 挂起 createdAt）时弹窗。送达缺口不再
 * 让弹窗失约；已展示过的登记（含「暂不处理」）也不自动重复打扰，行内提示条可再进入。
 * 待处理中心开着时跳过 —— 中心自身已把根丢失分组排最前，且弹窗会被面板压在下面。
 */
export function autoPromptRootLost() {
  if (state.rootLostPromptDirId && !state.dirs.some((d) => d.id === state.rootLostPromptDirId)) {
    state.rootLostPromptDirId = null
  }
  if (state.rootLostPromptDirId || state.pendingCenterOpen) return
  for (const d of state.dirs) {
    const rec = (d.pendingConflicts ?? []).find((p) => p.kind === 'root-lost' && !p.choice)
    if (rec && d.rootLostPromptedAt !== rec.createdAt) {
      state.rootLostPromptDirId = d.id
      return
    }
  }
}

/** 目录是否存在未决策的「云端文件夹丢失」挂起（提示条 / 面板入口的显示条件） */
export function dirRootLostOpen(d: SyncDir): boolean {
  return (d.pendingConflicts ?? []).some((p) => p.kind === 'root-lost' && !p.choice)
}

/**
 * 目录当前的「待处理信号」：未决策挂起里最新的时间戳（冲突 / 删除逐条登记取
 * createdAt，批量删除取快照 at），无未决策挂起时为 0。口径与 DirRow 行内待处理
 * 挂起条的计数一致（root-lost 有专门提示条、逐文件 delete 无快照时行内也不计）。
 * 作为「不再显示」的比较基准：关闭提示条时记下当时的信号，之后信号变大
 *（有新挂起）提示条重新显示 —— 关闭只对当前这批事项生效。
 */
export function dirPendingSignal(d: SyncDir): number {
  let t = 0
  for (const p of d.pendingConflicts ?? []) {
    if (p.choice || p.kind === 'root-lost' || p.kind === 'delete') continue
    t = Math.max(t, p.createdAt || 0)
  }
  if ((d.deleteBatch?.undecided ?? 0) > 0) t = Math.max(t, d.deleteBatch?.at || 0)
  return t
}

/**
 * 全部目录的待处理信号（各目录 dirPendingSignal 的最大值）：同步记录页顶部
 * 待处理横幅「不再显示」的比较基准，语义同 dirPendingSignal（有新挂起重新提示）。
 */
export function allPendingSignal(dirs: SyncDir[]): number {
  return dirs.reduce((acc, d) => Math.max(acc, dirPendingSignal(d)), 0)
}

/**
 * 关闭目录行内的「待处理挂起条」（不再显示）：记下当前待处理信号到目录的
 * pendingStripMutedAt（随目录持久化）。之后该目录出现更新的挂起时信号变大，
 * 提示条自动恢复显示；待处理中心 / 状态栏入口不受影响。
 */
export function mutePendingStrip(d: SyncDir) {
  d.pendingStripMutedAt = dirPendingSignal(d)
}

/** 拉取某目录当前挂起冲突（面板打开 / 事件外的兜底刷新）。
 *  同步拉取批量删除快照（listDeleteBatch）—— 删除确认的目录树数据源：逐文件
 *  挂起表有 500 条上限，超限部分没有逐文件记录，只有快照承载；两类数据同源
 *  同刷新时机（面板打开 / 轮末兜底 / 冷启动 / 回窗口），一处拉取保证口径一致。 */
export async function refreshPendingConflicts(dir: SyncDir) {
  if (!window.services || state.demo) return
  const dirArg = { id: dir.id, localPath: dir.localPath, remotePath: dir.remotePath, mode: dir.mode }
  try {
    const items = await window.services.sync.listPendingConflicts(dirArg)
    dir.pendingConflicts = (items || []).slice(0, MAX_LIST_ITEMS)
    // 兜底刷新也是数据到手路径：事件丢失后的回窗口 / 冷启动 / 面板打开都经这里补弹
    autoPromptRootLost()
  } catch {
    /* 读取失败保持旧值 */
  }
  try {
    dir.deleteBatch = await window.services.sync.listDeleteBatch(dirArg)
  } catch {
    dir.deleteBatch = null
  }
}

export async function refreshAllPendingConflicts() {
  for (const d of state.dirs) await refreshPendingConflicts(d)
}

/** 全目录未处理（无 choice）挂起数（状态栏角标等展示）：逐条类（冲突 / 根丢失）
 *  按挂起记录计，删除确认按批量快照的未决策数计（undecided 是引擎真值 —— 逐文件
 *  记录有 500 条上限，超出部分只有快照知道；快照缺失时退回记录口径兜底） */
export const pendingConflictTotal = computed(() =>
  state.dirs.reduce((acc, d) => {
    const itemOpen = (d.pendingConflicts ?? []).filter((p) => !p.choice && p.kind !== 'delete').length
    const deleteOpen = d.deleteBatch ? d.deleteBatch.undecided : (d.pendingConflicts ?? []).filter((p) => !p.choice && p.kind === 'delete').length
    return acc + itemOpen + deleteOpen
  }, 0)
)

/**
 * 全局待处理中心的目录分组（仅含有未决策挂起的目录，根丢失排最前）：每目录按
 * 根丢失 / 删除确认 / 冲突三类计数，供聚合面板渲染与「去处理」直达。删除确认
 * 计数与角标同口径：优先批量快照的 undecided（真值，覆盖超上限部分）。
 */
export const pendingCenterGroups = computed(() => {
  const groups: Array<{ dir: SyncDir; rootLost: number; deleteConfirm: number; conflict: number }> = []
  for (const d of state.dirs) {
    let rootLost = 0
    let conflict = 0
    for (const p of d.pendingConflicts ?? []) {
      if (p.choice) continue
      if (p.kind === 'root-lost') rootLost++
      else if (p.kind !== 'delete') conflict++
    }
    const deleteConfirm = d.deleteBatch
      ? d.deleteBatch.undecided
      : (d.pendingConflicts ?? []).filter((p) => !p.choice && p.kind === 'delete').length
    if (rootLost + deleteConfirm + conflict > 0) groups.push({ dir: d, rootLost, deleteConfirm, conflict })
  }
  groups.sort((a, b) => (b.rootLost > 0 ? 1 : 0) - (a.rootLost > 0 ? 1 : 0))
  return groups
})

/** 打开全局待处理中心（状态栏入口）：先全量刷新各目录挂起列表保证数据新鲜 */
export async function openPendingCenter() {
  state.pendingCenterOpen = true
  await refreshAllPendingConflicts()
}

/**
 * 待处理中心「去处理」直达：根丢失目录级决策弹 RootLostModal（既有 rootLostPromptDirId
 * 通道），其余经 pendingPanelDirId 一次性通道让对应 DirRow 打开本地待处理面板。
 */
export function goPendingDir(d: SyncDir) {
  if ((d.pendingConflicts ?? []).some((p) => p.kind === 'root-lost' && !p.choice)) {
    state.rootLostPromptDirId = d.id
  } else {
    state.pendingPanelDirId = d.id
  }
  state.pendingCenterOpen = false
}

/**
 * 为一批冲突挂起记录落 choice（逐条或「对剩余都这样处理」）：local / remote / both。
 * （删除确认类不走这里 —— 目录树决策走 applyDeleteScope 的范围通道，覆盖逐文件
 * 记录装不下的部分。）落完刷新面板并触发一轮手动同步（下一轮按 choice 自动解决）；
 * 同步进行中不排队（下一轮自动消费选择），改为明确提示而不是静默吞掉。
 */
export async function applyPendingChoices(dir: SyncDir, rels: string[], choice: 'local' | 'remote' | 'both') {
  if (!window.services || state.demo || !rels.length) return
  const dirArg = { id: dir.id, localPath: dir.localPath, remotePath: dir.remotePath, mode: dir.mode }
  try {
    for (const rel of rels) await window.services.sync.setPendingChoice(dirArg, rel, choice)
  } catch (e) {
    toast.error('操作没有成功，请重试', e instanceof Error ? e.message : String(e))
  }
  await refreshPendingConflicts(dir)
  const remaining = (dir.pendingConflicts ?? []).filter((p) => !p.choice && p.kind !== 'delete' && p.kind !== 'root-lost').length
  toast.success('已记录处理方式', remaining > 0 ? `还有 ${remaining} 个待处理` : '下次同步时生效')
  if (dir.status === 'syncing') {
    toast.info('正在同步，本次选择将在下一轮生效')
    return
  }
  void syncDir(dir)
}

/**
 * 落一条删除范围决策（目录树节点或底部「全部」按钮）：引擎按前缀写入 scope 并
 * 同步回写既有逐文件记录，覆盖逐文件挂起表装不下的部分。落完刷新面板数据并触发
 * 一轮手动同步（下一轮按 scope 自动执行 / 抑制）；同步进行中改为明确提示。
 * @param rel 范围前缀：'' = 全部；目录 rel = 该目录及子树；文件 rel = 单文件
 */
export async function applyDeleteScope(dir: SyncDir, rel: string, choice: 'delete' | 'keep') {
  if (!window.services || state.demo) return
  const dirArg = { id: dir.id, localPath: dir.localPath, remotePath: dir.remotePath, mode: dir.mode }
  try {
    const res = await window.services.sync.setDeleteScope(dirArg, rel, choice)
    const scope = rel ? `「${rel}」` : ''
    toast.success(
      '已记录处理方式',
      res && res.covered > 0 ? `${scope}影响 ${res.covered} 个文件，下次同步时生效` : '下次同步时生效'
    )
  } catch (e) {
    toast.error('操作没有成功，请重试', e instanceof Error ? e.message : String(e))
    return
  }
  await refreshPendingConflicts(dir)
  if (dir.status === 'syncing') {
    toast.info('正在同步，本次选择将在下一轮生效')
    return
  }
  void syncDir(dir)
}

/** 「暂时忽略此冲突」：清除该挂起记录（该文件再冲突时才重新询问），不触发同步 */
export async function ignorePendingConflict(dir: SyncDir, rel: string) {
  if (!window.services || state.demo) return
  try {
    await window.services.sync.clearPendingConflict(
      { id: dir.id, localPath: dir.localPath, remotePath: dir.remotePath, mode: dir.mode },
      rel
    )
  } catch {
    /* 清除失败保留旧值 */
  }
  await refreshPendingConflicts(dir)
}

/**
 * 「云端文件夹丢失」决策（kind='root-lost' 挂起，rel='.'）：把用户的选择写入挂起
 * 记录并立即触发一轮同步 —— 下一轮根探测消费该选择：
 *   upload       —— 重建云端文件夹，电脑上的文件按根重建保护语义重新上传；
 *   remove-local —— 跟随云端删除，电脑上已同步的文件移入回收站（未同步过的新文件
 *                   保留并上传到重建的云端文件夹；本地有改动的文件同样保留）。
 * 选择前每轮同步以「云端文件夹已不存在，等待确认」收场，零删除零传输。
 */
export async function resolveRootLost(dir: SyncDir, choice: 'upload' | 'remove-local') {
  state.rootLostPromptDirId = null
  if (!window.services || state.demo) return
  const dirArg = { id: dir.id, localPath: dir.localPath, remotePath: dir.remotePath, mode: dir.mode }
  try {
    await window.services.sync.setPendingChoice(dirArg, '.', choice)
  } catch (e) {
    toast.error('操作没有成功，请重试', e instanceof Error ? e.message : String(e))
    return
  }
  await refreshPendingConflicts(dir)
  toast.success(
    '已记录处理方式',
    choice === 'upload' ? '正在重建云端文件夹并重新上传' : '正在移除电脑上已同步的文件'
  )
  void syncDir(dir)
}

