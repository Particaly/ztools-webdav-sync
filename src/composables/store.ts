/* eslint-disable */
// store.ts —— 前端 store 组合层：
//   * 调度器订阅（applySlotView / applyRoundEnd / 事件分发 —— 跨域胶水）；
//   * init 与持久化 watch、演示数据（applyDemo）、杂项 UI（指南 / 退出 / 打开目录）；
//   * useStore() 门面与既有导出的 re-export —— 17 个消费方与 render-* 单测的
//     公共 API 零变化。
// 模块级单例（state / conflictResolvers / cancelRequested / persist 防抖）在
// store-core.ts 由唯一模块实例承载；各域单向依赖：core ← dirs ← conflicts ← pending ← store。
import { computed, reactive, ref, watch } from 'vue'
import type {
  ConflictChoice,
  ConflictInfo,
  DavCapabilities,
  DavConfig,
  DavServerEntry,
  DavTier,
  DirOverrides,
  DirStatus,
  Prefs,
  RegistryReconcileResult,
  SchedulerEvent,
  SchedulerSlotView,
  SyncDir,
  SyncLogEntry,
  SyncMode,
  SyncSummary,
  ZtoolsPluginsSyncDesc,
} from '../env.d'
import { toast } from './toast'
import { MIN_INTERVAL_MIN } from './options'
import { ZTOOLS_PLUGINS_DIR_ID, resolveDirPrefs } from '../../src-ztools/preload/types.mts'
import {
  state,
  conflictResolvers,
  cancelRequested,
  capStr,
  persist,
  schedulePersist,
  flushPersist,
  loadPersisted,
  uid,
  isPluginSyncDir,
  defaultPrefs,
  baseName,
  suggestRemote,
  normalizeRemote,
  tierLabel,
  tierHint,
  sanitizeDirForPersist,
  configured,
  connStatus,
  activeConflict,
  conflictPendingCount,
  anySyncing,
  lastSyncAt,
  cloudBytes,
  insecureHttp,
  globalPauseUntil,
  autoSyncPaused,
  pauseStatusText,
  pauseAutoSync,
  resumeAutoSync,
  ensurePauseTicker,
  GUIDE_URL,
} from './store-core'
import { serverLabel, normalizeServers, setActiveServer, addServer, removeServer, serverOfDir } from './store-servers'
import { testConnection, reprobe, confirmProbeDir } from './store-connection'
import {
  dirEnabled,
  dirAutoSyncOn,
  dirIntervalMin,
  dirSyncPrefs,
  dirEngineCfg,
  cancelSync,
  runSync,
  syncDir,
  syncAll,
  dryRunDir,
  latestDryRunRecord,
  refreshPluginSyncRow,
  refreshPluginRegistryState,
  disablePluginSync,
  addDir,
  removeDir,
  setDirEnabled,
  setDirOverrides,
  resetDirOverrides,
  updateDir,
} from './store-dirs'
import { resolveConflict, openConflictFor, applyManualConflict } from './store-conflicts'
import {
  applyPendingConflicts,
  autoPromptRootLost,
  dirRootLostOpen,
  dirPendingSignal,
  allPendingSignal,
  mutePendingStrip,
  refreshPendingConflicts,
  refreshAllPendingConflicts,
  pendingConflictTotal,
  pendingCenterGroups,
  openPendingCenter,
  goPendingDir,
  applyPendingChoices,
  applyDeleteScope,
  ignorePendingConflict,
  resolveRootLost,
} from './store-pending'

// 消费方既有导入面的原样 re-export（定义移入各域模块，单一事实源不变）
export { isPluginSyncDir, defaultPrefs, baseName, suggestRemote, tierLabel, tierHint } from './store-core'
export { serverLabel } from './store-servers'
export {
  dirEnabled,
  dirAutoSyncOn,
  dirIntervalMin,
  dirSyncPrefs,
  dirEngineCfg,
} from './store-dirs'
export { dirRootLostOpen, dirPendingSignal, allPendingSignal } from './store-pending'

