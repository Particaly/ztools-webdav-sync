/* eslint-disable */
// store-core.ts —— 前端 store 的共享内核：
//   * 模块级单例的唯一承载：state（reactive）、conflictResolvers（冲突等待表）、
//     cancelRequested（取消标记）、persist 防抖定时器 —— 全部消费方（域模块 /
//     store.ts 组合层 / 单测）经 import 引用**同一模块实例**（render-* 单测
//     直依赖此单例语义）；
//   * 纯函数与默认值（defaultPrefs / 路径与档位文案 / 限长截断）；
//   * 持久化管线（persist → 防抖 → dbStorage；loadPersisted 的形状校验）；
//   * 派生 computed 与全局暂停。
// 依赖图叶子（仅依赖 vue / toast / options / types）；域模块与组合层单向依赖本文件。
import { computed, reactive, ref, watch } from 'vue'
import type { ConflictChoice, ConflictInfo, DavCapabilities, DavConfig, DavServerEntry, DavTier, DirOverrides, DirStatus, Prefs, SyncDir, SyncLogEntry, SyncMode } from '../env.d'

export type TestResult = {
  ok: boolean
  latencyMs?: number
  error?: string
  tier?: DavTier | null
  capabilities?: DavCapabilities | null
  /** 云端配额（RFC 4331；服务器未返回时不携带 —— 展示层静默跳过） */
  quota?: { available: number | null; used: number | null }
}
import { toast } from './toast'
import { MIN_INTERVAL_MIN } from './options'
import { ZTOOLS_PLUGINS_DIR_ID } from '../../src-ztools/preload/types.mts'


const STORAGE_KEY = 'webdav-sync:data'
export const GUIDE_URL = 'https://help.jianguoyun.com/?p=2064'

/** 生成短 id */
export function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * 是否「ZTools 插件同步」虚拟行（自动发现目录、配置不可修改、不持久化）。
 * 判定键是 types.mts 的 ZTOOLS_PLUGINS_DIR_ID（前后端单一事实源，调度器按
 * 同一 id 合成 slot），行内状态 / 冲突 / 待处理经既有事件通道按 id 流转。
 */
export function isPluginSyncDir(d: SyncDir): boolean {
  return d.id === ZTOOLS_PLUGINS_DIR_ID
}

/** 默认偏好设置 */
export function defaultPrefs(): Prefs {
  return {
    autoSync: true,
    // 检查频率默认 1 小时（选项里最常用的中低频档；用户显式选过的值不受影响）
    intervalMin: 60,
    conflictStrategy: 'ask',
    ignoreHidden: true,
    concurrency: 4,
    defaultRemoteDir: '',
    // 功能测试目录：'' = 未选择（首次执行功能测试时弹目录选择器让用户指定）
    probeRemoteDir: '',
    verifyMaxBytes: 50 * 1024 * 1024,
    deepVerify: false,
    deepVerifyDays: 7,
    // 目录级租约锁，默认开；关闭后多设备仅靠档位保护
    leaseLock: true,
    // 后台运行：隐藏插件视图时是否继续自动同步；宿主声明恒为 true
    backgroundRunning: true,
    // 用户排除规则：默认空；内置 OS 垃圾规则（.DS_Store 等）不可关闭
    excludePatterns: [],
    // 实验功能：ZTools 插件目录同步（默认关）；发现与平台隔离见 preload 侧
    // ztools-plugins.mts —— 渲染层只持有开关与行级暂停两个 prefs 字段
    ztoolsPluginSync: false,
    ztoolsPluginSyncPaused: false,
    // 全局暂停自动同步（顶栏一键暂停）：0 = 未暂停；-1 = 一直暂停；> 0 = 到期时刻
    globalPauseUntil: 0,
    // 云端存储位置的父目录（'' = 默认云端根；实际同步根 = <该目录>/ztools-plugins/<平台>）
    ztoolsPluginSyncRemoteDir: '',
    // 持久黄色警告的「不再显示」标记（字段语义见 types.mts Prefs 注释）：
    // 情境指纹类关闭后条件变化会重新提示，时间戳类有新挂起会重新提示
    insecureHttpDismissedFor: '',
    tierHintDismissed: '',
    pluginUnavailableDismissed: false,
    registrySyncDismissed: '',
    pendingBarMutedAt: 0,
  }
}

