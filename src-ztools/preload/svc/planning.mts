/* eslint-disable */
// svc/planning.mts —— 同步规划纯函数域：批量删除
// 快照聚合与 scope 覆盖计算、三方指纹契约（fpMatch / remoteChangedVs /
// computeLocalChanged）、决策真值表（decideAction）、基线条目构造（entryFrom）、
// 改名配对启发式（computeRenamePairs）、远端冲突保护类用户文案、Windows 文件名
// 预检、大小写冲突检测、目录重叠校验。除 hashFile / mkOpError / 存储键归一外
// 无副作用，是 sync._internals 纯函数直检的主体。
import path from 'node:path'
import * as storage from '../store.mts'
import type { BaselineEntry, DeleteBatch, DeleteBatchNode, DeleteScope, SyncMode } from '../types.mts'
import { REMOTE_FP_TOL_MS, maybeYield, nfc, type DirCfg } from './base.mts'
import { hashFile } from './localfs.mts'
import { mkOpError } from './net.mts'


/**
 * 批量删除确认阈值：单轮待删数量（delete-local + delete-remote 合计）超过
 * max(DELETE_BATCH_MIN, 基线条目数 × DELETE_BATCH_RATIO) 时，本轮整批挂起 ——
 * 经冲突挂起通道登记「待确认删除」记录（kind='delete'，无 choice），确认前零删除，
 * 用户逐条 / 批量确认后下一轮才执行。少量删除（正常编辑流）不受影响。
 */
export const DELETE_BATCH_MIN = 50
export const DELETE_BATCH_RATIO = 0.2

/**
 * 批量删除快照的节点上限：目录树聚合后（目录节点 + 文件叶）超过此数时，从最深的
 * 目录开始折叠（子节点收拢进父目录的聚合计数，父目录仍可整体决策），直到不超；
 * 全平树（没有目录层可折叠）最后按 rel 排序截断。UI 的树形展示与目录级决策只依赖
 * 目录结构，折叠 / 截断不影响「按目录决策」「全部决策」的完整性（total / bytes
 * 始终是全量真值）。
 */
const MAX_BATCH_NODES = 3000

/** 批量删除快照的聚合输入：rel → 本地文件大小（字节数，用于「影响多少数据」展示） */
type DeleteBatchMembers = Map<string, number>

/**
 * 把「全部未决策删除候选」（rel → 大小）聚合成批量删除快照的目录树：
 * 逐文件建 trie（目录节点 + 文件叶），后序聚合子树文件数与字节数；节点总数超
 * MAX_BATCH_NODES 时按深度从深到浅折叠目录（折叠 = 清空其子节点，聚合计数留在
 * 目录节点上，用户可对该目录整体决策），全平树折叠不动时按 rel 排序截断。
 * 纯函数：不触碰存储，输出形态见 types.mts 的 DeleteBatch / DeleteBatchNode。
 * @param members 未决策删除候选（nfc 归一 rel → 本地大小）
 * @param at 快照构建时刻（毫秒）
 */
export function buildDeleteBatch(members: DeleteBatchMembers, at: number): DeleteBatch {
  interface TrieNode {
    name: string
    children: Map<string, TrieNode>
    isDir: boolean
    files: number
    bytes: number
  }
  const newnode = (name: string, isDir: boolean): TrieNode => ({ name, children: new Map(), isDir, files: 0, bytes: 0 })
  const root = newnode('', true)
  for (const [rel, size] of members) {
    const segs = rel.split('/')
    let cur = root
    for (let i = 0; i < segs.length - 1; i++) {
      const seg = segs[i]
      let next = cur.children.get(seg)
      if (!next) {
        next = newnode(seg, true)
        cur.children.set(seg, next)
      }
      cur = next
    }
    const leafName = segs[segs.length - 1]
    let leaf = cur.children.get(leafName)
    if (!leaf) {
      leaf = newnode(leafName, false)
      cur.children.set(leafName, leaf)
    }
    leaf.files = 1
    leaf.bytes = Math.max(0, Number(size) || 0)
  }
  // 后序聚合：目录节点的 files / bytes = 直接文件叶 + 子目录聚合
  let totalFiles = 0
  let totalBytes = 0
  const dirsByDepth: Array<{ node: TrieNode; rel: string; depth: number }> = []
  const agg = (node: TrieNode, rel: string, depth: number): void => {
    let files = 0
    let bytes = 0
    for (const child of node.children.values()) {
      const childRel = rel ? `${rel}/${child.name}` : child.name
      if (child.isDir) {
        agg(child, childRel, depth + 1)
        dirsByDepth.push({ node: child, rel: childRel, depth: depth + 1 })
        files += child.files
        bytes += child.bytes
      } else {
        files += 1
        bytes += child.bytes
      }
    }
    node.files = files
    node.bytes = bytes
    if (node.isDir && node.children.size === 0) {
      // 空目录占位（理论上不会出现 —— 目录节点只随文件叶创建），防御性归零
      node.files = 0
      node.bytes = 0
    }
  }
  agg(root, '', 0)
  for (const child of root.children.values()) {
    if (child.isDir) totalFiles += child.files
    else totalFiles += 1
    totalBytes += child.bytes
  }
  // 折叠：从最深的目录开始，把子节点收拢进目录节点（目录本身保留，仍可整体决策）
  dirsByDepth.sort((a, b) => b.depth - a.depth)
  const countNodes = (node: TrieNode): number => {
    let n = 1
    for (const c of node.children.values()) n += countNodes(c)
    return n
  }
  let nodeCount = countNodes(root) - 1 // 根（同步目录本身）不是快照节点
  for (const { node } of dirsByDepth) {
    if (nodeCount <= MAX_BATCH_NODES) break
    if (node.children.size === 0) continue
    nodeCount -= countNodes(node) - 1
    node.children.clear()
  }
  // 摊平输出（深度优先，目录在前）；仍超上限（全平树无目录可折叠）按 rel 排序截断
  const nodes: DeleteBatchNode[] = []
  const emit = (node: TrieNode, rel: string): void => {
    const childRels: Array<[TrieNode, string]> = []
    for (const child of node.children.values()) {
      const childRel = rel ? `${rel}/${child.name}` : child.name
      childRels.push([child, childRel])
    }
    childRels.sort((a, b) => (a[0].isDir === b[0].isDir ? a[1].localeCompare(b[1]) : a[0].isDir ? -1 : 1))
    for (const [child, childRel] of childRels) {
      nodes.push({ rel: childRel, isDir: child.isDir, files: child.isDir ? child.files : 1, bytes: child.bytes })
      if (child.isDir) emit(child, childRel)
    }
  }
  emit(root, '')
  if (nodes.length > MAX_BATCH_NODES) nodes.length = MAX_BATCH_NODES
  return { at, total: totalFiles, bytes: totalBytes, nodes }
}

