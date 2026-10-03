/**
 * e2e 共享测试基建（vitest 迁移版，自 test/sync-e2e.mjs 抽出；旧文件头的历史用例
 * 改写脉络见旧文件注释，迁移对拍通过后旧文件删除）。
 *
 * - section / slowSection 为 vitest 适配器：节注册为 test（fast 节带 'fast' tag、
 *   慢组带 'slow' tag）；check() 软失败登记，节尾一次性抛出全部失败用例清单 ——
 *   保持旧脚本「节内所有用例都执行、失败全列出」的语义。
 * - setupShard({ shard, port })：spawn 独立 dav-server（test/.dav-root-<shard>）、
 *   建独立 LOCAL / STORAGE_* / TRASH_DIR（pid 后缀防同毫秒碰撞）、加载 preload
 *   （WDSYNC_E2E_PRELOAD=built 切 dist 产物），返回旧主 try 作用域的全部共享标识符。
 * - teardownShard：对应旧 finally（引擎连接池销毁 → 标记兜底清理 → kill server 并
 *   等端口释放 → 删临时目录）；退出码由 vitest 接管。
 * - 对拍通道：WDSYNC_E2E_JSONL=<路径> 时逐用例追加 JSONL（节名/用例名/结果），
 *   供新旧运行 diff 比对。
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'vitest'

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
/** 轮次全零判定（原 M2 节内定义，提升到顶层供各节共享） */
export const isNoop = (s) => s.uploaded === 0 && s.downloaded === 0 && s.deleted === 0 && s.conflicts === 0
/** 各节共用的同步偏好（原 SAFE 节内定义，提升到顶层） */
export const SP = { ignoreHidden: true, concurrency: 4, conflictStrategy: 'ask' }

let curSection = null
export function check(name, cond, detail = '') {
  if (curSection) {
    curSection.checks++
    if (!cond) curSection.failed.push(name)
  }
  if (process.env.WDSYNC_E2E_JSONL) {
    try {
      fs.appendFileSync(process.env.WDSYNC_E2E_JSONL, JSON.stringify({ section: curSection ? curSection.desc : null, name, ok: !!cond }) + '\n')
    } catch (_) {
      /* 对拍输出失败不影响测试本身 */
    }
  }
  console.log(`${cond ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`)
}

async function runSection(desc, fn) {
  const rec = { desc, checks: 0, failed: [] }
  const prev = curSection
  curSection = rec
  try {
    await fn()
  } finally {
    curSection = prev
  }
  if (rec.failed.length) {
    throw new Error(`「${desc}」${rec.failed.length}/${rec.checks} 个用例失败：\n  ❌ ${rec.failed.join('\n  ❌ ')}`)
  }
}

/** 节包装器：注册为 vitest test（fast tag；节内 check 全跑完、失败末尾一次抛出） */
export function section(desc, fn) {
  return test(desc, { tags: ['fast'] }, () => runSection(desc, fn))
}

/** 慢组显式登记：reason 必填（一句话写明该节为何慢 / 为何可被日常回归跳过） */
export function slowSection(desc, reason, fn) {
  return test(desc, { tags: ['slow'] }, () => runSection(desc, fn))
}

/**
 * 每分片一套独立环境：dav-server / 端口 / .dav-root-<shard> / 临时目录 / preload 实例。
 * 返回旧主 try 作用域的全部共享标识符（分片文件顶部同名解构，节体零改动搬运）。
 */
