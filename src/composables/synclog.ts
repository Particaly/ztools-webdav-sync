import type { DecisionLogEntry, SyncDir, SyncLogEntry, SyncLogOp } from '../env.d'
import { decisionActionText, type DecisionHistoryRow } from './decisions'

/**
 * 同步记录的共享逻辑（记录拉取合并 + 全部文案渲染）：「同步记录」页单一数据源。
 * 记录分两类，按时间统一合并为一条时间线：
 *   ① 同步轮（sync-log.json）：每次引擎轮一条，含触发方式 / 起止时间 / 计数摘要 /
 *      逐文件操作明细 / 错误清单 —— 简略行与展开的详尽视图共用同一份数据；
 *   ② 用户决策（decision-log.json）：待处理挂起的每次选择 / 忽略 —— 决策是同步
 *      操作的一部分，与轮次记录同列表回看（复用决策历史的文案口径）。
 */

/** 时间线行 = 一条记录 + 所属目录名（目录可能随后被移除，名字在拉取时固化） */
export type SyncRecordRow =
  | ({ type: 'round' } & SyncLogEntry & { dirName: string })
  | ({ type: 'decision' } & DecisionHistoryRow)

/**
 * 拉取全部目录的同步记录与决策历史并按时间倒序合并成一条时间线
 *（best-effort：单目录失败不拖累整体）。浏览器预览（无 preload）与演示形态
 * 没有磁盘侧日志，返回空数组由调用方兜底。
 */
export async function loadSyncRecords(dirs: SyncDir[]): Promise<SyncRecordRow[]> {
  // 窄化结果存局部常量：函数守卫的收窄进不了下方异步回调，直取 window.services
  // 会重新摊开「可能缺席」
  const services = window.services
  if (!services) return []
  const rows: SyncRecordRow[] = []
  await Promise.all(
    dirs.map(async (d) => {
      const dirArg = { id: d.id, localPath: d.localPath, remotePath: d.remotePath, mode: d.mode }
      try {
        const rounds = (await services.sync.listSyncLog(dirArg)) as SyncLogEntry[]
        for (const r of rounds || []) rows.push({ ...r, type: 'round', dirName: d.name })
      } catch {
        /* 单目录同步记录读取失败跳过 */
      }
      try {
        const entries = (await services.sync.listDecisionLog(dirArg)) as DecisionLogEntry[]
        for (const e of entries || []) rows.push({ ...e, type: 'decision', dirName: d.name })
      } catch {
        /* 单目录决策历史读取失败跳过 */
      }
    })
  )
  rows.sort((a, b) => b.at - a.at)
  return rows
}

// ---------- 文案渲染（简略行 / 详尽视图共用口径） ----------

/** 触发方式文案（SyncLogEntry.trigger → 人话） */
export function triggerText(trigger: string): string {
  switch (trigger) {
    case 'manual':
      return '手动同步'
    case 'interval':
      return '定时自动同步'
    case 'watch':
      return '文件变化自动同步'
    case 'startup':
      return '插件启动同步'
    case 'backoff':
      return '失败后自动重试'
    case 'follow-up':
      return '自动跟进同步'
    case 'yield-retry':
      return '等待后自动重试'
    case 'dry-run':
      return '预演（未改动文件）'
    default:
      return '自动同步'
  }
}

/** 一次性单向操作的文案（手动「云端补齐 / 覆盖本地」等四个按钮） */
export function opText(op: string | undefined): string | null {
  switch (op) {
    case 'pull':
      return '云端补齐本地'
    case 'pull-full':
      return '云端覆盖本地'
    case 'push':
      return '本地补齐云端'
    case 'push-full':
      return '本地覆盖云端'
    default:
      return null
  }
}

/** 轮次结果文案 */
export function statusText(r: SyncLogEntry): string {
  switch (r.status) {
    case 'ok':
      return '同步完成'
    case 'partial':
      return '部分完成，有事项等你处理'
    case 'error':
      return '同步失败'
    case 'cancelled':
      return '已取消'
    case 'yielded':
      return '另一台设备正在同步，本次等待'
    default:
      return r.status
  }
}

/** 轮次结果的情绪色（行首状态点 / 文案着色用）：good 中性绿、warn 提示黄、bad 错误红、muted 灰 */
export function statusTone(r: SyncLogEntry): 'good' | 'warn' | 'bad' | 'muted' {
  if (r.status === 'error') return 'bad'
  if (r.status === 'partial') return 'warn'
  if (r.status === 'cancelled' || r.status === 'yielded') return 'muted'
  return 'good'
}

