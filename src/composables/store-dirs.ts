/* eslint-disable */
// store-dirs.ts —— 目录执行与管理域：同步执行状态机
// （runSync / syncDir / syncAll / 预演 / 取消）、目录增删改与覆盖、引擎参数组装
// （dirSyncPrefs / dirEngineCfg）、「ZTools 插件同步」虚拟行的发现与登记表状态。
import { state, conflictResolvers, cancelRequested, capStr, persist, schedulePersist, uid, baseName, suggestRemote, normalizeRemote, isPluginSyncDir, flushPersist, configured, MAX_LIST_ITEMS } from './store-core'
import { ZTOOLS_PLUGINS_DIR_ID, pluginSyncExcludePatterns, resolveDirPrefs } from '../../src-ztools/preload/types.mts'
import type { ConflictChoice, DavConfig, DirOverrides, Prefs, RegistryReconcileResult, SyncDir, SyncLogEntry, SyncMode, SyncSummary, ZtoolsPluginsSyncDesc } from '../env.d'
import { toast } from './toast'
import { MIN_INTERVAL_MIN } from './options'
import { serverOfDir, setActiveServer } from './store-servers'


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
 * 未覆盖的项回落全局偏好。优先级合并与畸形值防御统一在 types.mts 的
 * resolveDirPrefs —— 与 preload 调度器 prefsOf 同一函数（前后端单一口径，
 * 「无调度器直调引擎」与「调度器自动轮」两条路径同规则的前提）。
 * 插件同步虚拟行的覆盖存于 prefs.ztoolsPluginSyncOverrides（「同步设置」弹窗
 * 落点），excludePatterns 单独组装：全局规则 ∪ 记录级规则（未自定义时记录级取
 * 内置默认的运行时数据库忽略）—— 与调度器合成 slot 同一组装函数
 *（types.mts pluginSyncExcludePatterns），两路径同规则。
 * 限速（ratePerSec）不在其中：它属于网络层参数，经 dirEngineCfg 注入 netOpts。
 */
export function dirSyncPrefs(d: SyncDir) {
  const overrides = isPluginSyncDir(d)
    ? {
        ...(state.prefs.ztoolsPluginSyncOverrides ?? {}),
        excludePatterns: pluginSyncExcludePatterns(
          (state.prefs.ztoolsPluginSyncOverrides as { excludePatterns?: unknown } | null)?.excludePatterns ?? state.prefs.ztoolsPluginSyncExcludePatterns,
          state.prefs.excludePatterns
        ),
      }
    : d.overrides
  return resolveDirPrefs(overrides, state.prefs)
}

/**
 * 目录生效的引擎连接配置：目录 serverId 指向的服务器条目之上应用目录级网络层
 * 覆盖（当前仅 ratePerSec 限速；显式数值直接覆盖该服务器 netOpts 与档案默认的
 * 分层口径，未设置时保持服务器配置原样 —— 引擎 resolveNetOpts 按既有分层生效）。
 */
export function dirEngineCfg(d: SyncDir): DavConfig {
  const cfg: DavConfig = { ...serverOfDir(d) }
  if (d.overrides?.ratePerSec != null) {
    cfg.netOpts = { ...cfg.netOpts, ratePerSec: d.overrides.ratePerSec }
  }
  return cfg
}

/** 用户请求取消同步的目录 id 集合：runSync 经 shouldAbort 注入引擎，轮末 finally 统一清除 */
/**
 * 请求取消某目录的进行中同步：置位取消标记并提示；
 * 引擎在下一个检查点以「同步已中止」收场，runSync 的 catch 据此把目录状态回置 idle（非 error）。
 * 取消会即时中断在途传输（引擎销毁请求与读写流），而不是「等当前文件传完」。
 * 调度器在线时经其 cancel 通道（调度轮与 runSync 直调轮共用引擎取消语义）。
 */
