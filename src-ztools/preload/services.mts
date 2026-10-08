/* eslint-disable */
// WebDAV 同步插件 preload 服务：注入 window.services（Node 能力层）。
// 本文件 = 双向同步引擎（轮次编排 runSyncRound / 传输原语 / WAL 意图
// 恢复 / 目录级租约锁 / syncDirectory 单轮互斥门面）+ 渲染层服务对象 services；
// 其余逻辑域在 ./svc/ 下分模块（各文件头有域说明与依赖方向）：
//   base      —— 共享内核（fs 解析 / 共享类型 / nfc / sleep / maybeYield / logNote）
//   dav-parse —— URL / Digest / multistatus XML 解析
//   net       —— 网络层 + 请求管线（davRequest 总入口 / 熔断 / 错误工厂 mkOpError）
//   excludes  —— 五步排除链（本地与远端扫描共用的单一实现）
//   localfs   —— 本地扫描 / watcher / 哈希 / mtime 容差
//   dav       —— WebDAV 客户端 + 能力探测（listRemoteSafe / probeCapabilities）
//   planning  —— 规划纯函数（决策真值表 / 删除快照 / 改名配对 / 预检）
// 各域经显式 import 单向依赖（无环）；测试仍只经本文件单入口 + sync._internals 访问。
//
// 同步模型：
//   基准是每设备自持的基线（pluginData 下，见 store.mts），远端不存放任何状态文件。
//   决策输入：本地扫描 / 远端扫描 / 基线条目；有基线沿用三方真值表（decideAction），
//   无基线（新文件 / 基线损坏 / 新设备）一律按无基线保护语义：仅一侧存在视为新增，
//   绝不产生 delete-*；两侧都在则按 size/mtime/hash 收敛（adopt）或冲突。
import path from 'node:path'
import crypto from 'node:crypto'
import nodeTimers from 'node:timers'
import * as storage from './store.mts'
import { createScheduler, sweepSchedulerTimers } from './scheduler.mts'
import type { SchedulerFacade } from './scheduler.mts'
import { getHostPorts, setHostPorts, HOST_TRASH_MISSING_MESSAGE } from './host.mts'
import { describeZtoolsPluginsSync } from './ztools-plugins.mts'
import { getRegistryReconcileState, reconcilePluginRegistry } from './ztools-registry.mts'
import type {
  DavCapabilities,
  DeleteBatch,
  RegistryReconcileResult,
  SyncLogEntry,
  SyncLogOp,
  SyncMode,
  SyncProgress,
  ZtoolsPluginsSyncDesc,
} from './types.mts'
import {
  LIVE_TEMPS,
  REMOTE_FP_TOL_MS,
  fs,
  fsp,
  logNote,
  maybeYield,
  nfc,
  sleep,
  type DirCfg,
  type EngineCfg,
  type EnginePrefs,
  type RoundBreaker,
  type SyncHandlers,
} from './svc/base.mts'
import {
  joinRemote,
  parseMultistatus,
  relFromHref,
  remoteUrl,
  stripRemoteSlashes,
  createMultistatusStream,
  digestAuthorization,
  digestChallenges,
  parseDigestChallenge,
} from './svc/dav-parse.mts'
import {
  applyNetLimits,
  BW_UNLIMITED_BPS,
  byteBuckets,
  createRoundBreaker,
  davRequest,
  destroyNetPools,
  liveLimits,
  mkOpError,
  netTraffic,
  normalizeTlsError,
  resolveNetOpts,
  serverProfileFor,
  tlsAgentOptsFor,
} from './svc/net.mts'
import {
  ETAG_SKIP_FULL_SCAN_MS,
  PROBE_PROPFIND_BODY,
  PROBE_RESIDUE_MIN_AGE_MS,
  PROBE_TTL_MS,
  QUOTA_PROPFIND_BODY,
  effectiveCaps,
  getSyncCapabilities,
  listDirs,
  listRemote,
  listRemoteSafe,
  mkdirDeep,
  normEtag,
  openServerNoiseSafe,
  originOf,
  persistMoveUnsupported,
  probeCapabilities,
  propfindChildMap,
  recheckRemoteUnchanged,
  remotePropsEx,
  strongEtagOf,
} from './svc/dav.mts'
import {
  LOCK_NAME,
  compileExcludePatterns,
  compileExactRels,
  compileSyncExcludes,
  isJunkRel,
  isSyncTempName,
} from './svc/excludes.mts'
import {
  DIRTY_SCAN_MAX,
  checkLocalRootHealth,
  cleanupOrphanTemps,
  clearDirtyPaths,
  hashFile,
  ignoredWatchEvent,
  localFpTolMs,
  peekDirtyPaths,
  scanDir,
  scanDirSafe,
  scanDirtyFast,
  statOrNull,
  stopAllWatch,
  stopWatch,
  watchDir,
} from './svc/localfs.mts'
import {
  DELETE_BATCH_MIN,
  DELETE_BATCH_RATIO,
  ROOT_LOST_PENDING_REL,
  badFilenameError,
  buildDeleteBatch,
  checkDirOverlap,
  checkWinSegment,
  checkWindowsRel,
  computeLocalChanged,
  computeRenamePairs,
  computeUndecidedFiles,
  decideAction,
  detectCaseCollisions,
  entryFrom,
  fpMatch,
  remoteChangedMsg,
  remoteChangedVs,
  remoteUnverifiableMsg,
  scopeHitsRel,
  uploadVerifyFailedMsg,
  type RenamePair,
} from './svc/planning.mts'

// 引擎领域类型的公共出口：调度器与 env.d.ts 经本文件引用（单一事实源，
// 实际定义在 svc/base.mts）
export type { DirCfg, EngineCfg, EnginePrefs, SyncHandlers } from './svc/base.mts'

/** preload 运行环境中的 window（宿主注入 ztools API；Node 直跑测试时为伪造对象或不存在） */
declare const window: any
/**
 * 全部计时器一律经 node:timers（libuv 通道）创建，绝不用全局 setTimeout / setInterval。
 * 宿主 contextIsolation:false
 * 下 preload 与页面同处一个 Blink 世界，全局计时器就是 Blink DOM timer —— 页面真进入
 * hidden 态后会被钳到 ≥1s（满 5 分钟后约 1 次/分钟），隐藏态后台轮的锁静置 / 续租 /
 * 重试退避 / 取消轮询都会被拖到分钟级；node:timers 走 libuv，对隐藏节流完全免疫。
 * 注意：网络层的「空闲超时」不经计时器 —— mod.request 的 timeout 选项由 Node core 用
 * socket.setTimeout（libuv）实现，无需迁移。
 */
/**
 * 自动同步调度器。独立模块（无 Vue / DOM 依赖，不反向依赖本文件，
 * 引擎经参数注入），esbuild 随本文件一并打进单文件产物；文件尾部把实例挂到
 * window.services.scheduler。import 放在 storage 之后（scheduler 依赖 store）。
 */
/** 内容消歧（下载校验远端 hash）的默认上限：50MB，可由 prefs.verifyMaxBytes 覆盖 */
const DEFAULT_VERIFY_MAX_BYTES = 50 * 1024 * 1024
/**
 * 采纳内容确认的单轮总字节预算系数：默认预算 = verifyMaxBytes × 4。
 * 依据：崩溃恢复的常见形态是少数几个（1–3 个）中断文件，单文件上限的 4 倍足以完整
 * 覆盖；最坏情况把轮首额外确认 GET 的总流量封顶在「4 个最大文件」（默认 200MB，
 * 慢速广域网约数分钟），超出部分回退按大小采纳、轮次照常推进，绝不因海量待采纳
 * 文件把一轮拖成下载马拉松。prefs.adoptVerifyBudgetBytes > 0 时可直接覆盖总预算。
 */
const ADOPT_VERIFY_BUDGET_FACTOR = 4
/**
 * 开放意图（未了结的 upload 意图）的最大保留时长：30 天。
 * PUT 以 NETWORK / ABORTED / 上传读流失败收场时意图有意保持开放（服务器可能已收
 * 字节），供下一轮 recoverIntents 做半截判定；超龄意图在恢复期无条件放弃，防止
 * WAL 与内存态无限累积（另一半兜底：本地文件已不存在 / 已变化 → 恢复期放弃）。
 * 超龄按意图链最初写入时刻 firstAt 计算 —— 新意图取代旧意图时
 * 继承（runUploadOp），持续中断链（每轮半截重传再中断）的兜底时钟不被刷新，
 * 封顶真正生效；期间 WAL 每轮约增 2 行（新 intent + 旧 intent 的 abort），线性有界。
 */
const OPEN_INTENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

/**
 * 进度事件节流下限（同相位两次外发的最小间隔毫秒数）。数万文件轮次的逐文件
 * tick 与大文件传输的逐块字节 tick（byteMeter.onBytes）会以远超渲染层可消化的
 * 频率回调 onProgress（调度器缺失时渲染层直调引擎，每个事件都触发一次 Vue 响应式
 * 更新，界面卡顿）；节流后同相位事件至多 ~7Hz，进度条观感无差别。相位切换（每相位
 * 首个事件）与调用方标注的终态事件（force=true）一律外发 —— 注入式测试（「plan
 * 首事件」窗口注入）与最终计数准确性不受节流影响；计数单调不减，被丢弃的中间
 * 事件不损失信息。
 */
const PROGRESS_MIN_INTERVAL_MS = 150

/**
 * 给 onProgress 套时间节流（runSyncRound 内唯一入口，各阶段共用）。
 * 规则见 PROGRESS_MIN_INTERVAL_MS 注释；返回 (p, force?) => void。
 */
function throttledProgress(onProgress: (p: SyncProgress) => void): (p: SyncProgress, force?: boolean) => void {
  let lastPhase: any = null
  let lastAt = 0
  return (p, force = false) => {
    const t = Date.now()
    if (!force && p.phase === lastPhase && t - lastAt < PROGRESS_MIN_INTERVAL_MS) return
    lastPhase = p.phase
    lastAt = t
    onProgress(p)
  }
}

// ---------- 目录级租约锁 + 同目录单轮互斥 ----------
//
// 租约锁：跨设备的「同一目录同时同步」互斥靠远端同步根下的锁文件
//（.webdav-sync.lock）+ 服务器时钟 TTL。状态机：
//   GET 锁 → 404 空闲 / 200 解析（损坏视为过期）→ 过期判定**只用服务器时钟**
//   （响应头 date − last-modified ≥ ttlMs → 过期接管；deviceId 是本机 → 自己的遗留接管；
//    他人且未过期 → 让出本轮）→ PUT 本机锁 → 静置 LOCK_SETTLE_MS 回读确认
//   （deviceId 仍属本机 → 获得；他人 → 写回竞争失败让出；GET 失败 → 按已获得 + warning）
//   → 轮末 finally 释放（DELETE，绕过整轮熔断器单次尝试）。
// 无法写锁（PUT 403/401/网络失败等，含只读 C 档服务器）→ 跳过租约继续同步，
// 本轮仅依赖档位保护 —— 租约锁是尽力而为的互斥，绝不阻断同步本身。
//
// 获取时机（锁后置 + 按需）：规划完成后、worker 执行前，且仅当本轮计划含
// 远端写操作（upload / delete-remote / 可能落地为上传的 conflict）才尝试获取 ——
// 空轮 / 纯下载轮完全不发锁请求（省 4 个请求 + 1.5s 写回静置）。左锁补删（lockLeftover）
// 仍在轮首无条件执行，不随后置移动；能力探测随之自然落在锁外（探测写全部落在自己的
// 随机目录，无互斥风险）。
//
// 单轮互斥：本进程内的重入由模块级 ROUND_IN_FLIGHT 挡住（调度层误排 /
// 手动触发 + 定时轮重叠时，第二个轮次立即让位返回，不排队堆叠）。
/** 租约锁默认 TTL：3 分钟（锁内容 ttlMs 可覆盖，读取侧夹到 [LOCK_TTL_MIN_MS, LOCK_TTL_MAX_MS]） */
const LOCK_TTL_MS = 180000
/** 锁内容 ttlMs 的夹取区间：下界防瞬时值抖动误判过期，上界防异常大值把锁钉死 */
const LOCK_TTL_MIN_MS = 60000
const LOCK_TTL_MAX_MS = 3600000
/** PUT 锁后的静置期：他机同刻写锁的「写回竞争」在该窗口后由回读确认暴露 */
const LOCK_SETTLE_MS = 1500
/** 续租间隔：明显小于 TTL，重写锁内容（mtime 随之刷新）即完成续期 */
const LOCK_RENEW_MS = 60000
/**
 * 活动续租定时器集合：轮末 finally 与插件退出（services.cleanup）双通道清扫。
 * 崩溃注入路径（crashErr）故意不清自己的定时器（模拟进程死亡不做任何收尾），
 * 退出时的全局清扫是其唯一兜底 —— 不清扫则定时器会阻止宿主进程退出。
 */
const RENEW_TIMERS = new Set<any>()
/** 同目录单轮互斥表：key = normalizeLocalKey(localPath) + '|' + normalizeRemoteKey(remotePath) */
const ROUND_IN_FLIGHT = new Map()

/**
 * 清扫崩溃注入轮遗留的租约锁续租定时器。crashErr 路径按「模拟进程死亡」
 * 故意不做任何收尾（不 DELETE 锁、不清自己的续租定时器，见 syncDirectory 释放
 * finally 的注释）；真实进程死亡时定时器随进程消失，而测试在同一进程内模拟死亡，
 * 必须在崩溃轮断言后调用本函数做等价收尾 —— 否则遗留定时器会按 60s 周期向旧锁
 * 路径发 PUT，落进后续无关用例的观察窗（reqlog 行 / 限流预算）。
 * 遗留的锁文件本身是真实崩溃也会留下的残渣（TTL 过期 + 下轮左锁清理兜底），
 * 不在本函数职责内。返回清除的定时器个数（测试回归断言用）。
 */
function crashResidueSweep(): number {
  let cleared = 0
  for (const t of Array.from(RENEW_TIMERS)) {
    nodeTimers.clearInterval(t)
    RENEW_TIMERS.delete(t)
    cleared++
  }
  return cleared
}

/**
 * 上传单个文件（自动补齐远端父目录）。
 * expected: 计划阶段的本地指纹 {abs, size, mtimeMs}，来自本轮扫描。
 * createdDirs: 父目录缓存 Map<相对父路径, in-flight MKCOL promise> —— await 值即保证
 * 父目录已建好（并发 worker 共享同一 promise，不变量见下方建目录段注释）。
 * guards（档位保护）：
 *   recheck          —— B 档（或 A 档但扫描期 etag 弱/缺失）覆盖已存在文件前的紧邻复查；
 *   ifMatch          —— A 档覆盖已存在文件时的 If-Match（值必为强 etag，规范化后重新包裹引号）；
 *   ifNoneMatchStar  —— A 档新上传时的 If-None-Match:*（仅当目标不存在才允许创建）。
 *
 * 安全语义（对应状态机 PRE-UPLOAD-CHECK → UPLOAD → POST-CHECK）：
 *   1. 上传前重新 stat：与计划指纹不一致 → 拒绝按旧计划上传（文件已被修改，需重新规划）；
 *   2. 上传后重新 stat：与上传前不一致 → 文件在上传期间被修改，本次上传内容不可信，报错；
 *   3. HTTP 412（A 档条件头命中）：对端在扫描后修改了该文件 —— 不覆盖、本轮跳过该文件
 *      （错误信息明确标注，供排查「A 档判定后服务器又忽略条件头」等异常）。
 * 远端核验（存在性 + size 比对 + 取远端指纹写基线）不在本函数（按目录批量执行）：
 * 一个目录的上传全部完成后，由 syncDirectory 的批量校验阶段对该目录做一次 PROPFIND
 * Depth 1 统一核对并提交基线，不再逐文件一次 PROPFIND；上传前后的本地 stat 校验保留在此。
 * hooks.onBeforePut：在**前置检查（双 stat / 建目录 / B 档复查）全部通过之后、
 * PUT 请求发起之前**被 await 调用 —— 调用方（runUploadOp）在此刻才写 WAL intent，使
 * 「pre-flight 失败不产生 intent」成立；钩子抛错则 PUT 不发起、错误原样上抛。
 * hooks.onBytes：上传内容的逐块字节回调（透传网络层 ReqOpts.onBytes）—— 引擎侧
 * byteMeter 据此把实际流过的字节即时累加进传输进度（大文件上传期间进度按真实大小推进）。
 * tolMs：前置 / 后置本地 mtime 复核的容差，与规划层 localFpTolMs 同源（引擎调用点
 * 传入 localTol）——FAT 盘按 2000ms 放行的文件在操作级若仍按 1000ms 硬编码比较，
 * 会把「规划层判未变」的文件误报成「文件被改动」；缺省 1000 保持独立调用方行为。
 * 返回 { local: 上传后本地 stat, hash: 实际传输内容 sha256 }
 *（远端指纹 rsize/rmtimeMs/retag 由批量校验阶段从目录列表取，不由本函数提供）。
 */
async function uploadOne(cfg: EngineCfg, dir: DirCfg, rel: string, expected: any, createdDirs: Map<string, Promise<void>>, guards: any = {}, hooks: any = {}, tolMs: number = 1000): Promise<any> {
  // 跨平台文件名预检：Windows 非法名 / 保留名 / 尾空格点 / 超长在一切
  // 前置检查最前面拦截 —— 本机是 macOS 时同样拦截（多设备互通的另一端是 Windows）。
  // BAD_FILENAME → permanent 分类 → 失败退避表；重命名后新一轮自动恢复。
  const badName = checkWindowsRel(rel, dir && dir.localPath)
  if (badName) throw badFilenameError(rel, badName)
  // PRE-UPLOAD-CHECK：扫描之后文件若已变化，绝不能按旧计划上传（基线指纹必须对应实际上传的内容）
  const st1 = await statOrNull(expected.abs)
  if (!st1) throw new Error(`「${rel}」未上传：文件已经不在电脑上了`)
  if (st1.size !== expected.size || Math.abs(st1.mtimeMs - expected.mtimeMs) > tolMs) {
    throw new Error(`「${rel}」未上传：同步过程中文件被改动了，下次同步会重新处理`)
  }
  const segs = rel.split('/')
  if (segs.length > 1) {
    const parent = segs.slice(0, -1).join('/')
    // 缓存 in-flight promise 而非同步占位：Map 值是「in-flight 或已完成的 MKCOL」，
    // await 它保证进入 PUT 前父目录必然建好 —— 并发 worker 下同一父目录只有一个
    // 真正发起 mkdirDeep，后来者等待同一 promise，不会在目录未就绪时 PUT（假 409）。
    // 发起与 set 之间无 await（单线程内原子），后来者不可能错过这次登记。
    let p = createdDirs.get(parent)
    if (!p) {
      p = mkdirDeep(cfg, joinRemote(dir.remotePath, parent))
      // 失败驱逐：MKCOL 失败时移除条目，该目录后续文件可重试建目录，一个 rejected
      // promise 不卡死整个目录；已持有该 promise 的 worker 仍按原错误收场（逐文件
      // 独立失败语义不变）。catch 在 set 之前挂上，rejection 永远有处理者，不会
      // 触发 unhandledRejection。
      p.catch(() => { createdDirs.delete(parent) })
      createdDirs.set(parent, p)
    }
    await p
  }
  // 档位保护：B 档（或退化场景）覆盖已存在远端文件前，紧邻复查扫描期指纹
  if (guards.recheck) await recheckRemoteUnchanged(cfg, joinRemote(dir.remotePath, rel), guards.recheck, rel)
  // A 档条件头：覆盖带 If-Match（强 etag）、新上传带 If-None-Match:*
  const putHeaders: Record<string, any> = {}
  if (guards.ifMatch) putHeaders['If-Match'] = guards.ifMatch
  if (guards.ifNoneMatchStar) putHeaders['If-None-Match'] = '*'
  // intent 写入点 —— 全部前置检查已过、PUT 即将发起的唯一时刻。
  // 此前任何失败（stat 不符 / 建目录失败 / 复查不符）都不会产生 intent
  if (hooks.onBeforePut) await hooks.onBeforePut()
  // 边传边算 hash（hashAlg：摘要只覆盖最终成功的那次传输，429/503/423 重试不会污染），
  // 与实际发送字节同源（I4），不额外读盘；onBytes 透传给网络层做上传进度逐块回调
  const res = await davRequest(cfg, 'PUT', joinRemote(dir.remotePath, rel), { bodyFile: expected.abs, hashAlg: 'sha256', headers: putHeaders, onBytes: hooks.onBytes })
  if (res.status === 412) {
    // 条件保护命中：对端已变 → 不覆盖、本轮跳过（信息明确，便于排查服务器行为异常）
    throw mkOpError(remoteChangedMsg(rel, '暂未上传', true), 'PRECONDITION', {
      status: 412,
      permanent: true,
      detail: 'HTTP 412（If-Match 不匹配）',
    })
  }
  if (res.status !== 200 && res.status !== 201 && res.status !== 204) {
    // 附带 status 与分类 code：classifyOpFailure 据此判定永久 / 瞬时失败
    // （不预设 permanent —— 与该错误的原形态一致，处置交 classifyOpFailure）
    throw mkOpError(`「${rel}」上传失败（HTTP ${res.status}）`, (res.classification && res.classification.code) || 'HTTP', {
      status: res.status,
    })
  }
  // POST-CHECK：上传期间文件被修改 → 本次上传不能视为最终同步状态
  const st2 = await statOrNull(expected.abs)
  if (!st2 || st2.size !== st1.size || Math.abs(st2.mtimeMs - st1.mtimeMs) > tolMs) {
    throw new Error(`「${rel}」上传时又被修改了，请再同步一次`)
  }
  // 远端核验（VERIFY）已移至 syncDirectory 的批量校验阶段：PUT 成功 + 本地双 stat
  // 一致即返回，远端存在性 / size 与写基线用的指纹由所在目录的一次 PROPFIND Depth 1 统一提供
  return { local: st2, hash: res.hashHex }
}

/**
 * 下载单个文件（先写临时文件，通过校验后原子改名）。
 * localRel 用于「同时保留」时另存为冲突副本。
 * guards:
 *   expectedLocal      —— 计划阶段的目标指纹 {size, mtimeMs}；null 表示目标应当不存在（新文件）
 *   expectedRemoteSize —— 计划阶段扫描到的远端 size，用于发现「扫描后远端又变了」
 *   remoteMtimeMs      —— 远端 lastModified：落地后 utimes 对齐（失败忽略）
 *   origName           —— 远端原始文件名（NFD 服务器名与本机 NFC key 不一致时的实际访问名）
 *
 * 安全语义（对应状态机 DOWNLOAD_START → DOWNLOAD_TEMP → DOWNLOAD_VERIFY → LOCAL_TARGET_CHANGED? → ATOMIC_REPLACE）：
 *   1. 目标相对计划已变化（被用户修改 / 出现计划外文件 / 已消失）→ 中止，绝不覆盖用户内容；
 *   2. 临时文件大小必须与响应 Content-Length 一致（HTTP 200 ≠ 内容完整）；
 *   3. 远端大小与扫描时不一致 → 远端在同步期间变化，中止本轮该文件；
 *   4. 下载期间目标再次变化 → 中止，保留用户当前版本。
 * 任何中止都会清掉临时文件并抛错；临时文件全程登记在 LIVE_TEMPS。
 * tolMs：目标指纹复核（expectedLocal 比对与下载后复核）的本地 mtime 容差，与规划层
 * localFpTolMs 同源（引擎调用点传入 localTol）——FAT 盘规划层按 2000ms 判「未变」的
 * 文件，操作级若按 1000ms 硬编码比较会误报「文件被改动」；缺省 1000 保持独立调用方行为。
 * hooks.onBytes：下载内容的逐块字节回调（透传网络层 ReqOpts.onBytes）—— 引擎侧
 * byteMeter 据此把实际落盘的字节即时累加进传输进度（大文件下载期间进度按真实大小推进）。
 * 返回 { size, mtimeMs, hash }：rename（及 utimes）之后本地实际指纹 + 下载内容 sha256。
 */
async function downloadOne(cfg: EngineCfg, dir: DirCfg, rel: string, tmpDir: string, localRel: string | null, guards: any = {}, tolMs: number = 1000, hooks: any = {}): Promise<any> {
  // Windows 目标名预检（仅 win32）：远端来的非法名在本地文件系统必然创建失败，
  // 与其等到 EINVAL / silently-converted 不如前置报错（错误同走 BAD_FILENAME）。
  // 非 win32 平台放行 —— macOS / Linux 本身可落盘；上传侧预检已保证它将来
  // 不会被本插件传向 Windows 端（上传是唯一入口）。
  if (process.platform === 'win32') {
    const badName = checkWindowsRel(localRel || rel, dir && dir.localPath)
    if (badName) throw badFilenameError(rel, badName)
  }
  const remote = joinRemote(dir.remotePath, rel)
  const segs = (localRel || rel).split('/')
  if (guards.origName && !localRel) segs[segs.length - 1] = guards.origName
  const abs = path.join(dir.localPath, ...segs)
  const before = await statOrNull(abs)
  if (guards.expectedLocal) {
    if (!before) throw new Error(`「${rel}」未下载：电脑上的文件刚被修改或出现变化，已保留你的版本，没有覆盖`)
    if (before.size !== guards.expectedLocal.size || Math.abs(before.mtimeMs - guards.expectedLocal.mtimeMs) > tolMs) {
      throw new Error(`「${rel}」未下载：电脑上的文件刚被修改或出现变化，已保留你的版本，没有覆盖`)
    }
  } else if (before) {
    // 计划时目标不存在，现在却存在：计划外出现的内容一律不覆盖
    throw new Error(`「${rel}」未下载：电脑上的文件刚被修改或出现变化，已保留你的版本，没有覆盖`)
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true })
  const tmp = path.join(tmpDir, `.wdsync-dl-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  LIVE_TEMPS.add(tmp)
  let res: any = null
  try {
    // hashAlg：下载内容摘要由网络层在最终成功的那次传输中计算（重试不污染）；
    // onBytes 透传给网络层做下载进度逐块回调
    res = await davRequest(cfg, 'GET', remote, { sinkFile: tmp, hashAlg: 'sha256', onBytes: hooks.onBytes })
    if (res.status !== 200) {
      // 附带 status 与分类 code：classifyOpFailure 据此判定永久 / 瞬时失败
      throw mkOpError(`「${rel}」下载失败（HTTP ${res.status}）`, (res.classification && res.classification.code) || 'HTTP', {
        status: res.status,
      })
    }
    // DOWNLOAD_VERIFY：临时文件与 Content-Length 一致
    const tmpSt = await statOrNull(tmp)
    if (!tmpSt) {
      const e: any = new Error(`「${rel}」下载不完整，下次同步会重试`)
      e.detail = '临时文件丢失'
      throw e
    }
    const cl = res.headers && res.headers['content-length'] ? Number(res.headers['content-length']) : null
    if (cl != null && tmpSt.size !== cl) {
      const e: any = new Error(`「${rel}」下载不完整，下次同步会重试`)
      e.detail = `收到 ${tmpSt.size} 字节，响应声明 ${cl} 字节`
      throw e
    }
    // 远端相对扫描时已变化：本轮数据不可信，下一轮重新规划
    if (guards.expectedRemoteSize != null && cl != null && cl !== guards.expectedRemoteSize) {
      const e: any = new Error(`「${rel}」未下载：下载期间云端文件被修改了，下次同步重试`)
      e.detail = `${guards.expectedRemoteSize} → ${cl} 字节`
      throw e
    }
    // LOCAL_TARGET_CHANGED?：下载期间目标被用户修改 → 不 rename、不覆盖
    const after = await statOrNull(abs)
    if ((before == null) !== (after == null) || (before && after && (before.size !== after.size || Math.abs(before.mtimeMs - after.mtimeMs) > tolMs))) {
      throw new Error(`「${rel}」未下载：电脑上的文件刚被修改或出现变化，已保留你的版本，没有覆盖`)
    }
    // 计划内覆盖（expectedLocal 守卫已通过、目标仍存在）：先把本地旧版本移入
    // 系统回收站再落地新内容 —— 与删除语义统一，被覆盖的旧版可从回收站找回
    //（另一台设备误改 / 勒索加密 / 保存损坏时的最后一道本地保险）。回收站
    // 失败绝不退化直接覆盖：放弃本次下载、旧版原地保留，按瞬时失败下一轮重试。
    // before 为空（全新下载 / 冲突副本另存）不涉及覆盖，零开销不触发。
    if (before) {
      try {
        await getHostPorts().trashItem(abs)
      } catch (e: any) {
        const err: any = new Error(`「${rel}」未下载：电脑上的旧版本无法移入回收站，已保留现有文件，下次同步重试`)
        err.detail = (e && e.message) || String(e)
        throw err
      }
    }
    await fsp.rename(tmp, abs)
    // rename 落地后 fsync 目标目录（POSIX）——让新目录项掉电级落盘；
    // Windows 无法打开目录句柄，fsyncDirIfPossible 内部跳过（store.js 已知边界）
    await storage.fsyncDirIfPossible(path.dirname(abs))
  } catch (e: any) {
    // 统一清理：网络异常 / 校验失败 / 中止都会走到这里
    LIVE_TEMPS.delete(tmp)
    await fsp.unlink(tmp).catch(() => {})
    throw e
  }
  LIVE_TEMPS.delete(tmp) // rename 成功后临时路径已消失，生命周期结束
  // 按远端 lastModified 对齐本地 mtime（失败忽略），使基线与下一轮比较稳定
  if (guards.remoteMtimeMs > 0) {
    const t = new Date(guards.remoteMtimeMs)
    await fsp.utimes(abs, t, t).catch(() => {})
  }
  const st = await fsp.stat(abs)
  return { size: st.size, mtimeMs: st.mtimeMs, hash: res.hashHex }
}

/**
 * 内容消歧 —— 把远端文件下载到临时文件流式算 hash（不落地目标路径），
 * 用于「指纹变了但 size 相同」时判断远端是否真的变了。超限 / 失败返回 null（按远端已变处理）。
 * 另被 recoverIntents 复用：开放意图采纳前的内容确认（GET hash 对比本地）。
 */
async function verifyRemoteHash(cfg: EngineCfg, dir: DirCfg, rel: string, r: any): Promise<string | null> {
  const tmp = path.join(dir.localPath, `.wdsync-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  LIVE_TEMPS.add(tmp)
  try {
    // 下载到临时文件流式算 hash（hashAlg 由网络层按次创建，重试后摘要仍正确）
    const res = await davRequest(cfg, 'GET', joinRemote(dir.remotePath, rel), { sinkFile: tmp, hashAlg: 'sha256' })
    if (res.status !== 200) return null
    const st = await statOrNull(tmp)
    if (!st || st.size !== r.size) return null
    return res.hashHex != null ? res.hashHex : null
  } catch (_) {
    return null
  } finally {
    LIVE_TEMPS.delete(tmp)
    await fsp.unlink(tmp).catch(() => {})
  }
}

/**
 * 逐块比较两个文件的前 n 字节是否一致。
 * 固定 64KB 缓冲顺序读，不整文件读入内存；任一文件短读 / IO 异常返回 null（无法判定）。
 * @returns {Promise<'match'|'mismatch'|null>}
 */
async function filesPrefixEqual(aPath: string, bPath: string, n: number): Promise<'match' | 'mismatch' | null> {
  if (!(n > 0)) return 'match' // 空前缀平凡相等（size=0 的半截形态）
  const fa = await fsp.open(aPath, 'r').catch(() => null)
  const fb = await fsp.open(bPath, 'r').catch(() => null)
  if (!fa || !fb) {
    if (fa) await fa.close().catch(() => {})
    if (fb) await fb.close().catch(() => {})
    return null
  }
  const BUFSZ = 65536
  const ba = Buffer.allocUnsafe(BUFSZ)
  const bb = Buffer.allocUnsafe(BUFSZ)
  try {
    let off = 0
    while (off < n) {
      const want = Math.min(BUFSZ, n - off)
      const [ra, rb] = await Promise.all([fa.read(ba, 0, want, null), fb.read(bb, 0, want, null)])
      if (ra.bytesRead !== want || rb.bytesRead !== want) return null
      if (ba.compare(bb, 0, want, 0, want) !== 0) return 'mismatch'
      off += want
    }
    return 'match'
  } catch (_) {
    return null
  } finally {
    await fa.close().catch(() => {})
    await fb.close().catch(() => {})
  }
}

/**
 * 流式 GET 远端文件，与本地文件的前 rsize 字节逐块比对，
 * 判定远端是否为「本机自己中断上传留下的半截」。调用方已保证 0 ≤ rsize < 本地大小
 * 且 rsize ≤ verifyMaxBytes。
 * 远端下载经 .wdsync-verify- 临时文件（复用网络层重试 / 取消销毁 / hash 基础设施；
 * 受扫描排除与孤儿清理管辖）；GET 到的字节数与扫描期 rsize 不一致（GET 与扫描之间
 * 对端又变）按无法判定处理。
 * @returns {Promise<'match'|'mismatch'|null>} null = GET 失败 / 大小漂移 / IO 异常（无法判定）
 */
