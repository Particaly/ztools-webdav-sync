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
  DavTier,
  DirStatus,
  FailureRecord,
  LogOp,
  NetOpts,
  PendingChoice,
  PendingListItem,
  PendingRecord,
  Prefs,
  RoundDisplay,
  SchedulerApi,
  SchedulerEvent,
  SchedulerSnapshot,
  SchedulerSlotView,
  SyncMode,
  SyncNowResult,
  SyncProgress,
  SyncSummary,
  WalIntent,
  ZToolsApi,
} from '../src-ztools/preload/types.mts'

/**
 * preload 注入的 Node 能力层门面（由 services.mts 实现推导；测试直检后门
 * 已在 preload 侧裁剪，渲染层类型永不暴露）。
 */
export type { ServicesPublic as Services } from '../src-ztools/preload/services.mts'

/** 目录级设置覆盖：未设置的项跟随全局偏好 */
export interface DirOverrides {
  conflictStrategy?: Prefs['conflictStrategy']
  ignoreHidden?: boolean
  intervalMin?: number
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
  progress: { filesDone: number; filesTotal: number; bytesDone: number; bytesTotal: number; verifyDone?: number; verifyTotal?: number } | null
  /** 是否启用同步：undefined / true 视为启用，false 时跳过自动与手动同步 */
  enabled?: boolean
  /** 目录级设置覆盖（冲突处理 / 忽略隐藏文件 / 同步间隔），null 表示全部跟随全局 */
  overrides?: DirOverrides | null
  /** 运行时标记：刚完成一次同步（12 秒内展示完成摘要条） */
  justCompleted?: boolean
  /** 【demo/兼容字段】同 conflictFile：仅供演示场景的冲突弹窗展示两侧版本，真实流程不写入 */
  conflictLocal?: { size: number; mtimeMs: number } | null
  conflictRemote?: { size: number; mtimeMs: number } | null
  /** 最近一次同步扫描到的总字节数（用于估算云端占用） */
  lastBytesTotal?: number
  /**
   * 目录级服务器覆盖（调度器「每 origin 并发 1」的分组键）：现有 UI 不写入，
   * 缺省跟随全局 server —— 行为与单服务器形态完全一致（预留多服务器支持）。
   */
  serverUrl?: string | null
  /**
   * 该目录的待处理挂起（后台轮 defer 挂起的冲突 + 批量删除超阈值登记的
   * 「待确认删除」）；kind='delete' 为删除确认类（choice ∈ delete/keep），
   * 缺省为冲突类（choice ∈ local/remote/both）。主界面面板统一展示与处理。
   */
  pendingConflicts?: Array<{ rel: string; createdAt: number; choice?: string; kind?: string }> | null
}

declare global {
  interface Window {
    services: ServicesPublic
    ztools: ZToolsApi
  }
}

export {}
