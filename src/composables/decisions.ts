import type { DecisionLogEntry, SyncDir } from '../env.d'

/**
 * 决策记录的共享逻辑（决策历史拉取 + 文案渲染）：全局待处理中心「最近处理记录」
 * 与决策记录页共用，两处口径（排序 / 截断 / 动作文案）由本模块单点维护。
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
  if (!window.services) return []
  const rows: DecisionHistoryRow[] = []
  await Promise.all(
    dirs.map(async (d) => {
      try {
        const entries = (await window.services.sync.listDecisionLog({
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

/**
 * 演示场景（?demo=decisions）的决策历史样例：真实日志在磁盘侧（preload），
 * 浏览器预览读不到 —— 预览页面布局用的静态样例，随演示目录的挂起数据同构图。
 */
export function demoDecisionRows(): DecisionHistoryRow[] {
  const at = (minAgo: number) => Date.now() - minAgo * 60000
  return [
    { at: at(4), rel: '.', kind: 'delete', choice: 'keep', affected: 1200, dirName: '项目文档' },
    { at: at(26), rel: 'Photos/2024/RAW', kind: 'delete', choice: 'keep', affected: 640, dirName: '项目文档' },
    { at: at(58), rel: 'Spec/接口约定.md', kind: 'conflict', choice: 'local', dirName: '设计资源库' },
    { at: at(60 * 5), rel: 'Assets/旧版海报.psd', kind: 'delete', choice: 'delete', dirName: '设计资源库' },
    { at: at(60 * 26), rel: '.', kind: 'root-lost', choice: 'upload', affected: 342, dirName: '归档记录' },
    { at: at(60 * 27), rel: 'Notes/会议记录.md', kind: 'ignore', choice: 'ignore', dirName: '归档记录' },
  ]
}
