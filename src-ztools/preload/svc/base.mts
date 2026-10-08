/* eslint-disable */
// svc/base.mts —— 引擎共享内核：
//   * original-fs 解析（fs / fsp：全部本地文件 IO 的唯一入口，asar 规避见下方注释）；
//   * 跨域共享的类型形态（EngineCfg / DirCfg / EnginePrefs / SyncHandlers /
//     LocalStat / RemoteItem / ReqOpts / DavResponse / RoundBreaker）；
//   * 跨域共享的小工具与常量（nfc 别名、sleep、maybeYield 分片让出、logNote、
//     LIVE_TEMPS、REMOTE_FP_TOL_MS）。
// 本模块是依赖图叶子（仅依赖 node 内建、store.mts、types.mts）；各域单例状态
// （LIVE_TEMPS 等）由「全引擎唯一模块实例」承载 —— esbuild 单文件打包与 vitest
// 源码直载均为同一实例。
import nodeFs from 'node:fs'
import nodeTimers from 'node:timers'
import * as storage from '../store.mts'
import type { ConflictChoice, ConflictInfo, DavConfig, Prefs, SyncMode, SyncProgress } from '../types.mts'

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
export const fs: typeof nodeFs = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const original: any = require('original-fs')
    return original && typeof original.statSync === 'function' && original.promises ? original : nodeFs
  } catch (_) {
    return nodeFs
  }
})()

export const fsp = fs.promises

// ---------- 引擎领域类型（内部形态；公共形态见 types.mts） ----------

/** 引擎连接配置：DavConfig + 网络层注入通道（取消 / 熔断器 / 每轮流量袋 / 实时限速）。导出供调度器 SchedulerEngine 签名引用 */
export interface EngineCfg extends DavConfig {
  __wdsyncAbort?: (() => boolean) | null
  __wdsyncBreaker?: RoundBreaker | null
  /**
   * 每轮流量袋（调度器每轮挂载，网络层随字节流累加；调度器 1s 采样器据此折算
   * 「每目录实时速率」）。缺省（渲染层直调引擎的降级形态）只累计程总量。
   */
  __wdsyncTraffic?: { upBytes: number; downBytes: number } | null
  /**
   * 调度器轮次标记（cfgOf 挂载）：带宽限速改读网络层实时限额表（随配置应用
   * 推送，限速修改对在途传输即时生效）。缺省（渲染层直调 / 测试）维持请求侧
   * netOpts 快照的旧口径。
   */
  __wdsyncLiveLimits?: boolean
}

/** 本地文件指纹（扫描产物） */
export interface LocalStat {
  abs: string
  size: number
  mtimeMs: number
}

/** 远端条目指纹（multistatus 解析产物；isDir 条目由扫描层入表、规划层跳过传输决策） */
export interface RemoteItem {
  size: number
  mtime: number
  etag?: string
  isDir?: boolean
  origName?: string
}

/** 目录配置（syncDirectory 的 dir 参数形态）。导出供调度器 SchedulerEngine 签名引用 */
export interface DirCfg {
  id?: string
  localPath: string
  remotePath: string
  mode?: SyncMode
  [k: string]: unknown
}

/**
 * 引擎生效同步参数（渲染层 dirSyncPrefs 与调度器 prefsOf 的同一口径）。
 * 常规字段经 Pick 直接取自全局 Prefs（单一事实源 —— Prefs 侧改字段形态此处自动
 * 对齐，杜绝两份手抄漂移）；excludeRels 无全局形态、是目录级字段（勾选树
 * 「取消同步」的落地），保留在交叉类型的自有段。导出供调度器引用。
 */
export type EnginePrefs = Pick<
  Prefs,
  'ignoreHidden' | 'concurrency' | 'conflictStrategy' | 'verifyMaxBytes' | 'deepVerify' | 'deepVerifyDays' | 'adoptVerifyBudgetBytes' | 'leaseLock' | 'excludePatterns'
> & {
  /**
   * 勾选树「取消同步」的精确 rel 列表（渲染层选择性同步树的落地形态，
   * dir.overrides.excludeRels；目录级字段，无全局形态）。与 excludePatterns
   * 在扫描层合并生效（compileSyncExcludes：字面精确匹配 + 祖先目录命中即
   * 整棵子树排除）。
   */
  excludeRels?: string[]
}