// 前后端共用的常量与纯函数直接取自 preload 侧 types.mts（单一事实源；该文件
// 零 import / 零副作用，vite 直接按值 import 安全，见其文件头约束说明）

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
  // 预演轮（「预演一次」）：不进行行状态机 —— 计划值不写入 lastResult / 状态与
  // 提示条都不动（结果由 DryRunModal 经 listSyncLog 的预演记录渲染）。只把 slot
  // 进度事件置出的 syncing 复位（调度器不发 round-end，收尾由本守卫承担）
  if (summary && (summary as { dryRun?: boolean }).dryRun) {
    if (dir.status === 'syncing' && !dir.progress) {
      dir.status = 'idle'
      dir.errorMessage = null
      dir.errorDetail = null
    }
    dir.progress = null
    return
  }
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
  // 该目录的实时速率随轮清零（net-speed 事件只覆盖运行中的目录，轮末事件是权威收尾）
  if (state.dirSpeeds[ev.dirId]) {
    const next = { ...state.dirSpeeds }
    delete next[ev.dirId]
    state.dirSpeeds = next
  }
  // 摘要带挂起计数（删除确认 / 后台冲突 defer / 根丢失）时兜底拉一次该目录的
  // 挂起列表：pending-conflicts 事件是主通道，但任何送达缺口都不该让「处理入口」
  // 消失 —— 目录行提示条、状态栏入口与待处理中心都依赖这份数据
  const heldCount =
    (Number(summary?.deleteHeld) || 0) + (Number(summary?.deferredConflicts) || 0) + (Number(summary?.rootLostHeld) || 0)
  if (heldCount > 0) void refreshPendingConflicts(dir)
  // 插件同步虚拟行：注册表对账在调度器轮末异步执行（fire-and-forget），降级
  // 状态略晚于本事件落地 —— 延迟一拍再取，让「未授权 / 旧宿主」提示条及时出现
  if (ev.dirId === ZTOOLS_PLUGINS_DIR_ID && !ev.cancelled) {
    setTimeout(() => void refreshPluginRegistryState(), 1500)
  }
  // 本轮结束：清空「应用到全部」勾选，下一轮冲突重新询问
  state.conflictApplyAll = false
  // 立即 persist（不防抖）：轮末承载 lastSyncAt / lastResult / 挂起摘要落盘，
  // 低频（每目录每轮一次）；防抖只会让崩溃窗口内的同步成果多暴露 400ms
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
    case 'net-speed':
      // 实时速率（1s 一拍，EMA 平滑）：全局进状态栏、每目录进行内进度行；
      // 全零事件同样落状态（展示位据此隐藏速率段）
      state.netSpeed = { upBps: ev.upBps, downBps: ev.downBps }
      state.dirSpeeds = ev.dirs
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
    case 'plugin-out':
      // 宿主隐藏 / 关闭视图（removeChildView / kill）：渲染层定时器随隐藏被节流，
      // 挂起的防抖 persist 尾沿 timer 可能被无限推迟（kill 更是不发任何卸载事件，
      // 见 scheduler.mts 头注释）—— 当场冲刷，保证隐藏前最后一次编辑落盘。
      // isKill 走同一冲刷（尽力而为路径）；无挂起时 no-op，与 pagehide /
      // visibilitychange 兜底通道重复触发无副作用
      flushPersist()
      break
    case 'scheduler-error':
      // 调度器自身异常（自举失败 / 心跳缓慢等）：仅 visible 的事件弹提示；
      // 内部机制类（选举 / 心跳 / dbStorage）只写日志，不打扰用户
      if ((ev as { visible?: boolean }).visible) toast.warning('自动同步出了点问题，稍后会重试', ev.message)
      else console.info('[webdav-sync] scheduler:', ev.message)
      break
    default:
      // config-applied：事件数据已由调度器外发，无 UI 动作
      break
  }
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

