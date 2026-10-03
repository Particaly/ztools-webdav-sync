/* eslint-disable */
// WebDAV 同步插件 —— preload 共享领域类型。
//
// 本文件是 window.services 公共 API 与内部模块（store / scheduler / services）
// 共用类型的**单一事实源**：渲染层 env.d.ts 由此 re-export，preload 各模块经
// `import type` 引用 —— 手写两份的类型从此不再漂移。
// 约束（Node 类型剥离 + esbuild 双通道都要吃）：只允许可擦除语法
//（interface / type / import type），不得出现 enum / namespace / import =。

/** WebDAV 连接配置（渲染层持久化的 server 段；netOpts 见 NetOpts） */
export interface DavConfig {
  serverUrl: string
  username: string
  password: string
  /** 网络层调优（可选，缺省用 preload 内置常量）：连接 / 空闲 / 无进展超时、每源连接数与限速 */
  netOpts?: NetOpts
}

/**
 * 网络层参数：全部可选，
 * 缺省值见 services 的 NET_DEFAULTS（10s / 30s / 60s / 8 / 0）。
 * ratePerSec 特殊分层：未设置时若服务器命中已知档案
 * （如坚果云）则用档案默认限速；显式 0 = 明确不限速（覆盖档案默认）。
 */
export interface NetOpts {
  /** TCP/TLS 建连超时（毫秒，默认 10000） */
  connectTimeoutMs?: number
  /** socket 空闲超时（毫秒，默认 30000） */
  idleTimeoutMs?: number
  /** 传输无进展判死阈值（毫秒，默认 60000） */
  stallMs?: number
  /** 每源（host:port）并发连接上限（默认 8） */
  maxSockets?: number
  /** 每源每秒请求上限（默认 0 = 不限制；档案命中且未设置时按档案默认） */
  ratePerSec?: number
}

/**
 * 服务器档位：
 *   A —— 条件请求可用且 etag 为强 etag：上传 / 删除带 If-Match / If-None-Match；
 *   B —— 有写权限但条件请求不可用或 etag 弱 / 缺失：覆盖 / 删除前逐文件复查（尽力保护）；
 *   C —— 服务器拒绝写入：download-only，跳过一切上传与删除。
 */
export type DavTier = 'A' | 'B' | 'C'

/**
 * 服务器能力探测结果（写权限按远端根路径判定）。
 * 公共字段（etag / 条件请求 / depthInfinity 等）按 origin+username 粒度缓存共享；
 * writable / tier 是「本次探测目标路径」的生效视图。
 */
export interface DavCapabilities {
  tier: DavTier
  /** 探测时间戳（TTL 起点，默认 7 天） */
  probedAt: number
  /**
   * 写入探测是否成功（按远端根路径判定，同一服务器不同子树可不同）。
   * 权限性拒绝（401/403/405/507）→ false → C 档
   */
  writable: boolean
  /** C 档 / 写探测失败时的降级原因（如「服务器拒绝写入（HTTP 403）」），UI 直接展示 */
  writeReason?: string
  /** 写探测为非权限性失败（409/5xx/网络）：当轮按 B 档保守处理，结论未长期缓存、下轮重探 */
  writeRetrySoon?: boolean
  /** 写权限探测时间戳（按路径各自的缓存起点） */
  writeProbedAt?: number
  /** 公共能力字段是否完整探测过（false = 写被拒轮次的保守默认值，未经实测） */
  commonProbed?: boolean
  /** 探测未完成、按 B 档保守降级（不落缓存） */
  degraded?: boolean
  etag: { present: boolean; weak: boolean; stable: boolean }
  /** 条件请求实测结果：过期 If-Match / 已存在文件的 If-None-Match:* 是否都得 412 */
  conditional: { ifMatch: boolean; ifNoneMatch: boolean }
  /** PROPFIND Depth: infinity 是否可用（单请求递归扫描的开关） */
  depthInfinity: boolean
  /** 集合 etag 深层传播（探测实测：修改二层深度的探测文件后，父集合与祖先集合的 etag 都变化）。true 时逐目录扫描可按「子集合 etag 未变」跳过其 PROPFIND */
  etagPropagation: boolean
  /** getlastmodified 精度：'s' 秒级 / 'ms' 毫秒级 */
  mtimePrecision: 's' | 'ms'
  /** 集合 URL 无尾斜杠时是否被 301/302 重定向（仅记录观测结果） */
  collectionRedirect: boolean
  /** 探测过程中的降级 / 备注（排障用） */
  notes?: string[]
}

