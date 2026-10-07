/* eslint-disable */
// svc/localfs.mts —— 本地文件系统域：递归扫描 /
// 脏路径快速核对 / 根健康检查 / watcher 注册表（去抖 + 脏路径集）/ 哈希与本地
// mtime 容差探测 / 崩溃临时文件清理。扫描完整性语义（complete === false ⇒ 缺失
// 条目只代表「无法确认」，绝不能被决策层解释为删除）是本域的核心契约。
import path from 'node:path'
import crypto from 'node:crypto'
import nodeFs from 'node:fs'
import nodeTimers from 'node:timers'
import { LIVE_TEMPS, fs, fsp, logNote, maybeYield, nfc, type LocalStat } from './base.mts'
import { SYNC_SKIP_NAMES, isExcludedRel, isSyncTempName } from './excludes.mts'

/** 孤儿临时文件的最小时龄：超过才允许启动期清理（活跃下载与并发同步的临时文件必然很年轻） */
const ORPHAN_TEMP_MIN_AGE_MS = 60 * 60 * 1000
/**
 * 目录监听注册表：id（调度器传入的 watcherId）→ { watcher, timer, dirty }。
 * dirty 为该目录自上一轮同步以来上报过的事件路径集（NFC、'/' 分隔的 rel；详见
 * watchDir 注释）—— 只是「本地哪里可能变了」的加速提示，不是正确性来源
 *（watch 事件不保证完整，周期性全量扫描才是兜底）。
 */
const WATCHERS = new Map()
/** 本地扫描进度回调的间隔（扫描无既定总量，filesDone 按已见文件数递增上报） */
const SCAN_PROGRESS_MS = 250
/**
 * 本地脏路径快速核对的条目上限：watch hints 的 dirtyPaths 超过它即放弃快速核对、
 * 回落全量 walk。两个动机：① 病态大批量改动（如解压 / 依赖安装产生数千事件）时，
 * 逐路径 lstat + 每个删除路径的子树前缀清扫反而可能慢于一次顺序 walk；② 防御脏集
 * 异常膨胀（平台事件风暴）拖垮轮次。回落只影响性能形态，不影响正确性。
 */
export const DIRTY_SCAN_MAX = 512

/**
 * 同步启动期清理上一轮崩溃残留的临时文件（仅同步根目录第一层 —— 引擎只在这里产生临时文件）。
 * 三重安全边界，避免误删：
 *   1. 名字严格命中引擎临时前缀且是普通文件；
 *   2. 不在本进程在用集合（LIVE_TEMPS）中 —— 并发同步 / 活跃下载正在写入的文件不受影响；
 *   3. mtime 距今超过 ORPHAN_TEMP_MIN_AGE_MS —— 活跃写入的临时文件必然年轻，
 *      只有进程崩溃残留才会陈旧。
 * 单个文件删除失败静默跳过（下一轮重试）；清理环节任何异常都不阻断同步。
 */
export async function cleanupOrphanTemps(localPath: string): Promise<void> {
  let names
  try {
    names = await fsp.readdir(localPath)
  } catch (_) {
    return // 目录尚不存在（首轮同步）：无残留可清
  }
  const cutoff = Date.now() - ORPHAN_TEMP_MIN_AGE_MS
  for (const name of names) {
    if (!isSyncTempName(name)) continue
    const abs = path.join(localPath, name)
    if (LIVE_TEMPS.has(abs)) continue
    const st = await statOrNull(abs)
    if (!st || !st.isFile()) continue
    if (st.mtimeMs > cutoff) continue
    await fsp.unlink(abs).catch(() => {})
  }
}