/**
 * 响应「目录列表 / 启用状态 / 目录级设置」变化的钩子（dirs 签名 watch 的回调）：
 * 防抖持久化 —— 目录配置编辑（覆盖面板 / 修改弹窗 / 启停开关）同样是连续交互，
 * 与 prefs / servers watch 同款合并；调度器经 reload 自行重建（晚 ≤400ms 远小于
 * 其 1s tick，startup / watch 轮自带 rerun 合并，不惧稍晚）。
 */
function onDirsChanged() {
  schedulePersist()
}

// ---------- 初始化 ----------

/** 卸载 / 隐藏冲刷钩子是否已注册（应用常驻单实例；幂等防 init 重入重复挂监听） */
let persistFlushHooksInstalled = false

/**
 * 注册「视图关闭 / 隐藏前冲刷挂起防抖 persist」的 DOM 兜底钩子（一次性，应用
 * 常驻永不退订）：pagehide 是文档卸载前最后且最可靠的时机（unload/beforeunload
 * 在 bfcache 等场景不可靠，pagehide 是替代标准）；visibilitychange（hidden）
 * 覆盖宿主把插件视图移出 / 最小化的形态（DOM 事件先于节流生效）。调度器转发的
 * plugin-out（handleSchedulerEvent）是第三条通道 —— 三者任一先到即冲刷，
 * flushPersist 判空 no-op，多通道重复触发无副作用。浏览器预览 / 测试桩可能没有
 * 完整 DOM：能力探测失败只跳过注册（这类形态不依赖防抖落盘的耐久性）。
 */
function installPersistFlushHooks(): void {
  if (persistFlushHooksInstalled) return
  if (typeof window.addEventListener !== 'function' || typeof document.addEventListener !== 'function') return
  persistFlushHooksInstalled = true
  window.addEventListener('pagehide', flushPersist)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushPersist()
  })
}

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
  // 立即 persist（不防抖）：归一结果必须在下方 bindScheduler 握手之前落盘 ——
  // 调度器 loadConfig 只读 dbStorage，读到旧值会把已移除档位当有效配置执行
  if (changed) persist()
}

