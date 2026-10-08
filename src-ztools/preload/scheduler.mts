/* eslint-disable */
// WebDAV 同步插件 —— 自动同步调度器
//
// 职责：把定时轮询（interval）、启动同步（startup）、fs.watch 触发（watch）、
// 手动同步（manual）从渲染层迁到 preload 侧统一调度 —— 渲染层 JS 停摆 / 被宿主
// 隐藏节流时同步照常（node:timers 走 libuv 免疫节流）。
// 引擎（services.js 的 syncDirectory）经参数注入，本模块不 require services.js，
// 无 Vue / DOM 依赖；仅依赖 node:timers / node:fs 与 store.js 的 storageRoot /
// hash16 / CRC 行编解码助手。esbuild 随 services.js 一并打进单文件产物。
//
// 多实例模型（实测结论）：
//   - 「主窗口视图 + 独立窗口」是两个渲染进程，preload 各执行一次 → 两个**活**实例
//     并存，共享 pluginData 下的 scheduler 文件；globalThis 单例不跨实例，跨实例
//     协调必须走文件（leader 锁 / manual-requests / 目录锁）。
//   - 「幽灵定时器」不存在（reload 拆除整个 Node 环境；close/destroy/crash 进程
//     直接死且**不发任何卸载事件**）——因此 cleanup()/onPluginOut 只是尽力而为，
//     设计上假设它们不被调用：一切残留靠 TTL + 新实例接管兜底。
//
// 文件布局（<storageRoot>/scheduler/，storageRoot = pluginData/sync-state）：
//   leader.lock            leader 锁：{v:1, instanceId, deviceId, at}
//   manual-requests.jsonl  手动同步委托（CRC32-JSONL）：req / claim / receipt 三元组
//   locks/<h>.lock         每目录互斥锁：{v:1, instanceId, at, ttlMs}
//     h = hash16(['dirlock', deviceId, 规范化 localPath, 规范化 remotePath, origin])
//
// 关键语义：
//   - 配置权威只有 dbStorage（key webdav-sync:data）；渲染层保存后调 reload() 通知
//     重读，不做渲染层推送配置。
//   - leader 是唯一自动调度者（interval/startup/watch 只有 leader 执行与注册 watcher）；
//     非 leader 的手动 syncNow 走委托（manual-requests）→ 超时核验后兜底本地跑。
//   - leader 自己的同步与兜底代跑持同一把目录锁 —— 两实例同时手动同步同一目录时
//     串行化，基线 JSONL 不会被并发写坏、同步不会重复。
//   - 冲突：kind='manual' 且本机渲染层订阅在线 → 转发渲染层弹窗等待选择；
//     其余（interval/watch/startup/委托代跑/兜底代跑）一律返回 'defer' 挂起。
import fs from 'node:fs'
import path from 'node:path'
import nodeTimers from 'node:timers'
import * as store from './store.mts'
import { getHostPorts } from './host.mts'
import { ZTOOLS_PLUGINS_DIR_ID, describeZtoolsPluginsSync } from './ztools-plugins.mts'
import { resolveDirPrefs } from './types.mts'
import { reconcilePluginRegistry } from './ztools-registry.mts'
import { applyNetLimits, netTraffic } from './svc/net.mts'
import type { ConflictChoice, ConflictInfo, Prefs, RoundDisplay, SchedulerApi, SchedulerEvent, SchedulerSnapshot, SchedulerSlotView, SyncProgress, SyncSummary } from './types.mts'
// 仅类型导入（编译期擦除，不构成对 services 的运行时依赖 / 循环 require）：
// SchedulerEngine.syncDirectory 的签名与引擎侧 syncDirectory 完全同形
import type { DirCfg, EngineCfg, EnginePrefs, SyncHandlers } from './services.mts'

const fsp = fs.promises

/** 同进程自举守卫（globalThis 槽位：宿主对同一 filePath 的 preload 执行层去重的 belt & braces） */
declare global {
  // eslint-disable-next-line no-var
  var __wdsyncSchedulerOwner: string | undefined
}

// ---------- 调度器类型 ----------

/** 规范化后的目录配置（loadConfig 产物；渲染层 SyncDir 的调度侧子集 + serverId/serverUrl 覆盖） */
export interface SchedulerDirCfg {
  id: string
  localPath: string
  remotePath: string
  mode: 'two-way' | 'upload' | 'download'
  enabled: boolean
  overrides: Record<string, unknown> | null
  /** 目录使用的服务器（servers[] 成员的 id；null = 跟随第一台 —— 旧配置迁移前的缺省） */
  serverId: string | null
  /**
   * 目录级服务器地址覆盖（历史遗留的裸地址覆盖；优先于 serverId 指向的服务器
   * 地址 —— 引擎按 origin+账号分池凭据，地址不同即不同池，互不串扰）。现有 UI
   * 不写该字段（多服务器形态走 serverId），保留为手改配置与既有写入测试的兼容路径
   */
  serverUrl: string | null
}

/**
 * 规范化后的服务器条目（loadConfig 产物；渲染层 servers[] 的调度侧视图）。
 * 密码已解密回内存（openSecret）；netOpts / tls 原样透传给引擎
 */
export interface SchedulerServerCfg {
  id: string
  serverUrl?: string
  username?: string
  password?: string
  netOpts?: Record<string, unknown>
  tls?: Record<string, unknown>
  [k: string]: unknown
}

/** 规范化后的调度配置（dbStorage 单文档的调度侧视图） */
export interface SchedulerConfig {
  /** 服务器列表（多账号 / 多服务器；旧单 server 配置迁移为唯一成员，id 固定 'srv-default'） */
  servers: SchedulerServerCfg[]
  dirs: SchedulerDirCfg[]
  prefs: Partial<Prefs>
}

/** 引擎注入（services 挂载时提供；本模块不反向依赖 services） */
export interface SchedulerEngine {
  /** 执行一轮同步（cfg / dir / prefs / handlers 与 syncDirectory 同形，类型即引擎侧导出） */
  syncDirectory(cfg: EngineCfg, dir: DirCfg, prefs: EnginePrefs, handlers: SyncHandlers): Promise<SyncSummary>
  /** 注册目录监听（watcherId 由调度器命名） */
  watchDir(watcherId: string, localPath: string, onChange: () => void): boolean
  /** 停止监听 */
  stopWatch(watcherId: string): void
  /** 停止全部监听（cleanup 用） */
  stopAllWatch(): void
  /**
   * 读取 watcher 的脏路径集快照（可选；id 为 watchDir 注册用的同一 watcherId，
   * 返回 NFC、'/' 分隔的 rel 数组，无记录时 null）。仅 watch 轮调用：快照经
   * handlers.hints 交给引擎做本地脏路径快速核对，interval / startup / manual /
   * follow-up 轮是周期性全量对账的组成部分，不带该提示。
   */
  peekDirtyPaths?(watcherId: string): string[] | null
  /** 读取挂起冲突（轮末事件外发用；可选；条目为 store 的 PendingListItem） */
  listPendingConflicts?(dir: any): Promise<any[]>
}

/** 调度器门面：公共 SchedulerApi + 实例观测与宿主钩子（渲染层只用公共面） */
export type SchedulerFacade = SchedulerApi & {
  /** 实例 id（leader 锁令牌；测试观测用） */
  instanceId: string
  /** 宿主 PluginOut（preload 侧钩子转发；双发 PluginOut 靠幂等） */
  handlePluginOut(isKill?: boolean): void
  /** 宿主 PluginEnter：仅恢复因用户开关挂起的调度（api 挂起不自动恢复） */
  handlePluginEnter(action?: { code?: string }): void
  /** 统一清理（幂等；unload / kill 尽力而为路径） */
  cleanup(): void
}

/** createScheduler 的选项 */
export interface SchedulerOpts {
  engine: SchedulerEngine
  getDeviceId: () => Promise<string>
  storageRoot: () => string
  /** 时钟注入（缺省 Date.now；测试传假时钟） */
  now?: () => number
  /** 计时器注入（缺省 node:timers；测试传假 timer 队列） */
  timers?: InjectedTimers
  /** true = 创建后自举（生产挂载路径）；false = 仅 init()/reload() 读配置（测试实例） */
  autoBootstrap?: boolean
}

/** 计时器句柄（注入形态与 node:timers 原生 Timeout 的联合；unref 尽力而为） */
export type TimerHandle = { unref?(): void } | NodeJS.Timeout | number | undefined
/**
 * 注入式计时器（node:timers 的最小子集；测试假 timer 队列同形）。
 * 成员用「属性 : 函数类型」而非方法简写 —— 单测与 e2e 的计时器静态检查按
 * 「行首裸计时器名 + 左括号」识别调用点，方法简写会被误判为裸调用。
 */
export interface InjectedTimers {
  setTimeout: (fn: (...args: unknown[]) => void, ms: number) => TimerHandle
  clearTimeout: (handle: TimerHandle) => void
  setInterval: (fn: (...args: unknown[]) => void, ms: number) => TimerHandle
  clearInterval: (handle: TimerHandle) => void
}

/** 定时器条目：{ dispose() }（实例与模块两级登记表共用形状） */
export interface TimerEntry {
  dispose(): void
}

/**
 * 自动调度来源的封闭集合（单一事实源）：interval 定时轮、startup 新目录首轮、
 * watch 监听触发轮、follow-up 开放意图补跟轮、yield-retry 让出重排轮、backoff
 * 退避轮。startRound 的 leader 轮首复核与 executeRound 的自动 / 手动分流（锁等待
 * 上限）共用，DirSlot.nextDueKind 的类型联合亦由本数组派生 —— 新增自动来源时
 * 三处手抄收敛为改这一处。
 */
const AUTO_KINDS = ['interval', 'startup', 'watch', 'follow-up', 'yield-retry', 'backoff'] as const

/** DirSlot 状态机（调度侧每目录的全部运行时状态） */
export interface DirSlot {
  id: string
  dir: SchedulerDirCfg
  state: 'idle' | 'scheduled' | 'queued' | 'running'
  nextDueAt: number | null
  nextDueKind: typeof AUTO_KINDS[number] | null
  rerunPending: boolean
  cancelRequested: boolean
  lastRound: { endedAt: number; summary: SyncSummary | null; error: string | null } | null
  progress: SyncProgress | null
  roundSeq: number
  _lastEmitAt: number
  backoffFails: number
  backoffUntil: number
  followCount: number
  followNoProgress: number
  followLastOpen: number
  yieldStreak: number
  watchHeld: boolean
  lastNotifyFp: string | null
  /** 新目录首轮待发射（reload 新增目录 → leader 态 tick 发射 'startup' 轮） */
  startupPending: boolean
  /**
   * 本轮流量袋（executeRound / fallbackRun 挂到 cfg.__wdsyncTraffic 的同一对象引用，
   * 网络层随字节流累加）：1s 采样器据此折算「每目录实时速率」；轮末 settleRound 清空。
   */
  traffic: { upBytes: number; downBytes: number } | null
}

/** 队列元素（全局 FIFO；manual/watch 直插队首受公平上限约束） */
interface QueueJob {
  slot: DirSlot
  kind: string
  resolve?: (r: RoundResolveValue) => void
  enqueuedAt: number
  /**
   * 一次性单向操作（'pull' / 'push' 补齐档 / 'pull-full' / 'push-full' 覆盖档；
   * 仅 op 手动轮携带）：随 job 传入轮体，经引擎 hints.op 生效。目录忙时发生
   * rerun 重排的轮不携带 op —— 因此 op 轮在入口处对忙目录明确拒绝（见 syncNow），
   * 绝不退化为常规轮传播删除。
   */
  op?: 'pull' | 'push' | 'pull-full' | 'push-full' | null
  /** 预演轮（syncNow opts.dryRun）：随 job 传入轮体，经引擎 hints.dryRun 生效的零副作用轮 */
  dryRun?: boolean
}

/** 在飞轮登记（全局并发控制的 origin 分组） */
interface RunningJob {
  slot: DirSlot
  kind: string
  origin: string
}

/** 轮末等待者（手动入口等待轮完成 / rerun 轮完成） */
interface RoundWaiter {
  dirId: string
  afterSeq: number
  resolve: (r: RoundResolveValue) => void
}

/** 入队 resolve / 轮末等待者的应答值（各入口形态的宽松并集） */
export type RoundResolveValue = {
  ok?: boolean
  error?: string | Error | null
  summary?: SyncSummary | null
  skipped?: boolean
  concurrent?: boolean
}

/** 轮末结果（executeRound / startRound 内部传递）；error 为引擎富错误（可带 summary / code） */
interface RoundOutcome {
  summary?: SyncSummary | null
  error?: any
  cancelled?: boolean
  skipped?: boolean
  concurrent?: boolean
  /** 预演轮（syncNow opts.dryRun）：结果不做任何排程影响、不发 round-end */
  dryRun?: boolean
}

/** manual-requests.jsonl 的行（req / claim / receipt 三元组的单行形态） */
interface ManualOp {
  kind: 'req' | 'claim' | 'receipt' | string
  id?: string
  by?: string
  from?: string
  dirId?: string
  dir?: SchedulerDirCfg
  at?: number
  ok?: boolean
  error?: string
  [k: string]: unknown
}

/** 三元组折叠表的一行 */
interface ManualTriple {
  req?: ManualOp
  claim?: ManualOp
  receipt?: ManualOp
}

// ---------- 常量（导出供测试断言引用） ----------

/** 调度 tick 周期：按时间戳扫描到期目录（unref；睡眠唤醒后第一拍自然补跑） */
const TICK_MS = 1000
/** leader 心跳周期 */
const HEARTBEAT_MS = 5000
/** leader 锁 TTL：mtime 与内容 at 双信号，本机时钟判定停更 */
const LEADER_TTL_MS = 15000
/** 单次心跳写超过该时长计诊断并经 scheduler-error 上报（不静默） */
const SLOW_HEARTBEAT_WARN_MS = 2000
/** 目录互斥锁 TTL（双信号停更 ≥ TTL 才允许 temp+rename 接管） */
const DIR_LOCK_TTL_MS = 60000
/** 目录锁持锁期间的续期间隔（明显小于 TTL） */
const DIR_LOCK_RENEW_MS = 20000
/** 目录锁等待轮询间隔 */
const DIR_LOCK_POLL_MS = 250
/** 手动委托等待 leader 领取的超时（未见 claim 才核验并兜底） */
const MANUAL_CLAIM_TIMEOUT_MS = 15000
/** 委托方轮询 receipt 的间隔 */
const MANUAL_POLL_MS = 500
/** leader 顺带压缩 manual-requests 三元组的时龄门槛 */
const MANUAL_COMPACT_AGE_MS = 10 * 60 * 1000
/** 同目录重入（queued/running 期间再触发）轮末的重排延迟 */
const RERUN_DELAY_MS = 2000
/** 全局并发上限（跨 origin；prefs.schedulerMaxConcurrent 可覆盖，钳位 1–4） */
const MAX_CONCURRENT_ROUNDS = 3
/** 公平上限 —— 队列中等待超过该时长的轮视为「被饿死」，manual/watch 插队不得排到它前面 */
const FAIRNESS_STARVE_MS = 30000
/** 跨轮退避起效的连续网络类失败轮数（failureClass network/mixed；熔断轮同样计入） */
const BACKOFF_THRESHOLD = 2
/** 退避时长上限的固定项（与 4×interval 取大者） */
const BACKOFF_CAP_MS = 30 * 60 * 1000
/** 开放意图 follow-up 的抖动区间与无进展回落阈值 */
const FOLLOWUP_MIN_MS = 30000
const FOLLOWUP_MAX_MS = 60000
const FOLLOWUP_NO_PROGRESS_MAX = 5
/** 让出重排（yield-retry）抖动区间与连续让出收敛阈值 */
const YIELD_RETRY_MIN_MS = 15000
const YIELD_RETRY_MAX_MS = 45000
const YIELD_CONSECUTIVE_MAX = 5
/** 时钟跳变判定（tick 间隔 > TICK_MS×该倍数 = 睡眠唤醒级跳变）与跳变后处理参数 */
const CLOCK_JUMP_FACTOR = 5
const JUMP_CATCHUP_MIN_MS = 5000
const JUMP_CATCHUP_MAX_MS = 10000
const JUMP_GRACE_MS = 60000
/** 全局暂停恢复后的补跑抖动（有资格的空闲目录在该区间内到期，吸收暂停期间积压） */
const RESUME_CATCHUP_MIN_MS = 2000
const RESUME_CATCHUP_MAX_MS = 6000
/** lost 后重选延迟基数（±30% 抖动） */
const LOST_REELECT_BASE_MS = 30000
/** 竞争失败后的选举重试基数 */
const ELECTION_RETRY_MS = 5000
/** 自举：dbStorage 不可用时的重试间隔与次数（50ms×20） */
const BOOTSTRAP_RETRY_MS = 50
const BOOTSTRAP_MAX_RETRIES = 20
/** 配置在 dbStorage 的 key（与渲染层 persist 同一份数据） */
const CONFIG_KEY = 'webdav-sync:data'
/** slot 进度事件节流下限（≤4Hz） */
const PROGRESS_MIN_INTERVAL_MS = 250
/** 自动轮等待目录锁的上限（超时改为 +2s 重排，不阻塞全局队列）；手动 / 委托轮更长 */
const DIR_LOCK_AUTO_MAX_WAIT_MS = 5000
const DIR_LOCK_MANUAL_MAX_WAIT_MS = 92000
/**
 * 手动轮冲突转发等待渲染层应答的 TTL（分钟级）：轮开始时渲染层在线、转发后渲染层
 * 消失（渲染进程崩溃 / 关闭 —— 多实例模型下发不出卸载事件，cleanup 设计上不被
 * 调用，见文件头）时无人应答，引擎 onConflict 的 await 将永久挂起，手动轮与目录
 * 锁悬挂到进程退出。分钟级给足「用户看着弹窗犹豫」的常态时长，超时按「渲染层未
 * 回应」以 'defer' 结算（见 forwardConflict）。
 */