export async function setupShard({ shard, port }) {
  const BUILT = process.env.WDSYNC_E2E_PRELOAD === 'built'
  const ROOT = path.join(HERE, `.dav-root-${shard}`)
  const PORT = port
  await fsp.rm(ROOT, { recursive: true, force: true })
  const server = spawn(process.execPath, [path.join(HERE, 'dav-server.mjs'), String(PORT), ROOT], { stdio: 'pipe' })
  process.on('exit', () => {
    try {
      server.kill()
    } catch (_) {
      /* 已死：忽略 */
    }
  })
  // 防泄漏：spawn 之后任何失败（端口占用 / 启动超时 / 加载异常）立即杀掉子进程，
  // 否则收集期失败不触发 afterAll，孤儿 dav-server 会级联污染后续运行（EADDRINUSE）
  try {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server start timeout')), 15000)
    server.stdout.on('data', (d) => {
      if (String(d).includes('listening')) {
        clearTimeout(t)
        resolve()
      }
    })
    server.stderr.on('data', (d) => console.error('[dav]', String(d)))
  })
  const preloadPath = BUILT
    ? path.join(HERE, '..', 'src-ztools', 'preload', 'dist', 'services.js')
    : path.join(HERE, '..', 'src-ztools', 'preload', 'services.mts')
  console.log(`[e2e:${shard}] preload under test: ${BUILT ? 'built bundle' : 'source'} (port ${PORT})`)
  global.window = {}
  await import(pathToFileURL(preloadPath).href)
  const services = global.window.services
  const cfg = { serverUrl: `http://127.0.0.1:${PORT}/dav/`, username: 'u', password: 'p' }
  const storeModule = await import(pathToFileURL(path.join(HERE, '..', 'src-ztools', 'preload', 'store.mts')).href)
  const uniq = `${Date.now()}-${process.pid}`
  const LOCAL = path.join(os.tmpdir(), `wdsync-e2e-${uniq}`)
  const STORAGE_MAIN = path.join(os.tmpdir(), `wdsync-e2e-store-main-${uniq}`)
  const STORAGE_A = path.join(os.tmpdir(), `wdsync-e2e-store-a-${uniq}`)
  const STORAGE_B = path.join(os.tmpdir(), `wdsync-e2e-store-b-${uniq}`)
  const STORAGE_C = path.join(os.tmpdir(), `wdsync-e2e-store-c-${uniq}`)
  const STORAGE_D = path.join(os.tmpdir(), `wdsync-e2e-store-d-${uniq}`)
  const switchDevice = async (root) => {
    await services.storage.setRootForTest(root)
    if (BUILT) await storeModule.setRootForTest(root)
  }
  await switchDevice(STORAGE_MAIN)

  /** 直接定位某目录的基线存储目录（注入损坏快照等测试操纵用） */
  const baselineDirOf = async (d) => {
    const id = await services.storage.getDeviceId()
    return storeModule.baselineDirPath(id, d.localPath, d.remotePath)
  }

  // ── 跨节共享助手（原 P 系列节内定义；提升到此外层作用域，各节才能被独立登记 / 跳过）──
  const setProfile = async (p) => {
    if (p) fs.writeFileSync(path.join(ROOT, '.wdsync-test-profile'), p)
    else await fsp.rm(path.join(ROOT, '.wdsync-test-profile'), { force: true }).catch(() => {})
  }
  const setMidair = async (mode) => {
    if (mode) fs.writeFileSync(path.join(ROOT, '.wdsync-test-midair'), mode)
    else await fsp.rm(path.join(ROOT, '.wdsync-test-midair'), { force: true }).catch(() => {})
  }
  /** 新建独立存储根并切换（档位 / 能力缓存 / 基线互不串扰的前提） */
  const freshStore = async (tag) => {
    const root = path.join(os.tmpdir(), `wdsync-e2e-store-${tag}-${Date.now()}`)
    await fsp.mkdir(root, { recursive: true })
    await switchDevice(root)
    return root
  }
  const tmpLocal = async (tag) => {
    const lp = path.join(os.tmpdir(), `wdsync-e2e-local-${tag}-${Date.now()}`)
    await fsp.mkdir(lp, { recursive: true })
    return lp
  }
  const syncP = (lp, rp, prefs, handlers) =>
    services.sync.syncDirectory(cfg, { id: 'p', localPath: lp, remotePath: rp, mode: 'two-way' }, prefs || SP, handlers || {})
  /**
   * 收敛稳定断言：最多 maxRounds 轮内出现 no-op，且其后一轮仍是 no-op
   *（证明没有无限重传 / 乒乓；P6 异步指纹档位的关键断言）
   */
  const settleStable = async (lp, rp, maxRounds = 4) => {
    for (let i = 0; i < maxRounds; i++) {
      const s = await syncP(lp, rp)
      if (isNoop(s)) return { ok: isNoop(await syncP(lp, rp)), rounds: i + 1 }
    }
    return { ok: false, rounds: maxRounds }
  }
  /**
   * 崩溃注入轮的「进程死亡」等价收尾：crashErr 路径按设计不做任何收尾
   * （不释放锁、不清 60s 续租定时器，见 services.js 释放 finally 注释）—— 真实
   * 进程死亡时定时器随进程消失，而本测试进程活着，必须在每个崩溃轮断言后立即
   * 清扫，否则遗留定时器按 60s 周期向旧锁路径发 PUT，落进后续无关用例的观察窗。
   * 返回清除个数供断言。
   */
  const sweepCrashResidue = () => services.sync._internals.crashResidueSweep()

  const REQLOG = path.join(ROOT, '.wdsync-test-reqlog.log')
  /** 读请求日志为行数组（元素形如 'METHOD /dav/path'）；无日志返回空数组 */
  const readReqlog = async () =>
    (await fsp.readFile(REQLOG, 'utf-8').catch(() => '')).split('\n').filter(Boolean)
  /** 某路径（忽略尾斜杠差异）的指定方法请求数 */
  const countReq = (lines, method, p) =>
    lines.filter((l) => l.startsWith(`${method} `) && l.slice(method.length + 1).replace(/\/+$/, '') === p.replace(/\/+$/, '')).length
  /** 某路径指定方法请求的最后行号（-1 表示无）；用于「以该文件最后一次 PUT 为界」的断言 */
  const lastReqLine = (lines, method, p) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].startsWith(`${method} `) && lines[i].slice(method.length + 1).replace(/\/+$/, '') === p.replace(/\/+$/, '')) return i
    }
    return -1
  }

  const DEPTHLOG = path.join(ROOT, '.wdsync-test-depthlog.log')
  /** 读深度日志为行数组（元素形如 'DEPTH inf /dav/path' 或 'DEPTH 1 /dav/path'） */
  const readDepthlog = async () =>
    (await fsp.readFile(DEPTHLOG, 'utf-8').catch(() => '')).split('\n').filter(Boolean)
  /** 某远端路径（忽略尾斜杠差异）在指定深度下的列举次数；depth 传 'inf' 或数字字符串 */
  const countDepth = (lines, depth, p) =>
    lines.filter((l) => l.startsWith(`DEPTH ${depth} `) && l.slice(`DEPTH ${depth} `.length).replace(/\/+$/, '') === p.replace(/\/+$/, '')).length
  const clearDepthFlags = async () => {
    for (const f of ['.wdsync-test-depthlog', '.wdsync-test-noinfinity', '.wdsync-test-shallowinf']) {
      await fsp.rm(path.join(ROOT, f), { force: true }).catch(() => {})
    }
    await fsp.rm(DEPTHLOG, { force: true }).catch(() => {})
  }

  /** 设置 / 清除节流标记（ms = 每块延迟；null = 清除） */
  const setThrottle = async (ms) => {
    if (ms) fs.writeFileSync(path.join(ROOT, '.wdsync-test-throttle'), String(ms))
    else await fsp.rm(path.join(ROOT, '.wdsync-test-throttle'), { force: true }).catch(() => {})
  }
  /** 轮询 reqlog 直到谓词命中（超时抛错）；返回当时全部行 */
  const waitForReqLine = async (pred, timeoutMs = 15000) => {
    const t0 = Date.now()
    for (;;) {
      const lines = await readReqlog()
      if (pred(lines)) return lines
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitForReqLine 超时（${timeoutMs}ms）`)
      await sleep(30)
    }
  }
  /**
   * 等待 !ABORT 行出现（短超时）：服务器侧的连接关闭事件可能比客户端轮次收尾
   * 晚几十毫秒（服务器还在消费被中断的请求体），断言用轮询而非单次读取
   */
  const waitAbortLine = (method, urlPath) =>
    waitForReqLine((ls) => ls.some((l) => l === `!ABORT ${method} ${urlPath}`), 5000)
  /**
   * 起一轮同步，并在「目标请求行出现在 reqlog 且再过 warmMs」后置位取消标记 ——
   * 此时该传输必然在途（节流保证剩余时长 ≥1s）。返回 { err, summary, sawBytes,
   * abortToSettleMs }：err 为 null 表示轮次正常返回（取消失败形态）；sawBytes 记录
   * onProgress 是否观察到字节推进（引擎进度按文件粒度推进，小文件先完成即计）。
   */
  const runCancelRound = async (lp, rp, targetLine, warmMs, prefs) => {
    let abort = false
    let abortAt = 0
    let sawBytes = false
    const p = (async () => {
      try {
        const sum = await syncP(lp, rp, prefs, {
          shouldAbort: () => abort,
          onProgress: (ev) => {
            if (ev.phase === 'transfer' && ev.bytesDone > 0) sawBytes = true
          },
        })
        return { err: null, summary: sum }
      } catch (e) {
        return { err: e, summary: e.summary || null }
      }
    })()
    await waitForReqLine((ls) => ls.some((l) => l === targetLine))
    await sleep(warmMs)
    abortAt = Date.now()
    abort = true
    const r = await p
    return { ...r, sawBytes, abortToSettleMs: Date.now() - abortAt }
  }
  /** 读取某目录 WAL 的全部操作（e2e 形态断言用；损坏行忽略） */
  const readWalOps = async (d) => {
    const dir = await baselineDirOf(d)
    const text = await fsp.readFile(path.join(dir, 'wal.jsonl'), 'utf-8').catch(() => '')
    const ops = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        ops.push(JSON.parse(line).o)
      } catch {
        /* 损坏行不参与形态断言 */
      }
    }
    return ops
  }
  /** 递归收集本地目录中的引擎传输临时文件（.wdsync-dl- / .wdsync-verify-） */
  const findTempResidue = async (lp) => {
    const out = []
    const walk = async (dir) => {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const ent of entries) {
        const abs = path.join(dir, ent.name)
        if (ent.isDirectory()) await walk(abs)
        else if (ent.name.startsWith('.wdsync-dl-') || ent.name.startsWith('.wdsync-verify-')) out.push(abs)
      }
    }
    await walk(lp)
    return out
  }

  const PUP = { ...SP, leaseLock: false }
  const setNetcut = async (spec) => {
    if (spec) fs.writeFileSync(path.join(ROOT, '.wdsync-test-netcut'), spec)
    else await fsp.rm(path.join(ROOT, '.wdsync-test-netcut'), { force: true }).catch(() => {})
  }
  const setPartialPut = async (on) => {
    if (on) fs.writeFileSync(path.join(ROOT, '.wdsync-test-partialput'), 'x')
    else await fsp.rm(path.join(ROOT, '.wdsync-test-partialput'), { force: true }).catch(() => {})
  }
  /** 造一个 1MB 的填充文件内容（64KB × 16 块，netcut '2' 断在 128KB 处） */
  const puBuf = (ch) => {
    const b = Buffer.alloc(1024 * 1024)
    b.fill(ch)
    return b
  }

  /** 假 dbStorage 后备对象（SC 系列共用；生产为 dbStorage 的同步 KV） */
  const SC_DB = {}
  const SC_KEY = 'webdav-sync:data'
  /**
   * 写入一份调度器配置（dirs 为同步目录；prefs 缺省保持被动：不自动不启动）。
   * 密码经 services.secure.sealSecret 混淆落「dbStorage」—— 与渲染层 persist 同形态
   *（凭据混淆链路；调度器 loadConfig 内部解密）。
   */
  const setSCConfig = (dirs, prefs = {}) => {
    SC_DB[SC_KEY] = {
      server: { serverUrl: `http://127.0.0.1:${PORT}/dav/`, username: 'u', password: services.secure.sealSecret('p') },
      dirs,
      prefs: { autoSync: false, intervalMin: 15, syncOnStartup: false, conflictStrategy: 'ask', ignoreHidden: true, concurrency: 4, ...prefs },
    }
  }
  /** 创建测试调度器实例（autoBootstrap:false；now / timers 可注入假时钟） */
  const createTestSched = (extra = {}) =>
    services.sync._internals.createScheduler({
      engine: {
        syncDirectory: services.sync.syncDirectory,
        watchDir: services.fsx.watchDir,
        stopWatch: services.fsx.stopWatch,
        stopAllWatch: services.fsx.stopAllWatch,
        listPendingConflicts: services.sync.listPendingConflicts,
      },
      getDeviceId: services.storage.getDeviceId,
      autoBootstrap: false,
      ...extra,
    })
  /**
   * 假时钟：手动推进 now 与定时器队列（调度器侧时间完全可控；引擎内部计时器仍为
   * 真实时间 —— 轮次完成靠真实 IO，推进循环间让出真实事件循环即可）。
   */
  const makeFakeClock = () => {
    let t = Date.now()
    const pend = new Set()
    const fire = () => {
      for (const h of Array.from(pend)) {
        if (h.dead) continue
        if (h.at <= t) {
          if (h.interval > 0) {
            h.at = t + h.interval
            h.fn()
          } else {
            h.dead = true
            pend.delete(h)
            h.fn()
          }
        }
      }
    }
    const timers = {
      setTimeout(fn, ms) {
        const h = { fn, at: t + Math.max(0, Number(ms) || 0), interval: 0, dead: false }
        pend.add(h)
        return h
      },
      clearTimeout(h) {
        if (h) {
          h.dead = true
          pend.delete(h)
        }
      },
      setInterval(fn, ms) {
        const h = { fn, at: t + Math.max(0, Number(ms) || 0), interval: Math.max(1, Number(ms) || 1), dead: false }
        pend.add(h)
        return h
      },
      clearInterval(h) {
        if (h) {
          h.dead = true
          pend.delete(h)
        }
      },
    }
    return {
      timers,
      now: () => t,
      async advance(ms, slice = 200) {
        let remaining = ms
        while (remaining > 0) {
          const step = Math.min(slice, remaining)
          t += step
          fire()
          remaining -= step
          // 让出真实事件循环：轮次 / 心跳的真实 IO 与微任务在推进间隙推进
          await new Promise((r) => setImmediate(r))
          fire()
        }
      },
    }
  }
  /** 真实时间轮询等待谓词为真（不推进假时钟） */
  const waitReal = async (pred, timeoutMs = 20000) => {
    const t0 = Date.now()
    while (!pred()) {
      if (Date.now() - t0 > timeoutMs) return false
      await sleep(20)
    }
    return true
  }
  /** 边推进假时钟边等待谓词为真（capFakeMs 限制假时钟最大推进量，防止区间外的到期任务被误触发） */
  const pumpUntil = async (clock, pred, timeoutMs = 20000, capFakeMs = Infinity) => {
    const t0 = Date.now()
    let advanced = 0
    while (!pred()) {
      if (Date.now() - t0 > timeoutMs || advanced >= capFakeMs) return false
      const step = Math.min(200, capFakeMs - advanced)
      await clock.advance(step)
      advanced += step
      await sleep(5)
    }
    return true
  }
  /** 读 leader.lock 内容（无 / 损坏返回 null） */
  const readLeaderLock = async () => {
    try {
      return JSON.parse(await fsp.readFile(path.join(storeModule.storageRoot(), 'scheduler', 'leader.lock'), 'utf-8'))
    } catch (_) {
      return null
    }
  }
  /** 原子写 leader.lock（temp+rename，模拟另一实例的接管写） */
  const writeLeaderLock = async (body) => {
    const dir = path.join(storeModule.storageRoot(), 'scheduler')
    await fsp.mkdir(dir, { recursive: true })
    const p = path.join(dir, 'leader.lock')
    const tmp = `${p}.tmp-test`
    await fsp.writeFile(tmp, JSON.stringify(body))
    await fsp.rename(tmp, p)
  }

  const projDir = () => ({ id: 'd1', localPath: LOCAL, remotePath: '/proj', mode: 'two-way' })
  return {
    HERE, ROOT, PORT, LOCAL, server, services, cfg, storeModule, BUILT, preloadPath,
    STORAGE_MAIN, STORAGE_A, STORAGE_B, STORAGE_C, STORAGE_D, switchDevice,
    baselineDirOf, setProfile, setMidair, freshStore, tmpLocal, syncP, settleStable, sweepCrashResidue, projDir,
    REQLOG, readReqlog, countReq, lastReqLine,
    DEPTHLOG, readDepthlog, countDepth, clearDepthFlags,
    setThrottle, waitForReqLine, waitAbortLine, runCancelRound, readWalOps, findTempResidue,
    PUP, setNetcut, setPartialPut, puBuf,
    SC_DB, SC_KEY, setSCConfig, createTestSched, makeFakeClock, waitReal, pumpUntil, readLeaderLock, writeLeaderLock,
  }
  } catch (e) {
    try {
      server.stdout.destroy()
      server.stderr.destroy()
    } catch (_) {
      /* 忽略 */
    }
    try {
      server.kill('SIGKILL')
    } catch (_) {
      /* 忽略 */
    }
    throw e
  }
}