/** 应用启动：载入配置，绑定 preload 调度器；支持 ?demo= 场景用于界面预览 */
async function init() {
  // 关闭 / 隐藏冲刷钩子最先就位：此后任何路径排入的防抖 persist 都有
  // 「视图关闭 / 隐藏前落盘」的兜底（幂等，重复调用不重复注册）
  installPersistFlushHooks()
  const persisted = loadPersisted()
  if (persisted) {
    // 服务器列表载入与迁移：servers[] 为权威形态；旧配置只有单份 server ——
    // 迁移为唯一成员（id 固定 'srv-default'，与调度器 loadConfig 的迁移同款，
    // 目录缺省 serverId 恰好指向它，行为与单服务器形态完全一致）。
    const sec = window.services?.secure
    const openPwd = (sv: DavServerEntry): DavServerEntry => {
      const out = { ...sv }
      if (sec && typeof out.password === 'string') out.password = sec.openSecret(out.password)
      return out
    }
    let loaded: DavServerEntry[] = Array.isArray(persisted.servers) ? persisted.servers.filter((s) => s && typeof s === 'object') : []
    if (!loaded.length && persisted.server && typeof persisted.server === 'object') {
      loaded = [{ id: 'srv-default', name: '', ...persisted.server }]
    }
    loaded = loaded.map((sv) => openPwd(typeof sv.id === 'string' && sv.id ? sv : { ...sv, id: 'srv-default' }))
    state.servers = loaded
    normalizeServers(persisted.activeServerId)
    state.dirs = persisted.dirs || []
    state.prefs = { ...defaultPrefs(), ...(persisted.prefs || {}) }
  } else {
    normalizeServers()
  }
  // 全局暂停恢复计时（暂停期间 30s 跳动驱动状态文案 / 到期翻转；未暂停不启动）
  if (Number(state.prefs.globalPauseUntil) !== 0) ensurePauseTicker()
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

  // 深度监听设置变化：修改后防抖持久化（连续击键合并为一次落盘；内存态即时
  // 生效，调度器经 reload 重建排程 —— reload 也随落盘合并为一次）
  watch(
    () => JSON.stringify(state.prefs),
    () => {
      schedulePersist()
    }
  )

  // 监听目录启用状态 / 目录级设置 / 路径与同步方式的修改 / 使用的服务器 / 列表
  // 增删：防抖持久化（onDirsChanged；只取这些字段的序列化特征，同步进度等
  //  运行时字段变化不会触发；插件同步虚拟行不参与特征 —— 它不持久化，增删由
  //  prefs 开关的 watch 驱动）
  watch(
    () =>
      state.dirs
        .filter((d) => !isPluginSyncDir(d))
        .map((d) => `${d.id}~${dirEnabled(d) ? 1 : 0}~${JSON.stringify(d.overrides ?? null)}~${d.localPath}~${d.remotePath}~${d.mode}~${d.serverId ?? ''}`)
        .join('|'),
    onDirsChanged
  )

  // 深度监听服务器列表变化（地址 / 账号 / netOpts / tls 的编辑与增删切换）：
  // 防抖持久化 —— 与 prefs 同款合并语义（v-model 每击键改 state，全量深克隆 +
  // reload 合并为一次），调度器经 reload 重建连接配置
  watch(
    () => JSON.stringify(state.servers),
    () => {
      schedulePersist()
    }
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
  const setDemoServer = (sv: Partial<DavServerEntry>) => {
    const entry: DavServerEntry = { id: 'demo', name: '', serverUrl: '', username: '', password: '', ...sv }
    state.servers = [entry]
    normalizeServers(entry.id)
  }
  if (scene === 'empty') {
    setDemoServer({ serverUrl: '', username: '', password: '' })
    state.dirs = []
    return
  }
  setDemoServer({
    serverUrl: 'https://dav.example.com/remote.php/dav/files/user/',
    username: 'kai.wen',
    password: 'demo-password',
  })
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
      // 演示「云端占用」来源：lastBytesTotal 合计约 2.4 GB（设置页经 cloudBytes 派生展示）
      lastBytesTotal: Math.round(1.3 * 1024 * 1024 * 1024),
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
      lastBytesTotal: Math.round(0.7 * 1024 * 1024 * 1024),
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
      lastBytesTotal: Math.round(0.4 * 1024 * 1024 * 1024),
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
    // 实时速率演示：状态栏全局速度 + 目录行每目录速度（调度器 net-speed 事件的同形数据）
    state.netSpeed = { upBps: Math.round(2.2 * 1024 * 1024), downBps: Math.round(312 * 1024) }
    state.dirSpeeds = { [dirs[0].id]: { upBps: Math.round(2.2 * 1024 * 1024), downBps: Math.round(312 * 1024) } }
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
  } else if (scene === 'add') {
    state.showAdd = true
  }
  state.dirs = dirs
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

/**
 * 在系统文件管理器中打开本地同步文件夹（目录行「更多操作」菜单）。
 * 与 shellOpenExternal 同类的纯渲染层 UI 交互（host.mts 刻意不端口化的约定），
 * 宿主缺失或打开失败尽力而为：能力缺失给一条提示，调用异常静默。
 */
function openLocalFolder(localPath: string): void {
  try {
    if (typeof window.ztools?.shellOpenPath === 'function') {
      window.ztools.shellOpenPath(localPath)
      return
    }
  } catch (_) {
    /* 打开失败（路径已不存在等）：静默，用户可自行导航 */
  }
  toast.info('当前 ZTools 版本不支持在访达 / 资源管理器中打开文件夹')
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
    globalPauseUntil,
    autoSyncPaused,
    pauseStatusText,
    pauseAutoSync,
    resumeAutoSync,
    openLocalFolder,
    dryRunDir,
    latestDryRunRecord,
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
    serverLabel,
    setActiveServer,
    addServer,
    removeServer,
    serverOfDir,
  }
}