/** 从本地路径推断目录显示名 */
export function baseName(p: string): string {
  const norm = String(p || '').replace(/[\\/]+$/, '')
  const seg = norm.split(/[\\/]/).filter(Boolean)
  return seg.length ? seg[seg.length - 1] : norm
}

/** 从本地路径推断建议的远端目录 */
export function suggestRemote(p: string): string {
  return '/' + baseName(p)
}

/**
 * 规范化远端路径（UI 输入层）：以 / 开头、去尾部斜杠。
 * 刻意与 preload 的 normalizeRemoteKey（store.mts）分层 —— 那是持久化键的
 * 规范化层，额外做反斜杠转正斜杠与 NFC 折叠（基线 / 挂起等键的单一口径）；
 * 本函数只做形态兜底（展示与编辑场景保持用户输入可读原样），且引擎 / 调度器
 * 读侧都会再经 normalizeRemoteKey 归一，这里不必提前折叠。
 */
export function normalizeRemote(p: string): string {
  const t = p.replace(/\/+$/, '')
  return t.startsWith('/') ? t : '/' + t
}

// ---------- 档位文案（A 运行良好 / B 基本可用 / C 仅可下载） ----------

/** 档位短标签（主界面卡片 / 设置页展示）：面向用户的说法，不出现内部档位字母 */
export function tierLabel(t?: DavTier | null): string {
  if (t === 'A') return '运行良好'
  if (t === 'B') return '基本可用'
  if (t === 'C') return '仅可下载'
  return '尚未检测'
}

/** 档位提示文案（B 档的并发安全边界与 C 档的只读说明） */
export function tierHint(t?: DavTier | null): string {
  if (t === 'A') return '这个服务器支持多台设备安全地同时同步'
  if (t === 'B') return '多台设备同时修改同一个文件时，可能互相覆盖。覆盖或删除前会先逐个确认，建议尽量错开使用'
  if (t === 'C') return '服务器不允许上传或删除，目前只会下载云端文件'
  return ''
}

interface PersistShape {
  /** 旧单服务器字段（多服务器形态下 = 活跃服务器条目的同步副本，兼容旧版本读取） */
  server: DavConfig
  /** 服务器列表（多账号 / 多服务器；权威形态，调度器与设置页按此解析） */
  servers?: DavServerEntry[]
  /** 活跃服务器 id（设置页正在编辑 / 主界面卡片展示的那台；缺省 = 第一台） */
  activeServerId?: string
  dirs: SyncDir[]
  prefs: Prefs
}

export const state = reactive({
  route: 'main' as 'main' | 'settings' | 'decisions',
  /**
   * 服务器列表（多账号 / 多服务器）：state.server 恒指向其中的活跃条目
   *（reactive 数组内的代理对象），v-model 直接改写条目、persist 整列表落盘。
   * 恒保至少一条（零配置初态也是一条空白条目）—— 单服务器用户的形态不变。
   */
  servers: [] as DavServerEntry[],
  activeServerId: '',
  /** 活跃服务器条目（servers 内的代理；字段语义与旧单服务器完全一致） */
  server: { serverUrl: '', username: '', password: '' } as DavServerEntry,
  dirs: [] as SyncDir[],
  prefs: defaultPrefs(),
  connected: false, // 服务器可达
  connChecked: false, // 是否已探测过连接
  testing: false,
  testResult: null as TestResult | null,
  /** 最近一次连接测试带出的云端配额（RFC 4331；服务器未返回时为 null —— UI 零行为变化） */
  quota: null as { available: number | null; used: number | null } | null,
  /** 最近一次能力探测结果（档位展示与 B 档提示的来源） */
  capabilities: null as DavCapabilities | null,
  probing: false, // 「重新探测」进行中
  showAdd: false,
  /** 功能测试目录选择弹窗显隐：首次功能测试与设置页「修改测试目录」入口共用 */
  showProbeDirPicker: false,
  conflictQueue: [] as ConflictInfo[],
  activeConflict: null as ConflictInfo | null,
  /** 冲突弹窗「对本轮剩余冲突都这样处理」勾选：置位后本轮后续冲突不再弹窗 */
  conflictApplyAll: false,
  /**
   * 远端根丢失决策弹窗的目标目录 id（null = 关闭）。自动触发统一经 autoPromptRootLost
   *（pending-conflicts 事件、冷启动 / 回窗口 / 轮末兜底刷新等任一数据到手路径），
   * 另有 DirRow 提示条 / 待处理面板 / 待处理中心的「去处理」直达入口；
   * 「暂不处理」只关闭弹窗，决策仍以待处理挂起的形式保留（行内提示条可再进入）。
   */
  rootLostPromptDirId: null as string | null,
  /** 全局待处理中心（PendingCenterModal）显隐；状态栏「N 项待处理」入口打开 */
  pendingCenterOpen: false,
  /**
   * 待直达打开待处理面板的目录 id（null = 无）：待处理中心「去处理」的一次性通道
   *（与 rootLostPromptDirId 同款），对应 DirRow 监听到后打开本地 PendingConflictsModal
   * 并清回 null。
   */
  pendingPanelDirId: null as string | null,
  syncingAll: false,
  demo: false,
  saved: false, // 设置页「保存设置」反馈
  /**
   * 全局实时传输速率（字节/秒；调度器 net-speed 事件驱动，1s 一拍、EMA 平滑）。
   * 纯运行时展示字段：persist 只序列化显式列出的字段，不落盘。
   */
  netSpeed: { upBps: 0, downBps: 0 },
  /**
   * 每目录实时传输速率（同 net-speed 事件携带的 dirs 表；键为目录 id，仅传输中
   * 且近秒产生过流量的目录有值）。纯运行时展示字段，不落盘。
   */
  dirSpeeds: {} as Record<string, { upBps: number; downBps: number }>,
})