/**
 * 目录运行状态。
 * 'conflict' 为 demo/兼容保留值：真实同步的冲突经引擎 onConflict 队列即时弹窗处理，
 * runSync 只会落到 synced | error，引擎状态机从不产生该状态；仅 ?demo= 场景使用。
 */
export type DirStatus = 'idle' | 'synced' | 'syncing' | 'conflict' | 'error'

/** 同步模式：双向 / 仅上传 / 仅下载 */
export type SyncMode = 'two-way' | 'upload' | 'download'

/** 单次同步结果摘要 */
export interface SyncSummary {
  uploaded: number
  downloaded: number
  deleted: number
  conflicts: number
  /**
   * 经 onConflict 返回 'defer' 挂起、本轮跳过未解决的冲突数。
   * defer 不报错：轮次以「部分完成，有 N 个待处理冲突」收场；挂起记录经
   * listPendingConflicts / setPendingChoice 统一处理。
   */
  deferredConflicts: number
  /** 规划期直接收敛（无传输）的文件数：无基线 adopt / hash 消歧采纳 / touch 刷新之外的情形 */
  adopted: number
  bytesUp: number
  bytesDown: number
  totalFiles: number
  /** 引擎提示（快照损坏降级、指纹不稳定、消歧超限等），显式限长 200 条 */
  warnings: string[]
  /** 文件级失败信息（引擎侧已限长 200 条），errorsDropped 为被截断的条数 */
  errors: string[]
  errorsDropped: number
  /** 本轮生效的服务器档位（A 条件保护 / B 复查 / C 只读） */
  tier?: DavTier
  /** 本轮因他机持锁而让出（零传输成功返回，非错误；引擎侧字段，UI 暂不依赖） */
  yielded?: boolean
  /** 让出轮的规划传输项数（信息性字段：规划了 N 项因让出未执行；仅 yielded 时存在） */
  planned?: number
  /**
   * 失败轮的机器可读归因（调度器跨轮退避输入）：'network'（全部网络类）/
   * 'mixed' / 'other'（全部非网络类）；成功轮不设该字段。网络类口径与整轮熔断
   * 计数一致（NETWORK / CIRCUIT_OPEN / 终态 429/423/5xx）。
   */
  failureClass?: 'network' | 'mixed' | 'other'
  /** 轮末仍开放的 upload 意图数（开放意图短延迟后续轮的判定输入） */
  openIntents?: number
  /** 熔断轮附带（UI「服务器连续无响应」归因）：consecutive 为连续网络类失败数 */
  breaker?: { open: true; consecutive: number; reason: string }
  /**
   * 删除安全（引擎侧字段）：单轮待删超过 max(50, 基线×20%) 时整批登记
   * 「待确认删除」挂起（kind='delete'），确认前零删除；用户经待处理面板
   * 确认（下一轮执行）或保留。轮次以 partial 收场并系统提醒。
   */
  deleteHeld?: number
  /** 用户选择「保留不删」（删除挂起 choice='keep'）而抑制的删除数（delete-remote：云端副本保留） */
  deleteKept?: number
  /** 「不删除」决策命中 delete-local（云端已缺、本地完好）而恢复上传的文件数（云端副本由本地上传恢复） */
  deleteRestored?: number
  /** 远端根 404 重建保护跳过的删除数（待本地内容重新上传和解，之后自动恢复删除传播） */
  deleteRootGuard?: number
  /**
   * 远端同步根丢失、等待用户决策（kind='root-lost' 挂起）的轮数标记：
   * 决策（重新上传 / 移除本地）落地前每轮以该标记收场，零删除零传输；
   * 渲染层据此弹出决策弹窗，调度器据此发系统提醒。
   */
  rootLostHeld?: number
  /** 空目录清理：本地 / 远端移除的空目录数（仅清理因本轮同步删除而变空的目录） */
  dirsPrunedLocal?: number
  dirsPrunedRemote?: number
  /**
   * 引擎被其他入口占用（ROUND_IN_FLIGHT，如测试直调）：调度器据此置 rerunPending
   * 不丢触发（引擎侧字段，渲染层不依赖）。
   */
  concurrent?: boolean
  /**
   * 本轮扫描形态（引擎侧信息字段，渲染层不依赖）：
   *   remote     —— 远端扫描实际形态：'infinity' 单请求递归 | 'per-dir' 逐目录列举；
   *   skippedDirs —— etag 子树跳过未列举的子集合数；
   *   local      —— 本地扫描形态：当前恒 'full'；'dirty'（watch 脏路径增量）留给
   *                 后续任务填充；
   *   dirtyPaths —— 本地增量扫描的脏路径数（仅 local='dirty' 时有意义，后续任务填充）。
   */
  scan?: { remote: 'infinity' | 'per-dir'; skippedDirs?: number; local?: 'full' | 'dirty'; dirtyPaths?: number }
}