/**
 * 递归扫描本地目录。
 * 返回 { files: Map(rel -> {abs, size, mtimeMs}), complete: boolean, errors: [{rel, message}] }。
 *
 * 完整性语义（同步安全的核心）：
 *   complete === true  → 目录树全部枚举成功，"files 中没有 rel" 可以确证「文件不存在」
 *   complete === false → 至少有一处 readdir / stat 失败，此时缺失 entry 只代表「无法确认」，
 *                        绝不能被同步决策解释为删除（见 syncDirectory 的前置闸门）。
 * 排除次序（与远端 listRemoteSafe 同规则）：同步系统文件 / 引擎临时文件 → 内置垃圾
 *（isJunkRel）→ 用户排除规则（excludeMatcher）→ ignoreHidden 的隐藏文件。垃圾与
 * 用户规则与 ignoreHidden 无关；隐藏文件在 ignoreHidden 时属于刻意排除的范围，
 * 不算扫描错误。
 * @param excludeMatcher compileExcludePatterns 的产物（用户排除规则；null = 无规则直通）
 * @param onFilesSeen 可选扫描进度回调：(已见文件数) => void；内部按 SCAN_PROGRESS_MS
 *        节流 + 结束时强制末报一次（最终计数必然送达）。数万文件的扫描以百毫秒级
 *        粒度外发进度，渲染层不再面对「黑盒扫描数十秒」（runSyncRound 映射为
 *        phase='scan' 的进度事件；不传 = 零开销直通，既有直调调用方不受影响）
 */
export async function scanDirSafe(localPath: string, ignoreHidden: boolean, excludeMatcher: ((rel: string) => boolean) | null = null, onFilesSeen: ((n: number) => void) | null = null): Promise<any> {
  const root = path.resolve(localPath)
  const files = new Map()
  const errors: any[] = []
  let complete = true
  let seen = 0
  let lastNoteAt = 0
  const noteSeen = (force = false) => {
    if (!onFilesSeen) return
    const t = Date.now()
    if (!force && t - lastNoteAt < SCAN_PROGRESS_MS) return
    lastNoteAt = t
    try {
      onFilesSeen(seen)
    } catch (_) {
      /* 进度回调异常不得影响扫描 */
    }
  }
  async function walk(dir: any, prefix: any) {
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (e: any) {
      complete = false
      errors.push({ rel: prefix || '.', message: (e && e.code) || (e && e.message) || String(e) })
      return
    }
    for (const ent of entries) {
      await maybeYield() // 扫描批间分片让出（大目录紧凑循环不饿调度器心跳）
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name
      // 排除链统一走 isExcludedRel（与远端扫描同规则）：任一命中即不进入候选集合
      if (isExcludedRel(rel, { ignoreHidden, excludeMatcher })) continue
      const abs = path.join(dir, ent.name)
      if (ent.isSymbolicLink()) continue
      if (ent.isDirectory()) {
        await walk(abs, rel)
      } else if (ent.isFile()) {
        let st
        try {
          st = await fsp.stat(abs)
        } catch (e: any) {
          // stat 失败 = 无法确认该文件状态（可能是瞬时 IO / 权限问题），标记不完整
          complete = false
          errors.push({ rel, message: (e && e.code) || (e && e.message) || String(e) })
          continue
        }
        files.set(rel, { abs, size: st.size, mtimeMs: st.mtimeMs })
        seen++
        noteSeen()
      }
    }
  }
  await walk(root, '')
  noteSeen(true)
  return { files, complete, errors }
}

/**
 * 本地脏路径快速核对（watch 轮专用，替代 scanDirSafe 的全量 walk）。
 * 形态：以本机基线合成「上一轮一致时的本地表」，再逐条核对 watcher 上报的脏路径：
 *   - 不存在 / 符号链接（lstat 不跟链接，与 walk 的 isSymbolicLink 跳过语义对齐，
 *     符号链接视同不存在）→ 删除该键；目录删除事件只报目录名，故同时清扫全部
 *     `p + '/'` 前缀的键（子树整体消失）；
 *   - 普通文件 → 用实测 stat 覆盖合成值（修改与新增同形态 —— 基线外的新文件、
 *     rename 新名事件由此进入表）；
 *   - 目录 → 本地表本无目录条目，仅当表里恰有同名文件条目（文件变目录的反常
 *     形态）时删除；其余（fifo / socket 等非普通文件）按 walk 的忽略语义删除。
 * 脏路径先过与 walk 同序的排除链（同步系统文件 / 引擎临时 / 内置垃圾 / 用户排除 /
 * ignoreHidden）：被排除的名字本就不该在表里，跳过核对安全。
 * complete=true 的依据是**约定**而非实测：「基线 + 已核对的脏路径」构成对本地状态
 * 的完整视图 —— 漏掉未上报的 watch 事件是已知界内滞后（watch 事件不保证完整），
 * 由 interval / startup / manual / follow-up 轮的周期性全量扫描兜底对账；脏集只是
 * 加速手段，不是正确性来源。调用侧以 store.loadedOk 与
 * DIRTY_SCAN_MAX 把关：基线不可信或脏集过大时不会走到这里。
 * @param localPath 本地同步根
 * @param dirtyPaths watcher 上报的脏路径（NFC、'/' 分隔 rel；可含目录名）
 * @param store 本轮已打开的基线存储（entries 为 NFC 键；loadedOk 已由调用侧确认）
 * @param ignoreHidden 是否忽略隐藏文件（与全量扫描同口径）
 * @param excludeMatcher 用户排除规则（null = 无规则直通）
 * @param onFilesSeen 进度回调：核对完成后强制报告一次最终计数（终态送达与
 *        scanDirSafe 的末次强制报告同契约）
 */
