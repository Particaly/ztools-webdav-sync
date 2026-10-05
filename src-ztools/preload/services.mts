/* eslint-disable */
// WebDAV 同步插件 preload 服务：注入 window.services（Node 能力层）。
// 包含四部分：
//   dav    —— 基于 node:http(s) 的 WebDAV 客户端（PROPFIND / GET / PUT / MKCOL / DELETE），
//             网络层含：同源重定向跟随、状态码统一分类、幂等重试与退避、
//             连接/空闲/无进展三段超时、stream.pipeline 传输、keep-alive 连接池
//             与每源限速，以及服务器能力探测与档位判定
//   fsx    —— 本地文件系统辅助（递归扫描、监听、隐藏文件判定）
//   sync   —— 双向同步引擎（三方对比：本地 / 远端 / 本机基线，见下方「同步模型」）
//   storage—— 本地状态存储层入口（store.js：deviceId、基线、WAL）
//
// 同步模型（取代旧的远端 manifest 方案）：
//   基准不再是远端 .webdav-sync.json，而是每设备自持的基线（pluginData 下，见 store.js）。
//   决策输入：本地扫描 / 远端扫描 / 基线条目；有基线沿用三方真值表（decideAction），
//   无基线（新文件 / 基线损坏 / 新设备）一律按无基线保护语义：仅一侧存在视为新增，
//   绝不产生 delete-*；两侧都在则按 size/mtime/hash 收敛（adopt）或冲突。
//   远端不再存放任何状态文件；旧的 manifest / pending 日志逻辑已整体删除。
import http from 'node:http'
import https from 'node:https'
import nodeFs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import nodeTimers from 'node:timers'
import { Transform, pipeline } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { SaxesParser } from 'saxes'
import * as storage from './store.mts'
import { createScheduler, sweepSchedulerTimers } from './scheduler.mts'
import type { SchedulerFacade } from './scheduler.mts'
import { getHostPorts, setHostPorts, HOST_TRASH_MISSING_MESSAGE } from './host.mts'
import { describeZtoolsPluginsSync } from './ztools-plugins.mts'
import { getRegistryReconcileState, reconcilePluginRegistry } from './ztools-registry.mts'
import type {
  BaselineEntry,
  ConflictChoice,
  ConflictInfo,
  DavCapabilities,
  DavConfig,
  DavTier,
  DeleteBatch,
  DeleteBatchNode,
  DeleteScope,
  NetOpts,
  Prefs,
  RegistryReconcileResult,
  SyncLogEntry,
  SyncLogOp,
  SyncMode,
  SyncProgress,
  SyncSummary,
  ZToolsApi,
  ZtoolsPluginsSyncDesc,
} from './types.mts'

/**
 * 本地文件 IO 必须绕过 Electron 的 asar 补丁。ZTools 宿主（Electron）默认给 fs
 * 打上 asar 补丁：以 `.asar` 结尾的路径被当作「档案内路径」—— stat 返回 0 字节
 * 的虚拟条目（mtime 为该进程内首次访问该档案的时刻，随宿主重启变化）、
 * createReadStream 按目录语义打开直接失败。ZTools 插件实体恰是 .asar 文件，同步
 * 引擎必须按真实文件读写：优先 require Electron 暴露的未打补丁 original-fs
 *（esbuild 打包时标记 external，运行时由宿主解析）；非 Electron 环境（vitest
 * 直载源码 / 通用 Node）require 不可用，回落 node:fs —— 两者 API 完全同形。
 * 本模块所有本地文件 IO（fsp 承载的 stat / 扫描 / 落盘，以及上传读流 / 下载写流）
 * 一律经此处解析出的 fs：任何漏网走 asar 视图的调用都会把 0 字节指纹写进基线。
 */
const fs: typeof nodeFs = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const original: any = require('original-fs')
    return original && typeof original.statSync === 'function' && original.promises ? original : nodeFs
  } catch (_) {
    return nodeFs
  }
})()

const fsp = fs.promises

/** preload 运行环境中的 window（宿主注入 ztools API；Node 直跑测试时为伪造对象或不存在） */
declare const window: any
/**
 * 全部计时器一律经 node:timers（libuv 通道）创建，绝不用全局 setTimeout / setInterval。
 * 宿主 contextIsolation:false
 * 下 preload 与页面同处一个 Blink 世界，全局计时器就是 Blink DOM timer —— 页面真进入
 * hidden 态后会被钳到 ≥1s（满 5 分钟后约 1 次/分钟），隐藏态后台轮的锁静置 / 续租 /
 * 重试退避 / 取消轮询都会被拖到分钟级；node:timers 走 libuv，对隐藏节流完全免疫。
 * 注意：网络层的「空闲超时」不经计时器 —— mod.request 的 timeout 选项由 Node core 用
 * socket.setTimeout（libuv）实现，无需迁移。
 */
/**
 * 自动同步调度器。独立模块（无 Vue / DOM 依赖，不反向依赖本文件，
 * 引擎经参数注入），esbuild 随本文件一并打进单文件产物；文件尾部把实例挂到
 * window.services.scheduler。import 放在 storage 之后（scheduler 依赖 store）。
 */

/**
 * 历史版本存放在远端 / 本地同步目录内的状态文件名。相关逻辑已删除，
 * 仅为「用户把插件指到含残留文件的目录时不被同步下去」而在扫描层保留排除。
 */
// ---------- 引擎领域类型（内部形态；公共形态见 types.mts） ----------

/** 引擎连接配置：DavConfig + 网络层注入通道（取消 / 熔断器） */
interface EngineCfg extends DavConfig {
  __wdsyncAbort?: (() => boolean) | null
  __wdsyncBreaker?: ReturnType<typeof createRoundBreaker> | null
}

/** 本地文件指纹（扫描产物） */
interface LocalStat {
  abs: string
  size: number
  mtimeMs: number
}

/** 远端条目指纹（multistatus 解析产物；isDir 条目由扫描层入表、规划层跳过传输决策） */
interface RemoteItem {
  size: number
  mtime: number
  etag?: string
  isDir?: boolean
  origName?: string
}

/** 目录配置（syncDirectory 的 dir 参数形态） */
interface DirCfg {
  id?: string
  localPath: string
  remotePath: string
  mode?: SyncMode
  [k: string]: unknown
}

/** 引擎生效同步参数（渲染层 dirSyncPrefs 与调度器 prefsOf 的同一口径） */
interface EnginePrefs {
  ignoreHidden: boolean
  concurrency: number
  conflictStrategy: 'ask' | 'local' | 'remote' | 'both'
  verifyMaxBytes?: number
  deepVerify?: boolean
  deepVerifyDays?: number
  adoptVerifyBudgetBytes?: number
  leaseLock: boolean
  excludePatterns?: string[]
}

/** syncDirectory 的回调句柄 */
interface SyncHandlers {
  onProgress?: (p: SyncProgress) => void
  onConflict?: (info: ConflictInfo) => Promise<ConflictChoice> | ConflictChoice
  shouldAbort?: () => boolean
  /** 传输完成钩子（payload 形态由调用方解释；可选） */
  afterTransferOp?: (payload: any) => void
  /**
   * 轮次提示（调度器注入；直调可省略）。source = 触发来源（调度器轮次 kind：
   * 'watch' | 'interval' | 'startup' | 'manual' | 'follow-up' | ...）。
   * dirtyPaths 仅 watch 轮携带（watcher 脏路径快照，NFC rel 数组）：引擎据此把
   * 本地扫描换成「基线合成 + 脏路径核对」的快速形态；其余来源是周期性全量
   * 对账的组成部分，必须全量本地扫描。watcherKey 为该目录 watcher 的注册 id
   *（调度器形态 `${instanceId}:${dirId}`），扫描成功后引擎用它清理脏集。
   * op 为一次单向操作（渲染层手动入口注入；显示名与 op 值的映射）：
   *   'pull' = 「云端补齐本地」：云端新增 / 有变化的下载，本地缺失的恢复；本地
   *   多出的保留、本地改过的不覆盖，双侧都改走冲突流程；'push' = 「本地补齐
   *   云端」：按对称语义向云端收敛。'pull-full' = 「云端覆盖本地」/ 'push-full' =
   *   「本地覆盖云端」：以选定侧为准把对侧完全恢复成它的样子 —— 缺失恢复 /
   *   不一致覆盖（不做询问）/ 多余删除。四种都只沿选定方向传输；无基线差异不
   *   产生删除；覆盖档的删除与常规删除同走删除安全闸（批量超阈值挂起等确认）。
   *   仅对本轮生效，不落配置。
   */
  hints?: { source: string; dirtyPaths?: string[]; watcherKey?: string; op?: 'pull' | 'push' | 'pull-full' | 'push-full' }
}

/** 网络请求可选项（singleRequest / davRequest 的 opts） */
interface ReqOpts {
  headers?: Record<string, any>
  body?: string
  bodyFile?: string
  sinkFile?: string
  isCollection?: boolean
  /** 内容 hash 算法名（如 'sha256'；传输时旁路计算，结果在返回值 hashHex） */
  hashAlg?: string
  onReqStart?: (url: unknown) => void
  [k: string]: unknown
}

/** davRequest 的响应形态（HTTP 错误状态码正常 resolve；重试耗尽才 reject） */
interface DavResponse {
  status: number
  headers: Record<string, any>
  /** Buffer（流式聚合）或 string（小响应） */
  body?: any
  etag?: string
  hashHex?: string
  classification?: { code: string; permanent: boolean; retryAfterMs?: number; retryAfterCapped?: boolean }
  redirectCount?: number
}

const MANIFEST_NAME = '.webdav-sync.json'
const PENDING_NAME = '.webdav-sync-pending.json'
/**
 * 目录级租约锁文件名：位于远端同步根第一层，内容为 JSON
 * { v: 1, deviceId, startedAt, ttlMs }。本地与远端扫描层一律排除（远端在根、
 * rel 全等命中；与旧 manifest 同规则，与 ignoreHidden 取值无关）。
 */
const LOCK_NAME = '.webdav-sync.lock'
/** 扫描层一律排除的同步系统文件（本地与远端同规则，与 ignoreHidden 取值无关） */
const SYNC_SKIP_NAMES = new Set([MANIFEST_NAME, PENDING_NAME, LOCK_NAME])
/**
 * 同步引擎自身产生的临时文件名前缀。
 * .wdsync-dl- 为下载临时（downloadOne）；.wdsync-verify- 为内容消歧临时下载；
 * .wdsync-tmp- 为日志等其他临时写入；.wdsync-probe- 为能力探测在远端创建的探测
 * 目录 / 文件（探测放用户配置的远端根目录，必须被扫描排除以
 * 免干扰同步）。识别规则由扫描排除与启动期清理共用。
 */
const SYNC_TMP_PREFIXES = ['.wdsync-dl-', '.wdsync-tmp-', '.wdsync-verify-', '.wdsync-probe-']
/** 孤儿临时文件的最小时龄：超过才允许启动期清理（活跃下载与并发同步的临时文件必然很年轻） */
const ORPHAN_TEMP_MIN_AGE_MS = 60 * 60 * 1000
/** 本进程使用中的临时文件绝对路径集合：启动期清理必须跳过，防止误删并发同步正在写入的文件 */
const LIVE_TEMPS = new Set<any>()
/**
 * 目录监听注册表：id（调度器传入的 watcherId）→ { watcher, timer, dirty }。
 * dirty 为该目录自上一轮同步以来上报过的事件路径集（NFC、'/' 分隔的 rel；详见
 * watchDir 注释）—— 只是「本地哪里可能变了」的加速提示，不是正确性来源
 *（watch 事件不保证完整，周期性全量扫描才是兜底）。
 */
const WATCHERS = new Map()
/** 远端指纹 mtime 容差（ms）：覆盖服务端存储 mtime 粒度损失（FAT 2s、PROPFIND 秒级精度） */
const REMOTE_FP_TOL_MS = 2000
/** 内容消歧（下载校验远端 hash）的默认上限：50MB，可由 prefs.verifyMaxBytes 覆盖 */
const DEFAULT_VERIFY_MAX_BYTES = 50 * 1024 * 1024
/**
 * 采纳内容确认的单轮总字节预算系数：默认预算 = verifyMaxBytes × 4。
 * 依据：崩溃恢复的常见形态是少数几个（1–3 个）中断文件，单文件上限的 4 倍足以完整
 * 覆盖；最坏情况把轮首额外确认 GET 的总流量封顶在「4 个最大文件」（默认 200MB，
 * 慢速广域网约数分钟），超出部分回退按大小采纳、轮次照常推进，绝不因海量待采纳
 * 文件把一轮拖成下载马拉松。prefs.adoptVerifyBudgetBytes > 0 时可直接覆盖总预算。
 */
const ADOPT_VERIFY_BUDGET_FACTOR = 4
/**
 * 开放意图（未了结的 upload 意图）的最大保留时长：30 天。
 * PUT 以 NETWORK / ABORTED / 上传读流失败收场时意图有意保持开放（服务器可能已收
 * 字节），供下一轮 recoverIntents 做半截判定；超龄意图在恢复期无条件放弃，防止
 * WAL 与内存态无限累积（另一半兜底：本地文件已不存在 / 已变化 → 恢复期放弃）。
 * 超龄按意图链最初写入时刻 firstAt 计算 —— 新意图取代旧意图时
 * 继承（runUploadOp），持续中断链（每轮半截重传再中断）的兜底时钟不被刷新，
 * 封顶真正生效；期间 WAL 每轮约增 2 行（新 intent + 旧 intent 的 abort），线性有界。
 */
const OPEN_INTENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 批量删除确认阈值：单轮待删数量（delete-local + delete-remote 合计）超过
 * max(DELETE_BATCH_MIN, 基线条目数 × DELETE_BATCH_RATIO) 时，本轮整批挂起 ——
 * 经冲突挂起通道登记「待确认删除」记录（kind='delete'，无 choice），确认前零删除，
 * 用户逐条 / 批量确认后下一轮才执行。少量删除（正常编辑流）不受影响。
 */
const DELETE_BATCH_MIN = 50
const DELETE_BATCH_RATIO = 0.2

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
function buildDeleteBatch(members: DeleteBatchMembers, at: number): DeleteBatch {
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
function computeUndecidedFiles(batch: DeleteBatch, scopes: DeleteScope[]): number {
  if (!scopes.length) return batch.total
  const hit = (rel: string): boolean =>
    scopes.some((s) => s.prefix === '' || s.prefix === rel || rel.startsWith(s.prefix + '/'))
  // 根层逐个扫描顶层节点（根本身不可决策，空前缀 scope 在下探前先判）
  let covered = 0
  const walk = (node: DeleteBatchNode): void => {
    if (hit(node.rel)) {
      covered += node.files
      return
    }
    // 子节点关系由 rel 前缀推断：只下探直接子层（找以 node.rel + '/' 开头的节点）
    const prefix = node.rel + '/'
    for (const child of batch.nodes) {
      if (child.rel.startsWith(prefix) && !child.rel.slice(prefix.length).includes('/')) walk(child)
    }
  }
  for (const n of batch.nodes) {
    if (!n.rel.includes('/')) walk(n)
  }
  return Math.max(0, batch.total - covered)
}

/**
 * rel 是否落在删除范围决策的前缀之内（与 DirStateStore.matchDeleteScope 同一
 * 匹配规则：rel === prefix、rel 在 prefix 目录之下、或 prefix 为空 = 全部）。
 * 独立纯函数：setDeleteScope 无快照时按逐文件记录计算覆盖数复用。
 */
function scopeHitsRel(prefix: string, rel: string): boolean {
  return prefix === '' || prefix === rel || rel.startsWith(prefix + '/')
}

/**
 * 远端根丢失决策挂起的 rel 键（'.' 不可能是文件相对路径，与逐文件挂起天然无碰撞）：
 * 远端同步根 404 且本地基线非空时，整目录级决策（重新上传 / 移除本地）登记为
 * kind='root-lost' 的挂起记录，选择经 setPendingChoice 落地、下一轮根探测消费。
 */
const ROOT_LOST_PENDING_REL = '.'

/**
 * 长阶段分片让出：批处理循环每 YIELD_EVERY 条目实际让出一次事件循环。
 * 动机：await 一个已就绪的 Promise 只排微任务，node:timers 的回调（调度器 5s 心跳 /
 * 1s tick，走 libuv 定时器阶段）得不到执行机会 —— 数万条目的紧凑规划 / 批量校验 /
 * 哈希队列循环会把心跳饿过 TTL（15s），触发误接管。setImmediate 走 libuv 检查阶段，
 * 真正交还事件循环；每次让出仅一次空转，对吞吐无可测影响（200 条目一让）。
 */
const YIELD_EVERY = 200
let yieldCounter = 0
async function maybeYield(): Promise<void> {
  if (++yieldCounter >= YIELD_EVERY) {
    yieldCounter = 0
    await new Promise((resolve) => nodeTimers.setImmediate(resolve))
  }
}

/**
 * 进度事件节流下限（同相位两次外发的最小间隔毫秒数）。数万文件轮次的
 * 逐文件 tick 会以远超渲染层可消化的频率回调 onProgress（调度器缺失时渲染层
 * 直调引擎，每个事件都触发一次 Vue 响应式更新，界面卡顿）；节流后同相位事件
 * 至多 ~7Hz，进度条观感无差别。相位切换（每相位首个事件）与调用方标注的终态
 * 事件（force=true）一律外发 —— 注入式测试（「plan 首事件」窗口注入）与最终
 * 计数准确性不受节流影响；计数单调不减，被丢弃的中间事件不损失信息。
 */
const PROGRESS_MIN_INTERVAL_MS = 150
/** 本地扫描进度回调的间隔（扫描无既定总量，filesDone 按已见文件数递增上报） */
const SCAN_PROGRESS_MS = 250
/**
 * 本地脏路径快速核对的条目上限：watch hints 的 dirtyPaths 超过它即放弃快速核对、
 * 回落全量 walk。两个动机：① 病态大批量改动（如解压 / 依赖安装产生数千事件）时，
 * 逐路径 lstat + 每个删除路径的子树前缀清扫反而可能慢于一次顺序 walk；② 防御脏集
 * 异常膨胀（平台事件风暴）拖垮轮次。回落只影响性能形态，不影响正确性。
 */
const DIRTY_SCAN_MAX = 512

/**
 * 给 onProgress 套时间节流（runSyncRound 内唯一入口，各阶段共用）。
 * 规则见 PROGRESS_MIN_INTERVAL_MS 注释；返回 (p, force?) => void。
 */
function throttledProgress(onProgress: (p: SyncProgress) => void): (p: SyncProgress, force?: boolean) => void {
  let lastPhase: any = null
  let lastAt = 0
  return (p, force = false) => {
    const t = Date.now()
    if (!force && p.phase === lastPhase && t - lastAt < PROGRESS_MIN_INTERVAL_MS) return
    lastPhase = p.phase
    lastAt = t
    onProgress(p)
  }
}

// ---------- 目录级租约锁 + 同目录单轮互斥 ----------
//
// 租约锁：跨设备的「同一目录同时同步」互斥靠远端同步根下的锁文件
//（.webdav-sync.lock）+ 服务器时钟 TTL。状态机：
//   GET 锁 → 404 空闲 / 200 解析（损坏视为过期）→ 过期判定**只用服务器时钟**
//   （响应头 date − last-modified ≥ ttlMs → 过期接管；deviceId 是本机 → 自己的遗留接管；
//    他人且未过期 → 让出本轮）→ PUT 本机锁 → 静置 LOCK_SETTLE_MS 回读确认
//   （deviceId 仍属本机 → 获得；他人 → 写回竞争失败让出；GET 失败 → 按已获得 + warning）
//   → 轮末 finally 释放（DELETE，绕过整轮熔断器单次尝试）。
// 无法写锁（PUT 403/401/网络失败等，含只读 C 档服务器）→ 跳过租约继续同步，
// 本轮仅依赖档位保护 —— 租约锁是尽力而为的互斥，绝不阻断同步本身。
//
// 获取时机（锁后置 + 按需）：规划完成后、worker 执行前，且仅当本轮计划含
// 远端写操作（upload / delete-remote / 可能落地为上传的 conflict）才尝试获取 ——
// 空轮 / 纯下载轮完全不发锁请求（省 4 个请求 + 1.5s 写回静置）。左锁补删（lockLeftover）
// 仍在轮首无条件执行，不随后置移动；能力探测随之自然落在锁外（探测写全部落在自己的
// 随机目录，无互斥风险）。
//
// 单轮互斥：本进程内的重入由模块级 ROUND_IN_FLIGHT 挡住（调度层误排 /
// 手动触发 + 定时轮重叠时，第二个轮次立即让位返回，不排队堆叠）。
/** 租约锁默认 TTL：3 分钟（锁内容 ttlMs 可覆盖，读取侧夹到 [LOCK_TTL_MIN_MS, LOCK_TTL_MAX_MS]） */
const LOCK_TTL_MS = 180000
/** 锁内容 ttlMs 的夹取区间：下界防瞬时值抖动误判过期，上界防异常大值把锁钉死 */
const LOCK_TTL_MIN_MS = 60000
const LOCK_TTL_MAX_MS = 3600000
/** PUT 锁后的静置期：他机同刻写锁的「写回竞争」在该窗口后由回读确认暴露 */
const LOCK_SETTLE_MS = 1500
/** 续租间隔：明显小于 TTL，重写锁内容（mtime 随之刷新）即完成续期 */
const LOCK_RENEW_MS = 60000
/**
 * 活动续租定时器集合：轮末 finally 与插件退出（services.cleanup）双通道清扫。
 * 崩溃注入路径（crashErr）故意不清自己的定时器（模拟进程死亡不做任何收尾），
 * 退出时的全局清扫是其唯一兜底 —— 不清扫则定时器会阻止宿主进程退出。
 */
const RENEW_TIMERS = new Set<any>()
/** 同目录单轮互斥表：key = normalizeLocalKey(localPath) + '|' + normalizeRemoteKey(remotePath) */
const ROUND_IN_FLIGHT = new Map()

// ---------- 通用工具 ----------

/** 将远端相对路径拼接为绝对 URL，并对每个路径段做 URI 编码 */
function remoteUrl(cfg: EngineCfg, remotePath: string): string {
  const base = String(cfg.serverUrl || '').replace(/\/+$/, '')
  const rel = String(remotePath || '').replace(/^\/+|\/+$/g, '')
  const encoded = rel ? rel.split('/').map(encodeURIComponent).join('/') : ''
  return encoded ? `${base}/${encoded}` : `${base}/`
}

/** Basic 认证头 */
function authHeader(cfg: EngineCfg): Record<string, string> {
  if (!cfg.username && !cfg.password) return {}
  const token = Buffer.from(`${cfg.username || ''}:${cfg.password || ''}`).toString('base64')
  return { Authorization: `Basic ${token}` }
}

/** rel 内部 key 统一 NFC（store.js 同名实现的本地引用，避免循环依赖） */
const nfc = storage.nfc

/**
 * multistatus 提取器（saxes 流式实现，取代旧正则解析）。
 *
 * 与旧实现的语义对齐点：
 *  - 不开 xmlns 选项：真实抓包偶见「未声明的前缀」，开了会在 opentag 处硬错误；
 *    前缀剥离沿用 localName 策略，D: / d: / 无前缀（乃至任意前缀）统一覆盖；
 *  - <response> 内同名 prop 首次出现生效（对齐旧正则 pick() 的 first-match，
 *    含 404 propstat 与 200 propstat 并存时的取舍顺序）；
 *  - <response> / <collection> 标签容忍携带属性（逐元素 xmlns 声明等）；
 *  - CDATA 与普通文本按出现顺序拼进同一缓冲：text 事件已按 XML 规范解码实体
 *    （十进制 / 十六进制 / 预定义实体），CDATA 为字面文本不解码 —— 两者直接相连即可。
 *
 * 对旧实现的两处**有意语义修正**（旧缺陷）：
 *  1. CDATA 不再泄漏 <![CDATA[...]]> 标记进取值；
 *  2. 十六进制实体（&#xNN;）正确解码（旧 decodeEntities 只认十进制）。
 *
 * 错误语义（安全关键）：saxes 出错只发 error 事件不抛异常；此处记下首个错误，
 * close() 之后统一 throw —— 畸形 XML（截断 / 未闭合 / 坏实体 / 标签不匹配）
 * 必须让调用方把该目录扫描判为 incomplete，绝不静默返回部分结果（否则残缺
 * 列表会被决策层解释成「远端已删除」触发误删）。
 *
 * 流式接口：write() 接受 string 或 Buffer（Buffer 经 StringDecoder 转 utf-8，
 * 防止多字节中文文件名被网络块边界拆断）；条目在 <response> 闭合时即产出，
 * 不为整篇文档建树 —— Depth: infinity 大响应的内存驻留只与条目数相关。
 */
function createMultistatusStream(): any {
  const decoder = new StringDecoder('utf8')
  const parser = new SaxesParser({})
  const entries: any[] = []
  let firstError: any = null
  let cur: any = null // 当前 <response> 的累积条目
  let capture: any = null // 正在收集文本的 prop：{ field, buf }
  const FIELDS = new Set(['href', 'getcontentlength', 'getlastmodified', 'getetag', 'status'])
  parser.on('error', (e) => {
    if (firstError == null) firstError = e
  })
  parser.on('opentag', (node) => {
    const name = localName(node.name)
    if (name === 'response') {
      if (!cur) cur = { href: '', isDir: false, size: 0, mtime: 0, etag: '', seen: new Set<any>() }
      return
    }
    if (!cur) return
    if (name === 'collection') {
      cur.isDir = true
      return
    }
    // first-match：同名 prop 只取首次出现；已在本字段收集期间不重开（防嵌套同名元素）
    if (FIELDS.has(name) && !cur.seen.has(name) && !capture) {
      cur.seen.add(name)
      capture = { field: name, buf: '' }
    }
  })
  const appendText = (t: any) => {
    if (capture) capture.buf += t
  }
  parser.on('text', appendText)
  parser.on('cdata', appendText)
  parser.on('closetag', (tag) => {
    const name = localName(typeof tag === 'string' ? tag : tag.name)
    if (capture && name === capture.field) {
      const v = capture.buf.trim()
      if (capture.field === 'href') cur.href = v
      else if (capture.field === 'getcontentlength') cur.size = Number(v) || 0
      else if (capture.field === 'getlastmodified') cur.mtime = v ? Date.parse(v) || 0 : 0
      else if (capture.field === 'status') cur.status = v
      else cur.etag = v
      capture = null
      return
    }
    if (name === 'response' && cur) {
      // href 的百分号序列可能是坏的（文件名含裸 % 的服务器未编码输出）：
      // 解码失败退回原串，不能让单个坏条目炸掉整次目录解析
      let href = cur.href
      try {
        href = decodeURIComponent(href)
      } catch (_) {
        /* 保留原值 */
      }
      entries.push({ href, isDir: cur.isDir, size: cur.size, mtime: cur.mtime, etag: cur.etag, status: cur.status || '' })
      cur = null
    }
  })
  return {
    /** 喂入一段响应（string 或 Buffer；Buffer 经 StringDecoder 防多字节拆断） */
    write(chunk: any) {
      parser.write(typeof chunk === 'string' ? chunk : decoder.write(chunk))
    },
    /** 收尾；存在任一解析错误时统一抛出（调用方据此把扫描判为 incomplete） */
    close() {
      parser.close()
      if (firstError) {
        // 面向用户一句话；原始解析错误放 detail（反馈问题时可见）
        const err: any = new Error('服务器返回的内容无法识别，请确认地址是 WebDAV 地址')
        err.code = 'XML_PARSE'
        err.detail = firstError.message
        throw err
      }
    },
    /** 已成功产出的条目（close() 抛错时调用方不得使用本结果） */
    entries() {
      return entries
    },
  }
}

/** 标签名剥命名空间前缀：D:href / d:href / href（乃至任意未声明前缀）统一取 localName */
function localName(name: string): string {
  const i = String(name).indexOf(':')
  return i >= 0 ? String(name).slice(i + 1) : String(name)
}

/**
 * 解析 WebDAV multistatus XML，返回条目数组（与命名空间前缀无关）。
 * 签名与输出形状与旧正则实现保持一致：[{ href, isDir, size, mtime, etag }]。
 * 畸形 XML 一律 throw（code='XML_PARSE'）——绝不静默返回部分结果。
 */
function parseMultistatus(xml: string): any {
  const stream = createMultistatusStream()
  stream.write(String(xml))
  stream.close()
  return stream.entries()
}

/**
 * 依据服务端返回的 href 计算其相对于集合路径的 rel 路径（posix 分隔）。
 * 以集合自身的 URL pathname 为基准剥离，可正确处理 /remote.php/dav/ 之类的挂载前缀。
 * 返回空字符串表示条目是集合自身。
 */
function relFromHref(cfg: EngineCfg, collectionRemote: string, href: string): string {
  let itemPath = href
  try {
    const u = new URL(href, cfg.serverUrl)
    // 规范的 href 不会含未编码的 #（那会变成 fragment），因此 hash 非空必然意味着
    // 文件名本身带 #（parseMultistatus 已把 %23 提前解码成 #）：并回路径，否则文件名被截断
    itemPath = decodeURIComponent(u.pathname + (u.hash || ''))
  } catch (_) {
    /* 保留原值 */
  }
  let colPath
  try {
    // 与 itemPath 同样解码后再比对：remoteUrl 会逐段做百分号编码，
    // 不解码时中文等非 ASCII 目录名比对失败，会退化成返回整条 itemPath（相对路径错误）
    colPath = decodeURIComponent(new URL(remoteUrl(cfg, collectionRemote)).pathname)
  } catch (_) {
    colPath = '/' + String(collectionRemote || '').replace(/^\/+|\/+$/g, '')
  }
  if (!colPath.endsWith('/')) colPath += '/'
  if (itemPath === colPath || itemPath === colPath.replace(/\/$/, '')) return ''
  if (itemPath.startsWith(colPath)) {
    return itemPath.slice(colPath.length).replace(/\/+$/, '')
  }
  // 回退：按段剥离基准目录（href 与集合不同源等异常情况）
  const baseSeg = String(collectionRemote || '')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
  const segs = itemPath.replace(/^\/+/, '').split('/').filter(Boolean)
  let i = 0
  while (i < baseSeg.length && segs[segs.length - baseSeg.length + i] === baseSeg[i]) i++
  if (i === baseSeg.length) return segs.slice(0, segs.length - baseSeg.length).join('/')
  return segs.join('/')
}

// ---------- dav：WebDAV 客户端网络层（重定向 / 状态码分类 / 幂等重试 / 三段超时 / pipeline 传输 / 连接复用） ----------

/** 网络层默认参数：全部可经 cfg.netOpts 覆盖，写死为常量便于整体审计 */
const NET_DEFAULTS = {
  connectTimeoutMs: 10000, // TCP/TLS 建连超时：宁可早失败早重试，也不长时间挂在半开连接上
  idleTimeoutMs: 30000, // socket 空闲（无数据活动）超时：沿用旧版 30s 语义
  stallMs: 60000, // 传输「无进展」判死：收到响应后持续无任何字节的阈值（每块数据都会重置）
  maxSockets: 8, // 每源（host:port）并发连接上限（keep-alive 池）
  ratePerSec: 0, // 每源每秒请求上限，0 = 不限制
}
/** 重定向最大跟随次数：与常见浏览器/客户端默认一致，防重定向环 */
const MAX_REDIRECTS = 3

/**
 * 已知服务器档案：按 host 匹配，命中且用户未显式配置
 * netOpts.ratePerSec 时提供保守默认限速。目前只有坚果云 —— 官方对 WebDAV
 * 请求频率有配额（具体数额未公开，超限返回 429），且不支持 Depth:infinity
 * （逐目录 N+1 扫描请求多），是「最容易撞配额」的服务器形态。引擎已尊重
 * Retry-After 并按网络类失败做跨轮退避，档案默认再从源头压低请求速率。
 * 数值是保守取舍（4 次/秒 ≈ 500 目录空扫 2 分钟出头），用户可随时在设置页覆盖。
 */
const SERVER_PROFILES = [
  { label: '坚果云', hostSuffix: 'jianguoyun.com', netOpts: { ratePerSec: 4 } },
]

/** 档案匹配缓存（serverUrl 字符串 → 档案或 null）：resolveNetOpts 每请求调用，避免反复解析 URL */
const profileCache = new Map()

/**
 * 按服务器地址匹配已知服务器档案；无地址 / URL 不合法 / 未命中返回 null。
 * 匹配规则：host 全等或以「.<后缀>」结尾 —— evil-jianguoyun.com 与
 * jianguoyun.com.evil.com 均不命中。目录级 serverUrl 覆盖各自获得生效地址
 * 的档案（cfgOf 已把目录生效地址放进 cfg.serverUrl）。
 */
function serverProfileFor(serverUrl: string | null | undefined): any {
  const key = String(serverUrl || '')
  if (profileCache.has(key)) return profileCache.get(key)
  let profile: any = null
  try {
    const host = new URL(key).hostname.toLowerCase()
    if (host) {
      for (const p of SERVER_PROFILES) {
        if (host === p.hostSuffix || host.endsWith('.' + p.hostSuffix)) {
          profile = p
          break
        }
      }
    }
  } catch (_) {
    /* URL 不合法 = 无档案 */
  }
  if (profileCache.size > 32) profileCache.clear() // 同步目录数有限，兜底防膨胀
  profileCache.set(key, profile)
  return profile
}
/** 网络层 / 限流类失败的最大重试次数：首次之外再重试 3 次 */
const MAX_RETRIES = 3
/** 指数退避基数：500ms * 2^n，±25% 抖动 */
const RETRY_BASE_MS = 500
/** Retry-After 上限：服务端给再长也只等 30s，避免整轮同步被单个请求卡死 */
const RETRY_AFTER_CAP_MS = 30000
/**
 * 取消轮询间隔：shouldAbort 触发到在途请求被销毁的最大延迟。
 * 网络层没有「请求开始 / 结束」之外的统一挂点（下载在响应流、上传在读流、
 * 其余在等响应头），轮询是覆盖全部阶段的最低成本方案；间隔内的误差对
 * 取消体验无感（远小于任何一次真实传输的剩余时长）。
 */
const ABORT_POLL_MS = 100
/** 幂等方法：网络层异常时允许自动重试（PUT 不在其中，见 requestWithRetry 注释） */
const IDEMPOTENT_METHODS = new Set(['GET', 'PROPFIND', 'OPTIONS', 'DELETE', 'MKCOL'])
/** 这些状态码代表服务端「明确未处理请求」（没有落地任何字节），因此对 PUT 重发也是安全的 */
const RETRYABLE_STATUS_ANY_METHOD = new Set([429, 503, 423])
/** 允许跟随的重定向状态码（一律保留方法与请求体） */
const REDIRECT_STATUS = new Set([301, 302, 307, 308])

/**
 * 整轮熔断阈值：连续「网络类终态失败」达到该次数后，本轮剩余请求快速失败
 * 并终止轮次。只计网络层异常（重试耗尽后抛出的 NETWORK）与终态 5xx/429 响应 ——
 * 它们是「服务器整体不可用」的信号；4xx / 条件头 412 / 本地 IO 等文件级失败不计数
 * （每个文件独立，连续失败不代表服务器宕机）。
 *
 * 时间预算推导（最坏情形）：单请求 = 首次尝试 + 3 次重试，重试间隔为
 * min(Retry-After, 30s)：最坏 3×30s + 4 次响应耗时 ≈ 92s；熔断前最多 5 个这样的
 * 请求串行 ≈ 460s（并发传输时更快触发），此后本轮立即终止 —— 单轮总时长有上界，
 * 持续 503 的服务器不再把每个待传文件各拖 ~92 秒。
 */
const ROUND_BREAKER_THRESHOLD = 5

/**
 * 整轮熔断器（每轮同步一个实例，经 cfg.__wdsyncBreaker 传入网络层）。
 * consecutive 在任一成功请求后清零：偶发失败不熔断，只有「连续挂」才判定服务器不可用。
 */
function createRoundBreaker(threshold = ROUND_BREAKER_THRESHOLD) {
  const st = { consecutive: 0, open: false, reason: '' }
  return {
    noteSuccess() {
      st.consecutive = 0
    },
    noteFailure(msg: any) {
      st.consecutive++
      if (!st.open && st.consecutive >= threshold) {
        st.open = true
        st.reason = String(msg || '')
      }
    },
    /** 熔断后网络层快速失败用的错误（permanent=true：不再进入重试）；一句人话 + 技术原因放 detail */
    error() {
      const err: any = new Error('服务器连续多次出错，本次同步已暂停，剩余文件会在下次同步时继续')
      err.status = 0
      err.code = 'CIRCUIT_OPEN'
      err.permanent = true
      err.detail = `连续失败 ${st.consecutive} 次（${st.reason}）`
      return err
    },
    get open() {
      return st.open
    },
    get reason() {
      return st.reason
    },
    get consecutive() {
      return st.consecutive
    },
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => nodeTimers.setTimeout(r, ms))

/**
 * 合并 cfg.netOpts 与默认值；非法值（非正数等）回退默认，配置错误不应放大成奇怪行为。
 * ratePerSec 的分层：用户显式配置（含显式 0 = 明确不限速）>
 * 服务器档案默认（坚果云等，见 SERVER_PROFILES）> NET_DEFAULTS（0）。0 是合法
 * 显式值，不能用 num() 的「>0」口径吞掉，单独处理。
 */
function resolveNetOpts(cfg: EngineCfg): Required<NetOpts> {
  const raw = cfg && typeof cfg.netOpts === 'object' && cfg.netOpts ? cfg.netOpts : {}
  const num = (v: any, dflt: any) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt)
  const profile = serverProfileFor(cfg && cfg.serverUrl)
  const dfltRate =
    profile && Number.isFinite(profile.netOpts.ratePerSec) && profile.netOpts.ratePerSec > 0
      ? profile.netOpts.ratePerSec
      : NET_DEFAULTS.ratePerSec
  return {
    connectTimeoutMs: num(raw.connectTimeoutMs, NET_DEFAULTS.connectTimeoutMs),
    idleTimeoutMs: num(raw.idleTimeoutMs, NET_DEFAULTS.idleTimeoutMs),
    stallMs: num(raw.stallMs, NET_DEFAULTS.stallMs),
    maxSockets: num(raw.maxSockets, NET_DEFAULTS.maxSockets),
    ratePerSec:
      typeof raw.ratePerSec === 'number' && Number.isFinite(raw.ratePerSec) && raw.ratePerSec >= 0
        ? raw.ratePerSec
        : dfltRate,
  }
}

/** 模块级 keep-alive 连接池：按「协议 + maxSockets」缓存 Agent，Agent 内部再按 host:port 复用 */
const agentPool = new Map()
function agentFor(protocol: string, maxSockets: number): http.Agent {
  const mod = protocol === 'https:' ? https : http
  const key = `${protocol}|${maxSockets}`
  let agent = agentPool.get(key)
  if (!agent) {
    agent = new mod.Agent({ keepAlive: true, maxSockets })
    agentPool.set(key, agent)
  }
  return agent
}

/** 销毁全部自建 Agent 与限速器（插件退出 / 测试收尾调用，避免存活 socket 阻止进程退出） */
function destroyNetPools(): void {
  for (const agent of agentPool.values()) agent.destroy()
  agentPool.clear()
  rateLimiters.clear()
}

/**
 * 清扫崩溃注入轮遗留的租约锁续租定时器。crashErr 路径按「模拟进程死亡」
 * 故意不做任何收尾（不 DELETE 锁、不清自己的续租定时器，见 syncDirectory 释放
 * finally 的注释）；真实进程死亡时定时器随进程消失，而测试在同一进程内模拟死亡，
 * 必须在崩溃轮断言后调用本函数做等价收尾 —— 否则遗留定时器会按 60s 周期向旧锁
 * 路径发 PUT，落进后续无关用例的观察窗（reqlog 行 / 限流预算）。
 * 遗留的锁文件本身是真实崩溃也会留下的残渣（TTL 过期 + 下轮左锁清理兜底），
 * 不在本函数职责内。返回清除的定时器个数（测试回归断言用）。
 */
function crashResidueSweep(): number {
  let cleared = 0
  for (const t of Array.from(RENEW_TIMERS)) {
    nodeTimers.clearInterval(t)
    RENEW_TIMERS.delete(t)
    cleared++
  }
  return cleared
}

/** 每源简单令牌桶：容量 = ratePerSec，按速率持续补充；经串行链发放（不精确但足够） */
const rateLimiters = new Map()
function acquireRateSlot(origin: string, ratePerSec: number): Promise<void> {
  let bucket = rateLimiters.get(origin)
  if (!bucket) {
    bucket = { tokens: ratePerSec, last: Date.now(), chain: Promise.resolve() }
    rateLimiters.set(origin, bucket)
  }
  const run = bucket.chain.then(async () => {
    const now = Date.now()
    bucket.tokens = Math.min(ratePerSec, bucket.tokens + ((now - bucket.last) / 1000) * ratePerSec)
    bucket.last = now
    if (bucket.tokens < 1) {
      await sleep(Math.ceil((1 - bucket.tokens) * (1000 / ratePerSec)))
      bucket.tokens = Math.max(bucket.tokens, 1) // 补眠后至少按 1 枚发放
    }
    bucket.tokens -= 1
  })
  bucket.chain = run.catch(() => {})
  return run
}

/**
 * 解析 Retry-After 头：兼容「秒数」与「HTTP 日期」两种形态。
 * 返回 { ms, capped } 或 null；ms 已截断到 [0, 30s]，超上限时 capped = true（调用方据此标注）。
 */
function parseRetryAfter(raw: unknown): { ms: number; capped: boolean } | null {
  if (raw == null) return null
  const s = String(Array.isArray(raw) ? raw[0] : raw).trim()
  if (!s) return null
  let ms: any = null
  if (/^\d+$/.test(s)) ms = Number(s) * 1000
  else {
    const t = Date.parse(s)
    if (!Number.isNaN(t)) ms = t - Date.now()
  }
  if (ms == null) return null
  const capped = ms > RETRY_AFTER_CAP_MS
  return { ms: Math.max(0, capped ? RETRY_AFTER_CAP_MS : ms), capped }
}

/**
 * HTTP 状态码统一分类表。
 * 只回答「这类失败是什么」，不决定要不要重试 —— 重试还与方法幂等性有关（见 requestWithRetry）。
 * 405 的「MKCOL 已存在」语义保留给调用方解释（mkdirDeep 把它当成功）。
 */
function classifyStatus(status: number, headers: Record<string, any>): { code: string; permanent: boolean; retryAfterMs?: number; retryAfterCapped?: boolean } {
  if (status === 401 || status === 403) return { code: 'AUTH', permanent: true }
  if (status === 404) return { code: 'NOT_FOUND', permanent: true }
  if (status === 405) return { code: 'NOT_ALLOWED', permanent: true }
  if (status === 409) return { code: 'PARENT_MISSING', permanent: true }
  if (status === 412) return { code: 'PRECONDITION', permanent: true }
  if (status === 413 || status === 414) return { code: 'TOO_LARGE', permanent: true }
  if (status === 423) return { code: 'LOCKED', permanent: false } // 被锁：稍后重试通常可解除
  const ra = parseRetryAfter(headers && headers['retry-after'])
  if (status === 429) {
    return { code: 'RATE_LIMITED', permanent: false, ...(ra ? { retryAfterMs: ra.ms, retryAfterCapped: ra.capped } : {}) }
  }
  if (status === 503) {
    // 503 与 429 同属「限流/过载」：都尊重 Retry-After；code 归 SERVER（与其他 5xx 一致）
    return { code: 'SERVER', permanent: false, ...(ra ? { retryAfterMs: ra.ms, retryAfterCapped: ra.capped } : {}) }
  }
  if (status >= 500) return { code: 'SERVER', permanent: false }
  return { code: 'HTTP', permanent: true } // 其余 4xx：请求本身有问题，重试无意义
}

/** 网络层错误统一包装：已分类的错误原样透传，其余包装为 status=0 / code='NETWORK' / permanent=false */
function normalizeNetError(e: any, url: any): any {
  if (e && (e.code === 'NETWORK' || e.code === 'LOCAL_IO' || e.code === 'REDIRECT' || e.code === 'ABORTED')) return e
  const err: any = new Error('网络连接失败，请检查网络和服务器地址')
  err.status = 0
  err.code = 'NETWORK'
  err.permanent = false
  err.detail = `${(e && e.code) || (e && e.message) || e} ${url ? url.href : ''}`
  return err
}

/**
 * 构造「用户取消」类中止错误。取消必须能打断在途传输：网络层轮询
 * shouldAbort（cfg.__wdsyncAbort）后以本错误销毁请求，各错误出口优先以它收场 ——
 * 销毁动作引出的 ECONNRESET / PREMATURE_CLOSE 不得被误判为网络故障（否则会
 * 触发幂等重试与整轮熔断计数，让取消「复活」或污染失败统计）。
 * code='ABORTED' 是执行层的取消标记：该类错误不计失败分类、不进退避表、
 * 不产生用户可见错误（轮次整体按既有「同步已中止」语义收场）。
 */
function makeAbortError(url: any): any {
  const err: any = new Error('已取消同步')
  err.status = 0
  err.code = 'ABORTED'
  err.permanent = false
  err.detail = url ? url.href : ''
  return err
}

/** 重试等待：服务端给了 Retry-After 就尊重（已在 parseRetryAfter 截断）；否则指数退避 + 抖动 */
function backoffDelayMs(attempt: number, cls: any): number {
  if (cls && cls.retryAfterMs != null) return cls.retryAfterMs
  const base = RETRY_BASE_MS * Math.pow(2, attempt)
  return Math.round(base * (0.75 + Math.random() * 0.5)) // ±25% 抖动，避免多文件同步的重试风暴对齐
}

/** 上传/下载时旁路计算内容 hash 的 Transform（不额外读盘，边传边算；hash 对象按次创建，重试互不污染） */
function hashTransform(h: { update(c: unknown): void }): Transform {
  return new Transform({
    transform(chunk, _enc, cb) {
      h.update(chunk)
      cb(null, chunk)
    },
  })
}

/** 下载落盘错误映射：ENOSPC / EACCES / EPERM 等转可读中文（技术细节放 detail） */
function mapLocalWriteError(e: any, sinkFile: any): any {
  const code = (e && e.code) || ''
  const known = code === 'ENOSPC' || code === 'EDQUOT' || code === 'EACCES' || code === 'EPERM'
  const err: any = known
    ? new Error(code === 'ENOSPC' || code === 'EDQUOT' ? '电脑磁盘空间不足，写入文件失败。请清理空间后重新同步' : '没有写入权限，无法保存文件。请检查文件夹权限后重新同步')
    : new Error(`保存文件「${path.basename(sinkFile || '')}」失败`)
  err.status = 0
  err.code = 'LOCAL_IO'
  err.permanent = true
  err.detail = `${code || (e && e.message) || e} ${sinkFile || ''}`
  return err
}

/**
 * 发送单次请求（不含重试与重定向）。三段超时：
 *   连接超时（默认 10s）—— TCP/TLS 建立，仅对「正在建连」的 socket 生效；
 *   空闲超时（默认 30s）—— socket 无数据活动（沿用旧版语义，经 request timeout 实现）；
 *   无进展（默认 60s）—— 收到响应后持续无任何字节（stall 计时器随每块数据重置；上传方向由
 *   空闲超时兜底：读流停摆时 socket 同样无活动）。
 * 传输一律走 stream.pipeline：下载 res → 可选 hash → 写文件；上传 读流 → 可选 hash → req。
 * backpressure 与错误销毁交由 pipeline：读流/写流错误都会终结请求而不是悬挂。
 * 非成功（非 2xx）响应不落盘、不喂 hash —— 重试 / 重定向不得污染最终内容与摘要。
 */
function singleRequest(cfg: EngineCfg, method: string, url: URL, opts: ReqOpts, netOpts: Required<NetOpts>): Promise<DavResponse> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http
    const headers = { ...authHeader(cfg), ...opts.headers }
    let bodyBuf: any = null
    if (opts.bodyFile) {
      // bodyFile 每次尝试都重新 stat + 建流：重试 / 重定向绝不能复用已消费的读流
      let st
      try {
        st = fs.statSync(opts.bodyFile)
      } catch (e: any) {
        const err: any = new Error(`「${path.basename(opts.bodyFile)}」未上传：文件已经不在电脑上了`)
        err.status = 0
        err.code = 'LOCAL_IO'
        err.permanent = true
        err.detail = opts.bodyFile
        reject(err)
        return
      }
      headers['Content-Length'] = st.size
    } else if (opts.body != null) {
      bodyBuf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(String(opts.body), 'utf-8')
      headers['Content-Length'] = bodyBuf.length
    }
    // hash 按次创建（而非复用调用方传入的对象）：重试 / 重定向后摘要只覆盖最终成功的那一次传输
    const h = opts.hashAlg ? crypto.createHash(opts.hashAlg) : null
    let connectTimer: any = null
    let stallTimer: any = null
    let abortTimer: any = null // 取消轮询（见下方 req 创建后的挂载点）
    let settled = false
    const clearTimers = () => {
      if (connectTimer) nodeTimers.clearTimeout(connectTimer)
      if (stallTimer) nodeTimers.clearTimeout(stallTimer)
      if (abortTimer) nodeTimers.clearInterval(abortTimer)
      connectTimer = stallTimer = abortTimer = null
    }
    const finish = (fn: any, arg: any) => {
      if (settled) return
      settled = true
      clearTimers()
      fn(arg)
    }
    const armStall = () => {
      if (stallTimer) nodeTimers.clearTimeout(stallTimer)
      stallTimer = nodeTimers.setTimeout(() => {
        const err: any = new Error(`传输卡住了：${Math.round(netOpts.stallMs / 1000)} 秒没有收到数据，请检查网络`)
        err.status = 0
        err.code = 'NETWORK'
        err.permanent = false
        err.detail = url ? url.href : ''
        req.destroy(err)
      }, netOpts.stallMs)
    }
    const onResponse = (res: any) => {
      const status = res.statusCode || 0
      if (status < 200 || status >= 300) {
        // 失败 / 重定向响应：不落盘、不喂 hash，只消费响应体（释放 keep-alive 连接），
        // 结构化分类信息随结果带出供调用方（及后续阶段）使用
        res.resume()
        res.on('end', () =>
          finish(resolve, {
            status,
            headers: res.headers,
            body: null,
            etag: res.headers.etag || '',
            classification: classifyStatus(status, res.headers),
          })
        )
        res.on('error', (e: any) => finish(reject, abortErr || normalizeNetError(e, url)))
        return
      }
      armStall()
      res.on('data', () => armStall()) // 每收到一块数据就重置无进展计时
      if (opts.sinkFile && !opts.bodyFile) {
        // 下载：res → 可选 hash Transform → 写文件（pipeline 处理 backpressure / 错误传播）
        const sink = fs.createWriteStream(opts.sinkFile)
        // 与上传读流同理（见 bodyFile 分支注释）：请求侧（res）失败时 pipeline 的
        // 拆除会把同一错误传播进写流，若只看「sink 是否报过错」，网络中断会被误判
        // 成「文件写不进去」。以首个报错的来源区分发起方：sink 先报 = 真写失败。
        let firstErrFrom: '' | 'res' | 'sink' = ''
        sink.on('error', () => {
          if (!firstErrFrom) firstErrFrom = 'sink'
        })
        res.on('error', () => {
          if (!firstErrFrom) firstErrFrom = 'res'
        })
        const chain = [res]
        if (h) chain.push(hashTransform(h))
        chain.push(sink)
        pipeline(chain, (err) => {
          if (err) {
            // 取消销毁引出的错误一律以 ABORTED 收场（abortErr 非空 = 取消已发生）
            const mapped = abortErr || (firstErrFrom === 'sink' ? mapLocalWriteError(err, opts.sinkFile) : normalizeNetError(err, url))
            req.destroy(mapped)
            finish(reject, mapped)
            return
          }
          finish(resolve, { status, headers: res.headers, body: null, etag: res.headers.etag || '', hashHex: h ? h.digest('hex') : undefined })
        })
      } else {
        const chunks: any[] = []
        res.on('data', (c: any) => {
          // 上传场景的 h 属于请求体，响应体不得混入摘要
          if (h && !opts.bodyFile) h.update(c)
          chunks.push(c)
        })
        res.on('end', () =>
          finish(resolve, { status, headers: res.headers, body: Buffer.concat(chunks), etag: res.headers.etag || '', hashHex: h ? h.digest('hex') : undefined })
        )
        res.on('error', (e: any) => finish(reject, abortErr || normalizeNetError(e, url)))
      }
    }
    const req = mod.request(
      {
        method,
        host: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        headers,
        agent: agentFor(url.protocol, netOpts.maxSockets),
        timeout: netOpts.idleTimeoutMs,
      },
      onResponse
    )
    // 连接超时：复用 keep-alive 连接（sock.connecting === false）时跳过；
    // https 需等到 TLS 握手完成（secureConnect）才算连接建立
    req.on('socket', (sock) => {
      if (!sock || !sock.connecting) return
      connectTimer = nodeTimers.setTimeout(() => {
        const err: any = new Error('连接服务器超时，请检查网络或服务器地址')
        err.status = 0
        err.code = 'NETWORK'
        err.permanent = false
        err.detail = `${netOpts.connectTimeoutMs}ms ${url.origin}`
        req.destroy(err)
      }, netOpts.connectTimeoutMs)
      sock.once(url.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        if (connectTimer) nodeTimers.clearTimeout(connectTimer)
        connectTimer = null
      })
    })
    req.on('timeout', () => {
      const err: any = new Error('服务器长时间没有响应，请稍后重试')
      err.status = 0
      err.code = 'NETWORK'
      err.permanent = false
      err.detail = `${Math.round(netOpts.idleTimeoutMs / 1000)}s ${url.host}`
      req.destroy(err)
    })
    req.on('error', (e) => finish(reject, abortErr || normalizeNetError(e, url)))
    // 取消中断：shouldAbort 经 cfg.__wdsyncAbort 注入（runSyncRound 逐轮挂载，
    // 释放锁 / 批量校验等收尾请求会显式置空以豁免）。短周期轮询 + destroy：取消一旦
    // 触发，在途请求（下载响应流 / 上传读流 / 等待响应头任一阶段）立即销毁，不再等
    // 大文件传完；读写流由 pipeline 的错误传播一并终结。abortErr 记录中止事实，
    // 上方各错误出口优先以它收场（见 makeAbortError 注释）。unref：请求正常收尾
    // 前 finally 会 clearTimers，这里只为异常路径不阻塞进程退出加双保险。
    const abortPoll = cfg && typeof cfg.__wdsyncAbort === 'function' ? cfg.__wdsyncAbort : null
    let abortErr: any = null
    if (abortPoll) {
      abortTimer = nodeTimers.setInterval(() => {
        if (!settled && abortPoll()) {
          abortErr = abortErr || makeAbortError(url)
          req.destroy(abortErr)
        }
      }, ABORT_POLL_MS)
      if (typeof abortTimer.unref === 'function') abortTimer.unref()
    }
    if (opts.bodyFile) {
      // 上传：读流 → 可选 hash → req（pipeline：读流错误会销毁 req，不会悬挂）
      const rs = fs.createReadStream(opts.bodyFile)
      // 只有读流**自身**报错才按本地 IO 归类。请求侧失败（stall 看门狗 / 空闲超时 /
      // 连接被重置等 req.destroy(err)）时，pipeline 的拆除会把同一错误传播进读流
      //（destroy(err, rs) → rs 的 'error' 再冒一次）—— 若只看「rs 是否报过错」，网络
      // 卡顿会被误判成「文件暂时读不出来」并标记 permanent（不再重试）。因此以
      // **首个报错的来源**区分发起方：rs 先报 = 真读不出来；req 先报 = 网络故障，
      // 读流其后冒出的同一错误只是拆除回声，按 NETWORK 归类交给既有重试 / 退避。
      let firstErrFrom: '' | 'rs' | 'req' = ''
      let rsErr: any = null
      rs.on('error', (e) => {
        if (!firstErrFrom) {
          firstErrFrom = 'rs'
          rsErr = e
        }
      })
      req.on('error', () => {
        if (!firstErrFrom) firstErrFrom = 'req'
      })
      const chain: any[] = [rs]
      if (h) chain.push(hashTransform(h))
      chain.push(req)
      pipeline(chain, (err) => {
        if (!err) return // 正常收尾交由响应回调 resolve
        // 取消销毁（abortErr 非空）优先于读流失败判定 —— 取消不是本地 IO 故障
        if (abortErr) {
          finish(reject, abortErr)
          return
        }
        if (firstErrFrom === 'rs') {
          const e2: any = new Error(`「${path.basename(opts.bodyFile || '')}」未上传：文件暂时读不出来`)
          e2.status = 0
          e2.code = 'LOCAL_IO'
          e2.permanent = true
          e2.source = 'body-read' // 上传读流失败 —— 已发出的字节服务器可能已收，意图须保持开放
          e2.detail = `${(rsErr && rsErr.code) || (rsErr && rsErr.message) || err} ${opts.bodyFile || ''}`
          req.destroy(e2)
          finish(reject, e2)
          return
        }
        finish(reject, normalizeNetError(err, url))
      })
    } else if (bodyBuf != null) {
      req.end(bodyBuf)
    } else {
      req.end()
    }
  })
}

/**
 * 带重试的单 URL 请求：
 *  - 幂等方法（GET/PROPFIND/OPTIONS/DELETE/MKCOL）：网络异常或 429/503/423/5xx 最多重试 3 次；
 *  - PUT 仅在 429/503/423 上重试 —— 这些状态代表服务端明确「未处理请求」（未落地任何字节），
 *    重发不会造成二次应用；而纯网络层异常无法判断对端是否已收到/应用部分字节，PUT 一律不重试
 *    （引擎的 WAL / 基线语义都假定每次上传至多应用一次），宁可直接失败交给整轮重规划兜底；
 *  - 其余 4xx 不重试；本地 IO 类错误（LOCAL_IO，permanent）不重试。
 * 退避：500ms × 2^n ± 25% 抖动；429/503 优先采用 Retry-After（已截断 30s 上限，超限标记 capped）。
 */
async function requestWithRetry(cfg: EngineCfg, method: string, url: URL, opts: ReqOpts, netOpts: Required<NetOpts>): Promise<DavResponse> {
  const idempotent = IDEMPOTENT_METHODS.has(method)
  const breaker = cfg && cfg.__wdsyncBreaker
  let waitMs = 0
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0) await sleep(waitMs)
    // 整轮熔断：open 后本轮所有请求快速失败，不再消耗重试预算
    if (breaker && breaker.open) throw breaker.error()
    // 取消：取消后不再发起新的尝试（首次 / 幂等重试 / 重定向跟随一律拦截）
    if (cfg && typeof cfg.__wdsyncAbort === 'function' && cfg.__wdsyncAbort()) throw makeAbortError(url)
    if (netOpts.ratePerSec > 0) await acquireRateSlot(url.origin, netOpts.ratePerSec)
    let res
    try {
      res = await singleRequest(cfg, method, url, opts, netOpts)
    } catch (e: any) {
      if (e && e.permanent) throw e // 本地 IO 类失败：重试无意义
      // 在途传输被取消销毁 —— 立即透传，绝不进入幂等重试（重试会让取消失效）
      if (e && e.code === 'ABORTED') throw e
      if (idempotent && attempt < MAX_RETRIES && !opts.noRetry) {
        waitMs = backoffDelayMs(attempt, null)
        continue
      }
      // 网络层异常耗尽重试：计入整轮熔断（服务器整体不可用的信号）
      if (breaker && e && e.code === 'NETWORK') breaker.noteFailure(`${method} ${url.host}：${e.message}`)
      throw e
    }
    const s = res.status
    const retryable = s === 429 || s === 503 || s === 423 || (s >= 500 && s < 600)
    const methodAllowed = RETRYABLE_STATUS_ANY_METHOD.has(s) || idempotent
    if (retryable && methodAllowed && attempt < MAX_RETRIES && !opts.noRetry) {
      waitMs = backoffDelayMs(attempt, res.classification || classifyStatus(s, res.headers))
      continue
    }
    // 终态结果：5xx/429 计入熔断计数（文件级 4xx / 2xx / 3xx 一律视为服务器健康）
    if (breaker) {
      if (retryable) breaker.noteFailure(`${method} ${url.host}：HTTP ${s}`)
      else breaker.noteSuccess()
    }
    return res
  }
}

/**
 * 发送一个 WebDAV 请求（网络层总入口）。
 * opts: { headers, body(Buffer|string), bodyFile(本地路径，流式上传), sinkFile(本地路径，流式下载),
 *         hashAlg(如 'sha256'：bodyFile 时对请求体、否则对响应体计算，结果在返回值 hashHex),
 *         isCollection(目标为集合：URL 统一补尾斜杠), noRetry(禁用自动重试的逃生口) }
 * 返回 { status, headers, body, etag, hashHex?, classification? }。
 *
 * 框架与旧版保持一致：HTTP 错误状态码正常 resolve（调用方检查 r.status / r.classification），
 * 只有网络层异常（重试耗尽后）才 reject —— 错误对象带 status=0、code='NETWORK'、permanent=false。
 *
 * 重定向：301/302/307/308 最多跟随 3 次，仅同源，保留方法与请求体（bodyFile 场景每次
 * 跟随都重新创建文件读流）；相对 Location 以当前 URL 解析为绝对；跨源拒绝跟随并抛出含
 * 源与目标 URL 的可读错误（认证头绝不能被引到另一个源）。
 */
async function davRequest(cfg: EngineCfg, method: string, remotePath: string, opts: ReqOpts = {}): Promise<DavResponse> {
  const netOpts = resolveNetOpts(cfg)
  let startUrl
  try {
    startUrl = new URL(remoteUrl(cfg, remotePath))
  } catch (e: any) {
    const invalid: any = new Error('服务器地址格式不对，应以 http:// 或 https:// 开头')
    invalid.detail = cfg && cfg.serverUrl
    throw invalid
  }
  // 集合类 URL 统一带尾斜杠：部分服务器对无尾斜杠的集合 PROPFIND 返回 301，
  // 与其每次跟随重定向，不如一开始就按规范形态发起
  if (opts.isCollection && !startUrl.pathname.endsWith('/')) startUrl.pathname += '/'
  let current = startUrl
  for (let redirects = 0; ; redirects++) {
    const res = await requestWithRetry(cfg, method, current, opts, netOpts)
    if (!REDIRECT_STATUS.has(res.status) || !res.headers || res.headers.location == null) {
      // 附带已跟随的重定向次数：能力探测据此观察「集合 URL 无尾斜杠是否被 301」
      // 一类服务器行为；其余调用方不受影响（新增字段）
      res.redirectCount = redirects
      return res
    }
    if (redirects >= MAX_REDIRECTS) {
      const loop: any = new Error('服务器地址一直在跳转，无法连接，请检查地址是否正确')
      loop.detail = `重定向超过 ${MAX_REDIRECTS} 次：${startUrl.href}`
      throw loop
    }
    let next
    try {
      next = new URL(String(res.headers.location), current)
    } catch (e: any) {
      const badLoc: any = new Error('服务器地址一直在跳转，无法连接，请检查地址是否正确')
      badLoc.detail = `重定向地址无效（${res.headers.location}）：${current.href}`
      throw badLoc
    }
    if (next.origin !== current.origin) {
      const err: any = new Error(`服务器想把请求转到另一个网站（${next.origin}），出于安全已拒绝。如果新地址可信，请直接填写新地址`)
      err.status = res.status
      err.code = 'REDIRECT'
      err.permanent = true
      err.detail = `${current.href} → ${next.href}`
      throw err
    }
    current = next
  }
}

/** 递归创建远端目录（逐级 MKCOL，405 视为已存在）。失败时抛错带 status（探测按其分类权限性失败） */
async function mkdirDeep(cfg: EngineCfg, remotePath: string): Promise<void> {
  const segs = String(remotePath)
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean)
  let cur = ''
  for (const seg of segs) {
    cur += '/' + seg
    const r = await davRequest(cfg, 'MKCOL', cur)
    if (r.status !== 201 && r.status !== 405 && r.status !== 301) {
      const err: any = new Error(`无法在云端创建文件夹「${cur}」，请检查账号是否有写入权限`)
      err.status = r.status
      err.detail = `MKCOL HTTP ${r.status}`
      throw err
    }
  }
}

/**
 * 远端条目入表（逐目录与 Depth:infinity 两种扫描形态共用的排除链）。
 * 排除次序与语义和旧逐目录实现逐行一致：探测残留旁路登记（仅同步根第一层）→
 * 引擎临时前缀 → 内置垃圾 → 用户排除规则 → ignoreHidden。目录与文件分别入表
 *（目录条目 isDir:true，规划层跳过其传输决策）。
 * @returns {boolean} true = 条目已入表（目录也由本函数入表，是否递归列举由调用方决定）
 */
function acceptRemoteItem(files: Map<string, any>, probeResidue: Array<{ rel: string; mtimeMs: number }>, rel: string, item: RemoteItem, isRootLevel: boolean, ignoreHidden: boolean, excludeMatcher: ((rel: string) => boolean) | null): boolean {
  if (item.isDir) {
    // 同步根第一层的探测目录：旁路登记给 syncDirectory 的残留清理；
    // 只登记不排除例外 —— 登记完仍走下方排除链，不进 files、不参与同步
    if (isRootLevel && rel.startsWith(PROBE_PREFIX)) probeResidue.push({ rel, mtimeMs: item.mtime })
    if (isSyncTempRel(rel)) return false
    if (isJunkRel(rel)) return false
    if (excludeMatcher && excludeMatcher(rel)) return false
    if (ignoreHidden && isHiddenRel(rel)) return false
    files.set(rel, { isDir: true, size: 0, mtimeMs: item.mtime, etag: item.etag })
    return true
  }
  if (SYNC_SKIP_NAMES.has(rel)) return false
  if (isSyncTempRel(rel)) return false
  if (isJunkRel(rel)) return false
  if (excludeMatcher && excludeMatcher(rel)) return false
  if (ignoreHidden && isHiddenRel(rel)) return false
  files.set(rel, { isDir: false, size: item.size, mtimeMs: item.mtime, etag: item.etag })
  return true
}

/**
 * 深度列举远端目录（完整性感知版）。
 * 返回 { files: Map(rel -> {size, mtimeMs, etag, isDir}), complete: boolean, errors: [{rel, message}],
 *         probeResidue: [{rel, mtimeMs}], depth: 'infinity' | 'per-dir',
 *         collections: Map(NFC rel -> {e, m}), skippedDirs: [NFC rel] }（后两项见「子集合 etag 跳过」）。
 *
 * 与本地扫描对齐的安全性要求：
 *   - 根目录 / 子目录 PROPFIND 404 一律记为「无法确认」而不是「远端已删除」：
 *     子树缺失可能来自权限、瞬时故障或挂载前缀变化，绝不能触发删除传播。
 *     同口径覆盖「207 + 根条目 404 propstat」形态（部分网关对缺失路径不回
 *     HTTP 404 状态）：集合自身条目携带 404 propstat 时同样上报根缺失。
 *   - 非 207 响应同样记为扫描错误。complete === false 时调用方必须禁止本轮删除。
 *   - 同步系统自身文件（SYNC_SKIP_NAMES）与引擎临时文件在 ignoreHidden
 *     判定之前一律排除：它们不是用户业务文件，ignoreHidden=false 时同样不可进入候选集合。
 *   - 内置垃圾规则（isJunkRel）与用户排除规则（excludeMatcher）同样先于
 *     ignoreHidden 判定：垃圾文件不是业务文件；用户规则是显式意图，与隐藏开关无关。
 * probeResidue 为旁路登记（不进 files）：同步根第一层的 `.wdsync-probe-` 探测目录
 *（能力探测的崩溃残留，见 runCapabilityProbe）。登记复用本次扫描结果，专供
 * syncDirectory 扫描后的残留清理使用，不产生额外请求；探测目录本身仍被排除，
 * 绝不进入同步候选集合。
 * 扫描形态：
 *   - opts.depthInfinity 为 true（能力探测结论支持）时先对同步根发一次
 *     Depth:infinity PROPFIND —— 整棵树一个请求拿全（数万文件 / 数百目录的
 *     逐目录扫描要发 N+1 个请求，infinity 服务器上单请求快一个量级）；
 *   - 非 207 状态（能力缓存过期 / 服务器行为变化）或 multistatus 解析失败一律
 *     **回落逐目录模式**重扫（不用残缺结果；逐目录模式自己会给出完整性结论）。
 *     网络层异常不回落 —— 它已被网络层重试 3 次，回落只会对同一故障再发一串
 *     请求、成倍计入整轮熔断；
 *   - 「207 但只回第一层」的浅响应在扫描层无法识别（长得和合法的全平树一样），
 *     由 runSyncRound 的基线嵌套条目阀门兜底（见该处注释）；
 *   - depth 字段标记实际使用的形态，供调用方区分（阀门只对单请求形态生效）。
 *
 * 子集合 etag 跳过（仅逐目录形态）：
 *   - opts.collectionEtasg（上一轮完整扫描落盘的集合 etag 表，NFC rel 键；
 *     null / 缺省 = 不跳过，行为与既有完全一致）。BFS 在子目录入队处判定：
 *     该子条目 etag 非空且与缓存一致 → 不入队（省一次 PROPFIND），记入
 *     skippedDirs；否则照旧入队。根目录永不跳过（队首必然列举）。etag 缺失 /
 *     为空的服务器自然永不跳过（无须特判 —— 空串与任何缓存值都不相等）。
 *   - 正确性契约：跳过的前提是服务器能力 etagPropagation 已被探测验证
 *    （深层修改会传播到所有祖先集合的 etag），因此「子集合 etag 未变 ⇒ 子树
 *     内容未变」；**本函数不做能力判断，能力判断在调用方**（runSyncRound 按
 *     caps.etagPropagation / 缓存新鲜期统一裁决后才传入非空 map）。
 *   - collections 返回本轮实际观测到的每个子集合的 etag+mtime（NFC rel 键）：
 *     两种形态统一从 files 表的目录条目收割 —— 目录条目在两种形态下都带
 *     etag/mtime（acceptRemoteItem 入表），被跳过的目录在父清单里的条目同样是
 *     本轮的有效观测。调用方据此收割 scan-cache（仅完整扫描轮可落盘）。
 *   - skippedDirs 为本轮按「父清单里子集合 etag 与缓存一致」跳过 PROPFIND 的
 *     子集合 rel（NFC）。调用方负责把被跳过子树按基线合成回 files 表。
 * @param excludeMatcher compileExcludePatterns 的产物（用户排除规则；null = 无规则直通）
 * @param opts { depthInfinity?: boolean, collectionEtasg?: Map<string, { e: string; m: number }> | null }
 *        （缺省 falsy = 逐目录模式 + 不跳过，兼容既有调用方）
 */
async function listRemoteSafe(cfg: EngineCfg, remotePath: string, ignoreHidden: boolean, excludeMatcher: ((rel: string) => boolean) | null = null, opts: any = {}): Promise<any> {
  const base = String(remotePath).replace(/\/+$/, '')
  const files = new Map()
  const errors: any[] = []
  const probeResidue: any[] = [] // 同步根第一层的探测目录残留（旁路，见函数头注释）
  /** 本轮实际观测到的子集合 etag 表（NFC rel → { e, m }）：两种形态统一在收尾时从 files 表收割 */
  const collections = new Map<any, any>()
  /** 按缓存 etag 跳过 PROPFIND 的子集合 rel 列表（NFC；正确性契约见函数头注释） */
  const skippedDirs: string[] = []
  /**
   * 从 files 表收割子集合观测（目录条目 → collections，NFC 键）。数万条目的
   * 遍历按既有入表循环同规格分片让出。
   */
  const harvestCollections = async () => {
    for (const [rel, info] of files) {
      await maybeYield()
      if (info.isDir) collections.set(nfc(rel), { e: info.etag || '', m: info.mtimeMs || 0 })
    }
  }
  let complete = true
  if (opts.depthInfinity) {
    let r: any
    let netErr: any = null
    try {
      r = await davRequest(cfg, 'PROPFIND', base, {
        isCollection: true,
        headers: { Depth: 'infinity', 'Content-Type': 'application/xml' },
        body: PROBE_PROPFIND_BODY,
      })
    } catch (e: any) {
      netErr = e
    }
    if (netErr == null && (r.status === 207 || r.status === 200)) {
      let items
      try {
        items = parseMultistatus(r.body ? r.body.toString('utf-8') : '')
      } catch (e: any) {
        items = null // 解析失败 → 回落逐目录（文档过大截断等场景逐目录小文档可解）
      }
      if (items) {
        for (const item of items) {
          await maybeYield() // 数万条目的入表循环分片让出（与本地扫描同规格）
          // href 为集合自身的条目返回空 rel；infinity 响应的其余条目 rel 即
          // 相对同步根的完整路径（可能多段）
          const rel = relFromHref(cfg, base, item.href).replace(/\/+$/, '')
          if (!rel) {
            // 集合自身条目携带 404 propstat = 服务器以 207 形态告知「集合不存在」
            //（部分网关 / 服务对缺失路径不回 HTTP 404 状态，而是 207 + 404 propstat；
            // 根探测 Depth:0 也只见 207）。与 HTTP 404 分支同语义上报，交由 I1 闸门
            // 的根丢失兜底接管 —— 绝不能解读成「远端为空」触发批量删除
            if (/404/.test(String(item.status || ''))) {
              complete = false
              errors.push({ rel: '.', message: '云端找不到这个文件夹，或没有访问权限（HTTP 404）' })
              return { files, complete, errors, probeResidue, depth: 'infinity', collections, skippedDirs }
            }
            continue
          }
          acceptRemoteItem(files, probeResidue, rel, item, !rel.includes('/'), ignoreHidden, excludeMatcher)
        }
        await harvestCollections()
        return { files, complete, errors, probeResidue, depth: 'infinity', collections, skippedDirs }
      }
    }
    if (netErr == null && r.status !== 404) {
      // 非 207 且非 404（403/400/501 等 = 服务器对 infinity 说不，缓存已过期）：
      // 回落逐目录。404 不回落 —— 根缺失要与逐目录模式同语义上报（触发根重建
      // 保护链路），网络异常同样不回落（见函数头注释）
    } else if (netErr != null) {
      complete = false
      errors.push({ rel: '.', message: (netErr && netErr.message) || String(netErr) })
      return { files, complete, errors, probeResidue, depth: 'infinity', collections, skippedDirs }
    } else {
      // 404：与逐目录模式的首请求同语义（根缺失 → incomplete，绝不解读为「远端已删除」）
      complete = false
      errors.push({ rel: '.', message: '云端找不到这个文件夹，或没有访问权限（HTTP 404）' })
      return { files, complete, errors, probeResidue, depth: 'infinity', collections, skippedDirs }
    }
  }
  // 队列元素：{ path: 远端绝对路径, prefix: 相对基准目录的目录前缀 }
  const queue: Array<{ path: string; prefix: string }> = [{ path: base, prefix: '' }]
  while (queue.length) {
    const { path: cur, prefix } = queue.shift()!
    let r
    try {
      // isCollection：目录列举目标一律是集合，URL 补尾斜杠发起
      r = await davRequest(cfg, 'PROPFIND', cur, {
        isCollection: true,
        headers: { Depth: '1', 'Content-Type': 'application/xml' },
        body:
          '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>',
      })
    } catch (e: any) {
      complete = false
      errors.push({ rel: prefix || '.', message: (e && e.message) || String(e) })
      continue
    }
    if (r.status === 404) {
      complete = false
      errors.push({ rel: prefix || '.', message: '云端找不到这个文件夹，或没有访问权限（HTTP 404）' })
      continue
    }
    if (r.status !== 207) {
      complete = false
      errors.push({ rel: prefix || '.', message: `云端文件夹暂时读不出来（HTTP ${r.status}）` })
      continue
    }
    let items
    try {
      items = parseMultistatus(r.body ? r.body.toString('utf-8') : '')
    } catch (e: any) {
      // 畸形 XML（截断 / 未闭合 / 坏实体）：整目录判 incomplete，绝不把部分条目当全量
      //（否则残缺列表会被决策层解释成「远端已删除」→ 误删本地文件）
      complete = false
      errors.push({ rel: prefix || '.', message: (e && e.message) || String(e) })
      continue
    }
    for (const item of items) {
      const childRel = relFromHref(cfg, cur, item.href)
      if (!childRel) {
        // 集合自身条目（根级 = prefix 为空）：携带 404 propstat 时与 infinity 分支
        // 同语义上报根缺失 —— 否则该 207 会被解读成「远端为空」，非空基线下
        // 规划出批量 delete-local（仅靠删除阈值兜底）
        if (!prefix && /404/.test(String(item.status || ''))) {
          complete = false
          errors.push({ rel: '.', message: '云端找不到这个文件夹，或没有访问权限（HTTP 404）' })
        }
        continue // 集合自身
      }
      const rel = prefix ? `${prefix}/${childRel.replace(/\/+$/, '')}` : childRel.replace(/\/+$/, '')
      if (acceptRemoteItem(files, probeResidue, rel, item, !prefix, ignoreHidden, excludeMatcher) && item.isDir) {
        // 子集合 etag 跳过判定：缓存有该子集合的非空 etag 且与
        // 父清单里观测一致 → 子树内容未变（正确性契约见函数头注释），不再入队列举。
        // 根目录不经此路径（队首必然列举），天然永不跳过。
        const dirRel = nfc(rel)
        const cached = opts.collectionEtasg ? opts.collectionEtasg.get(dirRel) : null
        if (cached && item.etag && cached.e === item.etag) {
          skippedDirs.push(dirRel)
        } else {
          queue.push({ path: `${base}/${rel}`, prefix: rel })
        }
      }
    }
  }
  await harvestCollections()
  return { files, complete, errors, probeResidue, depth: 'per-dir', collections, skippedDirs }
}

/** 兼容旧 API：仅需要文件表（Map）的调用方使用；扫描不完整时抛出，避免把残缺列表当全量 */
async function listRemote(cfg: EngineCfg, remotePath: string, ignoreHidden: boolean): Promise<Map<string, any>> {
  const scan = await listRemoteSafe(cfg, remotePath, ignoreHidden)
  if (!scan.complete) {
    const e: any = new Error('无法读取云端文件夹的内容，本次同步已停止，没有改动任何文件')
    e.scanErrors = scan.errors
    e.detail = `${scan.errors[0].rel}: ${scan.errors[0].message}`
    throw e
  }
  return scan.files
}

/**
 * 浅层列举远端目录的直接子目录（Depth 1 PROPFIND，不递归）。
 * 供渲染层的远端目录选择器逐级浏览使用。
 * @param cfg WebDAV 连接配置
 * @param remotePath 基准目录（'' 表示服务器根目录）
 * @returns 子目录数组 [{ name: 目录名, path: 以 / 开头的远端路径 }]，按名称排序；
 *          隐藏目录（以 . 开头）不返回；目录不存在 / 权限错误时抛出异常
 */
async function listDirs(cfg: EngineCfg, remotePath: string): Promise<Array<{ name: string; path: string }>> {
  const base = String(remotePath || '').replace(/^\/+|\/+$/g, '')
  // 浏览器式逐级浏览的目标是集合：URL 补尾斜杠发起
  const r = await davRequest(cfg, 'PROPFIND', base, {
    isCollection: true,
    headers: { Depth: '1', 'Content-Type': 'application/xml' },
    body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
  })
  if (r.status === 404) throw new Error('云端找不到这个文件夹，或没有访问权限')
  const body = r.body ? r.body.toString('utf-8') : ''
  // 个别服务器对成功的 PROPFIND 返回 200 + multistatus 而非 207，一并接受
  if (r.status !== 207 && !(r.status === 200 && /multistatus/i.test(body))) {
    const err: any = new Error('无法读取云端文件夹的内容')
    err.detail = `HTTP ${r.status}`
    throw err
  }
  const dirs: any[] = []
  for (const item of parseMultistatus(body)) {
    // isDir 解析不出来时的兜底：RFC 约定集合的 href 以 / 结尾
    if (!item.isDir && !/\/$/.test(item.href)) continue
    const rel = relFromHref(cfg, base, item.href).replace(/\/+$/, '')
    if (!rel) continue // 集合自身
    // 异常服务器可能在 href 里带出嵌套路径：路径按完整 rel 拼接，名称只取最后一段
    const name = rel.split('/').pop() || rel
    if (isHiddenRel(name) || isJunkRel(name)) continue
    dirs.push({ name, path: `${base ? `/${base}` : ''}/${rel}` })
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name))
  return dirs
}

// ---------- 服务器能力探测与档位（写权限按远端根路径） ----------
//
// 背景：WebDAV 服务器对条件请求（If-Match / If-None-Match）、etag 强弱、Depth:
// infinity、集合 URL 尾斜杠等行为差异极大，且「静默忽略条件头」的服务器很常见 ——
// 不能按 RFC 假设，必须实测后落档。缓存存于 pluginData 存储根（store.js 的
// ServerStateStore / capabilities.json），绝不放 dbStorage / 用户同步目录 / 远端。
//
// 缓存粒度（两层）：
//   - 公共能力字段（etag 行为 / 条件请求 / depthInfinity / mtime 精度 / 尾斜杠重定向）
//     按「origin（scheme://host:port）+ username」粒度共享 —— 同一服务器同账号的行为
//     属性与具体目录无关；
//   - 写权限（writable，即 C 档判定）按「远端根路径」粒度（capabilities.json 的
//     writePaths 表）：同一账号下不同共享 / 子树的写权限可能不同（只读分享等），
//     探测文件就写在目标路径下实测。探测序列整体在目标路径执行：公共字段只在
//     无可信缓存时探测一次，后续目录仅补一次写探测（约 3 个请求）。
//
// 写失败分类：权限性失败（401/403/507；PUT 另含 405）→ C 档 +
// 原因（writeReason，UI 展示），缓存 7 天；非权限性失败（409 父目录缺失 / 5xx /
// 网络错误）→ 不得按 C 档长期缓存，当轮按 B 档保守处理（照常尝试写入 + 复查
// 保护），写结论不落缓存，下一轮自动重探。
//
// 目标根目录不存在：先确保根目录存在（PROPFIND 404 → mkdirDeep，
// 与同步轮自身的建根行为一致）再探测 —— 探测不「探测到父级」。
//
// 档位判定规则：
//   C —— 目标路径写探测被权限性拒绝：download-only，跳过一切上传与删除；
//   A —— 条件请求两侧实测均被遵守（If-Match 过期得 412 且 If-None-Match:* 对已存在
//         文件得 412），且 PROPFIND 返回强 etag（非 W/ 前缀）：上传 / 删除带条件头；
//   B —— 其余（可写，但条件请求不可用或 etag 弱 / 缺失 / 未知）：覆盖 / 删除前紧邻复查。
// 注意：etag「跨 PUT 稳定性」（etag.stable）只记录不参与档位判定 —— nginx/Apache 的
// mtime 型 etag 同内容重传也会变，属正常现象，不影响 If-Match 的正确使用。

/** 能力缓存 TTL：7 天（远端服务器行为变化通常伴随部署，周期性重探足够） */
const PROBE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/**
 * etag 跳过扫描缓存（scan-cache.json）的最大新鲜期：6 小时。
 * etag 跳过依赖「服务器正确传播集合 etag」这一探测结论 —— 探测是 7 天前的快照，
 * 服务器行为可能已变（停止传播的深层修改会被跳过漏掉）；周期性强制一次全量下降
 * 把这类「界内滞后」限制在有界时间内。同时也覆盖 watch 缺失的远端侧对账
 *（对端直改远端、本机无任何触发时，全量下降是唯一的发现通道）。
 */
const ETAG_SKIP_FULL_SCAN_MS = 6 * 3600 * 1000
/** 探测目录名前缀（已加入 SYNC_TMP_PREFIXES，扫描层排除） */
const PROBE_PREFIX = '.wdsync-probe-'
/**
 * 崩溃残留清理的最低时龄：小于该值的同前缀目录可能是「并发探测正在使用」，不得删。
 * 清理策略：按 `.wdsync-probe-` 前缀 + 时龄 ≥ 10 分钟（本常量）清理**所有设备**的
 * 崩溃残留 —— 前缀匹配不区分设备（活跃探测必然年轻，年龄门槛保护并发探测）。
 * 双通道执行：同步轮扫描后清理（syncDirectory 3.2 步，复用扫描结果、不额外列目录）
 * + 探测启动时清理（runCapabilityProbe 第 2 步，仅 needCommon 分支 —— 公共缓存命中
 * 时的按路径写探测不列表，依赖同步轮通道兜底）。两个通道都只删同步根第一层的
 * 探测目录（探测只产生第一层残留），绝不递归其他内容。
 */
const PROBE_RESIDUE_MIN_AGE_MS = 10 * 60 * 1000
/** 探测请求总量软上限（典型序列约 12 个）：超限立即降级收尾，绝不拖垮轮次 */
const PROBE_MAX_REQUESTS = 16
const PROBE_BODY = 'wdsync-capability-probe'
const PROBE_PROPFIND_BODY =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/></d:prop></d:propfind>'
/**
 * 写探测的「权限性失败」状态码：只有明确「不让写」才允许按 C 档长期缓存。
 * MKCOL 的 405 例外 = 集合已存在（RFC 4918），沿用旧语义视为可用；
 * PUT 的 405 = 方法不允许（该资源不可覆盖），归权限性失败。
 */
const MKCOL_DENIED_STATUS = new Set([401, 403, 507])
const PUT_DENIED_STATUS = new Set([401, 403, 405, 507])

/**
 * 计算配置的服务器 origin（scheme://host:port）——能力与噪声的缓存键之一。
 * 解析失败回退原始字符串（探测本身随后会因无效地址降级）。
 */
function originOf(cfg: EngineCfg): string {
  try {
    return new URL(remoteUrl(cfg, '')).origin
  } catch (_) {
    return String((cfg && cfg.serverUrl) || '')
  }
}

/**
 * etag 规范化（仅用于相等比较）：去首尾空白、去 W/ 弱标记前缀、去包裹引号。
 * 全链路（探测 / B 档复查 / 测试断言）共用这一处口径，避免「带引号 vs 不带」的假不相等。
 */
function normEtag(e: string | null | undefined): string {
  let t = String(e == null ? '' : e).trim()
  if (/^W\//i.test(t)) t = t.slice(2)
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) t = t.slice(1, -1)
  return t
}

/** 是否弱 etag（W/ 前缀）——弱 etag 绝不用于 If-Match（RFC 7232 强比较语义） */
function isWeakEtag(e: string | null | undefined): boolean {
  return /^W\//i.test(String(e == null ? '' : e).trim())
}

/** 取「可用于 If-Match 的强 etag」：弱 / 空返回 null，否则返回规范化后的裸 tag */
function strongEtagOf(e: string | null | undefined): string | null {
  if (!e || isWeakEtag(e)) return null
  const t = normEtag(e)
  return t ? t : null
}

/** 降级能力结果：探测无法完成时按 B 档（可写假设 + 无条件请求）保守执行，不落缓存 */
function degradedCaps(note: string, tech?: string): DavCapabilities {
  return {
    probedAt: 0,
    tier: 'B',
    writable: true,
    degraded: true,
    writeReason: note,
    writeRetrySoon: true,
    etag: { present: false, weak: false, stable: false },
    conditional: { ifMatch: false, ifNoneMatch: false },
    depthInfinity: false,
    etagPropagation: false,
    mtimePrecision: 'ms',
    collectionRedirect: false,
    notes: tech ? [note, tech] : [note],
  }
}

/** 权限性拒绝的写结论（C 档，可缓存 7 天）：reason 为面向用户一句话，tech 为技术明细（进 notes） */
function deniedWrite(reason: string, tech?: string): any {
  return { writable: false, reason, tech, probedAt: Date.now() }
}

/** 非权限性失败的写结论（409 / 5xx / 网络错误）：当轮按 B 档保守处理，不落缓存，下轮重探 */
function retryWrite(note: string, tech?: string): any {
  return { retry: true, note, tech, probedAt: Date.now() }
}

/**
 * 由「公共能力 + 目标路径写结论」组装该路径的生效能力视图（tier 在此判定）。
 * write 缺失 / retry 一律按可写处理（B 档保守：照常尝试写入 + 复查保护，
 * 绝不因探测故障跳过传输）；权限性拒绝才降到 C 档。
 */
function effectiveCaps(common: any, write: any): any {
  const writable = !(write && write.writable === false)
  const tier = !writable
    ? 'C'
    : common.conditional.ifMatch && common.conditional.ifNoneMatch && common.etag.present && !common.etag.weak
      ? 'A'
      : 'B'
  const notes = Array.isArray(common.notes) ? common.notes.slice() : []
  const eff: any = {
    probedAt: common.probedAt || 0,
    tier,
    writable,
    etag: { ...common.etag },
    conditional: { ...common.conditional },
    depthInfinity: !!common.depthInfinity,
    etagPropagation: !!common.etagPropagation,
    mtimePrecision: common.mtimePrecision || 'ms',
    collectionRedirect: !!common.collectionRedirect,
    notes,
  }
  if (common.commonProbed === false) eff.commonProbed = false
  if (write) {
    eff.writeProbedAt = write.probedAt
    if (write.writable === false && write.reason) {
      eff.writeReason = write.reason
      notes.push(write.reason)
      if (write.tech) notes.push(write.tech)
    } else if (write.retry && write.note) {
      eff.writeReason = write.note
      eff.writeRetrySoon = true
      notes.push(write.note)
      if (write.tech) notes.push(write.tech)
    }
  }
  return eff
}

/**
 * 执行一次能力探测（任一步失败降级收尾、绝不抛出）。
 * 探测在目标路径 pathKey（同步目录的远端根路径；'/' 为服务器基址）整体执行：
 *   确保根目录存在（PROPFIND 404 → mkdirDeep，与同步轮建根行为一致）
 *   →（需补公共字段时）基址无尾斜杠 PROPFIND 观测重定向 + 清理同前缀崩溃残留
 *   → MKCOL 探测目录 → PUT 探测文件（写权限按路径实测，失败按权限性 / 非权限性分类）
 *   →（仅无可信公共缓存时）PROPFIND/PUT/PROPFIND（etag 稳定性与 mtime 精度）
 *     → 过期 If-Match PUT（须 412）→ If-None-Match:* PUT（须 412）
 *     → Depth: infinity PROPFIND → DELETE 清理探测目录。
 * 探测全部写入目标路径下的专用子目录 `<root>/.wdsync-probe-<rand>/`（整体创建：
 * MKCOL 目录 → 内部写 probe.txt，不向根目录直接写任何探测文件；整体删除：结束时
 * DELETE 整个目录）。目录被扫描层排除（isSyncTempRel）；崩溃残留按
 * `.wdsync-probe-` 前缀 + 时龄 ≥ PROBE_RESIDUE_MIN_AGE_MS 双通道清理（见该常量
 * 注释：同步轮扫描后 + 探测启动时，清理所有设备的残留）。
 * @param cfg WebDAV 连接配置
 * @param pathKey 规范化远端根路径（'/' = 服务器基址）
 * @param cachedCommon 可信的公共能力缓存（origin+用户 粒度）；null = 需现场探测
 * @returns { common, write, commonProbed }：
 *   write = { writable, reason?, probedAt }（权限性结论，可缓存）| { retry, note, probedAt }
 *   （非权限性失败，当轮按 B 档保守处理、不落缓存）；
 *   commonProbed = 公共字段是否在本轮完整探测（写被拒时公共字段不可信）；
 *   返回 { fatal } 表示探测无法进行（网络级失败），调用方按 degraded 处理且不缓存。
 */
async function runCapabilityProbe(cfg: EngineCfg, pathKey: string, cachedCommon: any): Promise<any> {
  const needCommon = !cachedCommon
  const common =
    cachedCommon ||
    {
      probedAt: Date.now(),
      etag: { present: false, weak: false, stable: false },
      conditional: { ifMatch: false, ifNoneMatch: false },
      depthInfinity: false,
      etagPropagation: false,
      mtimePrecision: 'ms',
      collectionRedirect: false,
      notes: [],
    }
  const notes = common.notes
  let used = 0
  const req = (method: any, remotePath: any, opts: any = {}) => {
    // 软预算：超限后调用方步骤自行跳过，保证探测请求总量受控（~10 量级）
    if (used >= PROBE_MAX_REQUESTS) throw new Error('探测请求预算已用尽')
    used++
    return davRequest(cfg, method, remotePath, opts)
  }
  /** 提前收尾：写结论已定，公共字段本轮不可信（cachedCommon 存在时保持其可信标记） */
  const fail = (write: any) => {
    if (!cachedCommon) common.commonProbed = false
    return { common, write, commonProbed: false }
  }
  /** pathKey 对应 davRequest 的远端路径（'/' 基址 → ''） */
  const pathRel = pathKey === '/' ? '' : pathKey.replace(/^\/+/, '')

  let baseNoSlash = ''
  try {
    baseNoSlash = String((cfg && cfg.serverUrl) || '').replace(/\/+$/, '')
    new URL(baseNoSlash) // 仅验证可解析
  } catch (_) {
    return fail(retryWrite('服务器地址不正确', `服务器地址无效：${(cfg && cfg.serverUrl) || ''}`))
  }

  // 1. 确保目标根目录存在。mkdirDeep 失败按状态码分类：
  //    权限性拒绝 → C；其余（409 / 5xx / 网络错误）→ retry（B 档保守，不缓存）
  try {
    const r0 = await req('PROPFIND', pathRel, {
      isCollection: true,
      headers: { Depth: '0', 'Content-Type': 'application/xml' },
      body: PROBE_PROPFIND_BODY,
    })
    if (r0.status !== 207 && r0.status !== 200) {
      if (r0.status === 404) {
        try {
          await mkdirDeep(cfg, pathRel)
        } catch (e: any) {
          if (e && MKCOL_DENIED_STATUS.has(Number(e.status))) {
            return fail(deniedWrite('服务器不允许创建文件夹，请检查账号权限', `创建目录被拒（HTTP ${e.status}）`))
          }
          return fail(retryWrite('云端文件夹暂时不可用，稍后会自动重试', `根目录不存在且创建失败：${(e && e.message) || e}`))
        }
      } else if (r0.status === 401 || r0.status === 403) {
        return fail(deniedWrite('没有访问云端文件夹的权限，请检查账号权限', `目录不可访问（HTTP ${r0.status}）`))
      } else {
        return fail(retryWrite('云端文件夹暂时不可用，稍后会自动重试', `根目录 PROPFIND：HTTP ${r0.status}`))
      }
    }
  } catch (e: any) {
    return { fatal: '暂时无法检测服务器能力，稍后会自动重试', fatalTech: `根目录探测失败：${(e && e.message) || e}` }
  }

  // 2. 残留清理 +（仅基址）尾斜杠重定向观测。只在需要补公共字段时做：
  //    写探测不依赖目录清单，每轮同步前的按路径写探测不必重复列目录。
  if (needCommon) {
    let listEntries: any = null
    try {
      if (pathKey === '/') {
        const netOpts = resolveNetOpts(cfg)
        const r1 = await requestWithRetry(
          cfg,
          'PROPFIND',
          new URL(baseNoSlash),
          { headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: PROBE_PROPFIND_BODY },
          netOpts
        )
        if (REDIRECT_STATUS.has(r1.status) && r1.headers && r1.headers.location != null) {
          common.collectionRedirect = true
          // 重定向服务器：按规范尾斜杠形态重新列举一次取清单
          const r2 = await davRequest(cfg, 'PROPFIND', '', { isCollection: true, headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: PROBE_PROPFIND_BODY })
          if (r2.status === 207 || r2.status === 200) listEntries = parseMultistatus(r2.body ? r2.body.toString('utf-8') : '')
          else notes.push(`根目录 PROPFIND（重定向后）：HTTP ${r2.status}`)
        } else if (r1.status === 207 || r1.status === 200) {
          listEntries = parseMultistatus(r1.body ? r1.body.toString('utf-8') : '')
        } else {
          notes.push(`根目录 PROPFIND：HTTP ${r1.status}`)
        }
      } else {
        const r1 = await davRequest(cfg, 'PROPFIND', pathRel, { isCollection: true, headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: PROBE_PROPFIND_BODY })
        if (r1.status === 207 || r1.status === 200) listEntries = parseMultistatus(r1.body ? r1.body.toString('utf-8') : '')
        else notes.push(`目录 PROPFIND：HTTP ${r1.status}`)
      }
    } catch (e: any) {
      return { fatal: '暂时无法检测服务器能力，稍后会自动重试', fatalTech: `根目录探测失败：${(e && e.message) || e}` }
    }
    // 崩溃残留清理（通道之二；通道之一为 syncDirectory 扫描后清理，见 PROBE_RESIDUE_MIN_AGE_MS
    // 注释）：同前缀且时龄超阈值的目录 / 文件。前缀匹配不区分设备 —— 清理所有设备的
    // 残留；新近创建的可能是并发探测在用（含其他设备的活跃探测），由年龄门槛保护
    if (listEntries) {
      for (const item of listEntries) {
        const rel = relFromHref(cfg, pathRel, item.href)
        if (!rel) continue
        const name = String(rel).split('/').pop() || ''
        if (!name.startsWith(PROBE_PREFIX)) continue
        if (!item.mtime || Date.now() - item.mtime < PROBE_RESIDUE_MIN_AGE_MS) continue
        await davRequest(cfg, 'DELETE', joinRemote(pathRel, name)).catch(() => {})
      }
    }
  }

  // 3. 探测目录与写权限（MKCOL 405 = 已存在，视为可用）。
  //    探测文件放在探测目录的一层子目录里（<probe>/sub/probe.txt）——
  //    第 6 步的 Depth:infinity 探测据此直接验证「响应确实包含 ≥2 层后代」，
  //    对「返回 207 但把 infinity 当 Depth:1 应答」的服务器（真实存在）不会误判
  //    为支持递归列举（误判会让引擎的单请求扫描拿到残缺树 → 决策层把它解读成
  //    「远端已删除」→ 批量误删本地文件）。代价仅 +1 个 MKCOL。
  const dirName = `${PROBE_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const dirRel = joinRemote(pathRel, dirName)
  const nestedRel = joinRemote(dirRel, 'sub')
  const fileRel = joinRemote(nestedRel, 'probe.txt')
  let dirReady = false
  try {
    const mk = await req('MKCOL', dirRel)
    if (mk.status === 201 || mk.status === 405) dirReady = true
    else if (MKCOL_DENIED_STATUS.has(mk.status)) return fail(deniedWrite('服务器不允许创建文件夹，请检查账号权限', `创建目录被拒（HTTP ${mk.status}）`))
    else return fail(retryWrite('暂时无法确认服务器是否允许上传，稍后会自动重新检测', `创建探测目录：HTTP ${mk.status}`))
  } catch (e: any) {
    return fail(retryWrite('暂时无法确认服务器是否允许上传，稍后会自动重新检测', `创建探测目录失败：${(e && e.message) || e}`))
  }
  if (dirReady) {
    try {
      const mk2 = await req('MKCOL', nestedRel)
      if (mk2.status !== 201 && mk2.status !== 405) {
        if (MKCOL_DENIED_STATUS.has(mk2.status)) return fail(deniedWrite('服务器不允许创建文件夹，请检查账号权限', `创建目录被拒（HTTP ${mk2.status}）`))
        return fail(retryWrite('暂时无法确认服务器是否允许上传，稍后会自动重新检测', `创建探测子目录：HTTP ${mk2.status}`))
      }
    } catch (e: any) {
      return fail(retryWrite('暂时无法确认服务器是否允许上传，稍后会自动重新检测', `创建探测子目录失败：${(e && e.message) || e}`))
    }
  }

  // 4. 写探测文件：权限性拒绝（401/403/405/507）→ C 档 + 原因；
  //    其他失败（含 5xx）→ retry：当轮 B 档保守处理，不落缓存。
  //    不提前 return：探测目录已建，无论写探测成败都要走到第 7 步清理
  let write: any = null
  if (dirReady) {
    try {
      const p = await req('PUT', fileRel, { body: PROBE_BODY })
      if (p.status >= 200 && p.status < 300) write = { writable: true, probedAt: Date.now() }
      else if (PUT_DENIED_STATUS.has(p.status)) write = deniedWrite('服务器不允许上传文件，请检查账号权限', `写入被拒（HTTP ${p.status}）`)
      else write = retryWrite('暂时无法确认服务器是否允许上传，稍后会自动重新检测', `写入探测文件失败：HTTP ${p.status}`)
    } catch (e: any) {
      write = retryWrite('暂时无法确认服务器是否允许上传，稍后会自动重新检测', `写入探测文件失败：${(e && e.message) || e}`)
    }
  } else {
    write = retryWrite('暂时无法确认服务器是否允许上传，稍后会自动重新检测', '探测目录不可用')
  }
  const wrote = !!write && write.writable === true

  // 5. 公共能力字段（仅无可信缓存且本路径可写时；写被拒的轮次这些字段不可信，
  //    统一保持保守默认值，由 commonProbed=false 阻止其被当作可信缓存）
  if (wrote && needCommon) {
    const propsOnce = async () => {
      const r = await req('PROPFIND', fileRel, { headers: { Depth: '0', 'Content-Type': 'application/xml' }, body: PROBE_PROPFIND_BODY })
      if (r.status !== 207 || !r.body) return null
      const list = parseMultistatus(r.body.toString('utf-8'))
      return list[0] || null
    }
    let e1 = ''
    let lm1 = 0
    try {
      const p = await propsOnce()
      if (p) {
        e1 = p.etag
        lm1 = p.mtime
      } else notes.push('探测文件属性读取为空')
    } catch (e: any) {
      notes.push(`探测文件 PROPFIND 失败：${(e && e.message) || e}`)
    }
    let e2 = ''
    let lm2 = 0
    try {
      await req('PUT', fileRel, { body: PROBE_BODY }) // 同内容重传：观察 etag 跨 PUT 稳定性
      const p = await propsOnce()
      if (p) {
        e2 = p.etag
        lm2 = p.mtime
      }
    } catch (e: any) {
      notes.push(`探测文件二次写入/读取失败：${(e && e.message) || e}`)
    }
    common.etag.present = !!normEtag(e1)
    common.etag.weak = isWeakEtag(e1)
    common.etag.stable = common.etag.present && !!normEtag(e2) && normEtag(e1) === normEtag(e2)
    // mtime 精度：两次观测都落在整秒 → 秒级（服务端把 getlastmodified 捨到整秒），
    // 否则毫秒级。比「与本机时钟差」更稳：不受服务器时钟偏移影响。
    const wholeSec = (t: any) => t > 0 && t % 1000 === 0
    common.mtimePrecision = wholeSec(lm1) && wholeSec(lm2) ? 's' : 'ms'
    // 条件请求必须实测：静默忽略条件头的服务器很常见。
    // 过期 If-Match PUT 应得 412；对已存在文件 If-None-Match:* PUT 应得 412；
    // 两者都被遵守才判 conditional 可用。被忽略（2xx 照常写入）→ false。
    try {
      const c1 = await req('PUT', fileRel, { body: PROBE_BODY, headers: { 'If-Match': '"wdsync-probe-stale"' } })
      common.conditional.ifMatch = c1.status === 412
      if (c1.status !== 412 && (c1.status < 200 || c1.status >= 300)) notes.push(`If-Match 探测：HTTP ${c1.status}`)
    } catch (e: any) {
      notes.push(`If-Match 探测失败：${(e && e.message) || e}`)
    }
    try {
      const c2 = await req('PUT', fileRel, { body: PROBE_BODY, headers: { 'If-None-Match': '*' } })
      common.conditional.ifNoneMatch = c2.status === 412
      if (c2.status !== 412 && (c2.status < 200 || c2.status >= 300)) notes.push(`If-None-Match 探测：HTTP ${c2.status}`)
    } catch (e: any) {
      notes.push(`If-None-Match 探测失败：${(e && e.message) || e}`)
    }
  }

  // 5.5 集合 etag 深层传播。逐目录扫描按「子集合 etag 未变」跳过其
  //     PROPFIND 的正确性前提是：任意深度后代的变更都会反映到所有祖先集合的 etag ——
  //     只要存在一层不传播，跳过就会漏检深层变更。探测布局只有两层（探测目录/sub/probe.txt），
  //     因此只能实测到「文件→父集合」与「父集合→祖先集合」两级，两级都传播才判 true
  //     （保守：观测不到 = 不支持）。写入内容必须变化（PROBE_BODY + '-prop'）：mtime 型
  //     etag 服务器对同内容重传也视为写入，但内容变化对内容哈希型（dedup）服务器同样
  //     成立，两种 etag 实现都覆盖。请求预算：本步 4 个 PROPFIND + 1 个 PUT，全序列
  //     恰好 16 个 = PROBE_MAX_REQUESTS（第 2 步的根列举走 davRequest 不计软预算），
  //     仍在上限内；预算耗尽会抛错，被下方 try/catch 吞成 notes（etagPropagation 保持 false）。
  if (wrote && needCommon && common.etag.present) {
    try {
      /**
       * 对 listDir 发 Depth:1 PROPFIND，取名为 childName 的直接子条目的 etag。
       * 为什么不 Depth:0 直取子集合：观察的是「父集合的列表应答里，子集合条目的
       * etag 是否随深层写入变化」—— 引擎逐目录扫描读的正是父列表里的子条目 etag，
       * 探测口径必须与使用口径一致。非 207 / 找不到条目 / 无 etag 一律返回 ''（判 false）。
       */
      const etagOf = async (listDir: string, childName: string): Promise<string> => {
        const r = await req('PROPFIND', listDir, { isCollection: true, headers: { Depth: '1', 'Content-Type': 'application/xml' }, body: PROBE_PROPFIND_BODY })
        if (r.status !== 207 || !r.body) return ''
        for (const item of parseMultistatus(r.body.toString('utf-8'))) {
          if (relFromHref(cfg, listDir, item.href).replace(/\/+$/, '') === childName) return String(item.etag || '')
        }
        return ''
      }
      const subBefore = await etagOf(dirRel, 'sub')
      const topBefore = await etagOf(pathRel, dirName)
      await req('PUT', fileRel, { body: `${PROBE_BODY}-prop` }) // 内容必须变：两种 etag 实现都必然视为写入
      const subAfter = await etagOf(dirRel, 'sub')
      const topAfter = await etagOf(pathRel, dirName)
      // 一层：文件→父集合（sub）；两层：→祖先集合（探测目录的父 = 目标根）。二者都
      // 要求「有 etag 可观测 且 前后不同」—— 任一空串（集合无 etag 的默认服务器形态）
      // 直接判不传播
      const oneLevel = !!(subBefore && subAfter && subBefore !== subAfter)
      const twoLevel = !!(topBefore && topAfter && topBefore !== topAfter)
      common.etagPropagation = oneLevel && twoLevel
      if (!common.etagPropagation) notes.push('集合 etag 不随深层修改传播（或无法观测）：逐目录扫描不跳过子集合')
    } catch (e: any) {
      // 整段失败只记 notes，etagPropagation 保持 false（保守：能力探测绝不让单步故障连坐轮次）
      notes.push(`集合 etag 传播探测失败：${(e && e.message) || e}`)
    }
  }

  // 6. Depth: infinity（只读探测；只对探测目录发起，避免对真实大目录递归列举；
  //    仅在本路径可写且需补公共字段时有意义 —— commonProbed=false 的轮次该值不可信）。
  //    硬化：状态码 207/200 只是必要条件，响应里必须实际出现 ≥2 层的后代
  //    条目（sub/probe.txt）才判支持 —— 探测文件已特意放进一层子目录，「207 但只
  //    回第一层」的服务器在此直接露馅（按不支持处理，扫描走逐目录模式）
  if (dirReady && wrote && needCommon) {
    try {
      const d = await req('PROPFIND', dirRel, { isCollection: true, headers: { Depth: 'infinity', 'Content-Type': 'application/xml' }, body: PROBE_PROPFIND_BODY })
      let nested = false
      if (d.status === 207 || d.status === 200) {
        try {
          for (const item of parseMultistatus(d.body ? d.body.toString('utf-8') : '')) {
            if (relFromHref(cfg, dirRel, item.href).includes('/')) {
              nested = true
              break
            }
          }
        } catch (_) {
          nested = false // 响应畸形：按不支持处理（保守，扫描层有逐目录回落兜底）
        }
      } else {
        notes.push(`Depth: infinity：HTTP ${d.status}`)
      }
      common.depthInfinity = nested
      if (!nested && (d.status === 207 || d.status === 200)) notes.push('Depth: infinity 响应未包含嵌套条目，按不支持处理')
    } catch (e: any) {
      notes.push(`Depth: infinity 探测失败：${(e && e.message) || e}`)
    }
  }

  // 7. 清理探测目录（只要建了就删，写探测失败也不例外；失败仅记录，下轮再清）
  if (dirReady) {
    try {
      const del = await req('DELETE', dirRel)
      if (del.status >= 400) notes.push(`清理探测目录：HTTP ${del.status}`)
    } catch (e: any) {
      notes.push(`清理探测目录失败：${(e && e.message) || e}`)
    }
  }

  if (!cachedCommon) common.commonProbed = wrote
  return { common, write, commonProbed: needCommon && wrote }
}

/**
 * 探测 / 读取服务器能力（对外入口）。
 * @param cfg 连接配置
 * @param force true 时忽略缓存强制重探（设置页「重新探测」入口）
 * @param remotePath 远端根路径（按路径判定写权限）；缺省为服务器基址（UI / 连接测试场景）
 * @returns 目标路径的生效能力视图（含 tier / writable / writeReason）；探测无法进行时
 *          返回 degraded 结果（不抛出、不落缓存）
 */
async function probeCapabilities(cfg: EngineCfg, force?: boolean, remotePath?: string): Promise<DavCapabilities> {
  const pathKey = storage.normalizeRemoteKey(remotePath || '/')
  let state: any = null
  try {
    state = await storage.openServerState(originOf(cfg), (cfg && cfg.username) || '')
  } catch (e: any) {
    return degradedCaps('暂时无法检测服务器能力，稍后会自动重试', `能力缓存存储不可用：${(e && e.message) || e}`)
  }
  const cached = (!force && state.getCachedCapabilities(PROBE_TTL_MS)) || null
  const writePaths = { ...((cached && cached.writePaths) || {}) }
  // 公共字段仅信「完整探测过」的缓存；写结论仅信权限性结论（retry 型从不落缓存）。
  // etagPropagation 必须存在：本版本新增字段，旧版缓存（本特性引入前落盘）缺它 → 视为
  // 缓存缺失强制补一次公共重探 —— 一次性迁移成本，避免新结论要等 7 天 TTL 自然过期才出现
  let common = cached && cached.commonProbed !== false && typeof cached.etagPropagation === 'boolean' ? cached : null
  let write = cached && writePaths[pathKey] && typeof writePaths[pathKey].writable === 'boolean' ? writePaths[pathKey] : null
  let probed = false
  if (!common || !write) {
    probed = true
    const r = await runCapabilityProbe(cfg, pathKey, common)
    if (r.fatal) return degradedCaps(r.fatal, r.fatalTech)
    common = r.common
    write = r.write
  }
  const eff = effectiveCaps(common, write)
  if (probed && !eff.degraded) {
    if (write && typeof write.writable === 'boolean') writePaths[pathKey] = write
    // common 整体落盘（含 commonProbed 标记）：写被拒轮次的 best-effort 公共字段
    // 全部取保守值（false / 秒级），缓存它安全；commonProbed=false 阻止其被当作可信
    const commonToSave = common === cached ? cached : { ...common }
    commonToSave.writePaths = writePaths
    await state.saveCapabilities(commonToSave).catch((e: any) => eff.notes.push(`能力缓存写入失败：${(e && e.message) || e}`))
  }
  return eff
}

/**
 * 同步轮内部取能力：缓存优先，缺失 / 过期才现场探测（请求计入轮次开销但不计入传输进度）。
 * 写权限按同步目录的远端根路径判定：同一服务器下不同子树可各自落 A/B/C 档。
 */
async function getSyncCapabilities(cfg: EngineCfg, remotePath?: string): Promise<DavCapabilities> {
  try {
    return await probeCapabilities(cfg, false, remotePath)
  } catch (e: any) {
    return degradedCaps('暂时无法检测服务器能力，稍后会自动重试', `能力探测异常：${(e && e.message) || e}`)
  }
}

/**
 * 打开本配置对应的服务器噪声存储（fingerprint-unstable，按 origin+username 粒度）。
 * 存储层异常时返回空实现：噪声标记只是优化（跳过不必要的下载比对），不得因它阻断同步。
 */
async function openServerNoiseSafe(cfg: EngineCfg): Promise<any> {
  try {
    return await storage.openServerState(originOf(cfg), (cfg && cfg.username) || '')
  } catch (_) {
    return {
      // 与 ServerStateStore 同形的内存空实现：B 档提醒标记只进内存（每进程至多一次），
      // saveNoise 为 no-op —— 存储层异常时降级，不阻断同步
      noise: { fingerprintUnstable: false, noiseFiles: {}, concurrencyWarned: false },
      fingerprintUnstable: false,
      noteFingerprintNoise: () => false,
      resetFingerprintNoise: () => false,
      saveNoise: async () => {},
    }
  }
}

// ---------- fsx：本地文件系统 ----------

/** 判定相对路径中任一段是否为隐藏文件（点前缀；系统垃圾另行见 isJunkRel，两者独立判定） */
function isHiddenRel(rel: string): boolean {
  return String(rel)
    .split('/')
    .some((seg) => seg.startsWith('.'))
}

// ---------- 跨平台默认排除 ----------
//
// 两层排除，均在扫描层生效（本地 scanDirSafe 与远端 listRemoteSafe 同规则），
// 决策层（decideAction）永远看不到被排除的条目：
//   1. 内置垃圾规则 isJunkRel —— 与 ignoreHidden 无关、用户不可关闭：这些是
//      OS / Office 的本机临时产物，不是用户业务文件；跨平台同步它们只会制造
//      垃圾传播、大小写冲突噪声与空目录清理误判（README 已知边界如实列出）；
//   2. 用户规则 compileExcludePatterns —— prefs.excludePatterns（glob，逐行），
//      默认空。模式含 '/' 时按完整 rel 匹配（可排除子树），否则对每一段名匹配。
//      仅支持 * 与 ?（* 不跨越 '/'），其余字符按字面；条数与长度设上限防误配。

/** 内置垃圾文件精确名（小写比较）：macOS Finder / Windows 资源管理器 / Office 的本机产物 */
const JUNK_EXACT = new Set([
  '.ds_store', // macOS Finder 目录元数据
  '.spotlight-v100', // macOS 索引卷标（外置盘根常见）
  '.trashes', // macOS 废纸篓卷目录
  'thumbs.db', // Windows 缩略图缓存
  'ehthumbs.db', // Windows 媒体缩略图缓存
  'desktop.ini', // Windows 文件夹定制配置（本机视角设置，跨机无意义）
])
/** 内置垃圾文件前缀：._*（AppleDouble，macOS 在非 HFS 卷 / SMB 上的资源分叉）与 ~$*（Office 所有者锁临时文件） */
const JUNK_PREFIXES = ['._', '~$']

/**
 * 判定相对路径是否命中内置垃圾规则（与 ignoreHidden 取值无关，任何一段命中即排除）。
 * 纯函数；本地与远端扫描共用同一份名单。
 */
function isJunkRel(rel: string): boolean {
  return String(rel)
    .split('/')
    .some((seg) => {
      const low = seg.toLowerCase()
      return JUNK_EXACT.has(low) || JUNK_PREFIXES.some((p) => low.startsWith(p))
    })
}

/** 用户排除规则的数量与单条长度上限：防误配置把规则表变成正则炸弹 */
const EXCLUDE_PATTERN_MAX = 200
const EXCLUDE_PATTERN_LEN_MAX = 200

/**
 * 把一条 glob 编译为 RegExp（仅 * 与 ? 有特殊含义；* 不跨越 '/'）。
 * 无效输入（空 / 超长）返回 null，调用方跳过该条。
 */
function compileGlobPattern(pat: string): any {
  const p = String(pat == null ? '' : pat).trim()
  if (!p || p.length > EXCLUDE_PATTERN_LEN_MAX) return null
  let re = '^'
  for (const ch of p) {
    if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  try {
    return new RegExp(re + '$')
  } catch (_) {
    return null
  }
}

/**
 * 编译用户排除规则为一个匹配函数（纯函数，输入 patterns 数组）。
 * 返回 null 表示「无有效规则」（调用方零开销直通）。规则含 '/' → 匹配完整 rel；
 * 否则 → 对 rel 的每一段名匹配（与 isHiddenRel / isJunkRel 同粒度）。
 * @param {string[]} patterns glob 规则数组
 * @returns {((rel: string) => boolean) | null}
 */
function compileExcludePatterns(patterns: string[] | null | undefined): ((rel: string) => boolean) | null {
  if (!Array.isArray(patterns) || patterns.length === 0) return null
  const full: any[] = []
  const seg: any[] = []
  for (const pat of patterns.slice(0, EXCLUDE_PATTERN_MAX)) {
    const re = compileGlobPattern(pat)
    if (!re) continue
    ;(String(pat).includes('/') ? full : seg).push(re)
  }
  if (full.length === 0 && seg.length === 0) return null
  return (rel) => {
    const s = String(rel || '')
    if (full.some((re) => re.test(s))) return true
    return seg.some((re) => s.split('/').some((name) => re.test(name)))
  }
}

/**
 * 判定文件名是否为同步引擎自身产生的临时文件（下载临时 / 消歧临时下载 / 日志临时写入）。
 * 临时文件一律不允许进入同步候选集合：扫描层在 ignoreHidden 判定之前先做本检查，
 * 因此 ignoreHidden=false 时同样被排除 —— 临时文件不是用户业务文件。
 * 命名空间（.wdsync-dl- / .wdsync-verify- / .wdsync-tmp-）由引擎独占使用。
 */
function isSyncTempName(name: string): boolean {
  return SYNC_TMP_PREFIXES.some((p) => String(name).startsWith(p))
}

/** 同 isSyncTempName，但作用于相对路径的任意一段（子目录中的残留同样排除） */
function isSyncTempRel(rel: string): boolean {
  return String(rel)
    .split('/')
    .some(isSyncTempName)
}

/**
 * 同步启动期清理上一轮崩溃残留的临时文件（仅同步根目录第一层 —— 引擎只在这里产生临时文件）。
 * 三重安全边界，避免误删：
 *   1. 名字严格命中引擎临时前缀且是普通文件；
 *   2. 不在本进程在用集合（LIVE_TEMPS）中 —— 并发同步 / 活跃下载正在写入的文件不受影响；
 *   3. mtime 距今超过 ORPHAN_TEMP_MIN_AGE_MS —— 活跃写入的临时文件必然年轻，
 *      只有进程崩溃残留才会陈旧。
 * 单个文件删除失败静默跳过（下一轮重试）；清理环节任何异常都不阻断同步。
 */
async function cleanupOrphanTemps(localPath: string): Promise<void> {
  let names
  try {
    names = await fsp.readdir(localPath)
  } catch (_) {
    return // 目录尚不存在（首轮同步）：无残留可清
  }
  const cutoff = Date.now() - ORPHAN_TEMP_MIN_AGE_MS
  for (const name of names) {
    if (!isSyncTempName(name)) continue
    const abs = path.join(localPath, name)
    if (LIVE_TEMPS.has(abs)) continue
    const st = await statOrNull(abs)
    if (!st || !st.isFile()) continue
    if (st.mtimeMs > cutoff) continue
    await fsp.unlink(abs).catch(() => {})
  }
}

/**
 * 递归扫描本地目录。
 * 返回 { files: Map(rel -> {abs, size, mtimeMs}), complete: boolean, errors: [{rel, message}] }。
 *
 * 完整性语义（同步安全的核心）：
 *   complete === true  → 目录树全部枚举成功，"files 中没有 rel" 可以确证「文件不存在」
 *   complete === false → 至少有一处 readdir / stat 失败，此时缺失 entry 只代表「无法确认」，
 *                        绝不能被同步决策解释为删除（见 syncDirectory 的前置闸门）。
 * 排除次序（与远端 listRemoteSafe 同规则）：同步系统文件 / 引擎临时文件 → 内置垃圾
 *（isJunkRel）→ 用户排除规则（excludeMatcher）→ ignoreHidden 的隐藏文件。垃圾与
 * 用户规则与 ignoreHidden 无关；隐藏文件在 ignoreHidden 时属于刻意排除的范围，
 * 不算扫描错误。
 * @param excludeMatcher compileExcludePatterns 的产物（用户排除规则；null = 无规则直通）
 * @param onFilesSeen 可选扫描进度回调：(已见文件数) => void；内部按 SCAN_PROGRESS_MS
 *        节流 + 结束时强制末报一次（最终计数必然送达）。数万文件的扫描以百毫秒级
 *        粒度外发进度，渲染层不再面对「黑盒扫描数十秒」（runSyncRound 映射为
 *        phase='scan' 的进度事件；不传 = 零开销直通，既有直调调用方不受影响）
 */
async function scanDirSafe(localPath: string, ignoreHidden: boolean, excludeMatcher: ((rel: string) => boolean) | null = null, onFilesSeen: ((n: number) => void) | null = null): Promise<any> {
  const root = path.resolve(localPath)
  const files = new Map()
  const errors: any[] = []
  let complete = true
  let seen = 0
  let lastNoteAt = 0
  const noteSeen = (force = false) => {
    if (!onFilesSeen) return
    const t = Date.now()
    if (!force && t - lastNoteAt < SCAN_PROGRESS_MS) return
    lastNoteAt = t
    try {
      onFilesSeen(seen)
    } catch (_) {
      /* 进度回调异常不得影响扫描 */
    }
  }
  async function walk(dir: any, prefix: any) {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (e: any) {
      complete = false
      errors.push({ rel: prefix || '.', message: (e && e.code) || (e && e.message) || String(e) })
      return
    }
    for (const ent of entries) {
      await maybeYield() // 扫描批间分片让出（大目录紧凑循环不饿调度器心跳）
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name
      // 同步系统自身文件与引擎临时文件在 ignoreHidden 判定之前排除：
      // ignoreHidden=false 时同样不允许进入同步候选集合；内置垃圾与用户规则同先
      if (SYNC_SKIP_NAMES.has(rel)) continue
      if (isSyncTempRel(rel)) continue
      if (isJunkRel(rel)) continue
      if (excludeMatcher && excludeMatcher(rel)) continue
      if (ignoreHidden && isHiddenRel(rel)) continue
      const abs = path.join(dir, ent.name)
      if (ent.isSymbolicLink()) continue
      if (ent.isDirectory()) {
        await walk(abs, rel)
      } else if (ent.isFile()) {
        let st
        try {
          st = await fsp.stat(abs)
        } catch (e: any) {
          // stat 失败 = 无法确认该文件状态（可能是瞬时 IO / 权限问题），标记不完整
          complete = false
          errors.push({ rel, message: (e && e.code) || (e && e.message) || String(e) })
          continue
        }
        files.set(rel, { abs, size: st.size, mtimeMs: st.mtimeMs })
        seen++
        noteSeen()
      }
    }
  }
  await walk(root, '')
  noteSeen(true)
  return { files, complete, errors }
}

/**
 * 本地脏路径快速核对（watch 轮专用，替代 scanDirSafe 的全量 walk）。
 * 形态：以本机基线合成「上一轮一致时的本地表」，再逐条核对 watcher 上报的脏路径：
 *   - 不存在 / 符号链接（lstat 不跟链接，与 walk 的 isSymbolicLink 跳过语义对齐，
 *     符号链接视同不存在）→ 删除该键；目录删除事件只报目录名，故同时清扫全部
 *     `p + '/'` 前缀的键（子树整体消失）；
 *   - 普通文件 → 用实测 stat 覆盖合成值（修改与新增同形态 —— 基线外的新文件、
 *     rename 新名事件由此进入表）；
 *   - 目录 → 本地表本无目录条目，仅当表里恰有同名文件条目（文件变目录的反常
 *     形态）时删除；其余（fifo / socket 等非普通文件）按 walk 的忽略语义删除。
 * 脏路径先过与 walk 同序的排除链（同步系统文件 / 引擎临时 / 内置垃圾 / 用户排除 /
 * ignoreHidden）：被排除的名字本就不该在表里，跳过核对安全。
 * complete=true 的依据是**约定**而非实测：「基线 + 已核对的脏路径」构成对本地状态
 * 的完整视图 —— 漏掉未上报的 watch 事件是已知界内滞后（watch 事件不保证完整），
 * 由 interval / startup / manual / follow-up 轮的周期性全量扫描兜底对账；脏集只是
 * 加速手段，不是正确性来源。调用侧以 store.loadedOk 与
 * DIRTY_SCAN_MAX 把关：基线不可信或脏集过大时不会走到这里。
 * @param localPath 本地同步根
 * @param dirtyPaths watcher 上报的脏路径（NFC、'/' 分隔 rel；可含目录名）
 * @param store 本轮已打开的基线存储（entries 为 NFC 键；loadedOk 已由调用侧确认）
 * @param ignoreHidden 是否忽略隐藏文件（与全量扫描同口径）
 * @param excludeMatcher 用户排除规则（null = 无规则直通）
 * @param onFilesSeen 进度回调：核对完成后强制报告一次最终计数（终态送达与
 *        scanDirSafe 的末次强制报告同契约）
 */
async function scanDirtyFast(
  localPath: string,
  dirtyPaths: string[],
  store: any,
  ignoreHidden: boolean,
  excludeMatcher: ((rel: string) => boolean) | null,
  onFilesSeen: ((n: number) => void) | null
): Promise<any> {
  const root = path.resolve(localPath)
  const files = new Map()
  // 1. 按基线合成：上一轮一致时的本地表（本地侧指纹 lsize/lmtimeMs 即当时实测值）
  for (const [k, m] of store.entries) {
    await maybeYield() // 数万基线条目的合成循环分片让出（与既有条目循环同规格）
    files.set(k, { abs: path.join(root, ...k.split('/')), size: m.lsize, mtimeMs: m.lmtimeMs })
  }
  // 2. 核对脏路径：合成值只在该路径被上报时才被实测覆盖 / 清除
  for (const p of dirtyPaths) {
    await maybeYield()
    const rel = nfc(String(p))
    if (SYNC_SKIP_NAMES.has(rel)) continue
    if (isSyncTempRel(rel)) continue
    if (isJunkRel(rel)) continue
    if (excludeMatcher && excludeMatcher(rel)) continue
    if (ignoreHidden && isHiddenRel(rel)) continue
    let st: any = null
    try {
      st = await fsp.lstat(path.join(root, ...rel.split('/')))
    } catch (_) {
      st = null // 不存在 / 不可访问（ENOENT 等）：按「已不存在」处理
    }
    if (st && st.isSymbolicLink()) st = null
    if (!st) {
      files.delete(rel)
      // 目录删除只报目录名：清扫该前缀下全部子树键（Map 迭代中删除当前键是安全的）
      const prefix = rel + '/'
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) files.delete(k)
      }
    } else if (st.isFile()) {
      files.set(rel, { abs: path.join(root, ...rel.split('/')), size: st.size, mtimeMs: st.mtimeMs })
    } else {
      // 目录（表里同名文件条目属「文件变目录」反常形态）与 fifo / socket 等
      // 非普通文件：walk 均不入表，这里同样不入
      files.delete(rel)
    }
  }
  if (onFilesSeen) {
    try {
      onFilesSeen(files.size)
    } catch (_) {
      /* 进度回调异常不得影响扫描 */
    }
  }
  return { files, complete: true, errors: [] }
}

/** 兼容旧 API：仅需要文件表（Map）的调用方使用；扫描不完整时抛出，避免把残缺列表当全量 */
async function scanDir(localPath: string, ignoreHidden: boolean): Promise<Map<string, LocalStat>> {
  const scan = await scanDirSafe(localPath, ignoreHidden)
  if (!scan.complete) {
    const e: any = new Error(`读取电脑文件夹「${scan.errors[0].rel}」时出错，为避免误删文件，本次同步已停止`)
    e.detail = scan.errors[0].message
    e.scanErrors = scan.errors
    throw e
  }
  return scan.files
}

/**
 * 本地同步根健康检查（轮首、任何扫描与远端请求之前执行）。
 * 三类异常一律抛错中止整轮（零删除、零传输）：
 *   1. 根目录不存在 / 不是目录（ENOTDIR）—— 配置指向的路径已消失；
 *   2. 不可读（EACCES 等）—— 权限丢失，扫描必然不完整；
 *   3. 疑似未挂载 / 被清空 —— 目录存在且可读但**零条目**，而本机基线非空。
 *      典型场景：外置盘 / 网络盘掉线后挂载点残留为一个空目录（macOS 常见），
 *      或同步根被整体误删。此时若照常扫描，全部基线文件会按「本地已删除」
 *      规划成批量 delete-remote —— 该启发式在扫描前把整轮掐断。
 *      代价：用户真的删光了本地全部文件时也会中止（换由批量删除确认通道 /
 *      检查目录配置解决），保守取向：宁可中止也不批量误删。
 * baselineCount 为本机基线条目数（0 时不做空目录判定 —— 空目录 + 空基线是合法首轮）。
 * @throws {Error} message 含明确原因；调用方按 phase='scan' 的同步失败收场
 */
async function checkLocalRootHealth(localPath: string, baselineCount: number): Promise<any> {
  const root = path.resolve(localPath)
  let st: any = null
  try {
    st = await fsp.stat(root)
  } catch (e: any) {
    const err: any = new Error('无法访问电脑上的同步文件夹，本次同步已停止，没有改动任何文件')
    err.detail = `${(e && e.code) || (e && e.message) || e}`
    err.phase = 'scan'
    err.failureClass = 'other'
    throw err
  }
  if (!st.isDirectory()) {
    const err: any = new Error('同步位置不是文件夹，请重新选择')
    err.phase = 'scan'
    err.failureClass = 'other'
    throw err
  }
  let entries
  try {
    entries = await fsp.readdir(root)
  } catch (e: any) {
    const err: any = new Error('无法访问电脑上的同步文件夹，本次同步已停止，没有改动任何文件')
    err.detail = `${(e && e.code) || (e && e.message) || e}`
    err.phase = 'scan'
    err.failureClass = 'other'
    throw err
  }
  if (entries.length === 0 && baselineCount > 0) {
    const err: any = new Error(
      `电脑上的同步文件夹现在是空的，但之前已同步过 ${baselineCount} 个文件。可能是移动硬盘或网络盘没连接，也可能文件夹被清空了。为避免误删，本次已停止；如果确实应该为空，请到同步设置里检查路径`
    )
    err.phase = 'scan'
    err.failureClass = 'other'
    throw err
  }
}

/**
 * 注册目录监听（1.5s 去抖），返回是否成功。
 * 引擎自身临时文件（.wdsync-dl- 下载 / .wdsync-tmp- 容差探测 / .wdsync-verify- 消歧
 * 下载 / .wdsync-probe- 能力探测）与同步系统残留（旧 manifest）不触发回调：
 * 同步轮自身会向同步目录写这些文件，若不过滤，「下载 → watcher 触发 → 再排一轮
 * 空同步」会放大轮次（自触发回路；空轮不再产生新临时文件，因此不会无限循环，
 * 但每轮有传输的同步都会白跑一轮）。filename 为 null 的平台事件无法判定归属，
 * 按用户变化处理（宁可多跑一轮，不可漏报用户修改）。
 * macOS（实测，darwin 24 / Node 22）：根目录条目增删时 FSEvents 会额外发出
 * 「被监听目录自身」的 change 事件（filename = 目录名，无路径前缀）。该自事件
 * 总伴随目标条目自身的具名事件出现（根级创建/覆盖/删除均另有带文件名的 rename，
 * 子目录内写入则只有具名事件），过滤它不会漏报用户修改；不过滤则引擎在根目录
 * 写临时文件（.wdsync-dl-* 等）必触发 watcher，防自触发回路在 macOS 上失效。
 * 窄洞：用户文件恰与监听目录同名且以 change 事件上报时被一并过滤（Windows 内容
 * 修改才报 change；该文件由 interval 轮兜底，不丢数据）。
 */

/**
 * watcher 事件过滤判定（watchDir 回调的过滤器，纯函数）。
 * 忽略两类事件：① 引擎 / 同步系统临时文件（独占前缀与残留名，路径任一段命中即过滤）；
 * ② macOS 目录自事件（evt='change' 且 filename 恰等于被监听目录名，见 watchDir 注释）。
 * filename 为 null 的平台事件无法判定归属，不过滤（按用户变化处理，宁可多跑一轮）。
 * 已知窄洞（与 watchDir 同口径）：用户文件恰与被监听目录**同名**且以 change 上报
 * （Windows 内容修改形态；macOS 实测 darwin 24 / Node 22 用户文件的创建 / 覆盖 /
 * 原地改写一律 rename 具名事件，change 仅为目录自事件，构不成窄洞）会被 ② 一并
 * 忽略 —— 该文件的修改丢失 watch 触发，由 interval 定时轮兜底同步。
 * @param selfName 被监听目录的 basename（localPath 去尾分隔符）
 * @param evt fs.watch 事件类型（'rename' | 'change'）
 * @param filename fs.watch 回调的 filename（可能为 null，可能含路径分隔符）
 * @returns {boolean} true = 忽略该事件（不触发去抖回调）
 */
function ignoredWatchEvent(selfName: string, evt: string, filename: string | null): boolean {
  if (filename == null) return false
  const name = String(filename)
  if (evt === 'change' && name === selfName) return true
  const segs = name.split(/[\\/]/)
  return segs.some((s) => isSyncTempName(s)) || SYNC_SKIP_NAMES.has(segs[segs.length - 1])
}

function watchDir(id: string, localPath: string, onChange: () => void): boolean {
  try {
    stopWatch(id)
    const selfName = path.basename(String(localPath).replace(/[\\/]+$/, ''))
    const watcher = fs.watch(localPath, { recursive: true }, (_evt, filename) => {
      if (ignoredWatchEvent(selfName, _evt, filename)) return
      const rec = WATCHERS.get(id)
      if (!rec) return
      // 脏路径即时登记（过滤之后、去抖之外）：去抖窗口内合并的多个事件各自的
      // 路径都进集合，等待中的轮次才能逐路径核对而不是退回全量扫描。归一与
      // 扫描键同构：'/' 分隔（Windows 平台事件携带 '\'）+ NFC。filename 为 null
      // 的平台事件无路径可登记（集合空 → 该轮自然回落全量扫描，语义安全）。
      if (filename != null) rec.dirty.add(nfc(String(filename).split('\\').join('/')))
      nodeTimers.clearTimeout(rec.timer)
      rec.timer = nodeTimers.setTimeout(() => {
        try {
          onChange()
        } catch (_) {
          /* 回调异常不外抛 */
        }
      }, 1500)
    })
    WATCHERS.set(id, { watcher, timer: null, dirty: new Set() })
    return true
  } catch (_) {
    return false
  }
}

/**
 * 读取 watcher 当前累积的脏路径集快照（不清理）。
 * 使用时序：调度器在每个 watch 轮组装 handlers 时调用，把快照经 hints.dirtyPaths
 * 交给引擎；引擎在**本地扫描成功后**才对同一 watcher 调 clearDirtyPaths 消费 ——
 * 扫描失败 / 中止的轮次不清，集合留给下一轮。路径为 NFC、'/' 分隔的 rel，
 * 与本地扫描表的键同构；可能包含目录名（目录删除事件只报目录名，见 scanDirtyFast）。
 * @param id 注册 watcher 时使用的同一 id（调度器形态 `${instanceId}:${dirId}`）
 * @returns {string[] | null} 拷贝数组；该 id 无 watcher 记录（未注册 / 已停止）时 null
 */
function peekDirtyPaths(id: string): string[] | null {
  const rec = WATCHERS.get(id)
  if (!rec) return null
  return Array.from(rec.dirty)
}

/**
 * 从 watcher 的脏路径集中移除恰好这些路径（已核对消费语义）。
 * 只应由引擎在「本轮已用这些路径完成本地扫描」之后调用：本轮核对过的路径清除，
 * 扫描期间新到的事件路径不在参数里、留在集合中给下一轮（不丢触发）。多余路径
 *（集合中不存在）静默忽略；无该 watcher 记录时为 no-op。
 * @param id 注册 watcher 时使用的同一 id
 * @param paths peekDirtyPaths 快照中已完成核对的路径子集
 */
function clearDirtyPaths(id: string, paths: string[]): void {
  const rec = WATCHERS.get(id)
  if (!rec || !Array.isArray(paths)) return
  for (const p of paths) rec.dirty.delete(p)
}

/**
 * 停止指定目录监听。整条记录（含脏路径集）随之删除：watcher 已停、不再有新事件，
 * 该目录的下一轮自然回落全量本地扫描，脏集不清理也不影响正确性。
 */
function stopWatch(id: string): void {
  const rec = WATCHERS.get(id)
  if (!rec) return
  nodeTimers.clearTimeout(rec.timer)
  try {
    rec.watcher.close()
  } catch (_) {
    /* 忽略 */
  }
  WATCHERS.delete(id)
}

/** 停止全部监听（插件退出时调用） */
function stopAllWatch(): void {
  for (const id of Array.from(WATCHERS.keys())) stopWatch(id)
}

// ---------- sync：双向同步引擎 ----------

/** 拼接远端子路径 */
function joinRemote(base: string, name: string): string {
  return `${String(base).replace(/\/+$/, '')}/${name}`
}

// ---------- 同步状态机辅助 ----------

/** stat 一个本地路径，不存在 / 不可访问时返回 null（调用方必须把 null 当「无法确认」处理） */
async function statOrNull(abs: string): Promise<nodeFs.Stats | null> {
  try {
    return await fsp.stat(abs)
  } catch (_) {
    return null
  }
}

/** 流式计算本地文件 sha256（hex）。用于本地变化消歧与 WAL 恢复采纳 */
async function hashFile(abs: string): Promise<string> {
  const h = crypto.createHash('sha256')
  const rs = fs.createReadStream(abs)
  try {
    for await (const chunk of rs) h.update(chunk)
  } catch (e: any) {
    rs.destroy()
    throw e
  }
  return h.digest('hex')
}

/** 本地 mtime 容差缓存：目录路径 → 容差 ms（每个目录只探测一次） */
const FS_TOL_CACHE = new Map()

/**
 * 本地指纹 mtime 容差：通过在目标目录写入临时探测文件实测 mtime 粒度。
 *
 * 选型说明：fsutil fsinfo volumeinfo 在非提权 shell 下返回「错误 5: 拒绝访问」
 * （实测 Win11，普通用户基本必败）；mount / /proc/mounts 解析平台相关且无法在
 * 单一平台覆盖全部文件系统。写入实测法免提权、跨平台行为一致，且对网络盘 /
 * UNC 路径 / 外置盘天然正确（探测的就是目标文件系统本身）。
 *
 * 判定：把探测文件 utimes 到「奇数秒 + 700ms」——2 秒粒度的文件系统
 * （FAT12/16/32、exFAT、部分 SMB 捨位配置）读回值落在偶数秒边界（偏差 ≥ 500ms）
 * → 容差 2000ms；高精度文件系统（NTFS/APFS/ext4，实测 NTFS 读回零偏差）
 * → 容差 1000ms。探测失败（目录不可写等）保守取 2000ms。
 *
 * 探测文件使用 .wdsync-tmp- 前缀：被扫描层排除（isSyncTempRel），
 * 崩溃残留由启动期清理（cleanupOrphanTemps）回收。
 */
async function localFpTolMs(localPath: string): Promise<number> {
  const FAT_TOL = 2000
  const NORMAL_TOL = 1000
  const key = path.resolve(String(localPath || '.'))
  if (FS_TOL_CACHE.has(key)) return FS_TOL_CACHE.get(key)
  let tol = FAT_TOL // 探测失败时的保守值
  const probe = path.join(key, `.wdsync-tmp-tol-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  try {
    await fsp.writeFile(probe, '')
    try {
      const target = new Date(Math.floor(Date.now() / 2000) * 2000 + 1700)
      await fsp.utimes(probe, target, target)
      const st = await fsp.stat(probe)
      tol = Math.abs(st.mtimeMs - target.getTime()) > 500 ? FAT_TOL : NORMAL_TOL
    } finally {
      await fsp.unlink(probe).catch(() => {})
    }
  } catch (_) {
    /* 目录不可写 / 不存在等：保守 2000 */
  }
  FS_TOL_CACHE.set(key, tol)
  return tol
}

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
function fpMatch(a: any, b: any, tolMs = 1000): boolean {
  if (!a || !b) return false
  return a.size === b.size && Math.abs((a.mtimeMs || 0) - (b.mtimeMs || 0)) <= tolMs
}

/** 本地扫描指纹 vs 基线条目（lsize/lmtimeMs）的 size+mtime 判定 */
function localFpMatch(l: any, m: any, tolMs: number): boolean {
  if (!l || !m) return false
  return l.size === m.lsize && Math.abs((l.mtimeMs || 0) - (m.lmtimeMs || 0)) <= tolMs
}

/** 远端扫描指纹 vs 基线条目：etag 优先，size 严格，rmtime 容差 */
function remoteChangedVs(r: any, m: any): boolean {
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
 * 返回 { changed, hash? }。
 */
async function computeLocalChanged(l: any, m: any, tolMs: number, forceHash = false): Promise<any> {
  if (l.size !== m.lsize) return { changed: true }
  const mtimeNear = Math.abs((l.mtimeMs || 0) - (m.lmtimeMs || 0)) <= tolMs
  const needHash = forceHash || !mtimeNear
  if (!needHash) return { changed: false }
  if (m.lhash == null) return { changed: !mtimeNear } // 基线无历史 hash：深度校验无从比较，视为未变
  const hash = await hashFile(l.abs)
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
function decideAction(rel: string, l: any, r: any, m: any, mode: SyncMode, flags: any = {}): any {
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
function entryFrom(l: any, r: any, lhash: string | null, extra: { origName?: string; conflictCopy?: boolean } = {}): BaselineEntry {
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

/** 查询单个远端条目属性；区分「已不存在」与「查询失败」，网络异常直接抛出 */
async function remotePropsEx(cfg: EngineCfg, remotePath: string): Promise<any> {
  const r = await davRequest(cfg, 'PROPFIND', remotePath, { headers: { Depth: '0' } })
  if (r.status === 404) return { gone: true }
  if (r.status !== 207 || !r.body) return { error: `HTTP ${r.status}` }
  const list = parseMultistatus(r.body.toString('utf-8'))
  if (!list.length) return { error: 'empty multistatus' }
  return { props: list[0] }
}

/**
 * B 档复查：覆盖已存在远端文件 / 删除远端文件前，紧邻做一次 PROPFIND Depth 0，
 * 与扫描期指纹比对（etag 用统一的规范化比较——去引号、去 W/ 前缀；etag 缺任一侧时
 * 退化为 size 严格 + mtime 2000ms 容差）。不符 → 抛 REMOTE_CHANGED（放弃该文件并记录），
 * 下轮重新规划自然收敛。复查失败（网络 / 非 207）同样放弃：复查的目的就是保护，
 * 无法确认「远端未变」时按已变处理是唯一安全方向。远端已消失（gone）不算不符：
 * 覆盖语义下 PUT 本就是重建，删除语义下 DELETE 幂等达成目标状态。
 * @param cfg 配置 @param remoteAbs 远端绝对路径（相对服务器根）
 * @param scan 扫描期远端指纹 { etag, size, mtimeMs } @param rel 展示用相对路径
 */
async function recheckRemoteUnchanged(cfg: EngineCfg, remoteAbs: string, scan: any, rel: string): Promise<any> {
  const changed = (why: any) => {
    const err: any = new Error(`「${rel}」暂未上传：云端的文件刚被其他设备修改，为避免覆盖，下次同步会重新判断`)
    err.detail = why
    err.code = 'REMOTE_CHANGED'
    err.status = 0
    err.permanent = true
    throw err
  }
  let props
  try {
    props = await remotePropsEx(cfg, remoteAbs)
  } catch (e: any) {
    const err: any = new Error(`「${rel}」暂未处理：无法确认云端文件的最新状态，下次同步重试`)
    err.detail = (e && e.message) || e
    err.code = 'REMOTE_CHANGED'
    err.status = 0
    err.permanent = true
    throw err
  }
  if (props.gone) return
  if (props.error) {
    const err: any = new Error(`「${rel}」暂未处理：无法确认云端文件的最新状态，下次同步重试`)
    err.detail = props.error
    err.code = 'REMOTE_CHANGED'
    err.status = 0
    err.permanent = true
    throw err
  }
  const p = props.props
  const se = normEtag(scan.etag)
  const pe = normEtag(p.etag)
  if (se && pe) {
    if (se !== pe) changed(`etag ${se} → ${pe}`)
    return
  }
  if (p.size !== scan.size) changed(`大小 ${scan.size} → ${p.size}`)
  if (scan.mtimeMs > 0 && p.mtime > 0 && Math.abs(scan.mtimeMs - p.mtime) > REMOTE_FP_TOL_MS) {
    changed(`mtime 偏差 ${Math.abs(scan.mtimeMs - p.mtime)}ms 超容差`)
  }
}

// ---------- Windows 文件名 / 路径预检（跨平台统一执行） ----------
//
// 动机：插件明确支持 Windows + macOS 互通。macOS 允许的文件名（含 :、"、?、*
// 或以空格 / 点结尾）在 Windows 上要么无法创建、要么被系统改写；含保留名
// （CON / NUL / COM1…）的文件在 Windows 上任何 API 都打不开。本机是 macOS 时
// 照样预检 —— 文件一旦上传，另一台 Windows 设备下载即失败（或更糟：本地明明
// 两个文件、对端只能落一个）。预检在上传前置检查里抛 BAD_FILENAME（permanent
// 分类 → 记入失败退避表，不再每轮重试撞墙，重命名后自然恢复）。
//
// 已知边界（README 同步说明）：
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
function checkWinSegment(seg: string): string | null {
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
function checkWindowsRel(rel: string, baseAbs: string): string | null {
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
function badFilenameError(rel: string, why: string): any {
  const err: any = new Error(`已跳过「${rel}」：文件名或路径在 Windows 上无法使用（${why}）。改名后会自动恢复同步`)
  err.code = 'BAD_FILENAME'
  err.status = 0
  err.permanent = true
  return err
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
// 折叠情形为已知近似，README 说明）。

/**
 * 检测两侧扫描结果中的大小写冲突组。纯函数。
 * @param localRels 本地侧 NFC rel 集合（可迭代）
 * @param remoteRels 远端侧 NFC rel 集合（可迭代，仅文件条目）
 * @returns {{ groups: Array<{ side: 'local'|'remote'|'cross', rels: string[] }>, skip: Set<string> }}
 *          groups 按发现顺序（错误提示逐组）；skip 为全部涉及 rel（规划层跳过用）
 */
function detectCaseCollisions(localRels: Iterable<string>, remoteRels: Iterable<string>): { groups: any[]; skip: any } {
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
function checkDirOverlap(dir: DirCfg, existing: DirCfg[], exceptId: string | null | undefined): { side: string; withName: string; message: string } | null {
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

/**
 * 上传单个文件（自动补齐远端父目录）。
 * expected: 计划阶段的本地指纹 {abs, size, mtimeMs}，来自本轮扫描。
 * guards（档位保护）：
 *   recheck          —— B 档（或 A 档但扫描期 etag 弱/缺失）覆盖已存在文件前的紧邻复查；
 *   ifMatch          —— A 档覆盖已存在文件时的 If-Match（值必为强 etag，规范化后重新包裹引号）；
 *   ifNoneMatchStar  —— A 档新上传时的 If-None-Match:*（仅当目标不存在才允许创建）。
 *
 * 安全语义（对应状态机 PRE-UPLOAD-CHECK → UPLOAD → POST-CHECK）：
 *   1. 上传前重新 stat：与计划指纹不一致 → 拒绝按旧计划上传（文件已被修改，需重新规划）；
 *   2. 上传后重新 stat：与上传前不一致 → 文件在上传期间被修改，本次上传内容不可信，报错；
 *   3. HTTP 412（A 档条件头命中）：对端在扫描后修改了该文件 —— 不覆盖、本轮跳过该文件
 *      （错误信息明确标注，供排查「A 档判定后服务器又忽略条件头」等异常）。
 * 远端核验（存在性 + size 比对 + 取远端指纹写基线）不在本函数（按目录批量执行）：
 * 一个目录的上传全部完成后，由 syncDirectory 的批量校验阶段对该目录做一次 PROPFIND
 * Depth 1 统一核对并提交基线，不再逐文件一次 PROPFIND；上传前后的本地 stat 校验保留在此。
 * hooks.onBeforePut：在**前置检查（双 stat / 建目录 / B 档复查）全部通过之后、
 * PUT 请求发起之前**被 await 调用 —— 调用方（runUploadOp）在此刻才写 WAL intent，使
 * 「pre-flight 失败不产生 intent」成立；钩子抛错则 PUT 不发起、错误原样上抛。
 * 返回 { local: 上传后本地 stat, hash: 实际传输内容 sha256 }
 *（远端指纹 rsize/rmtimeMs/retag 由批量校验阶段从目录列表取，不由本函数提供）。
 */
async function uploadOne(cfg: EngineCfg, dir: DirCfg, rel: string, expected: any, createdDirs: any, guards: any = {}, hooks: any = {}): Promise<any> {
  // 跨平台文件名预检：Windows 非法名 / 保留名 / 尾空格点 / 超长在一切
  // 前置检查最前面拦截 —— 本机是 macOS 时同样拦截（多设备互通的另一端是 Windows）。
  // BAD_FILENAME → permanent 分类 → 失败退避表；重命名后新一轮自动恢复。
  const badName = checkWindowsRel(rel, dir && dir.localPath)
  if (badName) throw badFilenameError(rel, badName)
  // PRE-UPLOAD-CHECK：扫描之后文件若已变化，绝不能按旧计划上传（基线指纹必须对应实际上传的内容）
  const st1 = await statOrNull(expected.abs)
  if (!st1) throw new Error(`「${rel}」未上传：文件已经不在电脑上了`)
  if (st1.size !== expected.size || Math.abs(st1.mtimeMs - expected.mtimeMs) > 1000) {
    throw new Error(`「${rel}」未上传：同步过程中文件被改动了，下次同步会重新处理`)
  }
  const segs = rel.split('/')
  if (segs.length > 1) {
    const parent = segs.slice(0, -1).join('/')
    if (!createdDirs.has(parent)) {
      createdDirs.add(parent)
      await mkdirDeep(cfg, joinRemote(dir.remotePath, parent))
    }
  }
  // 档位保护：B 档（或退化场景）覆盖已存在远端文件前，紧邻复查扫描期指纹
  if (guards.recheck) await recheckRemoteUnchanged(cfg, joinRemote(dir.remotePath, rel), guards.recheck, rel)
  // A 档条件头：覆盖带 If-Match（强 etag）、新上传带 If-None-Match:*
  const putHeaders: Record<string, any> = {}
  if (guards.ifMatch) putHeaders['If-Match'] = guards.ifMatch
  if (guards.ifNoneMatchStar) putHeaders['If-None-Match'] = '*'
  // intent 写入点 —— 全部前置检查已过、PUT 即将发起的唯一时刻。
  // 此前任何失败（stat 不符 / 建目录失败 / 复查不符）都不会产生 intent
  if (hooks.onBeforePut) await hooks.onBeforePut()
  // 边传边算 hash（hashAlg：摘要只覆盖最终成功的那次传输，429/503/423 重试不会污染），
  // 与实际发送字节同源（I4），不额外读盘
  const res = await davRequest(cfg, 'PUT', joinRemote(dir.remotePath, rel), { bodyFile: expected.abs, hashAlg: 'sha256', headers: putHeaders })
  if (res.status === 412) {
    // 条件保护命中：对端已变 → 不覆盖、本轮跳过（信息明确，便于排查服务器行为异常）
    const err: any = new Error(`「${rel}」暂未上传：云端的文件刚被其他设备修改，为避免覆盖，下次同步会重新判断`)
    err.code = 'PRECONDITION'
    err.status = 412
    err.permanent = true
    err.detail = 'HTTP 412（If-Match 不匹配）'
    throw err
  }
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
    // 附带 status 与分类 code：classifyOpFailure 据此判定永久 / 瞬时失败
    const err: any = new Error(`「${rel}」上传失败（HTTP ${res.status}）`)
    err.status = res.status
    err.code = (res.classification && res.classification.code) || 'HTTP'
    throw err
  }
  // POST-CHECK：上传期间文件被修改 → 本次上传不能视为最终同步状态
  const st2 = await statOrNull(expected.abs)
  if (!st2 || st2.size !== st1.size || Math.abs(st2.mtimeMs - st1.mtimeMs) > 1000) {
    throw new Error(`「${rel}」上传时又被修改了，请再同步一次`)
  }
  // 远端核验（VERIFY）已移至 syncDirectory 的批量校验阶段：PUT 成功 + 本地双 stat
  // 一致即返回，远端存在性 / size 与写基线用的指纹由所在目录的一次 PROPFIND Depth 1 统一提供
  return { local: st2, hash: res.hashHex }
}

/**
 * 下载单个文件（先写临时文件，通过校验后原子改名）。
 * localRel 用于「同时保留」时另存为冲突副本。
 * guards:
 *   expectedLocal      —— 计划阶段的目标指纹 {size, mtimeMs}；null 表示目标应当不存在（新文件）
 *   expectedRemoteSize —— 计划阶段扫描到的远端 size，用于发现「扫描后远端又变了」
 *   remoteMtimeMs      —— 远端 lastModified：落地后 utimes 对齐（失败忽略）
 *   origName           —— 远端原始文件名（NFD 服务器名与本机 NFC key 不一致时的实际访问名）
 *
 * 安全语义（对应状态机 DOWNLOAD_START → DOWNLOAD_TEMP → DOWNLOAD_VERIFY → LOCAL_TARGET_CHANGED? → ATOMIC_REPLACE）：
 *   1. 目标相对计划已变化（被用户修改 / 出现计划外文件 / 已消失）→ 中止，绝不覆盖用户内容；
 *   2. 临时文件大小必须与响应 Content-Length 一致（HTTP 200 ≠ 内容完整）；
 *   3. 远端大小与扫描时不一致 → 远端在同步期间变化，中止本轮该文件；
 *   4. 下载期间目标再次变化 → 中止，保留用户当前版本。
 * 任何中止都会清掉临时文件并抛错；临时文件全程登记在 LIVE_TEMPS。
 * 返回 { size, mtimeMs, hash }：rename（及 utimes）之后本地实际指纹 + 下载内容 sha256。
 */
async function downloadOne(cfg: EngineCfg, dir: DirCfg, rel: string, tmpDir: string, localRel: string | null, guards: any = {}): Promise<any> {
  // Windows 目标名预检（仅 win32）：远端来的非法名在本地文件系统必然创建失败，
  // 与其等到 EINVAL / silently-converted 不如前置报错（错误同走 BAD_FILENAME）。
  // 非 win32 平台放行 —— macOS / Linux 本身可落盘；上传侧预检已保证它将来
  // 不会被本插件传向 Windows 端（上传是唯一入口）。
  if (process.platform === 'win32') {
    const badName = checkWindowsRel(localRel || rel, dir && dir.localPath)
    if (badName) throw badFilenameError(rel, badName)
  }
  const remote = joinRemote(dir.remotePath, rel)
  const segs = (localRel || rel).split('/')
  if (guards.origName && !localRel) segs[segs.length - 1] = guards.origName
  const abs = path.join(dir.localPath, ...segs)
  const before = await statOrNull(abs)
  if (guards.expectedLocal) {
    if (!before) throw new Error(`「${rel}」未下载：电脑上的文件刚被修改或出现变化，已保留你的版本，没有覆盖`)
    if (before.size !== guards.expectedLocal.size || Math.abs(before.mtimeMs - guards.expectedLocal.mtimeMs) > 1000) {
      throw new Error(`「${rel}」未下载：电脑上的文件刚被修改或出现变化，已保留你的版本，没有覆盖`)
    }
  } else if (before) {
    // 计划时目标不存在，现在却存在：计划外出现的内容一律不覆盖
    throw new Error(`「${rel}」未下载：电脑上的文件刚被修改或出现变化，已保留你的版本，没有覆盖`)
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  const tmp = path.join(tmpDir, `.wdsync-dl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  LIVE_TEMPS.add(tmp)
  let res: any = null
  try {
    // hashAlg：下载内容摘要由网络层在最终成功的那次传输中计算（重试不污染）
    res = await davRequest(cfg, 'GET', remote, { sinkFile: tmp, hashAlg: 'sha256' })
    if (res.status !== 200) {
      // 附带 status 与分类 code：classifyOpFailure 据此判定永久 / 瞬时失败
      const err: any = new Error(`「${rel}」下载失败（HTTP ${res.status}）`)
      err.status = res.status
      err.code = (res.classification && res.classification.code) || 'HTTP'
      throw err
    }
    // DOWNLOAD_VERIFY：临时文件与 Content-Length 一致
    const tmpSt = await statOrNull(tmp)
    if (!tmpSt) {
      const e: any = new Error(`「${rel}」下载不完整，下次同步会重试`)
      e.detail = '临时文件丢失'
      throw e
    }
    const cl = res.headers && res.headers['content-length'] ? Number(res.headers['content-length']) : null
    if (cl != null && tmpSt.size !== cl) {
      const e: any = new Error(`「${rel}」下载不完整，下次同步会重试`)
      e.detail = `收到 ${tmpSt.size} 字节，响应声明 ${cl} 字节`
      throw e
    }
    // 远端相对扫描时已变化：本轮数据不可信，下一轮重新规划
    if (guards.expectedRemoteSize != null && cl != null && cl !== guards.expectedRemoteSize) {
      const e: any = new Error(`「${rel}」未下载：下载期间云端文件被修改了，下次同步重试`)
      e.detail = `${guards.expectedRemoteSize} → ${cl} 字节`
      throw e
    }
    // LOCAL_TARGET_CHANGED?：下载期间目标被用户修改 → 不 rename、不覆盖
    const after = await statOrNull(abs)
    if ((before == null) !== (after == null) || (before && after && (before.size !== after.size || Math.abs(before.mtimeMs - after.mtimeMs) > 1000))) {
      throw new Error(`「${rel}」未下载：电脑上的文件刚被修改或出现变化，已保留你的版本，没有覆盖`)
    }
    await fsp.rename(tmp, abs)
    // rename 落地后 fsync 目标目录（POSIX）——让新目录项掉电级落盘；
    // Windows 无法打开目录句柄，fsyncDirIfPossible 内部跳过（store.js 已知边界）
    await storage.fsyncDirIfPossible(path.dirname(abs))
  } catch (e: any) {
    // 统一清理：网络异常 / 校验失败 / 中止都会走到这里
    LIVE_TEMPS.delete(tmp)
    await fsp.unlink(tmp).catch(() => {})
    throw e
  }
  LIVE_TEMPS.delete(tmp) // rename 成功后临时路径已消失，生命周期结束
  // 按远端 lastModified 对齐本地 mtime（失败忽略），使基线与下一轮比较稳定
  if (guards.remoteMtimeMs > 0) {
    const t = new Date(guards.remoteMtimeMs)
    await fsp.utimes(abs, t, t).catch(() => {})
  }
  const st = await fsp.stat(abs)
  return { size: st.size, mtimeMs: st.mtimeMs, hash: res.hashHex }
}

/**
 * 内容消歧 —— 把远端文件下载到临时文件流式算 hash（不落地目标路径），
 * 用于「指纹变了但 size 相同」时判断远端是否真的变了。超限 / 失败返回 null（按远端已变处理）。
 * 另被 recoverIntents 复用：开放意图采纳前的内容确认（GET hash 对比本地）。
 */
async function verifyRemoteHash(cfg: EngineCfg, dir: DirCfg, rel: string, r: any): Promise<string | null> {
  const tmp = path.join(dir.localPath, `.wdsync-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  LIVE_TEMPS.add(tmp)
  try {
    // 下载到临时文件流式算 hash（hashAlg 由网络层按次创建，重试后摘要仍正确）
    const res = await davRequest(cfg, 'GET', joinRemote(dir.remotePath, rel), { sinkFile: tmp, hashAlg: 'sha256' })
    if (res.status !== 200) return null
    const st = await statOrNull(tmp)
    if (!st || st.size !== r.size) return null
    return res.hashHex != null ? res.hashHex : null
  } catch (_) {
    return null
  } finally {
    LIVE_TEMPS.delete(tmp)
    await fsp.unlink(tmp).catch(() => {})
  }
}

/**
 * 逐块比较两个文件的前 n 字节是否一致。
 * 固定 64KB 缓冲顺序读，不整文件读入内存；任一文件短读 / IO 异常返回 null（无法判定）。
 * @returns {Promise<'match'|'mismatch'|null>}
 */
async function filesPrefixEqual(aPath: string, bPath: string, n: number): Promise<'match' | 'mismatch' | null> {
  if (!(n > 0)) return 'match' // 空前缀平凡相等（size=0 的半截形态）
  const fa = await fsp.open(aPath, 'r').catch(() => null)
  const fb = await fsp.open(bPath, 'r').catch(() => null)
  if (!fa || !fb) {
    if (fa) await fa.close().catch(() => {})
    if (fb) await fb.close().catch(() => {})
    return null
  }
  const BUFSZ = 65536
  const ba = Buffer.allocUnsafe(BUFSZ)
  const bb = Buffer.allocUnsafe(BUFSZ)
  try {
    let off = 0
    while (off < n) {
      const want = Math.min(BUFSZ, n - off)
      const [ra, rb] = await Promise.all([fa.read(ba, 0, want, null), fb.read(bb, 0, want, null)])
      if (ra.bytesRead !== want || rb.bytesRead !== want) return null
      if (ba.compare(bb, 0, want, 0, want) !== 0) return 'mismatch'
      off += want
    }
    return 'match'
  } catch (_) {
    return null
  } finally {
    await fa.close().catch(() => {})
    await fb.close().catch(() => {})
  }
}

/**
 * 流式 GET 远端文件，与本地文件的前 rsize 字节逐块比对，
 * 判定远端是否为「本机自己中断上传留下的半截」。调用方已保证 0 ≤ rsize < 本地大小
 * 且 rsize ≤ verifyMaxBytes。
 * 远端下载经 .wdsync-verify- 临时文件（复用网络层重试 / 取消销毁 / hash 基础设施；
 * 受扫描排除与孤儿清理管辖）；GET 到的字节数与扫描期 rsize 不一致（GET 与扫描之间
 * 对端又变）按无法判定处理。
 * @returns {Promise<'match'|'mismatch'|null>} null = GET 失败 / 大小漂移 / IO 异常（无法判定）
 */
async function remoteIsLocalPrefix(cfg: EngineCfg, dir: DirCfg, rel: string, localAbs: string, rsize: number): Promise<'match' | 'mismatch' | null> {
  const tmp = path.join(dir.localPath, `.wdsync-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  LIVE_TEMPS.add(tmp)
  try {
    const res = await davRequest(cfg, 'GET', joinRemote(dir.remotePath, rel), { sinkFile: tmp })
    if (res.status !== 200) return null
    const st = await statOrNull(tmp)
    if (!st || st.size !== rsize) return null
    return await filesPrefixEqual(tmp, localAbs, rsize)
  } catch (_) {
    return null
  } finally {
    LIVE_TEMPS.delete(tmp)
    await fsp.unlink(tmp).catch(() => {})
  }
}

/**
 * 删除本地文件 —— 一律移入回收站（经宿主端口层，默认端口绑定
 * ztools.shellTrashItem，宿主侧为 Electron shell.trashItem：macOS 进废纸篓 /
 * Windows 进回收站）。绝不退化为 unlink：回收站端口不可用（宿主未注入 / 测试
 * 环境缺失）或调用失败（权限、卷不支持、文件被占用等）一律抛错 —— 调用方按
 * 「跳过该文件并记录」处理，基线条目保留，文件留在原地，下一轮重试。文件本就
 * 不存在视为成功（目标状态达成）。
 * origName：基线记录的原始文件名（NFD 服务器 / 旧系统命名与 NFC key 不一致时用原名访问）。
 */
async function deleteLocalOne(dir: DirCfg, rel: string, origName?: string): Promise<void> {
  const segs = rel.split('/')
  if (origName) segs[segs.length - 1] = origName
  const abs = path.join(dir.localPath, ...segs)
  if (!(await statOrNull(abs))) return // 已不存在：目标状态达成
  // 接口缺失由默认端口抛固定文案（HOST_TRASH_MISSING_MESSAGE）：与调用失败是两类
  // 形态 —— 此处按端口化之前的文案逐字分别还原，既有断言与用户可见信息不变
  try {
    await getHostPorts().trashItem(abs)
  } catch (e: any) {
    const msg = (e && e.message) || e
    if (msg === HOST_TRASH_MISSING_MESSAGE) {
      throw new Error(`无法删除电脑上的「${rel}」：当前 ZTools 版本不支持放入回收站，文件已保留`)
    }
    const err: any = new Error(`无法删除「${rel}」：未能放入回收站，文件已保留`)
    err.detail = msg
    throw err
  }
  // 防御：trashItem 成功返回但文件仍在（异常宿主实现）按失败处理，
  // 绝不出现 summary.deleted++ 但文件还在的状态
  if (await statOrNull(abs)) {
    const err2: any = new Error(`无法删除「${rel}」：未能放入回收站，文件已保留`)
    err2.detail = '移入回收站后文件仍存在'
    throw err2
  }
}

// ---------- 永久失败分类与退避 ----------

/**
 * 对执行期单个传输操作的失败做三分类，决定「记退避表 / 当轮重试 / 普通报错」：
 *   'permanent' —— 文件级永久失败：HTTP 413（过大）/ 507（配额不足）/ 403 / 405（权限
 *                  拒绝）、本地 EACCES / EPERM（以系统码判，包装消息不可靠）、预留的
 *                  BAD_FILENAME（Windows 预检不通过的文件名，见上传前置检查）。重试大概率原地再败，
 *                  记入 failures.json 按指数退避跳过，避免每轮撞墙；
 *   'transient' —— 瞬时失败：HTTP 423（被锁）、网络层 NETWORK（重试耗尽）、本地写入
 *                  EBUSY（文件被占用，包装消息含系统码）。当轮后段重试一次，下轮自然
 *                  重试，不记录退避表；
 *   'normal'    —— 其余：当轮报错、下轮重试，不记录。
 *
 * 分类规则说明：
 *   - 401 不入 permanent：认证失败是配置级问题（密码错 / 授权过期），应整轮明确报错
 *     提醒用户修改配置，静默跳过只会掩盖故障；
 *   - 不直接采用错误对象的 permanent 字段：REMOTE_CHANGED（复查发现对端已变）与
 *     PRECONDITION（412 条件保护命中）虽标 permanent，但它们是「本轮不覆盖、下轮
 *     重新规划」的正常保护路径，不该进退避表；CIRCUIT_OPEN（整轮熔断的快速失败）
 *     同理 —— 熔断后剩余文件下轮自然重试，绝不记为持续失败；
 *   - 本地删除失败（deleteLocalOne 的包装错误不带系统码字段）按 normal 处理：权限
 *     恢复后下一轮立即重试（保留既有「ACL 复位后当轮即可删除成功」的语义）。
 */
function classifyOpFailure(e: any): 'permanent' | 'transient' | 'normal' {
  if (!e || typeof e !== 'object') return 'normal'
  if (e.code === 'BAD_FILENAME') return 'permanent' // Windows 文件名预检（uploadOne / win32 下载前置）
  const st = Number(e.status) || 0
  if (st === 413 || st === 507 || st === 403 || st === 405) return 'permanent'
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'permanent'
  if (st === 423) return 'transient'
  if (e.code === 'NETWORK') return 'transient'
  if (e.code === 'EBUSY') return 'transient'
  if (e.code === 'LOCAL_IO' && /EBUSY/.test(String(e.message || ''))) return 'transient'
  return 'normal'
}

/**
 * 判定错误是否属「网络类」（summary.failureClass 的逐条输入）。
 * 与整轮熔断的计数口径完全一致（requestWithRetry 的 noteFailure 判定）：
 * 网络层异常耗尽重试（NETWORK）、熔断快速失败（CIRCUIT_OPEN）、终态 429/423/5xx。
 * 与 classifyOpFailure 的分工：后者决定单文件失败后的处置（退避表 / 当轮重试 / 报错），
 * 本函数只回答「这条失败可否归因为服务器不可用」—— 供调度层跨轮退避的机器可读归纳，
 * 4xx 条件保护（412/REMOTE_CHANGED）与本地 IO 类不算网络类。
 */
function networkFailure(e: any): boolean {
  if (!e || typeof e !== 'object') return false
  if (e.code === 'NETWORK' || e.code === 'CIRCUIT_OPEN') return true
  const st = Number(e.status) || 0
  return st === 429 || st === 423 || (st >= 500 && st < 600)
}

/**
 * WAL 崩溃恢复：本轮扫描完成后，核对上一轮遗留的未了结意图。
 * 每个意图的裁决 ∈ { 采纳(done) / 放弃(abort) / 判定半截转重传(保持开放) / 保持开放(保守) }。
 *  - upload 意图：
 *    0. 超龄（> OPEN_INTENT_MAX_AGE_MS）或本地自意图起已不存在 / 已变化 → 放弃
 *       （两条防累积兜底；本地已变时半截判定失去前提，绝不能按旧意图重传）；
 *    1. 采纳：远端已存在与本地同 size 文件 → GET 内容确认（上限 verifyMaxBytes；
 *       GET 失败 / 超限回退按 size 采纳 —— 窄洞保留并写入 README 已知边界；内容不符
 *       则确定「不是自己的完成品」→ 放弃，交正常规划）；
 *    2. 判定半截（判定链全部满足）：存在开放 upload 意图 + 本地未变 + 远端现指纹
 *       ≠ 意图记录的上传前指纹 + 0 ≤ 远端 size < 本地 size + 流式前缀校验通过 →
 *       该 rel 记入返回的 forceUploads 集合，本轮强制规划为 upload（A 档 If-Match 用
 *       本轮扫描 etag、B 档照旧复查；意图保持开放，强制重传写入的新意图按「新者取代
 *       旧者」了结它）。size=0 走同一条前缀校验（空前缀平凡通过，见 README 取舍说明）；
 *       前缀不符 → 确定非己方半截 → 放弃；GET 失败 / 超 verifyMaxBytes → 保守保持
 *       开放（本轮正常规划进冲突，冲突弹窗带「疑似残缺文件」提示，意图下轮再判）；
 *    3. 其余（服务器原子未落地、对端真实修改等）→ 保持开放，正常规划照旧。
 *       绝不使用 mtime 时间窗启发（多设备时钟不同源）。
 *  - download 意图：远端未再变（PROPFIND 指纹与意图一致）且本地已存在同 size 文件 →
 *    采纳（同样做 GET 内容确认，失败回退 size 采纳）；否则放弃。下载意图不保持
 *    开放：远端从无「我方半截」问题，重推导安全。
 *  - 删除类意图不采纳：删除可由规划按旧基线幂等重推导（delete-local / delete-remote 的
 *    真值表行会再次得出同一动作）；直接「采纳=删条目」反而会让 delete-local 场景把
 *    已删文件当作新远端文件下载回来（无基线 + 仅远端存在 → download）。
 * 采纳时对本地文件重算一次 hash 作为 lhash（意图中不含传输中途算出的 hash）。
 * @param adoptBudgetBytes 采纳内容确认的单轮总字节预算（runSyncRound
 *        解析后传入；默认 verifyMaxBytes × ADOPT_VERIFY_BUDGET_FACTOR）。预算按
 *        「实际发出的确认 GET 的目标大小」扣减；耗尽后剩余条目不再发 GET，回退
 *        「按大小采纳」并计入轮末的一条汇总 warning（不逐文件刷屏）。
 * @returns {Promise<Set<string>>} 半截判定命中、本轮须强制规划为 upload 的 rel 集合（nfc key）
 */
async function recoverIntents(store: any, cfg: EngineCfg, dir: DirCfg, localByNfc: Map<string, any>, remoteByNfc: Map<string, any>, localTol: number, verifyMaxBytes: number | undefined, pushWarning: (msg: string) => void, adoptBudgetBytes: number | undefined): Promise<Set<string>> {
  const vMax = verifyMaxBytes ?? Number.NaN // undefined 时比较恒 false（不设上限的原语义）
  const forceUploads = new Set<string>()
  const intents: any[] = Array.from(store.pendingIntents.values())
  let adoptBytesLeft = adoptBudgetBytes ?? Number.POSITIVE_INFINITY
  const adoptBudgetSkipped: any[] = [] // 因预算耗尽回退按大小采纳的 rel（轮末汇总一条）
  /** 发出一次采纳确认 GET（预算内）—— 返回 false = 预算耗尽未发出（与 GET 失败的 null 区分） */
  const adoptVerifyGet = async (rel: any, r: any) => {
    if (adoptBytesLeft < r.size) {
      adoptBudgetSkipped.push(rel)
      return false
    }
    adoptBytesLeft -= r.size
    return verifyRemoteHash(cfg, dir, rel, r)
  }
  for (const it of intents) {
    const rel = nfc(it.rel || '')
    const l = localByNfc.get(rel)
    const rEntry = remoteByNfc.get(rel)
    const r = rEntry && !rEntry.isDir ? rEntry : null
    const settle = (adopted: any, warning: any) =>
      (adopted ? store.appendWalDone(it.id) : store.appendWalAbort(it.id)).catch(() => {}).then(() => {
        if (warning) logNote(warning)
      })
    // 兜底一：开放意图超龄 —— 按意图链最初写入时刻（firstAt，由新意图继承；
    // 缺失回退 at —— 注入 / download 类意图）计算，持续中断链不会因每轮「新者取代旧者」
    // 而免于封顶。at 与 firstAt 均缺失按超龄处理（现行写入点必有 at）→ 无条件放弃
    const bornAt = Number(it.firstAt) > 0 ? Number(it.firstAt) : Number(it.at)
    if (!(bornAt > 0) || Date.now() - bornAt > OPEN_INTENT_MAX_AGE_MS) {
      await settle(false, `崩溃恢复：${it.rel} 的开放意图已超龄（> ${Math.round(OPEN_INTENT_MAX_AGE_MS / 86400000)} 天），按放弃处理`)
      continue
    }
    if (it.op === 'upload') {
      const lp = it.local || {}
      const localUnchanged = l && l.size === lp.size && Math.abs((l.mtimeMs || 0) - (lp.mtimeMs || 0)) <= localTol
      // 兜底二：本地已不存在 / 已变化 → 意图失去意义（半截判定前提不成立），放弃
      if (!localUnchanged) {
        await settle(false, `崩溃恢复：${it.rel} 的开放上传意图已放弃（本地文件已变化或不存在），按正常流程重新规划`)
        continue
      }
      // ---- 采纳（既有语义 + 内容确认 + 单轮字节预算）----
      if (r && r.size === lp.size) {
        const lhash = await hashFile(l.abs).catch(() => null)
        let contentOk = true // 缺省可采纳：本地 hash 算不出 / 超限 / GET 失败 / 预算耗尽均回退按 size 采纳
        let confirmed = false // 是否实际完成过一次 GET 内容比对
        let budgetSkipped = false // 因预算耗尽未发 GET —— 逐文件提示由轮末汇总取代
        if (lhash != null && r.size <= vMax) {
          const rh = await adoptVerifyGet(rel, r)
          if (rh === false) {
            budgetSkipped = true
          } else if (rh != null) {
            confirmed = true
            contentOk = rh === lhash
          }
        }
        if (contentOk) {
          // GET 失败 / 超限（confirmed=false 且非预算耗尽）的回退：按 size 采纳
          //（窄洞见 README 已知边界）；预算耗尽的回退不逐文件提示（轮末汇总一条）。
          // 基线写入失败按放弃处理（与旧语义一致：setEntry 抛错绝不写 done）
          let wrote = false
          try {
            await store.setEntry(rel, entryFrom(l, r, lhash, { origName: r.origName }))
            wrote = true
          } catch (_) {}
          await settle(wrote, wrote ? (confirmed ? `崩溃恢复：${it.rel} 已按意图日志采纳（内容已确认，无重传、无冲突）` : budgetSkipped ? null : `崩溃恢复：${it.rel} 按大小采纳上传意图（内容确认未完成）`) : null)
          continue
        }
        // 内容不符且经 GET 确认：远端同 size 但内容并非本地 —— 不是自己的完成品，
        // 也不可能是自己的半截（size 相等），放弃后交正常规划（通常进冲突由用户裁决）
        await settle(false, `崩溃恢复：${it.rel} 远端内容与本地不一致，未采纳上传意图，按冲突处理`)
        continue
      }
      // ---- 半截判定链（任一不满足走保守路径 = 保持开放、正常规划）----
      const remoteWas = it.remote || null
      const remoteDiffers = remoteWas
        ? remoteChangedVs(r, { rsize: remoteWas.size, rmtimeMs: remoteWas.mtimeMs, retag: remoteWas.etag })
        : !!r
      if (r && remoteDiffers && r.size >= 0 && r.size < lp.size && lp.size > 0) {
        if (r.size > vMax) {
          // 超上限：无法安全判定 → 保持开放 + 冲突弹窗提示（经 onConflict info.hint）
          pushWarning(`「${it.rel}」在云端可能是上次没传完的不完整文件，但文件太大无法自动对比，请你选择保留哪一个`)
          continue
        }
        const verdict = await remoteIsLocalPrefix(cfg, dir, rel, l.abs, r.size)
        if (verdict === 'match') {
          // 同 rel 多个开放意图（历史残留 / 崩溃窗口）只提示一次，forceUploads 天然去重
          if (!forceUploads.has(rel)) pushWarning(`「${it.rel}」在云端是上次没传完的不完整文件，已自动重新上传`)
          forceUploads.add(rel)
          continue // 意图保持开放：强制重传的新意图将以「新者取代旧者」了结它
        }
        if (verdict === 'mismatch') {
          // 远端虽小于本地但内容并非本地前缀 —— 对端真实修改，确定非己方半截，放弃
          await settle(false, `崩溃恢复：${it.rel} 远端内容与本地不符（非本机半截），按冲突处理`)
          continue
        }
        // verdict === null：GET 失败 / 大小漂移 —— 保持开放，本轮正常规划（可能进冲突），下轮再判
        continue
      }
      // 保守路径（服务器原子未落地 / 对端改大 / 远端不存在等）：保持开放，正常规划照旧
      continue
    }
    if (it.op === 'download') {
      const rp = it.remote || {}
      const remoteOk =
        r &&
        r.size === rp.size &&
        (!rp.etag || rp.etag === (r.etag || '')) &&
        Math.abs((r.mtimeMs || 0) - (rp.mtimeMs || 0)) <= REMOTE_FP_TOL_MS
      if (remoteOk && l && l.size === rp.size) {
        const lhash = await hashFile(l.abs).catch(() => null)
        let contentOk = true
        if (lhash != null && r.size <= vMax) {
          const rh = await adoptVerifyGet(rel, r)
          if (rh !== false && rh != null) contentOk = rh === lhash
        }
        if (contentOk) {
          let wrote = false
          try {
            await store.setEntry(rel, entryFrom(l, r, lhash, { origName: r.origName }))
            wrote = true
          } catch (_) {}
          await settle(wrote, wrote ? `崩溃恢复：${it.rel} 已按意图日志采纳（无重传、无冲突）` : null)
          continue
        }
        // 内容不符（同 size 对端替换）不采纳：放弃后由规划按无基线语义重新收敛
      }
      await settle(false, null)
      continue
    }
    // 删除类 / 未知操作：一律放弃（幂等重推导语义不变）
    await settle(false, null)
  }
  // 汇总：预算耗尽而回退「按大小采纳」的条目 —— 一条 warning 带计数，不逐文件刷屏
  //（同尺寸对端替换可能被静默采纳的窄洞与 GET 失败回退同源，见 README 已知边界）
  if (adoptBudgetSkipped.length > 0) {
    const fmtMB = (n: any) => `${(n / (1024 * 1024)).toFixed(1)}MB`
    logNote(
      `崩溃恢复：${adoptBudgetSkipped.length} 个文件的采纳内容确认超出本轮预算（${fmtMB(adoptBudgetBytes)}），已按大小采纳（窄洞见 README 已知边界）`
    )
  }
  return forceUploads
}

/**
 * 获取目录级租约锁。调用时机（锁后置 + 按需）：runSyncRound 规划完成后、
 * B 档写前查重与 worker 执行之前，且仅当本轮剩余计划含远端写操作时才被调用
 *（空轮 / 纯下载轮零锁请求；详见 runSyncRound 内「按需拿锁」注释）。
 *
 * 状态机（返回值 outcome）：
 *   'acquired' —— 已获得锁（可附带 warn：回读异常但按已获得处理的尽力而为 warning）
 *   'yield'    —— 他人持有有效锁（未过期且非本机遗留）或写回竞争失败：本轮让出
 *   'skip'     —— 无法读写锁（PUT 403/401、GET 非 404/200、网络失败等）：跳过租约继续同步
 *
 * 服务器时钟过期判定（**只用服务器时钟**，绝不用本机时钟 —— 本机时钟偏移会误判）：
 *   响应头 date（服务器当前时间）− last-modified（锁文件 mtime）≥ ttlMs → 过期。
 *   Date / Last-Modified 头缺失或不可解析时差值为 NaN，比较恒为 false → 不判过期
 *   （保守让出，绝不偷走无法证明已过期的锁；自己的遗留仍可按 deviceId 接管，
 *   真实过期场景由「配合的服务器都会发 Date 头」兜底 —— HTTP/1.1 服务器应答
 *   Date 属 SHOULD 级要求，缺失属异常服务器）。
 * @param cfg 连接配置（含整轮熔断器；锁请求计入轮次开销）
 * @param lockPath 锁文件远端绝对路径（joinRemote(dir.remotePath, LOCK_NAME)）
 * @param deviceId 本机设备 ID
 * @returns {Promise<{outcome: 'acquired'|'yield'|'skip', warn?: string, startedAt?: string}>}
 *          startedAt 仅在 acquired 时返回（首次获取时刻，续租时保持不变）
 */
async function acquireLeaseLock(cfg: EngineCfg, lockPath: string, deviceId: string): Promise<any> {
  // 1. GET 现锁：404 → 空闲；200 → 解析内容与服务器时钟年龄
  let state: any = null // null = 空闲；否则 { own, expired }（损坏内容直接按过期处理）
  try {
    const r = await davRequest(cfg, 'GET', lockPath)
    if (r.status === 200) {
      let body: any = null
      try {
        body = JSON.parse(r.body ? r.body.toString('utf-8') : '')
      } catch (_) {
        body = null
      }
      if (!body || typeof body !== 'object') {
        state = { own: false, expired: true } // 内容损坏：视为过期 → 接管
      } else {
        const ttl = Math.min(LOCK_TTL_MAX_MS, Math.max(LOCK_TTL_MIN_MS, Number(body.ttlMs) > 0 ? Number(body.ttlMs) : LOCK_TTL_MS))
        const dateMs = Date.parse((r.headers && r.headers.date) || '')
        const lmMs = Date.parse((r.headers && r.headers['last-modified']) || '')
        const expired = Number.isFinite(dateMs) && Number.isFinite(lmMs) && dateMs - lmMs >= ttl
        state = { own: String(body.deviceId || '') === deviceId, expired }
      }
    } else if (r.status !== 404) {
      // 401/403/5xx 等异常：读不到锁就无法安全判定 → 与「无法写锁」同路径跳过租约
      return { outcome: 'skip', warn: `无法读取租约锁（HTTP ${r.status}）：本轮仅依赖档位保护` }
    }
  } catch (e: any) {
    // 取消销毁了取锁请求 → 静默按 skip 收场（锁未持有、轮次即将按取消终止，
    // 不产生「无法读取租约锁」的用户噪声）
    if (e && e.code === 'ABORTED') return { outcome: 'skip' }
    return { outcome: 'skip', warn: `无法读取租约锁（${(e && e.message) || e}）：本轮仅依赖档位保护` }
  }
  // 他人持有且未过期（服务器时钟年龄 < ttl 且非本机遗留）→ 让出；其余（空闲 / 过期 /
  // 自己的遗留 / 内容损坏）→ 接管
  if (state && !state.own && !state.expired) return { outcome: 'yield' }

  // 2. PUT 本机锁内容（覆盖旧锁 = 接管；写失败 → 跳过租约继续同步，走档位保护）
  const startedAt = new Date().toISOString()
  try {
    const r = await davRequest(cfg, 'PUT', lockPath, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, deviceId, startedAt, ttlMs: LOCK_TTL_MS }),
    })
    if (r.status >= 400) {
      return { outcome: 'skip', warn: `无法创建租约锁（HTTP ${r.status}）：本轮仅依赖档位保护` }
    }
  } catch (e: any) {
    // 取消销毁了写锁请求 → 静默按 skip 收场（同上方 GET 路径的取消豁免）
    if (e && e.code === 'ABORTED') return { outcome: 'skip' }
    return { outcome: 'skip', warn: `无法创建租约锁（${(e && e.message) || e}）：本轮仅依赖档位保护` }
  }

  // 3. 静置后回读确认：他机同刻写锁（写回竞争）在该窗口后暴露 —— 回读到别人的
  //    deviceId 说明竞争失败，让出；GET 失败按已获得处理（尽力而为，不因服务器
  //    抖动放弃整轮互斥机会）。回读内容损坏同按已获得（下一台设备会按过期接管）。
  await sleep(LOCK_SETTLE_MS)
  try {
    const r = await davRequest(cfg, 'GET', lockPath)
    if (r.status === 200) {
      let body: any = null
      try {
        body = JSON.parse(r.body ? r.body.toString('utf-8') : '')
      } catch (_) {
        body = null
      }
      if (body && typeof body === 'object' && String(body.deviceId || '') !== deviceId) {
        return { outcome: 'yield' } // 写回竞争失败：别人的内容在锁文件里
      }
      return { outcome: 'acquired', startedAt, warn: body ? undefined : '租约锁回读内容损坏：按已获得处理（尽力而为）' }
    }
    return { outcome: 'acquired', startedAt, warn: `租约锁回读异常（HTTP ${r.status}）：按已获得处理（尽力而为）` }
  } catch (e: any) {
    // 取消销毁了回读请求 → 锁已写入，按已获得处理且不告警（外层 finally 会
    // 照常 DELETE —— 释放请求同样豁免取消检查）
    if (e && e.code === 'ABORTED') return { outcome: 'acquired', startedAt }
    return { outcome: 'acquired', startedAt, warn: `租约锁回读失败（${(e && e.message) || e}）：按已获得处理（尽力而为）` }
  }
}

/**
 * 同步单个目录的公开入口（同目录单轮互斥包装）。
 *
 * 同一「本地目录 × 远端目录」在**本进程内**同时只允许一个轮次：调度层误排 /
 * 手动触发与定时轮重叠时，后到的调用立即按零计数成功返回（concurrent: true），
 * 不排队堆叠、不报错 —— 让出语义与租约锁的跨设备让出一致。跨设备 / 跨进程的
 * 互斥由轮次内部的远端租约锁负责，两层各管一边。
 *
 * 返回值除 runSyncRound 的汇总字段外，本包装的让出路径额外携带 concurrent: true；
 * 正常轮次不携带该字段（falsy）。
 */
async function syncDirectory(cfg: EngineCfg, dir: DirCfg, prefs: EnginePrefs, handlers: SyncHandlers): Promise<any> {
  const mutexKey = `${storage.normalizeLocalKey(dir && dir.localPath)}|${storage.normalizeRemoteKey(dir && dir.remotePath)}`
  if (ROUND_IN_FLIGHT.has(mutexKey)) {
    return {
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferredConflicts: 0,
      adopted: 0,
      bytesUp: 0,
      bytesDown: 0,
      totalFiles: 0,
      tier: 'B',
      warnings: ['这个文件夹正在同步中，本次跳过'],
      errors: [],
      errorsDropped: 0,
      /** 该目录已有同进程轮次在进行：本轮立即让位（非错误） */
      concurrent: true,
    }
  }
  ROUND_IN_FLIGHT.set(mutexKey, true)
  // 同步记录（sync-log.json）的轮次起止：开始时刻在进入轮体前定格 —— 锁等待 /
  // 队列耗时属于「这次同步」的一部分，记录的是用户感知的起止窗口
  const roundStartAt = Date.now()
  let roundSummary: any = null
  let roundError: any = null
  try {
    roundSummary = await runSyncRound(cfg, dir, prefs, handlers)
    return roundSummary
  } catch (e: any) {
    roundError = e
    // 轮内已收尾的错误（执行期失败 / 取消 / 熔断 / 崩溃注入）都带
    // err.summary（含 failureClass）。这里只兜「轮次体直接抛出、未经轮末收尾」的路径
    //（扫描期网络异常 / CIRCUIT_OPEN 快速失败 / 意外 bug）：补一个零计数的最小 summary
    // 与 failureClass，保证调度层在任何失败形态下都有机器可读的退避输入。
    // 崩溃注入错误已有 summary，不会进入此分支。
    if (e && typeof e === 'object' && !e.summary) {
      e.failureClass = e.failureClass || (networkFailure(e) ? 'network' : 'other')
      e.summary = {
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        deferredConflicts: 0,
        adopted: 0,
        bytesUp: 0,
        bytesDown: 0,
        totalFiles: 0,
        tier: 'B',
        warnings: [],
        errors: [e && e.message ? e.message : String(e)],
        errorsDropped: 0,
        failureClass: e.failureClass,
      }
    }
    throw e
  } finally {
    // 正常 / 异常 / 取消 / 崩溃注入（同进程内注入不是真死）一律放行后续轮次 ——
    // 崩溃注入只模拟「进程死亡」的收尾语义，真实场景进程已不存在、Map 随之消失
    ROUND_IN_FLIGHT.delete(mutexKey)
    // 同步记录落盘（best-effort，任何异常都不影响轮次结果的上抛）：
    // 崩溃注入路径跳过 —— 模拟进程死亡不做任何收尾，记录同样不写；
    // 并发让位轮（concurrent）在上方提前 return，不经过本 finally
    if (!(roundError && roundError.__wdsyncCrash)) {
      try {
        const cancelled = !!(roundError && (roundError.code === 'ABORTED' || (typeof handlers?.shouldAbort === 'function' && handlers.shouldAbort())))
        const st = await storage.openDirStore({ localPath: dir && dir.localPath, remotePath: dir && dir.remotePath })
        st.appendSyncLog(buildSyncLogEntry({ handlers, at: roundStartAt, summary: roundSummary || (roundError && roundError.summary) || null, error: roundError, cancelled }))
        await st.saveSyncLog().catch(() => {})
      } catch (_) {
        /* 同步记录写入失败无害：纯展示性审计信息 */
      }
    }
    // 摘要离开引擎前剥离内部采集器引用：__syncOps 只服务于同步记录落盘，
    // 不得随 round-end 事件进渲染层、更不能被渲染层持久化进配置（非展示字段）
    if (roundSummary) delete roundSummary.__syncOps
    if (roundError && roundError.summary) delete roundError.summary.__syncOps
  }
}

/**
 * 组装一条同步记录（syncDirectory 轮末收尾专用；纯函数，不落盘）。
 * 触发方式取 hints.source（调度器轮次 kind / 渲染层直调的 'manual'；
 * 'manual-delegated' 是多实例委托代跑的手动轮，展示口径并入 'manual'），
 * 一次性单向操作取 hints.op。status 判定顺序：用户取消 → 让出（零传输）→
 * 失败 → 部分完成（有挂起冲突 / 待确认删除等用户待处理项）→ 成功。
 * 逐文件操作明细读 summary.__syncOps（引擎轮内同一数组引用贯穿全部
 * 退出路径 —— 成功轮 / 执行期错误轮 err.summary / 扫描期错误轮的 spread 副本
 * 都携带同一引用；轮次体直接抛出、未经轮末收尾的失败轮没有该字段 → 空明细）。
 * @param opts.handlers 引擎回调句柄（取 hints.source / hints.op / shouldAbort）
 * @param opts.at 轮次开始时刻（毫秒）
 * @param opts.summary 轮次摘要（成功轮为返回值；失败轮取 err.summary；缺失按零计数）
 * @param opts.error 失败轮的错误（成功轮为 null）
 * @param opts.cancelled 是否以取消语义收场（shouldAbort 仍为真 / ABORTED 错误码）
 */
function buildSyncLogEntry(opts: { handlers: any; at: number; summary: any; error: any; cancelled: boolean }): SyncLogEntry {
  const handlers = opts.handlers || {}
  const hints = handlers.hints || {}
  const rawTrigger = typeof hints.source === 'string' && hints.source ? hints.source : 'manual'
  const summary = opts.summary || {}
  const errors: string[] = Array.isArray(summary.errors) ? summary.errors.map((s: any) => String(s)) : []
  const entry: SyncLogEntry = {
    at: opts.at,
    endAt: Date.now(),
    trigger: rawTrigger === 'manual-delegated' ? 'manual' : rawTrigger,
    status: 'ok',
    uploaded: Number(summary.uploaded) || 0,
    downloaded: Number(summary.downloaded) || 0,
    deleted: Number(summary.deleted) || 0,
    conflicts: Number(summary.conflicts) || 0,
    adopted: Number(summary.adopted) || 0,
    deferredConflicts: Number(summary.deferredConflicts) || 0,
    deleteHeld: Number(summary.deleteHeld) || 0,
    bytesUp: Number(summary.bytesUp) || 0,
    bytesDown: Number(summary.bytesDown) || 0,
    totalFiles: Number(summary.totalFiles) || 0,
    ops: Array.isArray(summary.__syncOps) ? summary.__syncOps : [],
    errors: errors.slice(0, 200),
  }
  if (Number(summary.errorsDropped) > 0) entry.errorsDropped = Number(summary.errorsDropped)
  if (hints.op === 'pull' || hints.op === 'push' || hints.op === 'pull-full' || hints.op === 'push-full') entry.op = hints.op
  if (opts.cancelled) {
    entry.status = 'cancelled'
  } else if (summary.yielded) {
    entry.status = 'yielded'
  } else if (opts.error) {
    entry.status = 'error'
    const msg = opts.error && opts.error.message ? String(opts.error.message) : String(opts.error)
    entry.error = msg.slice(0, 500)
  } else if (entry.deferredConflicts > 0 || entry.deleteHeld > 0) {
    entry.status = 'partial'
  }
  return entry
}

/**
 * 同步单个目录。
 * cfg:      { serverUrl, username, password }
 * dir:      { id, localPath, remotePath, mode: 'two-way'|'upload'|'download' }
 * prefs:    { ignoreHidden, concurrency, conflictStrategy: 'ask'|'local'|'remote'|'both',
 *             verifyMaxBytes?, deepVerify?, deepVerifyDays?, adoptVerifyBudgetBytes?,
 *             excludePatterns?（用户排除规则，扫描层与 ignoreHidden 独立生效） }
 * handlers: { onProgress(p), onConflict(info) -> Promise<choice | { choice, applyToRemaining } | 'defer'>,
 *             shouldAbort(), afterTransferOp?（测试崩溃注入专用，勿在产品代码使用） }
 * 返回汇总 { uploaded, downloaded, deleted, conflicts, deferredConflicts, adopted, bytesUp,
 *           bytesDown, totalFiles, tier, warnings[], errors[], errorsDropped,
 *           failureClass?, openIntents, breaker? }；存在文件级失败时抛错
 *（err.summary / err.errors 附带；err.summary 同样携带 failureClass 等机器可读字段，
 *  扫描期失败的错误也附带最小 err.summary 与 err.failureClass）。
 * tier 为本轮生效的服务器档位（A 条件保护 / B 复查 / C 只读）。
 * 调度层输入字段：
 *   failureClass      —— 存在文件级失败时 'network' | 'mixed' | 'other'（成功轮不设；
 *                        按 pushError 增量累计归纳，被截断到 200 条之外
 *                        的错误同样参与，不随 errorsDropped 丢失）；
 *   openIntents       —— 轮末仍开放的 upload 意图数（follow-up 后续轮判定输入）；
 *   breaker           —— 熔断轮附带 { open, consecutive, reason }；
 *   deferredConflicts —— onConflict 返回 'defer' 挂起（不报错、本轮跳过）的冲突数，
 *                        挂起记录无 choice，供 listPendingConflicts / setPendingChoice
 *                        统一处理；「部分完成，有 N 个待处理冲突」即由该字段表达。
 *
 * 目录级状态机：
 *   SCAN → PLAN（变化判定 + hash 消歧 + WAL 恢复；verify 并发池，进度经 plan 阶段外发）
 *        → EXECUTE（意图 → 操作 → 基线）→ FINALIZE
 *     └─ 扫描不完整 → ERROR（未发起任何传输）
 *
 * 与旧引擎（远端 manifest）的关键行为差异：
 *   - 每个文件验证成功后立即写本机基线（intent → op → done），单文件失败不再使
 *     整轮「回滚」其他已成功文件 —— 但轮末仍以 error 状态上报失败清单；
 *   - 崩溃（进程死亡）由 WAL + 下一轮恢复采纳，不再依赖远端中间状态；
 *   - 无基线 / 基线损坏的轮次禁用一切删除传播（无基线保护）。
 *
 * 核心不变量：
 *   I1 扫描不完整 ⇒ 本轮不产生任何计划（更不会删除）
 *   I2 删除失败   ⇒ 该文件基线条目保留
 *   I3 基线指纹与实际传输内容同源（上传前/后双重 stat + 边传边算 hash）
 *   I4 下载期间目标被修改 ⇒ 拒绝覆盖
 *   I5 基线损坏 ≠ 首次同步：按无基线保护模式执行，绝不删除
 *   I6 引擎不依赖窗口 / Vue / store：进度、冲突、结果、错误全部经 handlers 回调外发，
 *      shouldAbort 由调用方注入（调度器位于 preload 的接口预留）
 */
async function runSyncRound(cfg: EngineCfg, dir: DirCfg, prefs: EnginePrefs, handlers: SyncHandlers): Promise<any> {
  // onProgress 统一经时间节流（相位首事件与终态事件不受限，见
  // throttledProgress 注释）—— 数万文件轮次的逐文件 tick 不再以 kHz 级频率
  // 回调渲染层（直调引擎的无调度器形态下每个事件都是一次 Vue 响应式更新）
  const onProgress = throttledProgress((handlers && handlers.onProgress) || (() => {}))
  const shouldAbort = (handlers && handlers.shouldAbort) || (() => false)
  // afterTransferOp：操作已成功、基线尚未写入时被调用；抛错 = 模拟进程崩溃
  //（不写 abort、不写基线），下一轮由 WAL 恢复。仅供测试崩溃注入。
  const afterTransferOp = (handlers && handlers.afterTransferOp) || null
  // 整轮熔断：本轮全部网络请求共用一个实例（经 cfg 注入网络层），
  // 连续网络类终态失败达阈值后剩余请求快速失败并终止轮次。
  // __wdsyncAbort：shouldAbort 一并经 cfg 注入网络层 —— 取消时在途请求被
  // 轮询销毁（singleRequest），不再等大文件传完。锁释放 / 批量校验等收尾请求会显式
  // 置空该字段以豁免（取消路径的收尾语义不受影响，见各豁免点注释）。
  const roundBreaker = createRoundBreaker()
  cfg = { ...cfg, __wdsyncBreaker: roundBreaker, __wdsyncAbort: shouldAbort }
  const tmpDir = dir.localPath
  const mode = dir.mode || 'two-way'
  // 一次单向操作（「云端补齐本地 / 云端覆盖本地 / 本地补齐云端 / 本地覆盖云端」）：
  // 经 handlers.hints.op 注入，仅对本轮规划生效（decideAction 的 oneshot 分支
  // 凌驾于 dir.mode 之上）；非法值按常规轮处理
  const rawOp = handlers && handlers.hints ? handlers.hints.op : undefined
  const opHint = rawOp === 'pull' || rawOp === 'push' || rawOp === 'pull-full' || rawOp === 'push-full' ? rawOp : null
  const verifyMaxBytes = Number(prefs.verifyMaxBytes) > 0 ? Number(prefs.verifyMaxBytes) : DEFAULT_VERIFY_MAX_BYTES
  // 采纳内容确认的单轮总字节预算，默认 verifyMaxBytes × 4（见
  // ADOPT_VERIFY_BUDGET_FACTOR 的依据注释）；prefs.adoptVerifyBudgetBytes > 0 时覆盖
  const adoptVerifyBudgetBytes =
    Number(prefs.adoptVerifyBudgetBytes) > 0 ? Number(prefs.adoptVerifyBudgetBytes) : verifyMaxBytes * ADOPT_VERIFY_BUDGET_FACTOR
  const summary: any = {
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    conflicts: 0,
    /**
     * 经 onConflict 返回 'defer' 挂起、本轮跳过未解决的冲突数。
     * defer 路径不报错（与「无回调 / 非法值」的抛错路径不同）：后台轮由调度器统一
     * defer，其余文件照常同步，轮次以「部分完成，有 N 个待处理冲突」收场。
     */
    deferredConflicts: 0,
    adopted: 0,
    bytesUp: 0,
    bytesDown: 0,
    totalFiles: 0,
    /** 本轮生效的服务器档位（A 强条件保护 / B 复查尽力 / C 只读） */
    tier: 'B',
    warnings: [] as string[],
    errors: [] as string[],
    errorsDropped: 0,
    /** 批量删除确认挂起数：超过阈值的待删整批登记「待确认删除」，确认前零删除 */
    deleteHeld: 0,
    /** 用户选择「保留不删」（删除挂起 choice='keep'）而抑制的删除数（仅 delete-remote：云端副本保留） */
    deleteKept: 0,
    /** 「不删除」决策命中 delete-local（云端已缺、本地完好）而恢复上传的文件数（云端副本由本地上传恢复） */
    deleteRestored: 0,
    /** 远端根重建保护跳过的删除数（待重新上传和解，清零后恢复删除传播） */
    deleteRootGuard: 0,
    /** 空目录清理：本地 / 远端移除的空目录数（仅清理因本轮同步删除而变空的目录） */
    dirsPrunedLocal: 0,
    dirsPrunedRemote: 0,
  }
  /**
   * 逐文件操作明细的采集器（同步记录详尽视图的数据源，syncDirectory 轮末经
   * summary.__syncOps 读取 —— 同一数组引用贯穿全部退出路径）。只记录
   * 「已落地成功」的操作：上传在批量校验提交点、下载 / 删除在各自完成点、
   * 冲突在用户选择落地时；失败不在此列 —— 经轮末 errors 清单回看，且避免
   * 瞬时重试（当轮先败后成）造成同一文件的双记噪声。全量记录不截断：
   * 大轮次的展示完整性由渲染层虚拟滚动承担，计数摘要始终是全量真值。
   */
  const syncOps: SyncLogOp[] = []
  summary.__syncOps = syncOps
  const recordSyncOp = (op: SyncLogOp) => {
    syncOps.push(op)
  }
  const pushWarning = (w: any) => {
    if (summary.warnings.length < 200) summary.warnings.push(w)
  }
  // 内部提示经模块级 logNote 写日志（见其定义处）
  /**
   * 网络类 / 非网络类错误的**增量累计计数**（与 pushError 同步维护）。
   * 旧实现按 summary.errors（展示截断到 200 条）+ 等长标记数组归纳 failureClass，
   * 单轮错误超过 200 条时被截断的错误不参与归纳 —— 大目录的批量校验组级失败 /
   * B 档写前查重失败（每文件一条错误）等场景会把后到的类目整段丢掉，轮末分类
   * 失真（如 250 条网络类 + 60 条永久类被归纳成 network）。计数器对每次 pushError
   * 调用（无论该条是否保留进 errors）都累计，轮末据此归纳，归纳口径与错误列表的
   * 展示截断（200 条 + errorsDropped）解耦。
   */
  let errorNetCount = 0
  let errorOtherCount = 0
  const pushError = (w: any, isNetwork: any) => {
    if (isNetwork === true) errorNetCount++
    else errorOtherCount++
    if (summary.errors.length < 200) summary.errors.push(w)
    else summary.errorsDropped++
  }

  onProgress({ phase: 'scan', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, stage: 'scan' })

  // 清理上一轮崩溃残留的临时文件，再进入扫描 —— 避免清理与扫描器竞态
  await cleanupOrphanTemps(dir.localPath)
  const store = await storage.openDirStore({ localPath: dir.localPath, remotePath: dir.remotePath })
  if (!store.loadedOk) logNote('基线快照损坏：本轮按无基线保护模式执行（禁用删除传播）')
  // etag 跳过缓存：被跳过的子树要按基线合成远端条目，快照损坏
  //（loadedOk=false）时没有可信基线可合成 → 禁用跳过，强制全量列举
  const scanCache = store.loadedOk ? store.getScanCache() : null

  /**
   * 轮末统一补齐调度器需要的机器可读字段：
   *   failureClass —— 有过 pushError（含被截断丢弃的，按增量累计）时归纳为
   *                   'network'（全部网络类）/ 'mixed' / 'other'（全部非网络类）；
   *                   无错误不设该字段（成功轮）。调度层据此决定跨轮退避，不再靠
   *                   正则猜错误文案；
   *   openIntents  —— 轮末仍开放的 upload 意图数（follow-up 短延迟后续轮的判定输入；
   *                   数值来自本轮最终内存态，含本轮新留下的与上一轮遗留的）；
   *   breaker      —— 熔断轮附带 { open, consecutive, reason }（UI「服务器连续无响应」
   *                   归因与退避输入）。
   * 让出 / 正常 / 部分失败各收尾路径统一调用；crashErr（模拟进程死亡）不调用。
   */
  const finalizeSummaryMeta = () => {
    if (errorNetCount + errorOtherCount > 0) {
      summary.failureClass = errorNetCount === 0 ? 'other' : errorOtherCount === 0 ? 'network' : 'mixed'
    }
    summary.openIntents = Array.from(store.pendingIntents.values()).filter((p) => p.op === 'upload').length
    if (roundBreaker.open) {
      summary.breaker = { open: true, consecutive: roundBreaker.consecutive, reason: roundBreaker.reason }
    }
  }


  // 1a. 左锁优先清理：上一轮「释放失败」记下的 lockLeftover 标记在本轮开头
  //     补删远端锁（建根之前、best-effort）。删除成功（404/2xx）即清标记；失败保留
  //     标记下一轮再试。不依赖 prefs.leaseLock 开关 —— 这是修复动作：即便用户随后
  //     关闭了租约锁，也要把上一轮留下的远端残留清走。DELETE 走无熔断 cfg + 单次
  //     尝试（与释放同口径：熔断触发时网络可能仍可用）。
  if (store.meta.lockLeftover) {
    try {
      const r = await davRequest({ ...cfg, __wdsyncBreaker: null }, 'DELETE', joinRemote(dir.remotePath, LOCK_NAME), { noRetry: true })
      if (r.status < 400 || r.status === 404) {
        delete store.meta.lockLeftover
        await store.saveMeta().catch(() => {})
      }
    } catch (_) {
      /* 网络不可用：保留标记，下一轮再试 */
    }
  }

  // 1. 确保远端根目录存在（目标为集合：URL 带尾斜杠发起）。
  //    扫描期失败的错误附带 failureClass（调度层跨轮退避的机器可读输入）——
  //    5xx/429/423 归 network（与 networkFailure 同口径），401/403/404 等配置类归 other
  const rootProbe = await davRequest(cfg, 'PROPFIND', dir.remotePath, { isCollection: true, headers: { Depth: '0' } })
  // 根探测状态归一：部分网关 / 服务对缺失集合不回 HTTP 404，而是 207 + 集合自身
  // 条目携带 404 propstat（扫描层 listRemoteSafe 对同形态另有识别，此处归一后
  // 下游的决策闸 / 选择消费 / 重建逻辑全部按 404 复用）。解析失败按状态码原语义。
  let rootProbeStatus = rootProbe.status
  if (rootProbeStatus === 207 || rootProbeStatus === 200) {
    try {
      const probeItems = parseMultistatus(rootProbe.body ? rootProbe.body.toString('utf-8') : '')
      const selfGone = probeItems.some(
        (it: any) => it && !relFromHref(cfg, dir.remotePath, it.href).replace(/\/+$/, '') && /404/.test(String(it.status || ''))
      )
      if (selfGone) rootProbeStatus = 404
    } catch (_) {
      /* 畸形 body：按状态码判定（207 → 照常进入扫描，由扫描层给结论） */
    }
  }
  // 本轮是否处于「移除本地」决策的执行态（choice 消费轮或标记延续轮）：
  // 仅用于 rootWasRebuilt 处的提示文案分支（移除轮不能说「文件会重新上传」）
  let rootRemovalArmed = false
  /**
   * 远端根丢失的统一停轮：登记（或沿用）kind='root-lost' 待决策挂起并抛出
   * root-lost 错误 —— 决策落地前零删除零传输。登记条目 local.size 携带受影响的
   * 基线文件数（决策弹窗展示用）；已有挂起（含已带 choice 的）不覆盖，避免把
   * 用户已做出的选择冲掉。调度器据 summary.rootLostHeld 触发一次性系统提醒，
   * 渲染层据 pending-conflicts 事件弹出决策弹窗。
   */
  const stopForRootLost = async (): Promise<never> => {
    const existing = store.getPending(ROOT_LOST_PENDING_REL)
    if (!existing || existing.kind !== 'root-lost') {
      store.setPending(ROOT_LOST_PENDING_REL, {
        kind: 'root-lost',
        local: { size: store.entries.size, mtimeMs: Date.now() },
        remote: { size: 0, mtimeMs: 0, etag: '' },
        createdAt: Date.now(),
      })
      await store.savePendings().catch(() => {})
    }
    // summary 附在错误上：调度器 round-end 事件用它把 rootLostHeld 送达渲染层
    //（弹决策弹窗），并作为一次性系统提醒的触发输入
    summary.rootLostHeld = 1
    throw syncFail(`云端同步文件夹「${dir.remotePath}」已不存在，需要你确认处理方式：把电脑上的文件重新上传到云端，或把电脑上已同步的文件也删除`, {
      phase: 'root-lost',
      failureClass: 'other',
      summary,
    })
  }
  if (rootProbeStatus === 404) {
    if (store.entries.size === 0) {
      // 基线为空（首次同步 / 内容已和解）：无内容可保护，维持自动重建
      await mkdirDeep(cfg, dir.remotePath)
    } else {
      // ---- 远端根丢失决策闸（基线非空：本地有内容，去留必须由用户决定）----
      // 云端同步根消失可能是「用户在网页端删除了它」（此时自动重建 + 全量重传会
      // 违背用户意图），也可能是服务器瞬时故障 / 目录被挪动 —— 引擎无法区分，
      // 因此不再自动重建，挂起等待用户二选一：
      //   upload       —— 重建云端文件夹并按根重建保护语义恢复上传（既有 DS4 链路）；
      //   remove-local —— 跟随云端删除：meta.rootLostRemoval 标记使规划期的
      //                   delete-local 按用户已确认执行（移入回收站），未决的逐文件
      //                   删除确认挂起随之作废（根级决策已覆盖其问题）。
      // 选择前每轮以 root-lost 错误收场（不重建、不传输、零删除）；根在决策前恢复
      // （挪动回去 / 服务器瞬时 404）则挂起记录自动撤销，无需用户操作。
      const lostRec = store.getPending(ROOT_LOST_PENDING_REL)
      const lostChoice = lostRec && lostRec.kind === 'root-lost' ? lostRec.choice : undefined
      if (lostChoice === 'upload') {
        // 消费「重新上传」选择。保护标记先于 MKCOL 写入：建根失败（网络瞬时故障）
        // 的重试轮命中下方 rootRebuilt 分支继续恢复，不再重复打扰用户
        store.clearPending(ROOT_LOST_PENDING_REL)
        await store.savePendings().catch(() => {})
        if (!store.meta.rootRebuilt) store.meta.rootRebuilt = { at: Date.now() }
        await store.saveMeta().catch(() => {})
        await mkdirDeep(cfg, dir.remotePath)
      } else if (lostChoice === 'remove-local' || store.meta.rootLostRemoval) {
        // 消费「移除本地」选择（或标记延续轮：上轮选择后未和解完毕）。标记先于
        // MKCOL 写入，建根失败的重试轮直接走同一分支；未决的逐文件删除确认挂起
        // 在首次消费时作废（根级「移除」已回答它们的问题；keep 保留类不受影响，
        // 由逐文件挂起独立持续抑制）
        if (!store.meta.rootLostRemoval) {
          store.meta.rootLostRemoval = { at: Date.now() }
          for (const p of store.listPending()) {
            if (p.kind === 'delete') store.clearPending(p.rel)
          }
        }
        if (lostRec) {
          store.clearPending(ROOT_LOST_PENDING_REL)
          await store.savePendings().catch(() => {})
        }
        await store.saveMeta().catch(() => {})
        await mkdirDeep(cfg, dir.remotePath)
        rootRemovalArmed = true
      } else if (store.meta.rootRebuilt) {
        // 恢复进行中（此前已选「重新上传」且尚未和解，根又一次 404）：按既有保护
        // 语义继续重建重传，不再打断 —— 决策只在「全新丢失」时询问一次
        await mkdirDeep(cfg, dir.remotePath)
      } else {
        // 未决策（首次发现或重试）：登记挂起并停轮
        await stopForRootLost()
      }
    }
  } else if (rootProbeStatus >= 400) {
    const st = rootProbe.status
    throw syncFail(`无法访问云端文件夹（HTTP ${st}）`, { phase: 'scan', failureClass: st === 429 || st === 423 || st >= 500 ? 'network' : 'other' })
  } else if (store.getPending(ROOT_LOST_PENDING_REL)) {
    // 根已恢复（决策前用户把文件夹挪了回来 / 服务器瞬时 404）：撤销未决策的挂起，
    // 本轮照常同步。meta.rootLostRemoval 不在此撤销 —— 移除执行未和解完毕前必须
    // 延续（见轮末解除判定），其语义不受根恢复影响
    store.clearPending(ROOT_LOST_PENDING_REL)
    await store.savePendings().catch(() => {})
  }
  /**
   * 远端根 404 后被重建（本轮探测到 404 并 MKCOL）且本地基线非空：
   * 远端「全部缺失」是根消失的伪象而非逐文件删除，本轮禁用删除传播
   *（delete-local 整类跳过 —— 真实场景下远端扫描为空，delete-remote 本就无法产生），
   * 本地文件按无基线恢复语义重新上传。标记写入 meta.rootRebuilt 并跨轮生效：
   * 重建轮之后仍可能有上传失败的文件停留在「本地未变 + 远端缺失」状态，下一轮
   * 若照常规划会把它们 delete-local 误删 —— 标记保持生效直至「待和解」清零
   *（全部基线文件要么重新上传成功、要么两侧皆无），届时自动恢复正常删除传播。
   * 用户经挂起通道显式确认过的删除（kind='delete', choice='delete'）不受此保护拦截。
   */
  const rootWasRebuilt = rootProbeStatus === 404 && store.entries.size > 0
  if (rootWasRebuilt) {
    if (!store.meta.rootRebuilt) store.meta.rootRebuilt = { at: Date.now() }
    pushWarning(
      rootRemovalArmed
        ? '云端文件夹已按你的选择重建，电脑上已同步的文件将被移除（有改动的文件会保留并重新上传）'
        : '云端的同步文件夹之前丢失了，已重新创建。为防止误删，暂时不会同步「删除」操作，电脑上的文件会重新上传，恢复后自动正常'
    )
  }

  /**
   * 1.2 本地根健康检查（远端根探测之后、扫描之前）：根目录不存在 / 不可读 /
   * 疑似未挂载（空目录 + 非空基线）→ 整轮中止，零删除零传输。放在根探测之后：
   * 远端不可达（网络类失败）优先按网络类归因上报（调度层退避输入的既有契约），
   * 本地根问题的报错不吞掉网络故障信号。
   */
  await checkLocalRootHealth(dir.localPath, store.entries.size)

  // 1.5 目录级租约锁的载体变量（锁后置）：获取动作移入 roundBody 的规划
  //     完成后（见下方「按需拿锁」），此处只保留释放 finally 需要读写的状态 ——
  //     lockHeld / renewTimer / lockPath 必须留在 roundBody 作用域之外，外层 finally
  //     才能继续覆盖 正常 / 熔断 / 取消 全部退出路径。crashErr 同理提升（测试崩溃
  //     注入在传输期抛出、必然已在拿锁之后；若崩溃发生在拿锁前，lockHeld=false，
  //     finally 自然空转 —— 防御性兜底）。
  let crashErr: any = null // afterTransferOp 抛错（测试崩溃注入）：模拟进程死亡，轮末不做任何收尾
  let lockHeld = false
  let renewTimer: any = null
  const lockPath = joinRemote(dir.remotePath, LOCK_NAME)

  // 轮次体（扫描 → 规划 → [按需拿锁 + B 档写前查重] → 执行 → 收尾）包进 roundBody：
  // 释放锁的 finally 才能覆盖全部退出路径 —— 正常结束 / 轮次 error（含 CIRCUIT_OPEN
  // 熔断终止）/ shouldAbort 取消，三条路径天然都经过同一 finally。未持锁（空轮 /
  // 纯下载轮 / skip / 关闭开关）时该包装同样成立（finally 里 lockHeld 为 false，
  // 直接跳过释放）。
  const roundBody = async () => {

    // 2. 三路并行：本地扫描 + 能力获取 + 远端扫描。能力结论决定远端扫描形态
    //    （depthInfinity 支持时单请求拿整棵树，见 listRemoteSafe），因此远端扫描
    //    依赖 caps 的 Promise；能力缓存命中（常态，7 天 TTL）时它几乎零耗时，
    //    本地与远端扫描仍近似并行。冷缓存轮次探测与两路扫描并发（探测写全部
    //    落在自己的 .wdsync-probe- 随机目录，扫描层按前缀排除，互不干扰）。
    //    用户排除规则（prefs.excludePatterns）在两侧扫描层统一生效。
    //    本地扫描带节流进度回调（phase='scan' 的 filesDone 递增事件）。
    const excludeMatcher = compileExcludePatterns(prefs.excludePatterns)
    const capsPromise = getSyncCapabilities(cfg, dir.remotePath)
    // 本地脏路径快速核对：仅 watch 来源 hints、脏集非空
    // 且不超 DIRTY_SCAN_MAX、基线可信（loadedOk —— 合成依赖基线，快照损坏时必须
    // 全量实测）时启用；否则全量 walk。hints.watcherKey 是调度器注册该目录
    // watcher 用的 id（`${instanceId}:${dirId}`），扫描成功后据此清理脏集。
    const hints = handlers && handlers.hints
    const dirtyList =
      hints && hints.source === 'watch' && Array.isArray(hints.dirtyPaths) ? (hints.dirtyPaths as string[]) : null
    const useDirty = !!dirtyList && dirtyList.length > 0 && dirtyList.length <= DIRTY_SCAN_MAX && store.loadedOk
    // etagSkipUsed：本轮是否把 scan-cache 的集合 etag 表传给了远端扫描（子集合
    // etag 未变即跳过其 PROPFIND）。Promise.all 必然先等扫描
    // promise 了结，随后读取该标记是安全的。
    let etagSkipUsed = false
    const [localScan, caps, remoteScan] = await Promise.all([
      dirtyList && useDirty
        ? scanDirtyFast(dir.localPath, dirtyList, store, prefs.ignoreHidden, excludeMatcher, (n) =>
            // 快速核对完成后强制报告一次最终计数（与全量扫描的终态送达同契约）
            onProgress({ phase: 'scan', filesDone: n, filesTotal: 0, bytesDone: 0, bytesTotal: 0, stage: 'scan' }, true)
          )
        : scanDirSafe(dir.localPath, prefs.ignoreHidden, excludeMatcher, (n) =>
            // 扫描进度事件经 force 外发：scanDirSafe 内部已按 SCAN_PROGRESS_MS 节流
            //（含末次强制报告），这里不再吃引擎层节流 —— 保证最终扫描计数必然送达
            onProgress({ phase: 'scan', filesDone: n, filesTotal: 0, bytesDone: 0, bytesTotal: 0, stage: 'scan' }, true)
          ),
      capsPromise,
      capsPromise.then((c) => {
        // etag 子树跳过的统一裁决（listRemoteSafe 只执行不判断，契约见其头注释）：
        //   - 逐目录形态（infinity 单请求已最优，无请求可省）；
        //   - 探测实测集合 etag 深层传播（etagPropagation=true：深层修改必然改变
        //     所有祖先集合 etag，「子集合 etag 未变 ⇒ 子树未变」才成立）；
        //   - 缓存存在、新鲜（ETAG_SKIP_FULL_SCAN_MS 内有过一次全量下降 —— 周期性
        //     全量把「服务器侧停止传播造成的界内滞后」限制在有界时间内）且含观测。
        // 任一条件不满足传 null（不跳过），行为与既有完全一致。
        const fresh =
          !!scanCache &&
          typeof scanCache.lastFullScanAt === 'number' &&
          Date.now() - scanCache.lastFullScanAt <= ETAG_SKIP_FULL_SCAN_MS
        const usable =
          !c.depthInfinity &&
          c.etagPropagation === true &&
          !!scanCache &&
          fresh &&
          scanCache.collections &&
          Object.keys(scanCache.collections).length > 0
        etagSkipUsed = usable
        return listRemoteSafe(cfg, dir.remotePath, prefs.ignoreHidden, excludeMatcher, {
          depthInfinity: c.depthInfinity,
          collectionEtasg: usable ? new Map(Object.entries(scanCache.collections)) : null,
        })
      }),
    ])
    // 扫描形态信息字段（引擎侧观测，渲染层不依赖；见 types.mts SyncSummary.scan）：
    // local = 'dirty'（基线合成 + 脏路径核对的快速形态，仅 watch 轮）| 'full'（全量
    // walk）；dirtyPaths 为本轮 watch hints 携带的脏路径数（回落全量的轮次也保留
    // 该计数，供观测「带了 N 条但未启用」的回落原因排查）。
    summary.scan = {
      remote: remoteScan.depth,
      skippedDirs: (remoteScan.skippedDirs || []).length,
      local: useDirty ? 'dirty' : 'full',
      dirtyPaths: dirtyList ? dirtyList.length : 0,
    }
    // 脏集消费：本地扫描已完成且未中止 → 恰好清除本轮核对过的这些路径。放扫描
    // 之后（清理语义 = 已核对消费）：扫描期间新到的 watch 事件路径不在快照里，
    // 留在集合中给下一轮；扫描失败 / 中止不清（本轮 localScan 未被采用到收尾，
    // 下一轮重新核对）。此后轮内任一失败（I1 闸门 / 传输错误）都不再恢复脏集 ——
    // 脏集只是加速手段，正确性由全量轮兜底，清了至多多跑一次全量。
    if (dirtyList && useDirty && hints && hints.watcherKey && !shouldAbort()) clearDirtyPaths(hints.watcherKey, dirtyList)

    // 2.5 单请求扫描的「浅响应」运行时阀门：能力探测已用嵌套探测文件
    //     验证过服务器确实返回深层条目，但能力缓存最长 7 天、且不排除按目录行为
    //     分歧 —— 若基线里有大量嵌套文件而 Depth:infinity 响应里一个嵌套条目都
    //     没有，最可能是服务器把 infinity 当 Depth:1 应答；残缺树会被决策层解读
    //     成「远端已删除」→ 批量 delete-local。阈值与批量删除闸同口径（只在大规模
    //     时拦截，个别深层文件真实被删不触发）；命中按「扫描不完整」中止整轮
    //    （I1 闸门接管：零删除、零传输）。已不完整的扫描（如根缺失上报）不再
    //     叠加本阀门。根重建 / 移除执行的窗口期（本轮或标记延续轮重建了云端根，
    //     「远端为空」是已知伪象且删除传播已被停用）必须跳过 —— 否则「重新上传」
    //     的恢复轮会撞阀门死循环，永远传不上去。命中同时把该服务器的缓存能力
    //     持久降级为 depthInfinity=false（best-effort）：下一轮起改用逐目录扫描
    //    （对只回第一层的服务器语义恰好正确），直到下次能力探测（TTL 过期 /
    //     手动重探）自然恢复 —— 避免「服务器永远浅应答、每轮都撞阀门」的死循环。
    if (
      remoteScan.complete &&
      remoteScan.depth === 'infinity' &&
      store.entries.size > 0 &&
      !rootWasRebuilt &&
      !store.meta.rootRebuilt &&
      !store.meta.rootLostRemoval
    ) {
      const shallowThreshold = Math.max(DELETE_BATCH_MIN, Math.ceil(store.entries.size * DELETE_BATCH_RATIO))
      let nestedBase = 0
      for (const k of store.entries.keys()) {
        if (String(k).includes('/')) {
          nestedBase++
          if (nestedBase > shallowThreshold) break
        }
      }
      if (nestedBase > shallowThreshold) {
        let nestedScan = false
        for (const k of remoteScan.files.keys()) {
          if (String(k).includes('/')) {
            nestedScan = true
            break
          }
        }
        if (!nestedScan) {
          remoteScan.complete = false
          remoteScan.errors.push({ rel: '.', message: 'Depth:infinity 响应未包含任何嵌套条目，疑似服务器只返回了第一层（为避免批量误删，本轮按扫描不完整处理）' })
          // 持久降级（浅应答服务器改成逐目录形态即可正常工作）：
          try {
            const state = await storage.openServerState(originOf(cfg), (cfg && cfg.username) || '')
            const cached = state.getCachedCapabilities(PROBE_TTL_MS)
            if (cached && cached.depthInfinity) {
              const toSave = { ...cached, depthInfinity: false }
              toSave.notes = [...(toSave.notes || []), 'Depth:infinity 响应疑似只返回第一层，已降级为逐目录扫描（下次能力探测自动恢复）']
              await state.saveCapabilities(toSave).catch(() => {})
            }
          } catch (_) {
            /* 降级失败不影响本轮中止语义：下一轮再撞阀门时重试 */
          }
        }
      }
    }

    // 3. 扫描完整性闸门（I1）：任一侧不完整 → 整轮中止。
    //    取消销毁了扫描期的在途 PROPFIND 时按取消语义收场 ——「扫描未完成」
    //    的误导性报错只留给真实的扫描故障。
    if (!localScan.complete || !remoteScan.complete) {
      if (shouldAbort()) throw syncFail('已取消同步', { phase: 'scan' })
      // 远端根级 404（根在探测后 / 扫描前的窗口内消失，或单请求形态的根缺失上报）
      // 与「部分目录读不出」是两类故障：前者正是「同步目标被删除」的场景，按根丢失
      // 决策闸处理（登记待决策、零删除零传输）；后者维持 I1 原语义。基线为空或
      // 「移除本地」执行中不适用 —— 前者无内容可保护，后者已有明确决策在执行。
      if (
        !remoteScan.complete &&
        localScan.complete &&
        store.entries.size > 0 &&
        !store.meta.rootLostRemoval &&
        (remoteScan.errors || []).some((e: any) => e && e.rel === '.' && String(e.message || '').includes('404'))
      ) {
        await stopForRootLost()
      }
      const scanProblems = [
        ...localScan.errors.map((e: any) => `本地 ${e.rel}: ${e.message}`),
        ...remoteScan.errors.map((e: any) => `远端 ${e.rel}: ${e.message}`),
      ]
      // 扫描失败的 failureClass（远端扫描失败属 network —— 服务器 /
      // 网络不可用，调度层据此退避）；仅本地扫描不完整归 other；双侧都不完整归 mixed
      const scanClass = !remoteScan.complete && !localScan.complete ? 'mixed' : !remoteScan.complete ? 'network' : 'other'
      // summary 携带「友好标题 + 逐条具体原因」：渲染层错误条据此把为什么读不出来
      //（404 / 403 / 网络中断…）展示出来，而不是只有一句笼统的停止说明无从行动
      const scanFailMsg = '没能完整读取文件列表，本次同步已停止，避免误删文件'
      const scanErr = syncFail(scanFailMsg, { phase: 'scan', errors: scanProblems, failureClass: scanClass })
      scanErr.detail = scanProblems[0]
      scanErr.summary = { ...summary, errors: [scanFailMsg, ...scanProblems], failureClass: scanClass }
      throw scanErr
    }

    // 3.2 远端探测残留清理（崩溃残留双通道之二，与 runCapabilityProbe 启动清理互补）：
    //     复用本轮扫描结果（listRemoteSafe 旁路登记的 probeResidue），除 DELETE 本身外
    //     不增加任何请求。只处理同步根第一层的 `.wdsync-probe-` 目录且 mtime 距今
    //     ≥ PROBE_RESIDUE_MIN_AGE_MS 者 —— 前缀匹配不区分设备（清理**所有设备**的
    //     崩溃残留；活跃探测必然年轻，年龄门槛保证并发探测不被误删），且探测只会在
    //     根下第一层产生残留，绝不递归删除其他内容。best-effort：并发 DELETE、单个
    //     失败仅汇总为一条 warning（下轮再试），绝不阻断轮次；放在 I1 闸门之后，
    //     清理与否不影响扫描完整性判定。计数不计入 summary.deleted（非用户文件语义）。
    {
      const stale = (remoteScan.probeResidue || []).filter(
        (e: any) => e.rel && e.mtimeMs > 0 && Date.now() - e.mtimeMs >= PROBE_RESIDUE_MIN_AGE_MS
      )
      if (stale.length) {
        const base = String(dir.remotePath).replace(/\/+$/, '')
        const settled = await Promise.allSettled(stale.map((e: any) => davRequest(cfg, 'DELETE', joinRemote(base, e.rel))))
        const failedCnt = settled.filter((r) => r.status === 'rejected' || !r.value || r.value.status >= 400).length
        if (failedCnt) logNote(`清理远端探测残留失败 ${failedCnt}/${stale.length} 个（不影响本轮同步，下轮重试）`)
      }
    }

    // 3.3 etag 跳过子树的合成与 scan-cache 收割（仅在 I1 闸门之后：
    //     只有完整扫描轮的观测才可落入缓存；合成条目也只有完整轮才有资格充当
    //     「远端子树状态」的代表）。
    const skippedDirs: string[] = (remoteScan.skippedDirs || []) as string[]
    /** rel（NFC）是否位于任一被跳过的子集合之下（跳过目录通常少量，线性前缀比对即可；条目多时由调用方分片） */
    const underSkipped = (rel: string) => skippedDirs.some((s) => rel.startsWith(s + '/'))
    if (skippedDirs.length > 0) {
      // a) 按基线合成被跳过子树的远端条目 —— 合成即断言「服务器子树与基线一致」，
      //    依据是父清单里该子集合 etag 未变 + 探测验证的深层传播能力（深层修改必然
      //    改变祖先集合 etag，故 etag 未变 ⇒ 子树未变）。文件按基线的远端指纹合成；
      //    rawRel 的最后一段换回 m.origName（若有）—— remoteByNfc 的 NFC 循环从原始
      //    rel 推导 origName，直接用 NFC 键会丢 NFD 服务器原名（对照 FN0 行为）。
      for (const [k, m] of store.entries) {
        await maybeYield() // 数万基线条目 × 跳过前缀的比对循环分片让出（与既有循环同规格）
        if (!underSkipped(k)) continue
        const segs = k.split('/')
        if (m.origName) segs[segs.length - 1] = m.origName
        remoteScan.files.set(segs.join('/'), { isDir: false, size: m.rsize, mtimeMs: m.rmtimeMs, etag: m.retag, synth: true })
      }
      // 目录条目合成（空目录清理的 dirChildren 依赖目录条目在表）：缓存里位于跳过
      // 前缀下的集合观测即为本轮未列举、按同一断言仍存在的子集合
      if (scanCache && scanCache.collections) {
        for (const k of Object.keys(scanCache.collections)) {
          if (!underSkipped(k)) continue
          const c = scanCache.collections[k]
          remoteScan.files.set(k, { isDir: true, size: 0, mtimeMs: c.m, etag: c.e, synth: true })
        }
      }
    }
    // b) 收割新 scan-cache：本轮观测 ∪ 跳过前缀下的旧缓存条目（carry-forward ——
    //    被跳过子树内部本轮未列举，旧值继续有效，这正是下一轮还能继续跳过的关键）。
    //    lastFullScanAt：全量下降（infinity 形态或未传 etag 表）刷新为当前时刻，
    //    跳过轮沿用旧值（6 小时新鲜期由步骤 2 的 usable 裁决消费，见
    //    ETAG_SKIP_FULL_SCAN_MS）。写失败仅提示（缓存只是性能优化，下一轮多列举
    //    一些目录而已）。
    const fullDescent = remoteScan.depth === 'infinity' || !etagSkipUsed
    const mergedCollections: Record<string, any> = {}
    for (const [k, v] of remoteScan.collections) mergedCollections[k] = v
    if (skippedDirs.length > 0 && scanCache && scanCache.collections) {
      for (const k of Object.keys(scanCache.collections)) {
        if (underSkipped(k)) mergedCollections[k] = scanCache.collections[k]
      }
    }
    const newScanCache = {
      v: 1,
      lastFullScanAt: fullDescent ? Date.now() : Number(scanCache && scanCache.lastFullScanAt) || 0,
      collections: mergedCollections,
    }
    await store.saveScanCache(newScanCache).catch((e: any) =>
      logNote(`etag 跳过缓存写入失败（${(e && e.message) || e}）：下一轮将全量列举`)
    )
    /**
     * etag 跳过的运行时异常防线（第二层防御）：被跳过子树内的文件出现「远端实际
     * 状态 ≠ 合成（基线）状态」的迹象时置位（幂等，只记首个原因）。这是「探测
     * 验证」之外的兜底 —— 探测结论最长已是 7 天前的快照，服务器行为可能已变。
     * 触发点见各钩子（冲突判定 / 条件请求 412 / 写前复查失配 / 写前查重）；
     * 轮末统一收口（见 finalize 区的异常处理块）。
     */
    let etagSkipAnomaly: string | null = null
    const noteEtagSkipAnomaly = (rel: string, why: string) => {
      if (etagSkipAnomaly) return // 幂等：只记首个原因
      const k = nfc(String(rel || ''))
      if (skippedDirs.some((s) => k.startsWith(s + '/'))) etagSkipAnomaly = why
    }

    // 3.5 服务器能力与档位（写权限按本目录远端根路径判定）：与扫描
    //     并行获取（见步骤 2 —— 远端扫描形态依赖它，提前到此），此处只消费结论。
    //     探测请求计入轮次开销但不计入传输进度（bytes 字段只反映用户文件）。
    //     探测绝不抛出（失败降级 B 档）。
    // 指纹噪声存储（origin+username 粒度、跨目录共享），异常时降级为空实现；
    // B 档并发安全提示的「已提醒」标记同住这里（随 noise.json 跨轮持久）。
    const serverNoise = await openServerNoiseSafe(cfg)
    summary.tier = caps.tier
    let tierBNoticePending = false
    if (caps.tier === 'B') {
      // B 档并发安全提示每个服务器只携带一轮：渲染层对每轮 summary.warnings 弹
      // toast，逐轮携带会每次自动同步都弹一次。是否已提醒记入 noise.concurrencyWarned
      //（noise.json 持久化）；本轮名额只在干净收场时消耗（见轮末收口 —— 出错 / 取消 /
      // 熔断轮渲染层不弹警告 toast，弹不到就不算「弹过」）。探测降级轮（degraded，
      // 服务器真实档位未知）不携带也不消耗。
      if (!caps.degraded && !serverNoise.noise.concurrencyWarned) {
        tierBNoticePending = true
        pushWarning('这个服务器无法保证多台设备同时修改时的安全。覆盖或删除云端文件前会先确认，但仍有极小概率覆盖其他设备刚做的修改')
      }
    } else if (caps.tier === 'C') {
      pushWarning(`服务器不允许上传，本次只会下载文件${caps.writeReason ? `（${caps.writeReason}）` : ''}`)
    }
    let noiseDirty = false
    let roSkipped = 0 // C 档跳过的上传 / 删除 / 冲突动作数（轮末汇总一条 warning）

    // 4. NFC 视图：两侧 key 统一 NFC；实际访问用原始 abs / origName
    const localByNfc = new Map()
    for (const [rel, info] of localScan.files) {
      await maybeYield() // 分片让出（数万条目的 Map 构建是紧凑 CPU 循环）
      localByNfc.set(nfc(rel), info)
    }
    const remoteByNfc = new Map()
    for (const [rel, info] of remoteScan.files) {
      await maybeYield()
      remoteByNfc.set(nfc(rel), { ...info, origName: rel.split('/').pop() })
    }

    /**
     * 4.5 大小写冲突检测：同目录下仅大小写不同的文件在大小写不敏感的
     * 文件系统 / 服务器上是同一个名字，传输任一侧都会静默覆盖另一侧。涉及的
     * rel 全部进 caseSkip —— 规划层跳过其 upload / download / conflict（含 adopt
     * 收敛与半截强制重传），逐组报错提示用户重命名；删除传播不受限（删除其一
     * 正是消除冲突的手段，下轮自动恢复）。远端侧只取文件条目（目录不参与传输）。
     * 错误逐组上报、最多列 5 组（其余由 errors 截断机制自然收纳），不随文件数刷屏。
     */
    const remoteFileKeys: any[] = []
    for (const [k, v] of remoteByNfc) {
      await maybeYield() // 分片让出（数万条目的过滤循环）
      if (!v.isDir) remoteFileKeys.push(k)
    }
    const caseCollisions = detectCaseCollisions(localByNfc.keys(), remoteFileKeys)
    const caseSkip = caseCollisions.skip
    caseCollisions.groups.slice(0, 5).forEach((g: any) => {
      const sideText = g.side === 'local' ? '电脑上' : g.side === 'remote' ? '云端' : '电脑和云端'
      pushError(`${sideText}同时有 ${g.rels.join(' 和 ')} 两个文件，只有大小写不同，在 Windows 和 macOS 上会被当成同一个文件，已跳过，请改名其中一个`, false)
    })
    if (caseCollisions.groups.length > 5) {
      pushError(`另有 ${caseCollisions.groups.length - 5} 组这样的文件未逐条列出（同样已跳过），请检查文件夹`, false)
    }

    const localTol = await localFpTolMs(dir.localPath)

    // 5. WAL 崩溃恢复：用本轮扫描结果核对遗留意图 —— 采纳 /
    //    放弃 / 判定半截。半截命中者进入 forceUploads，规划期强制按 upload 重传。
    //    采纳内容确认受单轮字节预算约束（耗尽回退按大小采纳 + 轮末汇总 warning）。
    //    注意：remoteByNfc 可能含 etag 跳过子树的「合成条目」（按基线指纹合成，见
    //    3.3a）—— 意图记录的是写入当时的两侧指纹，合成 = 「按集合 etag 未变推定
    //    远端仍是指意图时的状态」，参与恢复判定与真实观测同口径、语义自洽。
    const forceUploads = await recoverIntents(store, cfg, dir, localByNfc, remoteByNfc, localTol, verifyMaxBytes, pushWarning, adoptVerifyBudgetBytes)

    // 深度校验（默认关）：到期则对 mtime/size 未变的文件也重算 hash 比对基线
    const deepVerifyDue =
      prefs.deepVerify === true &&
      (!store.meta.lastDeepVerifyAt || Date.now() - Number(store.meta.lastDeepVerifyAt) > Math.max(1, Number(prefs.deepVerifyDays) || 7) * 86400000)

    // 6. 规划：变化判定（含 hash 消歧）→ 决策 → 生成传输任务
    const rels = new Set([...localByNfc.keys(), ...remoteByNfc.keys(), ...store.entries.keys()])
    const plan: any[] = []
    for (const rel of rels) {
      await maybeYield() // 分片让出（三侧 key 并集的组装循环）
      const rEntry = remoteByNfc.get(rel)
      if (rEntry && rEntry.isDir) continue // 目录条目不参与文件决策（上传时自动建目录）
      const l = localByNfc.get(rel) || null
      const r = rEntry || null
      const m = store.get(rel)
      plan.push({ rel, l, r, m })
    }
    summary.totalFiles = plan.length
    const planByRel = new Map(plan.map((it) => [it.rel, it]))
    // 扫描到的全部文件字节（两侧并集）：云端占用估算的数据来源，与传输量无关
    //（「需要上传 / 下载多少字节」由传输阶段的 transferBytesTotal 承担）
    let scanBytesTotal = 0
    for (const it of plan) scanBytesTotal += (it.l ? it.l.size : 0) + (it.r ? it.r.size : 0)
    // 计划需要上传 + 下载的总字节（传输进度的分母）：由 pushTransfer 按任务累加，
    // 删除任务计 0；写前查重剔除任务时同步扣减
    let transferBytesTotal = 0
    // verifyDone / verifyTotal：规划期内容校验（verify）的进度字段（追加需求），
    // 无校验任务时保持 0；有任务时由下方 verify 池持续更新
    onProgress({ phase: 'plan', filesDone: 0, filesTotal: plan.length, bytesDone: 0, bytesTotal: 0, stage: 'plan', scanBytesTotal, verifyDone: 0, verifyTotal: 0 })

    let filesDone = 0
    let bytesDoneAcc = 0
    // tick / emitPlan 经节流 onProgress 外发；force=true 的终态调用保证池收尾后的
    // 最终计数必然送达（中间事件被节流丢弃不损失信息，计数单调不减）。
    // currentTask 是最后被领取的传输任务（并发 worker 下为近似「正在进行」），
    // 供 UI 展示「正在上传 / 下载 …」。
    let currentTask: { op: string; rel: string } | null = null
    const tick = (force = false) =>
      onProgress(
        {
          phase: 'transfer',
          filesDone,
          filesTotal: plan.length,
          bytesDone: bytesDoneAcc,
          bytesTotal: transferBytesTotal,
          stage: 'transfer',
          scanBytesTotal,
          ...(currentTask ? { currentOp: currentTask.op, currentFile: currentTask.rel } : {}),
        } as SyncProgress,
        force
      )

    const createdDirs = new Set<any>()
    const transfers: any[] = []
    /**
     * B 档「扫描期远端不存在」的新上传 rel 集合（写前查重目标）。A 档新上传已有
     * If-None-Match:* 写时守卫、B 档覆盖上传已有 recheck，均不进此集合（省请求）。
     */
    const bNewUploads = new Set<any>()
    /** 退避期内的持续失败文件：规划层不生成传输任务，轮末汇总一条 warning（元素 { rel, fr }） */
    const permSkipped: any[] = []
    /** 瞬时失败任务队列：worker 池收尾后当轮再执行一次（保存 job 闭包；只重试一轮次） */
    const transientFailed: any[] = []
    /**
     * 两段提交的上传暂存队列：PUT 已成功（含 POST-CHECK）但尚未提交基线的上传。
     * 元素 { rel, local: 上传后 stat, hash, intentId, origName?, conflict }；worker 池与瞬时失败
     * 当轮重试全部结束后，由下方「批量校验阶段」按父目录分组做 PROPFIND Depth 1 统一
     * 核对（远端存在 + size 一致）并提交基线 / done，不再逐文件一次校验。
     */
    const pendingUploads: any[] = []
    let aborted = false
    let roundConflictChoice: any = null
    /**
     * 本轮经「冲突挂起延续」解决的冲突清单（元素 { rel, choice }）：
     * 即上一轮用户已选择但落地失败、本轮直接沿用策略而未再次询问的冲突；
     * 轮末汇总一条 warning，让用户感知「没再问我，按上次的选择办了」。
     */
    const pendingResolved: any[] = []
    /**
     * 删除安全：规划期删除类动作只收集不执行，规划第二遍结束后统一
     * 过「删除安全闸」（用户确认标记 / 远端根重建保护 / 批量删除阈值）再入队；
     * 本轮成功落地删除的 rel 分别登记，供轮末空目录清理取祖先目录。
     */
    const deletePlanItems: any[] = []
    const localDeletedRels = new Set<any>()
    const remoteDeletedRels = new Set<any>()
    // crashErr 声明在 roundBody 之外（锁后置后拿锁与传输都在 roundBody 内）：
    // 外层释放锁的 finally 需读取它决定是否跳过收尾

    // 操作执行骨架：intent → 操作 → 验证 → [崩溃注入点] → 基线 → done。
    // opts.conflict：本次操作是冲突解决的落地动作 —— 成功提交（基线
    // 写入 + done）后清除该文件的冲突挂起记录（决策已完成）；失败路径不清（挂起与
    // choice 保留，下一轮沿用重试）。
    // intent 记录带 at（写入时刻，开放意图 30 天超龄兜底用）；同 rel 的既有
    // 开放意图由新者取代（aborts —— 与 runUploadOp 共用的取代语义）。
    const runOp = async (it: any, opName: any, body: any, opts: any = {}) => {
      if (shouldAbort()) {
        aborted = true
        return
      }
      const id = crypto.randomUUID()
      const intent: any = { op: opName, rel: it.rel, at: Date.now() }
      if (opName === 'download') intent.remote = { size: it.r.size, mtimeMs: it.r.mtimeMs, etag: it.r.etag || '' }
      await store.appendWalIntent({ id, ...intent })
      await supersedeOpenIntents(it.rel, id)
      const commitSet = (entry: any) => store.setEntry(it.rel, entry)
      const commitDel = () => store.deleteEntry(it.rel)
      try {
        await body(commitSet, commitDel)
        await store.appendWalDone(id)
        if (opts.conflict) store.clearPending(it.rel)
      } catch (e: any) {
        // 崩溃注入的错误不写 abort：模拟「进程死亡」，意图保持未了结供下一轮恢复
        if (!e || !e.__wdsyncCrash) await store.appendWalAbort(id).catch(() => {})
        throw e
      }
    }
    /** 同 rel 的其余开放意图由新意图取代（新者写 abort 了结旧者）。覆盖同轮瞬时重试与跨轮半截重传两条来源。 */
    const supersedeOpenIntents = async (rel: any, exceptId: any) => {
      for (const other of Array.from(store.pendingIntents.values())) {
        if (other.id !== exceptId && nfc(other.rel || '') === nfc(rel)) await store.appendWalAbort(other.id).catch(() => {})
      }
    }
    const crashHook = async (payload: any) => {
      if (!afterTransferOp) return
      try {
        await afterTransferOp(payload)
      } catch (e: any) {
        if (e && typeof e === 'object') e.__wdsyncCrash = true
        throw e
      }
    }

    /**
     * 两段提交的上传段：intent → PUT（uploadOne）→ 暂存 pendingUploads。
     * 与 runOp 的差异：body 成功后**不写基线、不写 done** —— 提交统一推迟到批量校验阶段
     *（所在目录的上传全部完成后，一次 PROPFIND Depth 1 核对 size 并取远端指纹写基线）。
     * 意图记录与取代语义：
     *   - intent 携带上传前的规划期远端指纹 remote（无则 null，半截判定链第 3 步的比对
     *     基准）、写入时刻 at，以及链上最初写入时刻 firstAt（新意图取代旧
     *     意图时继承，超龄按 firstAt 计算，持续中断链的兜底时钟不被每轮重写刷新）；
     *     写入点收紧到「PUT 发起前」—— 经 body 收到的 onBeforePut
     *     钩子在 uploadOne 的全部前置检查（双 stat / 建目录 / B 档复查）之后触发，
     *     pre-flight 失败不产生 intent（intentOpen 保持 false）；
     *   - abort 策略：崩溃注入不写 abort（既有）；PUT 以 NETWORK / ABORTED / 上传读流
     *     LOCAL_IO（source='body-read'）收场同样不写 abort —— 这些情形服务器可能已收到
     *     部分字节，意图保持开放供下一轮半截判定；pre-flight 失败（未写过 intent）与
     *     确定状态码（4xx/5xx 终态，含 412）仍写 abort；
     *   - 同 rel 的其余开放意图由新者取代（supersedeOpenIntents，同轮瞬时重试与跨轮
     *     半截重传共用「新者取代旧者」语义）。
     * 崩溃窗口语义：PUT 成功 → 批量提交之间崩溃（crashHook 抛出或真实进程死亡）时遗留
     * 未了结的 upload intent，下一轮 recoverIntents 按「本地未变 + 远端已存在同 size」采纳。
     * @param it 计划条目（取 rel 与 l / r 指纹写 intent） @param origName 扫描期远端原始文件名
     * @param body 传输体：形如 (hooks) => uploadOne(..., { onBeforePut: hooks.onBeforePut }) +
     *        crashHook，成功返回 uploadOne 的结果
     * @param fromConflict 本次上传是否为冲突解决的落地动作（半截强制重传也
     *        置 true —— 远端被证实为本机残缺文件时，等效 choice='local'，成功提交后清除挂起）
     * @returns {boolean} 是否已暂存待批量提交（开始前用户中止 → false，不发 intent）
     */
    const runUploadOp = async (it: any, origName: any, body: any, fromConflict = false) => {
      if (shouldAbort()) {
        aborted = true
        return false
      }
      const id = crypto.randomUUID()
      const remoteFp = it.r && !it.r.isDir ? { size: it.r.size, mtimeMs: it.r.mtimeMs, etag: it.r.etag || '' } : null
      let intentOpen = false // intent 实际写入过（PUT 前一刻）才需要考虑 abort
      try {
        const up = await body({
          onBeforePut: async () => {
            // 新意图继承同 rel 开放意图链的最初写入时刻 firstAt ——
            // 持续中断的文件每轮「新者取代旧者」不再刷新超龄时钟，30 天兜底对中断链
            // 真正封顶（否则 WAL 每轮约增 2 行且永不超龄）。旧意图缺 firstAt 时回退
            // 其 at（链上已知的最早时刻）；无旧意图时取当前时刻。
            const now = Date.now()
            let firstAt = now
            for (const other of store.pendingIntents.values()) {
              if (other.id === id || nfc(other.rel || '') !== nfc(it.rel)) continue
              const born = Number(other.firstAt) > 0 ? Number(other.firstAt) : Number(other.at) > 0 ? Number(other.at) : Infinity
              if (born < firstAt) firstAt = born
            }
            await store.appendWalIntent({
              id,
              op: 'upload',
              rel: it.rel,
              at: now,
              firstAt,
              local: { size: it.l.size, mtimeMs: it.l.mtimeMs },
              remote: remoteFp,
            })
            await supersedeOpenIntents(it.rel, id)
            intentOpen = true
          },
        })
        // added：扫描期远端没有该文件（含根重建保护 / 「不删除」恢复的复活上传）=
        // 云端新增；随批量校验提交点写进同步记录的操作明细
        pendingUploads.push({
          rel: it.rel,
          local: up.local,
          hash: up.hash,
          intentId: id,
          origName: origName || undefined,
          conflict: fromConflict === true,
          added: !(it.r && !it.r.isDir),
        })
        return true
      } catch (e: any) {
        // 崩溃注入 / 服务器可能已收字节（NETWORK / ABORTED / 上传读流 LOCAL_IO）：不写 abort，
        // 意图保持开放，下一轮 recoverIntents 三向判定（采纳 / 放弃 / 半截转重传）。
        // __openIntent：失败时确有开放意图 —— 该文件的当轮瞬时重试必须跳过
        //（handleTransferError 据此不再入队）：重试携带的守卫（A 档 If-None-Match:* /
        // If-Match、B 档复查）都基于**中断前**的远端指纹，撞上本机自己留下的半截必然
        // 412 / REMOTE_CHANGED，按规则写 abort 反而丢失半截标记，让下一轮退回假冲突
        const keepOpen =
          !intentOpen ||
          !e ||
          e.__wdsyncCrash ||
          e.code === 'NETWORK' ||
          e.code === 'ABORTED' ||
          (e.code === 'LOCAL_IO' && e.source === 'body-read')
        if (!keepOpen) await store.appendWalAbort(id).catch(() => {})
        if (keepOpen && intentOpen && e && typeof e === 'object') e.__openIntent = true
        throw e
      }
    }

    // ---- 持续失败退避的传输层接线 ----
    // 所有传输闭包（含 conflict 的裸闭包）统一经 pushTransfer 入队：
    //   成功 → 清除该文件的失败记录（退避解除，下一轮起恢复正常规划）；
    //   失败 → 给错误附加 e.__rel（runOp 内部的抛错与 conflict 闭包的直接抛错在此一处补齐），
    //          worker catch 据此把永久失败记到正确的 rel 名下。
    // 两段提交例外：上传闭包成功时返回 UPLOADED_PENDING（PUT 成功、待批量校验提交），
    // 失败记录的清除随之推迟到批量提交点 —— 若批量校验失败，该文件本轮终究未成功，
    // 退避记录保留（与「传输成功才清除」的语义一致）。
    const UPLOADED_PENDING = Symbol('wdsync-uploaded-pending')
    /**
     * 与 transfers 平行的任务元数据：{ rel, kind, bytes }，kind ∈
     * upload / download / delete-local / delete-remote / conflict，bytes 为该任务的
     * 传输字节估算（upload = 本地大小、download = 远端大小、conflict = 两侧之和、
     * 删除 = 0）—— 全部任务 bytes 之和即传输进度分母 transferBytesTotal。供规划完成后的
     * 两道闸读取：按需拿锁的「远端写」判定（upload / delete-remote / conflict）、
     * B 档写前查重的按 rel 剔除（与 transfers 同步 splice，下标始终对齐）。
     */
    const transferMeta: any[] = []
    const pushTransfer = (rel: any, fn: any, kind: any, bytes = 0) => {
      transferMeta.push({ rel, kind, bytes })
      transferBytesTotal += bytes
      transfers.push(async () => {
        try {
          const r = await fn()
          if (r !== UPLOADED_PENDING) store.clearFailure(rel)
          return r
        } catch (e: any) {
          if (e && typeof e === 'object' && !e.__rel) e.__rel = rel
          // etag 跳过运行时防线（见 noteEtagSkipAnomaly）：A 档条件保护命中（412，
          // uploadOne / delete-remote 的 PUT/DELETE If-Match 失配）或 B 档复查发现
          // 远端与扫描预期不符（REMOTE_CHANGED）—— 被跳过子树内的文件出现这种
          // 失败 = 远端实际状态与合成（基线）状态不符，标记异常
          if (e && typeof e === 'object' && (e.code === 'PRECONDITION' || e.code === 'REMOTE_CHANGED')) {
            noteEtagSkipAnomaly(e.__rel || rel, e.code === 'PRECONDITION' ? '条件请求 412' : '写前复查失配')
          }
          throw e
        }
      })
    }

    /**
     * 统一处理一次传输失败（worker catch 与瞬时失败重试共用）：
     *   transient 且非重试 → 收集到 transientFailed，当轮后段重试（暂不计入轮次错误）；
     *   transient 但失败留下开放上传意图（__openIntent）→ 不入重试队列，按普通错误
     *     上报并说明「下一轮自动判定」（重试守卫基于中断前指纹，撞上自己的半截必然
     *     412 / REMOTE_CHANGED 且丢失半截标记）；
     *   permanent          → 记入失败退避表（noteFailure；条目满时提示）；
     *   其余 / 重试再败    → 照常 pushError（下轮重试，不记录）。
     * 取消：ABORTED（在途传输被取消销毁）不在此列 —— 不分类、不进退避表、
     * 不产生用户可见错误；轮次整体由下方既有「aborted → 同步已中止」路径收场
     *（WAL 意图已在 runOp / runUploadOp 的 catch 里按开放意图策略处理）。
     */
    const handleTransferError = (e: any, job: any, isRetry: any) => {
      if (e && e.__wdsyncCrash && !crashErr) crashErr = e
      if (e && e.code === 'ABORTED') {
        aborted = true
        return
      }
      const cls = classifyOpFailure(e)
      // 失败留下开放意图的上传不做当轮重试 —— 重试守卫基于中断前的远端指纹，
      // 撞上本机自己的半截必然 412 / REMOTE_CHANGED 且丢失半截标记；下一轮恢复期的
      // 前缀校验才能安全区分「自己的半截」与「对端修改」。按普通错误上报（含说明）
      if (cls === 'transient' && e && e.__openIntent && !isRetry) {
        pushError(`${e.message}（这个文件本次不再重试，下次同步会自动检查）`, networkFailure(e))
        return
      }
      if (cls === 'transient' && !isRetry && job) {
        transientFailed.push(job)
        return
      }
      if (cls === 'permanent' && e && e.__rel) {
        const recorded = store.noteFailure(e.__rel, { code: e.code || (e.status ? `HTTP ${e.status}` : ''), message: e.message || '' })
        if (!recorded) logNote(`失败退避记录已满：${e.__rel} 的持续失败未记录，本轮后仍会每轮重试`)
      }
      pushError(e && e.message ? e.message : String(e), networkFailure(e))
    }

    // 冲突询问必须串行：并发 worker 同时 ask 会绕过 roundConflictChoice /
    // 冲突弹窗队列（一次只应只有一个询问在等待用户）
    let askChain = Promise.resolve()
    const resolveChoice = (it: any) => {
      const run = askChain.then(() => resolveChoiceInner(it))
      askChain = run.catch(() => {})
      return run
    }
    /**
     * 登记一条冲突挂起记录：用户已做出（含按「应用到全部」在本轮内
     * 沿用）的冲突决策，在成功落地之前先逐文件持久化 —— 落地失败（A 档 412 /
     * B 档复查 REMOTE_CHANGED / 网络）时下一轮自动沿用，不再重复询问；choice 省略
     * 表示「已询问但未解决」的挂起（供后续 UI 统一处理）。
     * 只更新内存并置脏，轮末由引擎统一落盘（crashErr 路径不写，模拟进程死亡）。
     */
    const registerPendingChoice = (it: any, choice: any) => {
      const ok = store.setPending(it.rel, {
        local: { size: it.l ? it.l.size : 0, mtimeMs: it.l ? it.l.mtimeMs : 0 },
        remote: { size: it.r ? it.r.size : 0, mtimeMs: it.r ? it.r.mtimeMs : 0, etag: it.r ? it.r.etag || '' : '' },
        createdAt: Date.now(),
        ...(choice ? { choice } : {}),
      })
      if (!ok) logNote(`冲突挂起记录已满：${it.rel} 的冲突决策未持久化（本轮仍按该决策执行）`)
    }
    const resolveChoiceInner = async (it: any) => {
      // etag 跳过运行时防线（见 noteEtagSkipAnomaly）：进入冲突判定本身通常意味着
      // 两侧都变了；被跳过子树内的合成远端按断言应与基线一致（rChanged=false，
      // 最多产生 upload），真出现冲突 = 远端实际状态与合成断言不符
      noteEtagSkipAnomaly(it.rel, '冲突判定')
      // 优先级 1：本轮内存的「应用到全部」—— 本轮用户的最新意图优先于历史挂起；
      // 沿用时同样逐文件登记挂起（applyToRemaining 只作用于本轮内存，持久化按文件记）
      if (roundConflictChoice) {
        registerPendingChoice(it, roundConflictChoice)
        return roundConflictChoice
      }
      // 优先级 2：上一轮用户已选择但尚未成功落地的冲突，
      // 本轮不再调用 onConflict / 不弹窗，直接沿用已记录的策略 —— 与 roundConflictChoice
      // 同一条执行路径（决策已定，仅剩传输）。C 档跳过、newBoth=conflict 等既有闸门
      // 在规划层已先行过滤，此处只处理真正进入冲突解决的条目。
      // choice 只认冲突类三值：'delete'/'keep' 是删除确认类挂起的选择值（手改数据 /
      // 异常写入混入冲突条目时），按「未解决」对待走正常询问流程，绝不落入 else
      //（else = 同时保留，语义完全不同）。
      const pendingRec = store.getPending(it.rel)
      if (pendingRec && (pendingRec.choice === 'local' || pendingRec.choice === 'remote' || pendingRec.choice === 'both')) {
        pendingResolved.push({ rel: it.rel, choice: pendingRec.choice })
        return pendingRec.choice
      }
      // 本机存在开放 upload 意图且远端小于本地 → 疑似上次中断上传留下的
      // 残缺文件（半截判定因超上限 / GET 失败而无法自动完成），随冲突信息带给渲染层提示
      const partialSuspect = (() => {
        for (const p of store.pendingIntents.values()) {
          if (p.op === 'upload' && nfc(p.rel || '') === it.rel) return true
        }
        return false
      })() && !!(it.r && it.l && it.r.size < it.l.size)
      let choice = prefs.conflictStrategy
      if (choice === 'ask' && handlers && handlers.onConflict) {
        const res = await handlers.onConflict({
          dirId: String(dir.id || ''),
          rel: it.rel,
          local: { size: it.l ? it.l.size : 0, mtimeMs: it.l ? it.l.mtimeMs : 0 },
          remote: { size: it.r ? it.r.size : 0, mtimeMs: it.r ? it.r.mtimeMs : 0, etag: it.r ? it.r.etag : '' },
          ...(partialSuspect ? { hint: 'partial-upload' } : {}),
        })
        if (res && typeof res === 'object') {
          if (res.choice === 'local' || res.choice === 'remote' || res.choice === 'both') {
            // 「对本轮剩余冲突都这样处理」：本轮后续冲突不再询问
            if (res.applyToRemaining) roundConflictChoice = res.choice
            registerPendingChoice(it, res.choice)
            return res.choice
          }
          // 无法识别的选择：按「未解决」登记挂起（无 choice），照旧抛错 —— 供后续统一处理
          registerPendingChoice(it, null)
          throw new Error(`「${it.rel}」的冲突还没处理，电脑和云端的文件都保持原样`)
        }
        // 'defer' = 冲突挂起（典型：后台轮渲染层不可见，
        // 调度器不等一个看不见的弹窗）。走现有「无 choice 挂起」登记通道（与 ask 无回调
        // 同一存储），返回哨兵值由冲突执行器跳过该文件 —— 轮次不因冲突报错。
        // 现有的 pending 沿用（优先级 2）与 setPendingChoice 批量处理路径天然复用
        if (res === 'defer') {
          registerPendingChoice(it, null)
          return 'defer'
        }
        if (res === 'local' || res === 'remote' || res === 'both') {
          registerPendingChoice(it, res)
          return res
        }
        registerPendingChoice(it, null)
        throw new Error(`「${it.rel}」的冲突还没处理，电脑和云端的文件都保持原样`)
      }
      if (choice === 'ask') {
        // ask 且无回调：同样按「未解决」登记挂起后抛错（挂起记录供 UI / setPendingChoice 后续处理）
        registerPendingChoice(it, null)
        throw new Error(`「${it.rel}」的冲突还没处理，电脑和云端的文件都保持原样`)
      }
      return choice
    }

    // ---- 规划第一遍（串行）：变化判定 + 收集需要「远端内容校验（verify）」的项 ----
    // verify（A 类远端消歧 / B 类双侧比对 / 无基线 adopt 的下载比对）是纯事实采集：
    // 先收集、再并发执行、最后按原顺序回填 —— decideAction 与各 adopt 分支的判定条件
    // 与旧串行版逐行等价，verify 只提供事实，不改变判定本身。
    const verifyJobs: any[] = []
    const verifyOutcome = new Map() // plan 条目 → 'done' | 'skipped'（skipped = 中止时未执行）
    for (const it of plan) {
      await maybeYield() // 规划第一遍分片让出（紧凑判定循环不饿调度器心跳）
      if (shouldAbort()) break // 仅停止继续判定；回填阶段的中止检查统一裁决（见第二遍）
      if (caseSkip.has(it.rel)) continue // 大小写冲突：不参与变化判定 / verify / adopt（见 4.5）
      const { l, r, m } = it
      const flags: any = {}
      it.flags = flags
      if (m) {
        // ---- 本地变化：size + 自适应 mtime 容差，模糊时 lhash 消歧 ----
        if (l) {
          const lc = await computeLocalChanged(l, m, localTol, deepVerifyDue)
          flags.lChanged = lc.changed
          if (!lc.changed && m.lhash != null && Math.abs((l.mtimeMs || 0) - (m.lmtimeMs || 0)) > localTol) {
            // touch 型变化：内容未变 → 静默刷新基线 mtime，不传输
            await store.setEntry(it.rel, { ...m, lmtimeMs: l.mtimeMs }).catch(() => {})
            it.m = m
            m.lmtimeMs = l.mtimeMs
          }
        } else {
          flags.lChanged = false
        }
        // ---- 远端变化（etag 优先，size/mtime 兜底）----
        flags.rChanged = r ? remoteChangedVs(r, m) : false
        // A 类（本地未变、仅远端指纹变化且等长）与 B 类（双侧都变且等长）天然互斥：
        // 前者要求本地未变、后者要求本地已变，同一轮内不会同时成立，故每条目至多一个任务
        const aCandidate =
          l &&
          r &&
          flags.lChanged === false &&
          flags.rChanged &&
          r.size === m.rsize &&
          m.lhash != null &&
          r.size <= verifyMaxBytes &&
          (((r.etag || '') === '' && (m.retag || '') === '') || serverNoise.fingerprintUnstable)
        const bCandidate = l && r && flags.lChanged && flags.rChanged && l.size === r.size && l.size <= verifyMaxBytes
        if (aCandidate || bCandidate) verifyJobs.push({ it, kind: aCandidate ? 'a' : 'b' })
      } else if (l && r) {
        // ---- 无基线且两侧都在 → size/mtime 先判，需要 hash 收敛的入池 ----
        if (l.size !== r.size) flags.newBoth = 'conflict'
        else if (Math.abs((l.mtimeMs || 0) - (r.mtimeMs || 0)) <= localTol) flags.newBoth = 'adopt'
        else if (l.size <= verifyMaxBytes) verifyJobs.push({ it, kind: 'adopt' })
        else flags.overLimitNoBaseline = true // 提示在第二遍按原条目顺序发出（与串行版一致）
      }
    }

    // ---- verify 并发池（追加需求：规划期并发 + 进度外发 + shouldAbort 检查）----
    if (verifyJobs.length) {
      let verifyBytesTotal = 0
      for (const job of verifyJobs) verifyBytesTotal += job.it.r ? job.it.r.size : 0
      let verifyDone = 0
      let verifyBytes = 0
      let vIdx = 0
      const emitPlan = (force = false) =>
        onProgress(
          {
            phase: 'plan',
            filesDone: 0,
            filesTotal: plan.length,
            bytesDone: verifyBytes,
            bytesTotal: verifyBytesTotal,
            stage: 'verify',
            scanBytesTotal,
            verifyDone,
            verifyTotal: verifyJobs.length,
          },
          force
        )
      emitPlan()
      const runVerifyJob = async (job: any) => {
        if (job.kind === 'a') {
          job.rh = await verifyRemoteHash(cfg, dir, job.it.rel, job.it.r)
        } else {
          // B 类任务与无基线 adopt 同构：先算本地 hash，成功才值得下载远端比对（与串行版顺序一致）
          job.lh = await hashFile(job.it.l.abs).catch(() => null)
          job.rh = job.lh != null ? await verifyRemoteHash(cfg, dir, job.it.rel, job.it.r) : null
        }
      }
      const verifyWorker = async () => {
        while (vIdx < verifyJobs.length) {
          if (shouldAbort()) {
            // 未领取的任务全部记为 skipped：第二遍会在第一个被跳过的条目处中止，
            // 等价于串行版「在条目边界检查中止」的语义。取消同样即时打断
            // 已领取的在途 verify 下载（网络层销毁请求，verifyRemoteHash 捕获后按
            // 「无法完成」返回 null，临时文件在其 finally 清理）
            for (let k = vIdx; k < verifyJobs.length; k++) verifyOutcome.set(verifyJobs[k].it, 'skipped')
            vIdx = verifyJobs.length
            return
          }
          const job = verifyJobs[vIdx++]
          await maybeYield() // hash 队列分片让出（本地哈希 / 远端校验的紧凑领取循环）
          try {
            await runVerifyJob(job)
          } catch (_) {
            /* verify 异常按「无法完成」处理（runVerifyJob 内部已兜 null），回填同串行版 */
          }
          verifyOutcome.set(job.it, 'done')
          verifyDone++
          verifyBytes += job.it.r ? job.it.r.size : 0
          emitPlan()
        }
      }
      // 并发上限取 min(prefs.concurrency, 4)：verify 只是规划期的事实采集，
      // 不应挤占传输带宽，也不应让小服务器同时承受过多下载
      await Promise.all(Array.from({ length: Math.max(1, Math.min(4, Number(prefs.concurrency) || 4)) }, verifyWorker))
      emitPlan(true) // verify 池收尾：最终 verifyDone / 字节数必然送达（节流豁免）
    }

    // ---- 规划第二遍（串行回填）：verify 结果 → 决策 → 生成传输任务 ----
    const jobOf = new Map(verifyJobs.map((j) => [j.it, j]))

    // 档位保护参数：按「扫描期远端条目」与档位推导每次上传 / 删除的守卫。
    //   A 档：已存在文件带 If-Match（仅强 etag，弱 etag 绝不用于 If-Match），
    //         新上传带 If-None-Match:*；扫描期 etag 弱 / 缺失时退化为 B 档复查；
    //   B 档：覆盖 / 删除已存在文件前紧邻复查（recheck）；新上传的写前保护由规划完成后的
    //         「写前查重」（bNewUploads）承担，不在此处（recheck 是文件级 Depth 0，
    //         查重按父目录分组一次 Depth 1，省请求）；
    //   C 档：上传 / 删除在规划层已整体跳过，此处不会走到。
    const uploadGuards = (scanR: any) => {
      const exists = scanR && !scanR.isDir
      if (caps.tier === 'A') {
        if (exists) {
          const tag = strongEtagOf(scanR.etag)
          return tag != null ? { ifMatch: `"${tag}"` } : { recheck: scanR }
        }
        return { ifNoneMatchStar: true }
      }
      if (caps.tier === 'B') return exists ? { recheck: scanR } : {}
      return {}
    }
    const deleteGuards = (scanR: any) => {
      const exists = scanR && !scanR.isDir
      if (caps.tier === 'A') {
        const tag = exists ? strongEtagOf(scanR.etag) : null
        return tag != null ? { ifMatch: `"${tag}"` } : exists ? { recheck: scanR } : {}
      }
      if (caps.tier === 'B') return exists ? { recheck: scanR } : {}
      return {}
    }
    /**
     * 上传任务入队（规划 upload 分支与「远端根重建保护 → 恢复上传」改判共用）。
     * B 档「扫描期远端不存在」的新上传登记写前查重目标（bNewUploads）：这是唯一
     * 写前零守卫的远端写路径，对端在扫描 → 写入窗口内新建同名文件会被静默覆盖。
     * 半截强制重传必有扫描期远端条目（残缺文件本身），不进此集合。
     * 两段提交：intent → PUT（uploadOne）→ 暂存；基线提交与 done 移到批量校验阶段。
     */
    /**
     * 上传任务入队（两段提交：intent → PUT → 暂存，基线提交与 done 在批量校验阶段）。
     * @param settlePendings 传入 true 时按冲突落地语义在基线提交成功后清除该文件的
     *   挂起记录（runUploadOp fromConflict → 批量提交点 clearPending）——「不删除」
     *   决策的恢复上传用它清掉已解决的删除挂起；半截强制重传同样传 true
     *   （远端被证实为本机残缺文件，等效 choice='local'）。
     */
    const pushUploadTransfer = (it: any, settlePendings = false) => {
      const scanR = it.r
      if (!scanR && caps.tier === 'B') bNewUploads.add(it.rel)
      pushTransfer(
        it.rel,
        async () => {
          const parked = await runUploadOp(
            it,
            scanR && scanR.origName,
            async (uh: any) => {
              const up = await uploadOne(cfg, dir, it.rel, it.l, createdDirs, uploadGuards(scanR), { onBeforePut: uh.onBeforePut })
              await crashHook({ rel: it.rel, act: 'upload' })
              bytesDoneAcc += it.l.size
              return up
            },
            settlePendings || forceUploads.has(it.rel)
          )
          return parked ? UPLOADED_PENDING : undefined
        },
        'upload',
        it.l.size
      )
    }
    for (const it of plan) {
      await maybeYield() // 规划第二遍（决策回填）分片让出
      if (shouldAbort() || verifyOutcome.get(it) === 'skipped') {
        aborted = true
        break
      }
      const { l, r, m } = it
      const flags = it.flags || {}
      const job = jobOf.get(it)
      let resolvedKeep = false
      // 大小写冲突（4.5）：不参与 A/B 类回填与无基线 adopt 收敛（收敛会写基线，
      // 让两个互为大小写变体的文件都「看起来已同步」，掩盖冲突）
      const caseHit = caseSkip.has(it.rel)

      if (!caseHit && m) {
        // ---- A 类回填：内容相同 → 静默采纳新远端指纹并累计指纹噪声 ----
        if (job && job.kind === 'a') {
          if (job.rh != null) {
            if (job.rh === m.lhash) {
              await store.setEntry(it.rel, { ...m, rsize: r.size, rmtimeMs: r.mtimeMs, retag: r.etag }).catch(() => {})
              m.rsize = r.size
              m.rmtimeMs = r.mtimeMs
              m.retag = r.etag
              flags.rChanged = false
              summary.adopted++
              // 噪声按 origin+username 粒度累计：同一服务器（同账号）下跨目录共享
              if (serverNoise.noteFingerprintNoise(it.rel)) {
                noiseDirty = true
                logNote('检测到服务器指纹不稳定（指纹变化但内容相同）：后续此类变化将直接做内容比对')
              }
            } else if (serverNoise.resetFingerprintNoise(it.rel)) {
              // 远端发生真实内容变化：移出噪声集合（返回 true = 确实移除，需要落盘）
              noiseDirty = true
            }
          } else {
            logNote(`无法完成远端内容校验 ${it.rel}：按「远端已变化」处理`)
          }
        }

        // ---- B 类回填：双侧都变且 size 相同 → 比较两侧当前内容，相同则 adopt（不算冲突）----
        if (l && r && flags.lChanged && flags.rChanged && l.size === r.size && l.size <= verifyMaxBytes) {
          const lh = job ? job.lh : null
          const rh = job ? job.rh : null
          if (lh != null && rh === lh) {
            await store.setEntry(it.rel, entryFrom(l, r, lh, { origName: r.origName })).catch(() => {})
            it.m = store.get(it.rel)
            flags.lChanged = false
            flags.rChanged = false
            summary.adopted++
            resolvedKeep = true
          }
        }
      } else if (!caseHit && l && r) {
        // ---- 无基线回填：两侧都在 → size/mtime/hash 收敛判定 ----
        let newBoth
        let adoptHash: any = null
        if (l.size !== r.size) {
          newBoth = 'conflict'
        } else if (Math.abs((l.mtimeMs || 0) - (r.mtimeMs || 0)) <= localTol) {
          newBoth = 'adopt'
        } else if (l.size <= verifyMaxBytes) {
          const lh = job ? job.lh : null
          const rh = job ? job.rh : null
          if (lh != null && rh === lh) {
            newBoth = 'adopt'
            adoptHash = lh
          } else {
            newBoth = 'conflict'
          }
        } else {
          pushWarning(`「${it.rel}」文件太大，无法自动对比两边是否一致，请你选择保留哪一个`)
          newBoth = 'conflict'
        }
        flags.newBoth = newBoth
        if (newBoth === 'adopt') {
          await store.setEntry(it.rel, entryFrom(l, r, adoptHash, { origName: r.origName })).catch(() => {})
          it.m = store.get(it.rel)
          summary.adopted++
          resolvedKeep = true
        }
      }

      // 半截强制重传：recoverIntents 判定「远端是本机上次中断上传的半截」
      // 的 rel 直接按 upload 规划 —— 远端变化是本机自己的残留而非对端修改，冲突语义不适用；
      // 档位守卫照常生效（A 档 If-Match 用本轮扫描 etag / B 档复查），GET 校验与 PUT 之间
      // 对端再改则按 412 / REMOTE_CHANGED 落回冲突。download 模式不强制（该模式下上传意图
      // 只可能来自历史冲突解决，交由正常冲突流程裁决）。
      // 大小写冲突文件不做强制重传（caseSkip 优先 —— 覆盖谁都是静默数据丢失）。
      // 一次性拉取（增量/全量）不强制（该方向不做任何上传）。
      const forcedUpload =
        forceUploads.has(it.rel) && !!l && opHint !== 'pull' && opHint !== 'pull-full' && mode !== 'download' && !caseSkip.has(it.rel)
      const act = forcedUpload ? 'upload' : resolvedKeep ? 'keep' : decideAction(it.rel, l, r, m, mode, { ...flags, oneshot: opHint }).act

      // 大小写冲突（4.5）：涉及的文件跳过一切传输 / 冲突 / 收敛动作；删除传播放行
      //（用户删除其一正是消除冲突的手段）；错误已在 4.5 逐组上报，此处静默跳过。
      if (caseSkip.has(it.rel) && (act === 'upload' || act === 'download' || act === 'conflict')) continue

      // 删除挂起标记失效清理：该 rel 不再规划为删除（状态已变化：文件重新出现 /
      // 被上传收敛 / 两侧皆无），确认与保留都失去对象 → 清除标记，面板不再滞留。
      // 覆盖包括 clean / skip / keep 在内的全部早退分支，故放在一切闸门之前。
      // 一次性单向轮（增量/全量）除外：op 轮的删除差异是否真的收敛要等常规轮
      // 确认（补齐档恢复 / 冻结，覆盖档的删除还要过删除安全闸），挂起原样保留
      // —— 清掉会让等确认的删除悄悄失效；恢复 / 删除落地路径自会消费挂起。
      {
        const dm = store.getPending(it.rel)
        if (dm && dm.kind === 'delete' && !opHint && act !== 'delete-local' && act !== 'delete-remote') store.clearPending(it.rel)
      }

      // 无基线保护兜底：基线不可信的轮次绝不执行删除
      if ((act === 'delete-local' || act === 'delete-remote') && !store.loadedOk) {
        pushWarning(`出于安全考虑，跳过了「${it.rel}」的删除`)
        continue
      }
      // 两侧均已不存在：丢弃基线条目（旧引擎靠整表重建天然丢弃，基线方案需显式删除）；
      // 该文件的持续失败退避记录一并清除（两侧皆无，无需再退避）
      if (act === 'clean') {
        await store.deleteEntry(it.rel).catch(() => {})
        store.clearFailure(it.rel)
        continue
      }
      if (act === 'skip' || act === 'keep') continue

      // C 档（只读）保护：跳过一切上传与删除（delete-local 也要跳过 —— 远端只读时
      // 删除本地等于丢数据）；需要上传的冲突解决一并跳过（choice='remote' 的纯下载场景
      // 在询问前无法预知，统一跳过最安全，下轮重新规划）。跳过仅计 warning，轮次不报错。
      if (caps.tier === 'C' && (act === 'upload' || act === 'delete-local' || act === 'delete-remote' || act === 'conflict')) {
        roSkipped++
        continue
      }

      // 持续失败退避：该文件在本机记录的永久失败尚未到重试时间 → 本轮不生成传输
      // 任务，计入 permSkipped（轮末汇总一条 warning）。只挡 upload / download / delete-*：
      // conflict 涉及用户决策（询问 / 挂起），照常走冲突流程不挡；本判定在无基线保护、
      // C 档跳过等既有闸门之后，优先级低于它们。
      if (act === 'upload' || act === 'download' || act === 'delete-local' || act === 'delete-remote') {
        const fr = store.getFailure(it.rel)
        if (fr && fr.retryAtMs > Date.now()) {
          permSkipped.push({ rel: it.rel, fr })
          continue
        }
      }

      // 删除类动作不入队 —— 收集后统一过删除安全闸（阈值 / 确认标记 / 根重建保护，
      // 见规划第二遍之后的「删除安全闸」块）；确认前的零删除约束在那里统一保证
      if (act === 'delete-local' || act === 'delete-remote') {
        deletePlanItems.push({ it, act })
        continue
      }

      if (act === 'upload') {
        pushUploadTransfer(it)
        continue
      }
      if (act === 'download') {
        pushTransfer(
          it.rel,
          () =>
            runOp(it, 'download', async (commitSet: any) => {
              const dl = await downloadOne(cfg, dir, it.rel, tmpDir, null, {
                expectedLocal: it.l || null,
                expectedRemoteSize: it.r.size,
                remoteMtimeMs: it.r.mtimeMs,
                origName: it.r.origName,
              })
              await crashHook({ rel: it.rel, act: 'download' })
              await commitSet(entryFrom({ size: dl.size, mtimeMs: dl.mtimeMs }, it.r, dl.hash, { origName: it.r.origName }))
              summary.downloaded++
              // 同步记录：本地侧落地成功（扫描期本地没有该文件 = 本地新增）
              recordSyncOp({ op: 'download', rel: it.rel, bytes: it.r.size, added: !it.l })
              summary.bytesDown += it.r.size
              bytesDoneAcc += it.r.size
            }),
          'download',
          it.r.size
        )
        continue
      }

      // conflict：根据策略解决（ask 时回调渲染层弹窗，支持「应用到本轮剩余」）。
      // 未解决（ask 无回调 / 回调返回非法值 / 选择所需的侧缺失）→ 该文件报错，其余文件不受影响。
      // 冲突解决产生的上传（choice=local 与 both 的第二段上传）同样走两段提交：
      // PUT 后暂存、批量校验阶段提交；「同时保留」的冲突副本下载提交保持即时（下载路径不动）。
      // 冲突挂起：决策与沿用都在 resolveChoiceInner 内登记；落地动作带
      // conflict 标记，成功提交后清除挂起、失败保留（下一轮沿用，不再询问）。
      pushTransfer(
        it.rel,
        async () => {
          const choice = await resolveChoice(it)
          let uploadPending = false
          // defer = 本轮挂起跳过 —— 计入 deferredConflicts，不报错、
          // 不计 conflicts，其余文件照常。正常返回（非 UPLOADED_PENDING）视为该任务
          // 完结（conflict 本无失败退避记录，clearFailure 空转无害）
          if (choice === 'defer') {
            summary.deferredConflicts++
            return undefined
          }
          if (choice === 'local') {
            if (!it.l) throw new Error(`你选择了保留电脑版本，但电脑上的「${it.rel}」已经不在了`)
            uploadPending = await runUploadOp(it, r && r.origName, async (uh: any) => {
              const up = await uploadOne(cfg, dir, it.rel, it.l, createdDirs, uploadGuards(r), { onBeforePut: uh.onBeforePut })
              await crashHook({ rel: it.rel, act: 'conflict-local' })
              bytesDoneAcc += it.l.size
              return up
            }, true)
          } else if (choice === 'remote') {
            if (!it.r || it.r.isDir) throw new Error(`你选择了保留云端版本，但云端的「${it.rel}」已经不在了`)
            await runOp(it, 'download', async (commitSet: any) => {
              const dl = await downloadOne(cfg, dir, it.rel, tmpDir, null, {
                expectedLocal: it.l || null,
                expectedRemoteSize: it.r.size,
                remoteMtimeMs: it.r.mtimeMs,
                origName: it.r.origName,
              })
              await crashHook({ rel: it.rel, act: 'conflict-remote' })
              await commitSet(entryFrom({ size: dl.size, mtimeMs: dl.mtimeMs }, it.r, dl.hash, { origName: it.r.origName }))
              summary.downloaded++
              summary.bytesDown += it.r.size
              bytesDoneAcc += it.r.size
            }, { conflict: true })
          } else {
            // 同时保留：云端版本另存为 <name>.conflict.<ext>，本地版本原样上传覆盖云端
            if (!it.l || !it.r) throw new Error(`你选择了两个都留，但「${it.rel}」有一侧已经不在了`)
            const segs = it.rel.split('/')
            const fileName = segs[segs.length - 1]
            const dot = fileName.lastIndexOf('.')
            const conflictName = dot > 0 ? `${fileName.slice(0, dot)}.conflict${fileName.slice(dot)}` : `${fileName}.conflict`
            const conflictRel = [...segs.slice(0, -1), conflictName].join('/')
            // 冲突副本目标若在计划中存在（上一轮的副本），按其计划指纹做覆盖保护。
            // 副本先行落基线（verified 事实）：此处崩溃 → 原文件仍无基线、仍冲突，重选 both 幂等重做。
            const dl = await downloadOne(cfg, dir, it.rel, tmpDir, conflictRel, {
              expectedLocal: (planByRel.get(conflictRel) && planByRel.get(conflictRel).l) || null,
              expectedRemoteSize: it.r.size,
            })
            const conflictAbs = path.join(dir.localPath, ...conflictRel.split('/'))
            const cst = await fsp.stat(conflictAbs)
            await store.setEntry(conflictRel, entryFrom(cst, it.r, dl.hash, { origName: conflictName, conflictCopy: true }))
            uploadPending = await runUploadOp(it, undefined, async (uh: any) => {
              const up = await uploadOne(cfg, dir, it.rel, it.l, createdDirs, uploadGuards(r), { onBeforePut: uh.onBeforePut })
              await crashHook({ rel: it.rel, act: 'conflict-both' })
              bytesDoneAcc += it.l.size + it.r.size
              return up
            }, true)
            summary.downloaded++
          }
          // 同步记录：冲突已按选择落地（本地 / 云端 / 副本下载与覆盖上传的
          // 落地动作不再单记 —— 冲突条目本身即两侧改动的完整描述）
          recordSyncOp({ op: 'conflict', rel: it.rel, choice })
          summary.conflicts++
          return uploadPending ? UPLOADED_PENDING : undefined
        },
        'conflict',
        // 冲突的落地动作要到执行期（用户选择）才知道方向：按两侧之和估算传输分母
        (it.l ? it.l.size : 0) + (it.r ? it.r.size : 0)
      )
    }

    // ---- 删除安全闸（规划第二遍之后、按需拿锁 / B 档查重之前）----
    // 删除类动作统一在此过闸（规划期只收集）。逐项判定，先到先得：
    //   1. 挂起标记 kind='delete' 且 choice='delete'（用户逐文件显式确认，无 scope
    //      来源）→ 照常入队执行 —— 显式同意优先于一切保护（含远端根重建保护）；
    //   2. 删除范围决策（目录树上的批量选择）命中 → 照 choice 执行 / 消费 ——
    //      最具体（最长前缀）者胜，覆盖逐文件挂起表装不下的部分（「全部不删除 /
    //      全部确认删除」的落地通道）与同代盖章记录的细化决策；
    //   3. 挂起标记 choice='keep'（用户逐文件保留）或 scope 盖章记录 → 按方向消费
    //     （consumeKeepChoice）：delete-local 恢复上传（deleteRestored）、
    //      delete-remote 抑制（deleteKept）；恢复成功后情形消失，scope 自动剪枝；
    //   4. 挂起标记无 choice（待确认）→ 抑制 ——「确认前零删除」的绝对约束，
    //      与阈值无关：已挂起的条目永远等确认，不因后续轮次数量回落而放行；
    //   5. 无标记的新鲜删除：
    //      a. 远端根丢失「移除本地」决策执行中（meta.rootLostRemoval）→ delete-local
    //         视为用户已确认（根级决策覆盖批量阈值与重建保护），入队执行；本地有
    //         改动的文件不会到这里 —— 规划层已将其判为 upload（改动优先于删除）；
    //      b. 远端根重建保护生效中（meta.rootRebuilt）→ delete-local 改判为「恢复上传」
    //         并计入 deleteRootGuard（远端缺失是根消失伪象，复活取向重传远端），
    //         delete-remote 暂缓；上传与远端和解后自动恢复删除传播；
    //      c. 新鲜删除总数 > max(50, 基线条目数×20%) → 整批挂起：逐项登记
    //         kind='delete' 挂起记录（无 choice），计入 deleteHeld，本轮零删除，
    //         用户经待处理面板确认 / 保留后下一轮落地；同时构建 / 刷新批量删除
    //         快照（目录树，「全部 / 按目录」范围决策的完整事实源）；
    //      d. 其余 → 照常入队执行。
    // 已确认 / 用户选择保留的删除不计入阈值（阈值只度量「未经确认的批量删除」，
    // 否则已确认的整批会永远无法执行）。挂起登记失败（条目上限满）只影响
    //「下一轮是否需重新登记」，不影响零删除约束 —— 抑制由数量判定驱动。
    const deleteThreshold = Math.max(DELETE_BATCH_MIN, Math.ceil(store.entries.size * DELETE_BATCH_RATIO))
    // removalForced：本轮经 rootLostRemoval 标记放行的 delete-local 数。轮末解除判定
    // 的输入 —— 降为 0 的干净轮说明「移除本地」已和解（待移除文件要么已删除、
    // 要么因本地改动改走上传），标记可解除，恢复正常删除语义（含批量阈值保护）
    let removalForced = 0
    const registerDeleteHold = (it: any) => {
      const ok = store.setPending(it.rel, {
        kind: 'delete',
        local: { size: it.l ? it.l.size : 0, mtimeMs: it.l ? it.l.mtimeMs : 0 },
        remote: { size: it.r ? it.r.size : 0, mtimeMs: it.r ? it.r.mtimeMs : 0, etag: it.r ? it.r.etag || '' : '' },
        createdAt: Date.now(),
      })
      if (!ok) logNote(`删除确认记录已满：${it.rel} 的挂起未持久化（本轮仍不删除，下一轮将重新登记）`)
    }
    const pushDeleteTransfer = (entry: any) => {
      const it = entry.it
      if (entry.act === 'delete-local') {
        pushTransfer(
          it.rel,
          () =>
            runOp(it, 'delete-local', async (_commitSet: any, commitDel: any) => {
              await deleteLocalOne(dir, it.rel, it.m && it.m.origName)
              await crashHook({ rel: it.rel, act: 'delete-local' })
              await commitDel()
              // 已确认删除落地 → 清除删除挂起标记（决策完成；冲突类挂起不经此路径）
              const pd = store.getPending(it.rel)
              if (pd && pd.kind === 'delete') store.clearPending(it.rel)
              summary.deleted++
              // 同步记录：电脑侧删除落地成功
              recordSyncOp({ op: 'delete-local', rel: it.rel })
              localDeletedRels.add(it.rel) // 空目录清理候选（本地侧祖先目录）
            }),
          'delete-local'
        )
      } else {
        pushTransfer(
          it.rel,
          () =>
            runOp(it, 'delete-remote', async (_commitSet: any, commitDel: any) => {
              // 档位保护：A 档带 If-Match（扫描期强 etag）；B 档（或 etag 弱/缺失）
              // 先紧邻复查扫描期指纹，不符放弃该文件
              const dg = deleteGuards(it.r)
              if (dg.recheck) await recheckRemoteUnchanged(cfg, joinRemote(dir.remotePath, it.rel), dg.recheck, it.rel)
              const res = await davRequest(cfg, 'DELETE', joinRemote(dir.remotePath, it.rel), dg.ifMatch ? { headers: { 'If-Match': dg.ifMatch } } : {})
              // 404 视为成功：远端目标状态（文件不存在）已达成
              if (res.status === 412) {
                const err: any = new Error(`「${it.rel}」未从云端删除：它刚被其他设备修改过`)
                err.detail = 'HTTP 412（If-Match 不匹配）'
                err.code = 'PRECONDITION'
                err.status = 412
                err.permanent = true
                throw err
              }
              if (!(res.status === 200 || res.status === 204 || res.status === 404)) {
                // 附带 status 与分类 code：classifyOpFailure 据此判定永久 / 瞬时失败
                const err: any = new Error(`无法从云端删除「${it.rel}」（HTTP ${res.status}）`)
                err.status = res.status
                err.code = (res.classification && res.classification.code) || 'HTTP'
                throw err
              }
              await crashHook({ rel: it.rel, act: 'delete-remote' })
              await commitDel()
              const pd = store.getPending(it.rel)
              if (pd && pd.kind === 'delete') store.clearPending(it.rel)
              summary.deleted++
              // 同步记录：云端侧删除落地成功
              recordSyncOp({ op: 'delete-remote', rel: it.rel })
              remoteDeletedRels.add(it.rel) // 空目录清理候选（远端侧祖先目录）
            }),
          'delete-remote'
        )
      }
    }
    const freshDeletes: any[] = []
    let deleteThresholdTripped = false
    /**
     * 「不删除」决策的消费（逐文件保留 / 范围决策 / 盖章记录共用），按方向落地：
     *   - delete-local（云端已缺、本地完好且未变 —— 规划真值表保证）：只抑制会把
     *     两端永久卡在分叉态（云端侧没有任何恢复通道，且每轮重复提示）。改判为
     *     「恢复上传」（复活取向，与无基线保护 / 根重建保护同语义）：本地文件原样
     *     保留，云端缺失的副本由本地上传恢复，两端重新一致。settlePendings 使基线
     *     提交成功后清除该文件的删除挂起（决策完成）；恢复失败（网络 / 412）挂起
     *     保留，下一轮继续按决策重试；恢复全部成功后 scope 零匹配自动剪枝。
     *   - delete-remote（本地已删、云端完好）：抑制 = 云端副本按用户意愿保留
     *    （本地删除是用户自己的动作，引擎不反向恢复），计入 deleteKept。
     */
    const consumeKeepChoice = (entry: any) => {
      if (entry.act === 'delete-local' && entry.it.l) {
        summary.deleteRestored++
        pushUploadTransfer(entry.it, true)
      } else {
        summary.deleteKept++
      }
    }
    // 本轮命中的删除范围决策前缀 → 命中文件数（轮末剪枝输入：零命中的 scope 视为
    // 情形已消失自动移除，避免陈旧 keep 永远压制未来的新删除事件）
    const scopeMatchCounts = new Map<string, number>()
    // 未决策删除候选（rel → 本地大小）：历史登记无 choice 的 + 本轮新鲜的 ——
    // 触发拦截时据此构建 / 刷新批量删除快照（UI 目录树与「全部」类决策的事实源）
    const undecidedMembers = new Map<string, number>()
    for (const entry of deletePlanItems) {
      const it = entry.it
      const pd = store.getPending(it.rel)
      // 1. 用户逐文件显式选择（setPendingChoice，无 scope 来源标记）：最优先，
      //    范围决策不得翻案 ——「全部」只作用于当前树里未决策的部分
      if (pd && pd.kind === 'delete' && pd.choice && pd.scope == null) {
        if (pd.choice === 'delete') pushDeleteTransfer(entry)
        else consumeKeepChoice(entry)
        continue
      }
      // 2. 删除范围决策（目录树上的批量选择）：按前缀匹配，最具体者胜。覆盖逐文件
      //    挂起表装不下的候选（「全部不删除 / 全部确认删除」的落地通道）；同代盖章
      //    记录的细化决策（文件级 scope 压过子树 scope）也在此消费
      const scope = store.matchDeleteScope(it.rel)
      if (scope) {
        scopeMatchCounts.set(scope.prefix, (scopeMatchCounts.get(scope.prefix) || 0) + 1)
        if (scope.choice === 'delete') {
          pushDeleteTransfer(entry)
        } else {
          consumeKeepChoice(entry)
        }
        undecidedMembers.delete(it.rel)
        continue
      }
      if (pd && pd.kind === 'delete' && pd.choice) {
        // 3. 范围决策盖章的记录（scope 已剪枝 / 代际更迭后由盖章兜底）：按盖章选择
        //    消费 —— 与逐文件确认同语义（删除执行成功后清除；失败保留重试）
        if (pd.choice === 'delete') pushDeleteTransfer(entry)
        else consumeKeepChoice(entry)
        continue
      }
      if (pd && pd.kind === 'delete') {
        // 4. 待确认：标记已存在，抑制（不重复登记）。「确认前零删除」绝对约束：
        //    与阈值无关，已挂起的条目永远等确认，不因数量回落放行
        summary.deleteHeld++
        undecidedMembers.set(it.rel, pd.local ? pd.local.size : 0)
        continue
      }
      if (store.meta.rootLostRemoval && entry.act === 'delete-local') {
        // 根丢失「移除本地」决策执行中：用户已在根级确认移除，delete-local 等同
        // 已确认删除（先于根重建保护与批量阈值判定）
        removalForced++
        pushDeleteTransfer(entry)
        continue
      }
      if (store.meta.rootRebuilt) {
        // 远端根重建保护：远端缺失是根消失的伪象而非逐文件删除。
        // delete-local 改判为「恢复上传」（复活取向，与无基线保护语义一致 ——
        // 宁可重传也不把「远端整树消失」解释成删除），上传全部成功后下一轮
        // 自动恢复删除传播；delete-remote（重建窗口内本地删除）暂缓至保护解除。
        // 用户显式确认过的删除在上方已放行，不受保护拦截。
        summary.deleteRootGuard++
        if (entry.act === 'delete-local' && it.l) pushUploadTransfer(it)
        continue
      }
      freshDeletes.push(entry)
    }
    if (freshDeletes.length > deleteThreshold) {
      for (const entry of freshDeletes) {
        registerDeleteHold(entry.it)
        summary.deleteHeld++
        undecidedMembers.set(entry.it.rel, entry.it.l ? entry.it.l.size : 0)
      }
      deleteThresholdTripped = true
      pushWarning(
        `这次要删除的文件有 ${freshDeletes.length} 个，数量偏多，为防止误删，没有删除任何文件。请在「待处理」里确认，确认后下次同步才会执行`
      )
      // 构建 / 刷新批量删除快照：含历史登记未决策的 + 本轮新鲜的（含登记超上限
      // 未持久化的部分 —— 它们没有逐文件记录，快照是它们对用户可见的唯一通道）
      store.setDeleteBatch(buildDeleteBatch(undecidedMembers, Date.now()))
    } else {
      for (const entry of freshDeletes) pushDeleteTransfer(entry)
    }
    // 范围决策剪枝 + 快照清理（仅扫描完整轮：扫描不完整时「零匹配 / 无未决策」
    // 不可信 —— 残缺的远端列表会把「还没看到」误判成「情形已消失」）。剪枝：
    // 零匹配的 scope 视为情形已消失自动移除。快照清除：本轮未触发拦截且已无
    // 未决策候选（scope 消费 / 逐文件确认 / 逐文件选择覆盖完毕）—— UI 树随之消失。
    if (remoteScan.complete) {
      const pruned = store.pruneDeleteScopes(new Set(scopeMatchCounts.keys()))
      if (pruned > 0) logNote(`${pruned} 条删除范围决策覆盖的删除已不存在（文件恢复 / 处理完毕），已自动清除`)
      if (!deleteThresholdTripped && undecidedMembers.size === 0) store.clearDeleteBatch()
    }

    // ---- 规划完成后、worker 执行前的两道闸（按需租约锁 → B 档新上传写前查重）----

    /**
     * 规划期已发生的本地状态变更统一落盘：WAL 恢复采纳 / touch 型 mtime 刷新 / 无基线
     * adopt / 指纹噪声标记 / 退避与挂起表。这些变更只依赖扫描结果、与是否传输无关，
     * 让出路径与轮末收尾共用同一套调用 —— 让出不回滚本地已确认的事实，下轮从一致状态出发。
     */
    const persistPlannedLocalState = async () => {
      await store.flush().catch(() => {})
      if (!store.loadedOk) await store.compact().catch(() => {})
      else await store.compactIfNeeded().catch(() => {})
      if (deepVerifyDue) store.meta.lastDeepVerifyAt = Date.now()
      await store.saveMeta().catch(() => {})
      if (store.failuresDirty) await store.saveFailures().catch(() => {})
      if (store.pendingsDirty) await store.savePendings().catch(() => {})
      if (!aborted) await store.truncateWal().catch(() => {})
      if (noiseDirty) await serverNoise.saveNoise().catch(() => {})
    }

    // 按需拿锁（锁后置 + 按需）：仅当本轮计划含「远端写」操作 —— upload
    //（新上传 / 覆盖，含冲突决策产生的覆盖上传）、delete-remote、或可能落地为上传的
    // conflict（choice 要到执行期才知道，保守按远端写计）—— 才尝试获取租约锁；纯空轮 /
    // 纯下载轮完全不发锁请求（省 4 个请求 + 1.5s 写回静置）。delete-local 与 download
    // 不触碰远端不算；远端 MKCOL 只伴随上传发生（父目录补齐），无需单列 —— 同步根建
    // 目录在轮首（锁后置前后都在锁外）。prefs.leaseLock === false 时整体关闭（写轮也
    // 不拿锁，语义不变）；C 档轮次因规划层已剔除全部远端写，天然不再进入。
    // 规划期已取消（aborted）的轮次不再拿锁 —— 取消应尽快收场，不为一把
    // 马上要释放的锁发出 GET/PUT/回读共 4 个请求与 1.5s 写回静置。
    const hasRemoteWrite = transferMeta.some((t) => t.kind === 'upload' || t.kind === 'delete-remote' || t.kind === 'conflict')
    if (hasRemoteWrite && !aborted && !shouldAbort() && prefs.leaseLock !== false) {
      // 锁阶段进度（含 GET → PUT → 1.5s 写回静置 → 回读确认的完整窗口）：
      // UI 显示「正在确认租约锁…」。force 外发 —— 与 verify 终态事件同相位，不吃节流
      onProgress({ phase: 'plan', filesDone: 0, filesTotal: plan.length, bytesDone: 0, bytesTotal: 0, stage: 'lock', scanBytesTotal }, true)
      const deviceId = await storage.getDeviceId()
      const acq = await acquireLeaseLock(cfg, lockPath, deviceId)
      if (acq.warn) logNote(acq.warn)
      if (acq.outcome === 'yield') {
        // 让出：本轮不做任何传输（含已规划的下载），按零计数成功返回 —— 这不是错误，
        // 调度层的下一轮自然重试；对端轮次结束后锁被释放或按 TTL 过期。totalFiles 归零
        // 维持「让出 = 零传输」的既有契约；planned 为信息性
        // 字段：本轮规划了 N 项传输因让出未执行（渲染层不依赖，仅供观测 / 测试断言）。
        summary.yielded = true
        summary.totalFiles = 0
        summary.planned = transferMeta.length
        pushWarning('另一台设备正在同步这个文件夹，本次先等一等')
        await persistPlannedLocalState()
        finalizeSummaryMeta() // 让出轮同样补齐机器可读字段（openIntents 对 follow-up 有意义）
        return summary
      }
      if (acq.outcome === 'acquired') {
        lockHeld = true
        // 续租定时器：每 LOCK_RENEW_MS 重写锁内容（startedAt 保持首次值；重写即刷新
        // mtime，服务器时钟年龄随之归零）。续租走无熔断 cfg + noRetry：它是尽力而为的
        // 保活，失败只记一条 warning、绝不计入整轮熔断（不中断轮次）。同样
        // 豁免取消检查：取消解算期（worker 收尾 → 释放 finally）恰好撞上续租滴答时，
        // 让这次轻量保活照常完成远好于报一条「续租失败」噪声（释放 finally 紧随其后）。
        // unref 防止定时器阻止进程退出；正常轮末由释放 finally 清理，崩溃注入路径由
        // cleanup() 全局清扫。
        let renewWarned = false
        const renewBody = JSON.stringify({ v: 1, deviceId, startedAt: acq.startedAt, ttlMs: LOCK_TTL_MS })
        const renewOnce = () =>
          davRequest({ ...cfg, __wdsyncBreaker: null, __wdsyncAbort: null }, 'PUT', lockPath, { headers: { 'Content-Type': 'application/json' }, body: renewBody, noRetry: true }).then(
            (r) => {
              if (r.status >= 400 && !renewWarned) {
                renewWarned = true
                logNote(`租约锁续租失败（HTTP ${r.status}）：锁可能提前过期，他机的让出保护将随之减弱`)
              }
            },
            (e) => {
              if (!renewWarned) {
                renewWarned = true
                logNote(`租约锁续租失败（${(e && e.message) || e}）：锁可能提前过期，他机的让出保护将随之减弱`)
              }
            }
          )
        renewTimer = nodeTimers.setInterval(renewOnce, LOCK_RENEW_MS)
        if (typeof renewTimer.unref === 'function') renewTimer.unref()
        RENEW_TIMERS.add(renewTimer)
      }
      // outcome === 'skip'：无法写锁（403/401/网络失败等）→ 不持锁继续同步，
      // 仅依赖档位保护 + 下方 B 档写前查重
    }

    // ---- B 档新上传写前查重（缓解覆盖洞）----
    // B 档（无条件请求能力）的「扫描期远端不存在」新上传是唯一写前零守卫的远端写路径：
    // 对端在「扫描 → 写入」窗口内新建同名文件会被静默覆盖（丢更新）。此处按父目录分组
    // 做一次 PROPFIND Depth 1 快查（复用批量校验阶段的请求形态与解析口径），名字已出现
    // 在远端者从执行队列剔除，按既有 REMOTE_CHANGED 类后果处理（本轮报错、不覆盖、下轮
    // 重新规划为冲突 / adopt；不进永久失败退避表）。查重不依赖锁的结果（acquired / skip /
    // 开关关闭都照做 —— 无锁时它反而是唯一保护）；查重请求失败（网络 / 非 207 / 解析
    // 失败）时该组文件按瞬时失败语义跳过本轮上传（同样绝不盲目裸 PUT、不进退避表，下轮
    // 自然重试）。放在拿锁之后：静置 1.5s 的观察窗更贴近写入时刻，且让出轮（无任何写入）
    // 天然不触发查重。规划期已取消的轮次跳过查重（worker 池随即按取消收场，
    // 不再为已取消的传输发守护请求；取消引发的请求失败也不报噪声错误）。
    if (bNewUploads.size > 0 && !shouldAbort()) {
      /** 从执行队列按 rel 剔除一个任务（transfers 与 transferMeta 同下标同步 splice；字节分母同步扣减） */
      const dropTransferByRel = (rel: any) => {
        const i = transferMeta.findIndex((t) => t.rel === rel)
        if (i < 0) return false
        transferBytesTotal -= transferMeta[i].bytes || 0
        transferMeta.splice(i, 1)
        transfers.splice(i, 1)
        return true
      }
      // 按父目录分组（rel 无 '/' → 同步根；否则取 dirname）：每组一次 PROPFIND Depth 1
      const byParent = new Map()
      for (const rel of bNewUploads) {
        const i = rel.lastIndexOf('/')
        const parent = i < 0 ? '' : rel.slice(0, i)
        if (!byParent.has(parent)) byParent.set(parent, [])
        byParent.get(parent).push(rel)
      }
      for (const [parent, rels] of byParent) {
        // 与批量校验阶段同一请求形态（isCollection：目录列举目标带尾斜杠发起）
        const dirRemote = parent ? joinRemote(dir.remotePath, parent) : dir.remotePath
        let childMap: any = null
        let groupErr: any = null
        try {
          const r = await davRequest(cfg, 'PROPFIND', dirRemote, {
            isCollection: true,
            headers: { Depth: '1', 'Content-Type': 'application/xml' },
            body: PROBE_PROPFIND_BODY,
          })
          if (r.status === 404) {
            // 404 = 远端父目录本身不存在 ⇒ 组内文件在远端必然无同名（比空列举更强的
            // 「无冲突」证据）—— 放行整组照常上传（首轮 PUT 前 MKCOL 建目录）。
            // 未特判时该组每轮被「查重失败」跳过且 MKCOL 永不发生，形成永不收敛的
            // 死循环（B 档 + 本地新建子目录场景）。
            continue
          }
          if (r.status !== 207 || !r.body) groupErr = `HTTP ${r.status}`
          else {
            childMap = new Map()
            // key 统一 NFC（与批量校验 / remoteByNfc 同口径）：NFD 服务器名也能命中
            for (const item of parseMultistatus(r.body.toString('utf-8'))) {
              const childRel = relFromHref(cfg, dirRemote, item.href)
              if (!childRel) continue // 集合自身
              childMap.set(nfc(childRel.replace(/\/+$/, '')), item)
            }
          }
        } catch (e: any) {
          groupErr = (e && e.message) || String(e)
        }
        if (groupErr) {
          // 组级失败（网络异常 / 非 207 / 解析失败）：该组新上传全部跳过本轮 —— 无法确认
          // 「远端没有同名文件」时按可能已存在处理是唯一安全方向，绝不盲目裸 PUT。
          // 只报错不记退避（瞬时失败语义：下轮重试自然恢复）。网络类标记：列举失败
          // 的主因是网络 / 5xx，解析失败也随列举通道归入 network（调度层退避口径）
          for (const rel of rels) {
            dropTransferByRel(rel)
            pushError(`「${rel}」暂未处理：无法确认云端文件的最新状态，下次同步重试`, true)
          }
          continue
        }
        for (const rel of rels) {
          await maybeYield() // 写前查重回填分片让出
          // 子条目 key 相对父目录集合；rel 是相对同步根的完整路径，剥离父前缀后比对
          const key = nfc(parent ? rel.slice(parent.length + 1) : rel)
          const item = childMap.get(key)
          if (item && !item.isDir) {
            dropTransferByRel(rel)
            // etag 跳过运行时防线（见 noteEtagSkipAnomaly）：写前查重发现远端出现了
            // 扫描期不存在的同名文件 —— 被跳过子树内即「远端实际状态 ≠ 合成（基线）状态」
            noteEtagSkipAnomaly(rel, '写前查重发现远端新文件')
            pushError(`「${rel}」暂未上传：云端的文件刚被其他设备修改，为避免覆盖，下次同步会重新判断`, false)
          }
        }
      }
    }

    // 7. 并发池执行
    // 传输开始事件（force 外发）：锁 / 查重闸门已过，UI 由此切入「正在同步文件」段，
    // 并拿到传输字节分母（此前阶段 bytesDone / bytesTotal 承载的是 verify 字节估算）
    onProgress(
      { phase: 'transfer', filesDone: 0, filesTotal: plan.length, bytesDone: 0, bytesTotal: transferBytesTotal, stage: 'transfer', scanBytesTotal },
      true
    )
    const conc = Math.max(1, Math.min(8, Number(prefs.concurrency) || 4))
    let idx = 0
    async function worker() {
      while (idx < transfers.length) {
        // 熔断 open 后停止领取新任务（已在执行的传输会以 CIRCUIT_OPEN 快速失败收尾）；
        // 取消同理 —— 网络层轮询 shouldAbort 后即时销毁在途请求（含大文件
        // 传输），ABORTED 错误经 handleTransferError 按「已取消」处理，不计失败
        if (shouldAbort() || roundBreaker.open) {
          aborted = true
          return
        }
        const i = idx++
        // 领取即报告当前任务（节流下可能被合并，取最后领取者即可）：UI 显示「正在上传 / 下载 …」
        const meta = transferMeta[i]
        currentTask = meta ? { op: meta.kind, rel: meta.rel } : null
        tick()
        const job = transfers[i]
        try {
          await job()
        } catch (e: any) {
          // 失败分类接线：permanent 记退避表、transient 收集待当轮重试、其余照常报错
          handleTransferError(e, job, false)
        }
        filesDone++
        tick()
      }
    }
    await Promise.all(Array.from({ length: conc }, worker))
    tick(true) // worker 池收尾：最终 filesDone / bytesDone 必然送达（节流豁免）
    // 后置收尾段（force 外发）：瞬时重试 / 批量校验提交 / 基线落盘 / 空目录清理 ——
    // UI 的整条进度按「传输 80% + 后置 10%」折算，此事件标记进入最后 10% 段
    onProgress(
      { phase: 'transfer', filesDone, filesTotal: plan.length, bytesDone: bytesDoneAcc, bytesTotal: transferBytesTotal, stage: 'finalize', scanBytesTotal },
      true
    )
    if (shouldAbort()) aborted = true

    // 瞬时失败当轮重试：worker 池全部结束后，对本轮收集的瞬时失败任务串行再执行
    // 一次（EBUSY 占用解除、瞬时 423 锁释放等场景）。只重试一轮次、不无限重试；熔断 /
    // 中止 / 崩溃注入时不执行。重试成功则该文件不计入轮次错误（pushTransfer 已清失败
    // 记录）；重试失败按其最终分类处理（permanent 照记退避表，其余照常报错）。
    if (transientFailed.length && !crashErr && !aborted && !roundBreaker.open) {
      for (const job of transientFailed) {
        if (shouldAbort() || roundBreaker.open) {
          aborted = true
          break
        }
        try {
          await job()
        } catch (e: any) {
          handleTransferError(e, job, true)
        }
      }
    }

    // ---- 批量校验阶段（两段提交的第二段）----
    // 位置：worker 池结束、瞬时失败当轮重试之后；crashErr 抛出与轮末收尾之前。
    // aborted（非崩溃）时也必须执行：已完成的 PUT 必须当场了结（提交基线或明确报错），
    // 不能把成功上传悬置到下一轮。crashErr 时跳过：模拟进程死亡不做任何收尾，
    // 遗留的 upload intent 交下一轮 recoverIntents 采纳 —— 崩溃窗口语义：
    // PUT 成功 → 此处批量提交之间崩溃，遗留 upload intent，下一轮按「本地未变 +
    // 远端已存在同 size」采纳。
    if (pendingUploads.length && !crashErr) {
      // 批量校验的列举请求豁免取消检查（__wdsyncAbort 置空）—— 取消轮也必须
      // 当场了结已成功的 PUT（提交基线或明确报错），不能把成功上传悬置到下一轮；收尾
      // 语义与释放锁的 finally 一致（见外层 finally 的豁免注释）。
      const calmCfg = { ...cfg, __wdsyncAbort: null }
      // 按父目录分组（rel 无 '/' → 同步根；否则取 dirname）：每组一次 PROPFIND Depth 1
      const byParent = new Map()
      for (const p of pendingUploads) {
        const i = p.rel.lastIndexOf('/')
        const parent = i < 0 ? '' : p.rel.slice(0, i)
        if (!byParent.has(parent)) byParent.set(parent, [])
        byParent.get(parent).push(p)
      }
      for (const [parent, pend] of byParent) {
        // 与 listRemoteSafe 同请求形态（isCollection：目录列举目标带尾斜杠发起；
        // body 与探测 / 扫描共用的同一组 props）
        const dirRemote = parent ? joinRemote(dir.remotePath, parent) : dir.remotePath
        let childMap: any = null
        let groupErr: any = null
        try {
          const r = await davRequest(calmCfg, 'PROPFIND', dirRemote, {
            isCollection: true,
            headers: { Depth: '1', 'Content-Type': 'application/xml' },
            body: PROBE_PROPFIND_BODY,
          })
          if (r.status !== 207 || !r.body) groupErr = `HTTP ${r.status}`
          else {
            childMap = new Map()
            // key 统一 NFC（两侧 key 归一）：NFD 服务器名也能命中 NFC rel（参照
            // listRemoteSafe → remoteByNfc 的做法）
            for (const item of parseMultistatus(r.body.toString('utf-8'))) {
              const childRel = relFromHref(cfg, dirRemote, item.href)
              if (!childRel) continue // 集合自身
              childMap.set(nfc(childRel.replace(/\/+$/, '')), item)
            }
          }
        } catch (e: any) {
          groupErr = (e && e.message) || String(e)
        }
        if (groupErr) {
          // 组级失败（网络异常 / 非 207 / 解析失败）：该组全部 pending 报错 —— 基线不写、
          // abort intent。下一轮可安全收敛：WAL 采纳（upload 意图 + 远端已存在同 size →
          // adopt）或按正常规划重传（远端确实没有该文件时）。网络类标记同写前查重口径
          for (const p of pend) {
            await store.appendWalAbort(p.intentId).catch(() => {})
            pushError(`「${p.rel}」上传后核对失败，下次同步会重试`, true)
          }
          continue
        }
        for (const p of pend) {
          await maybeYield() // 批量校验提交分片让出（大目录单轮数千 pending）
          // 子条目 key 相对父目录集合；pending.rel 是相对同步根的完整 rel，剥离父前缀后比对
          const key = nfc(parent ? p.rel.slice(parent.length + 1) : p.rel)
          const item = childMap.get(key)
          if (!item || item.isDir) {
            await store.appendWalAbort(p.intentId).catch(() => {})
            pushError(`「${p.rel}」上传后核对失败，下次同步会重试`, false)
            continue
          }
          if (item.size !== p.local.size) {
            await store.appendWalAbort(p.intentId).catch(() => {})
            pushError(`「${p.rel}」上传后核对失败，下次同步会重试`, false)
            continue
          }
          // 提交点：基线（远端指纹取自本次批量 PROPFIND，etag 口径与下一轮扫描一致）→ done →
          // 失败记录清除（清除随成功提交走）→ summary 计数（uploaded / bytesUp 在此计数；
          // bytesDoneAcc 进度计数留在传输闭包内，不随提交推迟）
          try {
            await store.setEntry(
              p.rel,
              entryFrom(p.local, { size: item.size, mtimeMs: item.mtime, etag: item.etag }, p.hash, p.origName ? { origName: p.origName } : {})
            )
            await store.appendWalDone(p.intentId)
          } catch (e: any) {
            // 基线写入失败（setEntry 抛出语义）：按文件级失败处理，abort 后报错
            await store.appendWalAbort(p.intentId).catch(() => {})
            pushError(`「${p.rel}」上传后核对失败，下次同步会重试`, false)
            continue
          }
          store.clearFailure(p.rel)
          // 冲突挂起：冲突解决的上传成功落地 → 清除该文件的挂起记录
          //（决策已完成；普通上传不带 conflict 标记、不受影响 —— 挂起只随冲突路径清除）
          if (p.conflict) store.clearPending(p.rel)
          summary.uploaded++
          // 同步记录：云端侧落地成功（含冲突 / 半截重传来源的上传 —— 冲突条目
          // 另记一条「选了什么」，两者分别描述云端改动与用户决策，互不替代）
          recordSyncOp({ op: 'upload', rel: p.rel, bytes: p.local.size, added: !!p.added })
          summary.bytesUp += p.local.size
        }
      }
    }

    // ---- 远端根重建保护解除判定（和解完成才恢复删除传播）----
    // 本轮根探测正常（未再 404）、非只读档、无任何错误且未取消（传输全部收尾成功）、
    // 且本轮没有因该保护跳过的删除（「本地未变 + 远端缺失」的待和解集合已清零：
    // 全部基线文件要么重新上传成功、要么两侧皆无）→ 清除标记，下一轮恢复正常删除传播。
    // 仍有跳过或本轮有失败 → 保守保留保护（下一轮干净轮次重新评估），并提示原因。
    if (store.meta.rootRebuilt && !rootWasRebuilt && !aborted && !roundBreaker.open && caps.tier !== 'C' && store.loadedOk && errorNetCount + errorOtherCount === 0) {
      if (summary.deleteRootGuard === 0) {
        delete store.meta.rootRebuilt
      }
    }
    if (store.meta.rootRebuilt && !rootWasRebuilt) {
      if (summary.deleteRootGuard > 0) {
        pushWarning(
          `云端文件夹之前丢失过，已把 ${summary.deleteRootGuard} 个原本会被当作「已删除」的文件改为重新上传，传完后恢复正常`
        )
      } else {
        pushWarning('云端文件夹之前丢失过，还有文件没传完，暂时不会同步「删除」操作，传完后恢复正常')
      }
    }

    // ---- 远端根丢失「移除本地」标记的解除判定 ----
    // 与 rootRebuilt 解除同口径的干净轮（无错误 / 未取消 / 非熔断 / 非只读 / 基线可信）
    // 且本轮再无经标记放行的删除（待移除集合已和解：要么已删除、要么因本地改动改走
    // 上传；keep 保留类由逐文件挂起独立抑制，不依赖本标记）→ 解除标记，恢复正常
    // 删除语义（含批量阈值保护）。仍有待移除或本轮有失败 → 保守保留标记，下一轮继续。
    if (
      store.meta.rootLostRemoval &&
      removalForced === 0 &&
      !aborted &&
      !roundBreaker.open &&
      caps.tier !== 'C' &&
      store.loadedOk &&
      errorNetCount + errorOtherCount === 0
    ) {
      delete store.meta.rootLostRemoval
      await store.saveMeta().catch(() => {})
    }

    // ---- 空目录清理（两端，best-effort，失败不报错）----
    // 范围严格限定「因本轮同步删除而变空」的目录：本轮成功删除文件的祖先目录
    //（不含同步根本身）；历史遗留 / 用户自建 / 他机留下的空目录不在清理范围。
    // 取消 / 熔断 / 崩溃注入轮不清理（收尾从简）；单目录清理失败静默跳过。
    if (!crashErr && !aborted && !roundBreaker.open) {
      // 本地：候选 = 本轮 delete-local 成功的祖先目录，按深度降序（先删最深的，
      // 父目录才有机会变空）。rmdir 对非空目录原子失败（ENOTEMPTY）—— 含被忽略
      // 的隐藏文件（如 .DS_Store）的目录自然跳过，不存在误删内容的可能。
      const localCandidates = new Set<any>()
      for (const rel of localDeletedRels) {
        const segs = rel.split('/')
        for (let i = segs.length - 1; i >= 1; i--) localCandidates.add(segs.slice(0, i).join('/'))
      }
      const localOrdered = Array.from(localCandidates).sort(
        (a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : 1)
      )
      for (const relDir of localOrdered) {
        await maybeYield()
        const absDir = path.join(dir.localPath, ...relDir.split('/'))
        try {
          await fsp.rmdir(absDir)
          summary.dirsPrunedLocal++
        } catch (_) {
          /* 非空 / 已不存在 / 权限：正常路径，跳过 */
        }
      }
      // 远端：候选 = 本轮 delete-remote 成功的祖先目录 ∩ 按扫描快照判定「本轮删除后
      // 应为空」的目录（自底向上递归：全部直接文件子项本轮已删、全部目录子项亦可清）。
      // DELETE 前逐目录 PROPFIND Depth 1 复核确无子条目 —— 他机可能在删除后写入新内容，
      // 集合 DELETE 在多数服务器是递归删除，绝不对未复核的目录发起。复核失败（网络 /
      // 非 207 / 404）跳过该目录（404 = 已不存在，目标状态达成，仅不计清理数）。
      if (remoteDeletedRels.size > 0 && !shouldAbort()) {
        /** 一次遍历构建直接子项关系（避免 候选数 × 条目数 的重复扫描） */
        const dirChildren = new Map() // 父 rel（'' = 同步根）→ { files: [], dirs: [] }
        for (const [rel, info] of remoteScan.files) {
          const i = rel.lastIndexOf('/')
          const parent = i < 0 ? '' : rel.slice(0, i)
          let slot = dirChildren.get(parent)
          if (!slot) {
            slot = { files: [], dirs: [] }
            dirChildren.set(parent, slot)
          }
          ;(info.isDir ? slot.dirs : slot.files).push(rel)
        }
        const remoteCandidates = new Set<any>()
        for (const rel of remoteDeletedRels) {
          const segs = rel.split('/')
          for (let i = segs.length - 1; i >= 1; i--) remoteCandidates.add(segs.slice(0, i).join('/'))
        }
        /** 按快照判定目录在本轮删除后是否应为空（要求扫描时至少有一个子项 ——
         *  扫描时空的目录不是本轮删除造成的，不属于清理范围） */
        const prunableCache = new Map()
        const isPrunable = (d: any) => {
          if (prunableCache.has(d)) return prunableCache.get(d)
          prunableCache.set(d, false) // 递归防环兜底（树结构实际无环）
          const kids = dirChildren.get(d) || { files: [], dirs: [] }
          let ok = kids.files.length + kids.dirs.length > 0
          for (const f of kids.files) {
            if (!remoteDeletedRels.has(f)) {
              ok = false
              break
            }
          }
          if (ok) {
            for (const sub of kids.dirs) {
              if (!isPrunable(sub)) {
                ok = false
                break
              }
            }
          }
          prunableCache.set(d, ok)
          return ok
        }
        const remoteOrdered = Array.from(remoteCandidates)
          .filter((d) => isPrunable(d))
          .sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : 1))
        for (const relDir of remoteOrdered) {
          if (shouldAbort() || roundBreaker.open) break
          await maybeYield()
          const dirUrl = joinRemote(dir.remotePath, relDir)
          try {
            const r = await davRequest(cfg, 'PROPFIND', dirUrl, {
              isCollection: true,
              headers: { Depth: '1', 'Content-Type': 'application/xml' },
              body: PROBE_PROPFIND_BODY,
            })
            if (r.status === 404) continue // 已不存在：目标状态达成
            if (r.status !== 207 || !r.body) continue // 无法复核 → 不删（保守）
            const kids = parseMultistatus(r.body.toString('utf-8')).filter(
              (item: any) => relFromHref(cfg, dirUrl, item.href).replace(/\/+$/, '') !== ''
            )
            if (kids.length > 0) continue // 复核发现仍有内容（他机写入等）→ 不删
            const del = await davRequest(cfg, 'DELETE', dirUrl)
            if (del.status === 200 || del.status === 204 || del.status === 404) summary.dirsPrunedRemote++
          } catch (_) {
            /* 复核 / 删除失败：跳过该目录，下一轮有机会再清 */
          }
        }
      }
    }

    // 熔断汇总：除各文件自身的失败信息外，补一条整轮结论与剩余量。
    // 网络类标记恒真：熔断只在网络类连续失败时打开（计数口径与 networkFailure 一致）
    if (roundBreaker.open) {
      pushError(
        `服务器连续多次出错，本次同步已暂停，剩余文件会在下次同步时继续`,
        true
      )
    }

    // 崩溃注入（测试）：真实进程崩溃不会执行任何收尾 —— 这里同样直接抛出，
    // 不 flush / 不压缩 / 不清 WAL，遗留的未了结意图留给下一轮 recoverIntents。
    if (crashErr) {
      crashErr.phase = 'execute'
      crashErr.summary = summary
      crashErr.errors = summary.errors
      throw crashErr
    }

    // B 档并发安全提示的「已提醒」落盘（名额消耗，见步骤 3.5）：只在本轮干净收场
    //（无文件级错误且未取消 —— 恰为步骤 9 不抛错的补集，渲染层只对这种轮次弹警告
    // toast）时置位，随下方 persistPlannedLocalState 的 noiseDirty 通道一并保存；
    // 弹不到用户的轮次不消耗名额，下一轮继续携带，直到用户真正看到过一次。
    if (tierBNoticePending && !aborted && summary.errors.length === 0) {
      serverNoise.noise.concurrencyWarned = true
      noiseDirty = true
    }

    // 8. 轮末收尾：fsync → 压缩 → 保存元数据 → 清空已了结的 WAL（与让出路径
    //    共用 persistPlannedLocalState，见该函数注释）。快照损坏的轮次强制压缩：用本轮
    //    已验证的事实重建快照，下一轮恢复正常基线模式（否则 loadedOk 永远为 false，
    //    保护模式会不必要地持续到所有后续轮次）。
    await persistPlannedLocalState()
    // etag 跳过运行时异常收口（第二层防御的落点，见 noteEtagSkipAnomaly）：被跳过
    // 子树内出现与基线不一致的远端状态 → 提示用户，并把缓存 lastFullScanAt 归零
    //（0 = 立即过期），下一轮强制全量下降核对真实远端状态。这是「探测验证」之外
    // 的运行时防线 —— 探测是 7 天前的快照，服务器行为可能已变；异常把界内滞后
    // 收敛到一轮。放在错误抛出之前：带错轮次同样要收口（异常轮最需要下一轮核对）。
    if (etagSkipAnomaly) {
      logNote(`etag 跳过的子树内出现与基线不一致的远端状态（${etagSkipAnomaly}）：下一轮将强制全量扫描核对`)
      await store.saveScanCache({ ...newScanCache, lastFullScanAt: 0 }).catch(() => {})
    }
    // C 档跳过汇总（每轮一条，不随文件数刷屏；信息明确到动作计数）
    if (roSkipped > 0) pushWarning(`服务器只能下载，本次跳过了 ${roSkipped} 个上传/删除操作，电脑上的文件都还在`)
    // 持续失败退避汇总（每轮一条）：最多列 3 个示例（文件名 + 失败原因 + 下次重试时间），
    // 其余以「等」带过 —— 不随文件数刷屏，用户能看到是哪些文件、为什么被跳过、何时自动恢复
    if (permSkipped.length > 0) {
      const fmtRetry = (ms: any) => {
        const d = new Date(ms)
        const p = (n: any) => String(n).padStart(2, '0')
        return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
      }
      const examples = permSkipped
        .slice(0, 3)
        .map(({ rel, fr }) => `${rel}：${String(fr.message || fr.code || '').slice(0, 80)}（下次重试 ${fmtRetry(fr.retryAtMs)}）`)
        .join('；')
      pushWarning(`有 ${permSkipped.length} 个文件一直同步失败（${examples}${permSkipped.length > 3 ? ' 等' : ''}），已暂时跳过，稍后会自动重试`)
    }
    // 冲突挂起延续汇总（每轮一条）：本轮按上次的选择自动解决、未再次
    // 询问的冲突清单（最多列 3 个示例）—— 让用户感知决策被沿用；解决失败的仍留在
    // 挂起表里（choice 保留），下一轮继续沿用
    if (pendingResolved.length > 0) {
      const fmtChoice = (c: any) => (c === 'local' ? '保留电脑版本' : c === 'remote' ? '保留云端版本' : '两个都留')
      const pendExamples = pendingResolved.slice(0, 3).map(({ rel, choice }) => `${rel} → ${fmtChoice(choice)}`).join('；')
      pushWarning(`按你上次的选择自动处理了 ${pendingResolved.length} 个冲突（${pendExamples}${pendingResolved.length > 3 ? ' 等' : ''}），没有再询问你`)
    }
    // 删除安全汇总（每轮一条）：批量删除超阈值时闸内已推送详细 warning，这里补
    // 跨轮存量挂起与「保留 / 根重建保护」的可见性 —— 待处理面板逐条 / 批量确认
    if (summary.deleteHeld > 0 && !deleteThresholdTripped) {
      pushWarning(`有 ${summary.deleteHeld} 项删除在等你确认，确认前不会删除任何文件`)
    }
    if (summary.deleteRestored > 0) {
      pushWarning(`按你之前选的「不删除」，${summary.deleteRestored} 个文件已从电脑重新上传，云端已恢复`)
    }
    if (summary.deleteKept > 0) {
      pushWarning(`按你之前选的「不删除」，${summary.deleteKept} 个文件的云端副本保留了下来（电脑上已删除的文件不会恢复）`)
    }
    // 空目录清理汇总（有清理动作才提示）
    if (summary.dirsPrunedLocal > 0 || summary.dirsPrunedRemote > 0) {
      pushWarning(`清理了因同步而变空的文件夹：电脑 ${summary.dirsPrunedLocal} 个、云端 ${summary.dirsPrunedRemote} 个`)
    }

    // 9. 文件级失败 / 中止 → 以错误状态上报（已成功文件的基线保留，summary 附带）。
    //    抛错 / 正常返回前统一补齐 failureClass / openIntents / breaker。
    finalizeSummaryMeta()
    if (summary.errors.length || aborted) {
      const err: any = new Error(summary.errors[0] || (aborted ? '已取消同步' : '同步意外停止，请稍后重试'))
      err.phase = 'execute'
      err.summary = summary
      err.errors = summary.errors
      throw err
    }
    return summary
  }
  // ---- 租约锁释放（三条退出路径共用）----
  // 正常结束（上方 return）/ 轮次 error（扫描闸门、执行失败、CIRCUIT_OPEN 熔断终止）/
  // shouldAbort 取消（以「同步已中止」错误收场）全部经过此 finally。crashErr 置位
  //（测试崩溃注入）时跳过一切：模拟进程死亡不得执行任何收尾 —— 不清续租定时器、
  // 不 DELETE 锁（定时器由 services.cleanup 的全局清扫兜底；真实进程死亡由锁 TTL
  // 过期 + 下一轮开头的左锁清理兜底）。互斥 key 不在此处清：
  // 由外层 syncDirectory 的 finally 负责（同进程内注入不是真死，必须放行下一轮）。
  try {
    return await roundBody()
  } finally {
    if (!crashErr) {
      if (renewTimer) {
        nodeTimers.clearInterval(renewTimer)
        RENEW_TIMERS.delete(renewTimer)
        renewTimer = null
      }
      if (lockHeld) {
        lockHeld = false
        try {
          // DELETE 走无熔断 cfg（__wdsyncBreaker 置 null）+ 单次尝试：熔断触发只说明
          // 「连续失败达到阈值」，网络可能仍可用 —— 释放必须有一次独立于熔断的机会。
          // 同样豁免取消检查（__wdsyncAbort 置 null）—— 取消轮必须照常释放
          // 已持有的锁，否则取消会把他机挡在 TTL 之外。
          const r = await davRequest({ ...cfg, __wdsyncBreaker: null, __wdsyncAbort: null }, 'DELETE', lockPath, { noRetry: true })
          if (r.status >= 400 && r.status !== 404) throw new Error(`HTTP ${r.status}`)
        } catch (e: any) {
          // 404 = 目标状态已达成（无锁可删），其余失败记左锁标记：下一轮开头优先补删
          logNote(`租约锁释放失败（${(e && e.message) || e}）：将在下一轮开头重试清理`)
          store.meta.lockLeftover = { at: Date.now() }
          await store.saveMeta().catch(() => {})
        }
      }
    }
  }
}

/** 仅写日志的内部提示：内部机制类信息不进 summary.warnings / 不弹 toast（不打扰用户），排障时在控制台可见 */
function logNote(m: unknown): void {
  try {
    console.info('[webdav-sync]', typeof m === 'string' ? m : String(m))
  } catch (_) {
    /* 忽略 */
  }
}

/** 构造带阶段标记的同步失败错误（可附带 failureClass 供调度层退避判定） */
function syncFail(message: string, opts: any = {}): any {
  const err: any = new Error(message)
  if (opts.phase) err.phase = opts.phase
  if (opts.errors) err.errors = opts.errors
  if (opts.summary) err.summary = opts.summary
  if (opts.failureClass) err.failureClass = opts.failureClass
  return err
}

// ---------- 导出 ----------

const services = {
  platform: process.platform,
  /** 调度器门面（文件尾部挂载实例；渲染层经 services.scheduler 订阅与请求） */
  scheduler: null as SchedulerFacade | null,
  dav: {
    /**
     * 测试连接：PROPFIND depth 0。
     * 返回 { ok, latencyMs, error?, tier?, capabilities? } —— tier / capabilities 为
     * 新增字段（向后兼容）：能力探测失败不影响连通性结论（tier 为 null）。
     * @param cfg 连接配置
     * @param remotePath 能力摘要的探测目标远端路径（渲染层传入用户选定的功能测试
     *   目录）；缺省为服务器基址 —— 同一服务器不同子树写权限可能不同，摘要需与
     *   「功能测试」同口径。
     */
    async testConnection(cfg: any, remotePath?: any) {
      const started = Date.now()
      try {
        const r = await davRequest(cfg, 'PROPFIND', '', {
          headers: { Depth: '0', 'Content-Type': 'application/xml' },
          body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
        })
        const latencyMs = Date.now() - started
        if (r.status === 207 || r.status === 200) {
          // 附带档位与能力摘要：缓存优先（7 天 TTL），缺失才现场探测；探测异常不连坐。
          // 探测目标为调用方指定的远端路径（功能测试目录），缺省为基址
          let capabilities: any = null
          try {
            capabilities = await probeCapabilities(cfg, false, remotePath)
          } catch (_) {
            /* 探测失败不影响连接判定 */
          }
          return { ok: true, latencyMs, tier: capabilities ? capabilities.tier : null, capabilities }
        }
        if (r.status === 401) return { ok: false, error: '用户名或密码不正确（坚果云请使用「应用密码」）', latencyMs }
        return { ok: false, error: `服务器返回了错误（HTTP ${r.status}）`, latencyMs }
      } catch (e: any) {
        return { ok: false, error: e && e.message ? e.message : String(e) }
      }
    },
    /** 探测服务器能力与档位。force=true 忽略缓存强制重探；remotePath 按该远端根路径判定写权限 */
    probeCapabilities: (cfg: any, force?: any, remotePath?: any) => probeCapabilities(cfg, !!force, remotePath),
    /**
     * 读取未过期的能力缓存（不发起网络请求）；无缓存 / 存储异常返回 null。
     * 返回目标路径（缺省基址）的生效视图（含 tier）。UI 展示降级原因用 writeReason。
     */
    async getCachedCapabilities(cfg: any, remotePath?: any) {
      try {
        const st = await storage.openServerState(originOf(cfg), (cfg && cfg.username) || '')
        const cached = st.getCachedCapabilities(PROBE_TTL_MS)
        if (!cached) return null
        const pathKey = storage.normalizeRemoteKey(remotePath || '/')
        const entry = cached.writePaths && cached.writePaths[pathKey]
        const write = entry && typeof entry.writable === 'boolean' ? entry : undefined
        return effectiveCaps(cached, write)
      } catch (_) {
        return null
      }
    },
    list: (cfg: any, remotePath: any, ignoreHidden: any) => listRemote(cfg, remotePath, ignoreHidden !== false),
    listDirs: (cfg: any, remotePath: any) => listDirs(cfg, remotePath),
    mkdirDeep: (cfg: any, remotePath: any) => mkdirDeep(cfg, remotePath),
    remove: (cfg: any, remotePath: any) => davRequest(cfg, 'DELETE', remotePath),
    /**
     * 已知服务器档案匹配（UI 提示用，不发网络请求）：按 cfg.serverUrl 返回
     * { label, netOpts } 或 null。档案默认只在用户未显式配置 netOpts.ratePerSec
     * 时生效（resolveNetOpts 的分层口径）；UI 据此展示「检测到 XX，已默认限速」。
     */
    serverProfile: (cfg: any) => serverProfileFor(cfg && cfg.serverUrl),
  },
  fsx: {
    scanDir: (localPath: any, ignoreHidden: any) => scanDir(localPath, ignoreHidden !== false),
    watchDir,
    stopWatch,
    stopAllWatch,
    /**
     * 读取 watcher 脏路径集快照（语义见模块内同名函数头注释）。渲染层不使用
     *（调度器经 SchedulerEngine 消费）；暴露在 fsx 是 env.d.ts 随实现源自动更新、
     * e2e 直检 watcher 记录 / 清理行为的入口。
     */
    peekDirtyPaths,
    /** 消费清理 watcher 脏路径集（引擎在本地扫描成功后调用；同样仅供测试直检） */
    clearDirtyPaths,
    /** 选取本地目录，返回路径或 null */
    pickDirectory(title: any) {
      try {
        const picked = window.ztools.showOpenDialog({
          title: title || '选择要同步的文件夹',
          properties: ['openDirectory'],
        })
        return Array.isArray(picked) && picked.length > 0 ? picked[0] : null
      } catch (_) {
        return null
      }
    },
  },
  sync: {
    syncDirectory,
    /**
     * 列出某目录的挂起记录（UI「冲突统一处理 / 删除确认」入口）。
     * @param d 目录配置（格式同 syncDirectory 的 dir 参数）
     * @returns [{ rel, local:{size,mtimeMs}, remote:{size,mtimeMs,etag}, createdAt, choice?, kind? }]
     *          按 createdAt 升序；choice 存在 = 用户已选择但落地失败（下轮自动沿用），
     *          不存在 = 已询问但未解决（待统一处理）；kind='delete' 为批量删除确认类
     *          挂起（choice ∈ delete/keep），缺省为冲突类（choice ∈ local/remote/both）
     */
    async listPendingConflicts(d: any) {
      const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
      return st.listPending()
    },
    /**
     * 清除某目录单个文件的冲突挂起记录（UI「忽略此挂起」入口：清除后该文件再冲突时
     * 按常规流程重新询问 / 按 prefs 策略处理）。已立即落盘；同时向决策历史追加一条
     * kind='ignore' 记录（「最近处理记录」可回看为什么不再询问）。
     * @returns 是否确实移除了条目
     */
    async clearPendingConflict(d: any, rel: any) {
      const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
      const prev = st.getPending(rel)
      const removed = st.clearPending(rel)
      if (removed) {
        st.appendDecision({ at: Date.now(), rel: String(rel), kind: 'ignore', choice: 'ignore' })
        await st.saveDecisionLog().catch(() => {})
      }
      if (st.pendingsDirty) await st.savePendings().catch(() => {})
      return removed
    },
    /**
     * 为某目录某个文件的挂起记录补记 / 修改用户选择（UI「统一处理」入口，典型用于
     * 批量解决「已询问但未解决」的挂起）。已立即落盘；下一轮同步自动按该选择解决。
     * 冲突类挂起（缺省 kind）接受 'local' | 'remote' | 'both'；删除确认类挂起
     *（kind='delete'，批量删除超阈值登记）接受 'delete'（确认删除，下一轮执行）|
     * 'keep'（保留两侧不删，持续抑制该文件的删除传播直至状态变化）；根丢失决策类
     *（kind='root-lost'，rel='.'）接受 'upload'（重建云端并重新上传）|
     * 'remove-local'（移除本地已同步内容，跟随云端删除）。
     * @returns 是否成功（挂起记录不存在 → false，不新建 —— 只对已登记的条目生效）
     */
    async setPendingChoice(d: any, rel: any, choice: any) {
      const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
      const prev = st.getPending(rel)
      if (!prev) return false
      const isDeleteKind = prev.kind === 'delete'
      const isRootLostKind = prev.kind === 'root-lost'
      const valid = isDeleteKind
        ? choice === 'delete' || choice === 'keep'
        : isRootLostKind
          ? choice === 'upload' || choice === 'remove-local'
          : choice === 'local' || choice === 'remote' || choice === 'both'
      if (!valid) {
        throw new Error(
          `无效的挂起处理选择：${choice}（${
            isDeleteKind ? '删除确认仅支持 delete / keep' : isRootLostKind ? '根丢失决策仅支持 upload / remove-local' : '冲突仅支持 local / remote / both'
          }）`
        )
      }
      const ok = st.setPending(rel, { ...prev, kind: prev.kind, choice, createdAt: prev.createdAt })
      if (ok) {
        // 决策历史：root-lost 类目录级决策携带受影响基线文件数（弹窗同口径），
        // 供「最近处理记录」回看「当时选了什么、影响了多少文件」
        const entry: any = {
          at: Date.now(),
          rel: String(rel),
          kind: isRootLostKind ? 'root-lost' : isDeleteKind ? 'delete' : 'conflict',
          choice: String(choice),
        }
        if (isRootLostKind && prev.local && prev.local.size > 0) entry.affected = prev.local.size
        st.appendDecision(entry)
        await st.saveDecisionLog().catch(() => {})
      }
      if (st.pendingsDirty) await st.savePendings().catch(() => {})
      return ok
    },
    /**
     * 列出某目录的决策历史（UI「最近处理记录」入口）。
     * @param d 目录配置（格式同 syncDirectory 的 dir 参数）
     * @returns [{ at, rel, kind, choice, affected? }] 按时间倒序（最新在前）；
     *          kind ∈ 'conflict' | 'delete' | 'root-lost' | 'ignore'，choice 为用户的
     *          选择值（忽略类恒为 'ignore'），affected 仅 root-lost 类携带
     */
    async listDecisionLog(d: any) {
      const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
      return st.listDecisionLog()
    },
    /**
     * 列出某目录的同步记录（UI「同步记录」页数据源）。
     * @param d 目录配置（格式同 syncDirectory 的 dir 参数）
     * @returns [{ at, endAt, trigger, status, uploaded, ..., ops[], errors[] }]
     *          按时间倒序（最新在前）；每轮一条，含触发方式 / 起止时间 / 计数摘要 /
     *          逐文件操作明细 / 错误清单 —— 简略行与详尽视图共用同一份数据
     */
    async listSyncLog(d: any) {
      const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
      return st.listSyncLog()
    },
    /**
     * 读取某目录的批量删除快照（UI 待处理面板「删除确认目录树」的数据源）。
     * 返回 DeleteBatchView：快照本体 + 当前生效的范围决策（scopes）+ 引擎算好的
     * 未决策文件数（undecided，按树精确去重扣除 scope 覆盖部分）。
     * 无快照但存在未决策删除记录（旧版本登记 / 未到阈值的单文件挂起）时从记录
     * 合成单文件叶快照 —— 保证「有挂起必有决策入口」，不会出现记录在等待确认
     * 却没有任何 UI 通道可达的死角。
     * @param d 目录配置（格式同 syncDirectory 的 dir 参数）
     * @returns DeleteBatchView | null（无快照且无未决策删除记录）
     */
    async listDeleteBatch(d: any) {
      const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
      let batch = st.getDeleteBatch()
      if (!batch) {
        const items = st.listPending().filter((p: any) => p.kind === 'delete' && !p.choice)
        if (!items.length) return null
        batch = buildDeleteBatch(new Map(items.map((p: any) => [p.rel, p.local ? p.local.size : 0])), Date.now())
      }
      const scopes = st.listDeleteScopes()
      return { ...batch, scopes, undecided: computeUndecidedFiles(batch, scopes) }
    },
    /**
     * 落一条删除范围决策（UI 目录树节点 / 底部「全部」按钮的入口）：在 prefix
     * （nfc 归一；'' = 整个同步目录）范围内按 choice 消费全部删除候选 —— 含逐文件
     * 挂起表装不下的部分。已登记的逐文件删除记录同步回写 choice（两条消费路径
     * 语义一致、UI 列表不再重复展示）；决策历史追加一条 kind='delete' 记录
     *（affected 携带覆盖文件数，「最近处理记录」可回看影响面）。
     * 立即落盘；下一轮同步按 scope 自动执行 / 抑制。
     * @param d 目录配置（格式同 syncDirectory 的 dir 参数）
     * @param rel 范围前缀：'' = 整个同步目录；目录 rel = 该目录及其全部子树；
     *            文件 rel = 单文件。'.' / '/' 保留字（根丢失决策专用）不可用
     * @param choice 'delete'（确认删除，下一轮执行）| 'keep'（保留不删，持续抑制）
     * @returns {{ ok: true, covered: number, stamped: number }} covered = 决策覆盖的
     *          删除候选文件数（按当前快照口径；无快照时按未决策记录数），stamped =
     *          同步回写 choice 的既有逐文件记录数
     */
    async setDeleteScope(d: any, rel: any, choice: any) {
      const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
      if (choice !== 'delete' && choice !== 'keep') {
        throw new Error(`无效的删除范围选择：${choice}（仅支持 delete = 确认删除 / keep = 保留不删）`)
      }
      const raw = String(rel == null ? '' : rel)
      if (raw === '.' || raw === '/') {
        throw new Error('「.」是云端文件夹丢失决策的保留路径，整个同步目录请用空范围表示')
      }
      const prefix = nfc(raw)
      const batch = st.getDeleteBatch()
      // 代际 = 决策时的快照 at（无快照的扁平决策为 0）：盖章回写限定同代，跨代新
      // 批次的决策不翻案旧代已盖章的逐文件记录（「全部」只作用于当前树的未决策项）
      const gen = batch ? batch.at : 0
      // 覆盖数 = 本次决策真正新覆盖的未决策文件数（决策前后的引擎口径差，天然
      // 扣除已被其他 scope 覆盖的部分）；无快照时退回未决策记录数
      const scopesBefore = st.listDeleteScopes()
      const covered = batch
        ? computeUndecidedFiles(batch, scopesBefore) - computeUndecidedFiles(batch, [...scopesBefore, { prefix, choice, at: 0, gen }])
        : st.listPending().filter((p: any) => p.kind === 'delete' && !p.choice && scopeHitsRel(prefix, p.rel)).length
      st.setDeleteScope(prefix, choice, gen)
      const stamped = st.stampDeleteScopeChoices(prefix, choice, gen)
      st.appendDecision({ at: Date.now(), rel: prefix || '.', kind: 'delete', choice, affected: covered > 0 ? covered : undefined })
      await st.saveDecisionLog().catch(() => {})
      if (st.pendingsDirty) await st.savePendings().catch(() => {})
      return { ok: true, covered, stamped }
    },
    /**
     * 校验一份新的同步目录配置与既有目录是否嵌套 / 重叠（保存时调用）。
     * 本地侧与远端侧分别判定，任一侧嵌套（含完全相同）即报错 —— UI 据此阻止保存。
     * @returns {{ side: 'local'|'remote', withName: string, message: string } | null}
     */
    checkDirOverlap: (dir: any, existing: any, exceptId: any) => checkDirOverlap(dir, existing, exceptId),
    /**
     * 内部状态机直检入口：仅供测试与同步安全审计使用，渲染层勿依赖。
     */
    _internals: {
      decideAction,
      davRequest,
      /** 本模块实际使用的本地 fs（宿主内应为未打补丁的 original-fs；Node 测试环境回落 node:fs） */
      localFs: fs,
      scanDirSafe,
      listRemoteSafe,
      /** 批量删除快照聚合（纯函数直检：目录树构建 / 折叠 / 截断） */
      buildDeleteBatch,
      /** 快照未决策文件数计算（纯函数直检：scope 覆盖去重） */
      computeUndecidedFiles,
      /** 范围前缀命中判定（纯函数直检，与 matchDeleteScope 同规则） */
      scopeHitsRel,
      uploadOne,
      downloadOne,
      deleteLocalOne,
      fpMatch,
      cleanupOrphanTemps,
      isSyncTempName,
      /** watcher 事件过滤判定直检（纯函数） */
      ignoredWatchEvent,
      hashFile,
      remoteChangedVs,
      computeLocalChanged,
      verifyRemoteHash,
      localFpTolMs,
      nfc,
      normEtag,
      probeCapabilities,
      /** 服务器档案匹配（纯函数：SERVER_PROFILES 的 host 后缀判定） */
      serverProfileFor,
      /** 生效网络参数解析（纯函数：显式 netOpts > 档案默认 > NET_DEFAULTS） */
      resolveNetOpts,
      /** saxes 解析器直检：畸形 XML 抛错 / 前缀变体 / 流式块边界 */
      parseMultistatus,
      createMultistatusStream,
      createRoundBreaker,
      /** 读取某目录基线条目（测试断言用）；目录配置格式同 syncDirectory 的 dir 参数 */
      async baselineEntry(d: any, rel: any) {
        const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
        const e = st.get(rel)
        return e ? { ...e } : null
      },
      /** 当前基线条目总数（测试断言用） */
      async baselineSize(d: any) {
        const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
        return st.entries.size
      },
      /** 传输失败三分类：'permanent' | 'transient' | 'normal'（直检分类规则用） */
      classifyOpFailure,
      /** 网络类失败判定（summary.failureClass 的逐条口径，与熔断计数一致） */
      networkFailure,
      /** 内置垃圾规则判定（跨平台默认排除，与 ignoreHidden 无关；纯函数） */
      isJunkRel,
      /** 用户排除规则编译（glob → 匹配函数；纯函数，null = 无有效规则） */
      compileExcludePatterns,
      /** Windows 文件名/路径预检（纯函数：段级校验 + rel/win32 长度预算） */
      checkWinSegment,
      checkWindowsRel,
      /** 大小写冲突检测（纯函数：本地/远端 rel 集合 → 冲突组 + 跳过集合） */
      detectCaseCollisions,
      /** 同步目录重叠校验（纯函数，与公开入口同实现） */
      checkDirOverlap,
      /** 读取某目录的持续失败退避记录（测试断言用）：rel → { code, message, count, firstAt, lastAt, retryAtMs } 副本 */
      async getFailures(d: any) {
        const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
        const out: Record<string, any> = {}
        for (const [k, v] of st.failures) out[k] = { ...v }
        return out
      },
      /** 测试专用：把某目录全部失败记录的重试时间前拨 ms 毫秒（验证退避到期后的重试行为） */
      async ageFailures(d: any, ms: any) {
        const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
        st.ageFailures(ms)
      },
      /** 读取某目录的元数据副本（测试断言左锁标记 lockLeftover 等） */
      async getDirMeta(d: any) {
        const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
        return { ...st.meta }
      },
      /** 读取某目录的冲突挂起记录副本（测试断言用）：[{ rel, local, remote, createdAt, choice? }] */
      async getPendings(d: any) {
        const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
        return st.listPending()
      },
      /**
       * 测试专用：把某目录全部开放意图的写入时间整体前拨 ms 毫秒（30 天超龄
       * 兜底验证；at 与 firstAt 一并前拨；只改内存不落盘，
       * 与 ageFailures 同款语义）
       */
      async ageOpenIntents(d: any, ms: any) {
        const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
        st.ageOpenIntents(ms)
      },
      /** 前缀比对助手直检（测试 / 审计用；product 路径经 remoteIsLocalPrefix 间接使用） */
      filesPrefixEqual,
      remoteIsLocalPrefix,
      /**
       * 清扫崩溃轮按设计遗留的续租定时器（测试崩溃注入收尾），返回清除个数。
       * 仅测试 / 排障用：正常轮末由释放 finally 自清，生产路径不存在需要清扫的定时器。
       */
      crashResidueSweep,
      /**
       * 调度器工厂直检入口（测试传假时钟与 autoBootstrap:false 建测试实例）。
       * 渲染层勿依赖 —— env.d.ts 的公共类型不含 _internals。
       */
      createScheduler,
      /** 清扫全部 scheduler 定时器（测试模拟无卸载事件的进程死亡） */
      sweepSchedulerTimers,
    },
  },
  /** 本地状态存储：渲染层通常只读 deviceId；其余入口供测试与排障 */
  storage: {
    getDeviceId: () => storage.getDeviceId(),
    /** 测试多设备模拟专用：切换存储根（关闭全部已打开存储） */
    setRootForTest: (dir: any) => storage.setRootForTest(dir),
  },
  /**
   * 宿主端口注入点（无头 / 测试专用；渲染层不使用）：getHostPorts 取当前端口
   *（未覆盖时每次现造默认端口，动态读 window.ztools）、setHostPorts 覆盖或还原
   *（null = 默认端口，语义见 host.mts）。注意注入只影响本 services 实例所在的
   * 模块图 —— e2e built 轨里 bundle 与源码 store 是两个实例，跨实例注入互不可见。
   */
  host: {
    getHostPorts,
    setHostPorts,
  },
  /**
   * 凭据混淆（AES-256-GCM，同步接口）：渲染层 persist 前把密码 seal 进
   * dbStorage、init 时 open 回内存；调度器读 dbStorage 配置时同一对函数解密。
   * 防随手窥视而非强加密（密钥与密文同机同盘，见 store.js「凭据混淆」节）。
   * seal 失败（pluginData 不可写）时原样返回明文 —— 混淆是尽力而为，不阻断保存。
   */
  secure: {
    sealSecret: (plain: any) => storage.sealSecret(plain),
    openSecret: (sealed: any) => storage.openSecret(sealed),
  },
  /**
   * 实验功能「ZTools 插件同步」的自动发现结果（渲染层虚拟行的数据源；渲染层
   * 无 Node 能力，不能自行发现 ~/.ztools/plugins）。发现逻辑与调度器 loadConfig
   * 的目录合成共用 ztools-plugins.mts 同一实现 —— 两侧行为天然一致。
   * @param remoteBase 用户所选的云端父目录（prefs.ztoolsPluginSyncRemoteDir；
   *        缺省 = 云端根），决定远端根的父目录段
   */
  ztoolsPlugins: {
    describe: (remoteBase?: string): ZtoolsPluginsSyncDesc => describeZtoolsPluginsSync(remoteBase),
    /**
     * 插件注册表对账的最近状态（实验功能「无感同步」第二段的观测口）：渲染层
     * 虚拟行据此提示降级形态（未授权 / 旧宿主）。null = 本会话尚未对账过。
     * 状态在 preload 侧模块内维护，进程重启归零、下一轮 round-end 重建。
     */
    registryState: (): (RegistryReconcileResult & { at: number }) | null => getRegistryReconcileState(),
    /**
     * 手动触发一次注册表对账（渲染层 / 测试入口；调度器轮末对账走同一实现，
     * 模块内串行化）：把 manifest 合并进宿主注册表 / 重写导出。未授权时返回
     * denied 结果，不做任何写入。
     * @returns 对账结果（status / adopted / removed / wroteManifest / error）
     */
    reconcileRegistry: (): Promise<RegistryReconcileResult> => reconcilePluginRegistry(),
  },
  /**
   * 插件退出时清理监听与自建网络资源（keep-alive 连接池 / 限速器）。
   * 租约锁续租定时器在此全局清扫：正常轮末由释放 finally 自清，崩溃注入
   * 路径（crashErr）故意不清自己的定时器（模拟进程死亡不做收尾），退出时由此兜底。
   * 调度器实例的清理一并纳入（幂等；scheduler 自身还持 leader 锁 / 目录锁 /
   * watcher，均在其 cleanup 内让出或清扫）。
   */
  cleanup() {
    if (schedulerInstance) {
      try {
        schedulerInstance.cleanup()
      } catch (_) {
        /* 调度器清理失败不阻断引擎清理 */
      }
    }
    stopAllWatch()
    destroyNetPools()
    crashResidueSweep()
  },
}

/**
 * 渲染层公共门面类型（单一事实源）：
 * 以本文件实现为基准，裁掉测试直检后门（sync._internals）—— 渲染层类型
 * （env.d.ts 经 re-export 引用此处）永不暴露后门成员。
 */
type SyncFacadePublic = Omit<(typeof services)['sync'], '_internals'>
export type ServicesPublic = Omit<typeof services, 'sync'> & { sync: SyncFacadePublic }

// 挂载到渲染层全局（宿主 contextIsolation:false 下即 window.services）
window.services = services

/**
 * 挂载调度器门面并注册宿主生命周期钩子。
 * 挂载失败（理论不可达）不拖垮引擎 —— scheduler 为 null 时渲染层自动退回
 * 「无自动同步，手动直调引擎」的降级路径。
 */
let schedulerInstance: any = null
try {
  schedulerInstance = createScheduler({
    engine: {
      syncDirectory,
      watchDir,
      stopWatch,
      stopAllWatch,
      // watch 轮的脏路径提示源（id 与 watchDir 注册用的 watcherId 同一形态）；
      // 引擎侧在本地扫描成功后经 hints.watcherKey 反向调 clearDirtyPaths 消费
      peekDirtyPaths,
      listPendingConflicts: (...a: any[]) => services.sync.listPendingConflicts(...a as [any]),
    },
    getDeviceId: () => storage.getDeviceId(),
    storageRoot: () => storage.storageRoot(),
    autoBootstrap: true,
  })
  services.scheduler = schedulerInstance
  // 宿主钩子槽位（经宿主端口层取 lifecycle，见 host.mts —— 默认端口
  // 绑定 window.ztools 且两钩子齐才返回；null 时跳过注册，与原 zt 缺失分支一致）：
  // onPluginEnter / onPluginOut 是单回调槽位、重复注册会覆盖 —— preload 先于
  // 渲染层执行，先注册即拥有槽位；渲染层（App.vue）不再自行注册，只经 scheduler
  // 订阅接收 plugin-out / plugin-enter 事件。注册发生在挂载期（import 时一次性），
  // 端口化不改变该时序。
  // 宿主事实（已核实）：outPlugin(false) 会双发 PluginOut（幂等清理兜底）；
  // 主窗口渲染层刷新摘视图不发 PluginOut；分离窗口点 X 不发 PluginOut；close /
  // destroy / 崩溃不发任何卸载事件 —— 全部靠 TTL 接管兜底。
  try {
    const lc = getHostPorts().lifecycle
    if (lc) {
      lc.onPluginOut((isKill: any) => {
        try {
          if (schedulerInstance) schedulerInstance.handlePluginOut(!!isKill)
          if (isKill) services.cleanup() // kill 路径全量清理；隐藏路径不清（后台同步要继续）
        } catch (_) {
          /* 钩子异常不得外抛进宿主 */
        }
      })
      lc.onPluginEnter((action: any) => {
        try {
          if (schedulerInstance) schedulerInstance.handlePluginEnter(action)
        } catch (_) {
          /* 同上 */
        }
      })
    }
  } catch (_) {
    /* 宿主 API 异常：钩子注册失败不影响引擎与调度器本体 */
  }
} catch (e: any) {
  // 调度器不可用（引擎仍完整可用）：仅控制台留痕，绝不抛出阻断 services 挂载
  try {
    console.warn('[webdav-sync] scheduler unavailable:', e && e.message ? e.message : e)
  } catch (_) {
    /* 忽略 */
  }
}