/** 插件偏好设置（渲染层 prefs 段） */
export interface Prefs {
  autoSync: boolean
  intervalMin: number
  syncOnStartup: boolean
  conflictStrategy: 'ask' | 'local' | 'remote' | 'both'
  ignoreHidden: boolean
  concurrency: number
  /** 默认 WebDAV 目录：添加同步目录时预填的云端路径，空字符串表示不预填 */
  defaultRemoteDir: string
  /**
   * 功能测试目录：设置页「功能测试」在该目录内实际建删临时文件夹实测写权限
   *（WebDAV 服务器不同子树的写权限可能不同，根目录不一定可写）。空字符串 =
   * 未选择（渲染层在首次执行功能测试时弹远端目录选择器让用户指定）。
   */
  probeRemoteDir?: string
  /** 内容消歧上限（字节）：指纹模糊时下载到临时文件比对 hash 的最大文件大小，默认 50MB */
  verifyMaxBytes?: number
  /**
   * 崩溃恢复采纳内容确认的单轮总字节预算：崩溃后大量待采纳文件时
   * 限制轮首确认 GET 的总流量；超出预算的条目回退「按大小采纳」并汇总一条提示。
   * 缺省 = verifyMaxBytes × 4（见 services ADOPT_VERIFY_BUDGET_FACTOR 的依据）
   */
  adoptVerifyBudgetBytes?: number
  /** 深度校验（默认关）：按 deepVerifyDays 周期对本地文件重算 hash 与基线比较，可发现 size/mtime 均未变的修改 */
  deepVerify?: boolean
  deepVerifyDays?: number
  /** 目录级租约锁（默认开）：每轮同步前获取远端目录锁实现多设备互斥；关闭后多设备仅靠服务器档位保护 */
  leaseLock: boolean
  /**
   * 后台运行（默认 true）：用户开关的语义是「隐藏插件视图时是否继续自动同步」。
   * 关闭 = 隐藏时调度器挂起（suspend）、进入时恢复；宿主的 backgroundRunning 声明
   * 仍是静态 true（换取隐藏态 Blink 不节流，交互不被钳制）。副作用见 README。
   */
  backgroundRunning?: boolean
  /**
   * 调度器全局并发上限（默认 3，钳位 1–4）：跨 origin 的并行同步轮数；
   * 同一 origin（WebDAV 服务器）始终串行。高级项，当前无 UI 入口。
   */
  schedulerMaxConcurrent?: number
  /**
   * 用户排除规则：glob 数组（仅 * 与 ? 有特殊含义，* 不跨越 /；
   * 规则含 / 时匹配完整相对路径，否则逐段匹配文件名）。与内置垃圾规则
   *（.DS_Store / ._ / ~$ / Thumbs.db 等，不可关闭）相互独立，也与
   * ignoreHidden 独立。默认空数组。
   */
  excludePatterns?: string[]
}

