import { computed, reactive, watch } from 'vue'
import type {
  ConflictChoice,
  ConflictInfo,
  DavCapabilities,
  DavConfig,
  DavTier,
  DirOverrides,
  DirStatus,
  Prefs,
  RegistryReconcileResult,
  SchedulerEvent,
  SchedulerSlotView,
  SyncDir,
  SyncMode,
  SyncSummary,
  ZtoolsPluginsSyncDesc,
} from '../env.d'
import { toast } from './toast'
import { MIN_INTERVAL_MIN } from './options'

const STORAGE_KEY = 'webdav-sync:data'
const GUIDE_URL = 'https://help.jianguoyun.com/?p=2064'

/** 生成短 id */
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/**
 * 【实验：ZTools 插件同步】虚拟行的固定 id —— 镜像 preload 侧
 * ztools-plugins.mts 的 ZTOOLS_PLUGINS_DIR_ID（渲染层无 Node 能力，不能运行时
 * 导入该模块；两处字面量必须一起改）。调度器按同一 id 合成 slot，行内状态 /
 * 冲突 / 待处理经既有事件通道（按 id 匹配）自动流转。
 */
const PLUGIN_SYNC_DIR_ID = 'ztools-plugins'

/** 是否「ZTools 插件同步」虚拟行（自动发现目录、配置不可修改、不持久化） */
export function isPluginSyncDir(d: SyncDir): boolean {
  return d.id === PLUGIN_SYNC_DIR_ID
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

/** 规范化远端路径：以 / 开头、去尾部斜杠 */
function normalizeRemote(p: string): string {
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
  server: DavConfig
  dirs: SyncDir[]
  prefs: Prefs
}

const state = reactive({
  route: 'main' as 'main' | 'settings' | 'decisions',
  server: { serverUrl: '', username: '', password: '' } as DavConfig,
  dirs: [] as SyncDir[],
  prefs: defaultPrefs(),
  connected: false, // 服务器可达
  connChecked: false, // 是否已探测过连接
  testing: false,
  testResult: null as TestResult | null,
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
  cloudUsage: '' as string, // 设置页「云端占用」展示值
  saved: false, // 设置页「保存设置」反馈
})

/** 冲突解决器的等待表：onConflict 回调据此挂起直到用户选择 */
const conflictResolvers = new Map<ConflictInfo, (c: ConflictChoice) => void>()

// ---------- 持久化 ----------

/** 错误/冲突列表显式限长（各最多 200 条），单条信息截断防膨胀 */
const MAX_LIST_ITEMS = 200
const MAX_MSG_LEN = 2000

/** 限长单个字符串（错误信息等） */
function capStr(s: unknown, max = MAX_MSG_LEN): string {
  const t = typeof s === 'string' ? s : String(s ?? '')
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** 限长数组（错误 / 冲突列表），超出部分丢弃并附加计数条目 */
function capList<T>(items: T[] | null | undefined, renderDropped: (n: number) => T): T[] {
  if (!items || items.length <= MAX_LIST_ITEMS) return items ?? []
  return [...items.slice(0, MAX_LIST_ITEMS), renderDropped(items.length - MAX_LIST_ITEMS)]
}

/** 持久化前的显式限长：lastResult 摘要中的列表与错误信息都有硬上限，写入体积有界 */
function sanitizeDirForPersist(d: SyncDir): SyncDir {
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

function persist() {
  const plain: PersistShape = JSON.parse(
    JSON.stringify({
      // 密码混淆落盘：preload 的 AES-256-GCM sealSecret（同步接口）。
      // 防随手窥视而非强加密（密钥与密文同机，README 已知边界如实说明）；
      // 无 preload（浏览器预览）时原样保存 —— 演示形态无真实凭据。
      server: (() => {
        const sv = { ...state.server }
        const sec = window.services?.secure
        if (sec && typeof sv.password === 'string') sv.password = sec.sealSecret(sv.password)
        return sv
      })(),
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

function loadPersisted(): PersistShape | null {
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

const configured = computed(() => !!state.server.serverUrl.trim())
const connStatus = computed<'connected' | 'disconnected' | 'unconfigured'>(() => {
  if (!configured.value) return 'unconfigured'
  return state.connected ? 'connected' : 'disconnected'
})
const activeConflict = computed(() => state.activeConflict)
/**
 * 【demo/兼容】处于 'conflict' 状态的目录数。真实同步的冲突经引擎 onConflict 队列
 * 即时处理，runSync 不会把目录置为 'conflict'，因此真实流程中恒为 0；
 * 仅 ?demo= 演示场景（如状态栏角标）非零。
 */
const conflictPendingCount = computed(() => state.dirs.filter((d) => d.status === 'conflict').length)
const anySyncing = computed(() => state.dirs.some((d) => d.status === 'syncing'))
const lastSyncAt = computed(() =>
  state.dirs.reduce<number | null>((acc, d) => Math.max(acc ?? 0, d.lastSyncAt ?? 0) || acc, null)
)
/** 云端占用估算：各目录最近一次同步扫描到的总字节 */
const cloudBytes = computed(() => state.dirs.reduce((acc, d) => acc + (d.lastBytesTotal ?? 0), 0))
/**
 * http 明文连接判定：服务器地址以 http:// 开头且主机非本机回环。
 * 明文连接下密码（Basic 认证）与文件内容可被网络中间人窃听 —— UI 逐处给出
 * 警告，但不阻止使用（内网自建服务器 / 调试场景合法）。
 */
const insecureHttp = computed(() => {
  const u = state.server.serverUrl.trim()
  if (!/^http:\/\//i.test(u)) return false
  try {
    const host = new URL(u).hostname.toLowerCase()
    return !(host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1')
  } catch {
    return true
  }
})

// ---------- 连接 ----------

/** 测试连接结果（附带档位与能力摘要，字段向后兼容） */
type TestResult = { ok: boolean; latencyMs?: number; error?: string; tier?: DavTier | null; capabilities?: DavCapabilities | null }

/**
 * 测试连接（设置页 / 主界面卡片按钮）。
 * 结果会回写 state（testResult / connected / capabilities）并默认弹顶部通知：
 * 成功展示延迟，失败展示原因；preload 抛出的异常也兜底为失败通知。
 * @param opts.notify 结果是否以顶部通知反馈，启动时的自动探测传 false 静默执行
 */
async function testConnection(opts?: { notify?: boolean }): Promise<TestResult> {
  const notify = opts?.notify !== false

  // 未填地址：直接提示，不打扰后端
  if (!state.server.serverUrl.trim()) {
    if (notify) toast.warning('请先填写服务器地址', '填写服务器地址后才能测试连接')
    return { ok: false, error: '未填写服务器地址' }
  }

  let result: TestResult
  if (!window.services) {
    // 纯浏览器预览（无 preload）时的模拟
    await new Promise((r) => setTimeout(r, 400))
    const ok = state.server.serverUrl.startsWith('https://')
    result = ok ? { ok: true, latencyMs: 128 } : { ok: false, error: '服务器返回 HTTP 401' }
  } else {
    state.testing = true
    try {
      // 附带能力摘要按已选测试目录取（未选择时为基址），档位展示口径与「功能测试」一致
      result = await window.services.dav.testConnection(state.server, state.prefs.probeRemoteDir || undefined)
    } catch (e) {
      // 网络异常等 preload 抛错同样要给出可见反馈，而不是静默失败
      result = { ok: false, error: e instanceof Error ? e.message : String(e) }
    } finally {
      state.testing = false
    }
  }

  state.testResult = result
  state.connected = result.ok
  state.connChecked = true
  // 保存最近一次探测结果（档位展示来源；探测失败保留 null）
  if (result.capabilities) state.capabilities = result.capabilities

  if (notify) {
    if (result.ok) toast.success('连接成功', `服务器响应 ${result.latencyMs ?? 0} 毫秒`)
    else toast.error('连接失败', result.error || '连不上服务器，请检查地址、用户名和密码')
  }
  return result
}

/**
 * 重新探测服务器能力与档位（设置页「功能测试」入口）。
 * 复用 preload 的 probeCapabilities(cfg, force=true, remotePath)：忽略缓存现场实测，
 * 结果写回 state.capabilities 并以通知反馈档位结论。
 * 探测目标为用户指定的测试目录（prefs.probeRemoteDir）—— WebDAV 服务器不同子树
 * 的写权限可能不同，根目录不一定可写，写权限必须按用户认可的目录实测；尚未选择
 * 测试目录时（首次功能测试）先弹远端目录选择器，确认后自动开始本次测试。
 */
async function reprobe(): Promise<void> {
  if (!state.server.serverUrl.trim()) {
    toast.warning('请先填写服务器地址', '填写服务器地址后才能检测服务器')
    return
  }
  if (!window.services) {
    toast.warning('当前环境不可用', '浏览器预览模式没有连接服务器的能力')
    return
  }
  if (!state.prefs.probeRemoteDir) {
    state.showProbeDirPicker = true
    return
  }
  state.probing = true
  try {
    const caps = await window.services.dav.probeCapabilities({ ...state.server }, true, state.prefs.probeRemoteDir)
    state.capabilities = caps
    toast.success(`检测完成：${tierLabel(caps.tier)}`, tierHint(caps.tier))
  } catch (e) {
    toast.error('检测失败', e instanceof Error ? e.message : String(e))
  } finally {
    state.probing = false
  }
}

/**
 * 确认功能测试目录（首次功能测试的选择与设置页「修改测试目录」共用入口）。
 * 写入 prefs.probeRemoteDir（经 prefs 深度 watch 自动持久化）并立即以新目录执行
 * 一次功能测试 —— 换目录的动机通常是原目录不可写，当场重测直接给出结论；
 * 选择了相同目录时只关闭弹窗，不重复发起探测。
 * @param path 远端目录选择器回传的绝对路径（以 / 开头；容错补齐缺省的起始斜杠）
 */
function confirmProbeDir(path: string) {
  state.showProbeDirPicker = false
  const p = String(path || '').trim()
  if (!p || p === state.prefs.probeRemoteDir) return
  state.prefs.probeRemoteDir = p.startsWith('/') ? p : '/' + p
  void reprobe()
}

// ---------- 同步 ----------

/** 目录是否启用（历史数据无该字段，视为启用） */
export function dirEnabled(d: SyncDir): boolean {
  return d.enabled !== false
}

/** 目录生效的自动同步开关：目录级覆盖优先，否则跟随全局偏好。关闭后该目录只手动同步 */
export function dirAutoSyncOn(d: SyncDir): boolean {
  return d.overrides?.autoSync ?? state.prefs.autoSync
}

/** 目录生效的同步间隔：目录级覆盖优先，否则跟随全局偏好 */
export function dirIntervalMin(d: SyncDir): number {
  return d.overrides?.intervalMin ?? state.prefs.intervalMin
}

/**
 * 目录生效的同步参数（供引擎调用与界面展示）：目录级覆盖（overrides）优先，
 * 未覆盖的项回落全局偏好。口径必须与 preload 调度器 prefsOf 保持一致 ——
 * 两处分别服务「无调度器直调引擎」与「调度器自动轮」两条路径。
 * 限速（ratePerSec）不在其中：它属于网络层参数，经 dirEngineCfg 注入 netOpts。
 */
export function dirSyncPrefs(d: SyncDir) {
  const o = d.overrides
  return {
    ignoreHidden: o?.ignoreHidden ?? state.prefs.ignoreHidden,
    concurrency: o?.concurrency ?? state.prefs.concurrency,
    conflictStrategy: o?.conflictStrategy ?? state.prefs.conflictStrategy,
    verifyMaxBytes: state.prefs.verifyMaxBytes,
    deepVerify: o?.deepVerify ?? state.prefs.deepVerify,
    deepVerifyDays: state.prefs.deepVerifyDays,
    adoptVerifyBudgetBytes: state.prefs.adoptVerifyBudgetBytes,
    leaseLock: o?.leaseLock ?? state.prefs.leaseLock,
    excludePatterns: o?.excludePatterns ?? state.prefs.excludePatterns,
  }
}

/**
 * 目录生效的引擎连接配置：全局 server 之上应用目录级网络层覆盖
 *（当前仅 ratePerSec 限速；显式数值直接覆盖全局 netOpts 与档案默认的分层口径，
 * 未设置时保持全局原样 —— 引擎 resolveNetOpts 按既有分层生效）。
 */
export function dirEngineCfg(d: SyncDir): DavConfig {
  const cfg: DavConfig = { ...state.server }
  if (d.overrides?.ratePerSec != null) {
    cfg.netOpts = { ...cfg.netOpts, ratePerSec: d.overrides.ratePerSec }
  }
  return cfg
}

/** 用户请求取消同步的目录 id 集合：runSync 经 shouldAbort 注入引擎，轮末 finally 统一清除 */
const cancelRequested = new Set<string>()

/**
 * 请求取消某目录的进行中同步：置位取消标记并提示；
 * 引擎在下一个检查点以「同步已中止」收场，runSync 的 catch 据此把目录状态回置 idle（非 error）。
 * 取消会即时中断在途传输（引擎销毁请求与读写流），而不是「等当前文件传完」。
 * 调度器在线时经其 cancel 通道（调度轮与 runSync 直调轮共用引擎取消语义）。
 */
function cancelSync(id: string) {
  const sched = window.services?.scheduler
  if (sched && !state.demo) {
    sched.cancel(id)
    toast.info('正在取消同步…', '正在停止，正在传输的文件会被中断')
    return
  }
  if (cancelRequested.has(id)) return
  cancelRequested.add(id)
  toast.info('正在取消同步…', '正在停止，正在传输的文件会被中断')
}

/**
 * 执行一次目录同步的完整流程：状态机 syncing → synced | error。
 * 引擎侧语义：每个文件验证成功即写本机基线；文件级失败不再回滚其他文件，
 * 但轮末以 error 状态上报（err.summary 携带成功部分计数，err.errors / errorsDropped 为失败清单）。
 * 真实同步的冲突由引擎 onConflict 回调经 conflictQueue 即时弹窗处理（见 resolveConflict），
 * 弹窗勾选「对本轮剩余冲突都这样处理」后，本轮后续冲突直接按该选择解决，不再弹窗。
 * opts.conflictStrategy 可覆盖目录冲突策略（手动冲突处理入口复用同一条状态机）。
 * opts.op 携带一次单向操作（'pull' = 「云端补齐本地」/ 'pull-full' = 「云端覆盖
 * 本地」/ 'push' = 「本地补齐云端」/ 'push-full' = 「本地覆盖云端」）：经引擎
 * hints.op 注入本轮规划 —— 补齐档恢复本端缺失、保留本端多出与改动；覆盖档以
 * 选定侧为准镜像对侧。无调度器形态（浏览器预览 / 降级直调引擎）时由本函数注入
 * hints，与调度器路径同一语义。
 */
async function runSync(dir: SyncDir, opts?: { conflictStrategy?: Prefs['conflictStrategy']; op?: 'pull' | 'push' | 'pull-full' | 'push-full' }) {
  dir.status = 'syncing'
  dir.errorMessage = null
  dir.progress = { filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 }
  try {
    const prefs = dirSyncPrefs(dir)
    if (opts?.conflictStrategy) prefs.conflictStrategy = opts.conflictStrategy
    const summary = await window.services.sync.syncDirectory(
      dirEngineCfg(dir),
      { id: dir.id, localPath: dir.localPath, remotePath: dir.remotePath, mode: dir.mode },
      prefs,
      {
        onProgress: (p) => {
          // verifyDone / verifyTotal：规划期内容校验进度的可选透传（UI 不强制展示，数据要在）；
          // stage / currentOp / currentFile / scanBytesTotal：细分阶段与当前任务，
          // 供 DirRow 折算「前置 10% + 传输字节 80% + 后置 10%」并展示「正在…」文案
          dir.progress = {
            filesDone: p.filesDone,
            filesTotal: p.filesTotal,
            bytesDone: p.bytesDone,
            bytesTotal: p.bytesTotal,
            verifyDone: p.verifyDone,
            verifyTotal: p.verifyTotal,
            stage: p.stage,
            currentOp: p.currentOp,
            currentFile: p.currentFile,
            scanBytesTotal: p.scanBytesTotal,
          }
          // 云端占用估算取「扫描到的全部文件字节」；bytesTotal 已改为传输字节口径，不再作占用来源
          if (p.scanBytesTotal) dir.lastBytesTotal = p.scanBytesTotal
        },
        onConflict: (info) =>
          new Promise<ConflictChoice>((resolve) => {
            state.conflictQueue.push(info)
            if (!state.activeConflict) state.activeConflict = state.conflictQueue[0]
            conflictResolvers.set(info, resolve)
          }),
        shouldAbort: () => cancelRequested.has(dir.id),
        hints: { source: 'manual', ...(opts?.op ? { op: opts.op } : {}) },
      }
    )
    dir.lastResult = summary
    // 云端占用估算：扫描到的全部文件字节（progress 已随轮末清空，这里最后留存一次）
    dir.lastBytesTotal = dir.progress?.scanBytesTotal ?? dir.lastBytesTotal
    dir.lastSyncAt = Date.now()
    dir.justCompleted = true
    dir.conflictFile = null
    dir.status = 'synced'
    // 引擎提示（快照损坏降级 / 指纹不稳定 / 消歧超限）：有则提示一次，不打断结果状态
    if (summary.warnings?.length) {
      toast.warning(summary.warnings[0], summary.warnings.length > 1 ? `另有 ${summary.warnings.length - 1} 条提示` : undefined)
    }
    setTimeout(() => {
      dir.justCompleted = false
    }, 12000)
  } catch (e) {
    // 用户主动取消：目录状态回置 idle（非 error）、不保留报错；
    // 引擎附带的 e.summary（已成功部分的计数）仍写入 lastResult 供摘要条展示
    if (cancelRequested.has(dir.id)) {
      dir.status = 'idle'
      dir.errorMessage = null
      const cancelSummary = (e as { summary?: SyncSummary }).summary
      if (cancelSummary) dir.lastResult = cancelSummary
      dir.lastSyncAt = Date.now()
      toast.info('已取消同步')
    } else {
      dir.status = 'error'
      const msg = e instanceof Error ? e.message : String(e)
      // 部分成功场景：err.summary 是引擎附带的完整计数，errorMessage 仍取首个失败原因；
      // 技术细节（HTTP 码 / 路径 / 原始报错）进 errorDetail，界面悬浮 title 展示
      const summary = (e as { summary?: SyncSummary }).summary
      dir.errorMessage = capStr(msg)
      dir.errorDetail = capStr((e as { detail?: unknown }).detail != null ? String((e as { detail?: unknown }).detail) : '')
      if (summary) dir.lastResult = summary
      dir.lastSyncAt = Date.now()
    }
  } finally {
    // 本轮结束：清除取消标记（无论是否真的走了取消路径），避免残留影响下一轮
    cancelRequested.delete(dir.id)
    dir.progress = null
    // 本轮结束：清空「应用到全部」勾选，下一轮冲突重新询问
    state.conflictApplyAll = false
    persist()
  }
}

/**
 * 同步单个目录：调度器在线时经其手动通道（直插队首）；进度 / 冲突 / 状态全部来自订阅事件。
 * opts.op 携带一次单向操作（'pull' = 「云端补齐本地」/ 'pull-full' = 「云端覆盖
 * 本地」/ 'push' = 「本地补齐云端」/ 'push-full' = 「本地覆盖云端」）：调度器路径
 * 经 syncNow 透传给引擎（补齐档恢复本端缺失、保留本端多出与改动；覆盖档以选定
 * 侧为准镜像对侧）；无调度器形态退回 runSync 直调引擎注入 hints。演示模式忽略
 * op（同一模拟过程）。
 */
async function syncDir(dir: SyncDir, opts?: { op?: 'pull' | 'push' | 'pull-full' | 'push-full' }) {
  if (!configured.value || dir.status === 'syncing' || !dirEnabled(dir)) return

  // 浏览器演示模式（无 preload）：模拟一次同步过程，便于预览「立即同步」交互
  if (!window.services) {
    if (!state.demo) return
    dir.status = 'syncing'
    dir.errorMessage = null
    const total = 10
    for (let i = 1; i <= total; i++) {
      await new Promise((r) => setTimeout(r, 120))
      dir.progress = { filesDone: i, filesTotal: total, bytesDone: i * 82000, bytesTotal: total * 82000 }
    }
    dir.lastResult = { uploaded: 6, downloaded: 4, deleted: 0, conflicts: 0, deferredConflicts: 0, adopted: 0, bytesUp: 6 * 82000, bytesDown: 4 * 82000, totalFiles: total, warnings: [], errors: [], errorsDropped: 0 }
    dir.lastBytesTotal = total * 82000
    dir.lastSyncAt = Date.now()
    dir.justCompleted = true
    dir.conflictFile = null
    dir.status = 'synced'
    dir.progress = null
    setTimeout(() => {
      dir.justCompleted = false
    }, 12000)
    return
  }

  // 调度器在线（真实宿主形态）—— 手动同步经调度器排队执行；本函数返回后
  // 状态由 round-end 事件收尾（含委托 / 兜底路径）。调度器缺失时退回直调引擎。
  const sched = window.services.scheduler
  if (sched && !state.demo) {
    dir.status = 'syncing'
    dir.errorMessage = null
    dir.progress = { filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 }
    try {
      await sched.syncNow(dir.id, opts?.op ? { op: opts.op } : undefined)
    } catch (e) {
      // syncNow 的明确拒绝（未就绪 / 未配置 / 目录不存在）：目录置错误并提示
      dir.status = 'error'
      dir.errorMessage = capStr(e instanceof Error ? e.message : String(e))
      dir.progress = null
    }
    return
  }
  await runSync(dir, opts)
}

/** 顺序同步全部目录（带宽友好，与设计稿的「单目录进度」一致）；已禁用的目录跳过 */
async function syncAll() {
  if (state.syncingAll || !configured.value) return
  state.syncingAll = true
  try {
    const sched = window.services?.scheduler
    if (sched && !state.demo) {
      try {
        await sched.syncNow()
      } catch (e) {
        toast.error('同步失败', e instanceof Error ? e.message : String(e))
      }
      return
    }
    for (const d of state.dirs) {
      if (dirEnabled(d)) await syncDir(d)
    }
  } finally {
    state.syncingAll = false
  }
}

// ---------- 目录管理 ----------

// ----------【实验：ZTools 插件同步】虚拟行 ----------
//
// 开关（prefs.ztoolsPluginSync）开启时，同步列表追加一条固定 id 的虚拟行：
// 本地目录由 preload 自动发现（~/.ztools/plugins，用户不可修改）、远端目录 =
// 用户可选的云端父目录（prefs.ztoolsPluginSyncRemoteDir，设置页「云端文件夹」）
// 之后固定跟上 ztools-plugins/<platformKey> 两段。行与普通目录完全同构 —— 调度器
// slot / 轮末事件 / 冲突与待处理面板经同一 id 通道流转；差异只有三点：
//   1. 不持久化（persist 与 dirs watch 均过滤；调度器 reload 时按开关现场合成）；
//   2. 配置不可修改（updateDir / setDirOverrides 对虚拟行 no-op，UI 也不给入口）；
//   3. 启停走 prefs.ztoolsPluginSyncPaused（setDirEnabled 路由），删除即关开关。

/**
 * 维护「ZTools 插件同步」虚拟行：开关关闭时移除；开启时经 preload 的
 * describe() 取自动发现结果注入（已存在则只刷新配置字段与 enabled，运行时
 * 状态 —— status / lastResult / 挂起列表等 —— 原样保留）。云端父目录随 prefs
 * 传入：更换位置后行的远端路径即时跟随，调度器经 reload 用同一参数合成 slot。
 * 无 preload（浏览器预览）或 describe 不可用时保持现状：行不出现，开关仍可
 * 保存（回到宿主环境后 init / 切换开关时补上）。
 * 注入后异步刷新注册表对账状态（registrySync）：对账走 IPC（内部 API），describe
 * 是同步发现拿不到 —— 未授权 / 旧宿主的降级提示由此补齐（refreshPluginRegistryState）。
 */
function refreshPluginSyncRow() {
  const idx = state.dirs.findIndex((d) => isPluginSyncDir(d))
  if (!state.prefs.ztoolsPluginSync) {
    if (idx >= 0) state.dirs.splice(idx, 1)
    return
  }
  let desc: ZtoolsPluginsSyncDesc | null = null
  try {
    desc = window.services?.ztoolsPlugins?.describe?.(state.prefs.ztoolsPluginSyncRemoteDir || undefined) ?? null
  } catch {
    desc = null
  }
  if (!desc) return
  const enabled = state.prefs.ztoolsPluginSyncPaused !== true
  if (idx >= 0) {
    const row = state.dirs[idx]
    row.name = 'ZTools 插件'
    row.localPath = desc.pluginsDir
    row.remotePath = desc.remotePath
    row.mode = 'two-way'
    row.enabled = enabled
    // registrySync 是异步注入字段：重建 desc 时保留上次探测结果，避免提示条闪烁
    row.pluginSyncInfo = { ...desc, registrySync: row.pluginSyncInfo?.registrySync }
    return
  }
  state.dirs.push({
    id: PLUGIN_SYNC_DIR_ID,
    name: 'ZTools 插件',
    localPath: desc.pluginsDir,
    remotePath: desc.remotePath,
    mode: 'two-way',
    status: 'idle',
    lastSyncAt: null,
    lastResult: null,
    conflictFile: null,
    errorMessage: null,
    progress: null,
    enabled,
    pluginSyncInfo: desc,
  })
  void refreshPluginRegistryState()
}

/**
 * 异步刷新虚拟行的注册表对账状态（registrySync）：读 preload 侧最近一次对账
 * 结果（调度器轮末 / init 时触发，本函数只读不触发对账），把降级形态合并进
 * 行的 pluginSyncInfo 供 DirRow 提示条渲染。无 preload / 尚未对账过（null）时
 * 保持现状 —— 提示条不出现（尚未对账意味着尚未同步，先让位给行级状态）。
 */
async function refreshPluginRegistryState() {
  if (!state.prefs.ztoolsPluginSync) return
  const row = state.dirs.find((d) => isPluginSyncDir(d))
  if (!row) return
  let st: (RegistryReconcileResult & { at: number }) | null = null
  try {
    st = window.services?.ztoolsPlugins?.registryState?.() ?? null
  } catch {
    st = null
  }
  if (!st) return
  const registrySync =
    st.status === 'ok' || st.status === 'noop'
      ? 'ok'
      : st.status === 'pending'
        ? 'pending'
        : st.status === 'denied'
          ? 'denied'
          : st.status === 'unavailable'
            ? 'unavailable'
            : undefined
  if (registrySync && row.pluginSyncInfo && row.pluginSyncInfo.registrySync !== registrySync) {
    row.pluginSyncInfo = { ...row.pluginSyncInfo, registrySync }
  }
}

/**
 * 关闭实验功能「ZTools 插件同步」（虚拟行的替代删除入口，DirRow 菜单「关闭
 * 插件同步」）：关开关并清行级暂停标记 —— 虚拟行经 prefs watch 移除、调度器
 * reload 后不再合成该 slot；电脑与云端文件都不会被删除。
 */
function disablePluginSync() {
  state.prefs.ztoolsPluginSync = false
  state.prefs.ztoolsPluginSyncPaused = false
}

/** 新增同步目录；overrides 可选（「覆盖全局设置」开启时传入，保证首次同步即用目录级参数） */
function addDir(localPath: string, remotePath: string, mode: SyncMode, overrides: DirOverrides | null = null): SyncDir | null {
  if (!localPath || !remotePath) return null
  const dir: SyncDir = {
    id: uid(),
    name: baseName(localPath),
    localPath,
    remotePath: normalizeRemote(remotePath),
    mode,
    overrides,
    status: 'idle',
    lastSyncAt: null,
    lastResult: null,
    conflictFile: null,
    errorMessage: null,
    progress: null,
  }
  state.dirs.push(dir)
  onDirsChanged()
  // 必须用存入响应式数组后的代理对象做同步：直接用上面的原始字面量，
  // syncDir 里的 status/progress 赋值不会经过 proxy，UI 永远不会更新。
  // 首次同步：调度器在线时由 reload 后的「新目录 startup 轮」承担（避免双触发，
  // rerun 合并）；无调度器形态（浏览器预览 / 降级）保持立即同步。
  const stored = state.dirs[state.dirs.length - 1]
  if (!(window.services?.scheduler && !state.demo)) void syncDir(stored)
  return stored
}

function removeDir(id: string) {
  // 虚拟行不走删除（电脑与云端文件不删）：等价操作是关闭实验开关
  if (id === PLUGIN_SYNC_DIR_ID) {
    disablePluginSync()
    return
  }
  const i = state.dirs.findIndex((d) => d.id === id)
  if (i >= 0) {
    state.dirs.splice(i, 1)
    // watcher 由 preload 调度器持有：persist → reload 后自动停挂
    onDirsChanged()
  }
}

/** 启用 / 停用某个同步目录（停用后自动与手动同步都会跳过）；虚拟行路由到行级暂停 prefs */
function setDirEnabled(id: string, enabled: boolean) {
  if (id === PLUGIN_SYNC_DIR_ID) {
    // 虚拟行不持久化，启停的权威只有 prefs（调度器合成时映射回 enabled）
    state.prefs.ztoolsPluginSyncPaused = !enabled
    return
  }
  const d = state.dirs.find((x) => x.id === id)
  if (d) d.enabled = enabled
}

/** 写入目录级设置覆盖（自动同步 / 检查频率 / 冲突处理 / 忽略隐藏 / 并发 / 限速 / 租约锁 / 深度校验 / 排除规则）；虚拟行无目录级设置（no-op） */
function setDirOverrides(id: string, patch: DirOverrides) {
  const d = state.dirs.find((x) => x.id === id)
  if (d && !isPluginSyncDir(d)) d.overrides = { ...(d.overrides ?? {}), ...patch }
}

/** 清除目录级设置覆盖：全部恢复跟随全局偏好；虚拟行 no-op */
function resetDirOverrides(id: string) {
  const d = state.dirs.find((x) => x.id === id)
  if (d && !isPluginSyncDir(d)) d.overrides = null
}

/**
 * 修改目录配置（「修改同步目录」弹窗保存入口）：
 * 本地路径变更时目录名跟随更新；overrides 为整体替换（null 表示清除全部覆盖、跟随全局）。
 * 路径 / 方式变化会通过 dirs 的序列化 watch 触发 onDirsChanged，重挂文件监听并持久化。
 * 插件同步虚拟行 no-op —— 本地目录自动发现、远端按平台隔离，均不可修改。
 */
function updateDir(id: string, patch: { localPath?: string; remotePath?: string; mode?: SyncMode; overrides?: DirOverrides | null }) {
  const d = state.dirs.find((x) => x.id === id)
  if (!d || isPluginSyncDir(d)) return
  if (patch.localPath !== undefined) {
    d.localPath = patch.localPath
    d.name = baseName(patch.localPath)
  }
  if (patch.remotePath !== undefined) d.remotePath = normalizeRemote(patch.remotePath)
  if (patch.mode !== undefined) d.mode = patch.mode
  if (patch.overrides !== undefined) d.overrides = patch.overrides
}

/**
 * 用户在冲突弹窗中做出选择。
 * 勾选「对本轮剩余冲突都这样处理」时向引擎回传 applyToRemaining，
 * 本轮后续冲突由引擎直接按该选择解决（不再进入弹窗队列）。
 */
function resolveConflict(choice: 'local' | 'remote' | 'both') {
  const info = state.activeConflict
  if (!info) return
  const resolve = conflictResolvers.get(info)
  conflictResolvers.delete(info)
  state.conflictQueue = state.conflictQueue.filter((c) => c !== info)
  state.activeConflict = state.conflictQueue[0] ?? null
  if (!state.activeConflict) state.conflictApplyAll = false
  resolve?.(state.conflictApplyAll ? { choice, applyToRemaining: true } : choice)
}

/**
 * 手动打开某目录的冲突处理（行内「处理」按钮）。
 * 【demo/兼容路径】入口由 DirRow 的冲突提示条触发，而该提示条要求
 * status === 'conflict' && conflictFile —— 真实同步状态机从不产生该状态，
 * 只有 ?demo=conflict 场景与历史持久化数据会走到这里。
 * 即便被触发，applyManualConflict 的真实分支也会复用引擎完整状态机
 * （runSync + 固定冲突策略），不会绕过安全链路，因此保留不作删除。
 */
function openConflictFor(dir: SyncDir) {
  if (!dir.conflictFile) return
  const info: ConflictInfo = {
    dirId: dir.id,
    rel: dir.conflictFile,
    local: { size: dir.conflictLocal?.size ?? 0, mtimeMs: dir.conflictLocal?.mtimeMs ?? Date.now() - 180000 },
    remote: { size: dir.conflictRemote?.size ?? 0, mtimeMs: dir.conflictRemote?.mtimeMs ?? Date.now() },
  }
  state.conflictQueue.push(info)
  state.activeConflict = info
  conflictResolvers.set(info, (rawChoice) => {
    // 行内打开的冲突在引擎外解决：直接按选择落地。
    // 'defer' 只可能来自调度器（后台轮），UI 弹窗从不产生 —— 此处忽略即可
    const choice = typeof rawChoice === 'string' ? rawChoice : rawChoice.choice
    if (choice === 'defer') return
    void applyManualConflict(dir.id, info, choice)
  })
}

async function applyManualConflict(dirId: string, _info: ConflictInfo, choice: 'local' | 'remote' | 'both') {
  // 按 id 取响应式目录对象，保证状态变更触发渲染
  const dir = state.dirs.find((d) => d.id === dirId)
  if (!dir) return
  // 演示模式：直接按选择落地状态
  if (state.demo || !window.services) {
    dir.status = 'synced'
    dir.conflictFile = null
    dir.lastSyncAt = Date.now()
    dir.justCompleted = true
    dir.lastResult = { uploaded: choice === 'remote' ? 0 : 1, downloaded: choice === 'local' ? 0 : 1, deleted: 0, conflicts: 1, deferredConflicts: 0, adopted: 0, bytesUp: 0, bytesDown: 0, totalFiles: 2, warnings: [], errors: [], errorsDropped: 0 }
    setTimeout(() => {
      dir.justCompleted = false
    }, 12000)
    persist()
    return
  }
  // 真实路径：以目录自身模式重跑引擎的完整状态机（SCAN→PLAN→EXECUTE→VERIFY→COMMIT），
  // 仅把冲突策略固定为用户的选择。旧实现曾改用 upload 模式整目录重传，
  // 会让本地删除在单向模式下意外传播到远端；现在与自动同步共用同一条安全链路，
  // 失败时远端 manifest 保持旧值，不会出现部分提交。
  await runSync(dir, { conflictStrategy: choice })
}

// ---------- 调度器订阅（自动同步由 preload 侧驱动） ----------
//
// 渲染层不再是调度的驱动者（旧 dirTimers / applyWatchers / 启动 syncAll 已删除）：
// 定时轮询、启动同步、fs.watch、手动排队全部由 preload 侧 scheduler 执行 —— 渲染层
// JS 停摆 / 宿主隐藏节流（Blink 定时器钳制）时同步照常。本节只做两件事：
//   1. init() 时握手 + 订阅事件（进度 / 轮末 / 冲突 / 调度器异常 / 宿主钩子转发）；
//   2. persist() 后通知调度器 reload（配置权威只有 dbStorage）。
// 冲突应答经 scheduler.resolveConflict 回传（kind=manual 且渲染层在线时才转发弹窗；
// 后台轮一律在 preload 侧 defer 挂起）。

/** 调度器事件退订函数（应用常驻单实例，仅重复绑定前退订旧句柄） */
let schedUnsubscribe: (() => void) | null = null

/** 把调度器 slot 状态映射到目录 UI 状态（running/queued → syncing；其余不打扰既有状态） */
function applySlotView(slot: SchedulerSlotView) {
  const dir = state.dirs.find((d) => d.id === slot.id)
  if (!dir) return
  if (slot.state === 'running' || slot.state === 'queued') {
    dir.status = 'syncing'
    if (slot.progress) {
      const p = slot.progress
      dir.progress = {
        filesDone: p.filesDone,
        filesTotal: p.filesTotal,
        bytesDone: p.bytesDone,
        bytesTotal: p.bytesTotal,
        verifyDone: p.verifyDone,
        verifyTotal: p.verifyTotal,
        stage: p.stage,
        currentOp: p.currentOp,
        currentFile: p.currentFile,
        scanBytesTotal: p.scanBytesTotal,
      }
      // 轮末 progress 即清空，云端占用估算在最后一次进度里留存（扫描字节口径）
      if (p.scanBytesTotal) dir.lastBytesTotal = p.scanBytesTotal
    }
  }
}

/** 轮末收尾：状态 / 摘要 / 提示与 runSync 的收尾口径一致（取消 → idle 非 error）。
 * 展示归因经 scheduler.summarizeRound（纯函数，preload 侧与渲染层共用）——
 * 熔断轮显示「服务器连续无响应 + 最后失败摘要」，完全相同的错误消息折叠为一条
 * （「无法列举远端目录（CIRCUIT_OPEN）」类噪声不再逐条刷屏），挂起冲突轮以
 * 「部分完成，有 N 个待处理冲突」收场（面板数据来自 pending-conflicts 事件）。 */
function applyRoundEnd(ev: Extract<SchedulerEvent, { type: 'round-end' }>) {
  const dir = state.dirs.find((d) => d.id === ev.dirId)
  if (!dir) return
  const summary = ev.summary ?? null
  const sched = window.services?.scheduler
  const disp = sched && typeof sched.summarizeRound === 'function' ? sched.summarizeRound(summary, ev.error, ev.cancelled) : null
  if (ev.cancelled) {
    dir.status = 'idle'
    dir.errorMessage = null
    dir.errorDetail = null
    if (summary) dir.lastResult = summary
    dir.lastSyncAt = Date.now()
    toast.info('已取消同步')
  } else if (disp && disp.tone === 'breaker') {
    // 熔断归因：状态文案固定为一句人话，最后失败原因折叠进 errorDetail（悬浮 title 可见）
    dir.status = 'error'
    dir.errorMessage = capStr(disp.title)
    dir.errorDetail = capStr(disp.detail || '')
    if (summary) dir.lastResult = summary
    dir.lastSyncAt = Date.now()
  } else if (ev.error || (disp && disp.tone === 'error')) {
    dir.status = 'error'
    dir.errorMessage = capStr((disp && disp.title) || ev.error)
    // 其余折叠后的失败条目作为详情（悬浮 title 可见），界面默认只展示首条摘要
    const more = disp && disp.errors && disp.errors.length > 1 ? disp.errors.join('\n') : ''
    dir.errorDetail = capStr(more)
    if (summary) dir.lastResult = summary
    dir.lastSyncAt = Date.now()
  } else {
    dir.status = 'synced'
    dir.errorMessage = null
    dir.errorDetail = null
    dir.conflictFile = null
    if (summary) dir.lastResult = summary
    dir.lastSyncAt = Date.now()
    // 部分完成轮（有删除确认 / 冲突挂起）不亮「同步完成」绿幅 —— 有事项在等
    // 用户处理时，行内状态保持低调的「已同步」，把注意力让给黄色待处理提示条
    dir.justCompleted = !(disp && disp.tone === 'partial')
    if (disp && disp.tone === 'partial') toast.info(disp.title, '回窗口后在文件夹列表统一处理')
    if (summary?.warnings?.length) {
      toast.warning(summary.warnings[0], summary.warnings.length > 1 ? `另有 ${summary.warnings.length - 1} 条提示` : undefined)
    }
    setTimeout(() => {
      dir.justCompleted = false
    }, 12000)
  }
  dir.progress = null
  // 摘要带挂起计数（删除确认 / 后台冲突 defer / 根丢失）时兜底拉一次该目录的
  // 挂起列表：pending-conflicts 事件是主通道，但任何送达缺口都不该让「处理入口」
  // 消失 —— 目录行提示条、状态栏入口与待处理中心都依赖这份数据
  const heldCount =
    (Number(summary?.deleteHeld) || 0) + (Number(summary?.deferredConflicts) || 0) + (Number(summary?.rootLostHeld) || 0)
  if (heldCount > 0) void refreshPendingConflicts(dir)
  // 插件同步虚拟行：注册表对账在调度器轮末异步执行（fire-and-forget），降级
  // 状态略晚于本事件落地 —— 延迟一拍再取，让「未授权 / 旧宿主」提示条及时出现
  if (ev.dirId === PLUGIN_SYNC_DIR_ID && !ev.cancelled) {
    setTimeout(() => void refreshPluginRegistryState(), 1500)
  }
  // 本轮结束：清空「应用到全部」勾选，下一轮冲突重新询问
  state.conflictApplyAll = false
  persist()
}

/**
 * 调度器转发的冲突（kind=manual 且本机订阅在线）：进弹窗队列，用户选择经
 * scheduler.resolveConflict 回传。'defer' 只可能由调度器兜底产生，弹窗不产生。
 */
function queueSchedulerConflict(ev: Extract<SchedulerEvent, { type: 'conflict' }>) {
  const info = ev.info
  state.conflictQueue.push(info)
  if (!state.activeConflict) state.activeConflict = state.conflictQueue[0]
  conflictResolvers.set(info, (rawChoice) => {
    const sched = window.services?.scheduler
    if (!sched) return
    if (typeof rawChoice === 'string') {
      // 'defer' 只可能来自调度器兜底（渲染层已不在），UI 弹窗从不产生 —— 忽略
      if (rawChoice === 'defer') return
      sched.resolveConflict(ev.conflictId, rawChoice)
      return
    }
    sched.resolveConflict(ev.conflictId, rawChoice.choice, rawChoice.applyToRemaining === true)
  })
}

/** 调度器事件入口（单一 listener 分发） */
function handleSchedulerEvent(ev: SchedulerEvent) {
  switch (ev.type) {
    case 'slot':
      applySlotView(ev.slot)
      break
    case 'round-end':
      applyRoundEnd(ev)
      break
    case 'conflict':
      queueSchedulerConflict(ev)
      break
    case 'pending-conflicts':
      applyPendingConflicts(ev.dirId, ev.items)
      break
    case 'plugin-enter':
      // 用户回窗口 —— 刷新全部目录的挂起冲突（后台轮 defer 产生，面板统一处理）
      void refreshAllPendingConflicts()
      break
    case 'scheduler-error':
      // 调度器自身异常（自举失败 / 心跳缓慢等）：仅 visible 的事件弹提示；
      // 内部机制类（选举 / 心跳 / dbStorage）只写日志，不打扰用户
      if ((ev as { visible?: boolean }).visible) toast.warning('自动同步出了点问题，稍后会重试', ev.message)
      else console.info('[webdav-sync] scheduler:', ev.message)
      break
    default:
      // config-applied / plugin-out：事件数据已由调度器外发，无 UI 动作
      break
  }
}

// ---------- 待处理挂起（后台轮 defer 冲突 + 批量删除确认的统一处理） ----------
//
// 后台（interval/watch）轮的冲突一律 defer 挂起（调度器侧，绝不等待一个看不见的
// 弹窗）；轮末经 pending-conflicts 事件外发清单 + ztools.showNotification 提醒一次
//（同批不重复）。批量删除超阈值（max(50, 基线×20%)）时引擎整批登记「待确认删除」
// 挂起（kind='delete'，无 choice），确认前零删除。用户回窗口后在此面板统一处理：
// 冲突逐条或批量三选一（setPendingChoice 落 choice，下一轮自动解决）；删除确认类
// 逐条或批量「确认删除 / 保留不删」；或「暂时忽略」（clearPendingConflict —— 冲突
// 再出现时才重新询问，删除类下一轮按阈值重新登记；永久失败的文件走失败退避表，
// 不进此通道，不会反复弹窗）。

/** pending-conflicts 事件 → 目录面板数据（choice 已选的条目仍展示，标注待下轮生效） */
function applyPendingConflicts(dirId: string, items: Array<{ rel: string; createdAt: number; choice?: string; kind?: string }>) {
  const dir = state.dirs.find((d) => d.id === dirId)
  if (!dir) return
  dir.pendingConflicts = items.slice(0, MAX_LIST_ITEMS)
  // 「云端文件夹丢失」待决策的自动弹窗不认事件上的 newlyNotified（只在轮末发一次，
  // 渲染层不在场时即永久丢失）：数据到手即交给 autoPromptRootLost 判定是否补弹
  autoPromptRootLost()
}

/**
 * 「云端文件夹丢失」决策弹窗的统一自动触发，任一数据到手路径都会调用（事件 /
 * 冷启动 / 回窗口 / 轮末兜底 / 面板打开刷新）：发现未决策的 root-lost 挂起、且弹窗
 * 从未为这条登记展示过（rootLostPromptedAt ≠ 挂起 createdAt）时弹窗。送达缺口不再
 * 让弹窗失约；已展示过的登记（含「暂不处理」）也不自动重复打扰，行内提示条可再进入。
 * 待处理中心开着时跳过 —— 中心自身已把根丢失分组排最前，且弹窗会被面板压在下面。
 */
function autoPromptRootLost() {
  if (state.rootLostPromptDirId && !state.dirs.some((d) => d.id === state.rootLostPromptDirId)) {
    state.rootLostPromptDirId = null
  }
  if (state.rootLostPromptDirId || state.pendingCenterOpen) return
  for (const d of state.dirs) {
    const rec = (d.pendingConflicts ?? []).find((p) => p.kind === 'root-lost' && !p.choice)
    if (rec && d.rootLostPromptedAt !== rec.createdAt) {
      state.rootLostPromptDirId = d.id
      return
    }
  }
}

/** 目录是否存在未决策的「云端文件夹丢失」挂起（提示条 / 面板入口的显示条件） */
export function dirRootLostOpen(d: SyncDir): boolean {
  return (d.pendingConflicts ?? []).some((p) => p.kind === 'root-lost' && !p.choice)
}

/**
 * 目录当前的「待处理信号」：未决策挂起里最新的时间戳（冲突 / 删除逐条登记取
 * createdAt，批量删除取快照 at），无未决策挂起时为 0。口径与 DirRow 行内待处理
 * 挂起条的计数一致（root-lost 有专门提示条、逐文件 delete 无快照时行内也不计）。
 * 作为「不再显示」的比较基准：关闭提示条时记下当时的信号，之后信号变大
 *（有新挂起）提示条重新显示 —— 关闭只对当前这批事项生效。
 */
export function dirPendingSignal(d: SyncDir): number {
  let t = 0
  for (const p of d.pendingConflicts ?? []) {
    if (p.choice || p.kind === 'root-lost' || p.kind === 'delete') continue
    t = Math.max(t, p.createdAt || 0)
  }
  if ((d.deleteBatch?.undecided ?? 0) > 0) t = Math.max(t, d.deleteBatch?.at || 0)
  return t
}

/**
 * 全部目录的待处理信号（各目录 dirPendingSignal 的最大值）：同步记录页顶部
 * 待处理横幅「不再显示」的比较基准，语义同 dirPendingSignal（有新挂起重新提示）。
 */
export function allPendingSignal(dirs: SyncDir[]): number {
  return dirs.reduce((acc, d) => Math.max(acc, dirPendingSignal(d)), 0)
}

/**
 * 关闭目录行内的「待处理挂起条」（不再显示）：记下当前待处理信号到目录的
 * pendingStripMutedAt（随目录持久化）。之后该目录出现更新的挂起时信号变大，
 * 提示条自动恢复显示；待处理中心 / 状态栏入口不受影响。
 */
function mutePendingStrip(d: SyncDir) {
  d.pendingStripMutedAt = dirPendingSignal(d)
}

/** 拉取某目录当前挂起冲突（面板打开 / 事件外的兜底刷新）。
 *  同步拉取批量删除快照（listDeleteBatch）—— 删除确认的目录树数据源：逐文件
 *  挂起表有 500 条上限，超限部分没有逐文件记录，只有快照承载；两类数据同源
 *  同刷新时机（面板打开 / 轮末兜底 / 冷启动 / 回窗口），一处拉取保证口径一致。 */
async function refreshPendingConflicts(dir: SyncDir) {
  if (!window.services || state.demo) return
  const dirArg = { id: dir.id, localPath: dir.localPath, remotePath: dir.remotePath, mode: dir.mode }
  try {
    const items = await window.services.sync.listPendingConflicts(dirArg)
    dir.pendingConflicts = (items || []).slice(0, MAX_LIST_ITEMS)
    // 兜底刷新也是数据到手路径：事件丢失后的回窗口 / 冷启动 / 面板打开都经这里补弹
    autoPromptRootLost()
  } catch {
    /* 读取失败保持旧值 */
  }
  try {
    dir.deleteBatch = await window.services.sync.listDeleteBatch(dirArg)
  } catch {
    dir.deleteBatch = null
  }
}

async function refreshAllPendingConflicts() {
  for (const d of state.dirs) await refreshPendingConflicts(d)
}

/** 全目录未处理（无 choice）挂起数（状态栏角标等展示）：逐条类（冲突 / 根丢失）
 *  按挂起记录计，删除确认按批量快照的未决策数计（undecided 是引擎真值 —— 逐文件
 *  记录有 500 条上限，超出部分只有快照知道；快照缺失时退回记录口径兜底） */
const pendingConflictTotal = computed(() =>
  state.dirs.reduce((acc, d) => {
    const itemOpen = (d.pendingConflicts ?? []).filter((p) => !p.choice && p.kind !== 'delete').length
    const deleteOpen = d.deleteBatch ? d.deleteBatch.undecided : (d.pendingConflicts ?? []).filter((p) => !p.choice && p.kind === 'delete').length
    return acc + itemOpen + deleteOpen
  }, 0)
)

/**
 * 全局待处理中心的目录分组（仅含有未决策挂起的目录，根丢失排最前）：每目录按
 * 根丢失 / 删除确认 / 冲突三类计数，供聚合面板渲染与「去处理」直达。删除确认
 * 计数与角标同口径：优先批量快照的 undecided（真值，覆盖超上限部分）。
 */
const pendingCenterGroups = computed(() => {
  const groups: Array<{ dir: SyncDir; rootLost: number; deleteConfirm: number; conflict: number }> = []
  for (const d of state.dirs) {
    let rootLost = 0
    let conflict = 0
    for (const p of d.pendingConflicts ?? []) {
      if (p.choice) continue
      if (p.kind === 'root-lost') rootLost++
      else if (p.kind !== 'delete') conflict++
    }
    const deleteConfirm = d.deleteBatch
      ? d.deleteBatch.undecided
      : (d.pendingConflicts ?? []).filter((p) => !p.choice && p.kind === 'delete').length
    if (rootLost + deleteConfirm + conflict > 0) groups.push({ dir: d, rootLost, deleteConfirm, conflict })
  }
  groups.sort((a, b) => (b.rootLost > 0 ? 1 : 0) - (a.rootLost > 0 ? 1 : 0))
  return groups
})

/** 打开全局待处理中心（状态栏入口）：先全量刷新各目录挂起列表保证数据新鲜 */
async function openPendingCenter() {
  state.pendingCenterOpen = true
  await refreshAllPendingConflicts()
}

/**
 * 待处理中心「去处理」直达：根丢失目录级决策弹 RootLostModal（既有 rootLostPromptDirId
 * 通道），其余经 pendingPanelDirId 一次性通道让对应 DirRow 打开本地待处理面板。
 */
function goPendingDir(d: SyncDir) {
  if ((d.pendingConflicts ?? []).some((p) => p.kind === 'root-lost' && !p.choice)) {
    state.rootLostPromptDirId = d.id
  } else {
    state.pendingPanelDirId = d.id
  }
  state.pendingCenterOpen = false
}

/**
 * 为一批冲突挂起记录落 choice（逐条或「对剩余都这样处理」）：local / remote / both。
 * （删除确认类不走这里 —— 目录树决策走 applyDeleteScope 的范围通道，覆盖逐文件
 * 记录装不下的部分。）落完刷新面板并触发一轮手动同步（下一轮按 choice 自动解决）；
 * 同步进行中不排队（下一轮自动消费选择），改为明确提示而不是静默吞掉。
 */
async function applyPendingChoices(dir: SyncDir, rels: string[], choice: 'local' | 'remote' | 'both') {
  if (!window.services || state.demo || !rels.length) return
  const dirArg = { id: dir.id, localPath: dir.localPath, remotePath: dir.remotePath, mode: dir.mode }
  try {
    for (const rel of rels) await window.services.sync.setPendingChoice(dirArg, rel, choice)
  } catch (e) {
    toast.error('操作没有成功，请重试', e instanceof Error ? e.message : String(e))
  }
  await refreshPendingConflicts(dir)
  const remaining = (dir.pendingConflicts ?? []).filter((p) => !p.choice && p.kind !== 'delete' && p.kind !== 'root-lost').length
  toast.success('已记录处理方式', remaining > 0 ? `还有 ${remaining} 个待处理` : '下次同步时生效')
  if (dir.status === 'syncing') {
    toast.info('正在同步，本次选择将在下一轮生效')
    return
  }
  void syncDir(dir)
}

/**
 * 落一条删除范围决策（目录树节点或底部「全部」按钮）：引擎按前缀写入 scope 并
 * 同步回写既有逐文件记录，覆盖逐文件挂起表装不下的部分。落完刷新面板数据并触发
 * 一轮手动同步（下一轮按 scope 自动执行 / 抑制）；同步进行中改为明确提示。
 * @param rel 范围前缀：'' = 全部；目录 rel = 该目录及子树；文件 rel = 单文件
 */
async function applyDeleteScope(dir: SyncDir, rel: string, choice: 'delete' | 'keep') {
  if (!window.services || state.demo) return
  const dirArg = { id: dir.id, localPath: dir.localPath, remotePath: dir.remotePath, mode: dir.mode }
  try {
    const res = await window.services.sync.setDeleteScope(dirArg, rel, choice)
    const scope = rel ? `「${rel}」` : ''
    toast.success(
      '已记录处理方式',
      res && res.covered > 0 ? `${scope}影响 ${res.covered} 个文件，下次同步时生效` : '下次同步时生效'
    )
  } catch (e) {
    toast.error('操作没有成功，请重试', e instanceof Error ? e.message : String(e))
    return
  }
  await refreshPendingConflicts(dir)
  if (dir.status === 'syncing') {
    toast.info('正在同步，本次选择将在下一轮生效')
    return
  }
  void syncDir(dir)
}

/** 「暂时忽略此冲突」：清除该挂起记录（该文件再冲突时才重新询问），不触发同步 */
async function ignorePendingConflict(dir: SyncDir, rel: string) {
  if (!window.services || state.demo) return
  try {
    await window.services.sync.clearPendingConflict(
      { id: dir.id, localPath: dir.localPath, remotePath: dir.remotePath, mode: dir.mode },
      rel
    )
  } catch {
    /* 清除失败保留旧值 */
  }
  await refreshPendingConflicts(dir)
}

/**
 * 「云端文件夹丢失」决策（kind='root-lost' 挂起，rel='.'）：把用户的选择写入挂起
 * 记录并立即触发一轮同步 —— 下一轮根探测消费该选择：
 *   upload       —— 重建云端文件夹，电脑上的文件按根重建保护语义重新上传；
 *   remove-local —— 跟随云端删除，电脑上已同步的文件移入回收站（未同步过的新文件
 *                   保留并上传到重建的云端文件夹；本地有改动的文件同样保留）。
 * 选择前每轮同步以「云端文件夹已不存在，等待确认」收场，零删除零传输。
 */
async function resolveRootLost(dir: SyncDir, choice: 'upload' | 'remove-local') {
  state.rootLostPromptDirId = null
  if (!window.services || state.demo) return
  const dirArg = { id: dir.id, localPath: dir.localPath, remotePath: dir.remotePath, mode: dir.mode }
  try {
    await window.services.sync.setPendingChoice(dirArg, '.', choice)
  } catch (e) {
    toast.error('操作没有成功，请重试', e instanceof Error ? e.message : String(e))
    return
  }
  await refreshPendingConflicts(dir)
  toast.success(
    '已记录处理方式',
    choice === 'upload' ? '正在重建云端文件夹并重新上传' : '正在移除电脑上已同步的文件'
  )
  void syncDir(dir)
}

/** 绑定调度器：订阅 + 握手（幂等；demo / 浏览器预览形态跳过） */
function bindScheduler() {
  const sched = window.services?.scheduler
  if (!sched || state.demo) return
  schedUnsubscribe?.()
  schedUnsubscribe = sched.subscribe(handleSchedulerEvent)
  void sched
    .init()
    .then((snap) => {
      if (!snap.ready && snap.notReadyReason) toast.warning('自动同步暂时没有开启', snap.notReadyReason)
    })
    .catch(() => {
      /* 握手失败不阻断界面 */
    })
}

/** 响应「目录列表 / 启用状态 / 目录级设置」变化的钩子：持久化（调度器经 reload 自行重建） */
function onDirsChanged() {
  persist()
}

// ---------- 初始化 ----------

/** 今天 HH:MM 的时间戳（演示数据用） */
function todayAt(h: number, m: number): number {
  const d = new Date()
  d.setHours(h, m, 0, 0)
  return d.getTime()
}

/**
 * 旧版本配置的检查频率归一：间隔选项已移除低于 15 分钟的档位（1 / 5 / 10 分钟），
 * 历史持久化值落在被移除档位时归一到 15 分钟 —— 否则下拉框出现空选项，实际同步
 * 频率也与界面可选范围不一致。覆盖全局偏好与目录级覆盖两处；有变更时立即落盘
 *（调度器随后经 reload 读取归一后的配置）。调度器侧不做钳位 —— 「配置什么跑什么」
 * 的语义留给配置本身，界面可选范围才是本归一的对齐目标。
 */
function normalizeLegacyIntervals(): void {
  let changed = false
  if (Number(state.prefs.intervalMin) < MIN_INTERVAL_MIN) {
    state.prefs.intervalMin = MIN_INTERVAL_MIN
    changed = true
  }
  for (const d of state.dirs) {
    const o = d.overrides?.intervalMin
    if (o != null && Number(o) < MIN_INTERVAL_MIN) {
      d.overrides = { ...(d.overrides ?? {}), intervalMin: MIN_INTERVAL_MIN }
      changed = true
    }
  }
  if (changed) persist()
}

/** 应用启动：载入配置，绑定 preload 调度器；支持 ?demo= 场景用于界面预览 */
async function init() {
  const persisted = loadPersisted()
  if (persisted) {
    state.server = { ...state.server, ...persisted.server }
    // 密码解密回内存（引擎调用需要明文）：解密失败返回空串 —— 界面显示空密码，
    // 连接测试以 401 提示用户重输；无 preload（浏览器预览）时保持原值
    const sec = window.services?.secure
    if (sec && typeof state.server.password === 'string') state.server.password = sec.openSecret(state.server.password)
    state.dirs = persisted.dirs || []
    state.prefs = { ...defaultPrefs(), ...(persisted.prefs || {}) }
  }
  // 旧版本间隔档位归一（<15 分钟 → 15）：在演示场景改写目录之前、绑定调度器
  // 之前执行 —— persist 落盘后调度器握手读到的即是归一后的配置
  normalizeLegacyIntervals()

  // 演示场景（开发预览）：?demo=main|empty|add|syncing|conflict|done|settings
  const demoParam = new URLSearchParams(location.search).get('demo')
  if (demoParam) applyDemo(demoParam)

  // 先绑定调度器（握手 + 订阅）—— 定时轮询、新目录首轮、fs.watch 全部在
  // preload 侧，不再依赖渲染层定时器（宿主隐藏节流免疫）；打开插件不触发同步
  bindScheduler()
  // 冷启动拉一次挂起冲突（后台轮 defer 产生；此后由 pending-conflicts 事件维护）
  void refreshAllPendingConflicts()

  // 深度监听设置变化：修改后立即生效并持久化（调度器经 reload 重建排程）
  watch(
    () => JSON.stringify(state.prefs),
    () => {
      persist()
    }
  )

  // 监听目录启用状态 / 目录级设置 / 路径与同步方式的修改 / 列表增删：持久化
  //（只取这些字段的序列化特征，同步进度等运行时字段变化不会触发；
  //  插件同步虚拟行不参与特征 —— 它不持久化，增删由 prefs 开关的 watch 驱动）
  watch(
    () =>
      state.dirs
        .filter((d) => !isPluginSyncDir(d))
        .map((d) => `${d.id}~${dirEnabled(d) ? 1 : 0}~${JSON.stringify(d.overrides ?? null)}~${d.localPath}~${d.remotePath}~${d.mode}`)
        .join('|'),
    onDirsChanged
  )

  // 【实验：ZTools 插件同步】开关 / 行级暂停 / 云端父目录变化 → 维护虚拟行
  //（增删 / 刷新 enabled 与发现结果，远端路径随父目录即时跟随）。行变化不直接
  // 持久化（虚拟行被 persist 过滤），但 prefs 本身的变化经上方 prefs 深 watch
  // 落盘并触发调度器 reload —— 调度器按同一组 prefs 合成 / 移除同 id 的 slot，
  // 两侧自然对齐
  watch(
    () =>
      `${state.prefs.ztoolsPluginSync ? 1 : 0}~${state.prefs.ztoolsPluginSyncPaused ? 1 : 0}~${state.prefs.ztoolsPluginSyncRemoteDir ?? ''}`,
    () => {
      refreshPluginSyncRow()
    }
  )
  refreshPluginSyncRow()

  if (configured.value) {
    // 先读能力缓存（无网络开销）立即呈现档位；随后的连通性探测会刷新它
    if (window.services) {
      void window.services.dav.getCachedCapabilities({ ...state.server }, state.prefs.probeRemoteDir || undefined).then((c) => {
        if (c && !state.capabilities) state.capabilities = c
      })
    }
    // 启动时的静默探测：不打通知，结果由界面状态点呈现（同步本身已由调度器启动）
    void testConnection({ notify: false })
  }
}

/** 演示场景数据（与设计稿 7 个画面一一对应） */
function applyDemo(scene: string) {
  state.demo = true
  if (scene === 'empty') {
    state.server = { serverUrl: '', username: '', password: '' }
    state.dirs = []
    return
  }
  state.server = {
    serverUrl: 'https://dav.example.com/remote.php/dav/files/user/',
    username: 'kai.wen',
    password: 'demo-password',
  }
  state.connected = true
  state.connChecked = true
  // 演示能力档位：B 档让首页档位徽标（含悬浮图例）与设置页检测结果可见；真实数据来自探测
  state.capabilities = {
    tier: 'B',
    probedAt: Date.now(),
    writable: true,
    etag: { present: true, weak: true, stable: true },
    conditional: { ifMatch: true, ifNoneMatch: true },
    depthInfinity: false,
    etagPropagation: false,
    mtimePrecision: 's',
    collectionRedirect: false,
    notes: [],
  }
  const dirs: SyncDir[] = [
    {
      id: 'demo-1',
      name: '项目文档',
      localPath: 'D:\\Documents\\Projects',
      remotePath: '/Projects/Documents',
      mode: 'two-way',
      status: 'synced',
      lastSyncAt: Date.now() - 2 * 60000,
      lastResult: null,
      conflictFile: null,
      errorMessage: null,
      progress: null,
    },
    {
      id: 'demo-2',
      name: '设计资源库',
      localPath: 'D:\\Design\\Assets',
      remotePath: '/Design/Assets',
      mode: 'two-way',
      status: 'synced',
      lastSyncAt: Date.now() - 3 * 60000,
      lastResult: null,
      conflictFile: null,
      errorMessage: null,
      progress: null,
    },
    {
      id: 'demo-3',
      name: '归档记录',
      localPath: 'D:\\Work\\Archive',
      remotePath: '/Work/Archive',
      mode: 'two-way',
      status: 'synced',
      lastSyncAt: todayAt(10, 32),
      lastResult: null,
      conflictFile: null,
      errorMessage: null,
      progress: null,
    },
  ]
  if (scene === 'syncing') {
    dirs[0].status = 'syncing'
    // 演示新进度形态：传输阶段按字节推进（分母 = 计划上传+下载字节），并携带当前任务
    dirs[0].progress = {
      filesDone: 128,
      filesTotal: 342,
      bytesDone: Math.round(12.8 * 1024 * 1024),
      bytesTotal: Math.round(34.6 * 1024 * 1024),
      stage: 'transfer',
      currentOp: 'upload',
      currentFile: 'Assets/Banners/hero-banner-v2.png',
      scanBytesTotal: Math.round(128 * 1024 * 1024),
    }
  } else if (scene === 'conflict') {
    dirs[0].status = 'conflict'
    dirs[0].conflictFile = 'README.md'
    dirs[0].conflictLocal = { size: 4300, mtimeMs: todayAt(10, 28) }
    dirs[0].conflictRemote = { size: 4710, mtimeMs: todayAt(10, 31) }
    // 与设计稿一致：冲突弹窗直接打开
    state.conflictQueue.push({
      dirId: dirs[0].id,
      rel: 'README.md',
      local: { size: 4300, mtimeMs: todayAt(10, 28) },
      remote: { size: 4710, mtimeMs: todayAt(10, 31) },
    })
    state.activeConflict = state.conflictQueue[0]
    conflictResolvers.set(state.activeConflict, (rawChoice) => {
      // 'defer' 只可能来自调度器（后台轮），demo 弹窗从不产生 —— 忽略
      const choice = typeof rawChoice === 'string' ? rawChoice : rawChoice.choice
      if (choice === 'defer') return
      void applyManualConflict(dirs[0].id, state.activeConflict!, choice)
    })
  } else if (scene === 'pending') {
    // 待处理面板预览：① 删除确认目录树（批量删除快照，含已决策子树徽标）+
    // ② 无快照的逐文件删除兜底列表 + ③ 冲突三选一列表；状态栏角标与目录行
    // 提示条同源计数
    dirs[0].pendingConflicts = [
      { rel: 'Spec/接口约定.md', createdAt: todayAt(10, 12), local: { size: 4300, mtimeMs: todayAt(10, 12) }, remote: { size: 4710, mtimeMs: todayAt(10, 13) } },
      { rel: 'Notes/会议记录.md', createdAt: todayAt(10, 15), local: { size: 2100, mtimeMs: todayAt(10, 15) }, remote: { size: 2100, mtimeMs: todayAt(10, 16) }, choice: 'local' },
    ]
    dirs[0].deleteBatch = {
      at: Date.now() - 4 * 60000,
      total: 1286,
      bytes: Math.round(2.3 * 1024 * 1024 * 1024),
      undecided: 86,
      scopes: [{ prefix: 'Photos/2024/RAW', choice: 'keep', at: Date.now() - 2 * 60000, gen: Date.now() - 4 * 60000 }],
      nodes: [
        { rel: 'Photos', isDir: true, files: 1200, bytes: Math.round(2.2 * 1024 * 1024 * 1024) },
        { rel: 'Photos/2024', isDir: true, files: 860, bytes: Math.round(1.6 * 1024 * 1024 * 1024) },
        { rel: 'Photos/2024/RAW', isDir: true, files: 640, bytes: Math.round(1.4 * 1024 * 1024 * 1024) },
        { rel: 'Photos/2024/精选', isDir: true, files: 220, bytes: Math.round(0.2 * 1024 * 1024 * 1024) },
        { rel: 'Photos/2023', isDir: true, files: 340, bytes: Math.round(0.6 * 1024 * 1024 * 1024) },
        { rel: 'Docs', isDir: true, files: 80, bytes: Math.round(96 * 1024 * 1024) },
        { rel: 'Docs/合同', isDir: true, files: 60, bytes: Math.round(88 * 1024 * 1024) },
        { rel: 'Docs/合同/外包协议.pdf', isDir: false, files: 1, bytes: Math.round(12 * 1024 * 1024) },
        { rel: 'Docs/发票.xlsx', isDir: false, files: 1, bytes: Math.round(3 * 1024 * 1024) },
        { rel: 'readme.txt', isDir: false, files: 1, bytes: 2048 },
      ],
    }
    // ② 兜底形态：有逐文件删除记录但无快照（旧数据 / 未到阈值单文件挂起）
    dirs[1].pendingConflicts = [
      { rel: 'Assets/旧版海报.psd', createdAt: todayAt(9, 40), kind: 'delete', local: { size: 184000000, mtimeMs: todayAt(9, 40) }, remote: { size: 0, mtimeMs: 0, etag: '' } },
      { rel: 'Assets/废弃Logo.ai', createdAt: todayAt(9, 41), kind: 'delete', local: { size: 42000000, mtimeMs: todayAt(9, 41) }, remote: { size: 0, mtimeMs: 0, etag: '' } },
    ]
  } else if (scene === 'decisions') {
    // 同步记录页预览（路由键沿用历史命名 'decisions'）：挂起数据驱动顶部待处理
    // 横幅的计数；记录时间线为静态样例（synclog.ts 的 demoSyncRecords）
    state.route = 'decisions'
    dirs[0].pendingConflicts = [
      { rel: 'Spec/接口约定.md', createdAt: todayAt(10, 12), local: { size: 4300, mtimeMs: todayAt(10, 12) }, remote: { size: 4710, mtimeMs: todayAt(10, 13) } },
      { rel: 'Notes/会议记录.md', createdAt: todayAt(10, 15), local: { size: 2100, mtimeMs: todayAt(10, 15) }, remote: { size: 2100, mtimeMs: todayAt(10, 16) }, choice: 'local' },
      { rel: 'Docs/评审纪要.md', createdAt: todayAt(10, 16), local: { size: 3600, mtimeMs: todayAt(10, 16) }, remote: { size: 3600, mtimeMs: todayAt(10, 17) }, choice: 'remote' },
    ]
    dirs[0].deleteBatch = {
      at: Date.now() - 4 * 60000,
      total: 1286,
      bytes: Math.round(2.3 * 1024 * 1024 * 1024),
      undecided: 86,
      scopes: [{ prefix: 'Photos/2024/RAW', choice: 'keep', at: Date.now() - 2 * 60000, gen: Date.now() - 4 * 60000 }],
      nodes: [
        { rel: 'Photos', isDir: true, files: 1200, bytes: Math.round(2.2 * 1024 * 1024 * 1024) },
        { rel: 'Photos/2024', isDir: true, files: 860, bytes: Math.round(1.6 * 1024 * 1024 * 1024) },
        { rel: 'Photos/2024/RAW', isDir: true, files: 640, bytes: Math.round(1.4 * 1024 * 1024 * 1024) },
        { rel: 'Docs', isDir: true, files: 80, bytes: Math.round(96 * 1024 * 1024) },
        { rel: 'Docs/合同', isDir: true, files: 60, bytes: Math.round(88 * 1024 * 1024) },
        { rel: 'readme.txt', isDir: false, files: 1, bytes: 2048 },
      ],
    }
    dirs[1].pendingConflicts = [
      { rel: 'Assets/横幅-v3.png', createdAt: todayAt(9, 40), local: { size: 821000, mtimeMs: todayAt(9, 40) }, remote: { size: 819000, mtimeMs: todayAt(9, 42) } },
      { rel: 'Assets/图标集.sketch', createdAt: todayAt(9, 44), local: { size: 42000000, mtimeMs: todayAt(9, 44) }, remote: { size: 41000000, mtimeMs: todayAt(9, 45) } },
    ]
    dirs[2].pendingConflicts = [
      { rel: '.', createdAt: todayAt(10, 30), kind: 'root-lost', local: { size: 342, mtimeMs: todayAt(10, 30) }, remote: { size: 0, mtimeMs: 0, etag: '' } },
    ]
  } else if (scene === 'done') {
    dirs[0].lastSyncAt = Date.now() - 5000
    dirs[0].justCompleted = true
    dirs[0].lastResult = { uploaded: 18, downloaded: 31, deleted: 0, conflicts: 0, deferredConflicts: 0, adopted: 0, bytesUp: 0, bytesDown: 0, totalFiles: 342, warnings: [], errors: [], errorsDropped: 0 }
  } else if (scene === 'settings') {
    state.route = 'settings'
    state.testResult = { ok: true, latencyMs: 128 }
    state.cloudUsage = '2.4 GB'
  } else if (scene === 'add') {
    state.showAdd = true
  }
  state.dirs = dirs
  state.cloudUsage = state.cloudUsage || '2.4 GB'
}

/** 打开配置指南（外部浏览器） */
function openGuide() {
  const url = GUIDE_URL
  try {
    window.ztools?.shellOpenExternal(url)
    return
  } catch (_) {
    /* 浏览器预览兜底 */
  }
  window.open(url, '_blank')
}

/** 关闭插件窗口（设置页右上角 X） */
function outPlugin() {
  try {
    window.ztools?.outPlugin?.()
  } catch (_) {
    /* 浏览器预览无此能力 */
  }
}

export function useStore() {
  return {
    state,
    configured,
    connStatus,
    activeConflict,
    conflictPendingCount,
    anySyncing,
    lastSyncAt,
    cloudBytes,
    insecureHttp,
    init,
    testConnection,
    reprobe,
    confirmProbeDir,
    syncDir,
    syncAll,
    cancelSync,
    addDir,
    updateDir,
    removeDir,
    setDirEnabled,
    setDirOverrides,
    resetDirOverrides,
    isPluginSyncDir,
    disablePluginSync,
    dirEnabled,
    dirAutoSyncOn,
    dirIntervalMin,
    dirSyncPrefs,
    dirEngineCfg,
    dirPendingSignal,
    allPendingSignal,
    mutePendingStrip,
    resolveConflict,
    openConflictFor,
    pendingConflictTotal,
    pendingCenterGroups,
    openPendingCenter,
    goPendingDir,
    refreshPendingConflicts,
    refreshAllPendingConflicts,
    autoPromptRootLost,
    applyPendingChoices,
    applyDeleteScope,
    ignorePendingConflict,
    resolveRootLost,
    openGuide,
    outPlugin,
    persist,
  }
}
