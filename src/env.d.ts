/// <reference types="vite/client" />
/// <reference types="@ztools-center/ztools-api-types" />

import type { DirStatus, Prefs, SyncMode, SyncSummary, ZToolsApi } from '../src-ztools/preload/types.mts'
import type { ServicesPublic } from '../src-ztools/preload/services.mts'

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>
  export default component
}

/**
 * 领域类型单一事实源：全部公共形状由 preload 侧定义
 *（types.mts），本文件只做 re-export 与渲染层自有形态（SyncDir /
 * DirOverrides 在配置之上叠加的 UI 运行时状态字段）—— 手写两份导致
 * 漂移的历史就此结束。preload 源码在 tsconfig.preload.json 下 strict
 * 全开，vue-tsc 同样覆盖这些源文件。
 */
export type {
  BaselineEntry,
  ConflictChoice,
  ConflictInfo,
  DavCapabilities,
  DavConfig,
  DavServerEntry,
  DavTier,
  DecisionLogEntry,
  DeleteBatch,
  DeleteBatchNode,
  DeleteBatchView,
  DeleteScope,
  DirStatus,
  FailureRecord,
  LogOp,
  NetOpts,
  PendingChoice,
  PendingListItem,
  PendingRecord,
  Prefs,
  RegistryReconcileResult,
  RoundDisplay,
  SchedulerApi,
  SchedulerEvent,
  SchedulerSnapshot,
  SchedulerSlotView,
  SyncLogEntry,
  SyncLogOp,
  SyncMode,
  SyncNowResult,
  SyncProgress,
  SyncSummary,
  TlsOpts,
  WalIntent,
  ZToolsApi,
  ZtoolsPluginsSyncDesc,
} from '../src-ztools/preload/types.mts'

/**
 * preload 注入的 Node 能力层门面（由 services.mts 实现推导；测试直检后门
 * 已在 preload 侧裁剪，渲染层类型永不暴露）。
 */
export type { ServicesPublic as Services } from '../src-ztools/preload/services.mts'

/**
 * 目录级设置覆盖：未设置的项跟随全局偏好。
 * 开关整体生效（「单独设置这个文件夹」）：开启时表单把全部字段按当前值显式写入，
 * 关闭时整体置 null 恢复跟随全局 —— 不做逐字段回退，保持 UI 与数据语义一致。
 */
export interface DirOverrides {
  /** 是否自动同步：关闭后该目录只手动同步（「立即同步」仍可用），不排自动轮、不挂 watcher */
  autoSync?: boolean
  /** 自动同步轮询间隔（分钟） */
  intervalMin?: number
  conflictStrategy?: Prefs['conflictStrategy']
  ignoreHidden?: boolean
  /** 并发传输数（同时上传 / 下载的文件数上限） */
  concurrency?: number
  /**
   * 每秒请求上限：显式数值覆盖全局 netOpts.ratePerSec 的分层口径
   *（档案默认 / 全局显式值）；缺省（键不存在）= 跟随全局
   */
  ratePerSec?: number
  /** 目录级租约锁（多设备互斥同步） */
  leaseLock?: boolean
  /** 深度校验（定期重算 hash 与基线比对） */
  deepVerify?: boolean
  /** 用户排除规则（glob 数组，口径与 prefs.excludePatterns 一致） */
  excludePatterns?: string[]
  /**
   * 选择性同步树「取消同步」的精确 rel 列表（渲染层勾选树的落地形态；目录级
   * 字段，无全局形态）。引擎侧字面精确匹配 + 祖先目录命中即整棵子树排除
   *（compileSyncExcludes），与 excludePatterns 在扫描层合并生效 —— 文件名含
   * 通配符字面也不会误伤。空数组 = 树上全部勾选（无排除）。
   */
  excludeRels?: string[]
}