/**
 * 计算「快照中未被任何 scope 覆盖的文件数」（listDeleteBatch 的 undecided 字段）：
 * 从树顶往下走，节点命中任一 scope（本节点或祖先在 scope 前缀之下）即整块计入
 * 已覆盖、不再下钻 —— scope 覆盖天然含其子树；多 scope 重叠经「先命中先吸收」
 * 天然去重。快照因截断没逐个列出的文件按其所在目录节点的聚合口径参与计算。
 * 纯函数；scopes 为空时未决策数 = total。
 * @param batch 批量删除快照
 * @param scopes 当前生效的删除范围决策
 */
export function computeUndecidedFiles(batch: DeleteBatch, scopes: DeleteScope[]): number {
  if (!scopes.length) return batch.total
  const hit = (rel: string): boolean =>
    scopes.some((s) => s.prefix === '' || s.prefix === rel || rel.startsWith(s.prefix + '/'))
  // 直接子层索引：父 rel → 直接子节点数组（根层以 '' 为键）。一趟 O(n) 建立：
  // 快照节点是摊平的树（buildDeleteBatch 深度优先输出），每个节点的父 rel 即自身
  // rel 去掉最后一段；索引不变量 —— 覆盖全部「有子节点」的 rel，走树只沿索引下钻，
  // 遍历的节点集合与顺序和朴素线性扫全量 nodes 找直接子层（O(n²)，MAX_BATCH_NODES
  // =3000 上限下最坏 ~900 万次前缀比较）完全一致。
  const childrenOf = new Map<string, DeleteBatchNode[]>()
  for (const node of batch.nodes) {
    const segs = node.rel.split('/')
    const parentRel = segs.length === 1 ? '' : segs.slice(0, -1).join('/')
    const arr = childrenOf.get(parentRel)
    if (arr) arr.push(node)
    else childrenOf.set(parentRel, [node])
  }
  // 根层逐个扫描顶层节点（根本身不可决策，空前缀 scope 在下探前先判）
  let covered = 0
  const walk = (node: DeleteBatchNode): void => {
    if (hit(node.rel)) {
      covered += node.files
      return
    }
    // 子节点关系由索引直接给出
    for (const child of childrenOf.get(node.rel) ?? []) walk(child)
  }
  for (const n of childrenOf.get('') ?? []) walk(n)
  return Math.max(0, batch.total - covered)
}

/**
 * rel 是否落在删除范围决策的前缀之内（与 DirStateStore.matchDeleteScope 同一
 * 匹配规则：rel === prefix、rel 在 prefix 目录之下、或 prefix 为空 = 全部）。
 * 独立纯函数：setDeleteScope 无快照时按逐文件记录计算覆盖数复用。
 */
export function scopeHitsRel(prefix: string, rel: string): boolean {
  return prefix === '' || prefix === rel || rel.startsWith(prefix + '/')
}

/**
 * 远端根丢失决策挂起的 rel 键（'.' 不可能是文件相对路径，与逐文件挂起天然无碰撞）：
 * 远端同步根 404 且本地基线非空时，整目录级决策（重新上传 / 移除本地）登记为
 * kind='root-lost' 的挂起记录，选择经 setPendingChoice 落地、下一轮根探测消费。
 */
export const ROOT_LOST_PENDING_REL = '.'

// ---------- 指纹契约 ----------
//
// 指纹 = { size, mtimeMs }（本地 stat / 远端 PROPFIND）+ 可选内容 hash（sha256，仅模糊时计算）。
// 基线条目（store.js）：{ origName?, lsize, lmtimeMs, lhash?, rsize, rmtimeMs, retag?, conflictCopy? }
//   - lhash 为上次实际传输内容的 sha256（上传 / 下载流式边传边算，不额外读盘）；
//     adopt（无传输收敛）时可能为空 —— 后续同 size 不同 mtime 将按「已变化」处理一次。
// 比较口径（全链路仅此一组函数，扫描 / 决策 / 恢复复用）：
//   - 本地侧：size 严格相等 + mtime 差 ≤ localFpTolMs（FAT/exFAT 2000ms，其余 1000ms）；
//     size 相同而 mtime 超容差 → 用 lhash 消歧（相同 = 未变并静默刷新基线 mtime）。
//   - 远端侧：size 严格 + etag 严格 + rmtime 容差 2000ms（etag 优先；无 etag 服务器退化为
//     size+mtime，配合内容消歧兜底）。etag 一律取自 PROPFIND（与扫描口径一致）。
// 已知边界：
//   1. 无 lhash / 未开启深度校验时，「等长且 mtime 不变或落在容差内」的本地修改 → 漏检；
//   2. 远端侧「等长且 etag / mtime 均不变」的修改无法检测（任何方案均无解，除非全量下载比对）；
//   3. 深度校验只覆盖本地侧。