export async function scanDirtyFast(
  localPath: string,
  dirtyPaths: string[],
  store: any,
  ignoreHidden: boolean,
  excludeMatcher: ((rel: string) => boolean) | null,
  onFilesSeen: ((n: number) => void) | null
): Promise<any> {
  const root = path.resolve(localPath)
  const files = new Map()
  // 1. 按基线合成：上一轮一致时的本地表（本地侧指纹 lsize/lmtimeMs 即当时实测值）
  for (const [k, m] of store.entries) {
    await maybeYield() // 数万基线条目的合成循环分片让出（与既有条目循环同规格）
    files.set(k, { abs: path.join(root, ...k.split('/')), size: m.lsize, mtimeMs: m.lmtimeMs })
  }
  // 2. 核对脏路径：合成值只在该路径被上报时才被实测覆盖 / 清除
  for (const p of dirtyPaths) {
    await maybeYield()
    const rel = nfc(String(p))
    // 排除链统一走 isExcludedRel（与全量扫描 / 远端扫描同规则）：被排除的名字本就不该在表里
    if (isExcludedRel(rel, { ignoreHidden, excludeMatcher })) continue
    let st: any = null
    try {
      st = await fsp.lstat(path.join(root, ...rel.split('/')))
    } catch (_) {
      st = null // 不存在 / 不可访问（ENOENT 等）：按「已不存在」处理
    }
    if (st && st.isSymbolicLink()) st = null
    if (!st) {
      files.delete(rel)
      // 目录删除只报目录名：清扫该前缀下全部子树键（Map 迭代中删除当前键是安全的）
      const prefix = rel + '/'
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) files.delete(k)
      }
    } else if (st.isFile()) {
      files.set(rel, { abs: path.join(root, ...rel.split('/')), size: st.size, mtimeMs: st.mtimeMs })
    } else {
      // 目录（表里同名文件条目属「文件变目录」反常形态）与 fifo / socket 等
      // 非普通文件：walk 均不入表，这里同样不入
      files.delete(rel)
    }
  }
  if (onFilesSeen) {
    try {
      onFilesSeen(files.size)
    } catch (_) {
      /* 进度回调异常不得影响扫描 */
    }
  }
  return { files, complete: true, errors: [] }
}

/** 兼容旧 API：仅需要文件表（Map）的调用方使用；扫描不完整时抛出，避免把残缺列表当全量 */
export async function scanDir(localPath: string, ignoreHidden: boolean): Promise<Map<string, LocalStat>> {
  const scan = await scanDirSafe(localPath, ignoreHidden)
  if (!scan.complete) {
    const e: any = new Error(`读取电脑文件夹「${scan.errors[0].rel}」时出错，为避免误删文件，本次同步已停止`)
    e.detail = scan.errors[0].message
    e.scanErrors = scan.errors
    throw e
  }
  return scan.files
}

/**
 * 本地同步根健康检查（轮首、任何扫描与远端请求之前执行）。
 * 三类异常一律抛错中止整轮（零删除、零传输）：
 *   1. 根目录不存在 / 不是目录（ENOTDIR）—— 配置指向的路径已消失；
 *   2. 不可读（EACCES 等）—— 权限丢失，扫描必然不完整；
 *   3. 疑似未挂载 / 被清空 —— 目录存在且可读但**零条目**，而本机基线非空。
 *      典型场景：外置盘 / 网络盘掉线后挂载点残留为一个空目录（macOS 常见），
 *      或同步根被整体误删。此时若照常扫描，全部基线文件会按「本地已删除」
 *      规划成批量 delete-remote —— 该启发式在扫描前把整轮掐断。
 *      代价：用户真的删光了本地全部文件时也会中止（换由批量删除确认通道 /
 *      检查目录配置解决），保守取向：宁可中止也不批量误删。
 * baselineCount 为本机基线条目数（0 时不做空目录判定 —— 空目录 + 空基线是合法首轮）。
 * @throws {Error} message 含明确原因；调用方按 phase='scan' 的同步失败收场
 */