/** 同步目录配置 + 运行时状态（渲染层自有形态：配置之上叠加 UI 运行态字段） */
export interface SyncDir {
  id: string
  name: string
  localPath: string
  remotePath: string
  mode: SyncMode
  status: DirStatus
  lastSyncAt: number | null
  lastResult: SyncSummary | null
  /**
   * 【demo/兼容字段】冲突文件名。真实同步的冲突由引擎 onConflict 队列即时弹出处理，
   * runSync 成功时会将其置回 null，引擎状态机从不写入非空值；
   * 仅 ?demo= 演示场景（及历史持久化数据）使用，勿据此扩展真实冲突流程。
   */
  conflictFile: string | null
  /**
   * 面向用户的错误摘要（一句话人话：发生了什么 + 该做什么）。
   * 技术细节（HTTP 码 / 路径 / 原始报错）放 errorDetail，界面默认不展示。
   */
  errorMessage: string | null
  /**
   * 错误详情（第二层）：悬浮 title / 反馈时复制用；null = 无补充信息。
   * 仅运行时展示与持久化，不参与同步逻辑。
   */
  errorDetail?: string | null
  progress: {
    phase?: 'scan' | 'plan' | 'transfer'
    filesDone: number
    filesTotal: number
    /**
     * 传输段已完成的「真实字节」：随上传读流 / 下载落盘逐块增长（大文件传输期间
     * 持续递进，不再按整文件完成跳变），任务完结时补齐尾差；终值 = 计划传输字节。
     * plan 段该字段承载内容校验字节（UI 只按 stage / phase 折算，不混用）。
     */
    bytesDone: number
    bytesTotal: number
    verifyDone?: number
    verifyTotal?: number
    stage?: 'scan' | 'plan' | 'verify' | 'lockwait' | 'lock' | 'transfer' | 'finalize'
    currentOp?: 'upload' | 'download' | 'delete-local' | 'delete-remote' | 'conflict' | 'rename-remote' | 'rename-local'
    currentFile?: string
    scanBytesTotal?: number
  } | null
  /** 是否启用同步：undefined / true 视为启用，false 时跳过自动与手动同步 */
  enabled?: boolean
  /** 目录级设置覆盖（是否自动同步 / 检查频率 / 冲突处理等全部高级项），null 表示全部跟随全局 */
  overrides?: DirOverrides | null
  /** 运行时标记：刚完成一次同步（12 秒内展示完成摘要条） */
  justCompleted?: boolean
  /** 【demo/兼容字段】同 conflictFile：仅供演示场景的冲突弹窗展示两侧版本，真实流程不写入 */
  conflictLocal?: { size: number; mtimeMs: number } | null
  conflictRemote?: { size: number; mtimeMs: number } | null
  /** 最近一次同步扫描到的总字节数（用于估算云端占用） */
  lastBytesTotal?: number
  /**
   * 该目录使用的服务器（store.servers 成员的 id；多账号 / 多服务器形态）。
   * 缺省 = 添加时活跃的服务器；调度器按 id 解析条目，失配回落第一台。
   */
  serverId?: string | null
  /**
   * 目录级服务器地址覆盖（历史遗留字段，现有 UI 不写 —— 多服务器形态走
   * serverId）：调度器「每 origin 并发 1」的分组键，行为与单服务器形态一致。
   */
  serverUrl?: string | null
  /**
   * 该目录的待处理挂起（后台轮 defer 挂起的冲突 + 批量删除超阈值登记的
   * 「待确认删除」+ 远端根丢失的目录级决策）；kind='delete' 为删除确认类
   * （choice ∈ delete/keep），kind='root-lost' 为根丢失决策类（choice ∈
   * upload/remove-local，rel 恒为 '.'，local.size 携带受影响文件数），
   * 缺省为冲突类（choice ∈ local/remote/both）。主界面面板统一展示与处理。
   */
  pendingConflicts?: Array<{
    rel: string
    createdAt: number
    choice?: string
    kind?: string
    local?: { size?: number; mtimeMs?: number }
    remote?: { size?: number; mtimeMs?: number; etag?: string }
  }> | null
  /**
   * 渲染层标记：决策弹窗最近一次自动 / 直达展示时对应的「云端文件夹丢失」挂起
   * createdAt（kind='root-lost' 的登记内 createdAt 稳定）。据此把自动弹窗从
   * 「只依赖一次性 newlyNotified 事件」改为「数据到手且这条登记未弹过」——
   * 事件在渲染层不在场时丢失后，回窗口 / 冷启动的兜底刷新仍能补弹；同一登记
   * 已展示过则不再自动重复打扰。随目录配置一并持久化。
   */
  rootLostPromptedAt?: number | null
  /**
   * 渲染层标记：行内「待处理挂起条」被用户关闭（不再显示）时的目录待处理信号
   *（store.dirPendingSignal：未决策挂起的最新时间）。有更新的挂起（新冲突 /
   * 新删除确认登记）时信号变大，提示条重新显示 —— 关闭只对当前这批事项生效，
   * 不吞掉后续新事项。随目录配置一并持久化。
   */
  pendingStripMutedAt?: number | null
  /**
   * 批量删除快照（listDeleteBatch 拉取）：删除确认的目录树数据源 —— 逐文件挂起
   * 表有 500 条上限，超限部分没有逐文件记录，树形展示与「全部 / 按目录」决策
   * 全部走这份快照（scopes 携带已决策状态、undecided 为未决策文件数真值）。
   * 运行时状态不持久化（sanitizeDirForPersist 置 null），打开面板 / 轮末兜底时刷新。
   */
  deleteBatch?: DeleteBatchView | null
  /**
   * 【实验：ZTools 插件同步】虚拟行携带的自动发现结果（services.ztoolsPlugins.describe）。
   * 仅虚拟行存在；纯运行时展示信息（available=false 时行内提示条），随行注入 /
   * 刷新，绝不持久化（虚拟行本身就被 persist 过滤）。
   */
  pluginSyncInfo?: ZtoolsPluginsSyncDesc | null
}

/**
 * preload 注入的全局能力（可选）：渲染层可能在无 preload 的环境运行（纯浏览器
 * 预览 / 测试），取用处一律按可能缺席处理 —— `?.` 可选链或 `if (!window.services)`
 * 守卫窄化后再直取，与库内既有约定一致。
 */
declare global {
  interface Window {
    services?: ServicesPublic
    ztools?: ZToolsApi
  }
}

export {}