/** 冲突信息（渲染层弹窗展示用） */
export interface ConflictInfo {
  dirId: string
  rel: string
  local: { size: number; mtimeMs: number }
  remote: { size: number; mtimeMs: number; etag?: string }
  /**
   * 引擎侧提示：'partial-upload' = 本机存在未完成的上传记录且远端小于本地，
   * 疑似上次中断上传留下的残缺文件（半截判定因超上限 / GET 失败无法自动完成），
   * 弹窗展示辅助文案；缺省无提示。
   */
  hint?: 'partial-upload'
}

/**
 * 同步进度回调载荷：verifyDone / verifyTotal 仅在 plan 阶段（规划期内容校验）有意义。
 *
 * 字节口径按阶段不同（UI 的进度折算只认 stage / phase，不直接用字节当百分比）：
 *   plan（verify 池运行中）—— bytesDone / bytesTotal 承载规划期内容校验的字节估算；
 *   transfer              —— bytesDone / bytesTotal 承载「计划需要上传 + 下载」的
 *                            字节量（分母只含已入队的传输任务，不含未变化的文件；
 *                            删除任务计 0），bytesDone 随传输完成递增。
 * scanBytesTotal 恒为「本轮扫描到的全部文件字节（两侧并集）」，与传输量无关
 *（云端占用估算的数据来源）。
 */
export interface SyncProgress {
  phase: 'scan' | 'plan' | 'transfer'
  filesDone: number
  filesTotal: number
  bytesDone: number
  bytesTotal: number
  /** 规划期内容校验（verify）已完成数（plan 阶段下发，无校验任务时为 0） */
  verifyDone?: number
  /** 规划期内容校验（verify）任务总数（plan 阶段下发，无校验任务时为 0） */
  verifyTotal?: number
  /**
   * 轮内细分阶段（当前正在执行的任务类别）：UI 据此展示「正在…」任务文案，并把
   * 整轮进度按 前置 10% / 传输（字节）80% / 后置 10% 分段折算。缺省时 UI 按 phase
   * 回落（旧事件形态兼容）。取值：
   *   scan     扫描（本地 + 远端）
   *   plan     变化判定 / 规划
   *   verify   规划期内容校验（hash 消歧 / 下载比对）
   *   lockwait 调度层等待目录锁（本机多实例互斥，他人正在同步该目录）
   *   lock     远端租约锁确认（多设备互斥；含 PUT 后的写回静置观察窗）
   *   transfer 传输（上传 / 下载 / 删除 / 冲突落地）
   *   finalize 后置收尾（瞬时重试 / 批量校验提交 / 基线落盘 / 空目录清理）
   */
  stage?: 'scan' | 'plan' | 'verify' | 'lockwait' | 'lock' | 'transfer' | 'finalize'
  /** 当前正在处理的任务类别（transfer 阶段；与 transferMeta 的 kind 同口径） */
  currentOp?: 'upload' | 'download' | 'delete-local' | 'delete-remote' | 'conflict'
  /** 当前正在处理的文件相对路径（transfer 阶段展示「正在上传 / 下载 …」用；并发时为最后领取者） */
  currentFile?: string
  /** 本轮扫描到的全部文件字节（两侧并集；云端占用估算用，非传输量） */
  scanBytesTotal?: number
}