/** 兼容旧签名：比较两个 {size, mtimeMs}（仅供 _internals 测试直检保留） */
export function fpMatch(a: any, b: any, tolMs = 1000): boolean {
  if (!a || !b) return false
  return a.size === b.size && Math.abs((a.mtimeMs || 0) - (b.mtimeMs || 0)) <= tolMs
}

/** 本地扫描指纹 vs 基线条目（lsize/lmtimeMs）的 size+mtime 判定 */
export function localFpMatch(l: any, m: any, tolMs: number): boolean {
  if (!l || !m) return false
  return l.size === m.lsize && Math.abs((l.mtimeMs || 0) - (m.lmtimeMs || 0)) <= tolMs
}

/** 远端扫描指纹 vs 基线条目：etag 优先，size 严格，rmtime 容差 */
export function remoteChangedVs(r: any, m: any): boolean {
  if (!m) return true
  if (m.rsize !== r.size) return true
  if ((m.retag || '') !== (r.etag || '')) return true
  if (m.rmtimeMs > 0 && r.mtimeMs > 0 && Math.abs(m.rmtimeMs - r.mtimeMs) > REMOTE_FP_TOL_MS) return true
  return false
}

/**
 * 本地变化判定（含 hash 消歧）。
 * l: 本地扫描 {abs, size, mtimeMs}；m: 基线条目；tolMs: 自适应容差。
 * forceHash = 深度校验开启且到期：对 mtime 未变的文件也重算 hash 与基线 lhash 比对。
 * preHash = 规划期哈希预取池提前算好的同一文件内容哈希（见 runSyncRound 规划第一遍
 *   前的预取池）：传入即免二次读盘。它必须满足「真正需要 hash 的判据」（等长 +
 *   mtime 模糊或深度校验到期 + 基线有 lhash）—— 预取池按同一判据筛条目，二者
 *   由注释互锁，改动任一侧须同步另一侧。缺省（undefined）时现场 hashFile
 *   （读盘失败照旧抛错让整轮失败，绝不静默当作已变 / 未变）。
 * 返回 { changed, hash? }。
 */
export async function computeLocalChanged(l: any, m: any, tolMs: number, forceHash = false, preHash?: string): Promise<any> {
  if (l.size !== m.lsize) return { changed: true }
  const mtimeNear = Math.abs((l.mtimeMs || 0) - (m.lmtimeMs || 0)) <= tolMs
  const needHash = forceHash || !mtimeNear
  if (!needHash) return { changed: false }
  if (m.lhash == null) return { changed: !mtimeNear } // 基线无历史 hash：深度校验无从比较，视为未变
  const hash = preHash !== undefined ? preHash : await hashFile(l.abs)
  return { changed: hash !== m.lhash, hash }
}