/** 冲突解决器的等待表：onConflict 回调据此挂起直到用户选择 */
export const conflictResolvers = new Map<ConflictInfo, (c: ConflictChoice) => void>()

// ---------- 持久化 ----------

/** 错误/冲突列表显式限长（各最多 200 条），单条信息截断防膨胀 */
export const MAX_LIST_ITEMS = 200
const MAX_MSG_LEN = 2000

/** 限长单个字符串（错误信息等） */
export function capStr(s: unknown, max = MAX_MSG_LEN): string {
  const t = typeof s === 'string' ? s : String(s ?? '')
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 限长数组（错误 / 冲突列表），超出部分丢弃并附加计数条目 */
export function capList<T>(items: T[] | null | undefined, renderDropped: (n: number) => T): T[] {
  if (!items || items.length <= MAX_LIST_ITEMS) return items ?? []
  return [...items.slice(0, MAX_LIST_ITEMS), renderDropped(items.length - MAX_LIST_ITEMS)]
}

/** 持久化前的显式限长：lastResult 摘要中的列表与错误信息都有硬上限，写入体积有界 */
export function sanitizeDirForPersist(d: SyncDir): SyncDir {
  const out: SyncDir = { ...d, progress: null, pendingConflicts: null, deleteBatch: null, status: (d.status === 'syncing' ? 'idle' : d.status) as DirStatus }
  out.errorMessage = d.errorMessage != null ? capStr(d.errorMessage) : null
  out.errorDetail = d.errorDetail != null ? capStr(d.errorDetail) : null
  if (d.lastResult) {
    out.lastResult = {
      ...d.lastResult,
      errors: capList(d.lastResult.errors, (n) => `（另有 ${n} 条错误未显示）`),
      warnings: capList(d.lastResult.warnings, (n) => `（另有 ${n} 条提示未显示）`),
    }
  }
  return out
}

export function persist() {
  const plain: PersistShape = JSON.parse(
    JSON.stringify({
      // 密码混淆落盘：preload 的 AES-256-GCM sealSecret（同步接口）。
      // 防随手窥视而非强加密（密钥与密文同机，已知边界）；
      // 无 preload（浏览器预览）时原样保存 —— 演示形态无真实凭据。
      // servers[] 为权威形态（逐条混淆）；server 字段 = 活跃条目的同步副本，
      // 旧版本插件（只认单 server）降级运行时仍可用。
      server: (() => {
        const sv = { ...state.server }
        const sec = window.services?.secure
        if (sec && typeof sv.password === 'string') sv.password = sec.sealSecret(sv.password)
        return sv
      })(),
      servers: (() => {
        const sec = window.services?.secure
        return state.servers.map((sv) => {
          const out = { ...sv }
          if (sec && typeof out.password === 'string') out.password = sec.sealSecret(out.password)
          return out
        })
      })(),
      activeServerId: state.activeServerId,
      // 进度等运行时字段不入库；入库字段显式限长（见 sanitizeDirForPersist）。
      // 【实验：ZTools 插件同步】虚拟行不持久化（dirs 里过滤）—— 调度器每次
      // reload 都按 prefs 开关现场合成同 id 的目录，配置权威只有 prefs
      dirs: state.dirs.filter((d) => !isPluginSyncDir(d)).map(sanitizeDirForPersist),
      prefs: state.prefs,
    })
  )
  try {
    if (window.ztools?.dbStorage) {
      window.ztools.dbStorage.setItem(STORAGE_KEY, plain)
      // 配置权威只有 dbStorage —— 保存后通知 preload 调度器重读（自动同步的
      // 目录列表 / 间隔 / 偏好变更由调度器自行重建，不做渲染层推送配置）
      const sched = window.services?.scheduler
      if (sched) void sched.reload().catch(() => {})
      return
    }
  } catch (_) {
    /* 回退 localStorage */
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(plain))
  } catch (_) {
    /* 忽略 */
  }
}