async function remoteIsLocalPrefix(cfg: EngineCfg, dir: DirCfg, rel: string, localAbs: string, rsize: number): Promise<'match' | 'mismatch' | null> {
  const tmp = path.join(dir.localPath, `.wdsync-verify-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  LIVE_TEMPS.add(tmp)
  try {
    const res = await davRequest(cfg, 'GET', joinRemote(dir.remotePath, rel), { sinkFile: tmp })
    if (res.status !== 200) return null
    const st = await statOrNull(tmp)
    if (!st || st.size !== rsize) return null
    return await filesPrefixEqual(tmp, localAbs, rsize)
  } catch (_) {
    return null
  } finally {
    LIVE_TEMPS.delete(tmp)
    await fsp.unlink(tmp).catch(() => {})
  }
}

/**
 * 删除本地文件 —— 一律移入回收站（经宿主端口层，默认端口绑定
 * ztools.shellTrashItem，宿主侧为 Electron shell.trashItem：macOS 进废纸篓 /
 * Windows 进回收站）。绝不退化为 unlink：回收站端口不可用（宿主未注入 / 测试
 * 环境缺失）或调用失败（权限、卷不支持、文件被占用等）一律抛错 —— 调用方按
 * 「跳过该文件并记录」处理，基线条目保留，文件留在原地，下一轮重试。文件本就
 * 不存在视为成功（目标状态达成）。
 * origName：基线记录的原始文件名（NFD 服务器 / 旧系统命名与 NFC key 不一致时用原名访问）。
 */
async function deleteLocalOne(dir: DirCfg, rel: string, origName?: string): Promise<void> {
  const segs = rel.split('/')
  if (origName) segs[segs.length - 1] = origName
  const abs = path.join(dir.localPath, ...segs)
  if (!(await statOrNull(abs))) return // 已不存在：目标状态达成
  // 接口缺失由默认端口抛固定文案（HOST_TRASH_MISSING_MESSAGE）：与调用失败是两类
  // 形态 —— 此处按端口化之前的文案逐字分别还原，既有断言与用户可见信息不变
  try {
    await getHostPorts().trashItem(abs)
  } catch (e: any) {
    const msg = (e && e.message) || e
    if (msg === HOST_TRASH_MISSING_MESSAGE) {
      throw new Error(`无法删除电脑上的「${rel}」：当前 ZTools 版本不支持放入回收站，文件已保留`)
    }
    const err: any = new Error(`无法删除「${rel}」：未能放入回收站，文件已保留`)
    err.detail = msg
    throw err
  }
  // 防御：trashItem 成功返回但文件仍在（异常宿主实现）按失败处理，
  // 绝不出现 summary.deleted++ 但文件还在的状态
  if (await statOrNull(abs)) {
    const err2: any = new Error(`无法删除「${rel}」：未能放入回收站，文件已保留`)
    err2.detail = '移入回收站后文件仍存在'
    throw err2
  }
}

// ---------- 永久失败分类与退避 ----------

/**
 * 对执行期单个传输操作的失败做三分类，决定「记退避表 / 当轮重试 / 普通报错」：
 *   'permanent' —— 文件级永久失败：HTTP 413（过大）/ 507（配额不足）/ 403 / 405（权限
 *                  拒绝）、本地 EACCES / EPERM（以系统码判，包装消息不可靠）、预留的
 *                  BAD_FILENAME（Windows 预检不通过的文件名，见上传前置检查）。重试大概率原地再败，
 *                  记入 failures.json 按指数退避跳过，避免每轮撞墙；
 *   'transient' —— 瞬时失败：HTTP 423（被锁）、网络层 NETWORK（重试耗尽）、本地写入
 *                  EBUSY（文件被占用，包装消息含系统码）。当轮后段重试一次，下轮自然
 *                  重试，不记录退避表；
 *   'normal'    —— 其余：当轮报错、下轮重试，不记录。
 *
 * 分类规则说明：
 *   - 401 不入 permanent：认证失败是配置级问题（密码错 / 授权过期），应整轮明确报错
 *     提醒用户修改配置，静默跳过只会掩盖故障；
 *   - 不直接采用错误对象的 permanent 字段：REMOTE_CHANGED（复查发现对端已变）与
 *     PRECONDITION（412 条件保护命中）虽标 permanent，但它们是「本轮不覆盖、下轮
 *     重新规划」的正常保护路径，不该进退避表；CIRCUIT_OPEN（整轮熔断的快速失败）
 *     同理 —— 熔断后剩余文件下轮自然重试，绝不记为持续失败；
 *   - 本地删除失败（deleteLocalOne 的包装错误不带系统码字段）按 normal 处理：权限
 *     恢复后下一轮立即重试（保留既有「ACL 复位后当轮即可删除成功」的语义）。
 */
function classifyOpFailure(e: any): 'permanent' | 'transient' | 'normal' {
  if (!e || typeof e !== 'object') return 'normal'
  if (e.code === 'BAD_FILENAME') return 'permanent' // Windows 文件名预检（uploadOne / win32 下载前置）
  const st = Number(e.status) || 0
  if (st === 413 || st === 507 || st === 403 || st === 405) return 'permanent'
  if (e.code === 'EACCES' || e.code === 'EPERM') return 'permanent'
  if (st === 423) return 'transient'
  if (e.code === 'NETWORK') return 'transient'
  if (e.code === 'EBUSY') return 'transient'
  if (e.code === 'LOCAL_IO' && /EBUSY/.test(String(e.message || ''))) return 'transient'
  return 'normal'
}

/**
 * 判定错误是否属「网络类」（summary.failureClass 的逐条输入）。
 * 与整轮熔断的计数口径完全一致（requestWithRetry 的 noteFailure 判定）：
 * 网络层异常耗尽重试（NETWORK）、熔断快速失败（CIRCUIT_OPEN）、终态 429/423/5xx。
 * 与 classifyOpFailure 的分工：后者决定单文件失败后的处置（退避表 / 当轮重试 / 报错），
 * 本函数只回答「这条失败可否归因为服务器不可用」—— 供调度层跨轮退避的机器可读归纳，
 * 4xx 条件保护（412/REMOTE_CHANGED）与本地 IO 类不算网络类。
 */
function networkFailure(e: any): boolean {
  if (!e || typeof e !== 'object') return false
  if (e.code === 'NETWORK' || e.code === 'CIRCUIT_OPEN') return true
  const st = Number(e.status) || 0
  return st === 429 || st === 423 || (st >= 500 && st < 600)
}

/**
 * WAL 崩溃恢复：本轮扫描完成后，核对上一轮遗留的未了结意图。
 * 每个意图的裁决 ∈ { 采纳(done) / 放弃(abort) / 判定半截转重传(保持开放) / 保持开放(保守) }。
 *  - upload 意图：
 *    0. 超龄（> OPEN_INTENT_MAX_AGE_MS）或本地自意图起已不存在 / 已变化 → 放弃
 *       （两条防累积兜底；本地已变时半截判定失去前提，绝不能按旧意图重传）；
 *    1. 采纳：远端已存在与本地同 size 文件 → GET 内容确认（上限 verifyMaxBytes；
 *       GET 失败 / 超限回退按 size 采纳 —— 窄洞保留（已知边界）；内容不符
 *       则确定「不是自己的完成品」→ 放弃，交正常规划）；
 *    2. 判定半截（判定链全部满足）：存在开放 upload 意图 + 本地未变 + 远端现指纹
 *       ≠ 意图记录的上传前指纹 + 0 ≤ 远端 size < 本地 size + 流式前缀校验通过 →
 *       该 rel 记入返回的 forceUploads 集合，本轮强制规划为 upload（A 档 If-Match 用
 *       本轮扫描 etag、B 档照旧复查；意图保持开放，强制重传写入的新意图按「新者取代
 *       旧者」了结它）。size=0 走同一条前缀校验（空前缀平凡通过）；
 *       前缀不符 → 确定非己方半截 → 放弃；GET 失败 / 超 verifyMaxBytes → 保守保持
 *       开放（本轮正常规划进冲突，冲突弹窗带「疑似残缺文件」提示，意图下轮再判）；
 *    3. 其余（服务器原子未落地、对端真实修改等）→ 保持开放，正常规划照旧。
 *       绝不使用 mtime 时间窗启发（多设备时钟不同源）。
 *  - download 意图：远端未再变（PROPFIND 指纹与意图一致）且本地已存在同 size 文件 →
 *    采纳（同样做 GET 内容确认，失败回退 size 采纳）；否则放弃。下载意图不保持
 *    开放：远端从无「我方半截」问题，重推导安全。
 *  - 删除类意图不采纳：删除可由规划按旧基线幂等重推导（delete-local / delete-remote 的
 *    真值表行会再次得出同一动作）；直接「采纳=删条目」反而会让 delete-local 场景把
 *    已删文件当作新远端文件下载回来（无基线 + 仅远端存在 → download）。
 * 采纳时对本地文件重算一次 hash 作为 lhash（意图中不含传输中途算出的 hash）。
 * @param adoptBudgetBytes 采纳内容确认的单轮总字节预算（runSyncRound
 *        解析后传入；默认 verifyMaxBytes × ADOPT_VERIFY_BUDGET_FACTOR）。预算按
 *        「实际发出的确认 GET 的目标大小」扣减；耗尽后剩余条目不再发 GET，回退
 *        「按大小采纳」并计入轮末的一条汇总 warning（不逐文件刷屏）。
 * @returns {Promise<Set<string>>} 半截判定命中、本轮须强制规划为 upload 的 rel 集合（nfc key）
 */
async function recoverIntents(store: storage.DirStateStore, cfg: EngineCfg, dir: DirCfg, localByNfc: Map<string, any>, remoteByNfc: Map<string, any>, localTol: number, verifyMaxBytes: number | undefined, pushWarning: (msg: string) => void, adoptBudgetBytes: number | undefined): Promise<Set<string>> {
  const vMax = verifyMaxBytes ?? Number.NaN // undefined 时比较恒 false（不设上限的原语义）
  const forceUploads = new Set<string>()
  const intents: any[] = Array.from(store.pendingIntents.values())
  let adoptBytesLeft = adoptBudgetBytes ?? Number.POSITIVE_INFINITY
  const adoptBudgetSkipped: any[] = [] // 因预算耗尽回退按大小采纳的 rel（轮末汇总一条）
  /** 发出一次采纳确认 GET（预算内）—— 返回 false = 预算耗尽未发出（与 GET 失败的 null 区分） */
  const adoptVerifyGet = async (rel: any, r: any) => {
    if (adoptBytesLeft < r.size) {
      adoptBudgetSkipped.push(rel)
      return false
    }
    adoptBytesLeft -= r.size
    return verifyRemoteHash(cfg, dir, rel, r)
  }
  for (const it of intents) {
    const rel = nfc(it.rel || '')
    const l = localByNfc.get(rel)
    const rEntry = remoteByNfc.get(rel)
    const r = rEntry && !rEntry.isDir ? rEntry : null
    const settle = (adopted: any, warning: any) =>
      (adopted ? store.appendWalDone(it.id) : store.appendWalAbort(it.id)).catch(() => {}).then(() => {
        if (warning) logNote(warning)
      })
    // 兜底一：开放意图超龄 —— 按意图链最初写入时刻（firstAt，由新意图继承；
    // 缺失回退 at —— 注入 / download 类意图）计算，持续中断链不会因每轮「新者取代旧者」
    // 而免于封顶。at 与 firstAt 均缺失按超龄处理（现行写入点必有 at）→ 无条件放弃
    const bornAt = Number(it.firstAt) > 0 ? Number(it.firstAt) : Number(it.at)
    if (!(bornAt > 0) || Date.now() - bornAt > OPEN_INTENT_MAX_AGE_MS) {
      await settle(false, `崩溃恢复：${it.rel} 的开放意图已超龄（> ${Math.round(OPEN_INTENT_MAX_AGE_MS / 86400000)} 天），按放弃处理`)
      continue
    }
    if (it.op === 'upload') {
      const lp = it.local || {}
      const localUnchanged = l && l.size === lp.size && Math.abs((l.mtimeMs || 0) - (lp.mtimeMs || 0)) <= localTol
      // 兜底二：本地已不存在 / 已变化 → 意图失去意义（半截判定前提不成立），放弃
      if (!localUnchanged) {
        await settle(false, `崩溃恢复：${it.rel} 的开放上传意图已放弃（本地文件已变化或不存在），按正常流程重新规划`)
        continue
      }
      // ---- 采纳（既有语义 + 内容确认 + 单轮字节预算）----
      if (r && r.size === lp.size) {
        const lhash = await hashFile(l.abs).catch(() => null)
        let contentOk = true // 缺省可采纳：本地 hash 算不出 / 超限 / GET 失败 / 预算耗尽均回退按 size 采纳
        let confirmed = false // 是否实际完成过一次 GET 内容比对
        let budgetSkipped = false // 因预算耗尽未发 GET —— 逐文件提示由轮末汇总取代
        if (lhash != null && r.size <= vMax) {
          const rh = await adoptVerifyGet(rel, r)
          if (rh === false) {
            budgetSkipped = true
          } else if (rh != null) {
            confirmed = true
            contentOk = rh === lhash
          }
        }
        if (contentOk) {
          // GET 失败 / 超限（confirmed=false 且非预算耗尽）的回退：按 size 采纳
          //（已知窄洞）；预算耗尽的回退不逐文件提示（轮末汇总一条）。
          // 基线写入失败按放弃处理（与旧语义一致：setEntry 抛错绝不写 done）
          let wrote = false
          try {
            await store.setEntry(rel, entryFrom(l, r, lhash, { origName: r.origName }))
            wrote = true
          } catch (_) {}
          await settle(wrote, wrote ? (confirmed ? `崩溃恢复：${it.rel} 已按意图日志采纳（内容已确认，无重传、无冲突）` : budgetSkipped ? null : `崩溃恢复：${it.rel} 按大小采纳上传意图（内容确认未完成）`) : null)
          continue
        }
        // 内容不符且经 GET 确认：远端同 size 但内容并非本地 —— 不是自己的完成品，
        // 也不可能是自己的半截（size 相等），放弃后交正常规划（通常进冲突由用户裁决）
        await settle(false, `崩溃恢复：${it.rel} 远端内容与本地不一致，未采纳上传意图，按冲突处理`)
        continue
      }
      // ---- 半截判定链（任一不满足走保守路径 = 保持开放、正常规划）----
      const remoteWas = it.remote || null
      const remoteDiffers = remoteWas
        ? remoteChangedVs(r, { rsize: remoteWas.size, rmtimeMs: remoteWas.mtimeMs, retag: remoteWas.etag })
        : !!r
      if (r && remoteDiffers && r.size >= 0 && r.size < lp.size && lp.size > 0) {
        if (r.size > vMax) {
          // 超上限：无法安全判定 → 保持开放 + 冲突弹窗提示（经 onConflict info.hint）
          pushWarning(`「${it.rel}」在云端可能是上次没传完的不完整文件，但文件太大无法自动对比，请你选择保留哪一个`)
          continue
        }
        const verdict = await remoteIsLocalPrefix(cfg, dir, rel, l.abs, r.size)
        if (verdict === 'match') {
          // 同 rel 多个开放意图（历史残留 / 崩溃窗口）只提示一次，forceUploads 天然去重
          if (!forceUploads.has(rel)) pushWarning(`「${it.rel}」在云端是上次没传完的不完整文件，已自动重新上传`)
          forceUploads.add(rel)
          continue // 意图保持开放：强制重传的新意图将以「新者取代旧者」了结它
        }
        if (verdict === 'mismatch') {
          // 远端虽小于本地但内容并非本地前缀 —— 对端真实修改，确定非己方半截，放弃
          await settle(false, `崩溃恢复：${it.rel} 远端内容与本地不符（非本机半截），按冲突处理`)
          continue
        }
        // verdict === null：GET 失败 / 大小漂移 —— 保持开放，本轮正常规划（可能进冲突），下轮再判
        continue
      }
      // 保守路径（服务器原子未落地 / 对端改大 / 远端不存在等）：保持开放，正常规划照旧
      continue
    }
    if (it.op === 'download') {
      const rp = it.remote || {}
      const remoteOk =
        r &&
        r.size === rp.size &&
        (!rp.etag || rp.etag === (r.etag || '')) &&
        Math.abs((r.mtimeMs || 0) - (rp.mtimeMs || 0)) <= REMOTE_FP_TOL_MS
      if (remoteOk && l && l.size === rp.size) {
        const lhash = await hashFile(l.abs).catch(() => null)
        let contentOk = true
        if (lhash != null && r.size <= vMax) {
          const rh = await adoptVerifyGet(rel, r)
          if (rh !== false && rh != null) contentOk = rh === lhash
        }
        if (contentOk) {
          let wrote = false
          try {
            await store.setEntry(rel, entryFrom(l, r, lhash, { origName: r.origName }))
            wrote = true
          } catch (_) {}
          await settle(wrote, wrote ? `崩溃恢复：${it.rel} 已按意图日志采纳（无重传、无冲突）` : null)
          continue
        }
        // 内容不符（同 size 对端替换）不采纳：放弃后由规划按无基线语义重新收敛
      }
      await settle(false, null)
      continue
    }
    // 删除类 / 未知操作：一律放弃（幂等重推导语义不变）
    await settle(false, null)
  }
  // 汇总：预算耗尽而回退「按大小采纳」的条目 —— 一条 warning 带计数，不逐文件刷屏
  //（同尺寸对端替换可能被静默采纳的窄洞与 GET 失败回退同源，属已知边界）
  if (adoptBudgetSkipped.length > 0) {
    const fmtMB = (n: any) => `${(n / (1024 * 1024)).toFixed(1)}MB`
    logNote(
      `崩溃恢复：${adoptBudgetSkipped.length} 个文件的采纳内容确认超出本轮预算（${fmtMB(adoptBudgetBytes)}），已按大小采纳（窄洞见 README 已知边界）`
    )
  }
  return forceUploads
}

/**
 * 获取目录级租约锁。调用时机（锁后置 + 按需）：runSyncRound 规划完成后、
 * B 档写前查重与 worker 执行之前，且仅当本轮剩余计划含远端写操作时才被调用
 *（空轮 / 纯下载轮零锁请求；详见 runSyncRound 内「按需拿锁」注释）。
 *
 * 状态机（返回值 outcome）：
 *   'acquired' —— 已获得锁（可附带 warn：回读异常但按已获得处理的尽力而为 warning）
 *   'yield'    —— 他人持有有效锁（未过期且非本机遗留）或写回竞争失败：本轮让出
 *   'skip'     —— 无法读写锁（PUT 403/401、GET 非 404/200、网络失败等）：跳过租约继续同步
 *
 * 服务器时钟过期判定（**只用服务器时钟**，绝不用本机时钟 —— 本机时钟偏移会误判）：
 *   响应头 date（服务器当前时间）− last-modified（锁文件 mtime）≥ ttlMs → 过期。
 *   Date / Last-Modified 头缺失或不可解析时差值为 NaN，比较恒为 false → 不判过期
 *   （保守让出，绝不偷走无法证明已过期的锁；自己的遗留仍可按 deviceId 接管，
 *   真实过期场景由「配合的服务器都会发 Date 头」兜底 —— HTTP/1.1 服务器应答
 *   Date 属 SHOULD 级要求，缺失属异常服务器）。
 * @param cfg 连接配置（含整轮熔断器；锁请求计入轮次开销）
 * @param lockPath 锁文件远端绝对路径（joinRemote(dir.remotePath, LOCK_NAME)）
 * @param deviceId 本机设备 ID
 * @returns {Promise<{outcome: 'acquired'|'yield'|'skip', warn?: string, startedAt?: string}>}
 *          startedAt 仅在 acquired 时返回（首次获取时刻，续租时保持不变）
 */
async function acquireLeaseLock(cfg: EngineCfg, lockPath: string, deviceId: string): Promise<any> {
  // 1. GET 现锁：404 → 空闲；200 → 解析内容与服务器时钟年龄
  let state: any = null // null = 空闲；否则 { own, expired }（损坏内容直接按过期处理）
  try {
    const r = await davRequest(cfg, 'GET', lockPath)
    if (r.status === 200) {
      let body: any = null
      try {
        body = JSON.parse(r.body ? r.body.toString('utf-8') : '')
      } catch (_) {
        body = null
      }
      if (!body || typeof body !== 'object') {
        state = { own: false, expired: true } // 内容损坏：视为过期 → 接管
      } else {
        const ttl = Math.min(LOCK_TTL_MAX_MS, Math.max(LOCK_TTL_MIN_MS, Number(body.ttlMs) > 0 ? Number(body.ttlMs) : LOCK_TTL_MS))
        const dateMs = Date.parse((r.headers && r.headers.date) || '')
        const lmMs = Date.parse((r.headers && r.headers['last-modified']) || '')
        const expired = Number.isFinite(dateMs) && Number.isFinite(lmMs) && dateMs - lmMs >= ttl
        state = { own: String(body.deviceId || '') === deviceId, expired }
      }
    } else if (r.status !== 404) {
      // 401/403/5xx 等异常：读不到锁就无法安全判定 → 与「无法写锁」同路径跳过租约
      return { outcome: 'skip', warn: `无法读取租约锁（HTTP ${r.status}）：本轮仅依赖档位保护` }
    }
  } catch (e: any) {
    // 取消销毁了取锁请求 → 静默按 skip 收场（锁未持有、轮次即将按取消终止，
    // 不产生「无法读取租约锁」的用户噪声）
    if (e && e.code === 'ABORTED') return { outcome: 'skip' }
    return { outcome: 'skip', warn: `无法读取租约锁（${(e && e.message) || e}）：本轮仅依赖档位保护` }
  }
  // 他人持有且未过期（服务器时钟年龄 < ttl 且非本机遗留）→ 让出；其余（空闲 / 过期 /
  // 自己的遗留 / 内容损坏）→ 接管
  if (state && !state.own && !state.expired) return { outcome: 'yield' }

  // 2. PUT 本机锁内容（覆盖旧锁 = 接管；写失败 → 跳过租约继续同步，走档位保护）
  const startedAt = new Date().toISOString()
  try {
    const r = await davRequest(cfg, 'PUT', lockPath, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ v: 1, deviceId, startedAt, ttlMs: LOCK_TTL_MS }),
    })
    if (r.status >= 400) {
      return { outcome: 'skip', warn: `无法创建租约锁（HTTP ${r.status}）：本轮仅依赖档位保护` }
    }
  } catch (e: any) {
    // 取消销毁了写锁请求 → 静默按 skip 收场（同上方 GET 路径的取消豁免）
    if (e && e.code === 'ABORTED') return { outcome: 'skip' }
    return { outcome: 'skip', warn: `无法创建租约锁（${(e && e.message) || e}）：本轮仅依赖档位保护` }
  }

  // 3. 静置后回读确认：他机同刻写锁（写回竞争）在该窗口后暴露 —— 回读到别人的
  //    deviceId 说明竞争失败，让出；GET 失败按已获得处理（尽力而为，不因服务器
  //    抖动放弃整轮互斥机会）。回读内容损坏同按已获得（下一台设备会按过期接管）。
  await sleep(LOCK_SETTLE_MS)
  try {
    const r = await davRequest(cfg, 'GET', lockPath)
    if (r.status === 200) {
      let body: any = null
      try {
        body = JSON.parse(r.body ? r.body.toString('utf-8') : '')
      } catch (_) {
        body = null
      }
      if (body && typeof body === 'object' && String(body.deviceId || '') !== deviceId) {
        return { outcome: 'yield' } // 写回竞争失败：别人的内容在锁文件里
      }
      return { outcome: 'acquired', startedAt, warn: body ? undefined : '租约锁回读内容损坏：按已获得处理（尽力而为）' }
    }
    return { outcome: 'acquired', startedAt, warn: `租约锁回读异常（HTTP ${r.status}）：按已获得处理（尽力而为）` }
  } catch (e: any) {
    // 取消销毁了回读请求 → 锁已写入，按已获得处理且不告警（外层 finally 会
    // 照常 DELETE —— 释放请求同样豁免取消检查）
    if (e && e.code === 'ABORTED') return { outcome: 'acquired', startedAt }
    return { outcome: 'acquired', startedAt, warn: `租约锁回读失败（${(e && e.message) || e}）：按已获得处理（尽力而为）` }
  }
}

/**
 * 同步单个目录的公开入口（同目录单轮互斥包装）。
 *
 * 同一「本地目录 × 远端目录」在**本进程内**同时只允许一个轮次：调度层误排 /
 * 手动触发与定时轮重叠时，后到的调用立即按零计数成功返回（concurrent: true），
 * 不排队堆叠、不报错 —— 让出语义与租约锁的跨设备让出一致。跨设备 / 跨进程的
 * 互斥由轮次内部的远端租约锁负责，两层各管一边。
 *
 * 返回值除 runSyncRound 的汇总字段外，本包装的让出路径额外携带 concurrent: true；
 * 正常轮次不携带该字段（falsy）。
 */
async function syncDirectory(cfg: EngineCfg, dir: DirCfg, prefs: EnginePrefs, handlers: SyncHandlers): Promise<any> {
  const mutexKey = `${storage.normalizeLocalKey(dir && dir.localPath)}|${storage.normalizeRemoteKey(dir && dir.remotePath)}`
  if (ROUND_IN_FLIGHT.has(mutexKey)) {
    return {
      uploaded: 0,
      downloaded: 0,
      deleted: 0,
      conflicts: 0,
      deferredConflicts: 0,
      adopted: 0,
      bytesUp: 0,
      bytesDown: 0,
      totalFiles: 0,
      tier: 'B',
      warnings: ['这个文件夹正在同步中，本次跳过'],
      errors: [],
      errorsDropped: 0,
      /** 该目录已有同进程轮次在进行：本轮立即让位（非错误） */
      concurrent: true,
    }
  }
  ROUND_IN_FLIGHT.set(mutexKey, true)
  // 同步记录（sync-log.json）的轮次起止：开始时刻在进入轮体前定格 —— 锁等待 /
  // 队列耗时属于「这次同步」的一部分，记录的是用户感知的起止窗口
  const roundStartAt = Date.now()
  let roundSummary: any = null
  let roundError: any = null
  try {
    roundSummary = await runSyncRound(cfg, dir, prefs, handlers)
    return roundSummary
  } catch (e: any) {
    roundError = e
    // 轮内已收尾的错误（执行期失败 / 取消 / 熔断 / 崩溃注入）都带
    // err.summary（含 failureClass）。这里只兜「轮次体直接抛出、未经轮末收尾」的路径
    //（扫描期网络异常 / CIRCUIT_OPEN 快速失败 / 意外 bug）：补一个零计数的最小 summary
    // 与 failureClass，保证调度层在任何失败形态下都有机器可读的退避输入。
    // 崩溃注入错误已有 summary，不会进入此分支。
    if (e && typeof e === 'object' && !e.summary) {
      e.failureClass = e.failureClass || (networkFailure(e) ? 'network' : 'other')
      e.summary = {
        uploaded: 0,
        downloaded: 0,
        deleted: 0,
        conflicts: 0,
        deferredConflicts: 0,
        adopted: 0,
        bytesUp: 0,
        bytesDown: 0,
        totalFiles: 0,
        tier: 'B',
        warnings: [],
        errors: [e && e.message ? e.message : String(e)],
        errorsDropped: 0,
        failureClass: e.failureClass,
        // 预演轮兜底路径同样带标记：调度器 planNext 不把预演失败计入退避
        ...(handlers && handlers.hints && handlers.hints.dryRun === true ? { dryRun: true } : {}),
      }
    }
    throw e
  } finally {
    // 正常 / 异常 / 取消 / 崩溃注入（同进程内注入不是真死）一律放行后续轮次 ——
    // 崩溃注入只模拟「进程死亡」的收尾语义，真实场景进程已不存在、Map 随之消失
    ROUND_IN_FLIGHT.delete(mutexKey)
    // 同步记录落盘（best-effort，任何异常都不影响轮次结果的上抛）：
    // 崩溃注入路径跳过 —— 模拟进程死亡不做任何收尾，记录同样不写；
    // 并发让位轮（concurrent）在上方提前 return，不经过本 finally
    if (!(roundError && roundError.__wdsyncCrash)) {
      try {
        const cancelled = !!(roundError && (roundError.code === 'ABORTED' || (typeof handlers?.shouldAbort === 'function' && handlers.shouldAbort())))
        const st = await storage.openDirStore({ localPath: dir && dir.localPath, remotePath: dir && dir.remotePath })
        st.appendSyncLog(buildSyncLogEntry({ handlers, at: roundStartAt, summary: roundSummary || (roundError && roundError.summary) || null, error: roundError, cancelled }))
        await st.saveSyncLog().catch(() => {})
      } catch (_) {
        /* 同步记录写入失败无害：纯展示性审计信息 */
      }
    }
    // 摘要离开引擎前剥离内部采集器引用：__syncOps 只服务于同步记录落盘，
    // 不得随 round-end 事件进渲染层、更不能被渲染层持久化进配置（非展示字段）
    if (roundSummary) delete roundSummary.__syncOps
    if (roundError && roundError.summary) delete roundError.summary.__syncOps
  }
}

/**
 * 组装一条同步记录（syncDirectory 轮末收尾专用；纯函数，不落盘）。
 * 触发方式取 hints.source（调度器轮次 kind / 渲染层直调的 'manual'；
 * 'manual-delegated' 是多实例委托代跑的手动轮，展示口径并入 'manual'），
 * 一次性单向操作取 hints.op。status 判定顺序：用户取消 → 让出（零传输）→
 * 失败 → 部分完成（有挂起冲突 / 待确认删除等用户待处理项）→ 成功。
 * 逐文件操作明细读 summary.__syncOps（引擎轮内同一数组引用贯穿全部
 * 退出路径 —— 成功轮 / 执行期错误轮 err.summary / 扫描期错误轮的 spread 副本
 * 都携带同一引用；轮次体直接抛出、未经轮末收尾的失败轮没有该字段 → 空明细）。
 * @param opts.handlers 引擎回调句柄（取 hints.source / hints.op / shouldAbort）
 * @param opts.at 轮次开始时刻（毫秒）
 * @param opts.summary 轮次摘要（成功轮为返回值；失败轮取 err.summary；缺失按零计数）
 * @param opts.error 失败轮的错误（成功轮为 null）
 * @param opts.cancelled 是否以取消语义收场（shouldAbort 仍为真 / ABORTED 错误码）
 */
function buildSyncLogEntry(opts: { handlers: any; at: number; summary: any; error: any; cancelled: boolean }): SyncLogEntry {
  const handlers = opts.handlers || {}
  const hints = handlers.hints || {}
  const rawTrigger = typeof hints.source === 'string' && hints.source ? hints.source : 'manual'
  const summary = opts.summary || {}
  const errors: string[] = Array.isArray(summary.errors) ? summary.errors.map((s: any) => String(s)) : []
  const entry: SyncLogEntry = {
    at: opts.at,
    endAt: Date.now(),
    trigger: rawTrigger === 'manual-delegated' ? 'manual' : rawTrigger,
    status: 'ok',
    uploaded: Number(summary.uploaded) || 0,
    downloaded: Number(summary.downloaded) || 0,
    deleted: Number(summary.deleted) || 0,
    conflicts: Number(summary.conflicts) || 0,
    adopted: Number(summary.adopted) || 0,
    renamed: (Number(summary.renamedRemote) || 0) + (Number(summary.renamedLocal) || 0),
    deferredConflicts: Number(summary.deferredConflicts) || 0,
    deleteHeld: Number(summary.deleteHeld) || 0,
    bytesUp: Number(summary.bytesUp) || 0,
    bytesDown: Number(summary.bytesDown) || 0,
    totalFiles: Number(summary.totalFiles) || 0,
    ops: Array.isArray(summary.__syncOps) ? summary.__syncOps : [],
    errors: errors.slice(0, 200),
  }
  if (Number(summary.errorsDropped) > 0) entry.errorsDropped = Number(summary.errorsDropped)
  if (hints.op === 'pull' || hints.op === 'push' || hints.op === 'pull-full' || hints.op === 'push-full') entry.op = hints.op
  if (opts.cancelled) {
    entry.status = 'cancelled'
  } else if (summary.yielded) {
    entry.status = 'yielded'
  } else if (opts.error) {
    entry.status = 'error'
    const msg = opts.error && opts.error.message ? String(opts.error.message) : String(opts.error)
    entry.error = msg.slice(0, 500)
  } else if (entry.deferredConflicts > 0 || entry.deleteHeld > 0) {
    entry.status = 'partial'
  }
  return entry
}

/**
 * 同步单个目录。
 * cfg:      { serverUrl, username, password }
 * dir:      { id, localPath, remotePath, mode: 'two-way'|'upload'|'download' }
 * prefs:    { ignoreHidden, concurrency, conflictStrategy: 'ask'|'local'|'remote'|'both',
 *             verifyMaxBytes?, deepVerify?, deepVerifyDays?, adoptVerifyBudgetBytes?,
 *             excludePatterns?（用户排除规则，扫描层与 ignoreHidden 独立生效） }
 * handlers: { onProgress(p), onConflict(info) -> Promise<choice | { choice, applyToRemaining } | 'defer'>,
 *             shouldAbort(), afterTransferOp?（测试崩溃注入专用，勿在产品代码使用） }
 * 返回汇总 { uploaded, downloaded, deleted, conflicts, deferredConflicts, adopted, bytesUp,
 *           bytesDown, totalFiles, tier, warnings[], errors[], errorsDropped,
 *           failureClass?, openIntents, breaker? }；存在文件级失败时抛错
 *（err.summary / err.errors 附带；err.summary 同样携带 failureClass 等机器可读字段，
 *  扫描期失败的错误也附带最小 err.summary 与 err.failureClass）。
 * tier 为本轮生效的服务器档位（A 条件保护 / B 复查 / C 只读）。
 * 调度层输入字段：
 *   failureClass      —— 存在文件级失败时 'network' | 'mixed' | 'other'（成功轮不设；
 *                        按 pushError 增量累计归纳，被截断到 200 条之外
 *                        的错误同样参与，不随 errorsDropped 丢失）；
 *   openIntents       —— 轮末仍开放的 upload 意图数（follow-up 后续轮判定输入）；
 *   breaker           —— 熔断轮附带 { open, consecutive, reason }；
 *   deferredConflicts —— onConflict 返回 'defer' 挂起（不报错、本轮跳过）的冲突数，
 *                        挂起记录无 choice，供 listPendingConflicts / setPendingChoice
 *                        统一处理；「部分完成，有 N 个待处理冲突」即由该字段表达。
 *
 * 目录级状态机：
 *   SCAN → PLAN（变化判定 + hash 消歧 + WAL 恢复；verify 并发池，进度经 plan 阶段外发）
 *        → EXECUTE（意图 → 操作 → 基线）→ FINALIZE
 *     └─ 扫描不完整 → ERROR（未发起任何传输）
 *
 * 与旧引擎（远端 manifest）的关键行为差异：
 *   - 每个文件验证成功后立即写本机基线（intent → op → done），单文件失败不再使
 *     整轮「回滚」其他已成功文件 —— 但轮末仍以 error 状态上报失败清单；
 *   - 崩溃（进程死亡）由 WAL + 下一轮恢复采纳，不再依赖远端中间状态；
 *   - 无基线 / 基线损坏的轮次禁用一切删除传播（无基线保护）。
 *
 * 核心不变量：
 *   I1 扫描不完整 ⇒ 本轮不产生任何计划（更不会删除）
 *   I2 删除失败   ⇒ 该文件基线条目保留
 *   I3 基线指纹与实际传输内容同源（上传前/后双重 stat + 边传边算 hash）
 *   I4 下载期间目标被修改 ⇒ 拒绝覆盖
 *   I5 基线损坏 ≠ 首次同步：按无基线保护模式执行，绝不删除
 *   I6 引擎不依赖窗口 / Vue / store：进度、冲突、结果、错误全部经 handlers 回调外发，
 *      shouldAbort 由调用方注入（调度器位于 preload 的接口预留）
 */
/**
 * 预演轮（hints.dryRun）的只读存储壳：拦截全部写方法为 no-op（基线 / WAL /
 * 挂起 / 删除快照 / 失败退避表 / scan-cache / 各落盘调用一概不动），读全部透传
 * —— 规划管线按真实数据完整运行、产出「将要发生什么」的计划，而真实存储保持
 * 原样。openDirStore 进程内缓存复用，壳必须挡住一切内存态写入；meta 对象上的
 * 直写点由轮内 !dryRun 守卫逐点保护（根探测 / 根丢失分支 / deepVerify 时间戳），
 * pendingIntents 交给浅拷贝（恢复与取代语义的内存态变更落在副本上，真表不动）。
 * no-op 返回值对齐真实签名（布尔计数类回真值，避免「已满」类噪声日志）。
 */
const DRY_RUN_STORE_NOOP: Record<string, (...args: any[]) => any> = {
  setEntry: () => Promise.resolve(),
  deleteEntry: () => Promise.resolve(),
  appendWalIntent: () => Promise.resolve(),
  appendWalDone: () => Promise.resolve(),
  appendWalAbort: () => Promise.resolve(),
  setPending: () => Promise.resolve(true),
  clearPending: () => Promise.resolve(),
  setDeleteBatch: () => Promise.resolve(),
  clearDeleteBatch: () => Promise.resolve(),
  setDeleteScope: () => Promise.resolve(),
  pruneDeleteScopes: () => Promise.resolve(0),
  stampDeleteScopeChoices: () => Promise.resolve(0),
  noteFailure: () => Promise.resolve(true),
  clearFailure: () => Promise.resolve(),
  ageFailures: () => Promise.resolve(),
  ageOpenIntents: () => Promise.resolve(),
  flush: () => Promise.resolve(),
  compact: () => Promise.resolve(),
  compactIfNeeded: () => Promise.resolve(),
  truncateWal: () => Promise.resolve(),
  saveMeta: () => Promise.resolve(),
  savePendings: () => Promise.resolve(),
  saveFailures: () => Promise.resolve(),
  saveDecisionLog: () => Promise.resolve(),
  saveScanCache: () => Promise.resolve(),
}
function makeDryRunStore(real: any): any {
  const pendingCopy = new Map(real.pendingIntents)
  return new Proxy(real, {
    get(t: any, prop: any) {
      if (prop === 'pendingIntents') return pendingCopy
      const noop = DRY_RUN_STORE_NOOP[String(prop)]
      if (noop) return noop
      const v = Reflect.get(t, prop, t)
      return typeof v === 'function' ? v.bind(t) : v
    },
  })
}

/** 本地磁盘预检的安全余量：可用空间低于「计划下载量 + 该余量」才拦（贴线的轮不误杀） */
const LOCAL_DISK_MARGIN_BYTES = 64 * 1024 * 1024

/** 字节数的人话（预检错误文案用；与渲染层 fmtBytes 口径一致的小型实现） */
function humanBytes(n: number): string {
  const v = Math.max(0, Number(n) || 0)
  if (v < 1024) return `${Math.ceil(v)} B`
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(v < 10 * 1024 ? 1 : 0)} KB`
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(v < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(v / 1024 / 1024 / 1024).toFixed(v < 10 * 1024 * 1024 * 1024 ? 1 : 0)} GB`
}

/**
 * 传输任务：任务元数据与执行闭包由同一对象承载 —— 元数据与闭包的对齐由结构
 * 保证，不依赖平行数组的同下标约定。
 */
interface RoundTask {
  /** 展示用相对路径（失败归因 e.__rel 同源） */
  rel: string
  /** upload / download / delete-local / delete-remote / conflict / rename-remote / rename-local */
  kind: string
  /** 该任务的传输字节估算（upload = 本地大小、download = 远端大小、conflict = 两侧之和、删除 / 改名 = 0） */
  bytes: number
  /**
   * 执行闭包（pushTransfer 包装：成功清退避记录、失败补 __rel 与 etag 跳过防线标记后
   * 上抛）。预演轮登记的计划任务**不携带**（仅元数据入表充当预检 / 进度分母）——
   * worker 池跳过无闭包任务，预演「只规划零执行」由该结构直接保证。
   */
  run?: () => Promise<any>
}

/**
 * 一轮同步的轮次摘要：计数字段由各执行点递增；yielded /
 * failureClass / openIntents / breaker 等由收尾路径补齐（见 finalizeSummaryMeta）。
 * __syncOps 为同步记录的逐文件明细采集器（轮内同一数组引用贯穿全部退出路径，
 * syncDirectory 轮末读取后剥离出渲染层）。
 */
interface RoundSummary {
  uploaded: number
  downloaded: number
  deleted: number
  conflicts: number
  /** 经 onConflict 返回 'defer' 挂起、本轮跳过未解决的冲突数 */
  deferredConflicts: number
  adopted: number
  /** 改名同步（零重传 / 零下载）：本地改名经云端 MOVE 落地 */
  renamedRemote: number
  /** 改名同步：远端改名在本机以本地改名跟随落地 */
  renamedLocal: number
  bytesUp: number
  bytesDown: number
  totalFiles: number
  /** 本轮生效的服务器档位（A 强条件保护 / B 复查尽力 / C 只读） */
  tier: string
  warnings: string[]
  errors: string[]
  errorsDropped: number
  /** 批量删除确认挂起数：超过阈值的待删整批登记「待确认删除」，确认前零删除 */
  deleteHeld: number
  /** 用户选择「保留不删」而抑制的删除数（仅 delete-remote：云端副本保留） */
  deleteKept: number
  /** 「不删除」决策命中 delete-local 而恢复上传的文件数 */
  deleteRestored: number
  /** 远端根重建保护跳过的删除数（待重新上传和解，清零后恢复删除传播） */
  deleteRootGuard: number
  /** 空目录清理：本地 / 远端移除的空目录数（仅清理因本轮同步删除而变空的目录） */
  dirsPrunedLocal: number
  dirsPrunedRemote: number
  /** 预演轮标记（含错误路径的 err.summary）：调度器 planNext 据此不做排程影响 */
  dryRun?: boolean
  /** 租约锁让出（零传输成功返回） */
  yielded?: boolean
  /** 让出轮的已规划任务数（信息性观测字段） */
  planned?: number
  /** 扫描形态信息（见 types.mts SyncSummary.scan） */
  scan?: any
  /** 远端根丢失决策挂起（调度器一次性系统提醒的触发输入） */
  rootLostHeld?: number
  failureClass?: 'network' | 'mixed' | 'other'
  openIntents?: number
  breaker?: { open: boolean; consecutive: number; reason: string }
  __syncOps?: SyncLogOp[]
}

/**
 * 档位保护参数（uploadGuards / deleteGuards 的产物）：
 *   ifMatch —— A 档覆盖 / 删除已存在文件时的 If-Match（值必为强 etag，重新包裹引号）；
 *   ifNoneMatchStar —— A 档新上传时的 If-None-Match:*（仅当目标不存在才允许创建）；
 *   recheck —— B 档（或 A 档但扫描期 etag 弱 / 缺失）覆盖前的紧邻复查（扫描期远端指纹）。
 */
interface TransferGuards {
  ifMatch?: string
  ifNoneMatchStar?: boolean
  recheck?: any
}

/**
 * 一轮同步的共享上下文（RoundContext）：承载 runSyncRound 全部跨阶段状态，
 * 各阶段函数（roundBootstrap / roundBody / 各 stage）与运行时闭包只经 ctx 交互。
 * 三个隐性不变量由字段归属固定：
 *   1. crashErr / lockHeld / renewTimer / lockPath 属于轮次体外层（releaseRoundLock
 *      在 finally 读写）—— 阶段内对它们的写一律经 ctx 字段，外层读到的总是终值；
 *   2. crashErr「模拟死亡零收尾」：置位后批量校验 / 空目录清理 / 收尾落盘 / 锁释放
 *      全部跳过（各消费点的 !crashErr 守卫不变）；
 *   3. tasks 单一任务表（元数据与执行闭包同对象，见 RoundTask）—— 元数据与闭包的
 *      对齐由结构保证，不存在双列表失步。
 */
interface RoundContext {
  cfg: EngineCfg
  dir: DirCfg
  prefs: EnginePrefs
  handlers: SyncHandlers
  tmpDir: string
  mode: SyncMode
  opHint: string | null
  dryRun: boolean
  verifyMaxBytes: number
  adoptVerifyBudgetBytes: number
  onProgress: (p: SyncProgress, force?: boolean) => void
  shouldAbort: () => boolean
  afterTransferOp: ((payload: any) => Promise<void>) | null
  roundBreaker: RoundBreaker
  summary: RoundSummary
  syncOps: SyncLogOp[]
  recordSyncOp: (op: SyncLogOp) => void
  pushWarning: (w: any) => void
  pushError: (w: any, isNetwork?: any) => void
  errorNetCount: number
  errorOtherCount: number
  realStore: storage.DirStateStore
  store: storage.DirStateStore
  scanCache: any
  finalizeSummaryMeta: () => void
  rootProbeStatus: number
  quotaAvailable: number | null
  quotaUsed: number | null
  rootRemovalArmed: boolean
  rootWasRebuilt: boolean
  dryRunRootMissing: boolean
  stopForRootLost: () => Promise<never>
  crashErr: any
  lockHeld: boolean
  renewTimer: any
  lockPath: string
  excludeMatcher: ((rel: string) => boolean) | null
  localScan: any
  remoteScan: any
  caps: DavCapabilities
  etagSkipUsed: boolean
  skippedDirs: string[]
  newScanCache: any
  etagSkipAnomaly: string | null
  noteEtagSkipAnomaly: (rel: string, why: string) => void
  serverNoise: any
  tierBNoticePending: boolean
  noiseDirty: boolean
  roSkipped: number
  localByNfc: Map<any, any>
  remoteByNfc: Map<any, any>
  caseSkip: Set<any>
  localTol: number
  forceUploads: Set<string>
  deepVerifyDue: boolean
  plan: any[]
  planByRel: Map<any, any>
  scanBytesTotal: number
  transferBytesTotal: number
  filesDone: number
  bytesDoneAcc: number
  currentTask: { op: string; rel: string } | null
  tick: (force?: boolean) => void
  /**
   * 新建一个传输任务的字节计量器（每个上传 / 下载任务一个；改名 / 删除零字节不走此通道）：
   *   onBytes(n) —— 网络层逐块回调（ReqOpts.onBytes）：把实际流过的字节即时累加进
   *     bytesDoneAcc 并 tick 刷新进度事件 —— 大文件传输期间 bytesDone 随真实大小
   *     增长（节流出口不变），进度条与速度折算不再依赖整文件完成的跳变；
   *   finish(size) —— 任务完结（原「bytesDoneAcc += 整文件大小」的替代）：只补
   *     「计划字节 − 已流过字节」的尾差。重试 / 重发从 0 重新流经文件会让同一任务
   *     的 onBytes 重复计数，尾差取 max(0, …) 钳位，最终 totals 恰好等于计划字节；
   *     任务失败时已流过的字节保留在计数里（真实消耗，单调不减，UI 上限钳位）。
   */
  byteMeter: () => { onBytes: (n: number) => void; finish: (size: number) => void }
  createdDirs: Map<string, Promise<void>>
  tasks: RoundTask[]
  bNewUploads: Set<any>
  permSkipped: any[]
  transientFailed: any[]
  pendingUploads: any[]
  aborted: boolean
  roundConflictChoice: any
  pendingResolved: any[]
  deletePlanItems: any[]
  localDeletedRels: Set<any>
  remoteDeletedRels: Set<any>
  runOp: (it: any, opName: any, body: any, opts?: any) => Promise<void>
  supersedeOpenIntents: (rel: any, exceptId: any) => Promise<void>
  crashHook: (payload: any) => Promise<void>
  runUploadOp: (it: any, origName: any, body: any, fromConflict?: boolean) => Promise<boolean>
  recordPlannedOp: (kind: any, rel: any, bytes?: number, planned?: { it?: any; from?: string }) => void
  pushTransfer: (rel: any, fn: any, kind: any, bytes?: number, planned?: { it?: any; from?: string }) => void
  handleTransferError: (e: any, job: any, isRetry: any) => void
  askChain: Promise<any>
  resolveChoice: (it: any) => Promise<any>
  registerPendingChoice: (it: any, choice: any) => void
  resolveChoiceInner: (it: any) => Promise<any>
  verifyJobs: any[]
  verifyOutcome: Map<any, any>
  hashPrefetch: Map<any, any>
  renamePairs: RenamePair[]
  renamePairByRel: Map<any, RenamePair>
  uploadGuards: (scanR: any) => TransferGuards
  deleteGuards: (scanR: any) => TransferGuards
  pushUploadTransfer: (it: any, settlePendings?: boolean) => void
  persistPlannedLocalState: () => Promise<void>
  removalForced: number
  deleteThresholdTripped: boolean
  /** 锁让出标记（acquireRoundLock 置位；roundBody 检查后按零计数成功返回） */
  roundYielded: boolean
}

/**
 * 两段提交的暂存哨兵（上传闭包成功返回它 = PUT 已成功、待批量校验阶段提交基线；
 * pushTransfer 据此推迟失败记录清除）。模块级常量：任务不跨轮，共享无副作用。
 */
const UPLOADED_PENDING = Symbol('wdsync-uploaded-pending')

/**
 * 构造轮次上下文：全部跨阶段字段的一次性初始化 + 运行时闭包装配（闭包经 ctx
 * 字段互访，阶段函数与闭包只经 ctx 交互）。summary 的计数字段、任务表、挂起收集
 * 等可变状态都在此定格初值 —— 阶段内对可变字段的写一律走 ctx.X，结构上不可能
 * 再出现「局部副本遮蔽共享态」的旧风险。
 */
function makeRoundContext(cfg: EngineCfg, dir: DirCfg, prefs: EnginePrefs, handlers: SyncHandlers): RoundContext {
  const roundBreaker = createRoundBreaker()
  const shouldAbort = (handlers && handlers.shouldAbort) || (() => false)
  const summary: RoundSummary = {
    uploaded: 0,
    downloaded: 0,
    deleted: 0,
    conflicts: 0,
    deferredConflicts: 0,
    adopted: 0,
    renamedRemote: 0,
    renamedLocal: 0,
    bytesUp: 0,
    bytesDown: 0,
    totalFiles: 0,
    tier: 'B',
    warnings: [] as string[],
    errors: [] as string[],
    errorsDropped: 0,
    deleteHeld: 0,
    deleteKept: 0,
    deleteRestored: 0,
    deleteRootGuard: 0,
    dirsPrunedLocal: 0,
    dirsPrunedRemote: 0,
  }
  const verifyMaxBytes = Number(prefs.verifyMaxBytes) > 0 ? Number(prefs.verifyMaxBytes) : DEFAULT_VERIFY_MAX_BYTES
  const ctx: RoundContext = {
    cfg: { ...cfg, __wdsyncBreaker: roundBreaker, __wdsyncAbort: shouldAbort },
    dir,
    prefs,
    handlers,
    onProgress: throttledProgress((handlers && handlers.onProgress) || (() => {})),
    shouldAbort,
    afterTransferOp: (handlers && handlers.afterTransferOp) || null,
    roundBreaker,
    tmpDir: dir.localPath,
    mode: dir.mode || 'two-way',
    dryRun: !!(handlers && handlers.hints && handlers.hints.dryRun === true),
    verifyMaxBytes,
    adoptVerifyBudgetBytes: Number(prefs.adoptVerifyBudgetBytes) > 0 ? Number(prefs.adoptVerifyBudgetBytes) : verifyMaxBytes * ADOPT_VERIFY_BUDGET_FACTOR,
    summary,
    syncOps: [],
    errorNetCount: 0,
    errorOtherCount: 0,
    realStore: null,
    store: null,
    scanCache: null,
    rootProbeStatus: 0,
    quotaAvailable: null,
    quotaUsed: null,
    rootRemovalArmed: false,
    rootWasRebuilt: false,
    dryRunRootMissing: false,
    crashErr: null,
    lockHeld: false,
    renewTimer: null,
    lockPath: '',
    excludeMatcher: null,
    localScan: null,
    remoteScan: null,
    caps: null as any,
    etagSkipUsed: false,
    skippedDirs: [],
    newScanCache: null,
    etagSkipAnomaly: null,
    serverNoise: null,
    tierBNoticePending: false,
    noiseDirty: false,
    roSkipped: 0,
    localByNfc: new Map(),
    remoteByNfc: new Map(),
    caseSkip: new Set<any>(),
    localTol: 1000,
    forceUploads: new Set<string>(),
    deepVerifyDue: false,
    plan: [],
    planByRel: new Map(),
    scanBytesTotal: 0,
    transferBytesTotal: 0,
    filesDone: 0,
    bytesDoneAcc: 0,
    currentTask: null,
    createdDirs: new Map<string, Promise<void>>(),
    tasks: [],
    bNewUploads: new Set<any>(),
    permSkipped: [],
    transientFailed: [],
    pendingUploads: [],
    aborted: false,
    roundConflictChoice: null,
    pendingResolved: [],
    deletePlanItems: [],
    localDeletedRels: new Set<any>(),
    remoteDeletedRels: new Set<any>(),
    askChain: Promise.resolve(),
    verifyJobs: [],
    verifyOutcome: new Map(),
    hashPrefetch: new Map(),
    renamePairs: [],
    renamePairByRel: new Map(),
    removalForced: 0,
    deleteThresholdTripped: false,
    roundYielded: false,
    opHint: null,
    // 运行时闭包（recordSyncOp 起）在下方逐个装配
  } as unknown as RoundContext

  // 一次单向操作档位（「云端补齐本地 / 云端覆盖本地 / 本地补齐云端 / 本地覆盖云端」）：
  // 经 handlers.hints.op 注入，仅对本轮规划生效（decideAction 的 oneshot 分支凌驾于
  // dir.mode 之上）；非法值按常规轮处理
  const rawOp = handlers && handlers.hints ? handlers.hints.op : undefined
  ctx.opHint = rawOp === 'pull' || rawOp === 'push' || rawOp === 'pull-full' || rawOp === 'push-full' ? rawOp : null
  // 预演标记随 summary 走（含错误路径的 err.summary）：调度器 planNext 据此不做
  // 任何排程影响（不退避、不 follow-up），渲染层 round-end 据此不进行行状态机
  if (ctx.dryRun) summary.dryRun = true
  summary.__syncOps = ctx.syncOps
  // —— 运行时闭包（阶段间共用；经 ctx 字段互访，装配点集中于此）——
  ctx.recordSyncOp = (op: SyncLogOp) => {
    ctx.syncOps.push(op)
  }
  ctx.pushWarning = (w: any) => {
    if (ctx.summary.warnings.length < 200) ctx.summary.warnings.push(w)
  }
  ctx.pushError = (w: any, isNetwork: any) => {
    if (isNetwork === true) ctx.errorNetCount++
    else ctx.errorOtherCount++
    if (ctx.summary.errors.length < 200) ctx.summary.errors.push(w)
    else ctx.summary.errorsDropped++
  }
  /**
   * 轮末统一补齐调度器需要的机器可读字段：
   *   failureClass —— 有过 pushError（含被截断丢弃的，按增量累计）时归纳为
   *                   'network'（全部网络类）/ 'mixed' / 'other'（全部非网络类）；
   *                   无错误不设该字段（成功轮）。调度层据此决定跨轮退避，不再靠
   *                   正则猜错误文案；
   *   openIntents  —— 轮末仍开放的 upload 意图数（follow-up 短延迟后续轮的判定输入；
   *                   数值来自本轮最终内存态，含本轮新留下的与上一轮遗留的）；
   *   breaker      —— 熔断轮附带 { open, consecutive, reason }（UI「服务器连续无响应」
   *                   归因与退避输入）。
   * 让出 / 正常 / 部分失败各收尾路径统一调用；crashErr（模拟进程死亡）不调用。
   */
  ctx.finalizeSummaryMeta = () => {
    if (ctx.errorNetCount + ctx.errorOtherCount > 0) {
      ctx.summary.failureClass = ctx.errorNetCount === 0 ? 'other' : ctx.errorOtherCount === 0 ? 'network' : 'mixed'
    }
    ctx.summary.openIntents = Array.from(ctx.store.pendingIntents.values()).filter((p: any) => p.op === 'upload').length
    if (ctx.roundBreaker.open) {
      ctx.summary.breaker = { open: true, consecutive: ctx.roundBreaker.consecutive, reason: ctx.roundBreaker.reason }
    }
  }
  /**
   * 远端根丢失的统一停轮：登记（或沿用）kind='root-lost' 待决策挂起并抛出
   * root-lost 错误 —— 决策落地前零删除零传输。登记条目 local.size 携带受影响的
   * 基线文件数（决策弹窗展示用）；已有挂起（含已带 choice 的）不覆盖，避免把
   * 用户已做出的选择冲掉。调度器据 summary.rootLostHeld 触发一次性系统提醒，
   * 渲染层据 pending-conflicts 事件弹出决策弹窗。
   */
  ctx.stopForRootLost = async (): Promise<never> => {
    const existing = ctx.store.getPending(ROOT_LOST_PENDING_REL)
    if (!existing || existing.kind !== 'root-lost') {
      ctx.store.setPending(ROOT_LOST_PENDING_REL, {
        kind: 'root-lost',
        local: { size: ctx.store.entries.size, mtimeMs: Date.now() },
        remote: { size: 0, mtimeMs: 0, etag: '' },
        createdAt: Date.now(),
      })
      await ctx.store.savePendings().catch(() => {})
    }
    // summary 附在错误上：调度器 round-end 事件用它把 rootLostHeld 送达渲染层
    //（弹决策弹窗），并作为一次性系统提醒的触发输入
    ctx.summary.rootLostHeld = 1
    throw syncFail(`云端同步文件夹「${ctx.dir.remotePath}」已不存在，需要你确认处理方式：把电脑上的文件重新上传到云端，或把电脑上已同步的文件也删除`, {
      phase: 'root-lost',
      failureClass: 'other',
      summary: ctx.summary,
    })
  }
  ctx.tick = (force = false) =>
    ctx.onProgress(
      {
        phase: 'transfer',
        filesDone: ctx.filesDone,
        filesTotal: ctx.plan.length,
        bytesDone: ctx.bytesDoneAcc,
        bytesTotal: ctx.transferBytesTotal,
        stage: 'transfer',
        scanBytesTotal: ctx.scanBytesTotal,
        ...(ctx.currentTask ? { currentOp: ctx.currentTask.op, currentFile: ctx.currentTask.rel } : {}),
      } as SyncProgress,
      force
    )
  // 字节计量器工厂（接口契约见 RoundContext.byteMeter）：传输进度按真实大小推进的
  // 引擎侧落点 —— onBytes 即时累加（tick 经节流出口 ≤7Hz 外发），finish 补尾差。
  ctx.byteMeter = () => {
    const st = { streamed: 0 }
    return {
      onBytes: (n: number) => {
        if (!(n > 0)) return
        st.streamed += n
        ctx.bytesDoneAcc += n
        ctx.tick()
      },
      finish: (size: number) => {
        ctx.bytesDoneAcc += Math.max(0, (size || 0) - st.streamed)
      },
    }
  }
  // 操作执行骨架：intent → 操作 → 验证 → [崩溃注入点] → 基线 → done。
  // opts.conflict：本次操作是冲突解决的落地动作 —— 成功提交（基线
  // 写入 + done）后清除该文件的冲突挂起记录（决策已完成）；失败路径不清（挂起与
  // choice 保留，下一轮沿用重试）。
  // intent 记录带 at（写入时刻，开放意图 30 天超龄兜底用）；同 rel 的既有
  // 开放意图由新者取代（aborts —— 与 runUploadOp 共用的取代语义）。
  ctx.runOp = async (it: any, opName: any, body: any, opts: any = {}) => {
    if (ctx.shouldAbort()) {
      ctx.aborted = true
      return
    }
    const id = crypto.randomUUID()
    const intent: any = { op: opName, rel: it.rel, at: Date.now() }
    if (opName === 'download') intent.remote = { size: it.r.size, mtimeMs: it.r.mtimeMs, etag: it.r.etag || '' }
    await ctx.store.appendWalIntent({ id, ...intent })
    await ctx.supersedeOpenIntents(it.rel, id)
    const commitSet = (entry: any) => ctx.store.setEntry(it.rel, entry)
    const commitDel = () => ctx.store.deleteEntry(it.rel)
    try {
      await body(commitSet, commitDel)
      await ctx.store.appendWalDone(id)
      if (opts.conflict) ctx.store.clearPending(it.rel)
    } catch (e: any) {
      // 崩溃注入的错误不写 abort：模拟「进程死亡」，意图保持未了结供下一轮恢复
      if (!e || !e.__wdsyncCrash) await ctx.store.appendWalAbort(id).catch(() => {})
      throw e
    }
  }
  /** 同 rel 的其余开放意图由新意图取代（新者写 abort 了结旧者）。覆盖同轮瞬时重试与跨轮半截重传两条来源。 */
  ctx.supersedeOpenIntents = async (rel: any, exceptId: any) => {
    for (const other of Array.from(ctx.store.pendingIntents.values()) as any[]) {
      if (other.id !== exceptId && nfc(other.rel || '') === nfc(rel)) await ctx.store.appendWalAbort(other.id).catch(() => {})
    }
  }
  ctx.crashHook = async (payload: any) => {
    if (!ctx.afterTransferOp) return
    try {
      await ctx.afterTransferOp(payload)
    } catch (e: any) {
      if (e && typeof e === 'object') e.__wdsyncCrash = true
      throw e
    }
  }
  /**
   * 两段提交的上传段：intent → PUT（uploadOne）→ 暂存 pendingUploads。
   * 与 runOp 的差异：body 成功后**不写基线、不写 done** —— 提交统一推迟到批量校验阶段
   *（所在目录的上传全部完成后，一次 PROPFIND Depth 1 核对 size 并取远端指纹写基线）。
   * 意图记录与取代语义：
   *   - intent 携带上传前的规划期远端指纹 remote（无则 null，半截判定链第 3 步的比对
   *     基准）、写入时刻 at，以及链上最初写入时刻 firstAt（新意图取代旧
   *     意图时继承，超龄按 firstAt 计算，持续中断链的兜底时钟不被每轮重写刷新）；
   *     写入点收紧到「PUT 发起前」—— 经 body 收到的 onBeforePut
   *     钩子在 uploadOne 的全部前置检查（双 stat / 建目录 / B 档复查）之后触发，
   *     pre-flight 失败不产生 intent（intentOpen 保持 false）；
   *   - abort 策略：崩溃注入不写 abort（既有）；PUT 以 NETWORK / ABORTED / 上传读流
   *     LOCAL_IO（source='body-read'）收场同样不写 abort —— 这些情形服务器可能已收到
   *     部分字节，意图保持开放供下一轮半截判定；pre-flight 失败（未写过 intent）与
   *     确定状态码（4xx/5xx 终态，含 412）仍写 abort；
   *   - 同 rel 的其余开放意图由新者取代（supersedeOpenIntents，同轮瞬时重试与跨轮
   *     半截重传共用「新者取代旧者」语义）。
   * 崩溃窗口语义：PUT 成功 → 批量提交之间崩溃（crashHook 抛出或真实进程死亡）时遗留
   * 未了结的 upload intent，下一轮 recoverIntents 按「本地未变 + 远端已存在同 size」采纳。
   * @param it 计划条目（取 rel 与 l / r 指纹写 intent） @param origName 扫描期远端原始文件名
   * @param body 传输体：形如 (hooks) => uploadOne(..., { onBeforePut: hooks.onBeforePut }) +
   *        crashHook，成功返回 uploadOne 的结果
   * @param fromConflict 本次上传是否为冲突解决的落地动作（半截强制重传也
   *        置 true —— 远端被证实为本机残缺文件时，等效 choice='local'，成功提交后清除挂起）
   * @returns {boolean} 是否已暂存待批量提交（开始前用户中止 → false，不发 intent）
   */
  ctx.runUploadOp = async (it: any, origName: any, body: any, fromConflict = false) => {
    if (ctx.shouldAbort()) {
      ctx.aborted = true
      return false
    }
    const id = crypto.randomUUID()
    const remoteFp = it.r && !it.r.isDir ? { size: it.r.size, mtimeMs: it.r.mtimeMs, etag: it.r.etag || '' } : null
    let intentOpen = false // intent 实际写入过（PUT 前一刻）才需要考虑 abort
    try {
      const up = await body({
        onBeforePut: async () => {
          // 新意图继承同 rel 开放意图链的最初写入时刻 firstAt ——
          // 持续中断的文件每轮「新者取代旧者」不再刷新超龄时钟，30 天兜底对中断链
          // 真正封顶（否则 WAL 每轮约增 2 行且永不超龄）。旧意图缺 firstAt 时回退
          // 其 at（链上已知的最早时刻）；无旧意图时取当前时刻。
          const now = Date.now()
          let firstAt = now
          for (const other of ctx.store.pendingIntents.values()) {
            if (other.id === id || nfc(other.rel || '') !== nfc(it.rel)) continue
            const born = Number(other.firstAt) > 0 ? Number(other.firstAt) : Number(other.at) > 0 ? Number(other.at) : Infinity
            if (born < firstAt) firstAt = born
          }
          await ctx.store.appendWalIntent({
            id,
            op: 'upload',
            rel: it.rel,
            at: now,
            firstAt,
            local: { size: it.l.size, mtimeMs: it.l.mtimeMs },
            remote: remoteFp,
          })
          await ctx.supersedeOpenIntents(it.rel, id)
          intentOpen = true
        },
      })
      // added：扫描期远端没有该文件（含根重建保护 / 「不删除」恢复的复活上传）=
      // 云端新增；随批量校验提交点写进同步记录的操作明细
      ctx.pendingUploads.push({
        rel: it.rel,
        local: up.local,
        hash: up.hash,
        intentId: id,
        origName: origName || undefined,
        conflict: fromConflict === true,
        added: !(it.r && !it.r.isDir),
      })
      return true
    } catch (e: any) {
      // 崩溃注入 / 服务器可能已收字节（NETWORK / ABORTED / 上传读流 LOCAL_IO）：不写 abort，
      // 意图保持开放，下一轮 recoverIntents 三向判定（采纳 / 放弃 / 半截转重传）。
      // __openIntent：失败时确有开放意图 —— 该文件的当轮瞬时重试必须跳过
      //（handleTransferError 据此不再入队）：重试携带的守卫（A 档 If-None-Match:* /
      // If-Match、B 档复查）都基于**中断前**的远端指纹，撞上本机自己留下的半截必然
      // 412 / REMOTE_CHANGED，按规则写 abort 反而丢失半截标记，让下一轮退回假冲突
      const keepOpen =
        !intentOpen ||
        !e ||
        e.__wdsyncCrash ||
        e.code === 'NETWORK' ||
        e.code === 'ABORTED' ||
        (e.code === 'LOCAL_IO' && e.source === 'body-read')
      if (!keepOpen) await ctx.store.appendWalAbort(id).catch(() => {})
      if (keepOpen && intentOpen && e && typeof e === 'object') e.__openIntent = true
      throw e
    }
  }
  /**
   * 预演轮的计划动作登记（pushTransfer 的 dry-run 分支）：不真正入队，按规划
   * 结果直接落计数与明细 —— 与真实轮的执行点同口径（上传按两段提交点计、
   * 冲突按条目计、删除按方向计、改名按方向计），供「预演结果」以同步记录的
   * 形态只读展示。bytes 为该任务的传输字节估算（与 tasks[].bytes 同源）。
   */
  ctx.recordPlannedOp = (kind: any, rel: any, bytes = 0, planned?: { it?: any; from?: string }) => {
    if (kind === 'upload') {
      ctx.summary.uploaded++
      ctx.summary.bytesUp += bytes || 0
      ctx.recordSyncOp({ op: 'upload', rel, bytes: bytes || 0, added: !(planned && planned.it && planned.it.r && !planned.it.r.isDir) })
    } else if (kind === 'download') {
      ctx.summary.downloaded++
      ctx.summary.bytesDown += bytes || 0
      ctx.recordSyncOp({ op: 'download', rel, bytes: bytes || 0, added: !(planned && planned.it && planned.it.l) })
    } else if (kind === 'delete-local' || kind === 'delete-remote') {
      ctx.summary.deleted++
      ctx.recordSyncOp({ op: kind, rel })
    } else if (kind === 'conflict') {
      ctx.summary.conflicts++
      ctx.recordSyncOp({ op: 'conflict', rel })
    } else if (kind === 'rename-remote' || kind === 'rename-local') {
      if (kind === 'rename-remote') ctx.summary.renamedRemote++
      else ctx.summary.renamedLocal++
      ctx.recordSyncOp({ op: kind, rel, from: planned && planned.from })
    }
  }
  ctx.pushTransfer = (rel: any, fn: any, kind: any, bytes = 0, planned?: { it?: any; from?: string }) => {
    // 传输字节分母（计划需要上传 + 下载的总字节）按任务累加，真实轮与预演轮同口径
    //（删除 / 改名任务计 0；写前查重剔除任务时按 tasks[i].bytes 同步扣减，见
    // runTransferPool 前的查重回填）。字节进度按真实大小推进依赖分母到位 ——
    // 缺了它 bytesTotal 恒 0，UI 的传输段只能退化为按文件数 / 直落 90%。
    ctx.transferBytesTotal += bytes
    // 预演轮：不执行（执行层零触达），按规划直接登记计划动作；任务表照常登记
    // —— 传输前预检（配额 / 磁盘）按计划字节量判定，预演同样受益
    if (ctx.dryRun) {
      ctx.tasks.push({ rel, kind, bytes })
      ctx.recordPlannedOp(kind, rel, bytes, planned)
      return
    }
    ctx.tasks.push({
      rel,
      kind,
      bytes,
      run: async () => {
        try {
          const r = await fn()
          if (r !== UPLOADED_PENDING) ctx.store.clearFailure(rel)
          return r
        } catch (e: any) {
          if (e && typeof e === 'object' && !e.__rel) e.__rel = rel
          // etag 跳过运行时防线（见 noteEtagSkipAnomaly）：A 档条件保护命中（412，
          // uploadOne / delete-remote 的 PUT/DELETE If-Match 失配）或 B 档复查发现
          // 远端与扫描预期不符（REMOTE_CHANGED）—— 被跳过子树内的文件出现这种
          // 失败 = 远端实际状态与合成（基线）状态不符，标记异常
          if (e && typeof e === 'object' && (e.code === 'PRECONDITION' || e.code === 'REMOTE_CHANGED')) {
            ctx.noteEtagSkipAnomaly(e.__rel || rel, e.code === 'PRECONDITION' ? '条件请求 412' : '写前复查失配')
          }
          throw e
        }
      },
    })
  }
  /**
   * 统一处理一次传输失败（worker catch 与瞬时失败重试共用）：
   *   transient 且非重试 → 收集到 transientFailed，当轮后段重试（暂不计入轮次错误）；
   *   transient 但失败留下开放上传意图（__openIntent）→ 不入重试队列，按普通错误
   *     上报并说明「下一轮自动判定」（重试守卫基于中断前指纹，撞上自己的半截必然
   *     412 / REMOTE_CHANGED 且丢失半截标记）；
   *   permanent          → 记入失败退避表（noteFailure；条目满时提示）；
   *   其余 / 重试再败    → 照常 pushError（下轮重试，不记录）。
   * 取消：ABORTED（在途传输被取消销毁）不在此列 —— 不分类、不进退避表、
   * 不产生用户可见错误；轮次整体由下方既有「aborted → 同步已中止」路径收场
   *（WAL 意图已在 runOp / runUploadOp 的 catch 里按开放意图策略处理）。
   */
  ctx.handleTransferError = (e: any, job: any, isRetry: any) => {
    if (e && e.__wdsyncCrash && !ctx.crashErr) ctx.crashErr = e
    if (e && e.code === 'ABORTED') {
      ctx.aborted = true
      return
    }
    const cls = classifyOpFailure(e)
    // 失败留下开放意图的上传不做当轮重试 —— 重试守卫基于中断前的远端指纹，
    // 撞上本机自己的半截必然 412 / REMOTE_CHANGED 且丢失半截标记；下一轮恢复期的
    // 前缀校验才能安全区分「自己的半截」与「对端修改」。按普通错误上报（含说明）
    if (cls === 'transient' && e && e.__openIntent && !isRetry) {
      ctx.pushError(`${e.message}（这个文件本次不再重试，下次同步会自动检查）`, networkFailure(e))
      return
    }
    if (cls === 'transient' && !isRetry && job) {
      ctx.transientFailed.push(job)
      return
    }
    if (cls === 'permanent' && e && e.__rel) {
      const recorded = ctx.store.noteFailure(e.__rel, { code: e.code || (e.status ? `HTTP ${e.status}` : ''), message: e.message || '' })
      if (!recorded) logNote(`失败退避记录已满：${e.__rel} 的持续失败未记录，本轮后仍会每轮重试`)
    }
    ctx.pushError(e && e.message ? e.message : String(e), networkFailure(e))
  }
  ctx.resolveChoice = (it: any) => {
    const run = ctx.askChain.then(() => ctx.resolveChoiceInner(it))
    ctx.askChain = run.catch(() => {})
    return run
  }
  /**
   * 登记一条冲突挂起记录：用户已做出（含按「应用到全部」在本轮内
   * 沿用）的冲突决策，在成功落地之前先逐文件持久化 —— 落地失败（A 档 412 /
   * B 档复查 REMOTE_CHANGED / 网络）时下一轮自动沿用，不再重复询问；choice 省略
   * 表示「已询问但未解决」的挂起（供后续 UI 统一处理）。
   * 只更新内存并置脏，轮末由引擎统一落盘（crashErr 路径不写，模拟进程死亡）。
   */
  ctx.registerPendingChoice = (it: any, choice: any) => {
    const ok = ctx.store.setPending(it.rel, {
      local: { size: it.l ? it.l.size : 0, mtimeMs: it.l ? it.l.mtimeMs : 0 },
      remote: { size: it.r ? it.r.size : 0, mtimeMs: it.r ? it.r.mtimeMs : 0, etag: it.r ? it.r.etag || '' : '' },
      createdAt: Date.now(),
      ...(choice ? { choice } : {}),
    })
    if (!ok) logNote(`冲突挂起记录已满：${it.rel} 的冲突决策未持久化（本轮仍按该决策执行）`)
  }
  ctx.resolveChoiceInner = async (it: any) => {
    // etag 跳过运行时防线（见 noteEtagSkipAnomaly）：进入冲突判定本身通常意味着
    // 两侧都变了；被跳过子树内的合成远端按断言应与基线一致（rChanged=false，
    // 最多产生 upload），真出现冲突 = 远端实际状态与合成断言不符
    ctx.noteEtagSkipAnomaly(it.rel, '冲突判定')
    // 优先级 1：本轮内存的「应用到全部」—— 本轮用户的最新意图优先于历史挂起；
    // 沿用时同样逐文件登记挂起（applyToRemaining 只作用于本轮内存，持久化按文件记）
    if (ctx.roundConflictChoice) {
      ctx.registerPendingChoice(it, ctx.roundConflictChoice)
      return ctx.roundConflictChoice
    }
    // 优先级 2：上一轮用户已选择但尚未成功落地的冲突，
    // 本轮不再调用 onConflict / 不弹窗，直接沿用已记录的策略 —— 与 roundConflictChoice
    // 同一条执行路径（决策已定，仅剩传输）。C 档跳过、newBoth=conflict 等既有闸门
    // 在规划层已先行过滤，此处只处理真正进入冲突解决的条目。
    // choice 只认冲突类三值：'delete'/'keep' 是删除确认类挂起的选择值（手改数据 /
    // 异常写入混入冲突条目时），按「未解决」对待走正常询问流程，绝不落入 else
    //（else = 同时保留，语义完全不同）。
    const pendingRec = ctx.store.getPending(it.rel)
    if (pendingRec && (pendingRec.choice === 'local' || pendingRec.choice === 'remote' || pendingRec.choice === 'both')) {
      ctx.pendingResolved.push({ rel: it.rel, choice: pendingRec.choice })
      return pendingRec.choice
    }
    // 本机存在开放 upload 意图且远端小于本地 → 疑似上次中断上传留下的
    // 残缺文件（半截判定因超上限 / GET 失败而无法自动完成），随冲突信息带给渲染层提示
    const partialSuspect = (() => {
      for (const p of ctx.store.pendingIntents.values()) {
        if (p.op === 'upload' && nfc(p.rel || '') === it.rel) return true
      }
      return false
    })() && !!(it.r && it.l && it.r.size < it.l.size)
    let choice = ctx.prefs.conflictStrategy
    if (choice === 'ask' && ctx.handlers && ctx.handlers.onConflict) {
      const res = await ctx.handlers.onConflict({
        dirId: String(ctx.dir.id || ''),
        rel: it.rel,
        local: { size: it.l ? it.l.size : 0, mtimeMs: it.l ? it.l.mtimeMs : 0 },
        remote: { size: it.r ? it.r.size : 0, mtimeMs: it.r ? it.r.mtimeMs : 0, etag: it.r ? it.r.etag : '' },
        ...(partialSuspect ? { hint: 'partial-upload' } : {}),
      })
      if (res && typeof res === 'object') {
        if (res.choice === 'local' || res.choice === 'remote' || res.choice === 'both') {
          // 「对本轮剩余冲突都这样处理」：本轮后续冲突不再询问
          if (res.applyToRemaining) ctx.roundConflictChoice = res.choice
          ctx.registerPendingChoice(it, res.choice)
          return res.choice
        }
        // 无法识别的选择：按「未解决」登记挂起（无 choice），照旧抛错 —— 供后续统一处理
        ctx.registerPendingChoice(it, null)
        throw new Error(`「${it.rel}」的冲突还没处理，电脑和云端的文件都保持原样`)
      }
      // 'defer' = 冲突挂起（典型：后台轮渲染层不可见，
      // 调度器不等一个看不见的弹窗）。走现有「无 choice 挂起」登记通道（与 ask 无回调
      // 同一存储），返回哨兵值由冲突执行器跳过该文件 —— 轮次不因冲突报错。
      // 现有的 pending 沿用（优先级 2）与 setPendingChoice 批量处理路径天然复用
      if (res === 'defer') {
        ctx.registerPendingChoice(it, null)
        return 'defer'
      }
      if (res === 'local' || res === 'remote' || res === 'both') {
        ctx.registerPendingChoice(it, res)
        return res
      }
      ctx.registerPendingChoice(it, null)
      throw new Error(`「${it.rel}」的冲突还没处理，电脑和云端的文件都保持原样`)
    }
    if (choice === 'ask') {
      // ask 且无回调：同样按「未解决」登记挂起后抛错（挂起记录供 UI / setPendingChoice 后续处理）
      ctx.registerPendingChoice(it, null)
      throw new Error(`「${it.rel}」的冲突还没处理，电脑和云端的文件都保持原样`)
    }
    return choice
  }
  ctx.noteEtagSkipAnomaly = (rel: string, why: string) => {
    if (ctx.etagSkipAnomaly) return // 幂等：只记首个原因
    const k = nfc(String(rel || ''))
    if (ctx.skippedDirs.some((s) => k.startsWith(s + '/'))) ctx.etagSkipAnomaly = why
  }
  // 档位保护参数：按「扫描期远端条目」与档位推导每次上传 / 删除的守卫。
  //   A 档：已存在文件带 If-Match（仅强 etag，弱 etag 绝不用于 If-Match），
  //         新上传带 If-None-Match:*；扫描期 etag 弱 / 缺失时退化为 B 档复查；
  //   B 档：覆盖 / 删除已存在文件前紧邻复查（recheck）；新上传的写前保护由规划完成后的
  //         「写前查重」（bNewUploads）承担，不在此处（recheck 是文件级 Depth 0，
  //         查重按父目录分组一次 Depth 1，省请求）；
  //   C 档：上传 / 删除在规划层已整体跳过，此处不会走到。
  ctx.uploadGuards = (scanR: any) => {
    const exists = scanR && !scanR.isDir
    if (ctx.caps.tier === 'A') {
      if (exists) {
        const tag = strongEtagOf(scanR.etag)
        return tag != null ? { ifMatch: `"${tag}"` } : { recheck: scanR }
      }
      return { ifNoneMatchStar: true }
    }
    if (ctx.caps.tier === 'B') return exists ? { recheck: scanR } : {}
    return {}
  }
  ctx.deleteGuards = (scanR: any) => {
    const exists = scanR && !scanR.isDir
    if (ctx.caps.tier === 'A') {
      const tag = exists ? strongEtagOf(scanR.etag) : null
      return tag != null ? { ifMatch: `"${tag}"` } : exists ? { recheck: scanR } : {}
    }
    if (ctx.caps.tier === 'B') return exists ? { recheck: scanR } : {}
    return {}
  }
  /**
   * 上传任务入队（规划 upload 分支与「远端根重建保护 → 恢复上传」改判共用）。
   * B 档「扫描期远端不存在」的新上传登记写前查重目标（bNewUploads）：这是唯一
   * 写前零守卫的远端写路径，对端在扫描 → 写入窗口内新建同名文件会被静默覆盖。
   * 半截强制重传必有扫描期远端条目（残缺文件本身），不进此集合。
   * 两段提交：intent → PUT（uploadOne）→ 暂存；基线提交与 done 移到批量校验阶段。
   */
  /**
   * 上传任务入队（两段提交：intent → PUT → 暂存，基线提交与 done 在批量校验阶段）。
   * @param settlePendings 传入 true 时按冲突落地语义在基线提交成功后清除该文件的
   *   挂起记录（runUploadOp fromConflict → 批量提交点 clearPending）——「不删除」
   *   决策的恢复上传用它清掉已解决的删除挂起；半截强制重传同样传 true
   *   （远端被证实为本机残缺文件，等效 choice='local'）。
   */
  ctx.pushUploadTransfer = (it: any, settlePendings = false) => {
    const scanR = it.r
    if (!scanR && ctx.caps.tier === 'B') ctx.bNewUploads.add(it.rel)
    ctx.pushTransfer(
      it.rel,
      async () => {
        // 字节计量器：PUT 读流逐块回调实时累加 bytesDone（大文件上传期间进度按真实
        // 大小推进）；完结补尾差（重试重发的重复字节由 max(0,…) 钳位消化）
        const meter = ctx.byteMeter()
        const parked = await ctx.runUploadOp(
          it,
          scanR && scanR.origName,
          async (uh: any) => {
            const up = await uploadOne(ctx.cfg, ctx.dir, it.rel, it.l, ctx.createdDirs, ctx.uploadGuards(scanR), { onBeforePut: uh.onBeforePut, onBytes: meter.onBytes }, ctx.localTol)
            await ctx.crashHook({ rel: it.rel, act: 'upload' })
            meter.finish(it.l.size)
            return up
          },
          settlePendings || ctx.forceUploads.has(it.rel)
        )
        return parked ? UPLOADED_PENDING : undefined
      },
      'upload',
      it.l.size,
      { it }
    )
  }
  /**
   * 规划期已发生的本地状态变更统一落盘：WAL 恢复采纳 / touch 型 mtime 刷新 / 无基线
   * adopt / 指纹噪声标记 / 退避与挂起表。这些变更只依赖扫描结果、与是否传输无关，
   * 让出路径与轮末收尾共用同一套调用 —— 让出不回滚本地已确认的事实，下轮从一致状态出发。
   */
  ctx.persistPlannedLocalState = async () => {
    await ctx.store.flush().catch(() => {})
    if (!ctx.store.loadedOk) await ctx.store.compact().catch(() => {})
    else await ctx.store.compactIfNeeded().catch(() => {})
    if (ctx.deepVerifyDue) ctx.store.meta.lastDeepVerifyAt = Date.now()
    await ctx.store.saveMeta().catch(() => {})
    if (ctx.store.failuresDirty) await ctx.store.saveFailures().catch(() => {})
    if (ctx.store.pendingsDirty) await ctx.store.savePendings().catch(() => {})
    if (!ctx.aborted) await ctx.store.truncateWal().catch(() => {})
    if (ctx.noiseDirty) await ctx.serverNoise.saveNoise().catch(() => {})
  }
  return ctx
}
/**
 * 同步单个目录的轮次编排层：引导 → 扫描 → 规划 → 两道闸 → 执行 → 收尾。
 * 各阶段函数只经 ctx 交互，三个隐性不变量见 RoundContext 头注释。
 */
async function runSyncRound(cfg: EngineCfg, dir: DirCfg, prefs: EnginePrefs, handlers: SyncHandlers): Promise<any> {
  const ctx = makeRoundContext(cfg, dir, prefs, handlers)
  await roundBootstrap(ctx)
  // 轮次体包进 try/finally：释放锁的 finally 覆盖全部退出路径 —— 正常结束 / 轮次
  // error（含 CIRCUIT_OPEN 熔断终止）/ shouldAbort 取消。未持锁（空轮 / 纯下载轮 /
  // skip / 关闭开关）时 lockHeld 为 false，直接跳过释放。
  try {
    return await roundBody(ctx)
  } finally {
    await releaseRoundLock(ctx)
  }
}

/** 轮首引导：残留清理 → 基线存储 → 左锁补删 → 远端根探测与决策闸 → 本地根健康检查。 */
async function roundBootstrap(ctx: RoundContext): Promise<void> {
  ctx.onProgress({ phase: 'scan', filesDone: 0, filesTotal: 0, bytesDone: 0, bytesTotal: 0, stage: 'scan' })

  // 清理上一轮崩溃残留的临时文件，再进入扫描 —— 避免清理与扫描器竞态。
  // 预演轮跳过（零本地写：残留临时文件留给真实轮清理，不影响规划正确性）
  if (!ctx.dryRun) await cleanupOrphanTemps(ctx.dir.localPath)
  ctx.realStore = await storage.openDirStore({ localPath: ctx.dir.localPath, remotePath: ctx.dir.remotePath })
  // 预演轮的只读存储壳（makeDryRunStore）：写方法全部 no-op，真实存储原样不动
  // 预演壳是同形 Proxy（写方法 no-op），按同一具名类型消费
  ctx.store = ctx.dryRun ? (makeDryRunStore(ctx.realStore) as unknown as storage.DirStateStore) : ctx.realStore
  if (!ctx.store.loadedOk) logNote('基线快照损坏：本轮按无基线保护模式执行（禁用删除传播）')
  // etag 跳过缓存：被跳过的子树要按基线合成远端条目，快照损坏
  //（loadedOk=false）时没有可信基线可合成 → 禁用跳过，强制全量列举
  ctx.scanCache = ctx.store.loadedOk ? ctx.store.getScanCache() : null
  // 1a. 左锁优先清理：上一轮「释放失败」记下的 lockLeftover 标记在本轮开头
  //     补删远端锁（建根之前、best-effort）。删除成功（404/2xx）即清标记；失败保留
  //     标记下一轮再试。不依赖 prefs.leaseLock 开关 —— 这是修复动作：即便用户随后
  //     关闭了租约锁，也要把上一轮留下的远端残留清走。DELETE 走无熔断 cfg + 单次
  //     尝试（与释放同口径：熔断触发时网络可能仍可用）。
  if (ctx.store.meta.lockLeftover && !ctx.dryRun) {
    try {
      const r = await davRequest({ ...ctx.cfg, __wdsyncBreaker: null }, 'DELETE', joinRemote(ctx.dir.remotePath, LOCK_NAME), { noRetry: true })
      if (r.status < 400 || r.status === 404) {
        delete ctx.store.meta.lockLeftover
        await ctx.store.saveMeta().catch(() => {})
      }
    } catch (_) {
      /* 网络不可用：保留标记，下一轮再试 */
    }
  }

  // 1. 确保远端根目录存在（目标为集合：URL 带尾斜杠发起）。
  //    扫描期失败的错误附带 failureClass（调度层跨轮退避的机器可读输入）——
  //    5xx/429/423 归 network（与 networkFailure 同口径），401/403/404 等配置类归 other
  //    显式请求体附带 RFC 4331 配额属性（quota-available-bytes / quota-used-bytes）：
  //    轮前配额预检的数据来源，零额外请求 —— 服务器不返回时字段缺省、预检静默跳过。
  const rootProbe = await davRequest(ctx.cfg, 'PROPFIND', ctx.dir.remotePath, {
    isCollection: true,
    headers: { Depth: '0', 'Content-Type': 'application/xml' },
    body: QUOTA_PROPFIND_BODY,
  })
  // 根探测状态归一：部分网关 / 服务对缺失集合不回 HTTP 404，而是 207 + 集合自身
  // 条目携带 404 propstat（扫描层 listRemoteSafe 对同形态另有识别，此处归一后
  // 下游的决策闸 / 选择消费 / 重建逻辑全部按 404 复用）。解析失败按状态码原语义。
  ctx.rootProbeStatus = rootProbe.status
  /** 云端剩余空间（RFC 4331，集合条目 quota-available-bytes；未返回 / 非数字 = null） */
  ctx.quotaAvailable = null
  /** 云端已用空间（同上；当前仅作观测字段随 testConnection 口径，预检只用可用量） */
  ctx.quotaUsed = null
  if (ctx.rootProbeStatus === 207 || ctx.rootProbeStatus === 200) {
    try {
      const probeItems = parseMultistatus(rootProbe.body ? rootProbe.body.toString('utf-8') : '')
      const selfGone = probeItems.some(
        (it: any) => it && !relFromHref(ctx.cfg, ctx.dir.remotePath, it.href).replace(/\/+$/, '') && /404/.test(String(it.status || ''))
      )
      if (selfGone) ctx.rootProbeStatus = 404
      // 集合自身条目的配额属性（rel 为空 = 集合自身；404 propstat 的条目无属性）
      const selfItem = probeItems.find((it: any) => it && !relFromHref(ctx.cfg, ctx.dir.remotePath, it.href).replace(/\/+$/, ''))
      if (selfItem) {
        if (typeof selfItem.quotaAvailable === 'number' && Number.isFinite(selfItem.quotaAvailable)) ctx.quotaAvailable = selfItem.quotaAvailable
        if (typeof selfItem.quotaUsed === 'number' && Number.isFinite(selfItem.quotaUsed)) ctx.quotaUsed = selfItem.quotaUsed
      }
    } catch (_) {
      /* 畸形 body：按状态码判定（207 → 照常进入扫描，由扫描层给结论） */
    }
  }
  // 本轮是否处于「移除本地」决策的执行态（choice 消费轮或标记延续轮）：
  // 仅用于 rootWasRebuilt 处的提示文案分支（移除轮不能说「文件会重新上传」）
  ctx.rootRemovalArmed = false
  // 预演轮「远端根尚不存在且基线为空」（首次同步的常态）标记：远端按空清单
  // 合成预演（不 MKCOL、不扫描 404 根），全部本地文件规划为上传
  ctx.dryRunRootMissing = ctx.dryRun && ctx.rootProbeStatus === 404 && ctx.store.entries.size === 0
  if (ctx.rootProbeStatus === 404) {
    if (ctx.store.entries.size === 0) {
      // 基线为空（首次同步 / 内容已和解）：无内容可保护，维持自动重建。
      // 预演轮不创建云端文件夹（零副作用）：按「云端为空」预演上传计划
      if (!ctx.dryRun) await mkdirDeep(ctx.cfg, ctx.dir.remotePath)
    } else if (ctx.dryRun) {
      // 预演轮不消费任何决策标记（零副作用）：无论是否已有选择，一律按
      // 「需要决策」停轮预演 —— 计划要等用户真实决策后才能成立
      await ctx.stopForRootLost()
    } else {
      // ---- 远端根丢失决策闸（基线非空：本地有内容，去留必须由用户决定）----
      // 云端同步根消失可能是「用户在网页端删除了它」（此时自动重建 + 全量重传会
      // 违背用户意图），也可能是服务器瞬时故障 / 目录被挪动 —— 引擎无法区分，
      // 因此不再自动重建，挂起等待用户二选一：
      //   upload       —— 重建云端文件夹并按根重建保护语义恢复上传（既有链路）；
      //   remove-local —— 跟随云端删除：meta.rootLostRemoval 标记使规划期的
      //                   delete-local 按用户已确认执行（移入回收站），未决的逐文件
      //                   删除确认挂起随之作废（根级决策已覆盖其问题）。
      // 选择前每轮以 root-lost 错误收场（不重建、不传输、零删除）；根在决策前恢复
      // （挪动回去 / 服务器瞬时 404）则挂起记录自动撤销，无需用户操作。
      const lostRec = ctx.store.getPending(ROOT_LOST_PENDING_REL)
      const lostChoice = lostRec && lostRec.kind === 'root-lost' ? lostRec.choice : undefined
      if (lostChoice === 'upload') {
        // 消费「重新上传」选择。保护标记先于 MKCOL 写入：建根失败（网络瞬时故障）
        // 的重试轮命中下方 rootRebuilt 分支继续恢复，不再重复打扰用户
        ctx.store.clearPending(ROOT_LOST_PENDING_REL)
        await ctx.store.savePendings().catch(() => {})
        if (!ctx.store.meta.rootRebuilt) ctx.store.meta.rootRebuilt = { at: Date.now() }
        await ctx.store.saveMeta().catch(() => {})
        await mkdirDeep(ctx.cfg, ctx.dir.remotePath)
      } else if (lostChoice === 'remove-local' || ctx.store.meta.rootLostRemoval) {
        // 消费「移除本地」选择（或标记延续轮：上轮选择后未和解完毕）。标记先于
        // MKCOL 写入，建根失败的重试轮直接走同一分支；未决的逐文件删除确认挂起
        // 在首次消费时作废（根级「移除」已回答它们的问题；keep 保留类不受影响，
        // 由逐文件挂起独立持续抑制）
        if (!ctx.store.meta.rootLostRemoval) {
          ctx.store.meta.rootLostRemoval = { at: Date.now() }
          for (const p of ctx.store.listPending()) {
            if (p.kind === 'delete') ctx.store.clearPending(p.rel)
          }
        }
        if (lostRec) {
          ctx.store.clearPending(ROOT_LOST_PENDING_REL)
          await ctx.store.savePendings().catch(() => {})
        }
        await ctx.store.saveMeta().catch(() => {})
        await mkdirDeep(ctx.cfg, ctx.dir.remotePath)
        ctx.rootRemovalArmed = true
      } else if (ctx.store.meta.rootRebuilt) {
        // 恢复进行中（此前已选「重新上传」且尚未和解，根又一次 404）：按既有保护
        // 语义继续重建重传，不再打断 —— 决策只在「全新丢失」时询问一次
        await mkdirDeep(ctx.cfg, ctx.dir.remotePath)
      } else {
        // 未决策（首次发现或重试）：登记挂起并停轮
        await ctx.stopForRootLost()
      }
    }
  } else if (ctx.rootProbeStatus >= 400) {
    const st = rootProbe.status
    // 网络类判定走 networkFailure 单一实现（5xx/429/423 归 network，其余归 other），
    // 与 summary.failureClass / 熔断计数同口径
    throw syncFail(`无法访问云端文件夹（HTTP ${st}）`, { phase: 'scan', failureClass: networkFailure({ status: st }) ? 'network' : 'other' })
  } else if (ctx.store.getPending(ROOT_LOST_PENDING_REL)) {
    // 根已恢复（决策前用户把文件夹挪了回来 / 服务器瞬时 404）：撤销未决策的挂起，
    // 本轮照常同步。meta.rootLostRemoval 不在此撤销 —— 移除执行未和解完毕前必须
    // 延续（见轮末解除判定），其语义不受根恢复影响
    ctx.store.clearPending(ROOT_LOST_PENDING_REL)
    await ctx.store.savePendings().catch(() => {})
  }
  /**
   * 远端根 404 后被重建（本轮探测到 404 并 MKCOL）且本地基线非空：
   * 远端「全部缺失」是根消失的伪象而非逐文件删除，本轮禁用删除传播
   *（delete-local 整类跳过 —— 真实场景下远端扫描为空，delete-remote 本就无法产生），
   * 本地文件按无基线恢复语义重新上传。标记写入 meta.rootRebuilt 并跨轮生效：
   * 重建轮之后仍可能有上传失败的文件停留在「本地未变 + 远端缺失」状态，下一轮
   * 若照常规划会把它们 delete-local 误删 —— 标记保持生效直至「待和解」清零
   *（全部基线文件要么重新上传成功、要么两侧皆无），届时自动恢复正常删除传播。
   * 例外：消费「重新上传」决策的重建轮本身强干净收场（无错误 / 无退避跳过 /
   * 无开放意图，见 applyRootGuardReleases）时，待和解当轮即清零 —— 标记当轮解除
   *（「成功即忘」：用户选择的策略随首次成功同步取消，云端再丢失必重新询问）。
   * 用户经挂起通道显式确认过的删除（kind='delete', choice='delete'）不受此保护拦截。
   */
  ctx.rootWasRebuilt = ctx.rootProbeStatus === 404 && ctx.store.entries.size > 0
  if (ctx.rootWasRebuilt) {
    if (!ctx.store.meta.rootRebuilt) ctx.store.meta.rootRebuilt = { at: Date.now() }
    ctx.pushWarning(
      ctx.rootRemovalArmed
        ? '云端文件夹已按你的选择重建，电脑上已同步的文件将被移除（有改动的文件会保留并重新上传）'
        : '云端的同步文件夹之前丢失了，已重新创建。为防止误删，暂时不会同步「删除」操作，电脑上的文件会重新上传，恢复后自动正常'
    )
  }

  /**
   * 1.2 本地根健康检查（远端根探测之后、扫描之前）：根目录不存在 / 不可读 /
   * 疑似未挂载（空目录 + 非空基线）→ 整轮中止，零删除零传输。放在根探测之后：
   * 远端不可达（网络类失败）优先按网络类归因上报（调度层退避输入的既有契约），
   * 本地根问题的报错不吞掉网络故障信号。
   */
  await checkLocalRootHealth(ctx.dir.localPath, ctx.store.entries.size)

// 1.5 目录级租约锁的载体状态（锁后置）：获取动作在 roundBody 的 acquireRoundLock
  //     阶段；crashErr / lockHeld / renewTimer / lockPath 由 RoundContext 承载（提升在
  //     轮次体作用域之外），releaseRoundLock 才能覆盖 正常 / 熔断 / 取消 全部退出路径。
  //     crashErr 在拿锁前置位的窗口下 lockHeld=false，释放 finally 自然空转（防御性兜底）。
  ctx.lockPath = joinRemote(ctx.dir.remotePath, LOCK_NAME)
}

/** 轮次体：扫描 → 规划 → [按需拿锁 + B 档写前查重] → 执行 → 收尾（阶段函数经 ctx 交互）。 */
async function roundBody(ctx: RoundContext): Promise<any> {
  await scanBothSides(ctx)
  await applyScanGates(ctx)
  await consumeCapabilities(ctx)
  await buildNfcViews(ctx)
  await buildRoundPlan(ctx)
  await planRoundPassOne(ctx)
  await planRoundPassTwo(ctx)
  await applyDeleteSafetyGate(ctx)
  await enqueueRenameTasks(ctx)
  await preflightRoundLimits(ctx)
  await acquireRoundLock(ctx)
  if (ctx.roundYielded) return ctx.summary // 让出：零传输按成功返回（planned 为信息性计数）
  await applyBDedupeGate(ctx)
  await runTransferPool(ctx)
  await commitBatchUploads(ctx)
  applyRootGuardReleases(ctx)
  await pruneEmptyDirs(ctx)
  // 熔断汇总：除各文件自身的失败信息外，补一条整轮结论与剩余量。
  // 网络类标记恒真：熔断只在网络类连续失败时打开（计数口径与 networkFailure 一致）
  if (ctx.roundBreaker.open) {
    ctx.pushError(
      `服务器连续多次出错，本次同步已暂停，剩余文件会在下次同步时继续`,
      true
    )
  }

  // 崩溃注入（测试）：真实进程崩溃不会执行任何收尾 —— 这里同样直接抛出，
  // 不 flush / 不压缩 / 不清 WAL，遗留的未了结意图留给下一轮 recoverIntents。
  if (ctx.crashErr) {
    ctx.crashErr.phase = 'execute'
    ctx.crashErr.summary = ctx.summary
    ctx.crashErr.errors = ctx.summary.errors
    throw ctx.crashErr
  }

  // B 档并发安全提示的「已提醒」落盘（名额消耗，见步骤 3.5）：只在本轮干净收场
  //（无文件级错误且未取消 —— 恰为步骤 9 不抛错的补集，渲染层只对这种轮次弹警告
  // toast）时置位，随下方 persistPlannedLocalState 的 noiseDirty 通道一并保存；
  // 弹不到用户的轮次不消耗名额，下一轮继续携带，直到用户真正看到过一次。
  // 预演轮不消耗（预演不产生用户可见的警告 toast —— 渲染层对预演结果静默展示）。
  if (ctx.tierBNoticePending && !ctx.dryRun && !ctx.aborted && ctx.summary.errors.length === 0) {
    ctx.serverNoise.noise.concurrencyWarned = true
    ctx.noiseDirty = true
  }

  // 8. 轮末收尾：fsync → 压缩 → 保存元数据 → 清空已了结的 WAL（与让出路径
  //    共用 persistPlannedLocalState，见该函数注释）。快照损坏的轮次强制压缩：用本轮
  //    已验证的事实重建快照，下一轮恢复正常基线模式（否则 loadedOk 永远为 false，
  //    保护模式会不必要地持续到所有后续轮次）。
  //    预演轮跳过收尾（零副作用：不 flush / 不压缩 / 不写 meta；只读存储壳下的
  //    这些调用本就是 no-op，显式跳过让 deepVerify 时间戳等 meta 直写也无从发生）。
  if (!ctx.dryRun) await ctx.persistPlannedLocalState()
  // etag 跳过运行时异常收口（第二层防御的落点，见 noteEtagSkipAnomaly）：被跳过
  // 子树内出现与基线不一致的远端状态 → 提示用户，并把缓存 lastFullScanAt 归零
  //（0 = 立即过期），下一轮强制全量下降核对真实远端状态。这是「探测验证」之外
  // 的运行时防线 —— 探测是 7 天前的快照，服务器行为可能已变；异常把界内滞后
  // 收敛到一轮。放在错误抛出之前：带错轮次同样要收口（异常轮最需要下一轮核对）。
  if (ctx.etagSkipAnomaly) {
    logNote(`etag 跳过的子树内出现与基线不一致的远端状态（${ctx.etagSkipAnomaly}）：下一轮将强制全量扫描核对`)
    await ctx.store.saveScanCache({ ...ctx.newScanCache, lastFullScanAt: 0 }).catch(() => {})
  }
  // C 档跳过汇总（每轮一条，不随文件数刷屏；信息明确到动作计数）
  if (ctx.roSkipped > 0) ctx.pushWarning(`服务器只能下载，本次跳过了 ${ctx.roSkipped} 个上传/删除操作，电脑上的文件都还在`)
  // 持续失败退避汇总（每轮一条）：最多列 3 个示例（文件名 + 失败原因 + 下次重试时间），
  // 其余以「等」带过 —— 不随文件数刷屏，用户能看到是哪些文件、为什么被跳过、何时自动恢复
  if (ctx.permSkipped.length > 0) {
    const fmtRetry = (ms: any) => {
      const d = new Date(ms)
      const p = (n: any) => String(n).padStart(2, '0')
      return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
    }
    const examples = ctx.permSkipped
      .slice(0, 3)
      .map(({ rel, fr }) => `${rel}：${String(fr.message || fr.code || '').slice(0, 80)}（下次重试 ${fmtRetry(fr.retryAtMs)}）`)
      .join('；')
    ctx.pushWarning(`有 ${ctx.permSkipped.length} 个文件一直同步失败（${examples}${ctx.permSkipped.length > 3 ? ' 等' : ''}），已暂时跳过，稍后会自动重试`)
  }
  // 冲突挂起延续汇总（每轮一条）：本轮按上次的选择自动解决、未再次
  // 询问的冲突清单（最多列 3 个示例）—— 让用户感知决策被沿用；解决失败的仍留在
  // 挂起表里（choice 保留），下一轮继续沿用
  if (ctx.pendingResolved.length > 0) {
    const fmtChoice = (c: any) => (c === 'local' ? '保留电脑版本' : c === 'remote' ? '保留云端版本' : '两个都留')
    const pendExamples = ctx.pendingResolved.slice(0, 3).map(({ rel, choice }) => `${rel} → ${fmtChoice(choice)}`).join('；')
    ctx.pushWarning(`按你上次的选择自动处理了 ${ctx.pendingResolved.length} 个冲突（${pendExamples}${ctx.pendingResolved.length > 3 ? ' 等' : ''}），没有再询问你`)
  }
  // 删除安全汇总（每轮一条）：批量删除超阈值时闸内已推送详细 warning，这里补
  // 跨轮存量挂起与「保留 / 根重建保护」的可见性 —— 待处理面板逐条 / 批量确认
  if (ctx.summary.deleteHeld > 0 && !ctx.deleteThresholdTripped) {
    ctx.pushWarning(`有 ${ctx.summary.deleteHeld} 项删除在等你确认，确认前不会删除任何文件`)
  }
  if (ctx.summary.deleteRestored > 0) {
    ctx.pushWarning(`按你之前选的「不删除」，${ctx.summary.deleteRestored} 个文件已从电脑重新上传，云端已恢复`)
  }
  if (ctx.summary.deleteKept > 0) {
    ctx.pushWarning(`按你之前选的「不删除」，${ctx.summary.deleteKept} 个文件的云端副本保留了下来（电脑上已删除的文件不会恢复）`)
  }
  // 空目录清理汇总（有清理动作才提示）
  if (ctx.summary.dirsPrunedLocal > 0 || ctx.summary.dirsPrunedRemote > 0) {
    ctx.pushWarning(`清理了因同步而变空的文件夹：电脑 ${ctx.summary.dirsPrunedLocal} 个、云端 ${ctx.summary.dirsPrunedRemote} 个`)
  }
  // 预演汇总（每轮一条，结果弹窗与同步记录共同携带）：如实说明预演的时效边界
  if (ctx.dryRun) {
    ctx.pushWarning('这是预演结果，没有改动任何文件。实际同步前文件内容可能又有变化，以真实同步为准')
  }

  // 9. 文件级失败 / 中止 → 以错误状态上报（已成功文件的基线保留，summary 附带）。
  //    抛错 / 正常返回前统一补齐 failureClass / openIntents / breaker。
  ctx.finalizeSummaryMeta()
  if (ctx.summary.errors.length || ctx.aborted) {
    const err: any = new Error(ctx.summary.errors[0] || (ctx.aborted ? '已取消同步' : '同步意外停止，请稍后重试'))
    err.phase = 'execute'
    err.summary = ctx.summary
    err.errors = ctx.summary.errors
    throw err
  }
  return ctx.summary
}
/** 阶段 2：三路并行扫描（本地 / 能力 / 远端）+ 浅响应阀门 + 扫描形态记录 + 脏集消费。 */
async function scanBothSides(ctx: RoundContext): Promise<void> {
  // 2. 三路并行：本地扫描 + 能力获取 + 远端扫描。能力结论决定远端扫描形态
  //    （depthInfinity 支持时单请求拿整棵树，见 listRemoteSafe），因此远端扫描
  //    依赖 caps 的 Promise；能力缓存命中（常态，7 天 TTL）时它几乎零耗时，
  //    本地与远端扫描仍近似并行。冷缓存轮次探测与两路扫描并发（探测写全部
  //    落在自己的 .wdsync-probe- 随机目录，扫描层按前缀排除，互不干扰）。
  //    用户排除规则（prefs.excludePatterns）与勾选树精确 rel（prefs.excludeRels）
  //    在两侧扫描层统一生效（compileSyncExcludes：glob + 精确路径，含祖先目录命中）。
  //    本地扫描带节流进度回调（phase='scan' 的 filesDone 递增事件）。
  ctx.excludeMatcher = compileSyncExcludes(ctx.prefs.excludePatterns, ctx.prefs.excludeRels)
  const capsPromise = getSyncCapabilities(ctx.cfg, ctx.dir.remotePath)
  // 本地脏路径快速核对：仅 watch 来源 hints、脏集非空
  // 且不超 DIRTY_SCAN_MAX、基线可信（loadedOk —— 合成依赖基线，快照损坏时必须
  // 全量实测）时启用；否则全量 walk。hints.watcherKey 是调度器注册该目录
  // watcher 用的 id（`${instanceId}:${dirId}`），扫描成功后据此清理脏集。
  const hints = ctx.handlers && ctx.handlers.hints
  const dirtyList =
    hints && hints.source === 'watch' && Array.isArray(hints.dirtyPaths) ? (hints.dirtyPaths as string[]) : null
  const useDirty = !!dirtyList && dirtyList.length > 0 && dirtyList.length <= DIRTY_SCAN_MAX && ctx.store.loadedOk
  // etagSkipUsed：本轮是否把 scan-cache 的集合 etag 表传给了远端扫描（子集合
  // etag 未变即跳过其 PROPFIND）。Promise.all 必然先等扫描
  // promise 了结，随后读取该标记是安全的。
  ctx.etagSkipUsed = false
  const [localScan, caps, remoteScan] = await Promise.all([
    dirtyList && useDirty
      ? scanDirtyFast(ctx.dir.localPath, dirtyList, ctx.store, ctx.prefs.ignoreHidden, ctx.excludeMatcher, (n) =>
          // 快速核对完成后强制报告一次最终计数（与全量扫描的终态送达同契约）
          ctx.onProgress({ phase: 'scan', filesDone: n, filesTotal: 0, bytesDone: 0, bytesTotal: 0, stage: 'scan' }, true)
        )
      : scanDirSafe(ctx.dir.localPath, ctx.prefs.ignoreHidden, ctx.excludeMatcher, (n) =>
          // 扫描进度事件经 force 外发：scanDirSafe 内部已按 SCAN_PROGRESS_MS 节流
          //（含末次强制报告），这里不再吃引擎层节流 —— 保证最终扫描计数必然送达
          ctx.onProgress({ phase: 'scan', filesDone: n, filesTotal: 0, bytesDone: 0, bytesTotal: 0, stage: 'scan' }, true)
        ),
    capsPromise,
    capsPromise.then((c) => {
      // etag 子树跳过的统一裁决（listRemoteSafe 只执行不判断，契约见其头注释）：
      //   - 逐目录形态（infinity 单请求已最优，无请求可省）；
      //   - 探测实测集合 etag 深层传播（etagPropagation=true：深层修改必然改变
      //     所有祖先集合 etag，「子集合 etag 未变 ⇒ 子树未变」才成立）；
      //   - 缓存存在、新鲜（ETAG_SKIP_FULL_SCAN_MS 内有过一次全量下降 —— 周期性
      //     全量把「服务器侧停止传播造成的界内滞后」限制在有界时间内）且含观测。
      // 任一条件不满足传 null（不跳过），行为与既有完全一致。
      const fresh =
        !!ctx.scanCache &&
        typeof ctx.scanCache.lastFullScanAt === 'number' &&
        Date.now() - ctx.scanCache.lastFullScanAt <= ETAG_SKIP_FULL_SCAN_MS
      const usable =
        !c.depthInfinity &&
        c.etagPropagation === true &&
        !!ctx.scanCache &&
        fresh &&
        ctx.scanCache.collections &&
        Object.keys(ctx.scanCache.collections).length > 0
      ctx.etagSkipUsed = usable
      // 预演轮 + 远端根缺失（首次同步常态）：不 MKCOL、不扫描 —— 按「云端为空」
      // 合成完整空清单，规划出「全部本地文件上传」的预演计划（与真实轮的
      // 「建根 + 无基线恢复上传」结果一致）
      if (ctx.dryRun && ctx.dryRunRootMissing) {
        return Promise.resolve({ files: new Map(), complete: true, errors: [], probeResidue: [], depth: 'per-dir', collections: new Map(), skippedDirs: [] })
      }
      return listRemoteSafe(ctx.cfg, ctx.dir.remotePath, ctx.prefs.ignoreHidden, ctx.excludeMatcher, {
        depthInfinity: c.depthInfinity,
        collectionEtasg: usable ? new Map(Object.entries(ctx.scanCache.collections)) : null,
      })
    }),
  ])
  ctx.localScan = localScan
  ctx.caps = caps
  ctx.remoteScan = remoteScan
  // 扫描形态信息字段（引擎侧观测，渲染层不依赖；见 types.mts SyncSummary.scan）：
  // local = 'dirty'（基线合成 + 脏路径核对的快速形态，仅 watch 轮）| 'full'（全量
  // walk）；dirtyPaths 为本轮 watch hints 携带的脏路径数（回落全量的轮次也保留
  // 该计数，供观测「带了 N 条但未启用」的回落原因排查）。
  ctx.summary.scan = {
    remote: ctx.remoteScan.depth,
    skippedDirs: (ctx.remoteScan.skippedDirs || []).length,
    local: useDirty ? 'dirty' : 'full',
    dirtyPaths: dirtyList ? dirtyList.length : 0,
  }
  // 脏集消费：本地扫描已完成且未中止 → 恰好清除本轮核对过的这些路径。放扫描
  // 之后（清理语义 = 已核对消费）：扫描期间新到的 watch 事件路径不在快照里，
  // 留在集合中给下一轮；扫描失败 / 中止不清（本轮 localScan 未被采用到收尾，
  // 下一轮重新核对）。此后轮内任一失败（I1 闸门 / 传输错误）都不再恢复脏集 ——
  // 脏集只是加速手段，正确性由全量轮兜底，清了至多多跑一次全量。
  if (dirtyList && useDirty && hints && hints.watcherKey && !ctx.shouldAbort()) clearDirtyPaths(hints.watcherKey, dirtyList)

  // 2.5 单请求扫描的「浅响应」运行时阀门：能力探测已用嵌套探测文件
  //     验证过服务器确实返回深层条目，但能力缓存最长 7 天、且不排除按目录行为
  //     分歧 —— 若基线里有大量嵌套文件而 Depth:infinity 响应里一个嵌套条目都
  //     没有，最可能是服务器把 infinity 当 Depth:1 应答；残缺树会被决策层解读
  //     成「远端已删除」→ 批量 delete-local。阈值与批量删除闸同口径（只在大规模
  //     时拦截，个别深层文件真实被删不触发）；命中按「扫描不完整」中止整轮
  //    （I1 闸门接管：零删除、零传输）。已不完整的扫描（如根缺失上报）不再
  //     叠加本阀门。根重建 / 移除执行的窗口期（本轮或标记延续轮重建了云端根，
  //     「远端为空」是已知伪象且删除传播已被停用）必须跳过 —— 否则「重新上传」
  //     的恢复轮会撞阀门死循环，永远传不上去。命中同时把该服务器的缓存能力
  //     持久降级为 depthInfinity=false（best-effort）：下一轮起改用逐目录扫描
  //    （对只回第一层的服务器语义恰好正确），直到下次能力探测（TTL 过期 /
  //     手动重探）自然恢复 —— 避免「服务器永远浅应答、每轮都撞阀门」的死循环。
  if (
    ctx.remoteScan.complete &&
    ctx.remoteScan.depth === 'infinity' &&
    ctx.store.entries.size > 0 &&
    !ctx.rootWasRebuilt &&
    !ctx.store.meta.rootRebuilt &&
    !ctx.store.meta.rootLostRemoval
  ) {
    const shallowThreshold = Math.max(DELETE_BATCH_MIN, Math.ceil(ctx.store.entries.size * DELETE_BATCH_RATIO))
    let nestedBase = 0
    for (const k of ctx.store.entries.keys()) {
      if (String(k).includes('/')) {
        nestedBase++
        if (nestedBase > shallowThreshold) break
      }
    }
    if (nestedBase > shallowThreshold) {
      let nestedScan = false
      for (const k of ctx.remoteScan.files.keys()) {
        if (String(k).includes('/')) {
          nestedScan = true
          break
        }
      }
      if (!nestedScan) {
        ctx.remoteScan.complete = false
        ctx.remoteScan.errors.push({ rel: '.', message: 'Depth:infinity 响应未包含任何嵌套条目，疑似服务器只返回了第一层（为避免批量误删，本轮按扫描不完整处理）' })
        // 持久降级（浅应答服务器改成逐目录形态即可正常工作）：
        try {
          const state = await storage.openServerState(originOf(ctx.cfg), (ctx.cfg && ctx.cfg.username) || '')
          const cached = state.getCachedCapabilities(PROBE_TTL_MS)
          if (cached && cached.depthInfinity) {
            const toSave = { ...cached, depthInfinity: false }
            toSave.notes = [...(toSave.notes || []), 'Depth:infinity 响应疑似只返回第一层，已降级为逐目录扫描（下次能力探测自动恢复）']
            await state.saveCapabilities(toSave).catch(() => {})
          }
        } catch (_) {
          /* 降级失败不影响本轮中止语义：下一轮再撞阀门时重试 */
        }
      }
    }
  }

}
/** 阶段 3 / 3.2 / 3.3：扫描完整性闸门（I1）→ 探测残留清理 → etag 跳过子树合成与 scan-cache 收割。 */
async function applyScanGates(ctx: RoundContext): Promise<void> {
  // 3. 扫描完整性闸门（I1）：任一侧不完整 → 整轮中止。
  //    取消销毁了扫描期的在途 PROPFIND 时按取消语义收场 ——「扫描未完成」
  //    的误导性报错只留给真实的扫描故障。
  if (!ctx.localScan.complete || !ctx.remoteScan.complete) {
    if (ctx.shouldAbort()) throw syncFail('已取消同步', { phase: 'scan' })
    // 远端根级 404（根在探测后 / 扫描前的窗口内消失，或单请求形态的根缺失上报）
    // 与「部分目录读不出」是两类故障：前者正是「同步目标被删除」的场景，按根丢失
    // 决策闸处理（登记待决策、零删除零传输）；后者维持 I1 原语义。基线为空或
    // 「移除本地」执行中不适用 —— 前者无内容可保护，后者已有明确决策在执行。
    if (
      !ctx.remoteScan.complete &&
      ctx.localScan.complete &&
      ctx.store.entries.size > 0 &&
      !ctx.store.meta.rootLostRemoval &&
      (ctx.remoteScan.errors || []).some((e: any) => e && e.rel === '.' && String(e.message || '').includes('404'))
    ) {
      await ctx.stopForRootLost()
    }
    const scanProblems = [
      ...ctx.localScan.errors.map((e: any) => `本地 ${e.rel}: ${e.message}`),
      ...ctx.remoteScan.errors.map((e: any) => `远端 ${e.rel}: ${e.message}`),
    ]
    // 扫描失败的 failureClass（远端扫描失败属 network —— 服务器 /
    // 网络不可用，调度层据此退避）；仅本地扫描不完整归 other；双侧都不完整归 mixed
    const scanClass = !ctx.remoteScan.complete && !ctx.localScan.complete ? 'mixed' : !ctx.remoteScan.complete ? 'network' : 'other'
    // summary 携带「友好标题 + 逐条具体原因」：渲染层错误条据此把为什么读不出来
    //（404 / 403 / 网络中断…）展示出来，而不是只有一句笼统的停止说明无从行动
    const scanFailMsg = '没能完整读取文件列表，本次同步已停止，避免误删文件'
    const scanErr = syncFail(scanFailMsg, { phase: 'scan', errors: scanProblems, failureClass: scanClass })
    scanErr.detail = scanProblems[0]
    scanErr.summary = { ...ctx.summary, errors: [scanFailMsg, ...scanProblems], failureClass: scanClass }
    throw scanErr
  }

  // 3.2 远端探测残留清理（崩溃残留双通道之二，与 runCapabilityProbe 启动清理互补）：
  //     复用本轮扫描结果（listRemoteSafe 旁路登记的 probeResidue），除 DELETE 本身外
  //     不增加任何请求。只处理同步根第一层的 `.wdsync-probe-` 目录且 mtime 距今
  //     ≥ PROBE_RESIDUE_MIN_AGE_MS 者 —— 前缀匹配不区分设备（清理**所有设备**的
  //     崩溃残留；活跃探测必然年轻，年龄门槛保证并发探测不被误删），且探测只会在
  //     根下第一层产生残留，绝不递归删除其他内容。best-effort：并发 DELETE、单个
  //     失败仅汇总为一条 warning（下轮再试），绝不阻断轮次；放在 I1 闸门之后，
  //     清理与否不影响扫描完整性判定。计数不计入 summary.deleted（非用户文件语义）。
  {
    const stale = (ctx.remoteScan.probeResidue || []).filter(
      (e: any) => e.rel && e.mtimeMs > 0 && Date.now() - e.mtimeMs >= PROBE_RESIDUE_MIN_AGE_MS
    )
    if (stale.length) {
      const base = String(ctx.dir.remotePath).replace(/\/+$/, '')
      const settled = await Promise.allSettled(stale.map((e: any) => davRequest(ctx.cfg, 'DELETE', joinRemote(base, e.rel))))
      const failedCnt = settled.filter((r) => r.status === 'rejected' || !r.value || r.value.status >= 400).length
      if (failedCnt) logNote(`清理远端探测残留失败 ${failedCnt}/${stale.length} 个（不影响本轮同步，下轮重试）`)
    }
  }

  // 3.3 etag 跳过子树的合成与 scan-cache 收割（仅在 I1 闸门之后：
  //     只有完整扫描轮的观测才可落入缓存；合成条目也只有完整轮才有资格充当
  //     「远端子树状态」的代表）。
  ctx.skippedDirs = (ctx.remoteScan.skippedDirs || []) as string[]
  /** rel（NFC）是否位于任一被跳过的子集合之下（跳过目录通常少量，线性前缀比对即可；条目多时由调用方分片） */
  const underSkipped = (rel: string) => ctx.skippedDirs.some((s) => rel.startsWith(s + '/'))
  if (ctx.skippedDirs.length > 0) {
    // a) 按基线合成被跳过子树的远端条目 —— 合成即断言「服务器子树与基线一致」，
    //    依据是父清单里该子集合 etag 未变 + 探测验证的深层传播能力（深层修改必然
    //    改变祖先集合 etag，故 etag 未变 ⇒ 子树未变）。文件按基线的远端指纹合成；
    //    rawRel 的最后一段换回 m.origName（若有）—— remoteByNfc 的 NFC 循环从原始
    //    rel 推导 origName，直接用 NFC 键会丢 NFD 服务器原名。
    for (const [k, m] of ctx.store.entries) {
      await maybeYield() // 数万基线条目 × 跳过前缀的比对循环分片让出（与既有循环同规格）
      if (!underSkipped(k)) continue
      const segs = k.split('/')
      if (m.origName) segs[segs.length - 1] = m.origName
      ctx.remoteScan.files.set(segs.join('/'), { isDir: false, size: m.rsize, mtimeMs: m.rmtimeMs, etag: m.retag, synth: true })
    }
    // 目录条目合成（空目录清理的 dirChildren 依赖目录条目在表）：缓存里位于跳过
    // 前缀下的集合观测即为本轮未列举、按同一断言仍存在的子集合
    if (ctx.scanCache && ctx.scanCache.collections) {
      for (const k of Object.keys(ctx.scanCache.collections)) {
        if (!underSkipped(k)) continue
        const c = ctx.scanCache.collections[k]
        ctx.remoteScan.files.set(k, { isDir: true, size: 0, mtimeMs: c.m, etag: c.e, synth: true })
      }
    }
  }
  // b) 收割新 scan-cache：本轮观测 ∪ 跳过前缀下的旧缓存条目（carry-forward ——
  //    被跳过子树内部本轮未列举，旧值继续有效，这正是下一轮还能继续跳过的关键）。
  //    lastFullScanAt：全量下降（infinity 形态或未传 etag 表）刷新为当前时刻，
  //    跳过轮沿用旧值（6 小时新鲜期由步骤 2 的 usable 裁决消费，见
  //    ETAG_SKIP_FULL_SCAN_MS）。写失败仅提示（缓存只是性能优化，下一轮多列举
  //    一些目录而已）。
  const fullDescent = ctx.remoteScan.depth === 'infinity' || !ctx.etagSkipUsed
  const mergedCollections: Record<string, any> = {}
  for (const [k, v] of ctx.remoteScan.collections) mergedCollections[k] = v
  if (ctx.skippedDirs.length > 0 && ctx.scanCache && ctx.scanCache.collections) {
    for (const k of Object.keys(ctx.scanCache.collections)) {
      if (underSkipped(k)) mergedCollections[k] = ctx.scanCache.collections[k]
    }
  }
  ctx.newScanCache = {
    v: 1,
    lastFullScanAt: fullDescent ? Date.now() : Number(ctx.scanCache && ctx.scanCache.lastFullScanAt) || 0,
    collections: mergedCollections,
  }
  await ctx.store.saveScanCache(ctx.newScanCache).catch((e: any) =>
    logNote(`etag 跳过缓存写入失败（${(e && e.message) || e}）：下一轮将全量列举`)
  )
  /**
   * etag 跳过的运行时异常防线（第二层防御）：被跳过子树内的文件出现「远端实际
   * 状态 ≠ 合成（基线）状态」的迹象时置位（幂等，只记首个原因）。这是「探测
   * 验证」之外的兜底 —— 探测结论最长已是 7 天前的快照，服务器行为可能已变。
   * 触发点见各钩子（冲突判定 / 条件请求 412 / 写前复查失配 / 写前查重）；
   * 轮末统一收口（见 finalize 区的异常处理块）。
   */
  ctx.etagSkipAnomaly = null

}
/** 阶段 3.5：消费能力结论（档位提示 / 指纹噪声存储 / C 档跳过计数）。 */
async function consumeCapabilities(ctx: RoundContext): Promise<void> {
  // 3.5 服务器能力与档位（写权限按本目录远端根路径判定）：与扫描
  //     并行获取（见步骤 2 —— 远端扫描形态依赖它，提前到此），此处只消费结论。
  //     探测请求计入轮次开销但不计入传输进度（bytes 字段只反映用户文件）。
  //     探测绝不抛出（失败降级 B 档）。
  // 指纹噪声存储（origin+username 粒度、跨目录共享），异常时降级为空实现；
  // B 档并发安全提示的「已提醒」标记同住这里（随 noise.json 跨轮持久）。
  ctx.serverNoise = await openServerNoiseSafe(ctx.cfg)
  ctx.summary.tier = ctx.caps.tier
  ctx.tierBNoticePending = false
  if (ctx.caps.tier === 'B') {
    // B 档并发安全提示每个服务器只携带一轮：渲染层对每轮 summary.warnings 弹
    // toast，逐轮携带会每次自动同步都弹一次。是否已提醒记入 noise.concurrencyWarned
    //（noise.json 持久化）；本轮名额只在干净收场时消耗（见轮末收口 —— 出错 / 取消 /
    // 熔断轮渲染层不弹警告 toast，弹不到就不算「弹过」）。探测降级轮（degraded，
    // 服务器真实档位未知）不携带也不消耗。
    if (!ctx.caps.degraded && !ctx.serverNoise.noise.concurrencyWarned) {
      ctx.tierBNoticePending = true
      ctx.pushWarning('这个服务器无法保证多台设备同时修改时的安全。覆盖或删除云端文件前会先确认，但仍有极小概率覆盖其他设备刚做的修改')
    }
  } else if (ctx.caps.tier === 'C') {
    ctx.pushWarning(`服务器不允许上传，本次只会下载文件${ctx.caps.writeReason ? `（${ctx.caps.writeReason}）` : ''}`)
  }
  ctx.noiseDirty = false
  ctx.roSkipped = 0 // C 档跳过的上传 / 删除 / 冲突动作数（轮末汇总一条 warning）

}
/** 阶段 4 / 4.5 / 5：NFC 视图 → 大小写冲突检测 → 本地容差 → WAL 意图恢复。 */
async function buildNfcViews(ctx: RoundContext): Promise<void> {
  // 4. NFC 视图：两侧 key 统一 NFC；实际访问用原始 abs / origName
  ctx.localByNfc = new Map()
  for (const [rel, info] of ctx.localScan.files) {
    await maybeYield() // 分片让出（数万条目的 Map 构建是紧凑 CPU 循环）
    ctx.localByNfc.set(nfc(rel), info)
  }
  ctx.remoteByNfc = new Map()
  for (const [rel, info] of ctx.remoteScan.files) {
    await maybeYield()
    ctx.remoteByNfc.set(nfc(rel), { ...info, origName: rel.split('/').pop() })
  }

  /**
   * 4.5 大小写冲突检测：同目录下仅大小写不同的文件在大小写不敏感的
   * 文件系统 / 服务器上是同一个名字，传输任一侧都会静默覆盖另一侧。涉及的
   * rel 全部进 caseSkip —— 规划层跳过其 upload / download / conflict（含 adopt
   * 收敛与半截强制重传），逐组报错提示用户重命名；删除传播不受限（删除其一
   * 正是消除冲突的手段，下轮自动恢复）。远端侧只取文件条目（目录不参与传输）。
   * 错误逐组上报、最多列 5 组（其余由 errors 截断机制自然收纳），不随文件数刷屏。
   */
  const remoteFileKeys: any[] = []
  for (const [k, v] of ctx.remoteByNfc) {
    await maybeYield() // 分片让出（数万条目的过滤循环）
    if (!v.isDir) remoteFileKeys.push(k)
  }
  const caseCollisions = detectCaseCollisions(ctx.localByNfc.keys(), remoteFileKeys)
  ctx.caseSkip = caseCollisions.skip
  caseCollisions.groups.slice(0, 5).forEach((g: any) => {
    const sideText = g.side === 'local' ? '电脑上' : g.side === 'remote' ? '云端' : '电脑和云端'
    ctx.pushError(`${sideText}同时有 ${g.rels.join(' 和 ')} 两个文件，只有大小写不同，在 Windows 和 macOS 上会被当成同一个文件，已跳过，请改名其中一个`, false)
  })
  if (caseCollisions.groups.length > 5) {
    ctx.pushError(`另有 ${caseCollisions.groups.length - 5} 组这样的文件未逐条列出（同样已跳过），请检查文件夹`, false)
  }

  ctx.localTol = await localFpTolMs(ctx.dir.localPath)

  // 5. WAL 崩溃恢复：用本轮扫描结果核对遗留意图 —— 采纳 /
  //    放弃 / 判定半截。半截命中者进入 forceUploads，规划期强制按 upload 重传。
  //    采纳内容确认受单轮字节预算约束（耗尽回退按大小采纳 + 轮末汇总 warning）。
  //    注意：remoteByNfc 可能含 etag 跳过子树的「合成条目」（按基线指纹合成，见
  //    3.3a）—— 意图记录的是写入当时的两侧指纹，合成 = 「按集合 etag 未变推定
  //    远端仍是指意图时的状态」，参与恢复判定与真实观测同口径、语义自洽。
  ctx.forceUploads = await recoverIntents(ctx.store, ctx.cfg, ctx.dir, ctx.localByNfc, ctx.remoteByNfc, ctx.localTol, ctx.verifyMaxBytes, ctx.pushWarning, ctx.adoptVerifyBudgetBytes)

  // 深度校验（默认关）：到期则对 mtime/size 未变的文件也重算 hash 比对基线
  ctx.deepVerifyDue = 
    ctx.prefs.deepVerify === true &&
    (!ctx.store.meta.lastDeepVerifyAt || Date.now() - Number(ctx.store.meta.lastDeepVerifyAt) > Math.max(1, Number(ctx.prefs.deepVerifyDays) || 7) * 86400000)

}
/** 阶段 6：计划组装（三侧 key 并集）与进度分母定格。 */
async function buildRoundPlan(ctx: RoundContext): Promise<void> {
  // 6. 规划：变化判定（含 hash 消歧）→ 决策 → 生成传输任务
  const rels = new Set([...ctx.localByNfc.keys(), ...ctx.remoteByNfc.keys(), ...ctx.store.entries.keys()])
  ctx.plan = []
  for (const rel of rels) {
    await maybeYield() // 分片让出（三侧 key 并集的组装循环）
    // 排除规则 / 勾选树命中的基线残留条目跳过规划：「本轮不可见」≠「两侧已删」
    // —— 两侧扫描层已把它们挡在外面，唯一来源是基线；若按 l/r 皆空走 clean
    // 出清基线，重新勾选后的内容分叉会被误判成冲突（跟踪丢失）。基线保持，
    // 重新可见后按基线正常判变化。
    if (ctx.excludeMatcher && ctx.excludeMatcher(rel)) continue
    const rEntry = ctx.remoteByNfc.get(rel)
    if (rEntry && rEntry.isDir) continue // 目录条目不参与文件决策（上传时自动建目录）
    const l = ctx.localByNfc.get(rel) || null
    const r = rEntry || null
    const m = ctx.store.get(rel)
    ctx.plan.push({ rel, l, r, m })
  }
  ctx.summary.totalFiles = ctx.plan.length
  ctx.planByRel = new Map(ctx.plan.map((it) => [it.rel, it]))
  // 扫描到的全部文件字节（两侧并集）：云端占用估算的数据来源，与传输量无关
  //（「需要上传 / 下载多少字节」由传输阶段的 transferBytesTotal 承担）
  ctx.scanBytesTotal = 0
  for (const it of ctx.plan) ctx.scanBytesTotal += (it.l ? it.l.size : 0) + (it.r ? it.r.size : 0)
  // 计划需要上传 + 下载的总字节（传输进度的分母）：由 pushTransfer 按任务累加，
  // 删除任务计 0；写前查重剔除任务时同步扣减
  ctx.transferBytesTotal = 0
  // verifyDone / verifyTotal：规划期内容校验（verify）的进度字段（追加需求），
  // 无校验任务时保持 0；有任务时由下方 verify 池持续更新
  ctx.onProgress({ phase: 'plan', filesDone: 0, filesTotal: ctx.plan.length, bytesDone: 0, bytesTotal: 0, stage: 'plan', scanBytesTotal: ctx.scanBytesTotal, verifyDone: 0, verifyTotal: 0 })

  ctx.filesDone = 0
  ctx.bytesDoneAcc = 0
  // tick / emitPlan 经节流 onProgress 外发；force=true 的终态调用保证池收尾后的
  // 最终计数必然送达（中间事件被节流丢弃不损失信息，计数单调不减）。
  // currentTask 是最后被领取的传输任务（并发 worker 下为近似「正在进行」），
  // 供 UI 展示「正在上传 / 下载 …」。
  ctx.currentTask = null

  /**
   * 已建（或在建）远端父目录缓存：键为目录内相对父路径（'/' 分隔），值为该父目录
   * in-flight 或已完成的 mkdirDeep promise。必须是 Map 而非 Set：并发 worker 池下
   * 同一父目录的多个文件要串行等待**同一个** promise，才能保证「进入 PUT 前父目录
   * 必然建好」—— Set 只做同步占位，后来者在 MKCOL 尚未落地时即 PUT → 假 409 且
   * 无重试。失败条目由发起方驱逐（见 uploadOne 建目录段），一个 rejected promise
   * 不会卡死整个目录的后续文件。
   */
  ctx.createdDirs = new Map<string, Promise<void>>()
  /**
   * 传输任务表（单一事实源：任务元数据与执行闭包由同一对象承载，形态见
   * RoundTask）。单一对象数组：写前查重剔除任务即单点 splice，元数据与闭包的
   * 对齐由结构保证，不存在两处平行列表失步的可能。
   */
  ctx.tasks = []
  /**
   * B 档「扫描期远端不存在」的新上传 rel 集合（写前查重目标）。A 档新上传已有
   * If-None-Match:* 写时守卫、B 档覆盖上传已有 recheck，均不进此集合（省请求）。
   */
  ctx.bNewUploads = new Set<any>()
  /** 退避期内的持续失败文件：规划层不生成传输任务，轮末汇总一条 warning（元素 { rel, fr }） */
  ctx.permSkipped = []
  /** 瞬时失败任务队列：worker 池收尾后当轮再执行一次（保存 job 闭包；只重试一轮次） */
  ctx.transientFailed = []
  /**
   * 两段提交的上传暂存队列：PUT 已成功（含 POST-CHECK）但尚未提交基线的上传。
   * 元素 { rel, local: 上传后 stat, hash, intentId, origName?, conflict }；worker 池与瞬时失败
   * 当轮重试全部结束后，由下方「批量校验阶段」按父目录分组做 PROPFIND Depth 1 统一
   * 核对（远端存在 + size 一致）并提交基线 / done，不再逐文件一次校验。
   */
  ctx.pendingUploads = []
  ctx.aborted = false
  ctx.roundConflictChoice = null
  /**
   * 本轮经「冲突挂起延续」解决的冲突清单（元素 { rel, choice }）：
   * 即上一轮用户已选择但落地失败、本轮直接沿用策略而未再次询问的冲突；
   * 轮末汇总一条 warning，让用户感知「没再问我，按上次的选择办了」。
   */
  ctx.pendingResolved = []
  /**
   * 删除安全：规划期删除类动作只收集不执行，规划第二遍结束后统一
   * 过「删除安全闸」（用户确认标记 / 远端根重建保护 / 批量删除阈值）再入队；
   * 本轮成功落地删除的 rel 分别登记，供轮末空目录清理取祖先目录。
   */
  ctx.deletePlanItems = []
  ctx.localDeletedRels = new Set<any>()
  ctx.remoteDeletedRels = new Set<any>()
  // crashErr 声明在 roundBody 之外（锁后置后拿锁与传输都在 roundBody 内）：
  // 外层释放锁的 finally 需读取它决定是否跳过收尾






}
/** 阶段 6.1：规划第一遍（哈希预取并发 + 判定串行）→ verify 并发池 → 改名配对。 */
async function planRoundPassOne(ctx: RoundContext): Promise<void> {
  // ---- 规划第一遍（判定串行，哈希消歧预取并发）：变化判定 + 收集 verify 项 ----
  // verify（A 类远端消歧 / B 类双侧比对 / 无基线 adopt 的下载比对）是纯事实采集：
  // 先收集、再并发执行、最后按原顺序回填 —— decideAction 与各 adopt 分支的判定条件
  // 与旧串行版逐行等价，verify 只提供事实，不改变判定本身。
  ctx.verifyJobs = []
  ctx.verifyOutcome = new Map() // plan 条目 → 'done' | 'skipped'（skipped = 中止时未执行）
  // ---- 本地哈希消歧预取池：判定串行、读盘并发 ----
  // 判定循环逐条串行，hash 读盘若也逐条串行，mtime 风暴（批量 touch / FAT 2s 舍入）下
  // 规划期墙钟会被串行磁盘 IO 拖长（远端 verify 侧已有并发池）。此处把
  // 「需要 hash 消歧」的条目先并发预取（判据与 computeLocalChanged 内部逐条对齐：
  // 等长 + mtime 模糊或深度校验到期 + 基线有 lhash，外加本循环的 caseSkip 跳过），
  // 串行判定循环查表取值。不变量：判定顺序、touch 刷新写（setEntry 仍按 plan 序
  // 串行落）、verifyJobs 的 plan 序入队（verify 池中止跳过语义依赖该序）全部保持；
  // 预取值只影响「IO 从哪来」，不影响任何判定输入之外的状态。预取失败不进表 →
  // 串行回退现场重算，抛错语义不变。预取快照与扫描指纹同属轮内过时容差
  //（l.size / l.mtimeMs 本就是更早的扫描期事实），中途再改的文件由下一轮
  // size / mtime / lhash 消歧自纠，预取不引入新的竞态面。
  ctx.hashPrefetch = new Map<any, string>() // plan 条目 → 内容哈希（仅成功条目入表）
  {
    const pending: any[] = []
    for (const it of ctx.plan) {
      if (ctx.caseSkip.has(it.rel)) continue // 与判定循环同款跳过：大小写冲突不参与消歧（见 4.5）
      const { l, m } = it
      if (l && m && l.size === m.lsize && m.lhash != null && (ctx.deepVerifyDue || Math.abs((l.mtimeMs || 0) - (m.lmtimeMs || 0)) > ctx.localTol)) pending.push(it)
    }
    let hIdx = 0
    const hashWorker = async () => {
      while (hIdx < pending.length) {
        // 中止后不再领取：串行循环开头的 shouldAbort 检查会先行 break，
        // 未预取条目不会被消费（个别在途条目照常算完，结果闲置无害）
        if (ctx.shouldAbort()) return
        const it = pending[hIdx++]
        await maybeYield() // 读盘分片让出（与 verify 池同款，紧凑领取循环不饿调度器心跳）
        const h = await hashFile(it.l.abs).catch(() => null)
        if (h != null) ctx.hashPrefetch.set(it, h) // 失败留空：串行回退重算以复现旧抛错语义
      }
    }
    // 并发上限与 verify 池同款 min(4, concurrency)：规划期读盘不挤占传输带宽，
    // 机械盘 / 网络盘上的 4 路顺序流读已能吃满大部分吞吐
    if (pending.length) await Promise.all(Array.from({ length: Math.max(1, Math.min(4, Number(ctx.prefs.concurrency) || 4)) }, hashWorker))
  }
  for (const it of ctx.plan) {
    await maybeYield() // 规划第一遍分片让出（紧凑判定循环不饿调度器心跳）
    if (ctx.shouldAbort()) break // 仅停止继续判定；回填阶段的中止检查统一裁决（见第二遍）
    if (ctx.caseSkip.has(it.rel)) continue // 大小写冲突：不参与变化判定 / verify / adopt（见 4.5）
    const { l, r, m } = it
    const flags: any = {}
    it.flags = flags
    if (m) {
      // ---- 本地变化：size + 自适应 mtime 容差，模糊时 lhash 消歧 ----
      let lc: any = null // 消歧结果提升到 if (m) 层：B 类入队要复用其中的 hash（见下方 push）
      if (l) {
        lc = await computeLocalChanged(l, m, ctx.localTol, ctx.deepVerifyDue, ctx.hashPrefetch.get(it))
        flags.lChanged = lc.changed
        if (!lc.changed && m.lhash != null && Math.abs((l.mtimeMs || 0) - (m.lmtimeMs || 0)) > ctx.localTol) {
          // touch 型变化：内容未变 → 静默刷新基线 mtime，不传输
          await ctx.store.setEntry(it.rel, { ...m, lmtimeMs: l.mtimeMs }).catch(() => {})
          it.m = m
          m.lmtimeMs = l.mtimeMs
        }
      } else {
        flags.lChanged = false
      }
      // ---- 远端变化（etag 优先，size/mtime 兜底）----
      flags.rChanged = r ? remoteChangedVs(r, m) : false
      // A 类（本地未变、仅远端指纹变化且等长）与 B 类（双侧都变且等长）天然互斥：
      // 前者要求本地未变、后者要求本地已变，同一轮内不会同时成立，故每条目至多一个任务
      const aCandidate =
        l &&
        r &&
        flags.lChanged === false &&
        flags.rChanged &&
        r.size === m.rsize &&
        m.lhash != null &&
        r.size <= ctx.verifyMaxBytes &&
        (((r.etag || '') === '' && (m.retag || '') === '') || ctx.serverNoise.fingerprintUnstable)
      const bCandidate = l && r && flags.lChanged && flags.rChanged && l.size === r.size && l.size <= ctx.verifyMaxBytes
      // B 类携带 pass 1 消歧时已算出的本地哈希（lh0），verify 池免同一文件二次读盘。
      // 语义安全性：kind 'b' 是规划期「双侧当前内容是否已收敛」的事前比对（相同则
      // adopt、不传输），不是上传后核对 —— 上传后核对由传输阶段的批量校验
      //（pendingUploads 的 PROPFIND size 复核）承担，与此处无关。本地侧复用 pass 1
      // 快照与整轮口径一致（l.size / l.mtimeMs 本就是更早的扫描期事实），且 lh0 与
      // 「lChanged 判定」来自同一份内容快照，比 verify 时重读（可能与判定所依据的
      // 内容不一致）反而更自洽；池到比对窗口内再改的文件由下一轮消歧自纠。lh0 仅
      // 在 pass 1 走过哈希消歧（等长但 mtime 模糊 / 深度校验到期）时存在，其余
      // B 类（相对基线变长变短、基线无 lhash 等）pass 1 未读盘，verify 池照旧现场算。
      if (aCandidate || bCandidate)
        ctx.verifyJobs.push({ it, kind: aCandidate ? 'a' : 'b', ...(bCandidate && lc.hash != null ? { lh0: lc.hash } : {}) })
    } else if (l && r) {
      // ---- 无基线且两侧都在 → size/mtime 先判，需要 hash 收敛的入池 ----
      if (l.size !== r.size) flags.newBoth = 'conflict'
      else if (Math.abs((l.mtimeMs || 0) - (r.mtimeMs || 0)) <= ctx.localTol) flags.newBoth = 'adopt'
      else if (l.size <= ctx.verifyMaxBytes) ctx.verifyJobs.push({ it, kind: 'adopt' })
      else flags.overLimitNoBaseline = true // 提示在第二遍按原条目顺序发出（与串行版一致）
    }
  }

  // ---- verify 并发池（追加需求：规划期并发 + 进度外发 + shouldAbort 检查）----
  if (ctx.verifyJobs.length) {
    let verifyBytesTotal = 0
    for (const job of ctx.verifyJobs) verifyBytesTotal += job.it.r ? job.it.r.size : 0
    let verifyDone = 0
    let verifyBytes = 0
    let vIdx = 0
    const emitPlan = (force = false) =>
      ctx.onProgress(
        {
          phase: 'plan',
          filesDone: 0,
          filesTotal: ctx.plan.length,
          bytesDone: verifyBytes,
          bytesTotal: verifyBytesTotal,
          stage: 'verify',
          scanBytesTotal: ctx.scanBytesTotal,
          verifyDone,
          verifyTotal: ctx.verifyJobs.length,
        },
        force
      )
    emitPlan()
    const runVerifyJob = async (job: any) => {
      if (job.kind === 'a') {
        job.rh = await verifyRemoteHash(ctx.cfg, ctx.dir, job.it.rel, job.it.r)
      } else {
        // B 类任务与无基线 adopt 同构：先算本地 hash，成功才值得下载远端比对（与串行版顺序一致）；
        // B 类若带 pass 1 消歧产物 lh0（见第一遍入队处）则直接复用，本轮不再二次读盘 ——
        // adopt 无基线分支无 m 可消歧，pass 1 从未读盘，恒走现场计算
        job.lh = job.lh0 != null ? job.lh0 : await hashFile(job.it.l.abs).catch(() => null)
        job.rh = job.lh != null ? await verifyRemoteHash(ctx.cfg, ctx.dir, job.it.rel, job.it.r) : null
      }
    }
    const verifyWorker = async () => {
      while (vIdx < ctx.verifyJobs.length) {
        if (ctx.shouldAbort()) {
          // 未领取的任务全部记为 skipped：第二遍会在第一个被跳过的条目处中止，
          // 等价于串行版「在条目边界检查中止」的语义。取消同样即时打断
          // 已领取的在途 verify 下载（网络层销毁请求，verifyRemoteHash 捕获后按
          // 「无法完成」返回 null，临时文件在其 finally 清理）
          for (let k = vIdx; k < ctx.verifyJobs.length; k++) ctx.verifyOutcome.set(ctx.verifyJobs[k].it, 'skipped')
          vIdx = ctx.verifyJobs.length
          return
        }
        const job = ctx.verifyJobs[vIdx++]
        await maybeYield() // hash 队列分片让出（本地哈希 / 远端校验的紧凑领取循环）
        try {
          await runVerifyJob(job)
        } catch (_) {
          /* verify 异常按「无法完成」处理（runVerifyJob 内部已兜 null），回填同串行版 */
        }
        ctx.verifyOutcome.set(job.it, 'done')
        verifyDone++
        verifyBytes += job.it.r ? job.it.r.size : 0
        emitPlan()
      }
    }
    // 并发上限取 min(prefs.concurrency, 4)：verify 只是规划期的事实采集，
    // 不应挤占传输带宽，也不应让小服务器同时承受过多下载
    await Promise.all(Array.from({ length: Math.max(1, Math.min(4, Number(ctx.prefs.concurrency) || 4)) }, verifyWorker))
    emitPlan(true) // verify 池收尾：最终 verifyDone / 字节数必然送达（节流豁免）
  }

  // ---- 改名配对（规划两遍之间：依赖第一遍的 lChanged / rChanged 事实）----
  // 「旧路径消失 + 新路径出现 + 内容指纹一致」⇒ 判定改名：本地改名走云端 MOVE
  //（零重传），远端改名走本地跟随（零下载）。配对成员两侧都跳过常规决策
  //（delete-* / upload / download 均不再入队，整对由一条改名任务承担）—— 因此
  // 大批量改名不会触发批量删除闸（改名不是删除）。回落条件见 computeRenamePairs 头注释。
  ctx.renamePairs = await computeRenamePairs({
    plan: ctx.plan,
    store: ctx.store,
    caseSkip: ctx.caseSkip,
    mode: ctx.mode,
    oneshot: ctx.opHint != null,
    moveSupported: ctx.caps.moveSupported !== false,
    forceUploads: ctx.forceUploads,
    localTol: ctx.localTol,
  })
  /** 配对任一侧的 rel → 所属配对（规划第二遍据此跳过常规决策） */
  ctx.renamePairByRel = new Map<any, RenamePair>()
  for (const p of ctx.renamePairs) {
    ctx.renamePairByRel.set(p.oldRel, p)
    ctx.renamePairByRel.set(p.newRel, p)
  }
  if (ctx.renamePairs.length) {
    logNote(
      `改名检测：${ctx.renamePairs.length} 个文件按改名同步（云端 MOVE ${ctx.renamePairs.filter((p) => p.dir === 'local').length} 个、本地跟随 ${ctx.renamePairs.filter((p) => p.dir === 'remote').length} 个）`
    )
  }

}
/** 阶段 6.2：规划第二遍（串行回填）—— verify 结果 → 决策 → 传输任务入队。 */
async function planRoundPassTwo(ctx: RoundContext): Promise<void> {
  // ---- 规划第二遍（串行回填）：verify 结果 → 决策 → 生成传输任务 ----
  const jobOf = new Map(ctx.verifyJobs.map((j) => [j.it, j]))

  for (const it of ctx.plan) {
    await maybeYield() // 规划第二遍（决策回填）分片让出
    if (ctx.shouldAbort() || ctx.verifyOutcome.get(it) === 'skipped') {
      ctx.aborted = true
      break
    }
    // 改名配对成员：常规决策（delete-* / upload / download / 冲突）全部跳过 ——
    // 整对由下方改名任务承担；配对不成立的回落路径不会走到这里
    if (ctx.renamePairByRel.has(it.rel)) continue
    const { l, r, m } = it
    const flags = it.flags || {}
    const job = jobOf.get(it)
    let resolvedKeep = false
    // 大小写冲突（4.5）：不参与 A/B 类回填与无基线 adopt 收敛（收敛会写基线，
    // 让两个互为大小写变体的文件都「看起来已同步」，掩盖冲突）
    const caseHit = ctx.caseSkip.has(it.rel)

    if (!caseHit && m) {
      // ---- A 类回填：内容相同 → 静默采纳新远端指纹并累计指纹噪声 ----
      if (job && job.kind === 'a') {
        if (job.rh != null) {
          if (job.rh === m.lhash) {
            await ctx.store.setEntry(it.rel, { ...m, rsize: r.size, rmtimeMs: r.mtimeMs, retag: r.etag }).catch(() => {})
            m.rsize = r.size
            m.rmtimeMs = r.mtimeMs
            m.retag = r.etag
            flags.rChanged = false
            ctx.summary.adopted++
            // 噪声按 origin+username 粒度累计：同一服务器（同账号）下跨目录共享
            if (ctx.serverNoise.noteFingerprintNoise(it.rel)) {
              ctx.noiseDirty = true
              logNote('检测到服务器指纹不稳定（指纹变化但内容相同）：后续此类变化将直接做内容比对')
            }
          } else if (ctx.serverNoise.resetFingerprintNoise(it.rel)) {
            // 远端发生真实内容变化：移出噪声集合（返回 true = 确实移除，需要落盘）
            ctx.noiseDirty = true
          }
        } else {
          logNote(`无法完成远端内容校验 ${it.rel}：按「远端已变化」处理`)
        }
      }

      // ---- B 类回填：双侧都变且 size 相同 → 比较两侧当前内容，相同则 adopt（不算冲突）----
      if (l && r && flags.lChanged && flags.rChanged && l.size === r.size && l.size <= ctx.verifyMaxBytes) {
        const lh = job ? job.lh : null
        const rh = job ? job.rh : null
        if (lh != null && rh === lh) {
          await ctx.store.setEntry(it.rel, entryFrom(l, r, lh, { origName: r.origName })).catch(() => {})
          it.m = ctx.store.get(it.rel)
          flags.lChanged = false
          flags.rChanged = false
          ctx.summary.adopted++
          resolvedKeep = true
        }
      }
    } else if (!caseHit && l && r) {
      // ---- 无基线回填：两侧都在 → size/mtime/hash 收敛判定 ----
      let newBoth
      let adoptHash: any = null
      if (l.size !== r.size) {
        newBoth = 'conflict'
      } else if (Math.abs((l.mtimeMs || 0) - (r.mtimeMs || 0)) <= ctx.localTol) {
        newBoth = 'adopt'
      } else if (l.size <= ctx.verifyMaxBytes) {
        const lh = job ? job.lh : null
        const rh = job ? job.rh : null
        if (lh != null && rh === lh) {
          newBoth = 'adopt'
          adoptHash = lh
        } else {
          newBoth = 'conflict'
        }
      } else {
        ctx.pushWarning(`「${it.rel}」文件太大，无法自动对比两边是否一致，请你选择保留哪一个`)
        newBoth = 'conflict'
      }
      flags.newBoth = newBoth
      if (newBoth === 'adopt') {
        await ctx.store.setEntry(it.rel, entryFrom(l, r, adoptHash, { origName: r.origName })).catch(() => {})
        it.m = ctx.store.get(it.rel)
        ctx.summary.adopted++
        resolvedKeep = true
      }
    }

    // 半截强制重传：recoverIntents 判定「远端是本机上次中断上传的半截」
    // 的 rel 直接按 upload 规划 —— 远端变化是本机自己的残留而非对端修改，冲突语义不适用；
    // 档位守卫照常生效（A 档 If-Match 用本轮扫描 etag / B 档复查），GET 校验与 PUT 之间
    // 对端再改则按 412 / REMOTE_CHANGED 落回冲突。download 模式不强制（该模式下上传意图
    // 只可能来自历史冲突解决，交由正常冲突流程裁决）。
    // 大小写冲突文件不做强制重传（caseSkip 优先 —— 覆盖谁都是静默数据丢失）。
    // 一次性拉取（增量/全量）不强制（该方向不做任何上传）。
    const forcedUpload =
      ctx.forceUploads.has(it.rel) && !!l && ctx.opHint !== 'pull' && ctx.opHint !== 'pull-full' && ctx.mode !== 'download' && !ctx.caseSkip.has(it.rel)
    const act = forcedUpload ? 'upload' : resolvedKeep ? 'keep' : decideAction(it.rel, l, r, m, ctx.mode, { ...flags, oneshot: ctx.opHint }).act

    // 大小写冲突（4.5）：涉及的文件跳过一切传输 / 冲突 / 收敛动作；删除传播放行
    //（用户删除其一正是消除冲突的手段）；错误已在 4.5 逐组上报，此处静默跳过。
    if (ctx.caseSkip.has(it.rel) && (act === 'upload' || act === 'download' || act === 'conflict')) continue

    // 删除挂起标记失效清理：该 rel 不再规划为删除（状态已变化：文件重新出现 /
    // 被上传收敛 / 两侧皆无），确认与保留都失去对象 → 清除标记，面板不再滞留。
    // 覆盖包括 clean / skip / keep 在内的全部早退分支，故放在一切闸门之前。
    // 一次性单向轮（增量/全量）除外：op 轮的删除差异是否真的收敛要等常规轮
    // 确认（补齐档恢复 / 冻结，覆盖档的删除还要过删除安全闸），挂起原样保留
    // —— 清掉会让等确认的删除悄悄失效；恢复 / 删除落地路径自会消费挂起。
    {
      const dm = ctx.store.getPending(it.rel)
      if (dm && dm.kind === 'delete' && !ctx.opHint && act !== 'delete-local' && act !== 'delete-remote') ctx.store.clearPending(it.rel)
    }

    // 无基线保护兜底：基线不可信的轮次绝不执行删除
    if ((act === 'delete-local' || act === 'delete-remote') && !ctx.store.loadedOk) {
      ctx.pushWarning(`出于安全考虑，跳过了「${it.rel}」的删除`)
      continue
    }
    // 两侧均已不存在：丢弃基线条目（旧引擎靠整表重建天然丢弃，基线方案需显式删除）；
    // 该文件的持续失败退避记录一并清除（两侧皆无，无需再退避）
    if (act === 'clean') {
      await ctx.store.deleteEntry(it.rel).catch(() => {})
      ctx.store.clearFailure(it.rel)
      continue
    }
    if (act === 'skip' || act === 'keep') continue

    // C 档（只读）保护：跳过一切上传与删除（delete-local 也要跳过 —— 远端只读时
    // 删除本地等于丢数据）；需要上传的冲突解决一并跳过（choice='remote' 的纯下载场景
    // 在询问前无法预知，统一跳过最安全，下轮重新规划）。跳过仅计 warning，轮次不报错。
    if (ctx.caps.tier === 'C' && (act === 'upload' || act === 'delete-local' || act === 'delete-remote' || act === 'conflict')) {
      ctx.roSkipped++
      continue
    }

    // 持续失败退避：该文件在本机记录的永久失败尚未到重试时间 → 本轮不生成传输
    // 任务，计入 permSkipped（轮末汇总一条 warning）。只挡 upload / download / delete-*：
    // conflict 涉及用户决策（询问 / 挂起），照常走冲突流程不挡；本判定在无基线保护、
    // C 档跳过等既有闸门之后，优先级低于它们。
    if (act === 'upload' || act === 'download' || act === 'delete-local' || act === 'delete-remote') {
      const fr = ctx.store.getFailure(it.rel)
      if (fr && fr.retryAtMs > Date.now()) {
        ctx.permSkipped.push({ rel: it.rel, fr })
        continue
      }
    }

    // 删除类动作不入队 —— 收集后统一过删除安全闸（阈值 / 确认标记 / 根重建保护，
    // 见规划第二遍之后的「删除安全闸」块）；确认前的零删除约束在那里统一保证
    if (act === 'delete-local' || act === 'delete-remote') {
      ctx.deletePlanItems.push({ it, act })
      continue
    }

    if (act === 'upload') {
      ctx.pushUploadTransfer(it)
      continue
    }
    if (act === 'download') {
      ctx.pushTransfer(
        it.rel,
        () =>
          ctx.runOp(it, 'download', async (commitSet: any) => {
            // 字节计量器：下载落盘流逐块回调实时累加 bytesDone（大文件下载期间进度按
            // 真实大小推进）；完结补尾差
            const meter = ctx.byteMeter()
            const dl = await downloadOne(ctx.cfg, ctx.dir, it.rel, ctx.tmpDir, null, {
              expectedLocal: it.l || null,
              expectedRemoteSize: it.r.size,
              remoteMtimeMs: it.r.mtimeMs,
              origName: it.r.origName,
            }, ctx.localTol, { onBytes: meter.onBytes })
            await ctx.crashHook({ rel: it.rel, act: 'download' })
            await commitSet(entryFrom({ size: dl.size, mtimeMs: dl.mtimeMs }, it.r, dl.hash, { origName: it.r.origName }))
            ctx.summary.downloaded++
            // 同步记录：本地侧落地成功（扫描期本地没有该文件 = 本地新增）
            ctx.recordSyncOp({ op: 'download', rel: it.rel, bytes: it.r.size, added: !it.l })
            ctx.summary.bytesDown += it.r.size
            meter.finish(it.r.size)
          }),
        'download',
        it.r.size,
        { it }
      )
      continue
    }

    if (ctx.dryRun) {
      // 预演：冲突按生效策略预判落地形态（不询问用户）—— 上次已选未落地的沿用
      //（与真实轮 resolveChoiceInner 优先级 2 同口径）；固定策略直接展开；'ask'
      // 只计冲突（真实轮会弹窗等待选择）。展开口径与真实轮执行期一致：local 的
      // 上传（两段提交点计 uploaded / bytesUp）、remote 的下载（downloaded /
      // bytesDown，无独立明细条目）、both 的副本下载（downloaded 计数、无独立
      // 明细条目）+ 上传 —— 抽样对拍时与随后真实轮的计数逐项一致。
      const pc = ctx.store.getPending(it.rel)
      const prior = pc && !pc.kind && (pc.choice === 'local' || pc.choice === 'remote' || pc.choice === 'both') ? pc.choice : null
      const plannedChoice = prior || (ctx.prefs.conflictStrategy !== 'ask' ? ctx.prefs.conflictStrategy : 'ask')
      ctx.recordSyncOp({ op: 'conflict', rel: it.rel, ...(plannedChoice !== 'ask' ? { choice: plannedChoice } : {}) })
      ctx.summary.conflicts++
      if (plannedChoice === 'local' && it.l) ctx.recordPlannedOp('upload', it.rel, it.l.size, { it })
      else if (plannedChoice === 'remote' && it.r && !it.r.isDir) {
        ctx.summary.downloaded++
        ctx.summary.bytesDown += it.r.size
      } else if (plannedChoice === 'both' && it.l && it.r && !it.r.isDir) {
        ctx.summary.downloaded++
        ctx.recordPlannedOp('upload', it.rel, it.l.size, { it })
      }
      continue
    }
    // conflict：根据策略解决（ask 时回调渲染层弹窗，支持「应用到本轮剩余」）。
    // 未解决（ask 无回调 / 回调返回非法值 / 选择所需的侧缺失）→ 该文件报错，其余文件不受影响。
    // 冲突解决产生的上传（choice=local 与 both 的第二段上传）同样走两段提交：
    // PUT 后暂存、批量校验阶段提交；「同时保留」的冲突副本下载提交保持即时（下载路径不动）。
    // 冲突挂起：决策与沿用都在 resolveChoiceInner 内登记；落地动作带
    // conflict 标记，成功提交后清除挂起、失败保留（下一轮沿用，不再询问）。
    ctx.pushTransfer(
      it.rel,
      async () => {
        const choice = await ctx.resolveChoice(it)
        let uploadPending = false
        // defer = 本轮挂起跳过 —— 计入 deferredConflicts，不报错、
        // 不计 conflicts，其余文件照常。正常返回（非 UPLOADED_PENDING）视为该任务
        // 完结（conflict 本无失败退避记录，clearFailure 空转无害）
        if (choice === 'defer') {
          ctx.summary.deferredConflicts++
          return undefined
        }
        if (choice === 'local') {
          if (!it.l) throw new Error(`你选择了保留电脑版本，但电脑上的「${it.rel}」已经不在了`)
          const meter = ctx.byteMeter() // 上传读流逐块累加 bytesDone；完结补尾差
          uploadPending = await ctx.runUploadOp(it, r && r.origName, async (uh: any) => {
            const up = await uploadOne(ctx.cfg, ctx.dir, it.rel, it.l, ctx.createdDirs, ctx.uploadGuards(r), { onBeforePut: uh.onBeforePut, onBytes: meter.onBytes }, ctx.localTol)
            await ctx.crashHook({ rel: it.rel, act: 'conflict-local' })
            meter.finish(it.l.size)
            return up
          }, true)
        } else if (choice === 'remote') {
          if (!it.r || it.r.isDir) throw new Error(`你选择了保留云端版本，但云端的「${it.rel}」已经不在了`)
          const meter = ctx.byteMeter() // 下载落盘流逐块累加 bytesDone；完结补尾差
          await ctx.runOp(it, 'download', async (commitSet: any) => {
            const dl = await downloadOne(ctx.cfg, ctx.dir, it.rel, ctx.tmpDir, null, {
              expectedLocal: it.l || null,
              expectedRemoteSize: it.r.size,
              remoteMtimeMs: it.r.mtimeMs,
              origName: it.r.origName,
            }, ctx.localTol, { onBytes: meter.onBytes })
            await ctx.crashHook({ rel: it.rel, act: 'conflict-remote' })
            await commitSet(entryFrom({ size: dl.size, mtimeMs: dl.mtimeMs }, it.r, dl.hash, { origName: it.r.origName }))
            ctx.summary.downloaded++
            ctx.summary.bytesDown += it.r.size
            meter.finish(it.r.size)
          }, { conflict: true })
        } else {
          // 同时保留：云端版本另存为 <name>.conflict.<ext>，本地版本原样上传覆盖云端
          if (!it.l || !it.r) throw new Error(`你选择了两个都留，但「${it.rel}」有一侧已经不在了`)
          const segs = it.rel.split('/')
          const fileName = segs[segs.length - 1]
          const dot = fileName.lastIndexOf('.')
          const conflictName = dot > 0 ? `${fileName.slice(0, dot)}.conflict${fileName.slice(dot)}` : `${fileName}.conflict`
          const conflictRel = [...segs.slice(0, -1), conflictName].join('/')
          // 字节计量器：副本下载与覆盖上传共用一个（两侧流经字节都实时累加
          // bytesDone），完结在上传落地后按两侧之和补尾差
          const meter = ctx.byteMeter()
          // 冲突副本目标若在计划中存在（上一轮的副本），按其计划指纹做覆盖保护。
          // 副本先行落基线（verified 事实）：此处崩溃 → 原文件仍无基线、仍冲突，重选 both 幂等重做。
          const dl = await downloadOne(ctx.cfg, ctx.dir, it.rel, ctx.tmpDir, conflictRel, {
            expectedLocal: (ctx.planByRel.get(conflictRel) && ctx.planByRel.get(conflictRel).l) || null,
            expectedRemoteSize: it.r.size,
          }, ctx.localTol, { onBytes: meter.onBytes })
          const conflictAbs = path.join(ctx.dir.localPath, ...conflictRel.split('/'))
          const cst = await fsp.stat(conflictAbs)
          await ctx.store.setEntry(conflictRel, entryFrom(cst, it.r, dl.hash, { origName: conflictName, conflictCopy: true }))
          uploadPending = await ctx.runUploadOp(it, undefined, async (uh: any) => {
            const up = await uploadOne(ctx.cfg, ctx.dir, it.rel, it.l, ctx.createdDirs, ctx.uploadGuards(r), { onBeforePut: uh.onBeforePut, onBytes: meter.onBytes }, ctx.localTol)
            await ctx.crashHook({ rel: it.rel, act: 'conflict-both' })
            meter.finish(it.l.size + it.r.size)
            return up
          }, true)
          ctx.summary.downloaded++
        }
        // 同步记录：冲突已按选择落地（本地 / 云端 / 副本下载与覆盖上传的
        // 落地动作不再单记 —— 冲突条目本身即两侧改动的完整描述）
        ctx.recordSyncOp({ op: 'conflict', rel: it.rel, choice })
        ctx.summary.conflicts++
        return uploadPending ? UPLOADED_PENDING : undefined
      },
      'conflict',
      // 冲突的落地动作要到执行期（用户选择）才知道方向：按两侧之和估算传输分母
      (it.l ? it.l.size : 0) + (it.r ? it.r.size : 0),
      { it }
    )
  }

}
/** 阶段 6.3：删除安全闸（用户确认标记 / 范围决策 / 根重建保护 / 批量阈值）。 */
async function applyDeleteSafetyGate(ctx: RoundContext): Promise<void> {
  // ---- 删除安全闸（规划第二遍之后、按需拿锁 / B 档查重之前）----
  // 删除类动作统一在此过闸（规划期只收集）。逐项判定，先到先得：
  //   1. 挂起标记 kind='delete' 且 choice='delete'（用户逐文件显式确认，无 scope
  //      来源）→ 照常入队执行 —— 显式同意优先于一切保护（含远端根重建保护）；
  //   2. 删除范围决策（目录树上的批量选择）命中 → 照 choice 执行 / 消费 ——
  //      最具体（最长前缀）者胜，覆盖逐文件挂起表装不下的部分（「全部不删除 /
  //      全部确认删除」的落地通道）与同代盖章记录的细化决策；
  //   3. 挂起标记 choice='keep'（用户逐文件保留）或 scope 盖章记录 → 按方向消费
  //     （consumeKeepChoice）：delete-local 恢复上传（deleteRestored）、
  //      delete-remote 抑制（deleteKept）；恢复成功后情形消失，scope 自动剪枝；
  //   4. 挂起标记无 choice（待确认）→ 抑制 ——「确认前零删除」的绝对约束，
  //      与阈值无关：已挂起的条目永远等确认，不因后续轮次数量回落而放行；
  //   5. 无标记的新鲜删除：
  //      a. 远端根丢失「移除本地」决策执行中（meta.rootLostRemoval）→ delete-local
  //         视为用户已确认（根级决策覆盖批量阈值与重建保护），入队执行；本地有
  //         改动的文件不会到这里 —— 规划层已将其判为 upload（改动优先于删除）；
  //      b. 远端根重建保护生效中（meta.rootRebuilt）→ delete-local 改判为「恢复上传」
  //         并计入 deleteRootGuard（远端缺失是根消失伪象，复活取向重传远端），
  //         delete-remote 暂缓；上传与远端和解后自动恢复删除传播；
  //      c. 新鲜删除总数 > max(50, 基线条目数×20%) → 整批挂起：逐项登记
  //         kind='delete' 挂起记录（无 choice），计入 deleteHeld，本轮零删除，
  //         用户经待处理面板确认 / 保留后下一轮落地；同时构建 / 刷新批量删除
  //         快照（目录树，「全部 / 按目录」范围决策的完整事实源）；
  //      d. 其余 → 照常入队执行。
  // 已确认 / 用户选择保留的删除不计入阈值（阈值只度量「未经确认的批量删除」，
  // 否则已确认的整批会永远无法执行）。挂起登记失败（条目上限满）只影响
  //「下一轮是否需重新登记」，不影响零删除约束 —— 抑制由数量判定驱动。
  const deleteThreshold = Math.max(DELETE_BATCH_MIN, Math.ceil(ctx.store.entries.size * DELETE_BATCH_RATIO))
  // removalForced：本轮经 rootLostRemoval 标记放行的 delete-local 数。轮末解除判定
  // 的输入 —— 降为 0 的干净轮说明「移除本地」已和解（待移除文件要么已删除、
  // 要么因本地改动改走上传），标记可解除，恢复正常删除语义（含批量阈值保护）
  ctx.removalForced = 0
  const registerDeleteHold = (it: any) => {
    const ok = ctx.store.setPending(it.rel, {
      kind: 'delete',
      local: { size: it.l ? it.l.size : 0, mtimeMs: it.l ? it.l.mtimeMs : 0 },
      remote: { size: it.r ? it.r.size : 0, mtimeMs: it.r ? it.r.mtimeMs : 0, etag: it.r ? it.r.etag || '' : '' },
      createdAt: Date.now(),
    })
    if (!ok) logNote(`删除确认记录已满：${it.rel} 的挂起未持久化（本轮仍不删除，下一轮将重新登记）`)
  }
  const pushDeleteTransfer = (entry: any) => {
    const it = entry.it
    if (entry.act === 'delete-local') {
      ctx.pushTransfer(
        it.rel,
        () =>
          ctx.runOp(it, 'delete-local', async (_commitSet: any, commitDel: any) => {
            await deleteLocalOne(ctx.dir, it.rel, it.m && it.m.origName)
            await ctx.crashHook({ rel: it.rel, act: 'delete-local' })
            await commitDel()
            // 已确认删除落地 → 清除删除挂起标记（决策完成；冲突类挂起不经此路径）
            const pd = ctx.store.getPending(it.rel)
            if (pd && pd.kind === 'delete') ctx.store.clearPending(it.rel)
            ctx.summary.deleted++
            // 同步记录：电脑侧删除落地成功
            ctx.recordSyncOp({ op: 'delete-local', rel: it.rel })
            ctx.localDeletedRels.add(it.rel) // 空目录清理候选（本地侧祖先目录）
          }),
        'delete-local',
        0,
        { it }
      )
    } else {
      ctx.pushTransfer(
        it.rel,
        () =>
          ctx.runOp(it, 'delete-remote', async (_commitSet: any, commitDel: any) => {
            // 档位保护：A 档带 If-Match（扫描期强 etag）；B 档（或 etag 弱/缺失）
            // 先紧邻复查扫描期指纹，不符放弃该文件
            const dg = ctx.deleteGuards(it.r)
            if (dg.recheck) await recheckRemoteUnchanged(ctx.cfg, joinRemote(ctx.dir.remotePath, it.rel), dg.recheck, it.rel)
            const res = await davRequest(ctx.cfg, 'DELETE', joinRemote(ctx.dir.remotePath, it.rel), dg.ifMatch ? { headers: { 'If-Match': dg.ifMatch } } : {})
            // 404 视为成功：远端目标状态（文件不存在）已达成
            if (res.status === 412) {
              throw mkOpError(`「${it.rel}」未从云端删除：它刚被其他设备修改过`, 'PRECONDITION', {
                status: 412,
                permanent: true,
                detail: 'HTTP 412（If-Match 不匹配）',
              })
            }
            if (!(res.status === 200 || res.status === 204 || res.status === 404)) {
              // 附带 status 与分类 code：classifyOpFailure 据此判定永久 / 瞬时失败
              throw mkOpError(`无法从云端删除「${it.rel}」（HTTP ${res.status}）`, (res.classification && res.classification.code) || 'HTTP', {
                status: res.status,
              })
            }
            await ctx.crashHook({ rel: it.rel, act: 'delete-remote' })
            await commitDel()
            const pd = ctx.store.getPending(it.rel)
            if (pd && pd.kind === 'delete') ctx.store.clearPending(it.rel)
            ctx.summary.deleted++
            // 同步记录：云端侧删除落地成功
            ctx.recordSyncOp({ op: 'delete-remote', rel: it.rel })
            ctx.remoteDeletedRels.add(it.rel) // 空目录清理候选（远端侧祖先目录）
          }),
        'delete-remote',
        0,
        { it }
      )
    }
  }
  const freshDeletes: any[] = []
  ctx.deleteThresholdTripped = false
  /**
   * 「不删除」决策的消费（逐文件保留 / 范围决策 / 盖章记录共用），按方向落地：
   *   - delete-local（云端已缺、本地完好且未变 —— 规划真值表保证）：只抑制会把
   *     两端永久卡在分叉态（云端侧没有任何恢复通道，且每轮重复提示）。改判为
   *     「恢复上传」（复活取向，与无基线保护 / 根重建保护同语义）：本地文件原样
   *     保留，云端缺失的副本由本地上传恢复，两端重新一致。settlePendings 使基线
   *     提交成功后清除该文件的删除挂起（决策完成）；恢复失败（网络 / 412）挂起
   *     保留，下一轮继续按决策重试；恢复全部成功后 scope 零匹配自动剪枝。
   *   - delete-remote（本地已删、云端完好）：抑制 = 云端副本按用户意愿保留
   *    （本地删除是用户自己的动作，引擎不反向恢复），计入 deleteKept。
   */
  const consumeKeepChoice = (entry: any) => {
    if (entry.act === 'delete-local' && entry.it.l) {
      ctx.summary.deleteRestored++
      ctx.pushUploadTransfer(entry.it, true)
    } else {
      ctx.summary.deleteKept++
    }
  }
  // 本轮命中的删除范围决策前缀 → 命中文件数（轮末剪枝输入：零命中的 scope 视为
  // 情形已消失自动移除，避免陈旧 keep 永远压制未来的新删除事件）
  const scopeMatchCounts = new Map<string, number>()
  // 未决策删除候选（rel → 本地大小）：历史登记无 choice 的 + 本轮新鲜的 ——
  // 触发拦截时据此构建 / 刷新批量删除快照（UI 目录树与「全部」类决策的事实源）
  const undecidedMembers = new Map<string, number>()
  for (const entry of ctx.deletePlanItems) {
    const it = entry.it
    const pd = ctx.store.getPending(it.rel)
    // 1. 用户逐文件显式选择（setPendingChoice，无 scope 来源标记）：最优先，
    //    范围决策不得翻案 ——「全部」只作用于当前树里未决策的部分
    if (pd && pd.kind === 'delete' && pd.choice && pd.scope == null) {
      if (pd.choice === 'delete') pushDeleteTransfer(entry)
      else consumeKeepChoice(entry)
      continue
    }
    // 2. 删除范围决策（目录树上的批量选择）：按前缀匹配，最具体者胜。覆盖逐文件
    //    挂起表装不下的候选（「全部不删除 / 全部确认删除」的落地通道）；同代盖章
    //    记录的细化决策（文件级 scope 压过子树 scope）也在此消费
    const scope = ctx.store.matchDeleteScope(it.rel)
    if (scope) {
      scopeMatchCounts.set(scope.prefix, (scopeMatchCounts.get(scope.prefix) || 0) + 1)
      if (scope.choice === 'delete') {
        pushDeleteTransfer(entry)
      } else {
        consumeKeepChoice(entry)
      }
      undecidedMembers.delete(it.rel)
      continue
    }
    if (pd && pd.kind === 'delete' && pd.choice) {
      // 3. 范围决策盖章的记录（scope 已剪枝 / 代际更迭后由盖章兜底）：按盖章选择
      //    消费 —— 与逐文件确认同语义（删除执行成功后清除；失败保留重试）
      if (pd.choice === 'delete') pushDeleteTransfer(entry)
      else consumeKeepChoice(entry)
      continue
    }
    if (pd && pd.kind === 'delete') {
      // 4. 待确认：标记已存在，抑制（不重复登记）。「确认前零删除」绝对约束：
      //    与阈值无关，已挂起的条目永远等确认，不因数量回落放行
      ctx.summary.deleteHeld++
      undecidedMembers.set(it.rel, pd.local ? pd.local.size : 0)
      continue
    }
    if (ctx.store.meta.rootLostRemoval && entry.act === 'delete-local') {
      // 根丢失「移除本地」决策执行中：用户已在根级确认移除，delete-local 等同
      // 已确认删除（先于根重建保护与批量阈值判定）
      ctx.removalForced++
      pushDeleteTransfer(entry)
      continue
    }
    if (ctx.store.meta.rootRebuilt) {
      // 远端根重建保护：远端缺失是根消失的伪象而非逐文件删除。
      // delete-local 改判为「恢复上传」（复活取向，与无基线保护语义一致 ——
      // 宁可重传也不把「远端整树消失」解释成删除），上传全部成功后下一轮
      // 自动恢复删除传播；delete-remote（重建窗口内本地删除）暂缓至保护解除。
      // 用户显式确认过的删除在上方已放行，不受保护拦截。
      ctx.summary.deleteRootGuard++
      if (entry.act === 'delete-local' && it.l) ctx.pushUploadTransfer(it)
      continue
    }
    freshDeletes.push(entry)
  }
  if (freshDeletes.length > deleteThreshold) {
    for (const entry of freshDeletes) {
      registerDeleteHold(entry.it)
      ctx.summary.deleteHeld++
      undecidedMembers.set(entry.it.rel, entry.it.l ? entry.it.l.size : 0)
    }
    ctx.deleteThresholdTripped = true
    ctx.pushWarning(
      `这次要删除的文件有 ${freshDeletes.length} 个，数量偏多，为防止误删，没有删除任何文件。请在「待处理」里确认，确认后下次同步才会执行`
    )
    // 构建 / 刷新批量删除快照：含历史登记未决策的 + 本轮新鲜的（含登记超上限
    // 未持久化的部分 —— 它们没有逐文件记录，快照是它们对用户可见的唯一通道）
    ctx.store.setDeleteBatch(buildDeleteBatch(undecidedMembers, Date.now()))
  } else {
    for (const entry of freshDeletes) pushDeleteTransfer(entry)
  }
  // 范围决策剪枝 + 快照清理（仅扫描完整轮：扫描不完整时「零匹配 / 无未决策」
  // 不可信 —— 残缺的远端列表会把「还没看到」误判成「情形已消失」）。剪枝：
  // 零匹配的 scope 视为情形已消失自动移除。快照清除：本轮未触发拦截且已无
  // 未决策候选（scope 消费 / 逐文件确认 / 逐文件选择覆盖完毕）—— UI 树随之消失。
  if (ctx.remoteScan.complete) {
    const pruned = ctx.store.pruneDeleteScopes(new Set(scopeMatchCounts.keys()))
    if (pruned > 0) logNote(`${pruned} 条删除范围决策覆盖的删除已不存在（文件恢复 / 处理完毕），已自动清除`)
    if (!ctx.deleteThresholdTripped && undecidedMembers.size === 0) ctx.store.clearDeleteBatch()
  }

}
/** 阶段 6.4：改名任务入队（删除安全闸之后）。 */
async function enqueueRenameTasks(ctx: RoundContext): Promise<void> {
  // ---- 改名任务入队（删除安全闸之后：配对成员从未进入 deletePlanItems，闸门与改名无交集）----
  /**
   * 本地改名 → 云端 MOVE（零重传）。守卫与删除同款（A 档源 If-Match / B 档复查），
   * 另带 Overwrite:F —— 目标路径若在他机新出现即 412 拒绝，绝不覆盖；源已 404 时
   * 核对目标确实存在且尺寸一致才按成功收尾（重试撞上「已移动」的幂等收口）。
   * MOVE 成功后取目标新指纹（etag / mtime 可能因 MOVE 变化）写基线，旧条目随迁删除。
   * 405/501 = 服务器不支持 MOVE：持久降级能力缓存，本轮按错误跳过 —— 下一轮自然
   * 回落「删除 + 重新上传」的既有语义（配对被 moveSupported=false 挡住）。
   */
  const pushRenameRemoteTransfer = (pair: RenamePair) => {
    const oldIt = ctx.planByRel.get(pair.oldRel)
    const newIt = ctx.planByRel.get(pair.newRel)
    if (!oldIt || !newIt) return
    ctx.pushTransfer(
      pair.newRel,
      () =>
        ctx.runOp(newIt, 'move-remote', async (commitSet: any) => {
          // 与上传同口径的 Windows 文件名预检：改名会把新名送上服务器，非法名从源头挡
          const badName = checkWindowsRel(pair.newRel, ctx.dir && ctx.dir.localPath)
          if (badName) throw badFilenameError(pair.newRel, badName)
          const srcRemote = joinRemote(ctx.dir.remotePath, pair.oldRel)
          const headers: Record<string, any> = {
            Destination: remoteUrl(ctx.cfg, joinRemote(ctx.dir.remotePath, pair.newRel)),
            Overwrite: 'F',
          }
          const dg = ctx.deleteGuards(oldIt.r)
          if (dg.recheck) await recheckRemoteUnchanged(ctx.cfg, srcRemote, dg.recheck, pair.oldRel)
          if (dg.ifMatch) headers['If-Match'] = dg.ifMatch
          const res = await davRequest(ctx.cfg, 'MOVE', srcRemote, { headers })
          if (res.status === 412) {
            throw mkOpError(remoteChangedMsg(pair.newRel, '暂未改名', false), 'PRECONDITION', {
              status: 412,
              permanent: true,
              detail: 'HTTP 412（MOVE Overwrite:F 拒绝或 If-Match 不匹配）',
            })
          }
          if (res.status === 405 || res.status === 501) {
            await persistMoveUnsupported(ctx.cfg)
            // status 置 0（而非 405）：405 会进 classifyOpFailure 的 permanent 表 →
            // 记失败退避，下一轮新路径的上传也被退避跳过，回落删传被无故拖慢。
            // 这里的语义是「下轮改走删传」，不是「这个文件持续失败」。
            throw mkOpError(`「${pair.newRel}」未能按改名同步（这个服务器不支持改名操作），下次同步会改为删除后重新上传`, 'MOVE_UNSUPPORTED', {
              permanent: true,
              detail: `MOVE HTTP ${res.status}`,
            })
          }
          // 404 = 源已不在：可能是上一次 MOVE 实际成功但响应丢失（重试场景）——
          // 核对目标存在且尺寸一致即按成功收尾，否则按失败交下一轮重新规划
          const movedOk = res.status === 201 || res.status === 204 || res.status === 200
          if (!movedOk && res.status !== 404) {
            // 附带 status 与分类 code：classifyOpFailure 据此判定永久 / 瞬时失败
            throw mkOpError(`「${pair.newRel}」改名同步失败（HTTP ${res.status}），下次同步会重试`, (res.classification && res.classification.code) || 'HTTP', {
              status: res.status,
            })
          }
          await ctx.crashHook({ rel: pair.newRel, act: 'move-remote' })
          // 目标新指纹（etag / mtime 可能因 MOVE 改变）：与上传的批量校验同目的 ——
          // 基线指纹必须对应远端实际状态；核对失败不写基线（下一轮 newBoth 采纳自愈）
          const props = await remotePropsEx(ctx.cfg, joinRemote(ctx.dir.remotePath, pair.newRel))
          if (!props || props.gone || props.error || !props.props || props.props.size !== oldIt.r.size) {
            throw new Error(`「${pair.newRel}」已在云端改名，但核对云端状态失败，下次同步会自动核对`)
          }
          const rp = props.props
          await commitSet(entryFrom(newIt.l, { size: rp.size, mtimeMs: rp.mtime, etag: rp.etag }, pair.m.lhash ?? null, { origName: pair.newRel.split('/').pop() }))
          await ctx.store.deleteEntry(pair.oldRel).catch(() => {})
          ctx.store.clearFailure(pair.oldRel)
          // 空目录清理对齐：旧语义（delete-remote + upload）会把旧路径计入远端删除
          // 集合、轮末清理因此变空的父目录 —— MOVE 同样让旧父目录变空，登记保持行为一致
          ctx.remoteDeletedRels.add(pair.oldRel)
          ctx.summary.renamedRemote++
          ctx.recordSyncOp({ op: 'rename-remote', rel: pair.newRel, from: pair.oldRel })
        }),
      'rename-remote',
      0,
      { from: pair.oldRel }
    )
  }
  /**
   * 远端改名 → 本地跟随（零下载）。远端已是目标状态，本机只需把旧文件原地改名：
   * 执行前复核旧文件仍是扫描时状态、新路径仍不存在（计划外内容绝不覆盖），
   * rename 保留 mtime（与新基线的远端指纹天然对齐）。
   */
  const pushRenameLocalTransfer = (pair: RenamePair) => {
    const oldIt = ctx.planByRel.get(pair.oldRel)
    const newIt = ctx.planByRel.get(pair.newRel)
    if (!oldIt || !newIt) return
    ctx.pushTransfer(
      pair.newRel,
      () =>
        ctx.runOp(newIt, 'move-local', async (commitSet: any) => {
          if (process.platform === 'win32') {
            const badName = checkWindowsRel(pair.newRel, ctx.dir && ctx.dir.localPath)
            if (badName) throw badFilenameError(pair.newRel, badName)
          }
          const oldSegs = pair.oldRel.split('/')
          if (oldIt.m && oldIt.m.origName) oldSegs[oldSegs.length - 1] = oldIt.m.origName
          const oldAbs = path.join(ctx.dir.localPath, ...oldSegs)
          const newAbs = path.join(ctx.dir.localPath, ...pair.newRel.split('/'))
          // 双侧复核：旧文件仍是扫描时状态（否则改名会吃掉用户的修改）、
          // 新路径仍不存在（计划外出现的内容绝不覆盖）。容差用规划层 localTol
          //（与 localFpTolMs 同源，防 FAT 盘操作级误报「刚被改动」）
          const st = await statOrNull(oldAbs)
          if (!st || st.size !== oldIt.l.size || Math.abs(st.mtimeMs - oldIt.l.mtimeMs) > ctx.localTol) {
            throw new Error(`「${pair.oldRel}」刚被改动，本次先不同步改名，下次同步会重新判断`)
          }
          if (await statOrNull(newAbs)) {
            throw new Error(`「${pair.newRel}」已出现在电脑上，本次先不同步改名，下次同步会重新判断`)
          }
          await fsp.mkdir(path.dirname(newAbs), { recursive: true })
          await fsp.rename(oldAbs, newAbs)
          await ctx.crashHook({ rel: pair.newRel, act: 'move-local' })
          // rename 落盘后 fsync 目标目录（POSIX）—— 与下载落地同规格
          await storage.fsyncDirIfPossible(path.dirname(newAbs))
          const ns = await fsp.stat(newAbs)
          await commitSet(entryFrom(ns, newIt.r, pair.m.lhash ?? null, { origName: newIt.r.origName }))
          await ctx.store.deleteEntry(pair.oldRel).catch(() => {})
          ctx.store.clearFailure(pair.oldRel)
          // 空目录清理对齐（本地侧，与远端方向同理）：旧语义的 delete-local 会让
          // 旧父目录参与轮末清理，本地改名同样让它变空
          ctx.localDeletedRels.add(pair.oldRel)
          ctx.summary.renamedLocal++
          ctx.recordSyncOp({ op: 'rename-local', rel: pair.newRel, from: pair.oldRel })
        }),
      'rename-local',
      0,
      { from: pair.oldRel }
    )
  }
  for (const p of ctx.renamePairs) {
    if (p.dir === 'local') pushRenameRemoteTransfer(p)
    else pushRenameLocalTransfer(p)
  }

}
/** 传输前预检：云端配额（RFC 4331）与本地磁盘空间，不足时整轮中止。 */
async function preflightRoundLimits(ctx: RoundContext): Promise<void> {
  // ---- 传输前预检（云端配额 / 本地磁盘空间）----
  // 位置：规划完成（计划字节量已知）、按需拿锁与执行之前 —— 不足时轮首报一条
  // 明确错误整轮中止（预演轮同样预检，预演结果如实反映「真实轮会停在这里」），
  // 而不是逐文件 507 / 下载中途 ENOSPC。
  //   云端配额：取自轮首根探测的 RFC 4331 属性（零额外请求）。服务器未返回、
  //   返回 0 / 负数（部分服务器把 0 当「无限制」误报）一律静默跳过 —— 预检只
  //   提前给出结论，不改变无配额服务器的既有行为；上传字节量按 upload +
  //   conflict 估算（conflict 的落地方向执行期才知，保守计入）。远端根缺失的
  //   首轮同步拿不到配额属性（集合尚不存在），本轮跳过预检、下一轮起生效。
  //   本地磁盘：statfs 空闲空间对比计划下载量（download + conflict 估算），
  //   低于「计划量 + 安全余量」即中止；statfs 不可用（旧内核 / 权限）跳过预检。
  if (!ctx.aborted && !ctx.shouldAbort()) {
    const plannedUp = ctx.tasks.reduce((a, t) => a + (t.kind === 'upload' || t.kind === 'conflict' ? t.bytes || 0 : 0), 0)
    if (ctx.quotaAvailable != null && ctx.quotaAvailable > 0 && plannedUp > ctx.quotaAvailable) {
      throw syncFail(`云端空间不够：这次要上传约 ${humanBytes(plannedUp)}，云端只剩约 ${humanBytes(ctx.quotaAvailable)}。请清理云端空间后重试`, {
        phase: 'plan',
        failureClass: 'other',
        summary: ctx.summary,
      })
    }
    const plannedDown = ctx.tasks.reduce((a, t) => a + (t.kind === 'download' || t.kind === 'conflict' ? t.bytes || 0 : 0), 0)
    if (plannedDown > 0 && typeof fsp.statfs === 'function') {
      try {
        const s = await fsp.statfs(ctx.dir.localPath)
        const free = Number(s.bavail) * Number(s.bsize)
        if (Number.isFinite(free) && free - plannedDown < LOCAL_DISK_MARGIN_BYTES) {
          throw syncFail(
            `电脑磁盘空间不够：这次要下载约 ${humanBytes(plannedDown)}，这个文件夹所在的磁盘只剩约 ${humanBytes(Math.max(0, free))}。请清理磁盘空间后重试`,
            { phase: 'plan', failureClass: 'other', summary: ctx.summary }
          )
        }
      } catch (e: any) {
        if (e && e.phase === 'plan') throw e // 预检自身给出的结论原样上抛
        /* statfs 失败（权限 / 文件系统不支持）：跳过本地预检，不阻断同步 */
      }
    }
  }

  // ---- 规划完成后、worker 执行前的两道闸（按需租约锁 → B 档新上传写前查重）----


}
/** 阶段 7a：按需获取目录级租约锁（锁后置 + 按需）+ 续租定时器。让出时置 ctx.roundYielded。 */
async function acquireRoundLock(ctx: RoundContext): Promise<void> {
  // 按需拿锁（锁后置 + 按需）：仅当本轮计划含「远端写」操作 —— upload
  //（新上传 / 覆盖，含冲突决策产生的覆盖上传）、delete-remote、或可能落地为上传的
  // conflict（choice 要到执行期才知道，保守按远端写计）—— 才尝试获取租约锁；纯空轮 /
  // 纯下载轮完全不发锁请求（省 4 个请求 + 1.5s 写回静置）。delete-local 与 download
  // 不触碰远端不算；远端 MKCOL 只伴随上传发生（父目录补齐），无需单列 —— 同步根建
  // 目录在轮首（锁后置前后都在锁外）。prefs.leaseLock === false 时整体关闭（写轮也
  // 不拿锁，语义不变）；C 档轮次因规划层已剔除全部远端写，天然不再进入。
  // 规划期已取消（aborted）的轮次不再拿锁 —— 取消应尽快收场，不为一把
  // 马上要释放的锁发出 GET/PUT/回读共 4 个请求与 1.5s 写回静置。
  // 预演轮不拿锁（锁文件本身是远端写，零副作用约束）。
  const hasRemoteWrite = ctx.tasks.some((t) => t.kind === 'upload' || t.kind === 'delete-remote' || t.kind === 'conflict' || t.kind === 'rename-remote')
  if (hasRemoteWrite && !ctx.dryRun && !ctx.aborted && !ctx.shouldAbort() && ctx.prefs.leaseLock !== false) {
    // 锁阶段进度（含 GET → PUT → 1.5s 写回静置 → 回读确认的完整窗口）：
    // UI 显示「正在确认租约锁…」。force 外发 —— 与 verify 终态事件同相位，不吃节流
    ctx.onProgress({ phase: 'plan', filesDone: 0, filesTotal: ctx.plan.length, bytesDone: 0, bytesTotal: 0, stage: 'lock', scanBytesTotal: ctx.scanBytesTotal }, true)
    const deviceId = await storage.getDeviceId()
    const acq = await acquireLeaseLock(ctx.cfg, ctx.lockPath, deviceId)
    if (acq.warn) logNote(acq.warn)
    if (acq.outcome === 'yield') {
      // 让出：本轮不做任何传输（含已规划的下载），按零计数成功返回 —— 这不是错误，
      // 调度层的下一轮自然重试；对端轮次结束后锁被释放或按 TTL 过期。totalFiles 归零
      // 维持「让出 = 零传输」的既有契约；planned 为信息性
      // 字段：本轮规划了 N 项传输因让出未执行（渲染层不依赖，仅供观测 / 测试断言）。
      ctx.summary.yielded = true
      ctx.summary.totalFiles = 0
      ctx.summary.planned = ctx.tasks.length
      ctx.pushWarning('另一台设备正在同步这个文件夹，本次先等一等')
      await ctx.persistPlannedLocalState()
      ctx.finalizeSummaryMeta() // 让出轮同样补齐机器可读字段（openIntents 对 follow-up 有意义）
      ctx.roundYielded = true // 让出：roundBody 检查该标记后按零计数成功返回
      return
    }
    if (acq.outcome === 'acquired') {
      ctx.lockHeld = true
      // 续租定时器：每 LOCK_RENEW_MS 重写锁内容（startedAt 保持首次值；重写即刷新
      // mtime，服务器时钟年龄随之归零）。续租走无熔断 cfg + noRetry：它是尽力而为的
      // 保活，失败只记一条 warning、绝不计入整轮熔断（不中断轮次）。同样
      // 豁免取消检查：取消解算期（worker 收尾 → 释放 finally）恰好撞上续租滴答时，
      // 让这次轻量保活照常完成远好于报一条「续租失败」噪声（释放 finally 紧随其后）。
      // unref 防止定时器阻止进程退出；正常轮末由释放 finally 清理，崩溃注入路径由
      // cleanup() 全局清扫。
      let renewWarned = false
      const renewBody = JSON.stringify({ v: 1, deviceId, startedAt: acq.startedAt, ttlMs: LOCK_TTL_MS })
      const renewOnce = () =>
        davRequest({ ...ctx.cfg, __wdsyncBreaker: null, __wdsyncAbort: null }, 'PUT', ctx.lockPath, { headers: { 'Content-Type': 'application/json' }, body: renewBody, noRetry: true }).then(
          (r) => {
            if (r.status >= 400 && !renewWarned) {
              renewWarned = true
              logNote(`租约锁续租失败（HTTP ${r.status}）：锁可能提前过期，他机的让出保护将随之减弱`)
            }
          },
          (e) => {
            if (!renewWarned) {
              renewWarned = true
              logNote(`租约锁续租失败（${(e && e.message) || e}）：锁可能提前过期，他机的让出保护将随之减弱`)
            }
          }
        )
      ctx.renewTimer = nodeTimers.setInterval(renewOnce, LOCK_RENEW_MS)
      if (typeof ctx.renewTimer.unref === 'function') ctx.renewTimer.unref()
      RENEW_TIMERS.add(ctx.renewTimer)
    }
    // outcome === 'skip'：无法写锁（403/401/网络失败等）→ 不持锁继续同步，
    // 仅依赖档位保护 + 下方 B 档写前查重
  }

}
/** 阶段 7b：B 档新上传写前查重（缓解覆盖洞；按父目录 PROPFIND Depth 1）。 */
async function applyBDedupeGate(ctx: RoundContext): Promise<void> {
  // ---- B 档新上传写前查重（缓解覆盖洞）----
  // B 档（无条件请求能力）的「扫描期远端不存在」新上传是唯一写前零守卫的远端写路径：
  // 对端在「扫描 → 写入」窗口内新建同名文件会被静默覆盖（丢更新）。此处按父目录分组
  // 做一次 PROPFIND Depth 1 快查（复用批量校验阶段的请求形态与解析口径），名字已出现
  // 在远端者从执行队列剔除，按既有 REMOTE_CHANGED 类后果处理（本轮报错、不覆盖、下轮
  // 重新规划为冲突 / adopt；不进永久失败退避表）。查重不依赖锁的结果（acquired / skip /
  // 开关关闭都照做 —— 无锁时它反而是唯一保护）；查重请求失败（网络 / 非 207 / 解析
  // 失败）时该组文件按瞬时失败语义跳过本轮上传（同样绝不盲目裸 PUT、不进退避表，下轮
  // 自然重试）。放在拿锁之后：静置 1.5s 的观察窗更贴近写入时刻，且让出轮（无任何写入）
  // 天然不触发查重。规划期已取消的轮次跳过查重（worker 池随即按取消收场，
  // 不再为已取消的传输发守护请求；取消引发的请求失败也不报噪声错误）。
  // 预演轮无执行、无写入，查重无意义，跳过。
  if (ctx.bNewUploads.size > 0 && !ctx.dryRun && !ctx.shouldAbort()) {
    /** 从执行队列按 rel 剔除一个任务（单点 splice：元数据与执行闭包同对象，对齐由结构保证；字节分母同步扣减） */
    const dropTransferByRel = (rel: any) => {
      const i = ctx.tasks.findIndex((t) => t.rel === rel)
      if (i < 0) return false
      ctx.transferBytesTotal -= ctx.tasks[i].bytes || 0
      ctx.tasks.splice(i, 1)
      return true
    }
    // 按父目录分组（rel 无 '/' → 同步根；否则取 dirname）：每组一次 PROPFIND Depth 1
    const byParent = new Map()
    for (const rel of ctx.bNewUploads) {
      const i = rel.lastIndexOf('/')
      const parent = i < 0 ? '' : rel.slice(0, i)
      if (!byParent.has(parent)) byParent.set(parent, [])
      byParent.get(parent).push(rel)
    }
    for (const [parent, rels] of byParent) {
      // 请求形态与解析口径统一在 propfindChildMap（与批量校验阶段共用同一实现）
      const dirRemote = parent ? joinRemote(ctx.dir.remotePath, parent) : ctx.dir.remotePath
      const probe = await propfindChildMap(ctx.cfg, dirRemote)
      if ('notFound' in probe) {
        // 404 = 远端父目录本身不存在 ⇒ 组内文件在远端必然无同名（比空列举更强的
        // 「无冲突」证据）—— 放行整组照常上传（首轮 PUT 前 MKCOL 建目录）。
        // 未特判时该组每轮被「查重失败」跳过且 MKCOL 永不发生，形成永不收敛的
        // 死循环（B 档 + 本地新建子目录场景）。
        continue
      }
      if ('err' in probe) {
        // 组级失败（网络异常 / 非 207 / 解析失败）：该组新上传全部跳过本轮 —— 无法确认
        // 「远端没有同名文件」时按可能已存在处理是唯一安全方向，绝不盲目裸 PUT。
        // 只报错不记退避（瞬时失败语义：下轮重试自然恢复）。网络类标记：列举失败
        // 的主因是网络 / 5xx，解析失败也随列举通道归入 network（调度层退避口径）
        for (const rel of rels) {
          dropTransferByRel(rel)
          ctx.pushError(remoteUnverifiableMsg(rel), true)
        }
        continue
      }
      for (const rel of rels) {
        await maybeYield() // 写前查重回填分片让出
        // 子条目 key 相对父目录集合；rel 是相对同步根的完整路径，剥离父前缀后比对
        const key = nfc(parent ? rel.slice(parent.length + 1) : rel)
        const item = probe.childMap.get(key)
        if (item && !item.isDir) {
          dropTransferByRel(rel)
          // etag 跳过运行时防线（见 noteEtagSkipAnomaly）：写前查重发现远端出现了
          // 扫描期不存在的同名文件 —— 被跳过子树内即「远端实际状态 ≠ 合成（基线）状态」
          ctx.noteEtagSkipAnomaly(rel, '写前查重发现远端新文件')
          ctx.pushError(remoteChangedMsg(rel, '暂未上传', true), false)
        }
      }
    }
  }

}
/** 阶段 7：并发池执行 + 瞬时失败当轮重试。 */
async function runTransferPool(ctx: RoundContext): Promise<void> {
  // 7. 并发池执行
  // 传输开始事件（force 外发）：锁 / 查重闸门已过，UI 由此切入「正在同步文件」段，
  // 并拿到传输字节分母（此前阶段 bytesDone / bytesTotal 承载的是 verify 字节估算）
  ctx.onProgress(
    { phase: 'transfer', filesDone: 0, filesTotal: ctx.plan.length, bytesDone: 0, bytesTotal: ctx.transferBytesTotal, stage: 'transfer', scanBytesTotal: ctx.scanBytesTotal },
    true
  )
  const conc = Math.max(1, Math.min(8, Number(ctx.prefs.concurrency) || 4))
  let idx = 0
  async function worker() {
    while (idx < ctx.tasks.length) {
      // 熔断 open 后停止领取新任务（已在执行的传输会以 CIRCUIT_OPEN 快速失败收尾）；
      // 取消同理 —— 网络层轮询 shouldAbort 后即时销毁在途请求（含大文件
      // 传输），ABORTED 错误经 handleTransferError 按「已取消」处理，不计失败
      if (ctx.shouldAbort() || ctx.roundBreaker.open) {
        ctx.aborted = true
        return
      }
      const i = idx++
      const t = ctx.tasks[i]
      // 预演轮登记的计划任务无执行闭包：仅充当预检 / 进度分母，不执行、不领取报告、
      // 不计数（与旧形态 dry-run 下 transfers 为空的进度输出完全一致）
      if (!t.run) continue
      // 领取即报告当前任务（节流下可能被合并，取最后领取者即可）：UI 显示「正在上传 / 下载 …」
      ctx.currentTask = { op: t.kind, rel: t.rel }
      ctx.tick()
      try {
        await t.run()
      } catch (e: any) {
        // 失败分类接线：permanent 记退避表、transient 收集待当轮重试、其余照常报错
        ctx.handleTransferError(e, t.run, false)
      }
      ctx.filesDone++
      ctx.tick()
    }
  }
  await Promise.all(Array.from({ length: conc }, worker))
  ctx.tick(true) // worker 池收尾：最终 filesDone / bytesDone 必然送达（节流豁免）
  // 后置收尾段（force 外发）：瞬时重试 / 批量校验提交 / 基线落盘 / 空目录清理 ——
  // UI 的整条进度按「传输 80% + 后置 10%」折算，此事件标记进入最后 10% 段
  ctx.onProgress(
    { phase: 'transfer', filesDone: ctx.filesDone, filesTotal: ctx.plan.length, bytesDone: ctx.bytesDoneAcc, bytesTotal: ctx.transferBytesTotal, stage: 'finalize', scanBytesTotal: ctx.scanBytesTotal },
    true
  )
  if (ctx.shouldAbort()) ctx.aborted = true

  // 瞬时失败当轮重试：worker 池全部结束后，对本轮收集的瞬时失败任务串行再执行
  // 一次（EBUSY 占用解除、瞬时 423 锁释放等场景）。只重试一轮次、不无限重试；熔断 /
  // 中止 / 崩溃注入时不执行。重试成功则该文件不计入轮次错误（pushTransfer 已清失败
  // 记录）；重试失败按其最终分类处理（permanent 照记退避表，其余照常报错）。
  if (ctx.transientFailed.length && !ctx.crashErr && !ctx.aborted && !ctx.roundBreaker.open) {
    for (const job of ctx.transientFailed) {
      if (ctx.shouldAbort() || ctx.roundBreaker.open) {
        ctx.aborted = true
        break
      }
      try {
        await job()
      } catch (e: any) {
        ctx.handleTransferError(e, job, true)
      }
    }
  }

}
/** 阶段 7c：批量校验提交（两段提交的第二段；按父目录 PROPFIND 核对后写基线）。 */
async function commitBatchUploads(ctx: RoundContext): Promise<void> {
  // ---- 批量校验阶段（两段提交的第二段）----
  // 位置：worker 池结束、瞬时失败当轮重试之后；crashErr 抛出与轮末收尾之前。
  // aborted（非崩溃）时也必须执行：已完成的 PUT 必须当场了结（提交基线或明确报错），
  // 不能把成功上传悬置到下一轮。crashErr 时跳过：模拟进程死亡不做任何收尾，
  // 遗留的 upload intent 交下一轮 recoverIntents 采纳 —— 崩溃窗口语义：
  // PUT 成功 → 此处批量提交之间崩溃，遗留 upload intent，下一轮按「本地未变 +
  // 远端已存在同 size」采纳。
  if (ctx.pendingUploads.length && !ctx.crashErr) {
    // 批量校验的列举请求豁免取消检查（__wdsyncAbort 置空）—— 取消轮也必须
    // 当场了结已成功的 PUT（提交基线或明确报错），不能把成功上传悬置到下一轮；收尾
    // 语义与释放锁的 finally 一致（见外层 finally 的豁免注释）。
    const calmCfg = { ...ctx.cfg, __wdsyncAbort: null }
    // 按父目录分组（rel 无 '/' → 同步根；否则取 dirname）：每组一次 PROPFIND Depth 1
    const byParent = new Map()
    for (const p of ctx.pendingUploads) {
      const i = p.rel.lastIndexOf('/')
      const parent = i < 0 ? '' : p.rel.slice(0, i)
      if (!byParent.has(parent)) byParent.set(parent, [])
      byParent.get(parent).push(p)
    }
    for (const [parent, pend] of byParent) {
      // 请求形态与解析口径统一在 propfindChildMap（与写前查重共用实现；请求经
      // calmCfg 豁免取消）；404 不特判 —— 与写前查重不同，此处「父目录不存在」
      // 只能按组失败收场（该组 pending 必须报错 + abort intent）
      const dirRemote = parent ? joinRemote(ctx.dir.remotePath, parent) : ctx.dir.remotePath
      const probe = await propfindChildMap(calmCfg, dirRemote)
      if (!('ok' in probe)) {
        // 组级失败（网络异常 / 非 207 / 解析失败）：该组全部 pending 报错 —— 基线不写、
        // abort intent。下一轮可安全收敛：WAL 采纳（upload 意图 + 远端已存在同 size →
        // adopt）或按正常规划重传（远端确实没有该文件时）。网络类标记同写前查重口径
        for (const p of pend) {
          await ctx.store.appendWalAbort(p.intentId).catch(() => {})
          ctx.pushError(uploadVerifyFailedMsg(p.rel), true)
        }
        continue
      }
      const childMap = probe.childMap
      for (const p of pend) {
        await maybeYield() // 批量校验提交分片让出（大目录单轮数千 pending）
        // 子条目 key 相对父目录集合；pending.rel 是相对同步根的完整 rel，剥离父前缀后比对
        const key = nfc(parent ? p.rel.slice(parent.length + 1) : p.rel)
        const item = childMap.get(key)
        if (!item || item.isDir) {
          await ctx.store.appendWalAbort(p.intentId).catch(() => {})
          ctx.pushError(uploadVerifyFailedMsg(p.rel), false)
          continue
        }
        if (item.size !== p.local.size) {
          await ctx.store.appendWalAbort(p.intentId).catch(() => {})
          ctx.pushError(uploadVerifyFailedMsg(p.rel), false)
          continue
        }
        // 提交点：基线（远端指纹取自本次批量 PROPFIND，etag 口径与下一轮扫描一致）→ done →
        // 失败记录清除（清除随成功提交走）→ summary 计数（uploaded / bytesUp 在此计数；
        // bytesDoneAcc 进度计数留在传输闭包内，不随提交推迟）
        try {
          await ctx.store.setEntry(
            p.rel,
            entryFrom(p.local, { size: item.size, mtimeMs: item.mtime, etag: item.etag }, p.hash, p.origName ? { origName: p.origName } : {})
          )
          await ctx.store.appendWalDone(p.intentId)
        } catch (e: any) {
          // 基线写入失败（setEntry 抛出语义）：按文件级失败处理，abort 后报错
          await ctx.store.appendWalAbort(p.intentId).catch(() => {})
          ctx.pushError(uploadVerifyFailedMsg(p.rel), false)
          continue
        }
        ctx.store.clearFailure(p.rel)
        // 冲突挂起：冲突解决的上传成功落地 → 清除该文件的挂起记录
        //（决策已完成；普通上传不带 conflict 标记、不受影响 —— 挂起只随冲突路径清除）
        if (p.conflict) ctx.store.clearPending(p.rel)
        ctx.summary.uploaded++
        // 同步记录：云端侧落地成功（含冲突 / 半截重传来源的上传 —— 冲突条目
        // 另记一条「选了什么」，两者分别描述云端改动与用户决策，互不替代）
        ctx.recordSyncOp({ op: 'upload', rel: p.rel, bytes: p.local.size, added: !!p.added })
        ctx.summary.bytesUp += p.local.size
      }
    }
  }

}
/** 阶段 8a：远端根重建 / 移除本地标记的解除判定（和解完成才恢复删除传播）。 */
async function applyRootGuardReleases(ctx: RoundContext): Promise<void> {
  // ---- 解除的安全前提：强干净轮（即时解除与延续轮解除共用）----
  // 除「无错误 / 未取消 / 非熔断 / 非只读档 / 基线可信 / 非崩溃轮」外，还必须没有任何
  // 「本轮看不见的待和解债务」：持续失败退避跳过的文件（permSkipped —— 它们在退避
  // 期间不进删除安全闸，deleteRootGuard 计不到，「干净」表象下可能藏着「本地未变 +
  // 远端缺失」的待恢复文件，解除后会被当新鲜删除执行造成误删）与仍未了结的 WAL
  // 开放意图（半截上传未落地、基线未提交）。预演轮不动任何 meta（零副作用：内存态
  // 变更会经缓存的 store 实例泄给真实轮）。
  const strongClean =
    !ctx.dryRun &&
    !ctx.aborted &&
    !ctx.crashErr &&
    !ctx.roundBreaker.open &&
    ctx.caps.tier !== 'C' &&
    ctx.store.loadedOk &&
    ctx.errorNetCount + ctx.errorOtherCount === 0 &&
    ctx.permSkipped.length === 0 &&
    ctx.store.pendingIntents.size === 0
  // ---- 远端根重建保护（= 「重新上传」决策的策略载体）解除判定 ----
  // 即时解除（决策消费轮，rootWasRebuilt）：本轮强干净 ⇒ 电脑上的文件已全部重新落地
  // 云端（改动文件已重传 / 两侧皆无的基线已清理），「直到成功同步一次之前保持上传」
  // 的使命完成 —— 策略当轮取消（成功即忘）。此后云端再丢失属于「全新丢失」，必须
  // 重新登记决策挂起询问用户，绝不静默复用上次的选择；含跨重启场景（解除随轮末
  // saveMeta 落盘，重建轮成功后不再有残留标记可被复用）。
  if (ctx.store.meta.rootRebuilt && ctx.rootWasRebuilt && strongClean) {
    delete ctx.store.meta.rootRebuilt
  }
  // 延续轮解除（保守口径）：本轮根探测正常（未再 404）且没有因该保护跳过的删除
  //（「本地未变 + 远端缺失」的待和解集合已清零：全部基线文件要么重新上传成功、
  // 要么两侧皆无）→ 清除标记，下一轮恢复正常删除传播。仍有债务（退避未到期 /
  // 本轮有失败等）→ 保守保留保护（债务清零后的强干净轮重新评估），并提示原因。
  if (ctx.store.meta.rootRebuilt && !ctx.rootWasRebuilt && strongClean) {
    if (ctx.summary.deleteRootGuard === 0) {
      delete ctx.store.meta.rootRebuilt
    }
  }
  if (ctx.store.meta.rootRebuilt && !ctx.rootWasRebuilt) {
    if (ctx.summary.deleteRootGuard > 0) {
      ctx.pushWarning(
        `云端文件夹之前丢失过，已把 ${ctx.summary.deleteRootGuard} 个原本会被当作「已删除」的文件改为重新上传，传完后恢复正常`
      )
    } else {
      ctx.pushWarning('云端文件夹之前丢失过，还有文件没传完，暂时不会同步「删除」操作，传完后恢复正常')
    }
  }

  // ---- 远端根丢失「移除本地」标记的解除判定 ----
  // 与 rootRebuilt 解除同口径的强干净轮（见上方 strongClean：含退避 / 开放意图债务
  // 检查 —— 退避中的待移除文件不进删除闸，不带债务判定会在「干净」表象下提前解除）
  // 且本轮再无经标记放行的删除（待移除集合已和解：要么已删除、要么因本地改动改走
  // 上传；keep 保留类由逐文件挂起独立抑制，不依赖本标记）→ 解除标记，恢复正常
  // 删除语义（含批量阈值保护）。仍有待移除或本轮有失败 → 保守保留标记，下一轮继续。
  if (
    ctx.store.meta.rootLostRemoval &&
    ctx.removalForced === 0 &&
    strongClean
  ) {
    delete ctx.store.meta.rootLostRemoval
    await ctx.store.saveMeta().catch(() => {})
  }

}
/** 阶段 8b：空目录清理（两端，best-effort，仅限因本轮同步删除而变空的目录）。 */
async function pruneEmptyDirs(ctx: RoundContext): Promise<void> {
  // ---- 空目录清理（两端，best-effort，失败不报错）----
  // 范围严格限定「因本轮同步删除而变空」的目录：本轮成功删除文件的祖先目录
  //（不含同步根本身）；历史遗留 / 用户自建 / 他机留下的空目录不在清理范围。
  // 取消 / 熔断 / 崩溃注入轮不清理（收尾从简）；单目录清理失败静默跳过。
  if (!ctx.crashErr && !ctx.aborted && !ctx.roundBreaker.open) {
    // 本地：候选 = 本轮 delete-local 成功的祖先目录，按深度降序（先删最深的，
    // 父目录才有机会变空）。rmdir 对非空目录原子失败（ENOTEMPTY）—— 含被忽略
    // 的隐藏文件（如 .DS_Store）的目录自然跳过，不存在误删内容的可能。
    const localCandidates = new Set<any>()
    for (const rel of ctx.localDeletedRels) {
      const segs = rel.split('/')
      for (let i = segs.length - 1; i >= 1; i--) localCandidates.add(segs.slice(0, i).join('/'))
    }
    const localOrdered = Array.from(localCandidates).sort(
      (a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : 1)
    )
    for (const relDir of localOrdered) {
      await maybeYield()
      const absDir = path.join(ctx.dir.localPath, ...relDir.split('/'))
      try {
        await fsp.rmdir(absDir)
        ctx.summary.dirsPrunedLocal++
      } catch (_) {
        /* 非空 / 已不存在 / 权限：正常路径，跳过 */
      }
    }
    // 远端：候选 = 本轮 delete-remote 成功的祖先目录 ∩ 按扫描快照判定「本轮删除后
    // 应为空」的目录（自底向上递归：全部直接文件子项本轮已删、全部目录子项亦可清）。
    // DELETE 前逐目录 PROPFIND Depth 1 复核确无子条目 —— 他机可能在删除后写入新内容，
    // 集合 DELETE 在多数服务器是递归删除，绝不对未复核的目录发起。复核失败（网络 /
    // 非 207 / 404）跳过该目录（404 = 已不存在，目标状态达成，仅不计清理数）。
    if (ctx.remoteDeletedRels.size > 0 && !ctx.shouldAbort()) {
      /** 一次遍历构建直接子项关系（避免 候选数 × 条目数 的重复扫描） */
      const dirChildren = new Map() // 父 rel（'' = 同步根）→ { files: [], dirs: [] }
      for (const [rel, info] of ctx.remoteScan.files) {
        const i = rel.lastIndexOf('/')
        const parent = i < 0 ? '' : rel.slice(0, i)
        let slot = dirChildren.get(parent)
        if (!slot) {
          slot = { files: [], dirs: [] }
          dirChildren.set(parent, slot)
        }
        ;(info.isDir ? slot.dirs : slot.files).push(rel)
      }
      const remoteCandidates = new Set<any>()
      for (const rel of ctx.remoteDeletedRels) {
        const segs = rel.split('/')
        for (let i = segs.length - 1; i >= 1; i--) remoteCandidates.add(segs.slice(0, i).join('/'))
      }
      /** 按快照判定目录在本轮删除后是否应为空（要求扫描时至少有一个子项 ——
       *  扫描时空的目录不是本轮删除造成的，不属于清理范围） */
      const prunableCache = new Map()
      const isPrunable = (d: any) => {
        if (prunableCache.has(d)) return prunableCache.get(d)
        prunableCache.set(d, false) // 递归防环兜底（树结构实际无环）
        const kids = dirChildren.get(d) || { files: [], dirs: [] }
        let ok = kids.files.length + kids.dirs.length > 0
        for (const f of kids.files) {
          if (!ctx.remoteDeletedRels.has(f)) {
            ok = false
            break
          }
        }
        if (ok) {
          for (const sub of kids.dirs) {
            if (!isPrunable(sub)) {
              ok = false
              break
            }
          }
        }
        prunableCache.set(d, ok)
        return ok
      }
      const remoteOrdered = Array.from(remoteCandidates)
        .filter((d) => isPrunable(d))
        .sort((a, b) => b.split('/').length - a.split('/').length || (a < b ? -1 : 1))
      for (const relDir of remoteOrdered) {
        if (ctx.shouldAbort() || ctx.roundBreaker.open) break
        await maybeYield()
        const dirUrl = joinRemote(ctx.dir.remotePath, relDir)
        try {
          const r = await davRequest(ctx.cfg, 'PROPFIND', dirUrl, {
            isCollection: true,
            headers: { Depth: '1', 'Content-Type': 'application/xml' },
            body: PROBE_PROPFIND_BODY,
          })
          if (r.status === 404) continue // 已不存在：目标状态达成
          if (r.status !== 207 || !r.body) continue // 无法复核 → 不删（保守）
          const kids = parseMultistatus(r.body.toString('utf-8')).filter(
            (item: any) => relFromHref(ctx.cfg, dirUrl, item.href).replace(/\/+$/, '') !== ''
          )
          if (kids.length > 0) continue // 复核发现仍有内容（他机写入等）→ 不删
          const del = await davRequest(ctx.cfg, 'DELETE', dirUrl)
          if (del.status === 200 || del.status === 204 || del.status === 404) ctx.summary.dirsPrunedRemote++
        } catch (_) {
          /* 复核 / 删除失败：跳过该目录，下一轮有机会再清 */
        }
      }
    }
  }

}
/**
 * 租约锁释放（三条退出路径共用）：
 * 正常结束 / 轮次 error（扫描闸门、执行失败、CIRCUIT_OPEN 熔断终止）/ shouldAbort
 * 取消全部经过。crashErr 置位（测试崩溃注入）时跳过一切：模拟进程死亡不得执行任何
 * 收尾 —— 不清续租定时器、不 DELETE 锁（定时器由 services.cleanup 的全局清扫兜底；
 * 真实进程死亡由锁 TTL 过期 + 下一轮开头的左锁清理兜底）。互斥 key 不在此处清：
 * 由外层 syncDirectory 的 finally 负责（同进程内注入不是真死，必须放行下一轮）。
 */
async function releaseRoundLock(ctx: RoundContext): Promise<void> {
  if (!ctx.crashErr) {
    if (ctx.renewTimer) {
      nodeTimers.clearInterval(ctx.renewTimer)
      RENEW_TIMERS.delete(ctx.renewTimer)
      ctx.renewTimer = null
    }
    if (ctx.lockHeld) {
      ctx.lockHeld = false
      try {
        // DELETE 走无熔断 cfg（__wdsyncBreaker 置 null）+ 单次尝试：熔断触发只说明
        // 「连续失败达到阈值」，网络可能仍可用 —— 释放必须有一次独立于熔断的机会。
        // 同样豁免取消检查（__wdsyncAbort 置 null）—— 取消轮必须照常释放
        // 已持有的锁，否则取消会把他机挡在 TTL 之外。
        const r = await davRequest({ ...ctx.cfg, __wdsyncBreaker: null, __wdsyncAbort: null }, 'DELETE', ctx.lockPath, { noRetry: true })
        if (r.status >= 400 && r.status !== 404) throw new Error(`HTTP ${r.status}`)
      } catch (e: any) {
        // 404 = 目标状态已达成（无锁可删），其余失败记左锁标记：下一轮开头优先补删
        logNote(`租约锁释放失败（${(e && e.message) || e}）：将在下一轮开头重试清理`)
        ctx.store.meta.lockLeftover = { at: Date.now() }
        await ctx.store.saveMeta().catch(() => {})
      }
    }
  }
}


/** 构造带阶段标记的同步失败错误（可附带 failureClass 供调度层退避判定） */
function syncFail(message: string, opts: any = {}): any {
  const err: any = new Error(message)
  if (opts.phase) err.phase = opts.phase
  if (opts.errors) err.errors = opts.errors
  if (opts.summary) err.summary = opts.summary
  if (opts.failureClass) err.failureClass = opts.failureClass
  return err
}

// ---------- 导出 ----------

const services = {
  platform: process.platform,
  /** 调度器门面（文件尾部挂载实例；渲染层经 services.scheduler 订阅与请求） */
  scheduler: null as SchedulerFacade | null,
  dav: {
    /**
     * 测试连接：PROPFIND depth 0。
     * 返回 { ok, latencyMs, error?, tier?, capabilities? } —— tier / capabilities 为
     * 新增字段（向后兼容）：能力探测失败不影响连通性结论（tier 为 null）。
     * @param cfg 连接配置
     * @param remotePath 能力摘要的探测目标远端路径（渲染层传入用户选定的功能测试
     *   目录）；缺省为服务器基址 —— 同一服务器不同子树写权限可能不同，摘要需与
     *   「功能测试」同口径。
     */
    async testConnection(cfg: any, remotePath?: any) {
      const started = Date.now()
      try {
        const r = await davRequest(cfg, 'PROPFIND', '', {
          headers: { Depth: '0', 'Content-Type': 'application/xml' },
          // resourcetype 之外附带 RFC 4331 配额属性（云端剩余空间展示；未支持的服务器按 404 propstat 缺省）
          body: QUOTA_PROPFIND_BODY,
        })
        const latencyMs = Date.now() - started
        if (r.status === 207 || r.status === 200) {
          // 配额属性（RFC 4331）：基址集合返回 quota-available-bytes / quota-used-bytes
          // 时随结果带给渲染层（服务器卡片「云端剩余空间」展示）；未返回 / 解析失败
          // 缺省 —— 无配额信息的服务器 UI 零行为变化。Depth:0 响应唯一条目即集合自身。
          let quota: { available: number | null; used: number | null } | undefined
          try {
            const items = parseMultistatus(r.body ? r.body.toString('utf-8') : '')
            const self = items && items[0]
            if (self && (self.quotaAvailable !== undefined || self.quotaUsed !== undefined)) {
              quota = {
                available: typeof self.quotaAvailable === 'number' ? self.quotaAvailable : null,
                used: typeof self.quotaUsed === 'number' ? self.quotaUsed : null,
              }
            }
          } catch (_) {
            /* 配额解析失败不影响连接结论 */
          }
          // 附带档位与能力摘要：缓存优先（7 天 TTL），缺失才现场探测；探测异常不连坐。
          // 探测目标为调用方指定的远端路径（功能测试目录），缺省为基址
          let capabilities: any = null
          try {
            capabilities = await probeCapabilities(cfg, false, remotePath)
          } catch (_) {
            /* 探测失败不影响连接判定 */
          }
          return { ok: true, latencyMs, tier: capabilities ? capabilities.tier : null, capabilities, ...(quota ? { quota } : {}) }
        }
        if (r.status === 401) return { ok: false, error: '用户名或密码不正确（坚果云请使用「应用密码」）', latencyMs }
        return { ok: false, error: `服务器返回了错误（HTTP ${r.status}）`, latencyMs }
      } catch (e: any) {
        return { ok: false, error: e && e.message ? e.message : String(e) }
      }
    },
    /** 探测服务器能力与档位。force=true 忽略缓存强制重探；remotePath 按该远端根路径判定写权限 */
    probeCapabilities: (cfg: any, force?: any, remotePath?: any) => probeCapabilities(cfg, !!force, remotePath),
    /**
     * 读取未过期的能力缓存（不发起网络请求）；无缓存 / 存储异常返回 null。
     * 返回目标路径（缺省基址）的生效视图（含 tier）。UI 展示降级原因用 writeReason。
     */
    async getCachedCapabilities(cfg: any, remotePath?: any) {
      try {
        const st = await storage.openServerState(originOf(cfg), (cfg && cfg.username) || '')
        const cached = st.getCachedCapabilities(PROBE_TTL_MS)
        if (!cached) return null
        const pathKey = storage.normalizeRemoteKey(remotePath || '/')
        const entry = cached.writePaths && cached.writePaths[pathKey]
        const write = entry && typeof entry.writable === 'boolean' ? entry : undefined
        return effectiveCaps(cached, write)
      } catch (_) {
        return null
      }
    },
    list: (cfg: any, remotePath: any, ignoreHidden: any) => listRemote(cfg, remotePath, ignoreHidden !== false),
    listDirs: (cfg: any, remotePath: any) => listDirs(cfg, remotePath),
    /**
     * 远端目录树清单（「选择性同步」勾选面板的数据源）：对远端同步根做一次完整
     * 扫描（能力缓存支持 Depth:infinity 时单请求，否则逐目录），不做任何排除 ——
     * 已被排除规则 / 勾选树挡掉的条目也要在树里可见（勾回去的前提）。能力缓存
     * 冷启动时会现场探测（探测文件自清理，与首轮同步同一边界）。
     * 扫描不完整（部分目录列举失败 / 根缺失）时 complete=false 并附 errors ——
     * UI 据此禁用勾选树并提示（残缺清单上勾选会误判「未列出 = 已同步」）。
     * @returns { complete, depth, entries: [{ rel, isDir, size }], errors: [{ rel, message }] }
     */
    async listTree(cfg: any, remotePath: any, ignoreHidden: any) {
      try {
        let depthInfinity = false
        try {
          // 只读缓存判定扫描形态（getCachedCapabilities 不发请求）：现场探测会在
          // 远端创建探测目录、且缺失根会被探测期的 mkdirDeep 顺带创建 —— 勾选树是
          // 纯浏览入口，不该有任何远端写副作用；无缓存按逐目录形态扫描（首轮同步
          // 之后缓存必然已热，常态走单请求）。
          const cached = await services.dav.getCachedCapabilities(cfg, String(remotePath || '/'))
          depthInfinity = !!(cached && cached.depthInfinity)
        } catch (_) {
          /* 缓存不可读按逐目录形态 */
        }
        const scan = await listRemoteSafe(cfg, String(remotePath || '/'), ignoreHidden !== false, null, { depthInfinity })
        const entries: any[] = []
        for (const [rel, info] of scan.files) {
          await maybeYield()
          entries.push({ rel, isDir: !!info.isDir, size: info.isDir ? 0 : Number(info.size) || 0 })
        }
        // 树的构建与展示按稳定顺序：rel 字典序（目录与文件混排，UI 分层后各自有序）
        entries.sort((a: any, b: any) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
        return {
          complete: scan.complete === true,
          depth: scan.depth,
          entries,
          errors: (scan.errors || []).map((e: any) => ({ rel: e && e.rel, message: (e && e.message) || '' })),
        }
      } catch (e: any) {
        return { complete: false, depth: 'per-dir', entries: [], errors: [{ rel: '.', message: (e && e.message) || String(e) }] }
      }
    },
    mkdirDeep: (cfg: any, remotePath: any) => mkdirDeep(cfg, remotePath),
    remove: (cfg: any, remotePath: any) => davRequest(cfg, 'DELETE', remotePath),
    /**
     * 已知服务器档案匹配（UI 提示用，不发网络请求）：按 cfg.serverUrl 返回
     * { label, netOpts } 或 null。档案默认只在用户未显式配置 netOpts.ratePerSec
     * 时生效（resolveNetOpts 的分层口径）；UI 据此展示「检测到 XX，已默认限速」。
     */
    serverProfile: (cfg: any) => serverProfileFor(cfg && cfg.serverUrl),
  },
  fsx: {
    scanDir: (localPath: any, ignoreHidden: any) => scanDir(localPath, ignoreHidden !== false),
    watchDir,
    stopWatch,
    stopAllWatch,
    /**
     * 读取 watcher 脏路径集快照（语义见模块内同名函数头注释）。渲染层不使用
     *（调度器经 SchedulerEngine 消费）；暴露在 fsx 是 env.d.ts 随实现源自动更新、
     * e2e 直检 watcher 记录 / 清理行为的入口。
     */
    peekDirtyPaths,
    /** 消费清理 watcher 脏路径集（引擎在本地扫描成功后调用；同样仅供测试直检） */
    clearDirtyPaths,
    /** 选取本地目录，返回路径或 null */
    pickDirectory(title: any) {
      try {
        const picked = window.ztools.showOpenDialog({
          title: title || '选择要同步的文件夹',
          properties: ['openDirectory'],
        })
        return Array.isArray(picked) && picked.length > 0 ? picked[0] : null
      } catch (_) {
        return null
      }
    },
    /**
     * 读取小体积文本文件（当前唯一用途：设置页导入 CA 证书 PEM）。带 256KB 上限 ——
     * 该入口只服务用户在文件选择器里挑中的单个证书文件，超限按损坏内容拒绝
     *（返回 null），绝不成为任意大文件的读取通道。读取失败同样返回 null。
     */
    async readTextFile(abs: string): Promise<string | null> {
      try {
        const st = await statOrNull(String(abs || ''))
        if (!st || !st.isFile() || st.size > 256 * 1024) return null
        return await fsp.readFile(String(abs), 'utf-8')
      } catch (_) {
        return null
      }
    },
  },
  sync: {
    syncDirectory,
    /**
     * 列出某目录的挂起记录（UI「冲突统一处理 / 删除确认」入口）。
     * @param d 目录配置（格式同 syncDirectory 的 dir 参数）
     * @returns [{ rel, local:{size,mtimeMs}, remote:{size,mtimeMs,etag}, createdAt, choice?, kind? }]
     *          按 createdAt 升序；choice 存在 = 用户已选择但落地失败（下轮自动沿用），
     *          不存在 = 已询问但未解决（待统一处理）；kind='delete' 为批量删除确认类
     *          挂起（choice ∈ delete/keep），缺省为冲突类（choice ∈ local/remote/both）
     */
    async listPendingConflicts(d: any) {
      const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
      return st.listPending()
    },
    /**
     * 清除某目录单个文件的冲突挂起记录（UI「忽略此挂起」入口：清除后该文件再冲突时
     * 按常规流程重新询问 / 按 prefs 策略处理）。已立即落盘；同时向决策历史追加一条
     * kind='ignore' 记录（「最近处理记录」可回看为什么不再询问）。
     * @returns 是否确实移除了条目
     */
    async clearPendingConflict(d: any, rel: any) {
      const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
      const prev = st.getPending(rel)
      const removed = st.clearPending(rel)
      if (removed) {
        st.appendDecision({ at: Date.now(), rel: String(rel), kind: 'ignore', choice: 'ignore' })
        await st.saveDecisionLog().catch(() => {})
      }
      if (st.pendingsDirty) await st.savePendings().catch(() => {})
      return removed
    },
    /**
     * 为某目录某个文件的挂起记录补记 / 修改用户选择（UI「统一处理」入口，典型用于
     * 批量解决「已询问但未解决」的挂起）。已立即落盘；下一轮同步自动按该选择解决。
     * 冲突类挂起（缺省 kind）接受 'local' | 'remote' | 'both'；删除确认类挂起
     *（kind='delete'，批量删除超阈值登记）接受 'delete'（确认删除，下一轮执行）|
     * 'keep'（保留两侧不删，持续抑制该文件的删除传播直至状态变化）；根丢失决策类
     *（kind='root-lost'，rel='.'）接受 'upload'（重建云端并重新上传）|
     * 'remove-local'（移除本地已同步内容，跟随云端删除）。
     * @returns 是否成功（挂起记录不存在 → false，不新建 —— 只对已登记的条目生效）
     */
    async setPendingChoice(d: any, rel: any, choice: any) {
      const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
      const prev = st.getPending(rel)
      if (!prev) return false
      const isDeleteKind = prev.kind === 'delete'
      const isRootLostKind = prev.kind === 'root-lost'
      const valid = isDeleteKind
        ? choice === 'delete' || choice === 'keep'
        : isRootLostKind
          ? choice === 'upload' || choice === 'remove-local'
          : choice === 'local' || choice === 'remote' || choice === 'both'
      if (!valid) {
        throw new Error(
          `无效的挂起处理选择：${choice}（${
            isDeleteKind ? '删除确认仅支持 delete / keep' : isRootLostKind ? '根丢失决策仅支持 upload / remove-local' : '冲突仅支持 local / remote / both'
          }）`
        )
      }
      const ok = st.setPending(rel, { ...prev, kind: prev.kind, choice, createdAt: prev.createdAt })
      if (ok) {
        // 决策历史：root-lost 类目录级决策携带受影响基线文件数（弹窗同口径），
        // 供「最近处理记录」回看「当时选了什么、影响了多少文件」
        const entry: any = {
          at: Date.now(),
          rel: String(rel),
          kind: isRootLostKind ? 'root-lost' : isDeleteKind ? 'delete' : 'conflict',
          choice: String(choice),
        }
        if (isRootLostKind && prev.local && prev.local.size > 0) entry.affected = prev.local.size
        st.appendDecision(entry)
        await st.saveDecisionLog().catch(() => {})
      }
      if (st.pendingsDirty) await st.savePendings().catch(() => {})
      return ok
    },
    /**
     * 列出某目录的决策历史（UI「最近处理记录」入口）。
     * @param d 目录配置（格式同 syncDirectory 的 dir 参数）
     * @returns [{ at, rel, kind, choice, affected? }] 按时间倒序（最新在前）；
     *          kind ∈ 'conflict' | 'delete' | 'root-lost' | 'ignore'，choice 为用户的
     *          选择值（忽略类恒为 'ignore'），affected 仅 root-lost 类携带
     */
    async listDecisionLog(d: any) {
      const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
      return st.listDecisionLog()
    },
    /**
     * 列出某目录的同步记录（UI「同步记录」页数据源）。
     * @param d 目录配置（格式同 syncDirectory 的 dir 参数）
     * @returns [{ at, endAt, trigger, status, uploaded, ..., ops[], errors[] }]
     *          按时间倒序（最新在前）；每轮一条，含触发方式 / 起止时间 / 计数摘要 /
     *          逐文件操作明细 / 错误清单 —— 简略行与详尽视图共用同一份数据
     */
    async listSyncLog(d: any) {
      const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
      return st.listSyncLog()
    },
    /**
     * 读取某目录的批量删除快照（UI 待处理面板「删除确认目录树」的数据源）。
     * 返回 DeleteBatchView：快照本体 + 当前生效的范围决策（scopes）+ 引擎算好的
     * 未决策文件数（undecided，按树精确去重扣除 scope 覆盖部分）。
     * 无快照但存在未决策删除记录（旧版本登记 / 未到阈值的单文件挂起）时从记录
     * 合成单文件叶快照 —— 保证「有挂起必有决策入口」，不会出现记录在等待确认
     * 却没有任何 UI 通道可达的死角。
     * @param d 目录配置（格式同 syncDirectory 的 dir 参数）
     * @returns DeleteBatchView | null（无快照且无未决策删除记录）
     */
    async listDeleteBatch(d: any) {
      const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
      let batch = st.getDeleteBatch()
      if (!batch) {
        const items = st.listPending().filter((p: any) => p.kind === 'delete' && !p.choice)
        if (!items.length) return null
        batch = buildDeleteBatch(new Map(items.map((p: any) => [p.rel, p.local ? p.local.size : 0])), Date.now())
      }
      const scopes = st.listDeleteScopes()
      return { ...batch, scopes, undecided: computeUndecidedFiles(batch, scopes) }
    },
    /**
     * 落一条删除范围决策（UI 目录树节点 / 底部「全部」按钮的入口）：在 prefix
     * （nfc 归一；'' = 整个同步目录）范围内按 choice 消费全部删除候选 —— 含逐文件
     * 挂起表装不下的部分。已登记的逐文件删除记录同步回写 choice（两条消费路径
     * 语义一致、UI 列表不再重复展示）；决策历史追加一条 kind='delete' 记录
     *（affected 携带覆盖文件数，「最近处理记录」可回看影响面）。
     * 立即落盘；下一轮同步按 scope 自动执行 / 抑制。
     * @param d 目录配置（格式同 syncDirectory 的 dir 参数）
     * @param rel 范围前缀：'' = 整个同步目录；目录 rel = 该目录及其全部子树；
     *            文件 rel = 单文件。'.' / '/' 保留字（根丢失决策专用）不可用
     * @param choice 'delete'（确认删除，下一轮执行）| 'keep'（保留不删，持续抑制）
     * @returns {{ ok: true, covered: number, stamped: number }} covered = 决策覆盖的
     *          删除候选文件数（按当前快照口径；无快照时按未决策记录数），stamped =
     *          同步回写 choice 的既有逐文件记录数
     */
    async setDeleteScope(d: any, rel: any, choice: any) {
      const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
      if (choice !== 'delete' && choice !== 'keep') {
        throw new Error(`无效的删除范围选择：${choice}（仅支持 delete = 确认删除 / keep = 保留不删）`)
      }
      const raw = String(rel == null ? '' : rel)
      if (raw === '.' || raw === '/') {
        throw new Error('「.」是云端文件夹丢失决策的保留路径，整个同步目录请用空范围表示')
      }
      const prefix = nfc(raw)
      const batch = st.getDeleteBatch()
      // 代际 = 决策时的快照 at（无快照的扁平决策为 0）：盖章回写限定同代，跨代新
      // 批次的决策不翻案旧代已盖章的逐文件记录（「全部」只作用于当前树的未决策项）
      const gen = batch ? batch.at : 0
      // 覆盖数 = 本次决策真正新覆盖的未决策文件数（决策前后的引擎口径差，天然
      // 扣除已被其他 scope 覆盖的部分）；无快照时退回未决策记录数
      const scopesBefore = st.listDeleteScopes()
      const covered = batch
        ? computeUndecidedFiles(batch, scopesBefore) - computeUndecidedFiles(batch, [...scopesBefore, { prefix, choice, at: 0, gen }])
        : st.listPending().filter((p: any) => p.kind === 'delete' && !p.choice && scopeHitsRel(prefix, p.rel)).length
      st.setDeleteScope(prefix, choice, gen)
      const stamped = st.stampDeleteScopeChoices(prefix, choice, gen)
      st.appendDecision({ at: Date.now(), rel: prefix || '.', kind: 'delete', choice, affected: covered > 0 ? covered : undefined })
      await st.saveDecisionLog().catch(() => {})
      if (st.pendingsDirty) await st.savePendings().catch(() => {})
      return { ok: true, covered, stamped }
    },
    /**
     * 校验一份新的同步目录配置与既有目录是否嵌套 / 重叠（保存时调用）。
     * 本地侧与远端侧分别判定，任一侧嵌套（含完全相同）即报错 —— UI 据此阻止保存。
     * @returns {{ side: 'local'|'remote', withName: string, message: string } | null}
     */
    checkDirOverlap: (dir: any, existing: any, exceptId: any) => checkDirOverlap(dir, existing, exceptId),
    /**
     * 内部状态机直检入口：仅供测试与同步安全审计使用，渲染层勿依赖。
     */
    _internals: {
      decideAction,
      davRequest,
      /** 本模块实际使用的本地 fs（宿主内应为未打补丁的 original-fs；Node 测试环境回落 node:fs） */
      localFs: fs,
      scanDirSafe,
      listRemoteSafe,
      /** 批量删除快照聚合（纯函数直检：目录树构建 / 折叠 / 截断） */
      buildDeleteBatch,
      /** 快照未决策文件数计算（纯函数直检：scope 覆盖去重） */
      computeUndecidedFiles,
      /** 范围前缀命中判定（纯函数直检，与 matchDeleteScope 同规则） */
      scopeHitsRel,
      uploadOne,
      downloadOne,
      deleteLocalOne,
      fpMatch,
      cleanupOrphanTemps,
      isSyncTempName,
      /** watcher 事件过滤判定直检（纯函数） */
      ignoredWatchEvent,
      hashFile,
      remoteChangedVs,
      computeLocalChanged,
      verifyRemoteHash,
      localFpTolMs,
      nfc,
      normEtag,
      probeCapabilities,
      /** 服务器档案匹配（纯函数：SERVER_PROFILES 的 host 后缀判定） */
      serverProfileFor,
      /** 生效网络参数解析（纯函数：显式 netOpts > 档案默认 > NET_DEFAULTS） */
      resolveNetOpts,
      /** Digest 挑战解析（纯函数直检：引号 / 逗号 / 畸形形态） */
      parseDigestChallenge,
      /** Digest 应答计算（纯函数直检：RFC 2617 标准向量 / qop 协商 / 算法映射） */
      digestAuthorization,
      /** Digest 挑战缓存（e2e 断言挑战复用与 nc 递增；Map 形态直读） */
      digestChallenges,
      /** 带宽字节桶（e2e 断言限速生效后的桶状态） */
      byteBuckets,
      /** 「不限制」的桶速率哨兵（e2e 断言改 0 即放开时的桶速率） */
      BW_UNLIMITED_BPS,
      /** 每源实时带宽限额表（e2e 断言调度器推送与限速修改的即时生效） */
      liveLimits,
      /** 推送一台服务器的实时带宽限额（调度器 applyConfig 的推送通道；测试直检用） */
      applyNetLimits,
      /** 进程级累计流量（实时速率的数据源；单测断言 PUT/GET 字节计数） */
      netTraffic,
      /** saxes 解析器直检：畸形 XML 抛错 / 前缀变体 / 流式块边界 */
      parseMultistatus,
      createMultistatusStream,
      createRoundBreaker,
      /** 读取某目录基线条目（测试断言用）；目录配置格式同 syncDirectory 的 dir 参数 */
      async baselineEntry(d: any, rel: any) {
        const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
        const e = st.get(rel)
        return e ? { ...e } : null
      },
      /** 当前基线条目总数（测试断言用） */
      async baselineSize(d: any) {
        const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
        return st.entries.size
      },
      /** 传输失败三分类：'permanent' | 'transient' | 'normal'（直检分类规则用） */
      classifyOpFailure,
      /** 网络类失败判定（summary.failureClass 的逐条口径，与熔断计数一致） */
      networkFailure,
      /** 内置垃圾规则判定（跨平台默认排除，与 ignoreHidden 无关；纯函数） */
      isJunkRel,
      /** 用户排除规则编译（glob → 匹配函数；纯函数，null = 无有效规则） */
      compileExcludePatterns,
      /** 勾选树精确 rel 集合编译（纯函数；null = 无条目） */
      compileExactRels,
      /** 本轮生效排除匹配器（glob + 勾选树精确 rel，含祖先目录命中；纯函数直检） */
      compileSyncExcludes,
      /** Windows 文件名/路径预检（纯函数：段级校验 + rel/win32 长度预算） */
      checkWinSegment,
      checkWindowsRel,
      /** 大小写冲突检测（纯函数：本地/远端 rel 集合 → 冲突组 + 跳过集合） */
      detectCaseCollisions,
      /** 改名配对（规划期启发式：旧路径消失 + 新路径出现 + 指纹一致 → 改名；直检回落条件用） */
      computeRenamePairs,
      /** TLS 握手错误映射（纯函数：Node 错误码 → 友好文案 + code='TLS'；非 TLS 返回 null） */
      normalizeTlsError,
      /** TLS Agent 选项解析（纯函数：cfg.tls → 分池键 + Agent 构造项） */
      tlsAgentOptsFor,
      /** 同步目录重叠校验（纯函数，与公开入口同实现） */
      checkDirOverlap,
      /** 读取某目录的持续失败退避记录（测试断言用）：rel → { code, message, count, firstAt, lastAt, retryAtMs } 副本 */
      async getFailures(d: any) {
        const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
        const out: Record<string, any> = {}
        for (const [k, v] of st.failures) out[k] = { ...v }
        return out
      },
      /** 测试专用：把某目录全部失败记录的重试时间前拨 ms 毫秒（验证退避到期后的重试行为） */
      async ageFailures(d: any, ms: any) {
        const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
        st.ageFailures(ms)
      },
      /**
       * 测试专用：为某文件植入一条持续失败退避记录（构造「重建轮带退避债务」场景，
       * 验证解除判定对 permSkipped 债务的保守处理）。与引擎 noteFailure 同一入口，
       * 计数 / 退避时长按真实规则推导；植入即落盘（与真实失败同口径）。
       */
      async seedFailure(d: any, rel: any, code: any, message: any) {
        const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
        st.noteFailure(String(rel), { code: String(code || 'TEST'), message: String(message || 'seeded') })
        if (st.failuresDirty) await st.saveFailures().catch(() => {})
      },
      /** 读取某目录的元数据副本（测试断言左锁标记 lockLeftover 等） */
      async getDirMeta(d: any) {
        const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
        return { ...st.meta }
      },
      /** 读取某目录的冲突挂起记录副本（测试断言用）：[{ rel, local, remote, createdAt, choice? }] */
      async getPendings(d: any) {
        const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
        return st.listPending()
      },
      /**
       * 测试专用：把某目录全部开放意图的写入时间整体前拨 ms 毫秒（30 天超龄
       * 兜底验证；at 与 firstAt 一并前拨；只改内存不落盘，
       * 与 ageFailures 同款语义）
       */
      async ageOpenIntents(d: any, ms: any) {
        const st = await storage.openDirStore({ localPath: d.localPath, remotePath: d.remotePath })
        st.ageOpenIntents(ms)
      },
      /** 前缀比对助手直检（测试 / 审计用；product 路径经 remoteIsLocalPrefix 间接使用） */
      filesPrefixEqual,
      remoteIsLocalPrefix,
      /**
       * 清扫崩溃轮按设计遗留的续租定时器（测试崩溃注入收尾），返回清除个数。
       * 仅测试 / 排障用：正常轮末由释放 finally 自清，生产路径不存在需要清扫的定时器。
       */
      crashResidueSweep,
      /**
       * 调度器工厂直检入口（测试传假时钟与 autoBootstrap:false 建测试实例）。
       * 渲染层勿依赖 —— env.d.ts 的公共类型不含 _internals。
       */
      createScheduler,
      /** 清扫全部 scheduler 定时器（测试模拟无卸载事件的进程死亡） */
      sweepSchedulerTimers,
    },
  },
  /** 本地状态存储：渲染层通常只读 deviceId；其余入口供测试与排障 */
  storage: {
    getDeviceId: () => storage.getDeviceId(),
    /** 测试多设备模拟专用：切换存储根（关闭全部已打开存储） */
    setRootForTest: (dir: any) => storage.setRootForTest(dir),
  },
  /**
   * 宿主端口注入点（无头 / 测试专用；渲染层不使用）：getHostPorts 取当前端口
   *（未覆盖时每次现造默认端口，动态读 window.ztools）、setHostPorts 覆盖或还原
   *（null = 默认端口，语义见 host.mts）。注意注入只影响本 services 实例所在的
   * 模块图 —— e2e built 轨里 bundle 与源码 store 是两个实例，跨实例注入互不可见。
   */
  host: {
    getHostPorts,
    setHostPorts,
  },
  /**
   * 凭据混淆（AES-256-GCM，同步接口）：渲染层 persist 前把密码 seal 进
   * dbStorage、init 时 open 回内存；调度器读 dbStorage 配置时同一对函数解密。
   * 防随手窥视而非强加密（密钥与密文同机同盘，见 store.js「凭据混淆」节）。
   * seal 失败（pluginData 不可写）时原样返回明文 —— 混淆是尽力而为，不阻断保存。
   */
  secure: {
    sealSecret: (plain: any) => storage.sealSecret(plain),
    openSecret: (sealed: any) => storage.openSecret(sealed),
  },
  /**
   * 实验功能「ZTools 插件同步」的自动发现结果（渲染层虚拟行的数据源；渲染层
   * 无 Node 能力，不能自行发现 ~/.ztools/plugins）。发现逻辑与调度器 loadConfig
   * 的目录合成共用 ztools-plugins.mts 同一实现 —— 两侧行为天然一致。
   * @param remoteBase 用户所选的云端父目录（prefs.ztoolsPluginSyncRemoteDir；
   *        缺省 = 云端根），决定远端根的父目录段
   */
  ztoolsPlugins: {
    describe: (remoteBase?: string): ZtoolsPluginsSyncDesc => describeZtoolsPluginsSync(remoteBase),
    /**
     * 插件注册表对账的最近状态（实验功能「无感同步」第二段的观测口）：渲染层
     * 虚拟行据此提示降级形态（未授权 / 旧宿主）。null = 本会话尚未对账过。
     * 状态在 preload 侧模块内维护，进程重启归零、下一轮 round-end 重建。
     */
    registryState: (): (RegistryReconcileResult & { at: number }) | null => getRegistryReconcileState(),
    /**
     * 手动触发一次注册表对账（渲染层 / 测试入口；调度器轮末对账走同一实现，
     * 模块内串行化）：把 manifest 合并进宿主注册表 / 重写导出。未授权时返回
     * denied 结果，不做任何写入。
     * @returns 对账结果（status / adopted / removed / wroteManifest / error）
     */
    reconcileRegistry: (): Promise<RegistryReconcileResult> => reconcilePluginRegistry(),
  },
  /**
   * 插件退出时清理监听与自建网络资源（keep-alive 连接池 / 限速器）。
   * 租约锁续租定时器在此全局清扫：正常轮末由释放 finally 自清，崩溃注入
   * 路径（crashErr）故意不清自己的定时器（模拟进程死亡不做收尾），退出时由此兜底。
   * 调度器实例的清理一并纳入（幂等；scheduler 自身还持 leader 锁 / 目录锁 /
   * watcher，均在其 cleanup 内让出或清扫）。
   */
  cleanup() {
    if (schedulerInstance) {
      try {
        schedulerInstance.cleanup()
      } catch (_) {
        /* 调度器清理失败不阻断引擎清理 */
      }
    }
    stopAllWatch()
    destroyNetPools()
    crashResidueSweep()
  },
}

/**
 * 渲染层公共门面类型（单一事实源）：
 * 以本文件实现为基准，裁掉测试直检后门（sync._internals）—— 渲染层类型
 * （env.d.ts 经 re-export 引用此处）永不暴露后门成员。
 */
type SyncFacadePublic = Omit<(typeof services)['sync'], '_internals'>
export type ServicesPublic = Omit<typeof services, 'sync'> & { sync: SyncFacadePublic }

// 挂载到渲染层全局（宿主 contextIsolation:false 下即 window.services）
window.services = services

/**
 * 挂载调度器门面并注册宿主生命周期钩子。
 * 挂载失败（理论不可达）不拖垮引擎 —— scheduler 为 null 时渲染层自动退回
 * 「无自动同步，手动直调引擎」的降级路径。
 */
let schedulerInstance: any = null
try {
  schedulerInstance = createScheduler({
    engine: {
      syncDirectory,
      watchDir,
      stopWatch,
      stopAllWatch,
      // watch 轮的脏路径提示源（id 与 watchDir 注册用的 watcherId 同一形态）；
      // 引擎侧在本地扫描成功后经 hints.watcherKey 反向调 clearDirtyPaths 消费
      peekDirtyPaths,
      listPendingConflicts: (...a: any[]) => services.sync.listPendingConflicts(...a as [any]),
    },
    getDeviceId: () => storage.getDeviceId(),
    storageRoot: () => storage.storageRoot(),
    autoBootstrap: true,
  })
  services.scheduler = schedulerInstance
  // 宿主钩子槽位（经宿主端口层取 lifecycle，见 host.mts —— 默认端口
  // 绑定 window.ztools 且两钩子齐才返回；null 时跳过注册，与原 zt 缺失分支一致）：
  // onPluginEnter / onPluginOut 是单回调槽位、重复注册会覆盖 —— preload 先于
  // 渲染层执行，先注册即拥有槽位；渲染层（App.vue）不再自行注册，只经 scheduler
  // 订阅接收 plugin-out / plugin-enter 事件。注册发生在挂载期（import 时一次性），
  // 端口化不改变该时序。
  // 宿主事实（已核实）：outPlugin(false) 会双发 PluginOut（幂等清理兜底）；
  // 主窗口渲染层刷新摘视图不发 PluginOut；分离窗口点 X 不发 PluginOut；close /
  // destroy / 崩溃不发任何卸载事件 —— 全部靠 TTL 接管兜底。
  try {
    const lc = getHostPorts().lifecycle
    if (lc) {
      lc.onPluginOut((isKill: any) => {
        try {
          if (schedulerInstance) schedulerInstance.handlePluginOut(!!isKill)
          if (isKill) services.cleanup() // kill 路径全量清理；隐藏路径不清（后台同步要继续）
        } catch (_) {
          /* 钩子异常不得外抛进宿主 */
        }
      })
      lc.onPluginEnter((action: any) => {
        try {
          if (schedulerInstance) schedulerInstance.handlePluginEnter(action)
        } catch (_) {
          /* 同上 */
        }
      })
    }
  } catch (_) {
    /* 宿主 API 异常：钩子注册失败不影响引擎与调度器本体 */
  }
} catch (e: any) {
  // 调度器不可用（引擎仍完整可用）：仅控制台留痕，绝不抛出阻断 services 挂载
  try {
    console.warn('[webdav-sync] scheduler unavailable:', e && e.message ? e.message : e)
  } catch (_) {
    /* 忽略 */
  }
}

