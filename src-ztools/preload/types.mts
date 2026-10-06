/* eslint-disable */
// WebDAV 同步插件 —— preload 共享领域类型。
//
// 本文件是 window.services 公共 API 与内部模块（store / scheduler / services）
// 共用类型的**单一事实源**：渲染层 env.d.ts 由此 re-export，preload 各模块经
// `import type` 引用 —— 手写两份的类型从此不再漂移。
// 约束（Node 类型剥离 + esbuild 双通道都要吃）：只允许可擦除语法
//（interface / type / import type），不得出现 enum / namespace / import =。

/** WebDAV 连接配置（渲染层持久化的 server 段；netOpts 见 NetOpts、tls 见 TlsOpts） */
export interface DavConfig {
  serverUrl: string
  username: string
  password: string
  /** 网络层调优（可选，缺省用 preload 内置常量）：连接 / 空闲 / 无进展超时、每源连接数与限速 */
  netOpts?: NetOpts
  /** TLS 信任选项（可选）：自签名证书 NAS（群晖 / QNAP 等）的连接通道 */
  tls?: TlsOpts
}

/**
 * TLS 信任选项：默认（未设置）按系统标准校验证书链与主机名 —— 自签名证书的
 * 服务器会直接连接失败。两条放宽通道（互不冲突，可同时使用）：
 *   trustServerCertificate —— 完全信任该服务器（跳过证书校验，传输仍加密）；
 *   caPem                 —— 追加信任自建 CA 的根证书（仍做完整校验，安全性更好）。
 * 两者都只作用于当前服务器配置，不影响其他连接。
 */
export interface TlsOpts {
  /**
   * 信任此服务器的证书：跳过证书链与主机名校验（连接仍加密，但无法防御
   * 中间人假冒服务器）。仅建议在服务器是自己可控的 NAS / 内网设备
   *（群晖、QNAP 等使用自签名证书的场景）时开启。
   */
  trustServerCertificate?: boolean
  /** 追加信任的 CA 根证书（PEM 格式文本，可含多段）：用于校验自建 CA 签发的服务器证书 */
  caPem?: string
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
  /**
   * MOVE 方法是否可用（改名同步的开关）：探测期实测（探测文件改名后清理）。
   * 缺省 undefined = 未探测（旧缓存 / 探测期不可写）—— 按「可用」乐观处理，
   * 运行时 MOVE 失败（405/501）会持久降级为 false 并回落删传语义；
   * false = 该服务器不支持 MOVE，改名按「删除 + 重新上传」处理。
   */
  moveSupported?: boolean
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
  /**
   * 改名同步（零重传 / 零下载）：本地改名经远端 MOVE 落地的文件数 ——
   * 配对条件为「旧路径消失 + 新路径出现 + 内容哈希与尺寸一致」，见引擎 computeRenamePairs。
   * 缺省 0（让出轮 / 扫描失败轮的最小摘要与旧版本记录不带）。
   */
  renamedRemote?: number
  /** 改名同步：远端改名在本机以本地改名落地的文件数（对端 MOVE 后本机跟随改名，零下载）；缺省 0 */
  renamedLocal?: number
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
  /**
   * 实验功能（默认关）：ZTools 插件目录同步。开启后同步列表出现一条固定 id
   *（'ztools-plugins'）的虚拟记录：本地目录自动发现（~/.ztools/plugins，用户
   * 不可修改）、远端按平台隔离（<父目录>/ztools-plugins/<platformKey>，防止
   * 不同平台的设备互相同步不兼容的插件）。该记录不可修改文件夹设置，也不可
   * 移除 —— 只能关本开关；发现逻辑见 ztools-plugins.mts（单一事实源）。
   */
  ztoolsPluginSync?: boolean
  /** 插件同步虚拟记录的行级暂停（true = 该记录停用，自动与手动同步都跳过；缺省 false） */
  ztoolsPluginSyncPaused?: boolean
  /**
   * 【实验：ZTools 插件同步】云端存储位置的父目录（用户可选；'' / 缺省 = 云端根）。
   * 实际同步根 = <该目录>/ztools-plugins/<platformKey> —— ztools-plugins 与平台段
   * 固定追加、不随选择改变，多台设备各选同一个父目录即可互通（组装与规范化见
   * ztools-plugins.mts 的 ztoolsPluginsRemotePath）。更换父目录后远端基线随
   * remotePath 键更换：首轮把本机插件重新上传到新位置，旧位置内容不迁移不删除。
   */
  ztoolsPluginSyncRemoteDir?: string

