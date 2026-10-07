import type { DecisionLogEntry, SyncDir } from '../env.d'

/**
 * 决策历史的共享逻辑（决策历史拉取 + 文案渲染）：全局待处理中心「最近处理记录」
 * 与同步记录页（用户决策行）共用，两处口径（排序 / 截断 / 动作文案）由本模块
 * 单点维护。同步轮记录的拉取与渲染见 synclog.ts（本模块只负责决策类记录）。
 */

/** 决策历史行 = 决策条目 + 所属目录名（目录可能随后被移除，名字在拉取时固化） */
export interface DecisionHistoryRow extends DecisionLogEntry {
  dirName: string
}

/** 历史列表展示上限（磁盘侧每目录环形 200 条，跨目录合并后展示层再截断） */
export const HISTORY_SHOWN = 50

/**
 * 拉取全部目录的决策历史并按时间倒序合并（best-effort：单目录失败不拖累整体）。
 * 浏览器预览（无 preload）与演示形态没有磁盘侧日志，返回空数组由调用方兜底。
 */
export async function loadDecisionHistory(dirs: SyncDir[]): Promise<DecisionHistoryRow[]> {
  // 窄化结果存局部常量：函数守卫的收窄进不了下方异步回调，直取 window.services
  // 会重新摊开「可能缺席」
  const services = window.services
  if (!services) return []
  const rows: DecisionHistoryRow[] = []
  await Promise.all(
    dirs.map(async (d) => {
      try {
        const entries = (await services.sync.listDecisionLog({
          id: d.id,
          localPath: d.localPath,
          remotePath: d.remotePath,
          mode: d.mode,
        })) as DecisionLogEntry[]
        for (const e of entries || []) rows.push({ ...e, dirName: d.name })
      } catch {
        /* 单目录读取失败跳过，历史列表不完整优于打不开 */
      }
    })
  )
  rows.sort((a, b) => b.at - a.at)
  return rows
}

/**
 * 决策条目的动作摘要文案（与各处理弹窗的选项文案同口径）：
 * 根丢失 / 删除确认 / 冲突 / 忽略四类，删除类体现范围（前缀）与影响面。
 */
export function decisionActionText(h: DecisionHistoryRow): string {
  if (h.kind === 'root-lost') {
    const n = h.affected && h.affected > 0 ? `（影响 ${h.affected} 个文件）` : ''
    return h.choice === 'remove-local' ? `删除电脑上的文件${n}` : `重新上传到云端${n}`
  }
  if (h.kind === 'delete') {
    // 删除确认：逐文件决策 rel 为文件路径；范围决策（目录树节点 /「全部」）rel 为
    // 前缀（'.' = 整目录），affected 携带覆盖文件数 —— 文案体现范围与影响面
    const n = h.affected && h.affected > 0 ? `（影响 ${h.affected} 个文件）` : ''
    const scope = h.rel && h.rel !== '.' ? `「${h.rel}」` : ''
    return `${scope}${h.choice === 'delete' ? '确认删除' : '选择不删除'}${n}`
  }
  if (h.kind === 'ignore') return '忽略了这条提醒（再次出现才会询问）'
  if (h.choice === 'local') return '冲突：保留电脑版本'
  if (h.choice === 'remote') return '冲突：保留云端版本'
  if (h.choice === 'both') return '冲突：两个都保留'
  return h.choice
}