/**
 * 冲突解决选择：applyToRemaining = 对本轮剩余冲突全部按该选择处理（「应用到全部」勾选）。
 * 'defer'：本轮挂起该冲突、跳过不报错 —— 典型为后台轮渲染层不可见，
 * 调度器不等一个看不见的弹窗；挂起记录经待处理冲突通道统一处理。
 */
export type ConflictChoice = 'local' | 'remote' | 'both' | 'defer' | { choice: 'local' | 'remote' | 'both'; applyToRemaining?: boolean }

// ---- 调度器视图 / 事件（scheduler 门面的公共形状）----

/**
 * 调度器目录视图：快照 slots 与 slot 事件共用的形状。state 为调度状态机
 * （idle / scheduled / queued / running）；渲染层 UI 状态（如 syncing）自行映射。
 */
export interface SchedulerSlotView {
  id: string
  state: 'idle' | 'scheduled' | 'queued' | 'running'
  /**
   * 下一次自动轮的到期时刻与来源：interval 常规轮询；backoff 跨轮退避
   * 到期；follow-up 开放意图短延迟后续轮；yield-retry 让出重排；watch 同目录 rerun
   * 的 +2s 重排；startup 由 startupPending 标记驱动（通常无预订）。
   */
  nextDueAt: number | null
  nextDueKind: 'interval' | 'startup' | 'watch' | 'backoff' | 'follow-up' | 'yield-retry' | null
  rerunPending: boolean
  cancelRequested: boolean
  progress: SyncProgress | null
  lastRound: { endedAt: number; summary: SyncSummary | null; error: string | null } | null
  /** 跨轮退避状态（fails 连续网络类失败轮数 / until 退避截止时刻，0 = 无） */
  backoff: { fails: number; until: number }
  /** follow-up 状态（轮次与无进展计数） */
  followUp: { count: number; noProgress: number }
  /** 退避期内合并的 watch 触发（不排队不提前，退避到期轮吸收） */
  watchHeld: boolean
}

/** 调度器全量快照（冷启动先拉快照再订阅） */
export interface SchedulerSnapshot {
  ready: boolean
  /** ready=false 时的原因（自举失败 / 配置不可读等，UI 直接展示） */
  notReadyReason?: string
  /** 配置内容哈希（reload 自检；同配置不重建） */
  configV: string
  leader: { isLeader: boolean; state: 'standby' | 'candidate' | 'leader' | 'lost'; instanceId: string }
  /** 是否处于挂起态（用户「后台运行」关闭 → 隐藏时挂起） */
  suspended: boolean
  slots: SchedulerSlotView[]
}

/**
 * 调度器事件（单一 listener，判别联合）。conflict 需经 resolveConflict 应答；
 * 其余为纯通知。plugin-out / plugin-enter 由 preload 侧钩子转发（渲染层不自行
 * 注册宿主钩子）。
 */
export type SchedulerEvent =
  | { type: 'slot'; slot: SchedulerSlotView }
  | { type: 'round-end'; dirId: string; summary: SyncSummary | null; error: string | null; cancelled: boolean }
  | { type: 'conflict'; conflictId: string; dirId: string; info: ConflictInfo }
  | { type: 'pending-conflicts'; dirId: string; items: Array<{ rel: string; createdAt: number; choice?: string; kind?: string; [k: string]: unknown }>; newlyNotified: boolean }
  | { type: 'config-applied'; dirsCount: number }
  /**
   * 调度器自身异常。默认面向日志（渲染层只 console 记录，不弹提示）；
   * visible=true 才允许打扰用户（当前无此类事件 —— 内部机制类信息一律只写日志）。
   */
  | { type: 'scheduler-error'; message: string; phase?: string; visible?: boolean }
  | { type: 'plugin-out'; isKill: boolean }
  | { type: 'plugin-enter'; code?: string }