/** 简略行的改动摘要（零传输轮返回「没有文件需要同步」一类的过程描述） */
export function roundBrief(r: SyncLogEntry): { label: string; count: number }[] {
  const chips: { label: string; count: number }[] = []
  if (r.uploaded > 0) chips.push({ label: '上传', count: r.uploaded })
  if (r.downloaded > 0) chips.push({ label: '下载', count: r.downloaded })
  if (r.deleted > 0) chips.push({ label: '删除', count: r.deleted })
  if ((r.renamed ?? 0) > 0) chips.push({ label: '改名', count: r.renamed! })
  if (r.conflicts > 0) chips.push({ label: '冲突', count: r.conflicts })
  return chips
}

/** 单条操作明细的文案（详尽视图逐行；两侧口径与 op 字段注释一致） */
export function opLineText(o: SyncLogOp): string {
  if (o.op === 'upload') return `${o.added ? '新增' : '更新'}了云端文件`
  if (o.op === 'download') return `${o.added ? '新增' : '更新'}了电脑文件`
  if (o.op === 'delete-local') return '删除了电脑文件'
  if (o.op === 'delete-remote') return '删除了云端文件'
  if (o.op === 'rename-remote') return '在云端改名（内容未重传）'
  if (o.op === 'rename-local') return '在电脑上改名（内容未重新下载）'
  // 冲突条目：一句话写明选择与其落地动作 —— 本身即两侧改动的完整描述
  if (o.choice === 'local') return '冲突：保留电脑版本（已上传覆盖云端）'
  if (o.choice === 'remote') return '冲突：保留云端版本（已下载覆盖本地）'
  if (o.choice === 'both') return '冲突：两个都保留（云端版本另存为副本）'
  return '冲突处理'
}

/** 详尽视图的分组标题（云端 = 线上 / 本地 = 线下 / 冲突 / 提示 / 错误） */
export function groupOps(ops: SyncLogOp[]): { cloudUp: SyncLogOp[]; cloudDel: SyncLogOp[]; cloudRename: SyncLogOp[]; localDown: SyncLogOp[]; localDel: SyncLogOp[]; localRename: SyncLogOp[]; conflicts: SyncLogOp[] } {
  const g = { cloudUp: [] as SyncLogOp[], cloudDel: [] as SyncLogOp[], cloudRename: [] as SyncLogOp[], localDown: [] as SyncLogOp[], localDel: [] as SyncLogOp[], localRename: [] as SyncLogOp[], conflicts: [] as SyncLogOp[] }
  for (const o of ops) {
    if (o.op === 'upload') g.cloudUp.push(o)
    else if (o.op === 'delete-remote') g.cloudDel.push(o)
    else if (o.op === 'rename-remote') g.cloudRename.push(o)
    else if (o.op === 'download') g.localDown.push(o)
    else if (o.op === 'delete-local') g.localDel.push(o)
    else if (o.op === 'rename-local') g.localRename.push(o)
    else g.conflicts.push(o)
  }
  return g
}

/** 决策行的动作文案（与待处理中心「最近处理记录」同口径，复用决策历史渲染） */
export function decisionRowText(h: DecisionHistoryRow): string {
  return decisionActionText(h)
}

/** 绝对时刻（详尽视图的「开始时间」）：今天 / 昨天 / 更早 */
export function fmtAbsTime(ts: number): string {
  const d = new Date(ts)
  const p = (v: number) => String(v).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  const now = new Date()
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((dayStart(now) - dayStart(d)) / 86400000)
  if (days <= 0) return `今天 ${hm}`
  if (days === 1) return `昨天 ${hm}`
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`
}

/** 耗时（详尽视图：当次同步从开始到收尾的时长） */
export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return '不足 1 秒'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} 秒`
  return `${Math.floor(s / 60)} 分 ${s % 60} 秒`
}

/**
 * 演示场景（?demo=decisions）的同步记录样例：真实日志在磁盘侧（preload），
 * 浏览器预览读不到 —— 预览页面布局用的静态样例，覆盖成功 / 部分完成 / 失败 /
 * 冲突与决策等主要形态，与演示目录的挂起数据同构图。
 */