// ---------- persist 的防抖与冲刷（设置页连续编辑的合并落盘） ----------

/** 设置编辑防抖间隔（ms）：连续击键合并为一次全量深克隆 + 调度器 reload（350–500ms 均可） */
const PERSIST_DEBOUNCE_MS = 400

/** 挂起的防抖 timer（null = 无挂起；模块级单例，flushPersist 据此判空 no-op） */
let persistTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 防抖版 persist（尾沿 400ms）：只服务设置页 v-model 直连 state 的连续编辑
 *（prefs / servers / dirs 三个序列化 watch 与 addServer / removeServer）——
 * 每次击键都全量深克隆（JSON.parse(JSON.stringify(全量))）+ sched.reload
 *（loadConfig 解密 + hash16 + 重建 slots）在快速输入时是纯浪费；合并成一次
 * 既够新鲜（400ms 远小于调度器 1s tick）又不丢语义。
 * 不变量：防抖只合并连续编辑；承重路径（activeServerId 写入、暂停/恢复、轮末
 * lastSyncAt 落盘、调度器握手前的归一化、demo）仍直接调 persist 立即生效 ——
 * 新调用点若被调度器 / 跨重启的读者依赖时序，走 persist 而不是这里。
 * 尾沿丢尾由 flushPersist 兜底（plugin-out / pagehide / 视图隐藏时冲刷）。
 */
export function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    persistTimer = null
    persist()
  }, PERSIST_DEBOUNCE_MS)
}

/**
 * 冲刷挂起的防抖 persist（无挂起时 no-op）：视图关闭 / 隐藏前调用 —— 宿主隐藏时
 * 渲染层定时器被节流（Blink 钳制），挂起的尾沿 timer 可能被无限推迟甚至永不触发
 *（close/destroy 不发任何卸载事件，见 scheduler.mts 头注释），最后一次编辑必须
 * 在失去执行机会前落盘。判空保证重复调用（plugin-out / pagehide / visibilitychange
 * 多通道先到先冲、后到者 no-op）不会产生多余的 persist。
 */
export function flushPersist(): void {
  if (!persistTimer) return
  clearTimeout(persistTimer)
  persistTimer = null
  persist()
}

export function loadPersisted(): PersistShape | null {
  try {
    const raw = window.ztools?.dbStorage ? window.ztools.dbStorage.getItem<PersistShape>(STORAGE_KEY) : null
    if (raw) return raw
  } catch (_) {
    /* 回退 localStorage */
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as PersistShape) : null
  } catch (_) {
    return null
  }
}

// ---------- 派生 ----------

/** 已配置任一服务器（多服务器形态：任一台填了地址即可同步 —— 各目录按 serverId 各自取用） */
export const configured = computed(() => state.servers.some((s) => String(s.serverUrl || '').trim()))
export const connStatus = computed<'connected' | 'disconnected' | 'unconfigured'>(() => {
  if (!configured.value) return 'unconfigured'
  return state.connected ? 'connected' : 'disconnected'
})
export const activeConflict = computed(() => state.activeConflict)
/**
 * 【demo/兼容】处于 'conflict' 状态的目录数。真实同步的冲突经引擎 onConflict 队列
 * 即时处理，runSync 不会把目录置为 'conflict'，因此真实流程中恒为 0；
 * 仅 ?demo= 演示场景（如状态栏角标）非零。
 */