/** 单次手动同步的结果（syncNow 单目录形态） */
export interface SyncNowResult {
  ok: boolean
  error?: string
  summary?: SyncSummary
}

/** preload 侧调度器公共门面（渲染层订阅与请求的形状；实例观测 / 宿主钩子不在公共面） */
export interface SchedulerApi {
  /** 渲染层握手（幂等）：标记订阅在线，读取配置启动；返回全量快照 */
  init(): Promise<SchedulerSnapshot>
  /** 订阅事件；返回退订函数 */
  subscribe(fn: (ev: SchedulerEvent) => void): () => void
  getSnapshot(): SchedulerSnapshot
  /** 手动同步（直插队首；省略 dirId = 全部启用目录）。未就绪时抛出明确错误 */
  syncNow(dirId?: string): Promise<SyncNowResult | { ok: boolean; perDir: Array<{ dirId: string; ok: boolean; error?: string }> }>
  /** 请求取消（接引擎 shouldAbort 通道；在飞轮在文件边界以取消语义收场） */
  cancel(dirId?: string): void
  /** 挂起自动调度（幂等；手动仍可用）。reason：'pref' = 用户偏好隐藏时挂起，'api' = 程序化挂起 */
  suspend(reason?: 'pref' | 'api'): void
  resume(): void
  /** 重读 dbStorage 配置（渲染层 persist 后调用；配置权威只有 dbStorage） */
  reload(): Promise<{ applied: boolean; error?: string }>
  /** 应答转发来的冲突（kind=manual 且渲染层在线时的弹窗选择） */
  resolveConflict(conflictId: string, choice: 'local' | 'remote' | 'both', applyToRemaining?: boolean): boolean
  /**
   * 轮末展示摘要（纯函数）—— 熔断轮归因「服务器连续无响应」+ 最后失败摘要、
   * 相同错误消息折叠为一条、挂起冲突轮收尾「部分完成，有 N 个待处理冲突」。
   */
  summarizeRound(summary: SyncSummary | null | undefined, error: Error | string | null | undefined, cancelled: boolean): RoundDisplay
}

/** 轮末展示摘要（scheduler.summarizeRound 的返回形状；纯函数产出） */
export interface RoundDisplay {
  tone: 'cancelled' | 'breaker' | 'error' | 'partial' | 'ok'
  title: string
  detail?: string
  /** breaker 轮附带：连续网络类失败数（tone='breaker' 时存在） */
  consecutive?: number
  /** 折叠后的错误消息（完全相同的合并为一条带次数） */
  errors?: string[]
}

// ---- store 内部数据形状（基线 / WAL / 失败表 / 挂起表）----

/**
 * 基线条目：nfcRel → 本地与远端的已知指纹。lhash 为本地内容哈希（有则深度
 * 校验 / 消歧可用）；origName 保留远端 NFD 原名（NFC 折叠访问）；conflictCopy
 * 标记「同时保留」策略生成的 *.conflict.* 副本（下载冲突副本时写入）。
 */
export interface BaselineEntry {
  lsize: number
  lmtimeMs: number
  rsize: number
  rmtimeMs: number
  retag: string
  lhash?: string
  origName?: string
  conflictCopy?: boolean
}

/**
 * WAL 意图（上传 / 删除前的「将要做」记录）：id 由引擎生成；store 侧只解释
 * id / at / firstAt（恢复与超龄判定），其余字段为引擎自由载荷（恢复期三向
 * 判定用的两侧指纹等），故带索引签名保持透传。
 */
export interface WalIntent {
  id: string
  op: string
  rel?: string
  at?: number
  firstAt?: number
  local?: { size?: number; mtimeMs?: number } | null
  remote?: { size?: number; mtimeMs?: number; etag?: string } | null
  [k: string]: unknown
}

/** 持续失败退避记录（failures.json 的条目形态） */
export interface FailureRecord {
  code: string
  message: string
  count: number
  firstAt: number
  lastAt: number
  retryAtMs: number
}