export function demoSyncRecords(): SyncRecordRow[] {
  const at = (minAgo: number) => Date.now() - minAgo * 60000
  // 大轮次样例：上百行明细，预览展开区的限高内滚与行级虚拟滚动
  const bulk: SyncLogOp[] = []
  for (let i = 0; i < 80; i++) bulk.push({ op: 'upload', rel: `Photos/2024/IMG_${String(1000 + i)}.jpg`, bytes: 1024 * (800 + i * 7), added: i < 20 })
  for (let i = 0; i < 40; i++) bulk.push({ op: 'download', rel: `Docs/合同/合同-${String(100 + i)}.pdf`, bytes: 1024 * 1024 + i * 917, added: i < 5 })
  const rows: SyncRecordRow[] = [
    {
      type: 'round',
      at: at(90),
      endAt: at(88),
      trigger: 'interval',
      status: 'ok',
      uploaded: 80,
      downloaded: 40,
      deleted: 0,
      conflicts: 0,
      adopted: 0,
      deferredConflicts: 0,
      deleteHeld: 0,
      bytesUp: 1024 * 1024 * 96,
      bytesDown: 1024 * 1024 * 41,
      totalFiles: 342,
      ops: bulk,
      errors: [],
      dirName: '项目文档',
    },
    {
      type: 'round',
      at: at(3),
      endAt: at(2),
      trigger: 'watch',
      status: 'ok',
      uploaded: 2,
      downloaded: 1,
      deleted: 0,
      conflicts: 0,
      adopted: 0,
      deferredConflicts: 0,
      deleteHeld: 0,
      bytesUp: 1024 * 380,
      bytesDown: 1024 * 64,
      totalFiles: 342,
      ops: [
        { op: 'upload', rel: 'Assets/Banners/hero-banner-v2.png', bytes: 1024 * 320, added: true },
        { op: 'upload', rel: 'Spec/接口约定.md', bytes: 1024 * 60 },
        { op: 'download', rel: 'Notes/会议记录.md', bytes: 1024 * 64 },
      ],
      errors: [],
      dirName: '项目文档',
    },
    {
      type: 'round',
      at: at(26),
      endAt: at(25),
      trigger: 'interval',
      status: 'partial',
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      adopted: 0,
      deferredConflicts: 2,
      deleteHeld: 86,
      bytesUp: 0,
      bytesDown: 0,
      totalFiles: 328,
      ops: [],
      errors: [],
      dirName: '项目文档',
    },
    {
      type: 'round',
      at: at(58),
      endAt: at(57),
      trigger: 'manual',
      status: 'ok',
      uploaded: 0,
      downloaded: 1,
      deleted: 0,
      conflicts: 1,
      adopted: 1,
      deferredConflicts: 0,
      deleteHeld: 0,
      bytesUp: 0,
      bytesDown: 1024 * 47,
      totalFiles: 204,
      ops: [
        { op: 'conflict', rel: 'Spec/接口约定.md', choice: 'local' },
        { op: 'upload', rel: 'Spec/接口约定.md', bytes: 4300 },
      ],
      errors: [],
      dirName: '设计资源库',
    },
    {
      type: 'round',
      at: at(60 * 5),
      endAt: at(60 * 5 - 40),
      trigger: 'backoff',
      status: 'error',
      error: '连不上服务器，请检查网络后重试',
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      adopted: 0,
      deferredConflicts: 0,
      deleteHeld: 0,
      bytesUp: 0,
      bytesDown: 0,
      totalFiles: 0,
      ops: [],
      errors: ['无法连接服务器（NETWORK）：连接超时'],
      dirName: '归档记录',
    },
    {
      type: 'round',
      at: at(60 * 5 - 120),
      endAt: at(60 * 5 - 119),
      trigger: 'watch',
      status: 'ok',
      uploaded: 1,
      downloaded: 0,
      deleted: 1,
      conflicts: 0,
      adopted: 0,
      deferredConflicts: 0,
      deleteHeld: 0,
      bytesUp: 1024 * 12,
      bytesDown: 0,
      totalFiles: 201,
      ops: [
        { op: 'upload', rel: 'Assets/新字体.zip', bytes: 1024 * 12, added: true },
        { op: 'delete-remote', rel: 'Assets/废弃Logo.ai' },
      ],
      errors: [],
      dirName: '设计资源库',
    },
    {
      type: 'decision',
      at: at(4),
      rel: '.',
      kind: 'delete',
      choice: 'keep',
      affected: 1200,
      dirName: '项目文档',
    },
    {
      type: 'decision',
      at: at(60 * 26),
      rel: '.',
      kind: 'root-lost',
      choice: 'upload',
      affected: 342,
      dirName: '归档记录',
    },
  ]
  return rows.sort((a, b) => b.at - a.at)
}