/**
 * 依据本端(l)/对端(r)/基线(m)三方状态生成单个文件的动作决策（纯函数）。
 *
 * flags（由规划层经 hash 消歧后注入的事实；未提供时按 size+mtime 容差自行推导）：
 *   lChanged / rChanged —— 本地 / 远端相对基线是否已变化
 *   newBoth             —— 无基线且两侧都在时的比对结论：'adopt'（已收敛，规划层已写基线）| 'conflict'
 *   oneshot             —— 一次单向操作（「补齐」× 双向 / 「覆盖」× 双向四档）：
 *                          'pull' / 'pull-full'（只下载）/ 'push' / 'push-full'
 *                         （只上传），未提供 = 常规轮
 *
 * 有基线真值表（沿用既有语义，三种模式不变；lCh/rCh 为注入或推导的 lChanged/rChanged）：
 * ┌──────┬──────┬────┬─────┬─────┬───────────────┬───────────────┬───────────────┐
 * │ local│remote│ m  │ lCh │ rCh │ two-way       │ upload        │ download      │
 * ├──────┼──────┼────┼─────┼─────┼───────────────┼───────────────┼───────────────┤
 * │  ✗   │  ✗   │ ✗  │  —  │  —  │ skip          │ skip          │ skip          │
 * │  ✗   │  ✗   │ ✓  │  —  │  —  │ clean         │ clean         │ clean         │
 * │  ✓   │  ✗   │ ✗  │  —  │  —  │ upload        │ upload        │ upload        │
 * │  ✓   │  ✗   │ ✓  │  ✗  │  —  │ delete-local  │ upload        │ delete-local  │
 * │  ✓   │  ✗   │ ✓  │  ✓  │  —  │ upload        │ upload        │ upload        │
 * │  ✗   │  ✓   │ ✗  │  —  │  —  │ download      │ download      │ download      │
 * │  ✗   │  ✓   │ ✓  │  —  │  ✗  │ delete-remote │ delete-remote │ download      │
 * │  ✗   │  ✓   │ ✓  │  —  │  ✓  │ download      │ download      │ download      │
 * │  ✓   │  ✓   │ ✗  │  —  │  —  │ newBoth 决定   │ newBoth 决定   │ newBoth 决定   │
 * │  ✓   │  ✓   │ ✓  │  ✗  │  ✗  │ keep          │ keep          │ keep          │
 * │  ✓   │  ✓   │ ✓  │  ✓  │  ✗  │ upload        │ upload        │ conflict      │
 * │  ✓   │  ✓   │ ✓  │  ✗  │  ✓  │ download      │ conflict      │ download      │
 * │  ✓   │  ✓   │ ✓  │  ✓  │  ✓  │ conflict      │ conflict      │ conflict      │
 * └──────┴──────┴────┴─────┴─────┴───────────────┴───────────────┴───────────────┘
 *
 * 无基线分支（新设备 / 新文件 / 基线损坏后的保护语义）：
 *   仅一侧存在 → 视为新增（upload / download），任何模式下都不产生 delete-*；
 *   两侧都在   → 规划层先按 size/mtime/hash 收敛：可收敛 → newBoth='adopt'（此处返回 keep），
 *                否则 conflict 交由用户决策。
 *
 * 单向模式语义（保持不变）：
 *   - upload 模式忽略「远端被删除」（本地未变时重新上传恢复远端），本地删除仍传播 delete-remote；
 *   - download 模式忽略「本地被删除」（远端未变时重新下载恢复本地），远端删除仍传播 delete-local；
 *   - 冲突解决是显式的「双向收敛」动作：任意模式选 local 都 PUT、选 remote 都覆盖本地；
 *   - 冲突副本（*.conflict.*）本地未修改时永远 keep，不做删除传播。
 *
 * 一次性单向操作语义（oneshot='pull' | 'push' 补齐档 / 'pull-full' | 'push-full'
 * 覆盖档；凌驾于 dir.mode 之上）：
 *   - 补齐档：把对端的内容带过来 —— 对端新增 / 有变化的文件沿方向传输，本端缺失
 *     的文件恢复（pull 重新下载 / push 重新上传）；本端多出的文件保留（绝不删除），
 *     本端改过的内容不覆盖（pull 对本端改动 keep，push 对对端改动 keep）；双侧都
 *     改 → 冲突流程（用户裁决，解决动作是显式「双向收敛」，不受方向限制）；
 *   - 覆盖档（镜像）：以选定侧为准，把本端完全恢复成对端的样子 —— 本端缺失的
 *     恢复、内容不一致的以对侧覆盖（不做询问）、本端多出的删除（delete-local /
 *     delete-remote，与常规删除同走删除安全闸：批量超阈值挂起等确认）；跨方向
 *     差异（pull 的本端改动 / push 的对端改动）同样被覆盖；
 *   - 无基线保护两档一致：仅一侧存在视为新增（沿方向传输），绝不产生 delete-*；
 *     两侧都在且内容可收敛 → adopt；不可收敛时补齐档 conflict、覆盖档按镜像覆盖；
 *   - 守卫不受档位影响：覆盖 / 删除前的 If-Match / 复查 / 下载守卫全部以扫描期
 *     状态为基准，与本轮决策无关的「扫描后突变」照常拦截（落回冲突 / 重试）。
 */
export function decideAction(rel: string, l: any, r: any, m: any, mode: SyncMode, flags: any = {}): any {
  // 一次性单向：方向（pull = 只下载 / push = 只上传）与档位（full = 覆盖档，以
  // 选定侧为准镜像对侧）；未知值按常规轮处理
  const oneshot = flags.oneshot === 'pull' || flags.oneshot === 'pull-full' ? 'pull' : flags.oneshot === 'push' || flags.oneshot === 'push-full' ? 'push' : null
  const oneshotFull = flags.oneshot === 'pull-full' || flags.oneshot === 'push-full'
  const lExists = !!l
  const rExists = !!(r && !r.isDir)
  const deriveL = () => lExists && (flags.lChanged !== undefined ? !!flags.lChanged : !localFpMatch(l, m, 2000))
  // 冲突副本只存在于本地：未被修改就始终保留，不做删除传播
  if (m && m.conflictCopy && lExists && !rExists) {
    if (!deriveL()) return { act: 'keep' }
  }
  if (!m) {
    if (!lExists && !rExists) return { act: 'skip' }
    // 无基线差异按方向收敛（覆盖档同样不产生删除 —— 无基线保护的底线）：
    // pull 不上传本地独有新文件，push 不下载远端独有新文件
    if (lExists && !rExists) return oneshot === 'pull' ? { act: 'keep' } : { act: 'upload' }
    if (!lExists && rExists) return oneshot === 'push' ? { act: 'keep' } : { act: 'download' }
    // 两侧都在：内容可收敛 → adopt（规划层已写基线）；补齐档交冲突流程裁决，
    // 覆盖档按镜像语义直接以选定侧覆盖对侧（不询问）
    if (flags.newBoth === 'adopt') return { act: 'keep', adopted: true }
    if (oneshotFull) return oneshot === 'pull' ? { act: 'download' } : { act: 'upload' }
    return { act: 'conflict' }
  }
  const lChanged = deriveL()
  const rChanged = rExists && (flags.rChanged !== undefined ? !!flags.rChanged : remoteChangedVs(r, m))
  if (!lExists && !rExists) return { act: 'clean' }
  if (lExists && !rExists) {
    // 一次性单向：pull 增量 keep（绝不删本地）、pull 全量 delete-local（以云端为
    // 准，与常规删除同走删除安全闸）；push 两档都 upload 恢复远端缺失的文件。
    // 常规轮沿用既有语义：本地未变按删除传播（upload 模式改判恢复上传），变过按上传
    if (oneshot === 'pull') return oneshotFull ? { act: 'delete-local' } : { act: 'keep' }
    if (oneshot === 'push') return { act: 'upload' }
    if (!lChanged) {
      if (mode === 'upload') return { act: 'upload' }
      return { act: 'delete-local' }
    }
    return { act: 'upload' }
  }
  if (!lExists && rExists) {
    // 一次性单向：push 增量 keep（绝不删远端）、push 全量 delete-remote（以本地
    // 为准，同走删除安全闸）；pull 两档都 download 恢复本地（「本地没有的从云端
    // 恢复」）。常规轮沿用既有语义：远端未变按删除传播（download 模式改判恢复
    // 下载），变过按下载
    if (oneshot === 'push') return oneshotFull ? { act: 'delete-remote' } : { act: 'keep' }
    if (oneshot === 'pull') return { act: 'download' }
    if (!rChanged) {
      if (mode === 'download') return { act: 'download' }
      return { act: 'delete-remote' }
    }
    return { act: 'download' }
  }
  if (!lChanged && !rChanged) return { act: 'keep' }
  if (lChanged && !rChanged) {
    // 本端改过：pull 增量 keep（不覆盖本地改动）、pull 全量 download（以云端为准
    // 覆盖）；push 两档都 upload
    if (oneshot === 'pull') return oneshotFull ? { act: 'download' } : { act: 'keep' }
    return { act: mode === 'download' ? 'conflict' : 'upload' }
  }
  if (!lChanged && rChanged) {
    // 对端改过：push 增量 keep（不覆盖云端改动）、push 全量 upload（以本地为准
    // 覆盖）；pull 两档都 download
    if (oneshot === 'push') return oneshotFull ? { act: 'upload' } : { act: 'keep' }
    return { act: mode === 'upload' ? 'conflict' : 'download' }
  }
  // 双侧都改：补齐档走冲突流程（用户裁决，不受方向限制）；覆盖档直接以选定侧
  // 为准覆盖对侧（镜像语义不做询问）
  if (oneshotFull) return oneshot === 'pull' ? { act: 'download' } : { act: 'upload' }
  return { act: 'conflict' }
}