export async function checkLocalRootHealth(localPath: string, baselineCount: number): Promise<any> {
  const root = path.resolve(localPath)
  let st: any = null
  try {
    st = await fsp.stat(root)
  } catch (e: any) {
    const err: any = new Error('无法访问电脑上的同步文件夹，本次同步已停止，没有改动任何文件')
    err.detail = `${(e && e.code) || (e && e.message) || e}`
    err.phase = 'scan'
    err.failureClass = 'other'
    throw err
  }
  if (!st.isDirectory()) {
    const err: any = new Error('同步位置不是文件夹，请重新选择')
    err.phase = 'scan'
    err.failureClass = 'other'
    throw err
  }
  let entries
  try {
    entries = await fsp.readdir(root)
  } catch (e: any) {
    const err: any = new Error('无法访问电脑上的同步文件夹，本次同步已停止，没有改动任何文件')
    err.detail = `${(e && e.code) || (e && e.message) || e}`
    err.phase = 'scan'
    err.failureClass = 'other'
    throw err
  }
  if (entries.length === 0 && baselineCount > 0) {
    const err: any = new Error(
      `电脑上的同步文件夹现在是空的，但之前已同步过 ${baselineCount} 个文件。可能是移动硬盘或网络盘没连接，也可能文件夹被清空了。为避免误删，本次已停止；如果确实应该为空，请到同步设置里检查路径`
    )
    err.phase = 'scan'
    err.failureClass = 'other'
    throw err
  }
}

/**
 * 注册目录监听（1.5s 去抖），返回是否成功。
 * 引擎自身临时文件（.wdsync-dl- 下载 / .wdsync-tmp- 容差探测 / .wdsync-verify- 消歧
 * 下载 / .wdsync-probe- 能力探测）与同步系统残留（旧 manifest）不触发回调：
 * 同步轮自身会向同步目录写这些文件，若不过滤，「下载 → watcher 触发 → 再排一轮
 * 空同步」会放大轮次（自触发回路；空轮不再产生新临时文件，因此不会无限循环，
 * 但每轮有传输的同步都会白跑一轮）。filename 为 null 的平台事件无法判定归属，
 * 按用户变化处理（宁可多跑一轮，不可漏报用户修改）。
 * macOS（实测，darwin 24 / Node 22）：根目录条目增删时 FSEvents 会额外发出
 * 「被监听目录自身」的 change 事件（filename = 目录名，无路径前缀）。该自事件
 * 总伴随目标条目自身的具名事件出现（根级创建/覆盖/删除均另有带文件名的 rename，
 * 子目录内写入则只有具名事件），过滤它不会漏报用户修改；不过滤则引擎在根目录
 * 写临时文件（.wdsync-dl-* 等）必触发 watcher，防自触发回路在 macOS 上失效。
 * 窄洞：用户文件恰与监听目录同名且以 change 事件上报时被一并过滤（Windows 内容
 * 修改才报 change；该文件由 interval 轮兜底，不丢数据）。
 */

/**
 * watcher 事件过滤判定（watchDir 回调的过滤器，纯函数）。
 * 忽略两类事件：① 引擎 / 同步系统临时文件（独占前缀与残留名，路径任一段命中即过滤）；
 * ② macOS 目录自事件（evt='change' 且 filename 恰等于被监听目录名，见 watchDir 注释）。
 * filename 为 null 的平台事件无法判定归属，不过滤（按用户变化处理，宁可多跑一轮）。
 * 已知窄洞（与 watchDir 同口径）：用户文件恰与被监听目录**同名**且以 change 上报
 * （Windows 内容修改形态；macOS 实测 darwin 24 / Node 22 用户文件的创建 / 覆盖 /
 * 原地改写一律 rename 具名事件，change 仅为目录自事件，构不成窄洞）会被 ② 一并
 * 忽略 —— 该文件的修改丢失 watch 触发，由 interval 定时轮兜底同步。
 * @param selfName 被监听目录的 basename（localPath 去尾分隔符）
 * @param evt fs.watch 事件类型（'rename' | 'change'）
 * @param filename fs.watch 回调的 filename（可能为 null，可能含路径分隔符）
 * @returns {boolean} true = 忽略该事件（不触发去抖回调）
 */