const CONFLICT_FORWARD_TTL_MS = 5 * 60 * 1000

/**
 * 模块级活动定时器登记表：元素为 { dispose() }（由各实例的 timer kit 注册）。
 * sweepSchedulerTimers() 一次性全部清除 —— 测试模拟「无卸载事件的进程死亡」
 *（close/destroy/crash：真实死亡定时器随进程消失，同进程内模拟则靠本函数）；
 * services.cleanup() 的兜底清扫同走此通道。
 */
const LIVE_TIMERS = new Set<TimerEntry>()

/**
 * 清扫全部 scheduler 定时器（跨实例）：模拟进程死亡 / 插件退出的兜底清扫。
 * @returns {number} 清除的定时器个数
 */
function sweepSchedulerTimers(): number {
  const n = LIVE_TIMERS.size
  for (const entry of Array.from(LIVE_TIMERS)) entry.dispose()
  return n
}

/** 生成短随机 id（instanceId / 请求 id 等非密码学场景；避免额外依赖） */
function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 均匀抖动：base ± pct%（选举重试 / lost 重选，避免多实例同步撞车） */
function jitter(baseMs: number, pct = 0.3): number {
  return Math.max(1, Math.round(baseMs * (1 - pct + 2 * pct * Math.random())))
}

/** 区间均匀抖动（follow-up / yield-retry / 跳变补跑的多目录错峰） */
function jitterRange(minMs: number, maxMs: number): number {
  return Math.max(1, Math.round(minMs + Math.random() * Math.max(0, maxMs - minMs)))
}

/**
 * 折叠完全相同的消息（轮末展示用，纯函数）：按首次出现顺序保留，重复的消息
 * 合并为一条「msg（重复 N 次）」——同文噪声不再逐条刷屏。
 * 只折叠展示，不改 summary.errors 原始数据（既有断言依赖原样）。
 */
function foldRepeated(messages: string[] | null | undefined): string[] {
  const counts = new Map<any, any>()
  const order: any[] = []
  for (const m of messages || []) {
    const k = String(m)
    if (!counts.has(k)) {
      counts.set(k, 1)
      order.push(k)
    } else {
      counts.set(k, counts.get(k) + 1)
    }
  }
  return order.map((k) => (counts.get(k) > 1 ? `${k}（重复 ${counts.get(k)} 次）` : k))
}

/**
 * 轮末展示摘要（渲染层复用，纯函数；测试直检）：
 * tone = 'cancelled' | 'breaker' | 'error' | 'partial' | 'ok'。
 * 熔断轮（summary.breaker.open）→ 「服务器连续无响应」+ 最后失败摘要（breaker.reason）；
 * deferredConflicts>0 / deleteHeld>0 且无错误 → 'partial'（部分完成：待处理冲突 /
 * 待确认删除，二者可并存时合并为一句）。
 */
function summarizeRound(summary: SyncSummary | null | undefined, error: Error | string | null | undefined, cancelled: boolean): RoundDisplay {
  const sum = summary || null
  const br = sum && sum.breaker && sum.breaker.open ? sum.breaker : null
  const errors = foldRepeated((sum && sum.errors) || [])
  const deferred = sum ? Number(sum.deferredConflicts) || 0 : 0
  const deleteHeld = sum ? Number(sum.deleteHeld) || 0 : 0
  if (cancelled) return { tone: 'cancelled', title: '已取消同步', errors: [] }
  // 熔断轮：一句人话归因，最后失败原因（技术细节）放 detail
  if (br) return { tone: 'breaker', title: '服务器一直没有响应，本次同步已暂停，稍后自动重试', detail: String(br.reason || ''), consecutive: br.consecutive, errors }
  if (error) return { tone: 'error', title: errors[0] || String(error), errors }
  if (deferred > 0 || deleteHeld > 0) {
    const parts: any[] = []
    if (deferred > 0) parts.push(`${deferred} 个文件等你选择`)
    if (deleteHeld > 0) parts.push(`${deleteHeld} 项删除等你确认`)
    return { tone: 'partial', title: `部分完成：${parts.join('、')}`, errors }
  }
  if (errors.length) return { tone: 'error', title: errors[0], errors }
  return { tone: 'ok', title: '同步完成', errors: [] }
}

/** stat 一个路径，不存在 / 不可访问返回 null（调用方把 null 当「无法确认」） */
async function statOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fsp.stat(p)
  } catch (_) {
    return null
  }
}

/**
 * 创建调度器实例。
 *
 * @param {object} opts
 *   engine        引擎注入（services.js 挂载时提供）：
 *                   syncDirectory(cfg, dir, prefs, handlers)  执行一轮同步
 *                   watchDir(watcherId, localPath, onChange)   注册目录监听
 *                   stopWatch(watcherId)                       停止监听
 *                   peekDirtyPaths?(watcherId)                 读取脏路径集快照（watch 轮 hints）
 *                   listPendingConflicts?(dir)                 读取挂起冲突（事件外发）
 *   getDeviceId   async () => deviceId（store.js；leader 锁内容与目录锁键使用）
 *   storageRoot   () => 存储根（store.js；scheduler 文件全部落在其 scheduler/ 子目录）
 *   now           时钟注入（缺省 Date.now；测试传假时钟）
 *   timers        计时器注入（缺省 node:timers；测试传假 timer 队列）
 *   autoBootstrap true = 创建后自举（生产挂载路径：不等渲染层 init）；
 *                 false = 仅在 init()/reload() 时读配置（测试实例）
 * @returns 调度器门面（init/subscribe/getSnapshot/syncNow/cancel/suspend/resume/
 *          reload/resolveConflict/cleanup/handlePluginOut/handlePluginEnter）
 */