  // ---------- 持久警告的「不再显示」标记（渲染层 UI 关注，引擎不消费） ----------
  //
  // 长时间展示的黄色警告由用户关闭后不再出现；多数记录「关闭时的情境指纹」，
  // 情境变化（换服务器 / 档位或状态改变 / 有新挂起）时自动重新提示，避免错过新情况。

  /**
   * 明文 http 连接警告「不再显示」：记录关闭时的服务器地址。主界面服务器卡片与
   * 设置页共用同一条警告（共用本标记）；换成另一个 http 地址后重新提示。
   */
  insecureHttpDismissedFor?: string
  /**
   * 设置页「服务器检测结果」结论提示行（B / C 档说明）不再显示：记录关闭时的档位
   *（'B' / 'C'）。档位变化后（服务器变更或重新检测出不同结论）重新提示。
   */
  tierHintDismissed?: string
  /** 插件同步行「本机插件目录尚未发现」提示条不再显示（永久；目录出现后提示条本就会消失） */
  pluginUnavailableDismissed?: boolean
  /**
   * 插件同步行「注册表对账降级」提示条不再显示：记录关闭时的对账状态
   *（'pending' / 'denied' / 'unavailable'）。状态变化（如批准授权、宿主升级）后重新提示。
   */
  registrySyncDismissed?: string
  /**
   * 同步记录页顶部「待处理横幅」不再显示：记录关闭时的全局待处理信号时间戳
   *（各目录未决策挂起的最新时间，见 store.dirPendingSignal）。有更新的挂起时重新提示。
   */
  pendingBarMutedAt?: number
}

/**
 * 「ZTools 插件同步」（实验）的自动发现结果（services.ztoolsPlugins.describe 的
 * 返回形状；发现逻辑见 ztools-plugins.mts）。渲染层虚拟行与调度器合成配置共用。
 */
export interface ZtoolsPluginsSyncDesc {
  /** 虚拟记录固定 id（渲染层行与调度器 slot 以此对齐） */
  id: 'ztools-plugins'
  /** 本机插件实体目录绝对路径（ZTOOLS_DATA_ROOT 覆盖时跟随；自动发现、不可修改） */
  pluginsDir: string
  /** 平台目录名（mac / windows / linux；未知平台原样使用 platform 值，保持隔离语义） */
  platformKey: string
  /** 平台隔离的远端同步根（<可选父目录>/ztools-plugins/<platformKey>；父目录缺省为云端根） */
  remotePath: string
  /** 插件目录当前是否可用（存在且为目录） */
  available: boolean
  /** 不可用原因（面向用户的一句话；available=true 时缺省） */
  reason?: string
  /**
   * 注册表对账（无感同步第二段）的降级形态（渲染层异步注入：describe 不填，
   * 经 services.ztoolsPlugins.registryState() 刷新后合并进虚拟行；缺省 undefined
   * = 尚未探测，UI 不提示）：'ok' = 已授权正常；'pending' = 已向宿主提交高级
   * API 授权申请，等用户在设置页批准（批准后实时生效，无需重开插件）；
   * 'denied' = 宿主无申请通道（旧版宿主），实体同步但插件不会自动登记；
   * 'unavailable' = 宿主未注入 internal 命名空间（更旧），同样不登记
   */
  registrySync?: 'ok' | 'pending' | 'denied' | 'unavailable'
}

/**
 * 插件注册表对账一次执行的结果（services.ztoolsPlugins.reconcileRegistry 的
 * 返回与 registryState 的最近状态共用形状；对账逻辑见 ztools-registry.mts）。
 */