/** 构造基线条目。extra: { origName?, conflictCopy? } */
export function entryFrom(l: any, r: any, lhash: string | null, extra: { origName?: string; conflictCopy?: boolean } = {}): BaselineEntry {
  const entry: BaselineEntry = {
    lsize: l ? l.size : 0,
    lmtimeMs: l ? l.mtimeMs : 0,
    rsize: r ? r.size : 0,
    rmtimeMs: r ? r.mtimeMs : 0,
    retag: r ? r.etag || '' : '',
  }
  if (lhash != null) entry.lhash = lhash
  if (extra.origName) entry.origName = extra.origName
  if (extra.conflictCopy) entry.conflictCopy = true
  return entry
}

// ---------- 改名检测（旧路径消失 + 新路径出现 + 内容指纹一致 ⇒ 判定改名） ----------
//
// 动机：本地把一个多 GB 的文件改名，旧语义 = delete-remote（删云端旧名）+ upload
//（全量重传新名）—— 改个名的代价是整个重新上传。基线已持有内容哈希（lhash），
// 「旧路径消失 + 新路径出现 + 哈希与尺寸一致」可高置信判定改名：
//   本地改名（two-way / upload 模式）→ 云端发 MOVE 改名，零重传；
//   远端改名（two-way / download 模式，对端设备已 MOVE）→ 本地同名跟随，零下载。
//
// 正确性论证（为何配对总是内容安全）：配对要求新旧内容指纹一致，因此无论「真改名」
// 还是「删旧建新（同内容）」，MOVE 后的云端终态与删传语义的终态完全相同 —— 启发式
// 错判的代价只是元数据差异（mtime 保留 vs 服务端当前时间），不会丢内容。反向风险
//（不同内容被误判为相同）由 lhash 强校验挡住（本地侧）与 etag/mtime 等价比对挡住
//（远端侧 —— 与引擎判定「远端未变」的既有口径相同）。
//
// 回落语义（任一条件不满足即不配对，走既有删传）：
//   基线不可信（loadedOk=false）/ 一次性单向轮 / 根重建或移除执行窗口 /
//   冲突副本基线 / 大小写冲突文件 / 该 rel 有挂起决策或删除范围决策或开放 WAL 意图 /
//   该 rel 处于失败退避期 / 基线无 lhash（本地侧无从强校验）/ 服务器不支持 MOVE
//  （caps.moveSupported === false，仅本地改名方向需要）/ download 模式不传播本地
//   改名、upload 模式不跟随远端改名（与删除传播的模式语义一致）。
// MOVE 执行失败（405/501）时持久降级 moveSupported=false，下一轮自然回落删传。

/** 改名配对结果：dir='local'（本地改名 → 云端 MOVE）| 'remote'（远端改名 → 本地改名跟随） */
export interface RenamePair {
  oldRel: string
  newRel: string
  dir: 'local' | 'remote'
  /** 旧路径的基线条目（配对的指纹依据；新基线由它改造而来） */
  m: BaselineEntry
}