/** 对应旧 finally：引擎连接池销毁 + 标记兜底清理 + kill server 等端口释放 + 删临时目录 */
export async function teardownShard(ctx) {
  try {
    if (global.window && global.window.services && typeof global.window.services.cleanup === 'function') {
      global.window.services.cleanup()
    }
  } catch (_) {
    /* 忽略 */
  }
  const allFlags = [
    '.wdsync-test-noetag',
    '.wdsync-test-redirect',
    '.wdsync-test-ratelimit',
    '.wdsync-test-xmlstyle',
    '.wdsync-test-profile',
    '.wdsync-test-midair',
    '.wdsync-test-badxml',
    '.wdsync-test-bigxml',
    '.wdsync-test-captheaders',
    '.wdsync-test-captheaders.log',
    '.wdsync-test-err503',
    '.wdsync-test-ro-subpaths',
    '.wdsync-test-mkcolfail',
    '.wdsync-test-fail413',
    '.wdsync-test-fail423',
    '.wdsync-test-fail423x',
    '.wdsync-test-reqlog',
    '.wdsync-test-reqlog.log',
    '.wdsync-test-vanish',
    '.wdsync-test-locksteal',
    '.wdsync-test-delefail',
    '.wdsync-test-dedupfail',
    '.wdsync-test-throttle',
    '.wdsync-test-casepair',
    // etag 子树跳过与 depth-infinity 的探测标记（正常路径由
    // B3 / ES / DP 各节自己的 finally 清理，此处兜底防异常路径泄漏给后续节）
    '.wdsync-test-depthlog',
    '.wdsync-test-depthlog.log',
    '.wdsync-test-noinfinity',
    '.wdsync-test-shallowinf',
    '.wdsync-test-root404prop',
    '.wdsync-test-etagprop',
  ]
  for (const flag of allFlags) {
    await fsp.rm(path.join(ctx.ROOT, flag), { force: true }).catch(() => {})
  }
  try {
    ctx.server.stdout.destroy()
    ctx.server.stderr.destroy()
  } catch (_) {
    /* 忽略 */
  }
  ctx.server.kill()
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 2000)
    ctx.server.once('exit', () => {
      clearTimeout(t)
      resolve()
    })
  })
  await fsp.rm(ctx.LOCAL, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(path.join(ctx.ROOT, '.wdsync-test-noetag'), { force: true }).catch(() => {})
  http.globalAgent.destroy()
  https.globalAgent.destroy()
}