export interface RegistryReconcileResult {
  /**
   * ok = 有产出（可能含变更）；noop = 无任何变化；pending = 权限申请已提交
   * 等待审批；denied / unavailable = 降级；error = 异常
   */
  status: 'ok' | 'noop' | 'pending' | 'denied' | 'unavailable' | 'error'
  /** 本轮从 manifest / 孤儿实体新登记的插件名列表 */
  adopted: string[]
  /** 本轮经两轮幽灵核验后移除注册记录的插件名列表 */
  removed: string[]
  /** 本轮是否改写了 manifest 文件（改写会触发 watcher → 下一轮上传） */
  wroteManifest: boolean
  /** 本轮提交 / 确认过的高级 API 申请通道名（仅 status='pending' 时存在） */
  requested?: string[]
  /** 降级 / 异常原因（denied 携带宿主的鉴权拒绝文案；UI 诊断用） */
  error?: string
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
  currentOp?: 'upload' | 'download' | 'delete-local' | 'delete-remote' | 'conflict' | 'rename-remote' | 'rename-local'
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
  /** 手动同步（直插队首；省略 dirId = 全部启用目录）。未就绪时抛出明确错误。
   *  opts.op 携带一次单向操作（'pull' = 「云端补齐本地」/ 'pull-full' = 「云端
   *  覆盖本地」/ 'push' = 「本地补齐云端」/ 'push-full' = 「本地覆盖云端」，经
   *  引擎 hints.op 注入本轮规划：补齐档恢复本端缺失、保留本端多出与改动，双侧
   *  都改走冲突流程；覆盖档以选定侧为准镜像对侧（缺失恢复 / 不一致覆盖 / 多余
   *  删除）。目录忙时明确拒绝 —— 忙时重排轮无法携带 op，放行会退化成常规轮，
   *  违背按钮语义） */
  syncNow(dirId?: string, opts?: { op?: 'pull' | 'push' | 'pull-full' | 'push-full' }): Promise<SyncNowResult | { ok: boolean; perDir: Array<{ dirId: string; ok: boolean; error?: string }> }>
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

// ---- 同步记录（sync-log.json：每次同步轮一条，简略 / 详尽两种视图共用数据源）----

/**
 * 单次同步中单个文件操作的记录（同步记录详尽视图的数据源）。
 * 两侧动作口径：upload / delete-remote 是对云端（线上）的操作，
 * download / delete-local 是对电脑（线下）的操作；conflict 为冲突处理
 *（其落地动作 —— 覆盖上传 / 下载 / 副本下载 —— 不再单记，避免一条改动两条记录）。
 */
export interface SyncLogOp {
  /** 操作类型（两侧口径见接口注释） */
  op: 'upload' | 'download' | 'delete-local' | 'delete-remote' | 'conflict' | 'rename-remote' | 'rename-local'
  /** 文件相对路径（nfc 归一；改名条目为新路径） */
  rel: string
  /** 改名前的原路径（op='rename-remote' / 'rename-local' 时存在） */
  from?: string
  /** 是否成功落地；缺省 true（失败条目仅来自批量校验提交失败等「明确失败」路径） */
  ok?: boolean
  /** 失败原因（ok=false 时的一句话，已截断） */
  err?: string
  /** 传输字节（upload = 本地大小、download = 远端大小；删除 / 冲突不计） */
  bytes?: number
  /** 对侧此前没有该文件 = 新增（upload → 云端新增 / download → 本地新增）；更新缺省 */
  added?: boolean
  /** 冲突处理的选择（op='conflict' 时）：local 保留电脑版本 / remote 保留云端版本 / both 两个都留 */
  choice?: 'local' | 'remote' | 'both'
}

/**
 * 单次同步轮的完整记录（sync-log.json 的条目形态）。每次引擎轮（成功 / 失败 /
 * 取消 / 让出）在轮末追加一条，供「同步记录」页回看当次同步的触发方式、时间与
 * 两侧改动明细。纯展示性审计信息 —— 丢失 / 损坏的最坏后果是记录列表变短，
 * 不影响同步正确性。
 */
export interface SyncLogEntry {
  /** 轮次开始时刻（毫秒） */
  at: number
  /** 轮次结束时刻（毫秒） */
  endAt: number
  /**
   * 触发方式：manual 手动同步 / manual-delegated 手动同步（多实例委托代跑，
   * 展示口径与 manual 合并）/ interval 定时自动 / watch 文件变化自动 /
   * startup 插件启动 / backoff 失败退避重试 / follow-up 开放意图后续轮 /
   * yield-retry 让出后重试
   */
  trigger: string
  /** 一次性单向操作（手动「云端补齐 / 覆盖本地」等四个按钮）；常规轮缺省 */
  op?: 'pull' | 'push' | 'pull-full' | 'push-full'
  /**
   * 轮次结果：ok 成功 / partial 部分完成（有挂起冲突或待确认删除，等用户处理）/
   * error 失败（error 携带首条人话原因）/ cancelled 用户取消 /
   * yielded 他机正在同步，本轮让出（零传输）
   */
  status: 'ok' | 'partial' | 'error' | 'cancelled' | 'yielded'
  /** 失败原因（status='error' 时的首条人话消息） */
  error?: string
  /** 计数摘要（SyncSummary 的展示子集；与简略行 / 详尽视图的头部共用） */
  uploaded: number
  downloaded: number
  deleted: number
  conflicts: number
  /** 规划期直接收敛（无传输）的文件数 */
  adopted: number
  /** 改名同步的文件数（renamedRemote + renamedLocal，详尽视图按 ops 细分方向）；缺省 0（旧版本记录） */
  renamed?: number
  /** 本轮挂起等用户处理的冲突数（后台轮 defer） */
  deferredConflicts: number
  /** 登记待确认删除的文件数（确认前零删除） */
  deleteHeld: number
  /** 上传字节合计 */
  bytesUp: number
  /** 下载字节合计 */
  bytesDown: number
  /** 本轮扫描到的文件总数（两侧并集） */
  totalFiles: number
  /** 逐文件操作明细（全量记录，不截断 —— 大轮次的详尽视图经渲染层虚拟滚动呈现） */
  ops: SyncLogOp[]
  /** 本轮错误清单（与 summary.errors 同源，上限 200 条） */
  errors: string[]
  /** 被截断未记录的错误数 */
  errorsDropped?: number
}

/** 基线 / WAL 日志行负载（{t:'set'|'del'|'clear'|'intent'|'done'|'abort', ...}） */
export interface LogOp {
  t: string
  k?: string
  e?: BaselineEntry
  id?: string
  [k: string]: unknown
}

/**
 * 插件自身的 internal 高级 API 授权状态（ztools.getInternalApiPermissions 的
 * 返回形状；宿主按通道细粒度授权，通道名形如 internal:db-get）。
 */
export interface InternalApiPermissionStatus {
  /** 完全授权（内置名单 / 手动全量名单）——放行所有 internal 通道 */
  fullAccess: boolean
  /** 已授权给本插件的通道名列表 */
  granted: string[]
  /** 已提交、等待用户在设置页「高级权限」审批的通道名列表 */
  pending: string[]
}

/**
 * ZTools 内部 API（window.ztools.internal）——本插件用到的子集。宿主
 * resources/preload.js 对所有插件注入该命名空间，但每次调用在主进程按
 * canUseInternalApi 鉴权：完全授权（内置 / 手动全量名单）放行一切；按通道
 * 授权模式下放行「已授权通道」。授权数据每次 IPC 现读 —— 设置页批准后立即
 * 生效，无需重开插件。授权入口与申请流程见 design/host-api-requirements.md。
 */
export interface ZToolsInternalApi {
  /** 读取 ZTOOLS/ 命名空间文档（如 'plugins' 注册表）；未授权时 reject */
  dbGet(key: string): Promise<any>
  /** 覆盖写 ZTOOLS/ 命名空间文档；未授权时 reject */
  dbPut(key: string, value: unknown): Promise<unknown>
  /**
   * 通知宿主刷新已安装插件列表与指令索引：登记后调用使列表即时刷新；
   * 调用失败静默吞掉 —— 通知是增强不是关键路径，绝不回滚已生效的登记
   */
  notifyPluginsChanged?(): Promise<unknown>
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
  /**
   * 查询自身的高级 API 授权状态（fullAccess / granted / pending）。宿主支持
   * 「按通道授权 + 主动申请」体系时存在；旧宿主缺失 —— 访问前特性检测，缺失时
   * 退回「直接调用并按拒绝降级」的探测路径
   */
  getInternalApiPermissions?(): Promise<InternalApiPermissionStatus>
  /**
   * 主动申请高级 API 权限（附通道名列表与用途说明，宿主写入待审申请供设置页
   * 审批）。返回 { success, status: 'granted' | 'pending', ... }；旧宿主缺失
   * 该方法 —— 缺失或失败时退回降级路径
   */
  requestInternalApiPermissions?(apis: string[], reason?: string): Promise<any>
  /**
   * 内部 API（window.ztools.internal）：ZTOOLS 注册表读写与列表刷新通知的
   * 通道。可选 —— 旧宿主未注入该命名空间时为 undefined，调用方据此降级为
   * 纯实体同步（不做注册表写入）；授权与否由宿主按调用鉴权，探测见
   * ztools-registry.mts。
   */
  internal?: ZToolsInternalApi
  /** 系统通知（挂起冲突提醒；preload 调度器使用，尽力而为） */
  showNotification?(body: string): void
}