export const conflictPendingCount = computed(() => state.dirs.filter((d) => d.status === 'conflict').length)
export const anySyncing = computed(() => state.dirs.some((d) => d.status === 'syncing'))
export const lastSyncAt = computed(() =>
  state.dirs.reduce<number | null>((acc, d) => Math.max(acc ?? 0, d.lastSyncAt ?? 0) || acc, null)
)
/** 云端占用估算：各目录最近一次同步扫描到的总字节 */
export const cloudBytes = computed(() => state.dirs.reduce((acc, d) => acc + (d.lastBytesTotal ?? 0), 0))
/**
 * http 明文连接判定：服务器地址以 http:// 开头且主机非本机回环。
 * 明文连接下密码（Basic 认证）与文件内容可被网络中间人窃听 —— UI 逐处给出
 * 警告，但不阻止使用（内网自建服务器 / 调试场景合法）。
 */
export const insecureHttp = computed(() => {
  const u = state.server.serverUrl.trim()
  if (!/^http:\/\//i.test(u)) return false
  try {
    const host = new URL(u).hostname.toLowerCase()
    return !(host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1')
  } catch {
    return true
  }
})

// ---------- 全局暂停自动同步（顶栏一键暂停） ----------

/**
 * 暂停剩余时间展示用的跳动时钟：仅暂停期间运转的 30s 周期 ref，驱动
 * autoSyncPaused / pauseRemainingText 随时间翻转（到期自动显示为未暂停，
 * 调度器侧由到期定时器自行恢复，渲染层不承担恢复动作）。
 */
const pauseTicker = ref(0)
let pauseTickerTimer: ReturnType<typeof setInterval> | null = null
export function ensurePauseTicker(): void {
  if (pauseTickerTimer) return
  pauseTicker.value = Date.now()
  pauseTickerTimer = setInterval(() => {
    pauseTicker.value = Date.now()
    if (!autoSyncPaused.value) stopPauseTicker()
  }, 30000)
}
function stopPauseTicker(): void {
  if (pauseTickerTimer) {
    clearInterval(pauseTickerTimer)
    pauseTickerTimer = null
  }
}

/** 全局暂停到期时刻（已归一）：0 = 未暂停；-1 = 一直暂停；> 0 = 到期 epoch ms */
export const globalPauseUntil = computed(() => {
  pauseTicker.value // 依赖跳动时钟：到期瞬间本计算自动翻转
  const p = Number(state.prefs.globalPauseUntil)
  if (!Number.isFinite(p) || p === 0) return 0
  if (p === -1) return -1
  return p > Date.now() ? p : 0
})
/** 自动同步是否处于全局暂停中（手动「立即同步」不受影响，见 scheduler.dirEligible） */
export const autoSyncPaused = computed(() => globalPauseUntil.value !== 0)
/** 顶栏状态位的暂停文案（title 里带恢复时机） */
export const pauseStatusText = computed(() => {
  const until = globalPauseUntil.value
  if (until === -1) return '已暂停同步'
  const remainMs = until - (pauseTicker.value || Date.now())
  const min = Math.max(1, Math.round(remainMs / 60000))
  const remain = min >= 60 ? `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分` : ''}` : `${min} 分钟`
  return `已暂停同步，约 ${remain} 后自动恢复`
})

/**
 * 一键暂停自动同步（顶栏下拉）：durationMs = 暂停时长；0 = 一直暂停（手动恢复）。
 * 持久化后调度器经 reload 感知：自动轮不排、watcher 摘除；手动「立即同步」不受影响。
 */
export function pauseAutoSync(durationMs: number): void {
  state.prefs.globalPauseUntil = durationMs > 0 ? Date.now() + durationMs : -1
  ensurePauseTicker()
  // 立即 persist（不防抖）：暂停必须让调度器当场经 reload 感知（自动轮不排 /
  // watcher 摘除），防抖窗口内后台轮照跑违背用户意图；且暂停起始时刻参与到期
  // 计算，晚落盘等于少暂停同样的时长
  persist()
}
/** 恢复自动同步：清暂停标记；调度器经 reload 感知迁移并对有资格目录短抖动内补跑一轮 */
export function resumeAutoSync(): void {
  if (state.prefs.globalPauseUntil === 0) return
  state.prefs.globalPauseUntil = 0
  stopPauseTicker()
  // 立即 persist（不防抖）：恢复同样要调度器立即 reload 感知并尽快补跑一轮 ——
  // 单次点击操作无连续编辑可合并，防抖只是徒增延迟
  persist()
}

/** 请求取消标记表（runSync 的 shouldAbort 据此轮询；调度器在线时经其 cancel 通道） */
export const cancelRequested = new Set<string>()
