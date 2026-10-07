import type { SyncDir } from '../env.d'
import { relBaseName } from './format'

/**
 * 同步进度的折算与文案（自 DirRow 迁出的纯函数）：把引擎上报的进度载荷
 *（SyncDir.progress）折算成整条进度条的百分比，并给出「正在…」当前任务文案。
 * 输入只读、无副作用，DirRow（目录行）与后续展示位共用同一口径。
 */

/** 目录进度载荷（SyncDir.progress 的非空形态，本模块折算与文案的输入） */
export type DirProgress = NonNullable<SyncDir['progress']>

/**
 * 把一轮同步的进度折算为整条进度条的百分比（前置 10% + 传输 80% + 后置 10%）：
 *   前置 10% —— 扫描起步 3%，规划 6%，verify 校验在 4–8% 间按完成数推进，锁 9%；
 *   传输 80% —— 10%–90%，按「已完成字节 / 计划上传+下载字节」推进（与文件数无关；
 *               字节分母为 0 的空轮直接落 90%）；
 *   后置 10% —— 收尾阶段定格 95%（批量校验提交 / 基线落盘 / 清理，轮末即达 100%）。
 * 旧事件无 stage 时按 phase 回落；传输段在字节分母缺失时退回按文件数折算。
 */
export function syncRoundPercent(p: DirProgress | null): number {
  if (!p) return 0
  const stage = p.stage
  if (stage === 'lockwait' || stage === 'lock') return 9
  if (stage === 'finalize') return 95
  if (stage === 'transfer' || (!stage && p.phase === 'transfer')) {
    if (p.bytesTotal > 0) return Math.min(90, Math.round(10 + (p.bytesDone / p.bytesTotal) * 80))
    if (!stage && p.filesTotal > 0) return Math.min(90, Math.round(10 + (p.filesDone / p.filesTotal) * 80))
    return 90
  }
  if (stage === 'verify' || (!stage && p.phase === 'plan')) {
    if (p.verifyTotal && p.verifyTotal > 0) return Math.round(4 + 4 * Math.min(1, (p.verifyDone ?? 0) / p.verifyTotal))
    return 6
  }
  // scan（本地扫描无既定总量）：低位起步值，随规划 / 锁 / 传输逐段推进
  return 3
}

/** 当前正在进行的任务文案（细分阶段 → 「正在…」；旧事件无 stage 时按 phase 回落） */
export function syncTaskText(p: DirProgress): string {
  // 旧事件形态兼容：无 stage 时按粗粒度 phase 映射（phase 与 stage 口径一致，
  // 绝不能把传输中的事件误标成「正在扫描」）
  if (!p.stage) {
    if (p.phase === 'plan') return '正在比对文件差异…'
    if (p.phase === 'transfer') return '正在同步文件…'
    return p.filesDone > 0 ? `正在扫描文件（已发现 ${p.filesDone} 个）…` : '正在扫描文件…'
  }
  switch (p.stage) {
    case 'lockwait':
      return '正在等待其他设备完成同步…'
    case 'lock':
      return '正在确认租约锁…'
    case 'verify':
      return p.verifyTotal && p.verifyTotal > 0 ? `正在校验文件内容（${p.verifyDone ?? 0}/${p.verifyTotal}）…` : '正在校验文件内容…'
    case 'finalize':
      return '正在完成收尾…'
    case 'plan':
      return '正在比对文件差异…'
    case 'transfer': {
      // currentFile 为引擎上报的文件 rel（正斜杠、无尾斜杠），末段名与
      // relBaseName（format.ts）完全同义 —— 与各弹窗展示位共用同一实现
      const name = p.currentFile ? relBaseName(p.currentFile) : ''
      if (p.currentOp === 'upload') return name ? `正在上传 ${name}` : '正在上传文件…'
      if (p.currentOp === 'download') return name ? `正在下载 ${name}` : '正在下载文件…'
      if (p.currentOp === 'delete-local' || p.currentOp === 'delete-remote') return name ? `正在删除 ${name}` : '正在删除文件…'
      if (p.currentOp === 'rename-remote' || p.currentOp === 'rename-local') return name ? `正在同步改名 ${name}` : '正在同步改名…'
      if (p.currentOp === 'conflict') return name ? `正在处理冲突 ${name}` : '正在处理冲突…'
      return '正在同步文件…'
    }
    default:
      // scan：附已发现文件数（无既定总量，不给百分比预期）
      return p.filesDone > 0 ? `正在扫描文件（已发现 ${p.filesDone} 个）…` : '正在扫描文件…'
  }
}