/**
 * 规划期改名配对（本地改名与远端改名两个方向独立进行）。
 * 输入为规划第一遍之后的 plan 条目（it.flags 已含 lChanged / rChanged）。
 * 多对多同内容时按 rel 排序贪心一对一匹配（终态与匹配方案无关，见上方正确性论证）。
 * @param opts.plan 规划条目数组（元素 { rel, l, r, m, flags }）
 * @param opts.store 目录存储（get / getPending / matchDeleteScope / getFailure / pendingIntents / meta / loadedOk）
 * @param opts.caseSkip 大小写冲突跳过集合
 * @param opts.mode 同步模式
 * @param opts.oneshot 本轮是否一次性单向操作（true = 不配对）
 * @param opts.moveSupported caps.moveSupported !== false（本地改名方向用）
 * @param opts.forceUploads 半截强制重传集合（命中的 rel 不配对）
 * @param opts.localTol 本地 mtime 容差（未用，保留签名稳定性）
 */
export async function computeRenamePairs(opts: {
  plan: any[]
  store: any
  caseSkip: Set<string>
  mode: SyncMode
  oneshot: boolean
  moveSupported: boolean
  forceUploads: Set<string>
  localTol: number
}): Promise<RenamePair[]> {
  const { plan, store, caseSkip, mode, forceUploads } = opts
  if (!store || !store.loadedOk || opts.oneshot) return []
  if (store.meta && (store.meta.rootRebuilt || store.meta.rootLostRemoval)) return []
  const moveSupported = opts.moveSupported !== false
  /** 任一「旧 / 新路径不适格」的判定：挂起决策、删除范围决策、失败退避、开放意图、强制重传、大小写冲突 */
  const ineligible = (rel: string): boolean => {
    if (caseSkip.has(rel) || forceUploads.has(rel)) return true
    const pd = store.getPending(rel)
    if (pd && (pd.kind === 'delete' || pd.kind === 'root-lost')) return true
    if (pd && pd.choice) return true // 已决策未落地的冲突：交既有流程，不抢跑
    if (typeof store.matchDeleteScope === 'function' && store.matchDeleteScope(rel)) return true
    const fr = typeof store.getFailure === 'function' ? store.getFailure(rel) : null
    if (fr && fr.retryAtMs > Date.now()) return true
    for (const p of store.pendingIntents.values()) {
      if (nfc(p.rel || '') === nfc(rel)) return true
    }
    return false
  }
  const localOld: any[] = [] // 本地改名：旧路径（本地消失、远端未变）
  const localNew: any[] = [] // 本地改名：新路径（本地新文件、远端没有）
  const remoteOld: any[] = [] // 远端改名：旧路径（远端消失、本地未变）
  const remoteNew: any[] = [] // 远端改名：新路径（远端新文件、本地没有）
  for (const it of plan) {
    if (!it || ineligible(it.rel)) continue
    const { l, r, m } = it
    const flags = it.flags || {}
    if (m) {
      if (m.conflictCopy) continue
      // 本地改名（two-way / upload 模式）：本地消失 + 远端仍在基线状态（rChanged=false）
      if (mode !== 'download' && !l && r && !r.isDir && flags.rChanged === false) localOld.push(it)
      // 远端改名（two-way / download 模式）：远端消失 + 本地仍在基线状态（lChanged=false）
      if (mode !== 'upload' && l && !r && flags.lChanged === false) remoteOld.push(it)
    } else {
      // 新路径候选（无基线）：恰好一侧存在才有配对资格 —— localNew = 本地新文件
      //（远端没有，否则是 newBoth 收敛 / 冲突语义），remoteNew 对称
      if (!l) {
        if (mode !== 'upload' && r && !r.isDir) remoteNew.push(it)
      } else if (!r) {
        if (mode !== 'download') localNew.push(it)
      }
    }
  }
  const pairs: RenamePair[] = []
  // ---- 方向一：本地改名 → 云端 MOVE（要求基线 lhash 强校验 + 服务器支持 MOVE）----
  if (moveSupported && localOld.length && localNew.length) {
    /** 旧路径候选按基线尺寸分桶（旧路径本地已消失，尺寸以基线 lsize 为准；桶内再按 lhash 匹配） */
    const bySize = new Map<number, any[]>()
    for (const it of localOld) {
      if (it.m.lhash == null) continue // 基线无 lhash：无法强校验内容，不配对（回落删传）
      const size = it.m.lsize
      if (!bySize.has(size)) bySize.set(size, [])
      bySize.get(size)!.push(it)
    }
    const hashOf = new Map<string, string | null>() // 新路径 rel → 计算出的 sha256（失败 null）
    for (const nit of localNew) {
      const candidates = bySize.get(nit.l.size)
      if (!candidates || !candidates.length) continue
      let hash = hashOf.get(nit.rel)
      if (!hashOf.has(nit.rel)) {
        hash = await hashFile(nit.l.abs).catch(() => null)
        hashOf.set(nit.rel, hash)
        await maybeYield() // 大文件哈希是全量读盘循环，分片让出（与既有规划循环同规格）
      }
      if (hash == null) continue
      const idx = candidates.findIndex((oit: any) => oit.m.lhash === hash)
      if (idx < 0) continue
      const oit = candidates.splice(idx, 1)[0]
      pairs.push({ oldRel: oit.rel, newRel: nit.rel, dir: 'local', m: oit.m })
    }
  }
  // ---- 方向二：远端改名 → 本地跟随（等价于「新远端条目相对旧基线未变」的指纹比对）----
  if (remoteOld.length && remoteNew.length) {
    for (const nit of remoteNew) {
      const idx = remoteOld.findIndex((oit: any) => oit.m.rsize === nit.r.size && !remoteChangedVs(nit.r, oit.m))
      if (idx < 0) continue
      const oit = remoteOld.splice(idx, 1)[0]
      pairs.push({ oldRel: oit.rel, newRel: nit.rel, dir: 'remote', m: oit.m })
    }
  }
  return pairs
}