function createScheduler(opts: SchedulerOpts): SchedulerFacade {
  const engine = opts.engine
  const now = opts.now || Date.now
  const rawTimers = opts.timers || nodeTimers
  const storageRoot = opts.storageRoot || store.storageRoot
  const getDeviceId = opts.getDeviceId || store.getDeviceId
  const instanceId = randomId()
  const ownerGuard = opts.autoBootstrap === true

  if (!engine || typeof engine.syncDirectory !== 'function') {
    throw new Error('createScheduler: engine.syncDirectory 未注入')
  }

  // ---------- 实例状态 ----------

  let destroyed = false
  let suspended = false
  let suspendReason: 'pref' | 'api' | null = null // 'pref'（隐藏时按用户开关挂起，plugin-enter 恢复）| 'api'
  let ready = false
  let everLoaded = false
  let notReadyReason: string | null = '配置尚未加载'
  let config: SchedulerConfig | null = null // { server, dirs, prefs }（规范化后）
  let configV = '' // 配置内容哈希（reload 自检）
  /** dirId → slot（DirSlot 状态机） */
  const slots = new Map<string, DirSlot>()
  /**
   * 全局 FIFO 队列：元素 { slot, kind, resolve?, enqueuedAt }；manual/watch 直插队首
   * （公平上限：已等待 ≥ FAIRNESS_STARVE_MS 的队首元素不被插队越过 —— interval
   * 任务不因连续手动 / watch 触发而饿死）
   */
  const queue: QueueJob[] = []
  /**
   * 在飞轮登记（全局并发）：元素 { slot, kind, origin }。并发规则 = 全局上限
   * maxConcurrentRounds（默认 3，prefs.schedulerMaxConcurrent 可覆盖）× 每 origin 并发 1
   * （同一 WebDAV 服务器的轮串行，服务器友好；不同 origin 可并行）。
   */
  const runningJobs: RunningJob[] = []
  /** 上一拍 tick 的时刻（时钟跳变检测：gap > TICK_MS×CLOCK_JUMP_FACTOR 视为睡眠唤醒） */
  let lastTickAt = 0
  /** 最近一次检测到的时钟跳变时刻（跳变后 JUMP_GRACE_MS 内网络类失败不计入退避） */
  let lastJumpAt = 0
  /** 选举状态：standby | candidate | leader | lost */
  let leaderState: 'standby' | 'candidate' | 'leader' | 'lost' = 'standby'
  /**
   * 在飞轮的中止信号：心跳回读失配（lost）或 cleanup 置 false → shouldAbort 令轮
   * 在文件边界以取消语义中止（引擎零改动，基线与 WAL 一致、锁照常释放）。
   * 注意 suspend **不动**本引用：挂起不是取消，在飞轮自然跑完收场。
   */
  const ownerRef = { valid: false }
  /** 渲染层订阅在线（init() 握手后置 true；冲突转发的前提） */
  let rendererOnline = false
  /** 事件订阅者；dispatch 异常互不传染 */
  const listeners = new Set<(ev: SchedulerEvent) => void>()
  /** 转发冲突的等待表：conflictId → (choice) => void（渲染层经 resolveConflict 应答） */
  const conflictResolvers = new Map<string, (choice: ConflictChoice) => void>()
  /** 轮末等待者：{ dirId, afterSeq, resolve }（手动入口等待轮完成 / rerun 轮完成） */
  const roundWaiters: RoundWaiter[] = []
  /** 已注册的 watcher：dirId → { watcherId, localPath }（仅 leader 注册） */
  const watcherRegs = new Map<string, { watcherId: string; localPath: string }>()
  /** 持有的目录锁：h → { renew }（renew 为 timer entry；释放时清除） */
  const heldDirLocks = new Map<string, { renew: TimerEntry }>()
  /** 目录锁键缓存：dirId → h（deviceId / origin 参与键，配置不变则不变） */
  const dirLockHashCache = new Map<string, string>()
  /** 全局暂停到期定时器（-1 一直暂停时不持有；kit 登记，cleanup 统一清扫） */
  let pauseExpiryTimer: TimerEntry | null = null
  /** 全局暂停生效中（迁移检测：false→true 进暂停排到期重读，true→false 恢复补跑） */
  let globalPauseActive = false

  // ---------- 计时器工具（登记 + owner 守卫 + 统一清扫） ----------
  //
  // 所有定时器经本 kit 创建：句柄登记进实例集合与模块级 LIVE_TIMERS，cleanup /
  // sweepSchedulerTimers 统一清除；autoBootstrap 实例的回调开头比对
  // globalThis.__wdsyncSchedulerOwner（防同进程重复初始化后旧实例残跑），失配自清
  // 且零 IO。测试显式创建的辅助实例（autoBootstrap:false）不做 owner 比对 ——
  // 它们本就是与自举实例并存的合法实例。

  /** 实例内活动定时器集合（cleanup 用） */
  const ownTimers = new Set<TimerEntry>()

  /**
   * 定时器条目：{ dispose() } —— 清除句柄并从实例 / 模块两级登记表移除（幂等）。
   * 句柄统一 unref（不阻止进程退出；进程死亡定时器随进程消失）。
   */
  function makeTimer(clearFn: () => void): TimerEntry {
    let disposed = false
    const entry: TimerEntry = {
      dispose() {
        if (disposed) return
        disposed = true
        try {
          clearFn()
        } catch (_) {
          /* 已触发句柄再 clear 是无害 no-op；其余异常吞掉（清扫不得抛错） */
        }
        ownTimers.delete(entry)
        LIVE_TIMERS.delete(entry)
      },
    }
    ownTimers.add(entry)
    LIVE_TIMERS.add(entry)
    return entry
  }

  const kit = {
    /** 一次性定时器（触发或清除后自动出表） */
    after(fn: (...args: unknown[]) => void, ms: number): TimerEntry {
      const box: { entry: TimerEntry | null } = { entry: null }
      const wrapped = (...args: unknown[]) => {
        if (ownerGuard && globalThis.__wdsyncSchedulerOwner !== instanceId) {
          if (box.entry) box.entry.dispose() // 失配自清且零 IO
          return
        }
        if (box.entry) box.entry.dispose() // 一次性：触发即出表
        fn(...args)
      }
      const handle = rawTimers.setTimeout(wrapped, ms)
      if (handle && typeof handle === 'object' && typeof handle.unref === 'function') handle.unref()
      box.entry = makeTimer(() => rawTimers.clearTimeout(handle as any))
      return box.entry
    },
    /** 周期定时器（dispose 后出表） */
    every(fn: (...args: unknown[]) => void, ms: number): TimerEntry {
      const box: { entry: TimerEntry | null } = { entry: null }
      const wrapped = (...args: unknown[]) => {
        if (ownerGuard && globalThis.__wdsyncSchedulerOwner !== instanceId) {
          if (box.entry) box.entry.dispose()
          return
        }
        fn(...args)
      }
      const handle = rawTimers.setInterval(wrapped, ms)
      if (handle && typeof handle === 'object' && typeof handle.unref === 'function') handle.unref()
      box.entry = makeTimer(() => rawTimers.clearInterval(handle as any))
      return box.entry
    },
    /** 睡眠（经登记的定时器实现；sweep 后挂起的 sleep 不再醒来 —— 等价进程死亡） */
    sleep(ms: number): Promise<void> {
      return new Promise<void>((resolve) => {
        kit.after(() => resolve(), ms)
      })
    },
    disposeAll() {
      for (const e of Array.from(ownTimers)) e.dispose()
    },
  }

  /**
   * 真实时钟睡眠（**轮体 IO 节拍专用**：目录锁轮询 / rename 重试 / 委托回执轮询 /
   * 自举重试）。测试约定「假时钟只管调度决策，轮体 IO 用真实等待」—— 这些等待
   * 节拍 IO 进度而非调度决策，必须走 node:timers 真实通道（假时钟冻结期间 kit.sleep
   * 永不触发，高负载压测实测会挂死整轮）。句柄仍经 makeTimer 登记（sweep 可清扫）。
   */
  function realSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const box: { entry: TimerEntry | null } = { entry: null }
      const handle = nodeTimers.setTimeout(() => {
        if (box.entry) box.entry.dispose()
        resolve()
      }, ms)
      if (handle && typeof handle === 'object' && typeof handle.unref === 'function') handle.unref()
      box.entry = makeTimer(() => nodeTimers.clearTimeout(handle as NodeJS.Timeout))
    })
  }

  // ---------- 事件外发 ----------

  /** 向全部订阅者派发事件（回调异常互不传染；订阅者抛错不中断调度循环） */
  function emit(ev: SchedulerEvent): void {
    for (const fn of Array.from(listeners)) {
      try {
        fn(ev)
      } catch (_) {
        /* 订阅者异常不外抛 */
      }
    }
  }

  /** 调度器自身异常上报（永不中断调度循环；默认仅写日志，visible=true 才外发为用户可见提示） */
  function emitError(message: unknown, phase?: string, visible = false): void {
    emit({ type: 'scheduler-error', message: String(message), phase: phase || 'runtime', visible })
  }

  /** slot 的对外视图（快照与 slot 事件共用同一形状） */
  function slotView(slot: DirSlot): SchedulerSlotView {
    return {
      id: slot.id,
      state: slot.state,
      nextDueAt: slot.nextDueAt,
      nextDueKind: slot.nextDueKind,
      rerunPending: slot.rerunPending,
      cancelRequested: slot.cancelRequested,
      progress: slot.progress || null,
      lastRound: slot.lastRound ? { ...slot.lastRound } : null,
      // 策略状态（UI「下次同步」归因与测试断言共用）
      backoff: { fails: slot.backoffFails || 0, until: slot.backoffUntil || 0 },
      followUp: { count: slot.followCount || 0, noProgress: slot.followNoProgress || 0 },
      watchHeld: slot.watchHeld === true,
    }
  }

  /** 外发 slot 事件（进度已由发射端节流 ≤4Hz；状态迁移处强制发） */
  function emitSlot(slot: DirSlot, force?: boolean): void {
    if (force || !slot._lastEmitAt || now() - slot._lastEmitAt >= PROGRESS_MIN_INTERVAL_MS) {
      slot._lastEmitAt = now()
      emit({ type: 'slot', slot: slotView(slot) })
    }
  }

  // ---------- 路径与配置 ----------

  const schedDir = (): string => path.join(storageRoot(), 'scheduler')
  const leaderLockPath = (): string => path.join(schedDir(), 'leader.lock')
  const manualPath = (): string => path.join(schedDir(), 'manual-requests.jsonl')
  const dirLockPath = (h: string): string => path.join(schedDir(), 'locks', `${h}.lock`)

  /**
   * 目录生效的服务器条目（多服务器解析）：目录 serverId 显式指向优先；缺省 /
   * 失配（该服务器已被删除）回落第一台 —— 与渲染层 dirEngineCfg 同一口径。
   * 无任何服务器（含地址全空）返回 null。
   */
  function serverEntryOf(slot: DirSlot | null): SchedulerServerCfg | null {
    const list = (config && config.servers) || []
    if (slot && slot.dir && slot.dir.serverId) {
      const hit = list.find((s) => s.id === slot.dir.serverId)
      if (hit) return hit
    }
    return list.length ? list[0] : null
  }

  /** 服务已配置（至少一台服务器有地址）：目录参与调度 / 挂 watcher 的公共前提 */
  function serverConfigured(): boolean {
    const list = (config && config.servers) || []
    return list.some((s) => typeof s.serverUrl === 'string' && s.serverUrl)
  }

  /**
   * 目录是否有资格参与自动调度（自身服务器已配置 + 目录启用 + 生效自动同步开 +
   * 未全局暂停）。多服务器形态下按目录各自的服务器判定 —— 未配置的那台只挡
   * 自己的目录，不再拖累其他服务器的目录
   */
  function dirEligible(slot: DirSlot): boolean {
    const entry = serverEntryOf(slot)
    const urlOk = !!((slot.dir && slot.dir.serverUrl) || (entry && entry.serverUrl))
    return urlOk && slot.dir.enabled !== false && autoSyncOf(slot) && !globalPaused()
  }

  /**
   * 目录生效的自动同步开关（目录级覆盖优先，缺省跟随全局偏好）。
   * 关闭后该目录不排自动轮、不挂 watcher，手动 syncNow 仍可用。
   */
  function autoSyncOf(slot: DirSlot): boolean {
    const o = (slot.dir && slot.dir.overrides) || {}
    if (o.autoSync != null) return o.autoSync !== false
    return !(config && config.prefs && config.prefs.autoSync === false)
  }

  /** 从配置对象计算目录生效间隔（ms）；目录级覆盖优先，intervalMin<=0 视为不排定时 */
  function intervalMsOf(slot: DirSlot): number {
    const o = slot.dir.overrides || {}
    const m = Number(o.intervalMin != null ? o.intervalMin : config && config.prefs.intervalMin)
    return Number.isFinite(m) && m > 0 ? m * 60000 : 0
  }

  /** 目录是否有资格参与自动调度（dirEligible 见上方多服务器版本） */

  /**
   * 全局暂停自动同步生效中（prefs.globalPauseUntil，顶栏一键暂停）：
   * > 0 的未来时刻 = 暂停至该时刻；-1 = 一直暂停（只能手动恢复）；
   * 0 / 缺省 / 已过期 = 未暂停。只拦自动调度（经 dirEligible 收敛到 interval /
   * backoff / follow-up / startup / watcher 全部入口），手动 syncNow 不受影响。
   */
  function globalPaused(): boolean {
    const p = Number(config && config.prefs && config.prefs.globalPauseUntil)
    if (!Number.isFinite(p) || p === 0) return false
    if (p === -1) return true
    return p > now()
  }

  /**
   * 目录生效的服务器 URL：历史遗留的目录级 serverUrl 覆盖优先（手改配置路径），
   * 缺省取目录 serverId 指向的服务器（多服务器），再回落第一台。
   */
  function serverUrlOf(slot: DirSlot): string {
    return (slot.dir && slot.dir.serverUrl) || (serverEntryOf(slot) || {}).serverUrl || ''
  }

  /** 目录生效的服务器 origin（并发分组键：同 origin 的轮串行） */
  function originOf(slot: DirSlot): string {
    try {
      return new URL(serverUrlOf(slot)).origin
    } catch (_) {
      return String(serverUrlOf(slot))
    }
  }

  /** 全局并发上限（prefs.schedulerMaxConcurrent 可覆盖；钳位 1–4 防误配） */
  function maxConcurrentRounds() {
    const n = Number(config && config.prefs && config.prefs.schedulerMaxConcurrent)
    if (Number.isFinite(n) && n >= 1) return Math.min(4, Math.floor(n))
    return MAX_CONCURRENT_ROUNDS
  }

  /** 目录锁键：deviceId × 规范化两侧路径 × 目录生效 origin（同机多实例共用一把锁） */
  async function dirLockHashFor(slot: DirSlot): Promise<string> {
    const cached = dirLockHashCache.get(slot.id)
    if (cached) return cached
    const deviceId = await getDeviceId()
    const h = store.hash16(['dirlock', deviceId, store.normalizeLocalKey(slot.dir.localPath), store.normalizeRemoteKey(slot.dir.remotePath), originOf(slot)])
    dirLockHashCache.set(slot.id, h)
    return h
  }

  /**
   * 引擎连接配置：目录 serverId 指向的服务器条目展开（地址 / 账号 / netOpts /
   * tls 各自独立，多服务器互不串凭据）；历史遗留的目录级 serverUrl 覆盖地址；
   * 目录级限速经 netOpts.ratePerSec 注入
   */
  function cfgOf(slot: DirSlot) {
    const base: Record<string, unknown> = { ...(serverEntryOf(slot) || {}) }
    if (slot && slot.dir && slot.dir.serverUrl) base.serverUrl = slot.dir.serverUrl
    const o = (slot && slot.dir && slot.dir.overrides) || {}
    if (o.ratePerSec != null) {
      // 目录级限速是显式覆盖：直接改写 netOpts.ratePerSec，服务器显式值与档案默认
      //（如坚果云自动限速）都不再生效 —— resolveNetOpts 只认 cfg.netOpts 的显式键
      const net = typeof base.netOpts === 'object' && base.netOpts ? { ...(base.netOpts as Record<string, unknown>) } : {}
      net.ratePerSec = o.ratePerSec
      base.netOpts = net
    }
    // 调度器轮次标记：带宽限速走网络层的实时限额表（applyNetLimits 随配置应用
    // 推送）—— 设置保存后在途传输的下一个切片即按新速率执行；渲染层直调 / 测试
    // 路径不打标记，维持请求侧 netOpts 的旧口径
    base.__wdsyncLiveLimits = true
    return base
  }

  /**
   * 目录生效的同步参数（与渲染层 dirSyncPrefs 同一优先级口径；overrides 优先，
   * 未覆盖项回落全局偏好）。优先级合并与畸形值防御（dbStorage 读到的原始
   * JSON：数值取整 / 布尔归一 / 数组校验）统一在 types.mts 的 resolveDirPrefs
   * —— 前后端单一口径，本函数只负责喂入 slot 的覆盖与全局偏好。
   */
  function prefsOf(slot: DirSlot) {
    return resolveDirPrefs(slot.dir.overrides, config && config.prefs)
  }

  // ---------- dbStorage 读取与配置应用 ----------

  /**
   * 每次经宿主端口取配置权威通道（现取不缓存 —— 自举约束）；不可用返回 null。
   * 默认端口即 window.ztools.dbStorage（host.mts），不可用时的错误文案因此保持
   * 宿主接口名不变；测试 / 无头形态经 services.host.setHostPorts 注入自定义 config。
   */
  function dbStorage() {
    return getHostPorts().config
  }

  /**
   * 读取并规范化配置。dbStorage 不可用 / 读取异常返回 { error }；键不存在按
   * 「空配置」处理（ready=true，0 个目录 —— 插件从未配置过的合法初态）。
   */
  function loadConfig(): { config?: SchedulerConfig; error?: string } {
    const db = dbStorage()
    if (!db) return { error: 'window.ztools.dbStorage 不可用' }
    let raw: any = null
    try {
      raw = db.getItem<any>(CONFIG_KEY)
    } catch (e: any) {
      return { error: `dbStorage 读取失败：${(e && e.message) || e}` }
    }
    if (raw == null) return { config: { servers: [], dirs: [], prefs: {} } }
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw)
      } catch (_) {
        return { error: '配置解析失败（webdav-sync:data 不是合法 JSON）' }
      }
    }
    if (!raw || typeof raw !== 'object') return { error: '配置格式不识别' }
    // 服务器列表（多账号 / 多服务器）：servers[] 为权威形态；旧配置只有单份
    // server —— 迁移为唯一成员（id 固定 'srv-default'，与渲染层 store 的迁移同款，
    // 目录缺省 serverId 恰好指向它，行为与单服务器形态完全一致）。
    // 密码经凭据混淆（AES-256-GCM）落盘：读取时解密回内存供引擎使用。解密失败
    //（密钥文件丢失 / 密文损坏 / 值本就不是密文格式）返回 ''—— 按密码为空处理，
    // 连接将以 401 失败提示用户重输，绝不把密文当明文送去认证。混淆语义见
    // store.js「凭据混淆」节（防随手窥视，非强加密）。
    const openServer = (s: any): SchedulerServerCfg => {
      const out: SchedulerServerCfg = { ...s }
      if (typeof out.id !== 'string' || !out.id) out.id = 'srv-default'
      if (typeof out.password === 'string') out.password = store.openSecret(out.password)
      return out
    }
    const servers: SchedulerServerCfg[] = (Array.isArray(raw.servers) ? raw.servers : [])
      .filter((s: any) => s && typeof s === 'object')
      .map(openServer)
    if (!servers.length && raw.server && typeof raw.server === 'object') servers.push(openServer(raw.server))
    const dirs = Array.isArray(raw.dirs)
      ? raw.dirs
          .filter((d: any) => d && typeof d === 'object' && d.localPath && d.remotePath)
          .map((d: any) => ({
            id: String(d.id || randomId()),
            localPath: String(d.localPath),
            remotePath: String(d.remotePath),
            mode: d.mode === 'upload' || d.mode === 'download' ? d.mode : 'two-way',
            enabled: d.enabled !== false,
            overrides: d.overrides && typeof d.overrides === 'object' ? d.overrides : null,
            // 目录使用的服务器（servers[] 成员 id；旧配置 / 缺省 = null 跟随第一台）
            serverId: d.serverId ? String(d.serverId) : null,
            // 目录级服务器地址覆盖（历史遗留路径；现有 UI 不写 —— 多服务器形态走 serverId）
            serverUrl: d.serverUrl ? String(d.serverUrl) : null,
          }))
          // 实验功能「ZTools 插件同步」的固定 id 由下方合成项独占：历史数据里若
          // 恰有同 id 的手改条目一律丢弃，防止与合成 slot 撞 id（运行时状态错乱）
          .filter((d: any) => d.id !== ZTOOLS_PLUGINS_DIR_ID)
      : []
    const prefs = raw.prefs && typeof raw.prefs === 'object' ? raw.prefs : {}
    // 实验功能「ZTools 插件同步」（ztools-plugins.mts 是发现的单一事实源）：
    // 开关开启时在用户目录之后合成固定 id 的目录配置 —— 本地目录自动发现、
    // 远端 = 用户所选父目录（ztoolsPluginSyncRemoteDir；缺省云端根）后固定跟上
    // ztools-plugins/<平台> 两段，mode 恒 two-way、无目录级覆盖；行级暂停
    //（ztoolsPluginSyncPaused）映射为 enabled=false，与用户目录「停用」完全同构
    //（slot 保留、dirEligible 跳过）。该记录不落 dbStorage 的 dirs（渲染层虚拟行
    // 同样不持久化）：每次 reload 现场合成，配置权威仍是 prefs 开关。
    if (prefs.ztoolsPluginSync === true) {
      const desc = describeZtoolsPluginsSync(typeof prefs.ztoolsPluginSyncRemoteDir === 'string' ? prefs.ztoolsPluginSyncRemoteDir : '')
      dirs.push({
        id: ZTOOLS_PLUGINS_DIR_ID,
        localPath: desc.pluginsDir,
        remotePath: desc.remotePath,
        mode: 'two-way',
        enabled: prefs.ztoolsPluginSyncPaused !== true,
        overrides: null,
        serverId: null,
        serverUrl: null,
      })
    }
    return { config: { servers, dirs, prefs } }
  }

  /**
   * 新建 slot 的初始状态（applyConfig 与 slotRefFor 共用）。
   * 调度策略字段：
   *   backoffFails / backoffUntil —— 连续网络类失败轮数 / 退避截止时刻（0 = 无退避）
   *   followCount / followNoProgress / followLastOpen —— follow-up 轮次 / 无进展计数 /
   *     上一轮的开放意图数（无进展 = 开放意图数未下降）
   *   yieldStreak  —— 连续让出轮数（≥5 按 interval 收敛）
   *   watchHeld    —— 退避期内合并的 watch 触发（不排队不提前，退避到期轮吸收）
   *   lastNotifyFp —— 最近一次已提醒的「无 choice 挂起冲突」指纹（同批不重复提醒）
   */
  function newSlotState(id: string, dir: SchedulerDirCfg): DirSlot {
    return {
      id,
      dir,
      state: 'idle',
      nextDueAt: null,
      nextDueKind: null,
      rerunPending: false,
      cancelRequested: false,
      lastRound: null,
      progress: null,
      roundSeq: 0,
      _lastEmitAt: 0,
      backoffFails: 0,
      backoffUntil: 0,
      followCount: 0,
      followNoProgress: 0,
      followLastOpen: 0,
      yieldStreak: 0,
      watchHeld: false,
      lastNotifyFp: null,
      startupPending: false,
      traffic: null,
    }
  }

  /**
   * 应用一份新配置：按 configV 自检（内容哈希不变则跳过），重建 slots、按需入队
   * 新目录的首次同步、leader 侧重挂 watcher。自举 / initial 加载**不**立即同步
   * （打开插件不触发同步，首轮交给各目录既定的 interval 时间点）；后续 reload 只
   * 对**新出现**的目录排一次立即同步（对应旧渲染层 addDir 后立即 syncDir 的行为）。
   */
  async function applyConfig(cfg: SchedulerConfig, opts2: { initial?: boolean } = {}): Promise<{ applied: boolean }> {
    const v = store.hash16([cfg])
    if (!opts2.initial && v === configV) return { applied: false }
    const prevSlots = slots
    configV = v
    config = cfg
    // 带宽限额实时推送：把每台服务器当前生效的上传 / 下载限速写进网络层活值表
    // —— 设置保存（防抖落盘 → reload → 走到这里）后在途传输的下一个 64KB 切片
    // 与本轮后续新请求立即按新限额执行（此前字节桶只在首次创建时读一次速率，
    // 改动要重启插件才生效）。请求限速（ratePerSec）不在此列：它逐请求按轮次
    // 快照现算，改动从下一轮起生效。
    for (const s of cfg.servers) applyNetLimits(s.serverUrl, s.netOpts)
    // 目录级地址覆盖（历史遗留）：按覆盖后的生效地址补推同款限额，与 cfgOf 的
    // 服务器解析同口径（serverId 显式指向优先，缺省回落第一台）
    for (const d of cfg.dirs) {
      if (!d.serverUrl) continue
      const entry = (d.serverId ? cfg.servers.find((x) => x.id === d.serverId) : null) || cfg.servers[0]
      if (entry) applyNetLimits(d.serverUrl, entry.netOpts)
    }
    // 目录锁键缓存全量失效：configV 自检已保证只在配置**真变**时走到这里，全量清
    // 一次的代价可忽略（每目录下次取锁多一次 getDeviceId + hash16）。一次 clear
    // 覆盖三类情形：① 目录路径变化（normalizeLocalKey/RemoteKey 输入变 → 键必变，
    // 旧缓存会让新旧路径各持一把锁失去互斥）；② 服务器 URL / serverId 变化
    //（originOf 输入变，同上）；③ 已删除目录的 Map 条目回收（不清则按 dirId 永久
    // 泄漏 —— cache 键是 slot.id，slot 删除时无人摘除）。
    dirLockHashCache.clear()
    ready = true
    everLoaded = true
    notReadyReason = null
    // 重建 slots：按 id 保留既有运行时状态（lastRound 等），新目录建新 slot
    const newIds = new Set()
    for (const d of cfg.dirs) {
      const old = prevSlots.get(d.id)
      if (old) {
        old.dir = d
      } else {
        newIds.add(d.id)
        prevSlots.set(d.id, newSlotState(d.id, d))
      }
    }
    // 删除目录：除了摘 slot 与 watcher，还必须冲刷该目录的轮末等待者 —— slot 一旦
    // 出表，其 rerun 预订（watch 重排）永不被 tick 扫到（tick 只遍历 slots），等待
    // 「该目录下一次轮末」的 syncNow / rerun 等待者将永久悬挂（见 failWaitersFor）。
    // 文案与 pumpQueue 丢弃已移除目录 job（1787 附近）、委托回执「目录已被移除」
    // 的既有用例保持一致。
    for (const dirId of Array.from(prevSlots.keys())) {
      if (cfg.dirs.some((d) => d.id === dirId)) continue
      prevSlots.delete(dirId)
      failWaitersFor(dirId, new Error('这个同步文件夹已被移除'))
    }
    for (const dirId of Array.from(watcherRegs.keys())) if (!prevSlots.has(dirId)) stopWatcherFor(dirId)
    for (const slot of prevSlots.values()) {
      if (!dirEligible(slot)) {
        // 目录不再有自动调度资格（停用 / 目录级自动同步关）：清掉自动类残留预订
        //（interval / backoff / follow-up / yield-retry）回 idle —— tick 只清「到期」
        // 的预订，未来预订会一直挂在快照上误导 UI。watch 重排（rerun 追赶）保留：
        // 可能有轮末等待者等它收场（手动重叠语义），到期由 tick 的既有闸门处理。
        if (slot.state === 'scheduled' && slot.nextDueKind !== 'watch') {
          slot.state = 'idle'
          slot.nextDueAt = null
          slot.nextDueKind = null
        }
        continue
      }
      // 新目录首轮不在此入队：applyConfig 可能早于选举完成（init 后选举异步在途），
      // 自动轮会被 startRound 的 leader 闸门按 skipped 丢弃 → 只置 pending 标记，
      // 由 leader 态的 tick（≤1s）发射；未上位期间自然挂起（leader 是唯一调度者）
      // 【实验：ZTools 插件同步】开启开关（reload 出现新 slot）不立即同步：
      // 跳过首轮标记，首轮交给 ensureIntervalSchedule 排到下一个 interval
      // 时间点 —— 插件目录可能很大，且开关常在浏览实验功能时被随手打开，开启
      // 瞬间触发全量上传不符合预期。
      if (!opts2.initial && newIds.has(slot.id)) {
        if (slot.id !== ZTOOLS_PLUGINS_DIR_ID) slot.startupPending = true
      }
      ensureIntervalSchedule(slot)
    }
    rebuildWatchers()
    syncPauseWatch()
    if (!suspended) {
      startTick()
      if (leaderState !== 'leader') startElection()
    }
    emit({ type: 'config-applied', dirsCount: prevSlots.size })
    return { applied: true }
  }

  // ---------- 全局暂停（prefs.globalPauseUntil，顶栏一键暂停） ----------

  /**
   * 暂停状态迁移的收敛点（applyConfig 末尾调用）：进入暂停 → 摘除 watcher 与
   * 自动类预订已由 dirEligible=false 的既有分支完成，这里只安排「到期重读」；
   * 退出暂停（手动恢复 / 到期）→ 补跑预订 + 重挂 watcher。
   * 到期定时器是唯一「配置内容未变也需要动作」的路径 —— applyConfig 按 configV
   * 自检会跳过未变配置，暂停到期只能自己驱动（refreshConfig 后重新判定迁移，
   * 用户可能在暂停期间又改了到期时刻 / 干脆续了暂停）。
   */
  function syncPauseWatch(): void {
    const paused = globalPaused()
    const was = globalPauseActive
    globalPauseActive = paused
    if (pauseExpiryTimer) {
      pauseExpiryTimer.dispose()
      pauseExpiryTimer = null
    }
    if (!paused) {
      if (was) resumeAfterPause()
      return
    }
    const p = Number(config && config.prefs && config.prefs.globalPauseUntil)
    if (p > 0) {
      // 有到期时刻：到点重读配置再判迁移。-1 = 一直暂停，无到期定时器 ——
      // 手动恢复经 persist → reload → applyConfig 走本函数的恢复分支
      pauseExpiryTimer = kit.after(() => {
        pauseExpiryTimer = null
        void refreshConfig({})
          .catch(() => {})
          .then(() => {
            if (!destroyed) syncPauseWatch()
          })
      }, Math.max(1000, p - now() + 500))
    }
  }

  /**
   * 恢复自动调度后的补跑：有资格、空闲且按 interval 排程的目录在短抖动内到期
   *（吸收暂停期间的积压变更）。只动预订状态，不直接入队 —— 非leader 实例 /
   * 挂起态下 tick 不跑，预订挂在 slot 上，上位 / 恢复后自然发射。退避、让出、
   * follow-up 与 watch 重排（rerunPending）等既有语义优先，一律不覆盖。
   */
  function resumeAfterPause(): void {
    for (const slot of slots.values()) {
      if (!dirEligible(slot)) continue
      if (slot.state === 'running' || slot.state === 'queued') continue
      if (slot.rerunPending || slot.nextDueKind === 'watch') continue // 有轮末等待者：交还 rerun 语义
      if (slot.backoffUntil > now()) continue // 退避期内：维持 backoff 预订语义
      if (intervalMsOf(slot) <= 0) continue // 不排定时的目录（仅 watch 驱动）不补跑
      slot.nextDueAt = now() + jitterRange(RESUME_CATCHUP_MIN_MS, RESUME_CATCHUP_MAX_MS)
      slot.nextDueKind = 'interval'
      if (slot.state === 'idle') slot.state = 'scheduled'
    }
    rebuildWatchers()
    if (!suspended && ready) startTick()
  }

  /**
   * 自举 / init / reload 的配置读取入口：读 dbStorage → applyConfig。
   * 失败返回错误（ready 维持旧值；自举路径由调用方重试）。
   */
  async function refreshConfig(opts2: { initial?: boolean }): Promise<{ applied: boolean; error?: string }> {
    const r = loadConfig()
    if (r.error || !r.config) return { applied: false, error: r.error || '配置为空' }
    return applyConfig(r.config, opts2)
  }

  // ---------- 自举（不依赖渲染层 JS 存活） ----------

  /**
   * 自举重试：dbStorage 不可用时 50ms×20 重试（每次经宿主端口现取，不缓存引用），
   * 仍失败 → ready:false + scheduler-error（UI 可见）；此后仅 init()/reload() 可复活。
   * globalThis.__wdsyncSchedulerOwner 防同进程重复自举：宿主 preload 对同一 filePath
   * 执行层去重（实测结论），本守卫只作 belt & braces。
   */
  async function bootstrapWithRetry() {
    for (let i = 0; i < BOOTSTRAP_MAX_RETRIES; i++) {
      if (destroyed) return
      const r = loadConfig()
      if (!r.error && r.config) {
        await applyConfig(r.config, { initial: true })
        return
      }
      notReadyReason = `自举等待宿主就绪：${r.error}`
      await realSleep(BOOTSTRAP_RETRY_MS)
    }
    notReadyReason = `dbStorage 不可用，调度器未启动：${notReadyReason}`
    emitError(notReadyReason, 'bootstrap')
  }

  // ---------- leader 选举 ----------

  /** 读取 leader 锁：{ body, st } 或 null（不存在 / 不可读 / 内容损坏按 null 处理） */
  async function leaderLockRead(): Promise<{ body: any; st: fs.Stats | null } | null> {
    try {
      const text = await fsp.readFile(leaderLockPath(), 'utf-8')
      const st = await statOrNull(leaderLockPath())
      let body: any = null
      try {
        body = JSON.parse(text)
      } catch (_) {
        body = null
      }
      return { body, st }
    } catch (_) {
      return null
    }
  }

  /** leader 锁当前是否归属本实例（内容 instanceId 比对） */
  async function leaderLockIsMine(): Promise<boolean> {
    const r = await leaderLockRead()
    return !!(r && r.body && r.body.instanceId === instanceId)
  }

  /**
   * leader 锁是否「活着」：内容 instanceId 合法 且（mtime 新鲜 或 内容 at 新鲜）。
   * 双信号取或 —— 任一信号新鲜即不抢占（保守：绝不偷走无法证明已停更的锁）。
   */
  function leaderAlive(r: { body: any; st: fs.Stats | null } | null): boolean {
    if (!r || !r.body || typeof r.body.instanceId !== 'string' || !r.body.instanceId) return false
    const mtimeFresh = r.st && now() - r.st.mtimeMs < LEADER_TTL_MS
    const atFresh = Number(r.body.at) > 0 && now() - Number(r.body.at) < LEADER_TTL_MS
    return !!(mtimeFresh || atFresh)
  }

  /** leader 锁原子写（temp+rename，at=now）：心跳 / 抢占共用 */
  async function atomicWriteLeaderLock(): Promise<void> {
    const body = JSON.stringify({ v: 1, instanceId, deviceId: await getDeviceId(), at: now() })
    await atomicWriteFile(leaderLockPath(), body, `${leaderLockPath()}.tmp-${instanceId}`)
  }

  /**
   * temp+rename 原子写（小文件共用；tmp 路径可指定以固定命名）。
   * rename 带瞬时错误重试（Windows 实测：Temp 下新建文件被 Defender / 索引器
   * 短暂占用时 rename 偶发 EPERM/EACCES/EBUSY —— 重试数次的代价远小于让心跳 /
   * 选举整链失败）。
   */
  async function atomicWriteFile(p: string, text: string, tmp?: string): Promise<void> {
    const t = tmp || `${p}.tmp-${instanceId}-${Math.random().toString(36).slice(2, 6)}`
    const fh = await fsp.open(t, 'w')
    try {
      await fh.writeFile(text, 'utf-8')
    } finally {
      await fh.close()
    }
    for (let i = 0; ; i++) {
      try {
        await fsp.rename(t, p)
        return
      } catch (e: any) {
        if (i < 5 && e && (e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY' || e.code === 'ENOTEMPTY')) {
          await realSleep(10 * (i + 1))
          continue
        }
        await fsp.rm(t, { force: true }).catch(() => {})
        throw e
      }
    }
  }

  /**
   * 尝试获取 leader 锁。状态机：
   *   无锁（ENOENT）→ 'wx' 独占创建 + 回读确认（EEXIST = 竞争失败，下轮再试）；
   *   锁内容损坏   → temp+rename 抢占 + 回读确认；
   *   他人持锁且活着 → 让位（acquired:false）；
   *   停更 ≥ TTL   → temp+rename 抢占 + 回读确认（回读失配 = 竞争失败）；
   *   自己持锁     → 刷新 at 恢复（重选回到自己的遗留锁）。
   * @returns {Promise<{acquired: boolean}>}
   */
  async function tryAcquireLeader(): Promise<{ acquired: boolean }> {
    if (destroyed || suspended) return { acquired: false }
    await fsp.mkdir(schedDir(), { recursive: true }).catch(() => {})
    const cur = await leaderLockRead()
    if (destroyed || suspended) return { acquired: false }
    if (cur && cur.body && cur.body.instanceId === instanceId) {
      await atomicWriteLeaderLock()
      return { acquired: await leaderLockIsMine() }
    }
    if (cur && leaderAlive(cur)) return { acquired: false }
    if (!cur) {
      try {
        const fh = await fsp.open(leaderLockPath(), 'wx')
        try {
          await fh.writeFile(JSON.stringify({ v: 1, instanceId, deviceId: await getDeviceId(), at: now() }), 'utf-8')
        } finally {
          await fh.close()
        }
        return { acquired: await leaderLockIsMine() }
      } catch (e: any) {
        if (e && e.code === 'EEXIST') return { acquired: false } // 并发竞争：本轮让位
        return { acquired: false }
      }
    }
    // 存在但停更 ≥ TTL / 内容损坏：temp+rename 抢占
    await atomicWriteLeaderLock()
    return { acquired: await leaderLockIsMine() }
  }

  /** 尽力释放 leader 锁（内容归属本实例才删；unload / suspend 主动让位用，其余靠 TTL） */
  async function resignLeaderBestEffort(): Promise<void> {
    try {
      if (await leaderLockIsMine()) await fsp.rm(leaderLockPath(), { force: true })
    } catch (_) {
      /* 释放失败靠 TTL 接管 */
    }
  }

  let electionTimer: TimerEntry | null = null
  let heartbeatTimer: TimerEntry | null = null

  /** 启动选举：立即尝试一次，失败按抖动间隔重试 */
  function startElection(): void {
    if (destroyed || suspended) return
    if (leaderState === 'leader') return
    leaderState = 'candidate'
    void electionAttempt()
  }

  async function electionAttempt(): Promise<void> {
    if (destroyed || suspended || leaderState === 'leader') return
    let r
    try {
      r = await tryAcquireLeader()
    } catch (e: any) {
      // 获取链路的任何 IO 异常（含瞬时 rename 失败重试耗尽）都不得逃逸成未处理
      // 拒绝 —— 记诊断、退回 standby 按抖动间隔重试（锁的最终一致由 TTL 兜底）
      if (destroyed || suspended) return
      leaderState = 'standby'
      emitError(`leader 选举异常（${(e && e.message) || e}），稍后重试`, 'election')
      scheduleElectionRetry(ELECTION_RETRY_MS)
      return
    }
    if (destroyed || suspended) return
    if (r.acquired) {
      leaderState = 'leader'
      ownerRef.valid = true
      startHeartbeat()
      rebuildWatchers()
      pumpQueue()
    } else {
      leaderState = 'standby'
      scheduleElectionRetry(ELECTION_RETRY_MS)
    }
  }

  /** 选举重试排程（幂等替换）；lost 后用 30s±30% 基数，竞争失败用 5s 基数 */
  function scheduleElectionRetry(baseMs: number): void {
    if (electionTimer) electionTimer.dispose()
    electionTimer = kit.after(() => {
      electionTimer = null
      if (leaderState !== 'leader' && !destroyed && !suspended) {
        leaderState = 'candidate'
        void electionAttempt()
      }
    }, jitter(baseMs))
  }

  /** 心跳：temp+rename 重写（刷新 mtime 与 at）→ 回读确认；失配 → lost */
  function startHeartbeat(): void {
    if (heartbeatTimer) heartbeatTimer.dispose()
    heartbeatTimer = kit.every(() => void heartbeatTick(), HEARTBEAT_MS)
    void heartbeatTick() // 成为 leader 立即跳一拍（兼作首轮确认）
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) heartbeatTimer.dispose()
    heartbeatTimer = null
  }

  async function heartbeatTick(): Promise<void> {
    if (destroyed || suspended || leaderState !== 'leader') return
    try {
      // 先读后写：若锁已属他人且新鲜（TTL 接管已发生），直接弃位 —— 先写会覆盖新
      // leader 的锁、再回读只见到自己，被接管的原实例会误判「仍在位」造成双 leader
      const cur = await leaderLockRead()
      if (destroyed || suspended) return
      if (cur && cur.body && cur.body.instanceId !== instanceId && leaderAlive(cur)) {
        becomeLost('心跳发现锁已被其他实例接管')
        return
      }
      const t0 = now()
      await atomicWriteLeaderLock()
      const dt = now() - t0
      if (dt > SLOW_HEARTBEAT_WARN_MS) emitError(`leader 心跳写入缓慢（${dt}ms）`, 'heartbeat')
      if (!(await leaderLockIsMine())) {
        becomeLost('心跳回读失配（锁已被其他实例接管）')
        return
      }
      heartbeatWarned = false
    } catch (e: any) {
      // 心跳写失败（IO 异常）不立即弃位：保守保持 leader，TTL 让其他实例兜底接管；
      // 连续失败只上报一次诊断（恢复成功后重置，可再次上报）
      if (!heartbeatWarned) {
        heartbeatWarned = true
        emitError(`leader 心跳写入失败（${(e && e.message) || e}）：保持持锁，TTL 兜底`, 'heartbeat')
      }
      return
    }
    // 心跳周期内捎带轮询手动委托请求（leader 侧职责）
    await pollManualRequests().catch(() => {})
  }

  let heartbeatWarned = false

  /**
   * lost：停自动调度（tick 守卫 leaderState、停心跳、停 watcher），在途轮经
   * ownerRef.valid=false 在文件边界以取消语义中止（引擎零改动，基线与 WAL 一致、
   * 目录锁照常释放）；30s±30% 抖动后重选。
   */
  function becomeLost(reason: string): void {
    if (leaderState === 'lost') return
    leaderState = 'lost'
    ownerRef.valid = false
    stopHeartbeat()
    stopAllWatchers()
    scheduleElectionRetry(LOST_REELECT_BASE_MS)
    emitError(`leader 身份丢失，暂停自动调度等待重选：${reason}`, 'leader')
    // 冲刷轮末等待者：重选期间 rerun 预订可能长期不被 tick 消费（他机已上位时
    // 本实例不再成为 leader），等待者以错误收场而非永久悬挂；在飞轮随后正常 settle
    // 时的二次 resolve 不存在 —— waiter 已 splice，且 Promise 本身只结算一次
    for (let i = roundWaiters.length - 1; i >= 0; i--) {
      const w = roundWaiters.splice(i, 1)[0]
      try {
        w.resolve({ error: new Error('已取消同步') })
      } catch (_) {
        /* 忽略 */
      }
    }
  }

  // ---------- 目录互斥锁（locks/<h>.lock） ----------

  /**
   * 单次尝试获取目录锁：
   *   无锁 → 'wx' 独占创建 + 回读确认（EEXIST = 竞争失败）；
   *   自己持锁 → 重写 at（续期语义，重入安全）；
   *   他人持锁：内容 at 与 mtime 双信号都停更 ≥ TTL → temp+rename 接管 + 回读确认；
   *             否则忙（返回 false，调用方异步轮询等待）。
   * IO 异常一律按「未获得」处理（绝不因锁通道故障阻断同步 —— 引擎侧远端租约锁
   * 与档位保护仍是安全底线）。
   * @returns {Promise<boolean>} 是否已持有
   */
  async function tryAcquireDirLock(h: string): Promise<boolean> {
    const p = dirLockPath(h)
    await fsp.mkdir(path.dirname(p), { recursive: true }).catch(() => {})
    const body = JSON.stringify({ v: 1, instanceId, at: now(), ttlMs: DIR_LOCK_TTL_MS })
    try {
      const fh = await fsp.open(p, 'wx')
      try {
        await fh.writeFile(body, 'utf-8')
      } finally {
        await fh.close()
      }
    } catch (e: any) {
      if (!e || e.code !== 'EEXIST') return false // IO 异常：按未获得处理
      let prev: any = null
      let st: any = null
      try {
        prev = JSON.parse(await fsp.readFile(p, 'utf-8'))
        st = await fsp.stat(p)
      } catch (_) {
        prev = null
      }
      if (prev && prev.instanceId === instanceId) {
        // 自己的锁（前一轮异常退出后重入）：重写刷新 at
        await atomicWriteFile(p, body).catch(() => {})
        return true
      }
      const ageAt = now() - (Number(prev && prev.at) || 0) >= DIR_LOCK_TTL_MS
      const ageMtime = !st || now() - st.mtimeMs >= DIR_LOCK_TTL_MS
      if (ageAt && ageMtime) {
        // 停更 ≥ TTL：接管（temp+rename 原子替换，写回竞态由回读暴露）
        await atomicWriteFile(p, body).catch(() => false)
        try {
          const rb = JSON.parse(await fsp.readFile(p, 'utf-8'))
          return !!(rb && rb.instanceId === instanceId)
        } catch (_) {
          return false
        }
      }
      return false
    }
    try {
      const rb = JSON.parse(await fsp.readFile(p, 'utf-8'))
      return !!(rb && rb.instanceId === instanceId)
    } catch (_) {
      return false
    }
  }

  /**
   * 异步等待目录锁（可取消，不阻塞 tick）：轮询 tryAcquireDirLock 直至获得 /
   * 取消 / leader 丢失 / 超时。等待期间放弃的条件与调用方上下文一致。
   * @param {string} h 锁键
   * @param {object} ctx { slot, maxWaitMs, cancelOn?, cancelOnReason?, onPoll? }；
   *        leader 轮附加 ownerRef 中止条件；onPoll 在每轮轮询间隙调用（锁等待进度的
   *        外发钩子，经调用方的节流发射器限频）
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async function acquireDirLockWaiting(h: string, ctx: { slot: DirSlot | null; maxWaitMs: number; cancelOn?: () => boolean; cancelOnReason?: string; onPoll?: () => void }): Promise<{ ok: boolean; reason?: string }> {
    const t0 = now()
    for (;;) {
      if (destroyed) return { ok: false, reason: '调度器已销毁' }
      if (ctx.slot && ctx.cancelOn && ctx.cancelOn()) return { ok: false, reason: ctx.cancelOnReason || '已取消' }
      let got = false
      try {
        got = await tryAcquireDirLock(h)
      } catch (_) {
        got = false
      }
      if (got) {
        startDirLockRenew(h)
        return { ok: true }
      }
      if (now() - t0 >= ctx.maxWaitMs) return { ok: false, reason: '等待目录锁超时' }
      if (ctx.onPoll) {
        try {
          ctx.onPoll()
        } catch (_) {
          /* 进度外发失败不影响锁等待 */
        }
      }
      await realSleep(DIR_LOCK_POLL_MS)
    }
  }

  /** 持锁续期：每 DIR_LOCK_RENEW_MS 重写 at（temp+rename）；释放时停表 */
  function startDirLockRenew(h: string): void {
    stopDirLockRenew(h)
    const entry = kit.every(() => {
      void (async () => {
        try {
          await atomicWriteFile(dirLockPath(h), JSON.stringify({ v: 1, instanceId, at: now(), ttlMs: DIR_LOCK_TTL_MS }))
        } catch (_) {
          /* 续期失败靠 TTL 语义兜底（他机 60s 后可接管） */
        }
      })()
    }, DIR_LOCK_RENEW_MS)
    heldDirLocks.set(h, { renew: entry })
  }

  function stopDirLockRenew(h: string): void {
    const rec = heldDirLocks.get(h)
    if (rec) {
      rec.renew.dispose()
      heldDirLocks.delete(h)
    }
  }

  /** 释放目录锁：停续期 + 内容归属本实例才删（尽力而为，失败靠 TTL） */
  async function releaseDirLock(h: string): Promise<void> {
    stopDirLockRenew(h)
    try {
      const body = JSON.parse(await fsp.readFile(dirLockPath(h), 'utf-8'))
      if (body && body.instanceId === instanceId) await fsp.rm(dirLockPath(h), { force: true })
    } catch (_) {
      /* 不存在（已接管 / 已释放）/ 读取失败：无事可做 */
    }
  }

  // ---------- 手动委托（manual-requests.jsonl） ----------

  /** 追加一行委托记录（CRC 行格式与基线日志一致；appendFile 小行写近似原子） */
  async function appendManualLine(op: ManualOp): Promise<void> {
    await fsp.mkdir(schedDir(), { recursive: true }).catch(() => {})
    await fsp.appendFile(manualPath(), store.encodeCrcLine(now(), op) + '\n', 'utf-8')
  }

  /**
   * 读取 manual-requests 全部合法行（CRC 校验失败的行忽略；未知 kind 忽略 ——
   * 前向兼容），返回 op 数组（保持写入顺序）。
   */
  async function readManualLines(): Promise<ManualOp[]> {
    let text = ''
    try {
      text = await fsp.readFile(manualPath(), 'utf-8')
    } catch (_) {
      return []
    }
    const out: ManualOp[] = []
    for (const line of text.split('\n')) {
      const t = line.trim()
      if (!t) continue
      const op = store.decodeCrcLine(t)
      if (op && typeof op.kind === 'string') out.push(op)
    }
    return out
  }

  /** 把行序列折叠为三元组表：id → { req?, claim?, receipt? }（未知 kind 忽略） */
  function foldManualTriples(lines: ManualOp[]): Map<string, ManualTriple> {
    const byId = new Map<any, any>()
    for (const op of lines) {
      if (!op.id) continue
      let rec = byId.get(op.id)
      if (!rec) {
        rec = {}
        byId.set(op.id, rec)
      }
      if (op.kind === 'req') rec.req = op
      else if (op.kind === 'claim') rec.claim = op
      else if (op.kind === 'receipt') rec.receipt = op
    }
    return byId
  }

  /**
   * leader 侧轮询：领取未 claim 的 req → 立即写 claim → 经全局队列执行该目录的
   * 手动轮（冲突一律 defer）→ 写 receipt。顺带压缩 10 分钟前已有 receipt 的三元组。
   * 只处理「无 claim 无 receipt」的请求 —— 他实例已 claim 的请求由该实例负责，
   * 领取者死亡由请求方的 15s 超时 / 心跳失联兜底接管，绝不双跑。
   * 压缩只移除带 receipt 的三元组（「req 已被压缩 ⇒ 视同已处理」依赖该不变量）。
   */
  async function pollManualRequests(): Promise<void> {
    if (leaderState !== 'leader' || destroyed || suspended) return
    // 重入互斥：心跳每 5s 一拍，处理内的 await（写 claim / 等轮完成）会放出下一拍，
    // 不加门会出现两拍并发读到同一「未领取」请求而双重 claim / 双跑
    if (pollingManual) return
    pollingManual = true
    try {
      await pollManualRequestsInner()
    } finally {
      pollingManual = false
    }
  }

  let pollingManual = false

  async function pollManualRequestsInner(): Promise<void> {
    let lines = await readManualLines()
    if (!lines.length) return
    let byId = foldManualTriples(lines)
    let processed = false
    for (const [id, rec] of byId) {
      if (!rec.req || rec.claim || rec.receipt) continue
      await appendManualLine({ kind: 'claim', id, by: instanceId, at: now() })
      processed = true
      const slot = rec.req.dirId ? slots.get(rec.req.dirId) : undefined
      const dirCfg = slot ? slot.dir : rec.req.dir
      if (!dirCfg || !dirCfg.localPath) {
        await appendManualLine({ kind: 'receipt', id, by: instanceId, at: now(), ok: false, error: '这个同步文件夹已被移除' })
        continue
      }
      // 一次性单向操作随 req 穿透委托链；目标目录忙时明确拒绝（忙时重排轮无法
      // 携带 op，放行会退化为常规轮、传播删除，违背按钮语义）
      const op =
        rec.req.op === 'pull' || rec.req.op === 'push' || rec.req.op === 'pull-full' || rec.req.op === 'push-full' ? rec.req.op : null
      if (op && slot && (slot.state === 'queued' || slot.state === 'running')) {
        await appendManualLine({ kind: 'receipt', id, by: instanceId, at: now(), ok: false, error: '这个文件夹正在同步中，请等这一轮结束再试' })
        continue
      }
      // 委托轮走全局队列（kind='manual-delegated'：冲突一律 defer，不转发本机渲染层）
      const result = await new Promise<RoundResolveValue>((resolve) => {
        enqueue(slotRefFor(dirCfg), 'manual-delegated', true, resolve, op)
      })
      await appendManualLine({
        kind: 'receipt',
        id,
        by: instanceId,
        at: now(),
        ok: !result.error,
        error: result.error ? String(result.error).slice(0, 400) : undefined,
      })
    }
    if (processed) {
      // 刚写过 claim / receipt：重读后再压缩（避免用旧快照重写丢行）
      lines = await readManualLines()
      byId = foldManualTriples(lines)
    }
    const cutoff = now() - MANUAL_COMPACT_AGE_MS
    const keepLines: ManualOp[] = []
    for (const rec of byId.values()) {
      if (!rec.receipt) {
        // 无 receipt（未处理 / 领取中）一律保留
        if (rec.req) keepLines.push(rec.req)
        if (rec.claim) keepLines.push(rec.claim)
        continue
      }
      const lastAt = Math.max(Number(rec.receipt.at) || 0, Number(rec.claim && rec.claim.at) || 0, Number(rec.req && rec.req.at) || 0)
      if (lastAt >= cutoff && rec.req && rec.claim && rec.receipt) {
        keepLines.push(rec.req, rec.claim, rec.receipt)
      }
    }
    if (keepLines.length !== lines.length) {
      const text = keepLines.map((op) => store.encodeCrcLine(Number(op.at) || now(), op)).join('\n')
      await atomicWriteFile(manualPath(), text + (text ? '\n' : ''))
    }
  }

  /** 供委托执行复用 slot 的辅助（slot 不存在时构造一次性 slot，不进 slots 表） */
  function slotRefFor(dirCfg: SchedulerDirCfg): DirSlot {
    const existing = slots.get(dirCfg.id)
    if (existing) return existing
    return newSlotState(dirCfg.id, dirCfg)
  }

  /**
   * 非 leader 的手动同步：写 req → 轮询等待 receipt。15s 内未见 claim 则核验
   *（receipt 存在 / req 已被压缩 ⇒ 视同已处理，绝不重跑）后兜底本地跑；见到
   * claim 后改等 receipt 或 leader 心跳失联（失联同样先核验再兜底）。
   * 本函数负责全部收尾（settleRound），调用方不再重复 settle。
   * @param op 一次性单向操作（'pull' / 'push' 补齐档 / 'pull-full' / 'push-full'
   *        覆盖档；随 req 穿透到执行方，缺省常规轮）
   */
  async function delegateManual(slot: DirSlot, op?: 'pull' | 'push' | 'pull-full' | 'push-full' | null): Promise<RoundResolveValue> {
    const dirCfg = slot.dir
    const id = randomId()
    await appendManualLine({ kind: 'req', id, from: instanceId, dirId: dirCfg.id, dir: dirCfg, at: now(), ...(op ? { op } : {}) })
    const deadline = now() + MANUAL_CLAIM_TIMEOUT_MS
    let sawClaim: ManualOp | null = null
    let outcome: { ok?: boolean; error?: string | Error | null; summary?: SyncSummary | null } | null = null
    for (;;) {
      if (destroyed) {
        outcome = { ok: false, error: '调度器已销毁' }
        break
      }
      const rec = foldManualTriples(await readManualLines()).get(id) || {}
      if (rec.receipt) {
        outcome = { ok: !!rec.receipt.ok, error: rec.receipt.error || null }
        break
      }
      if (rec.claim) sawClaim = rec.claim
      if (!sawClaim && now() >= deadline) {
        // 核验：receipt 已查（无）；req 整体被压缩 ⇒ 已处理过，绝不重跑
        if (!rec.req) {
          outcome = { ok: true, error: null }
          break
        }
        outcome = await fallbackRun(slot, op)
        break
      }
      if (sawClaim) {
        const lr = await leaderLockRead()
        const claimerAlive = !!lr && leaderAlive(lr) && lr.body && lr.body.instanceId === sawClaim.by
        if (!claimerAlive) {
          const rec2 = foldManualTriples(await readManualLines()).get(id) || {}
          if (rec2.receipt) {
            outcome = { ok: !!rec2.receipt.ok, error: rec2.receipt.error || null }
            break
          }
          outcome = await fallbackRun(slot, op)
          break
        }
      }
      await realSleep(MANUAL_POLL_MS)
    }
    if (!outcome) outcome = { ok: false, error: '未知结果' } // for(;;) 必经 break 赋值；类型收窄用
    settleRound(slot, 'manual', {
      summary: outcome.summary || null,
      error: outcome.error ? (outcome.error instanceof Error ? outcome.error : new Error(outcome.error)) : null,
    })
    return outcome
  }

  // ---------- DirSlot 状态机与全局队列 ----------

  let tickTimer: TimerEntry | null = null

  function startTick(): void {
    if (tickTimer) return
    tickTimer = kit.every(() => tick(), TICK_MS)
  }

  function stopTick(): void {
    if (tickTimer) tickTimer.dispose()
    tickTimer = null
  }

  /**
   * 调度 tick（1s，unref）：按时间戳扫描到期 slot（睡眠唤醒后第一拍自然补跑）。
   * 只有 leader 推进自动轮；interval 到期时从**到期时刻**锚定下一拍（轮长 / 排队
   * 延迟不改变节拍；用户取消保持该预订不变）。
   * 时钟跳变：tick 间隔远超周期（> TICK_MS×CLOCK_JUMP_FACTOR）判定为睡眠唤醒级
   * 跳变（宿主无 powerMonitor 钩子，实测结论）—— 到期任务不立即补跑，统一延迟
   * 5–10s（多目录抖动错峰；唤醒瞬间网络栈 / DNS / 远端常不可用），且跳变后
   * JUMP_GRACE_MS 内的网络类失败不计入退避（见 planNext）。
   */
  function tick(): void {
    if (destroyed || suspended || !ready) return
    if (leaderState !== 'leader' || !ownerRef.valid) return
    const t = now()
    if (lastTickAt > 0 && t - lastTickAt > TICK_MS * CLOCK_JUMP_FACTOR) {
      lastJumpAt = t
      for (const slot of slots.values()) {
        if (slot.state === 'scheduled' && slot.nextDueAt != null && slot.nextDueAt <= t) {
          slot.nextDueAt = t + jitterRange(JUMP_CATCHUP_MIN_MS, JUMP_CATCHUP_MAX_MS)
        }
      }
    }
    lastTickAt = t
    for (const slot of slots.values()) {
      // 新目录首轮：leader 态的 tick 发射（applyConfig 只置标记，见其注释）
      if (slot.startupPending) {
        slot.startupPending = false
        if (dirEligible(slot)) enqueue(slot, 'startup', false)
        continue
      }
      if (slot.state !== 'scheduled') continue
      if (slot.nextDueAt == null || slot.nextDueAt > t) continue
      const dueKind = slot.nextDueKind || 'interval'
      // 闸门区分来源：interval / backoff / follow-up / yield-retry 都是自动调度（受
      // autoSync / 目录启用门控）；watch 到期只有 rerunPending 重排一种来源 —— 它是
      // 「已触发的追赶」（手动 / watch 重叠），不得被 autoSync=false 丢弃（否则等待者
      // 永不唤醒）；目录禁用仍拦下
      if (dueKind === 'watch' ? slot.dir.enabled === false : !dirEligible(slot)) {
        slot.state = 'idle'
        slot.nextDueAt = null
        slot.nextDueKind = null
        continue
      }
      const iv = intervalMsOf(slot)
      if (dueKind === 'interval' && iv > 0) {
        let next = slot.nextDueAt + iv
        while (next <= t) next += iv // 时钟跳变 / 长睡眠后的追赶
        slot.nextDueAt = next
      } else {
        slot.nextDueAt = null
        slot.nextDueKind = null
      }
      enqueue(slot, dueKind, false)
    }
    pumpQueue()
  }

  /**
   * 入队（或对已在队列 / 在跑的目录置 rerunPending —— 一次保存 100 个文件 =
   * 一轮同步 + 轮末一次 +2s 重排，不是 100 次排队）。
   * @param slot 目标 slot（引用；job 携带引用，不按 dirId 反查）
   * @param kind 触发来源；front=true 直插队首（manual / watch：用户可见反馈优先）——
   *        公平上限：队首已等待 ≥ FAIRNESS_STARVE_MS 的元素视为被饿死，插队
   *        只能排到它们之后（interval 任务不会因连续手动 / watch 触发而无限延后）
   * @param resolve 可选的轮完成应答（job 直跑路径经 startRound 应答；rerun 路径
   *        注册为轮末等待者 —— 等到「不再有 rerunPending 的那次轮末」才返回）
   * @param op 一次性单向操作（'pull' / 'push' 补齐档 / 'pull-full' / 'push-full'
   *        覆盖档；仅 op 手动轮携带，随 job 传入轮体）。
   *        注意：目录忙时走 rerunPending 路径会丢弃 op —— 调用方（syncNow）须
   *        先对忙目录拒绝 op 轮，保证此处只在空闲态接收 op
   * @param dryRun 预演轮（「预演一次」入口）：hints.dryRun 注入引擎的零副作用轮；
   *        忙时重排同样无法携带 —— syncNow 已对忙目录拒绝，此处只在空闲态接收
   */
  function enqueue(slot: DirSlot, kind: string, front: boolean, resolve?: (r: RoundResolveValue) => void, op?: 'pull' | 'push' | 'pull-full' | 'push-full' | null, dryRun?: boolean): void {
    if (destroyed || suspended) {
      if (resolve) resolve({ error: '调度器未运行' })
      return
    }
    if (slot.state === 'queued' || slot.state === 'running') {
      slot.rerunPending = true
      emitSlot(slot, true)
      if (resolve) waitRoundEnd(slot, resolve)
      return
    }
    slot.state = 'queued'
    slot.progress = null
    const job = { slot, kind, resolve, enqueuedAt: now(), op: op || null, dryRun: !!dryRun }
    if (front) {
      let idx = 0
      while (idx < queue.length && now() - queue[idx].enqueuedAt >= FAIRNESS_STARVE_MS) idx++
      queue.splice(idx, 0, job)
    } else {
      queue.push(job)
    }
    emitSlot(slot, true)
    pumpQueue()
  }

  /**
   * 立即触发一次（watch 事件 / 手动入口共用；manual/watch 插队首）。
   * 退避期内的 watch 触发不排队不提前 —— 只置 watchHeld 合并成一个到期点
   * （backoff-expiry 轮本就对目录做全量对比同步，吸收该变化）；手动不受退避限制。
   */
  function scheduleNow(dirId: string, kind: 'watch' | 'manual'): void {
    const slot = slots.get(dirId)
    if (!slot) return
    if (kind === 'watch' && slot.backoffUntil > now()) {
      slot.watchHeld = true
      emitSlot(slot, true)
      return
    }
    enqueue(slot, kind, kind === 'manual' || kind === 'watch')
  }

  /**
   * 确保目录存在自动预订（无未来预订时）：退避期内预订到 backoffUntil（kind
   * 'backoff'），否则按 interval 从 now 起算一拍。applyConfig / 挂起恢复 / 轮末
   * 常规排程共用 —— 退避状态在 slot 上持久，重建预订不丢退避语义。
   */
  function ensureIntervalSchedule(slot: DirSlot): void {
    if (!dirEligible(slot)) return
    if (slot.nextDueAt != null && slot.nextDueAt > now()) return
    if (slot.backoffUntil > now()) {
      slot.nextDueAt = slot.backoffUntil
      slot.nextDueKind = 'backoff'
    } else {
      const iv = intervalMsOf(slot)
      if (iv <= 0) return
      slot.nextDueAt = now() + iv
      slot.nextDueKind = 'interval'
    }
    if (slot.state === 'idle') slot.state = 'scheduled'
  }

  /**
   * 全局队列泵（并发：全局上限 maxConcurrentRounds × 每 origin 并发 1）。
   * 顺序扫描队列取第一个「origin 空闲且 slot 仍 queued」的 job 开跑；同 origin 的
   * 后续 job 留队等待（不丢失），失效 job（目录被移除 / slot 已不在 queued 态）
   * 顺带出队收尾。startRound 同步注册 runningJobs 后才让出，泵不会重复开跑同一 job。
   */
  function pumpQueue(): void {
    if (destroyed || suspended) return
    for (;;) {
      if (runningJobs.length >= maxConcurrentRounds()) return
      let picked = -1
      let idx = 0
      while (idx < queue.length) {
        const job = queue[idx]
        if (!slots.has(job.slot.id) && job.kind !== 'manual-delegated') {
          // 配置已移除该目录：丢弃 job（被移除目录的 rerun 等待者也一并收尾）
          queue.splice(idx, 1)
          job.slot.state = 'idle'
          if (job.resolve) job.resolve({ error: '这个同步文件夹已被移除' })
          continue
        }
        if (job.slot.state !== 'queued') {
          queue.splice(idx, 1)
          if (job.resolve) job.resolve({ error: null, skipped: true })
          continue
        }
        if (runningJobs.some((j) => j.origin === originOf(job.slot))) {
          idx++
          continue
        }
        picked = idx
        break
      }
      if (picked < 0) return
      const job = queue.splice(picked, 1)[0]
      void startRound(job.slot, job.kind, job.resolve, job.op, job.dryRun)
    }
  }

  /** 注册一个「该目录下一次轮末（且不再挂 rerun）」等待者 */
  function waitRoundEnd(slot: DirSlot, resolve: (r: RoundResolveValue) => void): void {
    roundWaiters.push({ dirId: slot.id, afterSeq: slot.roundSeq, resolve })
  }

  /**
   * 以错误收场某目录的全部轮末等待者（倒序 splice + try/catch 包 resolve ——
   * 与 becomeLost / suspend / cleanup 的既有冲刷范本同构，resolve 抛错不外传）。
   * 删除目录必须调用本助手：slot 移出 slots 表后，其 rerun 预订永不被 tick 扫到，
   * 等待者若不冲刷将永久悬挂（syncNow 的 Promise 永不 settle）。对在飞轮随后
   * 正常 settle 的场景，提前冲刷不破坏语义 —— 等待者已 splice 出表（settleRound
   * 的唤醒循环找不到它，不重复 resolve），且 Promise 本身只结算一次。
   */
  function failWaitersFor(dirId: string, err: Error): void {
    for (let i = roundWaiters.length - 1; i >= 0; i--) {
      const w = roundWaiters[i]
      if (w.dirId !== dirId) continue
      roundWaiters.splice(i, 1)
      try {
        w.resolve({ error: err })
      } catch (_) {
        /* 忽略 */
      }
    }
  }

  /** 系统通知（挂起冲突提醒）：经宿主端口尽力而为（默认端口内部已吞异常、缺接口 no-op），异常不打断调度 */
  function notifyBestEffort(body: string): void {
    try {
      getHostPorts().notify(body)
    } catch (_) {
      /* 提醒失败无害（自定义端口违约抛错时同样兜底） */
    }
  }

  /**
   * 常规排程落点（退避优先于 interval）：网络类失败且 fails ≥ 阈值 → 退避预订
   * min(interval×2^(fails-1), max(30min, 4×interval))；非网络失败轮不延长不清零
   * 已在退避中的预订；其余按 ensureIntervalSchedule。
   */
  function applyBackoffOrInterval(slot: DirSlot, netFail: boolean): void {
    if (slot.backoffFails >= BACKOFF_THRESHOLD) {
      if (netFail) {
        const iv = intervalMsOf(slot) || 15 * 60000
        const delay = Math.min(iv * Math.pow(2, slot.backoffFails - 1), Math.max(BACKOFF_CAP_MS, 4 * iv))
        slot.backoffUntil = now() + delay
        slot.nextDueAt = slot.backoffUntil
        slot.nextDueKind = 'backoff'
        return
      }
      if (slot.backoffUntil > now()) return // 退避窗内：非网络失败轮不动预订
    }
    slot.backoffUntil = 0
    ensureIntervalSchedule(slot)
  }

  /**
   * 轮末排程策略（settleRound 的决策部分；只处理「真正跑过」的轮）：
   *   取消 → 保持原预订不动；让出 → 不计失败不清退避，15–45s 抖动
   *   重排（连续 5 次按 interval 收敛）；开放意图（openIntents>0 且非熔断）→
   *   30–60s 抖动 follow-up，**优先于跨轮退避**（本机有未完成工作要尽快收敛；防打爆
   *   由无进展回落保证 —— 连续 5 次 openIntents 未下降回落常规排程）；网络类失败
   *   （network/mixed/熔断）→ 计数 ≥2 起按指数退避（跳变宽限期内不计数）；成功 →
   *   清零全部计数按 interval。'other' 失败不计数也不清零（只按 interval 重排）。
   * mixed 计入退避的取舍：mixed 含网络类成分，服务器可能整体不可达，保守计入。
   */
  function planNext(slot: DirSlot, o: RoundOutcome): void {
    if (o.skipped || o.concurrent || o.cancelled || o.dryRun) {
      // 未真正执行（锁竞争让路 / 引擎被其他入口占用 / 用户取消 / 预演轮）：
      // 不动任何计数 —— 预演没有改变任何文件，排程语义与轮前完全一致
      ensureIntervalSchedule(slot)
      return
    }
    const sum = o.summary
    const openIntents = sum ? Number(sum.openIntents) || 0 : 0
    const breakerOpen = !!(sum && sum.breaker && sum.breaker.open)
    const yielded = !!(sum && sum.yielded)
    const netFail = breakerOpen || (sum ? sum.failureClass === 'network' || sum.failureClass === 'mixed' : false)
    const jumpGrace = lastJumpAt > 0 && now() - lastJumpAt < JUMP_GRACE_MS

    if (yielded) {
      slot.yieldStreak = (slot.yieldStreak || 0) + 1
      if (slot.yieldStreak >= YIELD_CONSECUTIVE_MAX) {
        slot.yieldStreak = 0
        // 收敛：撤销残留的 yield-retry 预订（否则未来预订被保留、kind 不回 interval）
        if (slot.nextDueKind === 'yield-retry') {
          slot.nextDueAt = null
          slot.nextDueKind = null
        }
        ensureIntervalSchedule(slot)
      } else {
        slot.nextDueAt = now() + jitterRange(YIELD_RETRY_MIN_MS, YIELD_RETRY_MAX_MS)
        slot.nextDueKind = 'yield-retry'
      }
      return
    }
    slot.yieldStreak = 0

    const succeeded = !o.error && !!sum && !(sum.errors && sum.errors.length) && !breakerOpen
    if (succeeded) {
      // 成功（含「部分完成，有 N 个待处理冲突」的 defer 轮 —— errors 为空即服务器可达）
      // 清退避；follow-up 的无进展计数不在此清零 —— defer 轮开放意图仍在（未收敛），
      // 清零会让 noProgress 在冲突挂起环里震荡、永不触发回落（清零只由 openIntents===0 路径负责）
      slot.backoffFails = 0
      slot.backoffUntil = 0
      if (slot.nextDueKind === 'backoff') {
        slot.nextDueAt = null
        slot.nextDueKind = null
      }
    } else if (netFail && !jumpGrace) {
      slot.backoffFails = (slot.backoffFails || 0) + 1
    }

    if (openIntents > 0 && !breakerOpen) {
      if (slot.followCount > 0) {
        if (openIntents >= slot.followLastOpen) slot.followNoProgress = (slot.followNoProgress || 0) + 1
        else slot.followNoProgress = 0
      }
      if (slot.followNoProgress >= FOLLOWUP_NO_PROGRESS_MAX) {
        slot.followCount = 0
        slot.followNoProgress = 0
        slot.followLastOpen = 0
        applyBackoffOrInterval(slot, netFail) // 回落常规排程（可能直接进退避）
        return
      }
      slot.followCount++
      slot.followLastOpen = openIntents
      slot.nextDueAt = now() + jitterRange(FOLLOWUP_MIN_MS, FOLLOWUP_MAX_MS)
      slot.nextDueKind = 'follow-up'
      return
    }
    if (openIntents === 0) {
      slot.followCount = 0
      slot.followNoProgress = 0
      slot.followLastOpen = 0
    }
    applyBackoffOrInterval(slot, netFail)
  }

  /**
   * 轮末统一收尾：settle slot、外发 round-end、排程策略（planNext）、唤醒等待者、
   * 泵队列。skipped=true 的轮（leader 失位 / 自动轮锁竞争让路）不发 round-end ——
   * 没有真正跑过，渲染层状态不该被打扰。
   */
  function settleRound(slot: DirSlot, kind: string, outcome: RoundOutcome): void {
    const { summary = null, error = null, cancelled = false, skipped = false, concurrent = false, dryRun = false } = outcome || {}
    const hadRerun = slot.rerunPending
    slot.state = 'idle'
    slot.progress = null
    slot.cancelRequested = false
    // 本轮流量袋随轮释放（采样器对非 running slot 不再采样，基线表同步收敛）
    slot.traffic = null
    // 真实轮对目录做了全量对比同步，退避期合并的 watch 变化已被吸收；skipped /
    // concurrent / 预演轮没有真正同步，保留 watchHeld 待下一轮吸收
    if (!skipped && !concurrent && !dryRun) slot.watchHeld = false
    // 预演轮不发 round-end、不触发挂起提醒与注册表对账（零打扰 —— 渲染层行状态机、
    // 待处理面板、系统通知通道都不被「预演一次」惊动；结果经 syncNow 返回值送达）
    if (!skipped && !dryRun) {
      slot.lastRound = {
        endedAt: now(),
        summary: summary || null,
        error: error ? error.message || String(error) : null,
      }
      emit({
        type: 'round-end',
        dirId: slot.id,
        summary: summary || (error && error.summary) || null,
        error: error ? error.message || String(error) : null,
        cancelled,
      })
      // 插件注册表对账（实验功能「无感同步」的第二段）：实体与 manifest 本轮已
      // 落盘，此刻把 manifest 合并进宿主注册表 / 重写导出 —— 未授权或旧宿主时
      // 内部降级为 no-op（ztools-registry.mts）。取消轮跳过（半截状态等下一轮）；
      // fire-and-forget 且模块内串行化，任何异常只进结果状态不影响轮次收尾
      if (slot.id === ZTOOLS_PLUGINS_DIR_ID && !cancelled) {
        void reconcilePluginRegistry(slot.dir.localPath).catch(() => {})
      }
      // 挂起事件（UI 面板入口）+ 系统通知（同批只提醒一次：指纹 = 无 choice 的
      // 逐条类挂起 rel 排序集 + 未决策删除总数；处理后再出现新集合才再提醒）。
      // 触发条件覆盖冲突挂起（deferredConflicts）、删除确认挂起（deleteHeld ——
      // 批量删除超阈值整批转入待处理面板；计数取 summary 真值而非逐条列表 ——
      // 逐文件挂起表有 500 条上限，超限部分没有逐条记录，只有 summary 计数与
      // 批量快照）与远端根丢失待决策（rootLostHeld —— 目录级决策，kind='root-lost'
      // 挂起），通知文案按三类分别计数
      const deleteHeldCount = summary ? Number(summary.deleteHeld) || 0 : 0
      const rootLostCount = summary ? Number(summary.rootLostHeld) || 0 : 0
      if (summary && (Number(summary.deferredConflicts) > 0 || deleteHeldCount > 0 || rootLostCount > 0) && typeof engine.listPendingConflicts === 'function') {
        engine
          .listPendingConflicts(slot.dir)
          .then((items) => {
            // 逐条类 = 冲突 + 根丢失（删除确认类走 deleteHeld 真值口径，不进逐条集合）
            const openItems = (items || []).filter((it) => it && !it.choice && it.kind !== 'delete')
            const openRels = openItems.map((it) => it.rel).sort()
            const fp = `${openRels.join('|')}#${deleteHeldCount}`
            let newlyNotified = false
            if ((openRels.length || deleteHeldCount > 0) && fp !== slot.lastNotifyFp) {
              slot.lastNotifyFp = fp
              newlyNotified = true
            } else if (!openRels.length && !deleteHeldCount) {
              slot.lastNotifyFp = null
            }
            // 事件先于系统通知发出：渲染层的挂起列表（处理入口的数据源）是关键
            // 路径，通知只是尽力而为的增强 —— 任何后续异常都不能再影响事件送达
            emit({ type: 'pending-conflicts', dirId: slot.id, items: items || [], newlyNotified })
            if (newlyNotified) {
              const nRootLost = openItems.filter((it) => it.kind === 'root-lost').length
              const nConflict = openItems.filter((it) => it.kind !== 'root-lost').length
              const parts: any[] = []
              if (nRootLost > 0) parts.push('云端的同步文件夹不见了，需要你确认怎么处理')
              if (nConflict > 0) parts.push(`${nConflict} 个文件需要你选择保留哪一个`)
              if (deleteHeldCount > 0) parts.push(`${deleteHeldCount} 项删除等你确认`)
              notifyBestEffort(`WebDAV 同步：${parts.join('、')}，点击打开插件处理`)
            }
          })
          .catch(() => {})
      }
    }
    planNext(slot, { summary, error, cancelled, skipped, concurrent, dryRun })
    // rerunPending → +2s 重排一次（watch 语义合并）
    if (slot.rerunPending) {
      slot.rerunPending = false
      slot.state = 'scheduled'
      slot.nextDueAt = now() + RERUN_DELAY_MS
      slot.nextDueKind = 'watch'
    }
    // 状态一致性：有未来预订的 idle 必须回到 scheduled（tick 只扫 scheduled）
    if (slot.state === 'idle' && slot.nextDueAt != null) slot.state = 'scheduled'
    emitSlot(slot, true)
    // 唤醒等待者：本轮结束且不再挂 rerun 才算「等到」（手动重叠场景等的是 rerun 轮）
    slot.roundSeq++
    if (!hadRerun) {
      for (let i = roundWaiters.length - 1; i >= 0; i--) {
        const w = roundWaiters[i]
        if (w.dirId === slot.id && w.afterSeq < slot.roundSeq) {
          roundWaiters.splice(i, 1)
          w.resolve({ summary: summary || (error && error.summary) || null, error })
        }
      }
    }
  }

  /**
   * 执行一轮（队列 worker，全局并发 1）。
   * leadership 语义：
   *   自动轮（interval/watch/startup）——仅在 leader 态进入，轮首重读 leader.lock
   *     确认（不沿用入队时的判断）；失位 → 跳过（skipped，不发 round-end）；
   *   manual ——执行前重新判定身份（leader→非 leader 切换的瞬间不沿用发起时的
   *     判断）：仍为 leader 则本机直跑（冲突可转发本机渲染层），否则转委托；
   *   manual-delegated ——leader 代其他实例跑（冲突一律 defer）。
   * 目录锁：所有轮（自动 / 手动 / 委托代跑）都持同一目录锁，与兜底路径互斥。
   * @param op 一次性单向操作（'pull' / 'push' 补齐档 / 'pull-full' / 'push-full'
   *        覆盖档；仅 op 手动 / 委托轮携带，经引擎 hints.op 生效；自动轮恒缺省）
   * @param dryRun 预演轮：hints.dryRun 注入引擎的零副作用轮（结果不做任何排程
   *        影响、不发 round-end —— 渲染层行状态机与通知通道都不被预演打扰）
   */
  async function startRound(slot: DirSlot, kind: string, resolve?: (r: RoundResolveValue) => void, op?: 'pull' | 'push' | 'pull-full' | 'push-full' | null, dryRun?: boolean): Promise<void> {
    const jobRec = { slot, kind, origin: originOf(slot) }
    runningJobs.push(jobRec) // 同步注册：泵在首个 await 前即可见到本 job 占用的 origin
    try {
      if ((AUTO_KINDS as readonly string[]).includes(kind)) {
        if (leaderState !== 'leader' || !ownerRef.valid || !(await leaderLockIsMine())) {
          if (leaderState === 'leader') becomeLost('轮首复核：锁不归属本实例')
          settleRound(slot, kind, { skipped: true })
          if (resolve) resolve({ error: null, skipped: true })
          return
        }
      }
      slot.state = 'running'
      slot.progress = null
      emitSlot(slot, true)
      // manual 身份重判（执行前，不沿用发起时判断）。预演轮非 leader 也不委托
      //（不转发冲突、零远端写，本地跑与 leader 跑语义一致）
      if (kind === 'manual' && !(leaderState === 'leader' && ownerRef.valid && (await leaderLockIsMine()))) {
        const r = dryRun ? await runDryRoundLocal(slot) : await delegateManual(slot, op) // 内部已 settleRound
        if (resolve) resolve(r)
        return
      }
      const outcome = await executeRound(slot, kind, op, dryRun)
      if (dryRun) (outcome as any).dryRun = true
      settleRound(slot, kind, outcome)
      if (resolve) resolve(outcome)
    } catch (e: any) {
      settleRound(slot, kind, { error: e, ...(dryRun ? { dryRun: true } : {}) })
      if (resolve) resolve({ error: e })
    } finally {
      const i = runningJobs.indexOf(jobRec)
      if (i >= 0) runningJobs.splice(i, 1)
      pumpQueue()
    }
  }

  /**
   * 轮体：取目录锁 → 引擎 syncDirectory → 结果分类。锁等待期间可被取消 /
   * leader 丢失打断；自动轮锁等待超时不报错，+2s 重排（watch 语义）；手动 /
   * 委托轮超时报错。所有 executeRound 轮都在 leader 身份下执行，ownerRef 失效
   * 即中止（在途轮在文件边界以取消语义收场）。
   * @param op 一次性单向操作（'pull' / 'push' 补齐档 / 'pull-full' / 'push-full'
   *        覆盖档；经引擎 hints.op 注入本轮规划）
   * @param dryRun 预演轮：hints.dryRun 注入引擎（source 一并改为 'dry-run'，
   *        同步记录落预演触发；脏路径快照不携带 —— 预演恒全量扫描）
   */
  async function executeRound(slot: DirSlot, kind: string, op?: 'pull' | 'push' | 'pull-full' | 'push-full' | null, dryRun?: boolean): Promise<RoundOutcome> {
    const isAuto = (AUTO_KINDS as readonly string[]).includes(kind)
    const h = await dirLockHashFor(slot)
    // 进度发射器提前到锁等待之前：等待目录锁（他机 / 他实例正在同步该目录）期间
    // 发 lockwait 细分阶段 —— UI 显示「正在等待其他设备完成同步…」而不是无进度的空转
    const progressAt = makeProgressEmitter(slot)
    const acq = await acquireDirLockWaiting(h, {
      slot,
      maxWaitMs: isAuto ? DIR_LOCK_AUTO_MAX_WAIT_MS : DIR_LOCK_MANUAL_MAX_WAIT_MS,
      cancelOn: () => slot.cancelRequested || !ownerRef.valid,
      cancelOnReason: slot.cancelRequested ? '已取消' : 'leader 丢失',
      onPoll: () => progressAt({ phase: 'scan', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, stage: 'lockwait' }),
    })
    if (!acq.ok) {
      if (isAuto) {
        // 自动轮不因锁竞争报错：+2s 重排（settleRound 依 nextDueAt 保持 scheduled 态）
        slot.nextDueAt = now() + RERUN_DELAY_MS
        slot.nextDueKind = 'watch'
        return { skipped: true }
      }
      if (acq.reason === '已取消' || acq.reason === 'leader 丢失') {
        return { error: new Error('已取消同步'), cancelled: true }
      }
      // 手动轮锁等待超时：一句人话 + 技术原因放 detail
      const lockTimeout: any = new Error('另一台设备正在同步这个文件夹，等待超时，稍后会重试')
      lockTimeout.detail = acq.reason
      return { error: lockTimeout }
    }
    try {
      // 轮次提示（引擎本地扫描形态的输入）：source = 轮次 kind。只有 watch 轮携带
      // 脏路径快照 —— 触发即来自已注册的 watcher，peek 时机在轮体之前，轮期间新到
      // 的事件留在集合里给下一轮；interval / startup / manual / follow-up 轮是
      // 「周期性全量对账」的组成部分（watch 事件不保证完整，正确性恰靠这些全量轮
      // 兜底），一律不带 dirtyPaths。watcherKey 把注册 id 告知引擎，供其在本地扫描
      // 成功后清理脏集（消费语义见引擎侧 clearDirtyPaths）。
      const wrec = watcherRegs.get(slot.id)
      let dirty: string[] | null = null
      if (kind === 'watch' && wrec && typeof engine.peekDirtyPaths === 'function') {
        try {
          dirty = engine.peekDirtyPaths(wrec.watcherId)
        } catch (_) {
          dirty = null // 引擎侧异常按「无提示」处理（回落全量扫描，语义安全）
        }
      }
      // cfgOf / prefsOf 展开服务器条目与 overrides（Record<string, unknown> 键取值静态
      // 类型为 unknown），结构是 EngineCfg / EnginePrefs 的运行时形态但静态类型无法
      // 证明 —— 调用侧断言收窄，不改这两个函数。slot.dir（SchedulerDirCfg）只缺
      // DirCfg 的索引签名（接口不带隐式索引，连 as 的重叠判定也过不了），与 cfgOf
      // 同因经 unknown 双重断言
      // 本轮流量袋装配 + 采样器就位（见 attachRoundTraffic 注释）；settleRound 轮末清空
      const roundCfg = cfgOf(slot) as unknown as EngineCfg
      attachRoundTraffic(slot, roundCfg)
      const summary = await engine.syncDirectory(roundCfg, slot.dir as unknown as DirCfg, prefsOf(slot) as EnginePrefs, {
        onProgress: progressAt,
        shouldAbort: () => slot.cancelRequested || !ownerRef.valid,
        // 预演轮不转发冲突（引擎侧不询问），回调仅为防御性兜底
        onConflict: !dryRun && kind === 'manual' && rendererOnline ? (info: ConflictInfo) => forwardConflict(slot, info) : () => 'defer',
        hints: {
          source: dryRun ? 'dry-run' : kind,
          dirtyPaths: dryRun ? undefined : dirty || undefined,
          watcherKey: dryRun ? undefined : wrec ? wrec.watcherId : undefined,
          op: dryRun ? undefined : op || undefined,
          dryRun: dryRun || undefined,
        },
      })
      // concurrent:true（引擎 ROUND_IN_FLIGHT 被其他入口占用，如测试直调引擎）：
      // 不得丢触发 —— 置 rerunPending（settleRound 轮末 +2s 重排一次）
      if (summary && summary.concurrent) {
        slot.rerunPending = true
        return { summary, concurrent: true }
      }
      return { summary }
    } catch (e: any) {
      const cancelled = !!(slot.cancelRequested || !ownerRef.valid || (e && e.code === 'ABORTED'))
      return { summary: e && e.summary ? e.summary : null, error: e, cancelled }
    } finally {
      await releaseDirLock(h)
    }
  }

  /** 进度发射器（≤4Hz 节流；终态由 settleRound 强制外发） */
  function makeProgressEmitter(slot: DirSlot): (p: SyncProgress) => void {
    let last = 0
    return (p) => {
      slot.progress = p
      const t = now()
      if (t - last >= PROGRESS_MIN_INTERVAL_MS) {
        last = t
        emitSlot(slot)
      }
    }
  }

  // ---------- 实时速率采样（net-speed 事件） ----------
  //
  // 进度事件按「文件完成」节流外发，单个大文件传输期间数秒无事件 —— 速率不能
  // 从进度事件折算。网络层在字节流上累计全局流量（netTraffic）与每轮流量袋
  // （cfg.__wdsyncTraffic），本采样器按 1s 周期做差分 → EMA 平滑 → net-speed
  // 事件外发，与进度事件通道完全解耦（大文件传输中速率照常跳动）。

  /** 速率采样周期（ms）：1s 粒度对「实时」足够，事件量可忽略 */
  const NET_SPEED_SAMPLE_MS = 1000
  /** 速率 EMA 平滑系数：瞬时值权重（1s 采样下 0.5 ≈ 2s 时间常数，抖动与响应性平衡） */
  const NET_SPEED_EMA = 0.5
  /** 速率归零下限（字节/秒）：低于视为 0 —— 传输收尾的 EMA 衰减尾不再显示假速度 */
  const NET_SPEED_FLOOR_BPS = 512
  /** 连续无流量的采样拍数：达到即硬归零（EMA 减半衰减太慢，收尾后假速度会拖 10 秒以上） */
  const NET_SPEED_ZERO_TICKS = 2

  /** 单方向差分基线 + 平滑值 */
  interface SpeedChan {
    /** 上次采样的累计字节数（差分基线） */
    last: number
    /** EMA 平滑后的速率（字节/秒） */
    bps: number
    /** 连续「本拍零流量」计数（达到 NET_SPEED_ZERO_TICKS 硬归零） */
    zeros: number
  }

  /** 一路采样（全局 / 每目录同形）：两方向 + 采样时刻 */
  interface SpeedSample {
    up: SpeedChan
    down: SpeedChan
    at: number
  }

  /** 采样器运行态：全局一路 + 每运行中目录一路；timer 为 null = 采样器停止 */
  const speedState = {
    global: { up: { last: 0, bps: 0, zeros: 0 }, down: { last: 0, bps: 0, zeros: 0 }, at: 0 } as SpeedSample,
    perDir: new Map<string, SpeedSample>(),
    timer: null as TimerEntry | null,
    /** 上一次采样是否外发过非零速率（归零沿只补发一次全零事件） */
    active: false,
  }

  /** 单方向推进：差分 → 瞬时速率 → EMA 平滑；低于下限或连续零流量拍硬归零 */
  function speedStep(c: SpeedChan, totalBytes: number, dtSec: number): void {
    const inst = Math.max(0, totalBytes - c.last) / dtSec
    c.last = totalBytes
    if (inst > 0) {
      c.zeros = 0
      c.bps = c.bps * (1 - NET_SPEED_EMA) + inst * NET_SPEED_EMA
      // 锁文件等小体积请求的瞬时速率没有展示意义：低于下限直接按 0
      if (c.bps < NET_SPEED_FLOOR_BPS) c.bps = 0
    } else if (++c.zeros >= NET_SPEED_ZERO_TICKS || c.bps < NET_SPEED_FLOOR_BPS) {
      c.bps = 0
    } else {
      c.bps *= 1 - NET_SPEED_EMA
    }
  }

  /** 新建一路采样：差分基线取当前累计值（历史流量不计入首拍突发） */
  function speedSampleOf(totalUp: number, totalDown: number, t: number): SpeedSample {
    return { up: { last: totalUp, bps: 0, zeros: 0 }, down: { last: totalDown, bps: 0, zeros: 0 }, at: t }
  }

  /**
   * 轮体装配（executeRound / fallbackRun 共用）：把本轮流量袋挂到 cfg 与 slot
   *（同一对象引用，网络层随字节流累加）、启动采样器，并以零基线种下该目录的
   * 采样路 —— 基线为 0 使首拍差分即覆盖「自轮首起的全部流量」，慢轮快轮都不漏。
   */
  function attachRoundTraffic(slot: DirSlot, cfg: EngineCfg): void {
    cfg.__wdsyncTraffic = { upBytes: 0, downBytes: 0 }
    slot.traffic = cfg.__wdsyncTraffic
    ensureSpeedSampler()
    speedState.perDir.set(slot.id, speedSampleOf(0, 0, now()))
  }

  /** 启动 1s 采样器（幂等）：差分基线取当前累计值，历史流量不造成首拍假突发 */
  function ensureSpeedSampler(): void {
    if (speedState.timer) return
    speedState.global = speedSampleOf(netTraffic.upBytes, netTraffic.downBytes, now())
    speedState.perDir.clear()
    speedState.timer = kit.every(() => speedTick(), NET_SPEED_SAMPLE_MS)
  }

  /** 停止采样器并清空每目录基线（归零沿 / 全部轮次结束后调用） */
  function stopSpeedSampler(): void {
    if (speedState.timer) {
      speedState.timer.dispose()
      speedState.timer = null
    }
    speedState.perDir.clear()
    speedState.active = false
  }

  /** 采样一拍：全局与运行中目录各做差分，非零则外发 net-speed；空闲且无在飞轮则停表 */
  function speedTick(): void {
    const st = speedState
    const t = now()
    const dt = Math.max(0.2, (t - st.global.at) / 1000)
    speedStep(st.global.up, netTraffic.upBytes, dt)
    speedStep(st.global.down, netTraffic.downBytes, dt)
    st.global.at = t
    // 每目录只对「运行中且挂了流量袋」的 slot 采样；基线表收敛到当前运行集合
    const running = new Set<string>()
    for (const slot of slots.values()) {
      if (slot.state !== 'running' || !slot.traffic) continue
      running.add(slot.id)
      let s = st.perDir.get(slot.id)
      if (!s) {
        s = speedSampleOf(slot.traffic.upBytes, slot.traffic.downBytes, t)
        st.perDir.set(slot.id, s)
      }
      speedStep(s.up, slot.traffic.upBytes, dt)
      speedStep(s.down, slot.traffic.downBytes, dt)
      s.at = t
    }
    for (const id of Array.from(st.perDir.keys())) {
      if (!running.has(id)) st.perDir.delete(id)
    }
    const dirs: Record<string, { upBps: number; downBps: number }> = {}
    for (const [id, s] of st.perDir) {
      if (s.up.bps > 0 || s.down.bps > 0) dirs[id] = { upBps: Math.round(s.up.bps), downBps: Math.round(s.down.bps) }
    }
    const gActive = st.global.up.bps > 0 || st.global.down.bps > 0
    if (gActive) {
      st.active = true
      emit({ type: 'net-speed', upBps: Math.round(st.global.up.bps), downBps: Math.round(st.global.down.bps), dirs })
    } else if (st.active) {
      // 归零沿：补发一次全零（渲染层随即隐藏速率显示）
      st.active = false
      emit({ type: 'net-speed', upBps: 0, downBps: 0, dirs: {} })
    }
    // 停表条件：无在飞轮且速率已归零（EMA 衰减尾走完）—— 在飞轮存在时保持运转，
    // 文件间隙（传输下一文件前的规划 / 校验）不算空闲
    if (!running.size && !gActive) stopSpeedSampler()
  }

  /**
   * 手动轮的冲突转发：本机渲染层订阅在线时把冲突交给渲染层弹窗，等待用户经
   * resolveConflict 应答（引擎询问串行化，同一时刻至多一个在等）。
   *
   * TTL 兜底（真实时钟）：转发后渲染层消失（崩溃 / 关闭且 cleanup 不被调用 ——
   * 设计假设，见文件头多实例模型）时永无应答，引擎询问与目录锁将悬挂到进程退出；
   * 超时按「渲染层未回应」以 'defer' 结算 —— 与无处理器路径（onConflict 恒返回
   * 'defer'）同一返回值，语义 = 挂到待处理中心、两侧保持原样，用户稍后决定，
   * 安全侧不丢数据。定时器走 node:timers 真实通道（轮体 IO 语义，与 realSleep
   * 同款 —— 假时钟冻结的测试里也要能到期，防挂死），句柄经 makeTimer 登记；
   * 渲染层应答 / TTL 到期 / cleanup 冲刷任一先结算即清定时器与等待表条目，
   * 不留泄漏（Promise 只结算一次，晚到的重复 settle 无害）。
   */
  function forwardConflict(slot: DirSlot, info: ConflictInfo): Promise<ConflictChoice> {
    return new Promise((resolve) => {
      const conflictId = randomId()
      const box: { entry: TimerEntry | null } = { entry: null }
      let settled = false
      const settle = (choice: ConflictChoice) => {
        if (settled) return
        settled = true
        if (box.entry) box.entry.dispose()
        if (conflictResolvers.get(conflictId) === settle) conflictResolvers.delete(conflictId)
        resolve(choice)
      }
      conflictResolvers.set(conflictId, settle)
      // 先武装 TTL 再发事件：同步订阅者若在 emit 内即刻应答，settle 才来得及清掉刚武装的句柄
      const handle = nodeTimers.setTimeout(() => settle('defer'), CONFLICT_FORWARD_TTL_MS)
      if (handle && typeof handle === 'object' && typeof handle.unref === 'function') handle.unref()
      box.entry = makeTimer(() => nodeTimers.clearTimeout(handle as NodeJS.Timeout))
      emit({ type: 'conflict', conflictId, dirId: slot.id, info })
    })
  }

  /**
   * 兜底本地跑（非 leader 手动 / 委托超时 / 领取者失联）：先核验（调用方已做），
   * 再取目录锁本地执行；冲突一律 defer。不占全局队列槽位（委托方直等结果），
   * 与 leader 轮的互斥由目录锁保证。返回结果，**不**做 settleRound（由调用方
   * delegateManual 统一收尾）。
   * @param op 一次性单向操作（'pull' / 'push' 补齐档 / 'pull-full' / 'push-full'
   *        覆盖档；经引擎 hints.op 注入本轮规划）
   * @param dryRun 预演轮（本地直跑形态；冲突一律 defer 的既有语义对预演无意义 ——
   *        引擎预演不询问）
   */
  async function fallbackRun(slot: DirSlot, op?: 'pull' | 'push' | 'pull-full' | 'push-full' | null, dryRun?: boolean): Promise<RoundResolveValue> {
    const h = await dirLockHashFor(slot)
    // 锁等待期间发 lockwait 进度（与 executeRound 同口径；节流由发射器承担）
    const progressAt = makeProgressEmitter(slot)
    const acq = await acquireDirLockWaiting(h, {
      slot,
      maxWaitMs: DIR_LOCK_MANUAL_MAX_WAIT_MS,
      cancelOn: () => slot.cancelRequested,
      cancelOnReason: '已取消',
      onPoll: () => progressAt({ phase: 'scan', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, stage: 'lockwait' }),
    })
    if (!acq.ok) {
      const lockFail: any = new Error('暂时无法开始同步，稍后会重试')
      lockFail.detail = acq.reason
      return { ok: false, error: lockFail }
    }
    slot.state = 'running'
    emitSlot(slot, true)
    try {
      // 同 executeRound：cfgOf / prefsOf / slot.dir 的静态形态与引擎形参不吻合
      //（运行时同形），调用侧断言收窄（注释见 executeRound 调用点）
      // 本轮流量袋装配：与 executeRound 同款（attachRoundTraffic，轮末清空）
      const roundCfg = cfgOf(slot) as unknown as EngineCfg
      attachRoundTraffic(slot, roundCfg)
      const summary = await engine.syncDirectory(roundCfg, slot.dir as unknown as DirCfg, prefsOf(slot) as EnginePrefs, {
        onProgress: progressAt,
        shouldAbort: () => slot.cancelRequested,
        onConflict: () => 'defer',
        hints: {
          source: dryRun ? 'dry-run' : 'manual',
          op: dryRun ? undefined : op || undefined,
          dryRun: dryRun || undefined,
        },
      })
      if (summary && summary.concurrent) {
        // 兜底路径撞上本进程内其他入口的在飞轮（如测试直调引擎）：不丢触发，
        // 交由对方轮末的既有排程收敛
        return { ok: true, summary, concurrent: true }
      }
      return { ok: true, summary }
    } catch (e: any) {
      return { ok: false, error: e && e.message ? e.message : String(e), summary: e && e.summary }
    } finally {
      await releaseDirLock(h)
    }
  }

  /**
   * 预演轮的本地直跑（非 leader 也不委托 —— 预演不转发冲突、零远端写，本地跑
   * 与 leader 跑语义一致）：fallbackRun 拿目录锁执行后按 settleRound 收尾
   *（slot 状态 / 等待者唤醒与普通轮同一管线；round-end 与排程影响被 dryRun 抑制）。
   */
  async function runDryRoundLocal(slot: DirSlot): Promise<RoundResolveValue> {
    const r = await fallbackRun(slot, null, true)
    settleRound(slot, 'manual', {
      summary: r.summary || null,
      error: r.error == null ? null : r.error instanceof Error ? r.error : new Error(String(r.error)),
      dryRun: true,
    })
    return r
  }

  // ---------- watcher（仅 leader 注册；触发即插队） ----------

  function stopWatcherFor(dirId: string): void {
    const rec = watcherRegs.get(dirId)
    if (!rec) return
    try {
      engine.stopWatch(rec.watcherId)
    } catch (_) {
      /* 引擎侧不存在的 id 是无害 no-op */
    }
    watcherRegs.delete(dirId)
  }

  function stopAllWatchers(): void {
    for (const dirId of Array.from(watcherRegs.keys())) stopWatcherFor(dirId)
  }

  /**
   * 重挂 watcher：仅 leader、服务器已配置、目录启用且生效自动同步开（目录级覆盖
   * 可单独关掉某目录的自动同步 —— watcher 是自动触发，一并停挂）时注册；引擎侧
   * 已有 1.5s 去抖，这里的事件只做「插队触发」。非 leader 实例不注册（自动触发
   * 无执行权，避免多实例重复监听 / 重复请求）。
   */
  function rebuildWatchers(): void {
    const wantIds = new Set<string>()
    if (leaderState === 'leader' && !destroyed && !suspended && serverConfigured()) {
      for (const slot of slots.values()) if (dirEligible(slot)) wantIds.add(slot.id)
    }
    for (const dirId of Array.from(watcherRegs.keys())) if (!wantIds.has(dirId)) stopWatcherFor(dirId)
    if (!wantIds.size) return
    for (const dirId of wantIds) {
      const slot = slots.get(dirId)
      if (!slot) continue
      const rec = watcherRegs.get(dirId)
      if (rec) {
        if (rec.localPath === slot.dir.localPath) continue
        stopWatcherFor(dirId)
      }
      const watcherId = `${instanceId}:${dirId}`
      let ok = false
      try {
        ok = engine.watchDir(watcherId, slot.dir.localPath, () => onWatchFire(dirId))
      } catch (_) {
        ok = false
      }
      if (ok) watcherRegs.set(dirId, { watcherId, localPath: slot.dir.localPath })
    }
  }

  function onWatchFire(dirId: string): void {
    if (destroyed || suspended || leaderState !== 'leader' || !ownerRef.valid) return
    scheduleNow(dirId, 'watch')
  }

  // ---------- 对外门面 ----------

  const facade: SchedulerFacade = {
    /** 实例 id（leader 锁令牌；测试观测用） */
    instanceId,

    /**
     * 渲染层握手（幂等）：标记渲染层在线（冲突转发的前提），并（重新）读取配置
     * （渲染层 init 前可能已 persist 过新配置）。返回全量快照（冷启动先拉快照再订阅）。
     */
    async init() {
      rendererOnline = true
      if (destroyed) return facade.getSnapshot()
      const r = await refreshConfig({ initial: !everLoaded })
      if (r && r.error) {
        notReadyReason = r.error
        emitError(notReadyReason, 'init')
      }
      return facade.getSnapshot()
    },

    /** 订阅事件（单一 listener 多路分发）；返回退订函数 */
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },

    /** 全量快照：{ ready, notReadyReason?, configV, leader, suspended, slots } */
    getSnapshot() {
      return {
        ready,
        ...(notReadyReason ? { notReadyReason } : {}),
        configV,
        leader: { isLeader: leaderState === 'leader' && ownerRef.valid, state: leaderState, instanceId },
        suspended,
        slots: Array.from(slots.values(), slotView),
      }
    },

    /**
     * 轮末展示摘要（纯函数，渲染层 round-end 复用；测试直检）。
     * 熔断轮归因为「服务器连续无响应」+ 最后失败摘要（breaker.reason）；完全相同的
     * 错误消息折叠为一条（带次数）——「无法列举远端目录（CIRCUIT_OPEN）」类同文
     * 噪声不再逐条刷屏；挂起冲突轮收尾为「部分完成，有 N 个待处理冲突」。
     */
    summarizeRound,

    /**
     * 手动同步（渲染层「立即同步」入口）。
     * 未就绪时抛出明确错误（不静默忽略）。leader 本机直跑（排队队首等待轮完成）；
     * 非 leader 走委托（manual-requests），超时核验后兜底本地跑。
     * @param dirId 省略 = 同步全部启用目录
     * @param opts.op 一次单向操作（'pull' = 「云端补齐本地」/ 'pull-full' =
     *        「云端覆盖本地」/ 'push' = 「本地补齐云端」/ 'push-full' = 「本地
     *        覆盖云端」，经引擎 hints.op 注入本轮规划：补齐档恢复本端缺失、保留
     *        本端多出与改动；覆盖档以选定侧为准镜像对侧 —— 缺失恢复 / 不一致
     *        覆盖 / 多余删除）。目录忙（queued/running）时明确拒绝 —— 忙时的
     *        rerun 重排轮无法携带 op，放行会退化成常规轮，违背按钮语义
     * @param opts.dryRun 预演（「预演一次」入口）：零副作用轮，引擎 hints.dryRun
     *        生效 —— 返回 summary 带 dryRun 标记（计划值），同步记录落 trigger
     *        'dry-run'；不触发排程影响 / round-end / 通知；忙时同样拒绝；非 leader
     *        不委托（本地直跑，预演无冲突转发语义）
     */
    async syncNow(dirId, opts) {
      if (!ready) {
        const notReady: any = new Error('自动同步还没准备好，请稍候')
        notReady.detail = notReadyReason || '配置未加载'
        throw notReady
      }
      if (!config || !serverConfigured()) throw new Error('还没有设置服务器，请先到「设置」里填写')
      const op = opts && (opts.op === 'pull' || opts.op === 'push' || opts.op === 'pull-full' || opts.op === 'push-full') ? opts.op : null
      const dryRun = !!(opts && opts.dryRun === true)
      const targets: DirSlot[] = dirId
        ? slots.has(dirId)
          ? [slots.get(dirId) as DirSlot]
          : []
        : Array.from(slots.values()).filter((s) => s.dir.enabled !== false)
      if (dirId && !targets[0]) throw new Error('找不到这个同步文件夹')
      if (!targets.length) throw new Error(dirId ? '找不到这个同步文件夹' : '没有正在开启的同步文件夹')
      if ((op || dryRun) && targets.some((s) => s.state === 'queued' || s.state === 'running')) {
        throw new Error('这个文件夹正在同步中，请等这一轮结束再试')
      }
      const results: RoundResolveValue[] = []
      for (const slot of targets) {
        const mineNow = leaderState === 'leader' && ownerRef.valid && (await leaderLockIsMine())
        if (mineNow) {
          // op / 预演轮的忙检查不能只靠入口那一次：上方 await leaderLockIsMine() 是
          // 异步文件 IO，让出事件循环期间 tick / watcher / 委托请求都可能把该 slot
          // 变忙；enqueue 的忙分支只置 rerunPending 并 waitRoundEnd、丢弃 op 与
          // dryRun（预演轮静默变真实传输轮、单向覆盖轮退化为常规轮并传播删除）。
          // 因此这里必须**同步**复检：本行到 enqueue 内置 slot.state='queued' 全程
          // 无 await，才是真正的原子窗口（范本：pollManualRequestsInner 在 enqueue
          // 前的同步忙检查 + 拒绝）。单目录调用（dirId 形参存在，targets 恰一个）
          // 抛入口同款错误；批量调用逐目录记错误结果并 continue —— 不因 mid-loop
          // 抛错丢掉已完成目录的结果（perDir 与 results 按下标对齐，语义保持）。
          if ((op || dryRun) && (slot.state === 'queued' || slot.state === 'running')) {
            if (dirId) throw new Error('这个文件夹正在同步中，请等这一轮结束再试')
            results.push({ ok: false, error: new Error('这个文件夹正在同步中，请等这一轮结束再试') })
            continue
          }
          results.push(await new Promise<RoundResolveValue>((resolve) => enqueue(slot, 'manual', true, resolve, op, dryRun)))
        } else {
          // 非 leader 路径无需本复检：委托轮的忙拒绝由 leader 侧 pollManualRequests
          //（enqueue 前同步忙检查）以回执送达；预演本地直跑（runDryRoundLocal）经
          // fallbackRun 取目录锁，与在飞轮天然互斥，等待语义安全。
          results.push(dryRun ? await runDryRoundLocal(slot) : await delegateManual(slot, op))
        }
      }
      if (dirId) {
        const r = results[0]
        return { ok: !r.error, error: r.error ? String(r.error) : undefined, summary: r.summary || undefined }
      }
      return {
        ok: results.every((r) => !r.error),
        perDir: results.map((r, i) => ({ dirId: targets[i].id, ok: !r.error, error: r.error ? String(r.error) : undefined })),
      }
    },

    /** 请求取消（接引擎 shouldAbort 通道；在飞轮在文件边界以取消语义收场） */
    cancel(dirId) {
      if (dirId == null) {
        for (const slot of slots.values()) {
          if (slot.state === 'running' || slot.state === 'queued') {
            slot.cancelRequested = true
            emitSlot(slot, true)
          }
        }
        return
      }
      const slot = slots.get(dirId)
      if (slot) {
        slot.cancelRequested = true
        emitSlot(slot, true)
      }
    },

    /**
     * 挂起自动调度（幂等）：清 tick / 心跳 / 选举定时器与全部 watcher、主动让出
     * leader 锁（他人可立即接管），等同 autoSync=false；手动同步仍可用。在飞轮
     * 不被取消（ownerRef 不失效），自然跑完收场。
     * @param reason 'pref'（用户「后台运行」关闭 → 隐藏时挂起，进入时恢复）| 'api'
     */
    suspend(reason: 'pref' | 'api' = 'api') {
      if (destroyed || suspended) return
      suspended = true
      suspendReason = reason
      stopTick()
      stopHeartbeat()
      if (electionTimer) electionTimer.dispose()
      electionTimer = null
      leaderState = 'standby'
      stopAllWatchers()
      // 清空队列（挂起期间不执行；等待者以错误收尾避免悬挂）
      while (queue.length) {
        const job = queue.shift()
        if (!job) break
        job.slot.state = 'idle'
        if (job.resolve) job.resolve({ error: '调度器已挂起' })
      }
      for (const slot of slots.values()) {
        if (slot.state === 'scheduled') {
          slot.state = 'idle'
          slot.nextDueAt = null
          slot.nextDueKind = null
        }
      }
      void resignLeaderBestEffort()
    },

    /** 恢复自动调度（幂等）：重读配置、重启选举与 tick */
    async resume() {
      if (destroyed || !suspended) return
      suspended = false
      suspendReason = null
      const r = await refreshConfig({ initial: !everLoaded })
      if (r && r.error) emitError(r.error, 'resume')
      if (ready) {
        startTick()
        startElection()
      }
    },

    /**
     * 重读 dbStorage 配置（渲染层 persist 后调用；配置权威只有 dbStorage）。
     * 按 configV 自检：内容未变零动作。首次加载（早于 init() 的 persist 触发）
     * 同样按 initial 处理 —— 打开插件不立即同步，新目录首轮不因加载入口不同而
     * 多发或丢失。
     */
    async reload() {
      if (destroyed) return { applied: false }
      const r = await refreshConfig({ initial: !everLoaded })
      if (r && r.error) {
        emitError(r.error, 'reload')
        return { applied: false, error: r.error }
      }
      return r
    },

    /**
     * 渲染层应答转发的冲突（forwardConflict 挂起的 Promise 在此解锁）。
     * @returns 是否确有等待中的该冲突
     */
    resolveConflict(conflictId, choice, applyToRemaining) {
      const resolve = conflictResolvers.get(conflictId)
      if (!resolve) return false
      conflictResolvers.delete(conflictId)
      resolve(applyToRemaining ? { choice, applyToRemaining: true } : choice)
      return true
    },

    /** 宿主 PluginOut（preload 侧钩子转发；双发 PluginOut 靠幂等） */
    handlePluginOut(isKill) {
      if (isKill) {
        facade.cleanup()
        return
      }
      // 隐藏（removeChildView）：用户「后台运行」关闭时挂起自动调度；默认（开）继续跑
      if (config && config.prefs && config.prefs.backgroundRunning === false) facade.suspend('pref')
      emit({ type: 'plugin-out', isKill: !!isKill })
    },

    /** 宿主 PluginEnter：仅恢复因用户开关挂起的调度（api 挂起不自动恢复） */
    handlePluginEnter(action) {
      if (suspended && suspendReason === 'pref') void facade.resume()
      emit({ type: 'plugin-enter', code: action && action.code })
    },

    /**
     * 统一清理（幂等；unload / kill 尽力而为路径 —— 设计上假设它不被调用，
     * 残留由 TTL + 新实例接管兜底）：清全部定时器与 watcher、让出 leader 锁与
     * 目录锁、取消在飞轮、清空订阅与冲突等待。
     */
    cleanup() {
      if (destroyed) return
      destroyed = true
      for (const slot of slots.values()) slot.cancelRequested = true
      ownerRef.valid = false
      stopTick()
      stopHeartbeat()
      if (electionTimer) electionTimer.dispose()
      electionTimer = null
      stopAllWatchers()
      for (const h of Array.from(heldDirLocks.keys())) {
        stopDirLockRenew(h)
        void releaseDirLock(h)
      }
      void resignLeaderBestEffort()
      // 冲突等待全部按 defer 收场（渲染层已不在，绝不挂死引擎询问）
      for (const [, resolve] of Array.from(conflictResolvers)) {
        try {
          resolve('defer')
        } catch (_) {
          /* 忽略 */
        }
      }
      conflictResolvers.clear()
      for (const w of roundWaiters.splice(0)) {
        try {
          w.resolve({ error: new Error('调度器已清理') })
        } catch (_) {
          /* 忽略 */
        }
      }
      listeners.clear()
      rendererOnline = false
      leaderState = 'standby'
      kit.disposeAll()
      if (ownerGuard && globalThis.__wdsyncSchedulerOwner === instanceId) {
        try {
          delete globalThis.__wdsyncSchedulerOwner
        } catch (_) {
          /* 忽略 */
        }
      }
    },
  }

  // ---------- 自举启动（生产挂载路径） ----------

  if (opts.autoBootstrap === true) {
    if (globalThis.__wdsyncSchedulerOwner) {
      // 同进程已有自举实例（宿主 preload 执行层去重下不应出现；belt & braces）
      notReadyReason = '同进程已有调度器实例，重复自举被拒绝'
      emitError(notReadyReason, 'bootstrap')
    } else {
      globalThis.__wdsyncSchedulerOwner = instanceId
      void bootstrapWithRetry()
    }
  }

  return facade
}