export function cancelSync(id: string) {
  const sched = window.services?.scheduler
  if (sched && !state.demo) {
    sched.cancel(id)
    toast.info('正在取消同步…', '正在停止，正在传输的文件将被中断')
    return
  }
  if (cancelRequested.has(id)) return
  cancelRequested.add(id)
  toast.info('正在取消同步…', '正在停止，正在传输的文件将被中断')
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
export async function runSync(dir: SyncDir, opts?: { conflictStrategy?: Prefs['conflictStrategy']; op?: 'pull' | 'push' | 'pull-full' | 'push-full' }) {
  // 调用方（syncDir / applyManualConflict）均已对无 preload 形态提前返回，这里
  // 服务必然在场；守卫只为满足类型窄化，真触发（不应发生）按轮失败收场
  const services = window.services
  if (!services) throw new Error('浏览器预览模式没有连接服务器的能力')
  dir.status = 'syncing'
  dir.errorMessage = null
  dir.progress = { filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0 }
  try {
    const prefs = dirSyncPrefs(dir)
    if (opts?.conflictStrategy) prefs.conflictStrategy = opts.conflictStrategy
    const summary = await services.sync.syncDirectory(
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
          // 云端占用估算取「扫描到的全部文件字节」；bytesTotal 为传输字节口径，不作占用来源
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
    // 立即 persist（不防抖）：轮末承载 lastSyncAt / lastResult 落盘（重启后「上次
    // 同步」展示读它——调度器不消费该字段，configV 哈希只取配置字段，reload 是
    // no-op）；每目录每轮才一次，低频无合并价值
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
export async function syncDir(dir: SyncDir, opts?: { op?: 'pull' | 'push' | 'pull-full' | 'push-full' }) {
  if (!configured.value || dir.status === 'syncing' || !dirEnabled(dir)) return

  // 浏览器演示模式（无 preload）：模拟一次同步过程，便于预览「立即同步」交互
  if (!window.services) {
    if (!state.demo) return
    dir.status = 'syncing'
    dir.errorMessage = null
    const total = 10
    // 模拟实时速率（状态栏 / 目录行的速度展示预览）：上传下载交替的固定演示值
    state.netSpeed = { upBps: 680 * 1024, downBps: 420 * 1024 }
    state.dirSpeeds = { [dir.id]: { ...state.netSpeed } }
    for (let i = 1; i <= total; i++) {
      await new Promise((r) => setTimeout(r, 120))
      dir.progress = { filesDone: i, filesTotal: total, bytesDone: i * 82000, bytesTotal: total * 82000 }
    }
    state.netSpeed = { upBps: 0, downBps: 0 }
    delete state.dirSpeeds[dir.id]
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
export async function syncAll() {
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

/**
 * 预演一次（「选择性同步」的配套入口，目录行「更多操作」菜单）：只扫描与规划的
 * 零副作用轮 —— 不上传 / 不下载 / 不删除、不写基线，云端与电脑文件零改动。
 * 调度器在线时经 syncNow(opts.dryRun) 排队（忙时明确拒绝）；无调度器形态直调
 * 引擎注入 hints.dryRun（同一语义）。预演结果以同步记录（trigger='dry-run'）
 * 落盘，结果弹窗经 listSyncLog 读取最新一条预演记录渲染（明细与真实轮同口径）。
 * 调度器路径不发 round-end —— 目录行状态在轮前后保持不变；slot 进度事件会把
 * 行置为 syncing，本函数收尾时按 slot 实际状态复位（空闲才复位，避免误清真实轮）。
 * @returns { ok, error? } —— ok=false 时 error 为失败原因（含忙时拒绝 / 预演轮错误摘要）
 */
export async function dryRunDir(dir: SyncDir): Promise<{ ok: boolean; error?: string }> {
  if (!window.services) return { ok: false, error: '浏览器预览模式没有连接服务器的能力，无法预演' }
  if (state.demo) return { ok: false, error: '演示模式没有真实文件，无法预演' }
  if (!configured.value || dir.status === 'syncing') return { ok: false, error: '该文件夹正在同步中，请等待本轮结束后再试' }
  const sched = window.services.scheduler
  try {
    if (sched) {
      const r = await sched.syncNow(dir.id, { dryRun: true })
      if (r && 'error' in r && r.error) return { ok: false, error: r.error }
      return { ok: true }
    }
    // 无调度器形态（降级直调引擎）：注入预演 hints，与调度器路径同一语义
    const prefs = dirSyncPrefs(dir)
    await window.services.sync.syncDirectory(dirEngineCfg(dir), { id: dir.id, localPath: dir.localPath, remotePath: dir.remotePath, mode: dir.mode }, prefs, {
      hints: { source: 'dry-run', dryRun: true },
    })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    // slot 进度事件会把行置为 syncing：按调度器实际状态复位（预演轮不发 round-end，
    // 若此刻有真实轮在飞则保持 syncing 交给 round-end 收尾）
    const d = state.dirs.find((x) => x.id === dir.id)
    if (d && d.status === 'syncing') {
      const schedNow = window.services?.scheduler
      let busy = false
      try {
        const snap = schedNow?.getSnapshot?.()
        const slot = snap && snap.slots.find((s) => s.id === dir.id)
        busy = !!slot && (slot.state === 'running' || slot.state === 'queued')
      } catch (_) {
        busy = false
      }
      if (!busy) {
        d.status = 'idle'
        d.progress = null
      }
    }
  }
}

/** 读取某目录最新一条预演记录（trigger='dry-run'；预演结果弹窗的数据源） */
export async function latestDryRunRecord(dir: SyncDir): Promise<SyncLogEntry | null> {
  if (!window.services) return null
  try {
    const dirArg = { id: dir.id, localPath: dir.localPath, remotePath: dir.remotePath, mode: dir.mode }
    const rounds = (await window.services.sync.listSyncLog(dirArg)) as SyncLogEntry[]
    return (rounds || []).find((r) => r.trigger === 'dry-run') || null
  } catch (_) {
    return null
  }
}

// ---------- 目录管理 ----------

// ----------【实验：ZTools 插件同步】虚拟行 ----------
//
// 开关（prefs.ztoolsPluginSync）开启时，同步列表追加一条固定 id 的虚拟行：
// 本地目录由 preload 自动发现（~/.ztools/plugins，用户不可修改）、远端目录 =
// 用户可选的云端父目录（prefs.ztoolsPluginSyncRemoteDir，设置页「云端文件夹」）
// 之后固定跟上 ztools-plugins/<platformKey> 两段。行与普通目录完全同构 —— 调度器
// slot / 轮末事件 / 冲突与待处理面板经同一 id 通道流转；差异只有四点：
//   1. 不持久化到 dirs（persist 与 dirs watch 均过滤；调度器 reload 时按开关
//      现场合成）；
//   2. 身份字段不可修改（本地目录自动发现 / 远端按平台隔离 / 方式恒双向），
//      但目录级设置与服务器可改（「同步设置」弹窗）—— 落 prefs 的
//      ztoolsPluginSyncOverrides / ztoolsPluginSyncServerId（该记录唯一可
//      持久化的目录级状态，调度器 reload 合成 slot 时按同组 prefs 重建）；
//   3. 启停走 prefs.ztoolsPluginSyncPaused（setDirEnabled 路由），删除即关开关；
//   4. 排除规则享有内置默认（运行时数据库三件套，见 types.mts），与全局规则
//      叠加生效 —— 组装统一走 pluginSyncExcludePatterns（dirSyncPrefs 与调度器
//      同一函数，两路径同规则）。

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
export function refreshPluginSyncRow() {
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
  // 目录级设置与服务器来自 prefs（「同步设置」弹窗的持久化落点）：行字段与
  // prefs 始终同源 —— 保存路径（setDirOverrides / updateDir）双写保证即时响应，
  // 本函数在 init / prefs 变化时重建同一映射
  const overrides = (state.prefs.ztoolsPluginSyncOverrides as DirOverrides | null) ?? null
  const serverId = state.prefs.ztoolsPluginSyncServerId || null
  if (idx >= 0) {
    const row = state.dirs[idx]
    row.name = 'ZTools 插件'
    row.localPath = desc.pluginsDir
    row.remotePath = desc.remotePath
    row.mode = 'two-way'
    row.enabled = enabled
    row.overrides = overrides
    row.serverId = serverId
    // registrySync 是异步注入字段：重建 desc 时保留上次探测结果，避免提示条闪烁
    row.pluginSyncInfo = { ...desc, registrySync: row.pluginSyncInfo?.registrySync }
    return
  }
  state.dirs.push({
    id: ZTOOLS_PLUGINS_DIR_ID,
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
    overrides,
    serverId,
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
export async function refreshPluginRegistryState() {
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
 * 注册表降级提示条的可见性判定（DirRow 渲染共用口径，收口于此以便单测）：只有
 * 降级态（pending / denied / unavailable）提示；'ok' 表示对账通道健康 —— 自动
 * 安装已在正常工作，绝不提示。此前 'ok' 在 DirRow 的文案三分支里掉进「缺少内部
 * API」兜底分支：授权批准后对账转 ok，提示条反而以错误文案重新出现（误报）。
 * 「不再显示」按关闭时的状态指纹：指纹一致不重复提示，状态变化后重新提示 ——
 * 含 ok → 再次降级的回归形态（此时指纹是旧降级态，与新状态不同，正常复出）。
 * @param registrySync 行上的对账状态（undefined = 尚未对账过 / 非插件行，不出条）
 * @param dismissed 用户上次关闭提示条时记录的状态指纹（空串 / null = 从未关闭）
 * @returns 是否渲染提示条
 */
export function registrySyncStripVisibleFor(registrySync: string | undefined, dismissed: string | null | undefined): boolean {
  return !!registrySync && registrySync !== 'ok' && (dismissed ?? '') !== registrySync
}

/**
 * 关闭实验功能「ZTools 插件同步」（虚拟行的替代删除入口，DirRow 菜单「关闭
 * 插件同步」）：关开关并清行级暂停标记 —— 虚拟行经 prefs watch 移除、调度器
 * reload 后不再合成该 slot；电脑与云端文件都不会被删除。
 */
export function disablePluginSync() {
  state.prefs.ztoolsPluginSync = false
  state.prefs.ztoolsPluginSyncPaused = false
}

/**
 * 新增同步目录；overrides 可选（「覆盖全局设置」开启时传入，保证首次同步即用目录级参数）；
 * serverId 可选（多服务器：缺省挂当前活跃的服务器）
 */
export function addDir(localPath: string, remotePath: string, mode: SyncMode, overrides: DirOverrides | null = null, serverId?: string): SyncDir | null {
  if (!localPath || !remotePath) return null
  const dir: SyncDir = {
    id: uid(),
    name: baseName(localPath),
    localPath,
    remotePath: normalizeRemote(remotePath),
    mode,
    overrides,
    serverId: serverId || state.activeServerId || null,
    status: 'idle',
    lastSyncAt: null,
    lastResult: null,
    conflictFile: null,
    errorMessage: null,
    progress: null,
  }
  // 持久化交给 dirs 签名 watch（onDirsChanged → 防抖 persist）：签名串含 d.id，
  // push 必然触发 —— 不再显式调用，避免同一次变更双重 persist（updateDir /
  // setDirEnabled / setDirOverrides 本就只靠 watch，此处对齐）
  state.dirs.push(dir)
  // 必须用存入响应式数组后的代理对象做同步：直接用上面的原始字面量，
  // syncDir 里的 status/progress 赋值不会经过 proxy，UI 永远不会更新。
  // 首次同步：调度器在线时由（防抖 persist →）reload 后的「新目录 startup 轮」
  // 承担（避免双触发，rerun 合并，晚 ≤400ms 无碍 —— dir.id 在 push 前已生成，
  // 也不依赖落盘顺序）；无调度器形态（浏览器预览 / 降级）保持立即同步。
  const stored = state.dirs[state.dirs.length - 1]
  if (!(window.services?.scheduler && !state.demo)) void syncDir(stored)
  return stored
}

export function removeDir(id: string) {
  // 虚拟行不走删除（电脑与云端文件不删）：等价操作是关闭实验开关
  if (id === ZTOOLS_PLUGINS_DIR_ID) {
    disablePluginSync()
    return
  }
  const i = state.dirs.findIndex((d) => d.id === id)
  if (i >= 0) {
    // 持久化交给 dirs 签名 watch（同 addDir，不再显式调用避免双重 persist）；
    // fs watcher 由 preload 调度器持有：防抖 persist → reload 后自动停挂
    state.dirs.splice(i, 1)
  }
}

/** 启用 / 停用某个同步目录（停用后自动与手动同步都会跳过）；虚拟行路由到行级暂停 prefs */
export function setDirEnabled(id: string, enabled: boolean) {
  if (id === ZTOOLS_PLUGINS_DIR_ID) {
    // 虚拟行不持久化，启停的权威只有 prefs（调度器合成时映射回 enabled）
    state.prefs.ztoolsPluginSyncPaused = !enabled
    return
  }
  const d = state.dirs.find((x) => x.id === id)
  if (d) d.enabled = enabled
}

/**
 * 写入目录级设置覆盖（自动同步 / 检查频率 / 冲突处理 / 忽略隐藏 / 并发 / 限速 /
 * 租约锁 / 深度校验 / 排除规则）；插件同步虚拟行路由到 prefs.ztoolsPluginSyncOverrides
 *（该记录唯一可持久化的目录级状态，调度器 reload 合成 slot 时按同组 prefs 重建），
 * 行字段双写一份保证即时响应（prefs 深 watch 负责防抖落盘）。
 */
export function setDirOverrides(id: string, patch: DirOverrides) {
  const d = state.dirs.find((x) => x.id === id)
  if (!d) return
  if (isPluginSyncDir(d)) {
    state.prefs.ztoolsPluginSyncOverrides = { ...(state.prefs.ztoolsPluginSyncOverrides ?? {}), ...patch }
    d.overrides = state.prefs.ztoolsPluginSyncOverrides as DirOverrides
    return
  }
  d.overrides = { ...(d.overrides ?? {}), ...patch }
}

/** 清除目录级设置覆盖：全部恢复跟随全局偏好；插件同步虚拟行路由到 prefs（同步置空行字段） */
export function resetDirOverrides(id: string) {
  const d = state.dirs.find((x) => x.id === id)
  if (!d) return
  if (isPluginSyncDir(d)) {
    state.prefs.ztoolsPluginSyncOverrides = null
    d.overrides = null
    return
  }
  d.overrides = null
}

/**
 * 修改目录配置（「修改同步目录」弹窗保存入口）：
 * 本地路径变更时目录名跟随更新；overrides 为整体替换（null 表示清除全部覆盖、跟随全局）。
 * 路径 / 方式变化会通过 dirs 的序列化 watch 触发 onDirsChanged，重挂文件监听并持久化。
 * 插件同步虚拟行：身份字段（本地 / 远端 / 方式）不可修改 —— 本地目录自动发现、
 * 远端按平台隔离、方式恒双向；仅目录级设置（ztoolsPluginSyncOverrides）与服务器
 *（ztoolsPluginSyncServerId）落 prefs，行字段双写一份保证即时响应。
 */
export function updateDir(id: string, patch: { localPath?: string; remotePath?: string; mode?: SyncMode; overrides?: DirOverrides | null; serverId?: string | null }) {
  const d = state.dirs.find((x) => x.id === id)
  if (!d) return
  if (isPluginSyncDir(d)) {
    if (patch.overrides !== undefined) {
      state.prefs.ztoolsPluginSyncOverrides = patch.overrides
      d.overrides = patch.overrides
    }
    if (patch.serverId !== undefined) {
      state.prefs.ztoolsPluginSyncServerId = patch.serverId || ''
      d.serverId = patch.serverId || null
    }
    return
  }
  if (patch.localPath !== undefined) {
    d.localPath = patch.localPath
    d.name = baseName(patch.localPath)
  }
  if (patch.remotePath !== undefined) d.remotePath = normalizeRemote(patch.remotePath)
  if (patch.mode !== undefined) d.mode = patch.mode
  if (patch.overrides !== undefined) d.overrides = patch.overrides
  if (patch.serverId !== undefined) d.serverId = patch.serverId
}