// ---------- 远端冲突保护类用户文案（throw / pushError 两用的单一出口） ----------

/**
 * 「云端的文件刚被其他设备修改」类文案：动词按场景参数化（上传 / 覆盖 / 删除复查
 * =「暂未上传」，MOVE 改名 =「暂未改名」），后缀「，为避免覆盖」仅覆盖类场景携带
 *（改名路径的 412 不涉及覆盖语义）。各处文案与既有版本逐字一致，收敛为模板防漂移。
 */
export const remoteChangedMsg = (rel: string, verb: '暂未上传' | '暂未改名', avoidOverwrite: boolean): string =>
  `「${rel}」${verb}：云端的文件刚被其他设备修改${avoidOverwrite ? '，为避免覆盖' : ''}，下次同步会重新判断`

/** 「无法确认云端文件的最新状态」类文案：无法确认「云端没变 / 没有同名」时按已变处理（绝不盲写）的统一提示 */
export const remoteUnverifiableMsg = (rel: string): string => `「${rel}」暂未处理：无法确认云端文件的最新状态，下次同步重试`

/** 「上传后核对失败」类文案：批量校验失败不写基线，下一轮重试自然收敛的统一提示 */
export const uploadVerifyFailedMsg = (rel: string): string => `「${rel}」上传后核对失败，下次同步会重试`

// ---------- Windows 文件名 / 路径预检（跨平台统一执行） ----------
//
// 动机：插件明确支持 Windows + macOS 互通。macOS 允许的文件名（含 :、"、?、*
// 或以空格 / 点结尾）在 Windows 上要么无法创建、要么被系统改写；含保留名
// （CON / NUL / COM1…）的文件在 Windows 上任何 API 都打不开。本机是 macOS 时
// 照样预检 —— 文件一旦上传，另一台 Windows 设备下载即失败（或更糟：本地明明
// 两个文件、对端只能落一个）。预检在上传前置检查里抛 BAD_FILENAME（permanent
// 分类 → 记入失败退避表，不再每轮重试撞墙，重命名后自然恢复）。
//
// 已知边界：
//   - 路径过长按「本机绝对路径 + rel ≤ 259（MAX_PATH 含 NUL）」判定 —— 对端
//     Windows 机器的根路径长度不同，非 win32 平台退化为 rel ≤ 240 的保守近似；
//   - Windows 10 1607+ 可经系统策略启用长路径，本预检不做探测、一律按经典限制。