/**
 * 挂起记录的合法选择值（冲突类 local/remote/both；删除确认类 delete/keep；
 * 远端根丢失决策类 upload/remove-local）
 */
export type PendingChoice = 'local' | 'remote' | 'both' | 'delete' | 'keep' | 'upload' | 'remove-local'

/**
 * 冲突 / 删除确认 / 根丢失决策挂起记录（pending-conflicts.json 的条目形态）。
 * rel='.' 且 kind='root-lost' 为远端同步根丢失的整目录级决策记录：
 * local.size 携带受影响的基线文件数，remote 恒为空指纹。
 */
export interface PendingRecord {
  local: { size: number; mtimeMs: number }
  remote: { size: number; mtimeMs: number; etag: string }
  createdAt: number
  /** 'delete' = 删除确认类挂起；'root-lost' = 远端根丢失决策类；缺省为冲突类 */
  kind?: 'delete' | 'root-lost'
  /** 用户已做出但尚未成功落地的选择；缺省 = 未解决 */
  choice?: PendingChoice
  /**
   * choice 的来源标记：删除范围决策（setDeleteScope）盖章回写时记录其前缀 ——
   * 区分「用户逐文件显式选择」（无此字段，规划期最优先、范围决策不得翻案）与
   * 「范围决策盖章」（scope 存续时由 scope 消费、剪枝后由盖章兜底；同代更具体
   * 的后点决策可改写）。用户经 setPendingChoice 的选择永不携带此字段。
   */
  scope?: string
  /** 盖章时的批量代际（快照 at；无快照的扁平决策为 0）—— 跨代不互相改写 */
  scopeGen?: number
}

/** listPending 的返回形态（挂起记录 + nfc rel 键） */
export interface PendingListItem extends PendingRecord {
  rel: string
}

// ---- 批量删除快照与范围决策（pending-conflicts.json 的附加载荷）----

/**
 * 批量删除快照节点：批量删除闸拦截轮对「全部未决策删除候选」的聚合目录树里
 * 的一个节点。目录节点（isDir=true）的 files / bytes 为子树聚合值；文件叶
 *（isDir=false）恒为单文件（files=1）。rel 为 nfc 归一后的相对路径。
 */
export interface DeleteBatchNode {
  rel: string
  isDir: boolean
  /** 该节点覆盖的文件数（目录 = 子树文件总数，文件叶 = 1） */
  files: number
  /** 该节点覆盖的字节数（目录 = 子树字节总数） */
  bytes: number
}

/**
 * 批量删除快照（deleteBatch）：触发批量删除阈值拦截的那一轮，对「全部未决策
 * 删除候选」（新发现的 + 历史登记无 choice 的）做的目录聚合快照 —— 超出逐文件
 * 挂起表上限（500 条）的部分没有逐文件记录，快照是 UI 树形展示与「全部」类
 * 批量决策的完整事实源。所有未决策项被消费完（scope 覆盖 / 逐文件选择）后
 * 由引擎清除；下一次触发拦截时整体重建。
 */
export interface DeleteBatch {
  /** 快照构建时刻（毫秒） */
  at: number
  /** 受影响文件总数（含因节点上限未逐个列出的部分） */
  total: number
  /** 受影响字节总数 */
  bytes: number
  /** 聚合目录树节点（目录 + 文件叶，上限 MAX_BATCH_NODES，超出折叠 / 截断） */
  nodes: DeleteBatchNode[]
}

/**
 * 删除范围决策（deleteScope）：用户在目录树的某个节点（含文件叶 / 整个同步
 * 目录 = 空前缀）做出的批量选择 —— 覆盖该前缀下全部删除候选，包括逐文件
 * 挂起表装不下的部分。匹配规则：rel === prefix 或 rel 在 prefix 目录之下
 *（prefix='' 匹配全部）；多 scope 命中时取最具体（最长前缀）者。
 * 生命周期：连续多轮有效（每轮按匹配消费：delete 执行 / keep 抑制），
 * 扫描完整且零匹配的轮自动剪枝（情形已消失，后续再出现按新事件重新询问）。
 */