export {
  createScheduler,
  sweepSchedulerTimers,
  summarizeRound, // 轮末展示摘要（纯函数，渲染层与测试共用）
  // 常量导出（测试断言引用）
  TICK_MS,
  HEARTBEAT_MS,
  LEADER_TTL_MS,
  SLOW_HEARTBEAT_WARN_MS,
  DIR_LOCK_TTL_MS,
  DIR_LOCK_RENEW_MS,
  CONFLICT_FORWARD_TTL_MS,
  MANUAL_CLAIM_TIMEOUT_MS,
  MANUAL_COMPACT_AGE_MS,
  RERUN_DELAY_MS,
  LOST_REELECT_BASE_MS,
  BOOTSTRAP_RETRY_MS,
  BOOTSTRAP_MAX_RETRIES,
  CONFIG_KEY,
  // 调度策略常量
  MAX_CONCURRENT_ROUNDS,
  FAIRNESS_STARVE_MS,
  BACKOFF_THRESHOLD,
  BACKOFF_CAP_MS,
  FOLLOWUP_MIN_MS,
  FOLLOWUP_MAX_MS,
  FOLLOWUP_NO_PROGRESS_MAX,
  YIELD_RETRY_MIN_MS,
  YIELD_RETRY_MAX_MS,
  YIELD_CONSECUTIVE_MAX,
  CLOCK_JUMP_FACTOR,
  JUMP_CATCHUP_MIN_MS,
  JUMP_CATCHUP_MAX_MS,
  JUMP_GRACE_MS,
}