export function ignoredWatchEvent(selfName: string, evt: string, filename: string | null): boolean {
  if (filename == null) return false
  const name = String(filename)
  if (evt === 'change' && name === selfName) return true
  const segs = name.split(/[\\/]/)
  return segs.some((s) => isSyncTempName(s)) || SYNC_SKIP_NAMES.has(segs[segs.length - 1])
}

export function watchDir(id: string, localPath: string, onChange: () => void): boolean {
  try {
    stopWatch(id)
    const selfName = path.basename(String(localPath).replace(/[\\/]+$/, ''))
    const watcher = fs.watch(localPath, { recursive: true }, (_evt, filename) => {
      if (ignoredWatchEvent(selfName, _evt, filename)) return
      const rec = WATCHERS.get(id)
      if (!rec) return
      // 脏路径即时登记（过滤之后、去抖之外）：去抖窗口内合并的多个事件各自的
      // 路径都进集合，等待中的轮次才能逐路径核对而不是退回全量扫描。归一与
      // 扫描键同构：'/' 分隔（Windows 平台事件携带 '\'）+ NFC。filename 为 null
      // 的平台事件无路径可登记（集合空 → 该轮自然回落全量扫描，语义安全）。
      if (filename != null) rec.dirty.add(nfc(String(filename).split('\\').join('/')))
      nodeTimers.clearTimeout(rec.timer)
      rec.timer = nodeTimers.setTimeout(() => {
        try {
          onChange()
        } catch (_) {
          /* 回调异常不外抛 */
        }
      }, 1500)
    })
    // error 监听必须在 watchDir 返回前同步挂好：被监听目录被删 / 移动时 Node 对
    // FSWatcher emit 'error'，无监听即未捕获异常直接崩插件。目录消失属正常用户
    // 操作而非故障，stopWatch 是安全降级 —— interval 定时轮仍兜底同步，数据不丢，
    // 仅该目录的事件触发从 watch 降级为定时。error 由事件循环异步派发，必然晚于
    // 本同步块（含下方 WATCHERS.set），故 stopWatch 此时必能取到记录；即便竞态下
    // 记录未及登记，stopWatch 对无记录是 no-op，不反向抛错。
    watcher.on('error', (err) => {
      logNote(`目录监听已停止（${(err && err.message) || err}）：${localPath}，该目录改由定时轮兜底同步`)
      stopWatch(id)
    })
    WATCHERS.set(id, { watcher, timer: null, dirty: new Set() })
    return true
  } catch (_) {
    return false
  }
}

/**
 * 读取 watcher 当前累积的脏路径集快照（不清理）。
 * 使用时序：调度器在每个 watch 轮组装 handlers 时调用，把快照经 hints.dirtyPaths
 * 交给引擎；引擎在**本地扫描成功后**才对同一 watcher 调 clearDirtyPaths 消费 ——
 * 扫描失败 / 中止的轮次不清，集合留给下一轮。路径为 NFC、'/' 分隔的 rel，
 * 与本地扫描表的键同构；可能包含目录名（目录删除事件只报目录名，见 scanDirtyFast）。
 * @param id 注册 watcher 时使用的同一 id（调度器形态 `${instanceId}:${dirId}`）
 * @returns {string[] | null} 拷贝数组；该 id 无 watcher 记录（未注册 / 已停止）时 null
 */
export function peekDirtyPaths(id: string): string[] | null {
  const rec = WATCHERS.get(id)
  if (!rec) return null
  return Array.from(rec.dirty)
}

/**
 * 从 watcher 的脏路径集中移除恰好这些路径（已核对消费语义）。
 * 只应由引擎在「本轮已用这些路径完成本地扫描」之后调用：本轮核对过的路径清除，
 * 扫描期间新到的事件路径不在参数里、留在集合中给下一轮（不丢触发）。多余路径
 *（集合中不存在）静默忽略；无该 watcher 记录时为 no-op。
 * @param id 注册 watcher 时使用的同一 id
 * @param paths peekDirtyPaths 快照中已完成核对的路径子集
 */