/** syncDirectory 的回调句柄。导出供调度器 SchedulerEngine 签名引用 */
export interface SyncHandlers {
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
 *   dryRun 为 true = 预演轮（「预演一次」入口）：只扫描与规划、零副作用 ——
 *   不执行任何传输、不写基线 / WAL / 挂起 / 失败表 / scan-cache / meta（只读
 *   存储壳拦截全部写方法），云端与本地用户文件零改动；计划动作按既有安全闸
 *  （删除确认 / C 档 / 失败退避 / 大小写冲突等）过滤后计入 summary 与
 *   __syncOps（明细与真实轮同口径），以 trigger 'dry-run' 落同步记录。冲突按
 *   生效策略预判（'ask' 只计冲突不询问）；远端根不存在且基线为空（首次同步
 *   常态）时按「云端为空」合成远端清单（不 MKCOL），全部本地文件规划为上传。
 */
  hints?: { source: string; dirtyPaths?: string[]; watcherKey?: string; op?: 'pull' | 'push' | 'pull-full' | 'push-full'; dryRun?: boolean }
}

/** 网络请求可选项（singleRequest / davRequest 的 opts） */
export interface ReqOpts {
  headers?: Record<string, any>
  body?: string
  bodyFile?: string
  sinkFile?: string
  isCollection?: boolean
  /** 内容 hash 算法名（如 'sha256'；传输时旁路计算，结果在返回值 hashHex） */
  hashAlg?: string
  /**
   * 文件内容字节回调（可选；仅 bodyFile 上传与 sinkFile 下载两条流式管道生效）：
   * 每流经一块实际数据（限速之后、计数口径同 noteTraffic —— 用户看到的传输速率）
   * 以该块字节数调用一次。传输进度的「按真实大小推进」由此驱动：引擎把累加进
   * bytesDone 并刷新进度事件，大文件传输期间进度不再按整文件完成跳变。
   * 每次尝试（重试 / Digest / 重定向重发）都从 0 重新流经文件，回调会重复收到
   * 字节 —— 调用方（引擎侧 byteMeter）以「完成任务时只补尾差」消化重复计数。
   */
  onBytes?: (n: number) => void
  onReqStart?: (url: unknown) => void
  [k: string]: unknown
}

/** davRequest 的响应形态（HTTP 错误状态码正常 resolve；重试耗尽才 reject） */
export interface DavResponse {
  status: number
  headers: Record<string, any>
  /** Buffer（流式聚合）或 string（小响应） */
  body?: any
  etag?: string
  hashHex?: string
  classification?: { code: string; permanent: boolean; retryAfterMs?: number; retryAfterCapped?: boolean }
  redirectCount?: number
}

/** 本进程使用中的临时文件绝对路径集合：启动期清理必须跳过，防止误删并发同步正在写入的文件 */
export const LIVE_TEMPS = new Set<any>()
/** 远端指纹 mtime 容差（ms）：覆盖服务端存储 mtime 粒度损失（FAT 2s、PROPFIND 秒级精度） */
export const REMOTE_FP_TOL_MS = 2000

/**
 * 长阶段分片让出：批处理循环每 YIELD_EVERY 条目实际让出一次事件循环。
 * 动机：await 一个已就绪的 Promise 只排微任务，node:timers 的回调（调度器 5s 心跳 /
 * 1s tick，走 libuv 定时器阶段）得不到执行机会 —— 数万条目的紧凑规划 / 批量校验 /
 * 哈希队列循环会把心跳饿过 TTL（15s），触发误接管。setImmediate 走 libuv 检查阶段，
 * 真正交还事件循环；每次让出仅一次空转，对吞吐无可测影响（200 条目一让）。
 */
const YIELD_EVERY = 200
let yieldCounter = 0
export async function maybeYield(): Promise<void> {
  if (++yieldCounter >= YIELD_EVERY) {
    yieldCounter = 0
    await new Promise((resolve) => nodeTimers.setImmediate(resolve))
  }
}

/** rel 内部 key 统一 NFC（store.js 同名实现的本地引用，避免循环依赖） */
export const nfc = storage.nfc

export const sleep = (ms: number): Promise<void> => new Promise((r) => nodeTimers.setTimeout(r, ms))


/** 仅写日志的内部提示：内部机制类信息不进 summary.warnings / 不弹 toast（不打扰用户），排障时在控制台可见 */
export function logNote(m: unknown): void {
  try {
    console.info('[webdav-sync]', typeof m === 'string' ? m : String(m))
  } catch (_) {
    /* 忽略 */
  }
}

/**
 * 整轮熔断器实例形态（net.mts createRoundBreaker 的返回形状）。结构化接口而非
 * ReturnType 反查：EngineCfg 在本模块声明、createRoundBreaker 在 net.mts，反向
 * 类型依赖会与「base 是依赖图叶子」冲突；net 侧显式以本接口为返回类型锁定契约。
 */
export interface RoundBreaker {
  noteSuccess(): void
  noteFailure(msg: unknown): void
  error(): Error & Record<string, unknown>
  readonly open: boolean
  readonly reason: string
  readonly consecutive: number
}