export interface DeleteScope {
  /** nfc 归一前缀；'' = 整个同步目录 */
  prefix: string
  /** 'delete' = 确认删除（下一轮执行）；'keep' = 保留不删（持续抑制） */
  choice: 'delete' | 'keep'
  /** 决策时刻（毫秒） */
  at: number
  /**
   * 批量代际（决策时的快照 at；无快照的扁平决策为 0）：范围决策只对「没有逐文件
   * 决策」的候选生效，盖章回写限定同代 —— 跨代的新批次决策不翻案旧代已盖章的
   * 逐文件记录；同前缀的新决策覆盖旧槽位（最后一次为准）。keep 语义与逐文件
   * 保留一致：持续抑制直至覆盖情形消失（引擎按零匹配剪枝）。
   */
  gen: number
}

/** listDeleteBatch 的返回形态（快照 + 当前 scopes + 引擎算好的未决策文件数） */
export interface DeleteBatchView extends DeleteBatch {
  /** 当前生效的删除范围决策（UI 据此渲染已决策 / 随上级决策状态） */
  scopes: DeleteScope[]
  /** 未决策文件数（total - 被 scopes 覆盖的文件数，引擎按树精确去重计算） */
  undecided: number
}

/**
 * 决策历史记录（decision-log.json 的条目形态）：用户对待处理挂起做出选择（或选择
 * 忽略）时追加一条，供「最近处理记录」面板回看。纯展示性审计信息 —— 丢失 / 损坏
 * 的最坏后果是历史列表变短，不影响同步正确性。
 */
export interface DecisionLogEntry {
  /** 决策时刻（毫秒） */
  at: number
  /** 决策对象的文件相对路径；root-lost 类恒为 '.' */
  rel: string
  /** 'conflict' | 'delete' | 'root-lost' = 挂起类别；'ignore' = 用户选择忽略挂起 */
  kind: 'conflict' | 'delete' | 'root-lost' | 'ignore'
  /** 用户选择（忽略类为被忽略挂起原本的类别对应的合法值或 'ignore'） */
  choice: string
  /** 影响文件数（仅 root-lost 类目录级决策携带 = 受影响基线文件数） */
  affected?: number
}

/** 基线 / WAL 日志行负载（{t:'set'|'del'|'clear'|'intent'|'done'|'abort', ...}） */
export interface LogOp {
  t: string
  k?: string
  e?: BaselineEntry
  id?: string
  [k: string]: unknown
}

/** ZTools 宿主 API（本插件用到的子集；preload 侧访问 window.ztools 的类型） */
export interface ZToolsApi {
  onPluginEnter(cb: (action: { code: string }) => void): void
  /**
   * 宿主为单回调槽位（重复注册覆盖）。由 preload 侧先注册持有槽位并转发
   * plugin-out 事件给调度器订阅者；渲染层不再自行注册。isKill=true 为 killPlugin
   * 路径（进程将亡），false 为普通隐藏（视图摘除，进程可能存活）。
   */
  onPluginOut(cb: (isKill?: boolean) => void): void
  showOpenDialog(options: { title?: string; properties: string[] }): string[] | undefined
  shellOpenExternal(url: string): void
  /**
   * 把文件 / 目录移入系统回收站（异步，失败 reject）。
   * 由引擎用于本地删除（宿主已核实可用）。
   */
  shellTrashItem(fullPath: string): Promise<void>
  dbStorage: {
    getItem<T>(key: string): T | null
    setItem(key: string, value: unknown): void
  }
  getPath(name: string): string
  /** 系统通知（挂起冲突提醒；preload 调度器使用，尽力而为） */
  showNotification?(body: string): void
}
