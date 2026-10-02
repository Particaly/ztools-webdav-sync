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
  SchedulerEvent,
  SchedulerSlotView,
  SyncDir,
  SyncMode,
  SyncSummary,
} from '../env.d'
import { toast } from './toast'

const STORAGE_KEY = 'webdav-sync:data'
const GUIDE_URL = 'https://help.jianguoyun.com/?p=2064'

/** 生成短 id */
function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

/** 默认偏好设置 */
export function defaultPrefs(): Prefs {
  return {
    autoSync: true,
    intervalMin: 15,
    syncOnStartup: true,
    conflictStrategy: 'ask',
    ignoreHidden: true,
    concurrency: 4,
    defaultRemoteDir: '',
    verifyMaxBytes: 50 * 1024 * 1024,
    deepVerify: false,
    deepVerifyDays: 7,
    // 目录级租约锁，默认开；关闭后多设备仅靠档位保护
    leaseLock: true,
    // 后台运行：隐藏插件视图时是否继续自动同步；宿主声明恒为 true
    backgroundRunning: true,
    // 用户排除规则：默认空；内置 OS 垃圾规则（.DS_Store 等）不可关闭
    excludePatterns: [],
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

// ---------- 档位文案（A 强保证 / B 尽力 / C 只读） ----------

/** 档位短标签（主界面卡片 / 设置页展示） */
export function tierLabel(t?: DavTier | null): string {
  if (t === 'A') return 'A 档 · 强并发保证'
  if (t === 'B') return 'B 档 · 尽力保护'
  if (t === 'C') return 'C 档 · 只读'
  return '未探测'
}

/** 档位提示文案（B 档的并发安全边界与 C 档的只读说明） */
export function tierHint(t?: DavTier | null): string {
  if (t === 'A') return '条件请求与强 etag 可用，多设备并发修改可被服务端拦截'
  if (t === 'B') return '该服务器无法完全保证多设备并发安全：覆盖 / 删除前会逐文件复查'
  if (t === 'C') return '服务器拒绝写入，仅下载；上传与删除已跳过'
  return ''
}

interface PersistShape {
  server: DavConfig
  dirs: SyncDir[]
  prefs: Prefs
}

const state = reactive({
  route: 'main' as 'main' | 'settings',
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
  conflictQueue: [] as ConflictInfo[],
  activeConflict: null as ConflictInfo | null,
  /** 冲突弹窗「对本轮剩余冲突都这样处理」勾选：置位后本轮后续冲突不再弹窗 */
  conflictApplyAll: false,
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
  const out: SyncDir = { ...d, progress: null, pendingConflicts: null, status: (d.status === 'syncing' ? 'idle' : d.status) as DirStatus }
  out.errorMessage = d.errorMessage != null ? capStr(d.errorMessage) : null
  if (d.lastResult) {
    out.lastResult = {
      ...d.lastResult,
      errors: capList(d.lastResult.errors, (n) => `（其余 ${n} 条错误已省略）`),
      warnings: capList(d.lastResult.warnings, (n) => `（其余 ${n} 条提示已省略）`),
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
      // 进度等运行时字段不入库；入库字段显式限长（见 sanitizeDirForPersist）
      dirs: state.dirs.map(sanitizeDirForPersist),
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
    if (notify) toast.warning('请先填写服务器地址', '填写 WebDAV 地址后再测试连接')
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
      result = await window.services.dav.testConnection(state.server)
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
    if (result.ok) toast.success('连接成功', `服务器响应 ${result.latencyMs ?? 0} ms`)
    else toast.error('连接失败', result.error || '无法连接服务器，请检查地址与凭据')
  }
  return result
}

/**
 * 重新探测服务器能力与档位（设置页「重新探测」入口）。
 * 复用 preload 的 probeCapabilities(cfg, force=true)：忽略缓存现场实测，
 * 结果写回 state.capabilities 并以通知反馈档位结论。
 */
async function reprobe(): Promise<void> {
  if (!state.server.serverUrl.trim()) {
    toast.warning('请先填写服务器地址', '填写 WebDAV 地址后再探测服务器能力')
    return
  }
  if (!window.services) {
    toast.warning('当前环境不可用', '浏览器预览模式无 preload 能力')
    return
  }
  state.probing = true
  try {
    const caps = await window.services.dav.probeCapabilities({ ...state.server }, true)
    state.capabilities = caps
    toast.success(
      `探测完成：${tierLabel(caps.tier)}`,
      caps.tier === 'A' ? tierHint('A') : `${tierHint(caps.tier)}${caps.notes && caps.notes.length ? `（${caps.notes[0]}）` : ''}`
    )
  } catch (e) {
    toast.error('探测失败', e instanceof Error ? e.message : String(e))
  } finally {
    state.probing = false
  }
}

// ---------- 同步 ----------

/** 目录是否启用（历史数据无该字段，视为启用） */
export function dirEnabled(d: SyncDir): boolean {
  return d.enabled !== false
}

/** 目录生效的自动同步间隔：目录级覆盖优先，否则跟随全局偏好 */
export function dirIntervalMin(d: SyncDir): number {
  return d.overrides?.intervalMin ?? state.prefs.intervalMin
}

/** 目录生效的同步参数（冲突处理 / 忽略隐藏文件 / 消歧与深度校验 / 采纳预算 / 租约锁 / 排除规则），供引擎调用与界面展示 */
export function dirSyncPrefs(d: SyncDir) {
  return {
    ignoreHidden: d.overrides?.ignoreHidden ?? state.prefs.ignoreHidden,
    concurrency: state.prefs.concurrency,
    conflictStrategy: d.overrides?.conflictStrategy ?? state.prefs.conflictStrategy,
    verifyMaxBytes: state.prefs.verifyMaxBytes,
    deepVerify: state.prefs.deepVerify,
    deepVerifyDays: state.prefs.deepVerifyDays,
    adoptVerifyBudgetBytes: state.prefs.adoptVerifyBudgetBytes,
    leaseLock: state.prefs.leaseLock,
    excludePatterns: state.prefs.excludePatterns,
  }
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
    toast.info('正在取消同步…', '将中断在途传输并中止本轮')
    return
  }
  if (cancelRequested.has(id)) return
  cancelRequested.add(id)
  toast.info('正在取消同步…', '将中断在途传输并中止本轮')
}

/**
 * 执行一次目录同步的完整流程：状态机 syncing → synced | error。
 * 引擎侧语义：每个文件验证成功即写本机基线；文件级失败不再回滚其他文件，
 * 但轮末以 error 状态上报（err.summary 携带成功部分计数，err.errors / errorsDropped 为失败清单）。
 * 真实同步的冲突由引擎 onConflict 回调经 conflictQueue 即时弹窗处理（见 resolveConflict），
 * 弹窗勾选「对本轮剩余冲突都这样处理」后，本轮后续冲突直接按该选择解决，不再弹窗。
 * opts.conflictStrategy 可覆盖目录冲突策略（手动冲突处理入口复用同一条状态机）。
 */
async function runSync(dir: SyncDir, opts?: { conflictStrategy?: Prefs['conflictStrategy'] }) {
  dir.status = 'syncing'
  dir.errorMessage = null
  dir.progress = { filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 }
  try {
    const prefs = dirSyncPrefs(dir)
    if (opts?.conflictStrategy) prefs.conflictStrategy = opts.conflictStrategy
    const summary = await window.services.sync.syncDirectory(
      { ...state.server },
      { id: dir.id, localPath: dir.localPath, remotePath: dir.remotePath, mode: dir.mode },
      prefs,
      {
        onProgress: (p) => {
          // verifyDone / verifyTotal：规划期内容校验进度的可选透传（UI 不强制展示，数据要在）
          dir.progress = {
            filesDone: p.filesDone,
            filesTotal: p.filesTotal,
            bytesDone: p.bytesDone,
            bytesTotal: p.bytesTotal,
            verifyDone: p.verifyDone,
            verifyTotal: p.verifyTotal,
          }
        },
        onConflict: (info) =>
          new Promise<ConflictChoice>((resolve) => {
            state.conflictQueue.push(info)
            if (!state.activeConflict) state.activeConflict = state.conflictQueue[0]
            conflictResolvers.set(info, resolve)
          }),
        shouldAbort: () => cancelRequested.has(dir.id),
      }
    )
    dir.lastResult = summary
    dir.lastBytesTotal = dir.progress?.bytesTotal ?? dir.lastBytesTotal
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
      // 部分成功场景：err.summary 是引擎附带的完整计数，errorMessage 仍取首个失败原因
      const summary = (e as { summary?: SyncSummary }).summary
      dir.errorMessage = capStr(msg)
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

/** 同步单个目录：调度器在线时经其手动通道（直插队首）；进度 / 冲突 / 状态全部来自订阅事件 */
async function syncDir(dir: SyncDir) {
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
      await sched.syncNow(dir.id)
    } catch (e) {
      // syncNow 的明确拒绝（未就绪 / 未配置 / 目录不存在）：目录置错误并提示
      dir.status = 'error'
      dir.errorMessage = capStr(e instanceof Error ? e.message : String(e))
      dir.progress = null
    }
    return
  }
  await runSync(dir)
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
  const i = state.dirs.findIndex((d) => d.id === id)
  if (i >= 0) {
    state.dirs.splice(i, 1)
    // watcher 由 preload 调度器持有：persist → reload 后自动停挂
    onDirsChanged()
  }
}

/** 启用 / 停用某个同步目录（停用后自动与手动同步都会跳过） */
function setDirEnabled(id: string, enabled: boolean) {
  const d = state.dirs.find((x) => x.id === id)
  if (d) d.enabled = enabled
}

/** 写入目录级设置覆盖（冲突处理 / 忽略隐藏文件 / 同步间隔） */
function setDirOverrides(id: string, patch: DirOverrides) {
  const d = state.dirs.find((x) => x.id === id)
  if (d) d.overrides = { ...(d.overrides ?? {}), ...patch }
}

/** 清除目录级设置覆盖：全部恢复跟随全局偏好 */
function resetDirOverrides(id: string) {
  const d = state.dirs.find((x) => x.id === id)
  if (d) d.overrides = null
}

/**
 * 修改目录配置（「修改同步目录」弹窗保存入口）：
 * 本地路径变更时目录名跟随更新；overrides 为整体替换（null 表示清除全部覆盖、跟随全局）。
 * 路径 / 方式变化会通过 dirs 的序列化 watch 触发 onDirsChanged，重挂文件监听并持久化。
 */
function updateDir(id: string, patch: { localPath?: string; remotePath?: string; mode?: SyncMode; overrides?: DirOverrides | null }) {
  const d = state.dirs.find((x) => x.id === id)
  if (!d) return
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
      dir.progress = {
        filesDone: slot.progress.filesDone,
        filesTotal: slot.progress.filesTotal,
        bytesDone: slot.progress.bytesDone,
        bytesTotal: slot.progress.bytesTotal,
        verifyDone: slot.progress.verifyDone,
        verifyTotal: slot.progress.verifyTotal,
      }
      // 轮末 progress 即清空，云端占用估算在最后一次进度里留存
      if (slot.progress.bytesTotal) dir.lastBytesTotal = slot.progress.bytesTotal
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
    if (summary) dir.lastResult = summary
    dir.lastSyncAt = Date.now()
    toast.info('已取消同步')
  } else if (disp && disp.tone === 'breaker') {
    // 熔断归因：状态文案固定，详情折叠进 errorMessage（title 上限内）
    dir.status = 'error'
    dir.errorMessage = capStr(disp.detail ? `${disp.title}：${disp.detail}` : disp.title)
    if (summary) dir.lastResult = summary
    dir.lastSyncAt = Date.now()
  } else if (ev.error || (disp && disp.tone === 'error')) {
    dir.status = 'error'
    dir.errorMessage = capStr((disp && disp.title) || ev.error)
    if (summary) dir.lastResult = summary
    dir.lastSyncAt = Date.now()
  } else {
    dir.status = 'synced'
    dir.errorMessage = null
    dir.conflictFile = null
    if (summary) dir.lastResult = summary
    dir.lastSyncAt = Date.now()
    dir.justCompleted = true
    if (disp && disp.tone === 'partial') toast.info(disp.title, '回窗口后在目录列表统一处理')
    if (summary?.warnings?.length) {
      toast.warning(summary.warnings[0], summary.warnings.length > 1 ? `另有 ${summary.warnings.length - 1} 条提示` : undefined)
    }
    setTimeout(() => {
      dir.justCompleted = false
    }, 12000)
  }
  dir.progress = null
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
      // 调度器自身异常（自举失败 / 心跳缓慢等）：可见但不打断界面
      toast.warning('同步调度器异常', ev.message)
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
}

/** 拉取某目录当前挂起冲突（面板打开 / 事件外的兜底刷新） */
async function refreshPendingConflicts(dir: SyncDir) {
  if (!window.services || state.demo) return
  try {
    const items = await window.services.sync.listPendingConflicts({
      id: dir.id,
      localPath: dir.localPath,
      remotePath: dir.remotePath,
      mode: dir.mode,
    })
    dir.pendingConflicts = (items || []).slice(0, MAX_LIST_ITEMS)
  } catch {
    /* 读取失败保持旧值 */
  }
}

async function refreshAllPendingConflicts() {
  for (const d of state.dirs) await refreshPendingConflicts(d)
}

/** 全目录未处理（无 choice）挂起数（状态栏角标等展示） */
const pendingConflictTotal = computed(() =>
  state.dirs.reduce((acc, d) => acc + (d.pendingConflicts?.filter((p) => !p.choice).length ?? 0), 0)
)

/**
 * 为一批挂起记录落 choice（逐条或「对剩余都这样处理」）。冲突类 local / remote /
 * both；删除确认类（kind='delete'）delete = 确认删除（下一轮执行）、keep = 保留不删。
 * 落完刷新面板并触发一轮手动同步（下一轮会按 choice 自动解决；手动成功同时清退避）。
 */
async function applyPendingChoices(dir: SyncDir, rels: string[], choice: 'local' | 'remote' | 'both' | 'delete' | 'keep') {
  if (!window.services || state.demo || !rels.length) return
  const dirArg = { id: dir.id, localPath: dir.localPath, remotePath: dir.remotePath, mode: dir.mode }
  try {
    for (const rel of rels) await window.services.sync.setPendingChoice(dirArg, rel, choice)
  } catch (e) {
    toast.error('应用失败', e instanceof Error ? e.message : String(e))
  }
  await refreshPendingConflicts(dir)
  const remaining = dir.pendingConflicts?.filter((p) => !p.choice).length ?? 0
  toast.success('已记录处理方式', remaining > 0 ? `仍有 ${remaining} 个待处理` : '即将同步落地')
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

/** 绑定调度器：订阅 + 握手（幂等；demo / 浏览器预览形态跳过） */
function bindScheduler() {
  const sched = window.services?.scheduler
  if (!sched || state.demo) return
  schedUnsubscribe?.()
  schedUnsubscribe = sched.subscribe(handleSchedulerEvent)
  void sched
    .init()
    .then((snap) => {
      if (!snap.ready && snap.notReadyReason) toast.warning('自动同步未启动', snap.notReadyReason)
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

  // 演示场景（开发预览）：?demo=main|empty|add|syncing|conflict|done|settings
  const demoParam = new URLSearchParams(location.search).get('demo')
  if (demoParam) applyDemo(demoParam)

  // 先绑定调度器（握手 + 订阅）—— 自举 / 启动同步（syncOnStartup）、定时
  // 轮询、fs.watch 全部在 preload 侧，不再依赖渲染层定时器（宿主隐藏节流免疫）
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
  //（只取这些字段的序列化特征，同步进度等运行时字段变化不会触发）
  watch(
    () =>
      state.dirs
        .map((d) => `${d.id}~${dirEnabled(d) ? 1 : 0}~${JSON.stringify(d.overrides ?? null)}~${d.localPath}~${d.remotePath}~${d.mode}`)
        .join('|'),
    onDirsChanged
  )

  if (configured.value) {
    // 先读能力缓存（无网络开销）立即呈现档位；随后的连通性探测会刷新它
    if (window.services) {
      void window.services.dav.getCachedCapabilities({ ...state.server }).then((c) => {
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
    dirs[0].progress = {
      filesDone: 128,
      filesTotal: 342,
      bytesDone: Math.round(12.8 * 1024 * 1024),
      bytesTotal: Math.round(34.6 * 1024 * 1024),
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
    syncDir,
    syncAll,
    cancelSync,
    addDir,
    updateDir,
    removeDir,
    setDirEnabled,
    setDirOverrides,
    resetDirOverrides,
    dirEnabled,
    dirIntervalMin,
    dirSyncPrefs,
    resolveConflict,
    openConflictFor,
    pendingConflictTotal,
    refreshPendingConflicts,
    refreshAllPendingConflicts,
    applyPendingChoices,
    ignorePendingConflict,
    openGuide,
    outPlugin,
    persist,
  }
}