export function clearDirtyPaths(id: string, paths: string[]): void {
  const rec = WATCHERS.get(id)
  if (!rec || !Array.isArray(paths)) return
  for (const p of paths) rec.dirty.delete(p)
}

/**
 * 停止指定目录监听。整条记录（含脏路径集）随之删除：watcher 已停、不再有新事件，
 * 该目录的下一轮自然回落全量本地扫描，脏集不清理也不影响正确性。
 */
export function stopWatch(id: string): void {
  const rec = WATCHERS.get(id)
  if (!rec) return
  nodeTimers.clearTimeout(rec.timer)
  try {
    rec.watcher.close()
  } catch (_) {
    /* 忽略 */
  }
  WATCHERS.delete(id)
}

/** 停止全部监听（插件退出时调用） */
export function stopAllWatch(): void {
  for (const id of Array.from(WATCHERS.keys())) stopWatch(id)
}

/** stat 一个本地路径，不存在 / 不可访问时返回 null（调用方必须把 null 当「无法确认」处理） */
export async function statOrNull(abs: string): Promise<nodeFs.Stats | null> {
  try {
    return await fsp.stat(abs)
  } catch (_) {
    return null
  }
}

/** 流式计算本地文件 sha256（hex）。用于本地变化消歧与 WAL 恢复采纳 */
export async function hashFile(abs: string): Promise<string> {
  const h = crypto.createHash('sha256')
  const rs = fs.createReadStream(abs)
  try {
    for await (const chunk of rs) h.update(chunk)
  } catch (e: any) {
    rs.destroy()
    throw e
  }
  return h.digest('hex')
}

/** 本地 mtime 容差缓存：目录路径 → 容差 ms（每个目录只探测一次） */
const FS_TOL_CACHE = new Map()

/**
 * 本地指纹 mtime 容差：通过在目标目录写入临时探测文件实测 mtime 粒度。
 *
 * 选型说明：fsutil fsinfo volumeinfo 在非提权 shell 下返回「错误 5: 拒绝访问」
 * （实测 Win11，普通用户基本必败）；mount / /proc/mounts 解析平台相关且无法在
 * 单一平台覆盖全部文件系统。写入实测法免提权、跨平台行为一致，且对网络盘 /
 * UNC 路径 / 外置盘天然正确（探测的就是目标文件系统本身）。
 *
 * 判定：把探测文件 utimes 到「奇数秒 + 700ms」——2 秒粒度的文件系统
 * （FAT12/16/32、exFAT、部分 SMB 捨位配置）读回值落在偶数秒边界（偏差 ≥ 500ms）
 * → 容差 2000ms；高精度文件系统（NTFS/APFS/ext4，实测 NTFS 读回零偏差）
 * → 容差 1000ms。探测失败（目录不可写等）保守取 2000ms。
 *
 * 探测文件使用 .wdsync-tmp- 前缀：被扫描层排除（isSyncTempRel），
 * 崩溃残留由启动期清理（cleanupOrphanTemps）回收。
 */
export async function localFpTolMs(localPath: string): Promise<number> {
  const FAT_TOL = 2000
  const NORMAL_TOL = 1000
  const key = path.resolve(String(localPath || '.'))
  if (FS_TOL_CACHE.has(key)) return FS_TOL_CACHE.get(key)
  let tol = FAT_TOL // 探测失败时的保守值
  const probe = path.join(key, `.wdsync-tmp-tol-${process.pid}-${Math.random().toString(36).slice(2, 8)}`)
  try {
    await fsp.writeFile(probe, '')
    try {
      const target = new Date(Math.floor(Date.now() / 2000) * 2000 + 1700)
      await fsp.utimes(probe, target, target)
      const st = await fsp.stat(probe)
      tol = Math.abs(st.mtimeMs - target.getTime()) > 500 ? FAT_TOL : NORMAL_TOL
    } finally {
      await fsp.unlink(probe).catch(() => {})
    }
  } catch (_) {
    /* 目录不可写 / 不存在等：保守 2000 */
  }
  FS_TOL_CACHE.set(key, tol)
  return tol
}