/** Windows 保留设备名（含扩展名的形态也保留：CON.txt 同样非法；base 名比较） */
const WIN_RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'])
/** Windows 文件名非法字符（斜杠是路径分隔符不会出现在段内，其余按段校验） */
const WIN_ILLEGAL_RE = /[<>:"\\|?*\u0000-\u001f]/
/** 非内置长路径时，rel 段本身的保守长度上限（任何 Windows 目标根都几乎必挂） */
const WIN_REL_LEN_LIMIT = 240
/** MAX_PATH：260 含结尾 NUL */
const WIN_MAX_PATH = 260

/**
 * 校验单个路径段（文件名 / 目录名）对 Windows 的合法性。纯函数。
 * @returns {string|null} 非法原因；合法返回 null
 */
export function checkWinSegment(seg: string): string | null {
  const s = String(seg == null ? '' : seg)
  if (WIN_ILLEGAL_RE.test(s)) return '文件名包含 Windows 不支持的符号（< > : " | ? *）'
  if (s !== '' && /[. ]$/.test(s)) return '文件名不能以空格或句点结尾（Windows 限制）'
  const base = s.split('.')[0].toUpperCase()
  if (WIN_RESERVED.has(base)) return `「${base}」是 Windows 的保留名称，不能用作文件名`
  return null
}

/**
 * 校验相对路径（rel，posix 分隔）作为 Windows 目标的合法性，含长度预算。纯函数。
 * @param rel 相对同步根的路径
 * @param baseAbs 本机同步根绝对路径（长度预算用；win32 上精确，其余平台近似）
 * @returns {string|null} 非法原因；合法返回 null
 */
export function checkWindowsRel(rel: string, baseAbs: string): string | null {
  const r = String(rel || '')
  for (const seg of r.split('/')) {
    const why = checkWinSegment(seg)
    if (why) return `${seg}：${why}`
  }
  if (r.length > WIN_REL_LEN_LIMIT) return `路径太长（${r.length} 个字符），超出 Windows 的长度限制（${WIN_REL_LEN_LIMIT}）`
  if (process.platform === 'win32') {
    const absLen = String(baseAbs || '').length + 1 + r.length
    if (absLen > WIN_MAX_PATH - 1) return `路径太长（${absLen} 个字符），超出 Windows 的长度限制（260）`
  }
  return null
}

/** 构造 BAD_FILENAME 错误（classifyOpFailure → permanent：记退避表，重命名后自动恢复） */
export function badFilenameError(rel: string, why: string): any {
  return mkOpError(`已跳过「${rel}」：文件名或路径在 Windows 上无法使用（${why}）。改名后会自动恢复同步`, 'BAD_FILENAME', {
    permanent: true,
  })
}

// ---------- 大小写冲突检测 ----------
//
// 同目录下「仅大小写不同」的文件（A.txt 与 a.txt）在大小写不敏感的文件系统
// （Windows / macOS 默认卷）或部分 WebDAV 服务器上是同一个文件：任一侧把它们
// 同时存在时，传输任何一个都会静默覆盖另一个 —— 必须检测并提示，不静默覆盖。
// 检测在规划层（runSyncRound 扫描后）执行，三种形态：
//   本地侧一对（本地大小写敏感卷才会出现）、远端侧一对（Linux 类服务器会出现）、
//   跨侧各一个（本机 A.txt + 远端 a.txt：上传 A.txt 会覆盖远端 a.txt）。
// 处置：涉及文件本轮跳过一切 upload / download / conflict（含 adopt 收敛与半截
// 强制重传），逐组报错引起用户注意；删除传播不受限 —— 用户删除其中一个正是
// 消除冲突的手段，下一轮自动恢复。大小写折叠用 toLowerCase（Unicode 特殊
// 折叠情形为已知近似）。

/**
 * 检测两侧扫描结果中的大小写冲突组。纯函数。
 * @param localRels 本地侧 NFC rel 集合（可迭代）
 * @param remoteRels 远端侧 NFC rel 集合（可迭代，仅文件条目）
 * @returns {{ groups: Array<{ side: 'local'|'remote'|'cross', rels: string[] }>, skip: Set<string> }}
 *          groups 按发现顺序（错误提示逐组）；skip 为全部涉及 rel（规划层跳过用）
 */
export function detectCaseCollisions(localRels: Iterable<string>, remoteRels: Iterable<string>): { groups: any[]; skip: any } {
  /** fold(rel) → { local: [rels], remote: [rels] } */
  const byFold = new Map()
  const add = (side: any, rel: any) => {
    const k = rel.toLowerCase()
    let slot = byFold.get(k)
    if (!slot) {
      slot = { local: [], remote: [] }
      byFold.set(k, slot)
    }
    slot[side].push(rel)
  }
  for (const rel of localRels) add('local', String(rel))
  for (const rel of remoteRels) add('remote', String(rel))
  const groups: any[] = []
  const skip = new Set<any>()
  for (const slot of byFold.values()) {
    // NFC key 完全一致的同名文件（正常情况）不构成冲突 —— 大小写折叠后同键
    if (slot.local.length > 1) {
      groups.push({ side: 'local', rels: slot.local.slice() })
      for (const r of slot.local) skip.add(r)
    }
    if (slot.remote.length > 1) {
      groups.push({ side: 'remote', rels: slot.remote.slice() })
      for (const r of slot.remote) skip.add(r)
    }
    // 跨侧：各恰好一个且 NFC rel 不同（相同则是同名文件，正常同步）
    if (slot.local.length === 1 && slot.remote.length === 1 && slot.local[0] !== slot.remote[0]) {
      groups.push({ side: 'cross', rels: [slot.local[0], slot.remote[0]] })
      skip.add(slot.local[0])
      skip.add(slot.remote[0])
    }
  }
  // 组内排序保证错误信息稳定
  for (const g of groups) g.rels.sort()
  return { groups, skip }
}

// ---------- 同步目录重叠校验（保存时调用） ----------

/**
 * 校验一份新的同步目录配置与既有目录是否嵌套 / 重叠。纯函数。
 * 本地侧与远端侧分别判定：任一侧嵌套（含完全相同）都算重叠 —— 两个同步对
 * 写同一棵子树会互相传播对方的删除、watcher 互相触发、基线互相踩踏。
 * 大小写折叠：win32 与 darwin 默认卷大小写不敏感，路径按小写比较；linux
 * 保持大小写敏感（与 normalizeLocalKey 的平台分支同取向）。
 * @param dir 新配置 { localPath, remotePath }（远端可空 = 不校验远端）
 * @param existing 既有目录列表 [{ id, name?, localPath, remotePath }]
 * @param exceptId 排除的既有目录 id（编辑自身时不与自己比较）
 * @returns {{ side: 'local'|'remote', withName: string, message: string } | null} null = 无重叠
 */
export function checkDirOverlap(dir: DirCfg, existing: DirCfg[], exceptId: string | null | undefined): { side: string; withName: string; message: string } | null {
  const newLocal = storage.normalizeLocalKey(dir && dir.localPath)
  const newRemote = storage.normalizeRemoteKey(dir && dir.remotePath)
  const foldLocal = process.platform === 'win32' || process.platform === 'darwin' ? (p: any) => p.toLowerCase() : (p: any) => p
  const l = foldLocal(newLocal)
  const nested = (a: any, b: any) => a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)
  for (const d of Array.isArray(existing) ? existing : []) {
    if (!d || (exceptId && d.id === exceptId)) continue
    if (d.localPath) {
      const ol = foldLocal(storage.normalizeLocalKey(d.localPath))
      if (nested(l, ol)) {
        return { side: 'local', withName: String(d.name || d.id || ''), message: `这个文件夹与已有的同步「${d.name || d.id}」有重叠，请换一个` }
      }
    }
    if (d.remotePath && dir && dir.remotePath) {
      const or = String(storage.normalizeRemoteKey(d.remotePath))
      const nr = String(newRemote)
      const sameRemoteFold = process.platform === 'win32' || process.platform === 'darwin'
      const a = sameRemoteFold ? nr.toLowerCase() : nr
      const b = sameRemoteFold ? or.toLowerCase() : or
      if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/')) {
        return { side: 'remote', withName: String(d.name || d.id || ''), message: `这个云端文件夹与已有的同步「${d.name || d.id}」有重叠，请换一个` }
      }
    }
  }
  return null
}
