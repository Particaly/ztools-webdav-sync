/**
 * 同步轮基准：数万文件规模下的扫描 / 规划 / 无变化轮耗时与内存。
 * 与 bench-saxes（纯解析基准）互补，这里跑的是完整引擎路径：
 *   本地扫描（scanDirSafe）/ 远端扫描（listRemoteSafe，逐目录与 Depth:infinity 两种
 *   形态各测一遍）/ 首轮 adopt 建基线（零传输）/ 无变化轮（完整 syncDirectory）。
 *
 * 场景构造：本地与远端（dav-server 的 ROOT）各落 N 个内容一致、mtime 对齐（固定
 * 时间戳）的小文件 → 首轮按 size+mtime 直接 adopt（不触发 hash 消歧、零传输），
 * 基线建立后即得到纯净的「无变化轮」。文件数与目录数可参：
 *   node --expose-gc test/bench-round.mjs [files] [dirs]
 *   （默认 50000 文件 / 500 目录 = 每目录 100 文件；--expose-gc 可选，内存数据更准）
 *
 * 注意：dav-server 跑在本机回环，网络成本≈0 —— 数字反映引擎与解析开销的上界
 * 估计（真实广域网下远端扫描受 RTT 支配，逐目录形态差距会进一步放大）。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const N = Number(process.argv[2]) || 50000
const DIRS = Number(process.argv[3]) || 500
const PORT = 5361
const perDir = Math.ceil(N / DIRS)

const gc = typeof globalThis.gc === 'function' ? globalThis.gc : null
const mu = () => process.memoryUsage()
const fmtMB = (b) => `${(b / 1048576).toFixed(1)}MB`
const hr = async (fn) => {
  const t0 = process.hrtime.bigint()
  const r = await fn()
  return [Number(process.hrtime.bigint() - t0) / 1e6, r]
}
const best = (arr) => Math.min(...arr)

/** 采样器：阶段前后的 rss/heap 差值 + 采样峰值（onProgress 回调内取 max） */
function sampler() {
  const st = { before: mu(), peak: mu(), after: null }
  return {
    sample() {
      const m = mu()
      if (m.heapUsed > st.peak.heapUsed) st.peak = m
      if (m.rss > st.peak.rss) st.peak = m
    },
    done() {
      st.after = mu()
      return {
        rssDelta: st.after.rss - st.before.rss,
        heapDelta: st.after.heapUsed - st.before.heapUsed,
        peakRss: st.peak.rss,
        peakHeap: st.peak.heapUsed,
      }
    }
  }
}
const report = (key, ms, mem) =>
  console.log(
    `${key}: ${ms.toFixed(0)}ms` +
      (mem ? ` | rssΔ=${fmtMB(mem.rssDelta)} heapΔ=${fmtMB(mem.heapDelta)} peakHeap=${fmtMB(mem.peakHeap)} peakRss=${fmtMB(mem.peakRss)}` : '')
  )

// ---- 起迷你 DAV 服务器（独立端口与根目录，不碰 e2e 的 .dav-root）----
const davRoot = path.join(os.tmpdir(), `wdsync-bench-dav-${Date.now()}`)
const localRoot = path.join(os.tmpdir(), `wdsync-bench-local-${Date.now()}`)
const storeRoot = path.join(os.tmpdir(), `wdsync-bench-store-${Date.now()}`)
const server = spawn(process.execPath, [path.join(HERE, 'dav-server.mjs'), String(PORT), davRoot], { stdio: 'pipe' })
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('dav start timeout')), 5000)
  server.stdout.on('data', (d) => {
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
  server.stderr.on('data', (d) => console.error('[dav]', String(d)))
})

try {
  // ---- 加载 preload 引擎（源码形态）----
  globalThis.window = {}
  await import(pathToFileURL(path.join(HERE, '..', 'src-ztools', 'preload', 'services.mts')).href)
  const services = globalThis.window.services
  await services.storage.setRootForTest(storeRoot)
  const cfg = { serverUrl: `http://127.0.0.1:${PORT}/dav/`, username: 'u', password: 'p' }
  const dirCfg = { id: 'bench', localPath: localRoot, remotePath: '/bench', mode: 'two-way' }
  const prefs = { ignoreHidden: true, concurrency: 4, conflictStrategy: 'ask' }
  const setProfile = (p) => {
    if (p) fs.writeFileSync(path.join(davRoot, '.wdsync-test-profile'), p)
    else fs.rmSync(path.join(davRoot, '.wdsync-test-profile'), { force: true })
  }
  console.log(
    `bench-round: files=${N} dirs=${DIRS} (每目录 ${perDir}) node=${process.version} gc=${gc ? 'on' : 'off'} machine=${os.platform()}/${os.cpus()[0].model}`
  )

  // ---- 造树：本地与远端各 N 个小文件，内容一致、mtime 固定对齐（adopt 不触发 hash）----
  {
    const t0 = Date.now()
    const FIXED = new Date(1700000000000)
    const mkTree = async (base) => {
      fs.mkdirSync(base, { recursive: true })
      for (let d = 0; d < DIRS; d++) {
        const dirPath = path.join(base, `d${d}`)
        fs.mkdirSync(dirPath, { recursive: true })
        const files = []
        for (let i = 0; i < perDir; i++) {
          const idx = d * perDir + i
          if (idx >= N) break
          const p = path.join(dirPath, `f${idx}.txt`)
          fs.writeFileSync(p, `bench-content-${idx}-${'x'.repeat(idx % 97)}`)
          files.push(p)
        }
        await Promise.all(files.map((p) => fsp.utimes(p, FIXED, FIXED)))
      }
    }
    await mkTree(localRoot)
    await mkTree(path.join(davRoot, 'bench'))
    console.log(`setup: 两棵树各 ${N} 文件就绪（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
  }

  // ---- 1. 本地扫描 ×3 取最好 ----
  {
    const times = []
    let mem = null
    for (let r = 0; r < 4; r++) {
      if (gc) gc()
      const s = sampler()
      const [ms, scan] = await hr(() => services.sync._internals.scanDirSafe(localRoot, true))
      s.sample()
      mem = s.done()
      if (r > 0 && scan.complete && scan.files.size === N) times.push(ms)
      else if (r > 0) console.log(`  (warn) scan r${r}: complete=${scan.complete} count=${scan.files.size}`)
    }
    report(`local-scan x${times.length} best`, best(times), mem)
  }

  // ---- 2. 远端扫描：逐目录（p1）×3 ----
  setProfile('p1')
  {
    const times = []
    let mem = null
    for (let r = 0; r < 4; r++) {
      if (gc) gc()
      const s = sampler()
      const [ms, scan] = await hr(() => services.sync._internals.listRemoteSafe(cfg, '/bench', true))
      s.sample()
      mem = s.done()
      if (r > 0 && scan.complete) times.push(ms)
    }
    report(`remote-scan per-dir (501 请求) x${times.length} best`, best(times), mem)
  }

  // ---- 3. 首轮 adopt（p1 逐目录形态；零传输，建基线）----
  let adoptMs = 0
  let adoptMem = null
  {
    if (gc) gc()
    const s = sampler()
    const phases = { scanDoneAt: 0 }
    const t0 = Date.now()
    const [ms, sum] = await hr(() =>
      services.sync.syncDirectory(cfg, dirCfg, prefs, {
        onProgress: (p) => {
          s.sample()
          if (p.phase === 'plan' && !phases.scanDoneAt) phases.scanDoneAt = Date.now()
        },
      })
    )
    adoptMs = ms
    adoptMem = s.done()
    console.log(
      `first-round adopt (per-dir, 零传输): ${ms.toFixed(0)}ms（扫描段 ${(phases.scanDoneAt - t0).toFixed(0)}ms / 规划+收尾 ${(Date.now() - phases.scanDoneAt).toFixed(0)}ms）` +
        ` | adopted=${sum.adopted} totalFiles=${sum.totalFiles} errors=${sum.errors.length} | rssΔ=${fmtMB(adoptMem.rssDelta)} heapΔ=${fmtMB(adoptMem.heapDelta)} peakHeap=${fmtMB(adoptMem.peakHeap)}`
    )
  }

  // ---- 4. 无变化轮（p1 逐目录）×3：完整 syncDirectory ----
  const roundTimes = { perDir: [], inf: [] }
  const roundPeak = { perDir: 0, inf: 0 }
  const scanSplits = { perDir: [], inf: [] }
  {
    for (let r = 0; r < 4; r++) {
      if (gc) gc()
      const s = sampler()
      const t0 = Date.now()
      let scanDoneAt = 0
      const sum = await services.sync.syncDirectory(cfg, dirCfg, prefs, {
        onProgress: (p) => {
          s.sample()
          if (p.phase === 'plan' && !scanDoneAt) scanDoneAt = Date.now()
        },
      })
      const ms = Date.now() - t0
      if (sum.uploaded === 0 && sum.downloaded === 0 && sum.errors.length === 0 && sum.adopted === 0) {
        if (r > 0) {
          roundTimes.perDir.push(ms)
          scanSplits.perDir.push(scanDoneAt - t0)
        }
      } else {
        console.log(`  (warn) per-dir no-change r${r} 非纯净: ${JSON.stringify({ u: sum.uploaded, d: sum.downloaded, a: sum.adopted, e: sum.errors.length })}`)
      }
      roundPeak.perDir = Math.max(roundPeak.perDir, s.done().peakHeap)
    }
    report(
      `no-change round (p1 逐目录) x${roundTimes.perDir.length} best`,
      best(roundTimes.perDir),
      { rssDelta: 0, heapDelta: 0, peakHeap: roundPeak.perDir, peakRss: 0 }
    )
    console.log(`  → 其中扫描段（轮起到首个 plan 事件）best=${best(scanSplits.perDir).toFixed(0)}ms，规划+收尾≈${(best(roundTimes.perDir) - best(scanSplits.perDir)).toFixed(0)}ms`)
  }

  // ---- 5. 切 p9：Depth:infinity 单请求扫描 ----
  setProfile('p9')
  {
    await services.dav.probeCapabilities(cfg, true, '/bench')
    const times = []
    let mem = null
    for (let r = 0; r < 4; r++) {
      if (gc) gc()
      const s = sampler()
      const [ms, scan] = await hr(() => services.sync._internals.listRemoteSafe(cfg, '/bench', true, null, { depthInfinity: true }))
      s.sample()
      mem = s.done()
      if (r > 0 && scan.complete && scan.depth === 'infinity') times.push(ms)
      else if (r > 0) console.log(`  (warn) inf-scan r${r}: complete=${scan.complete} depth=${scan.depth}`)
    }
    report(`remote-scan infinity (1 请求) x${times.length} best`, best(times), mem)

    for (let r = 0; r < 4; r++) {
      if (gc) gc()
      const s = sampler()
      const t0 = Date.now()
      let scanDoneAt = 0
      const sum = await services.sync.syncDirectory(cfg, dirCfg, prefs, {
        onProgress: (p) => {
          s.sample()
          if (p.phase === 'plan' && !scanDoneAt) scanDoneAt = Date.now()
        },
      })
      const ms = Date.now() - t0
      if (sum.uploaded === 0 && sum.downloaded === 0 && sum.errors.length === 0 && sum.adopted === 0) {
        if (r > 0) {
          roundTimes.inf.push(ms)
          scanSplits.inf.push(scanDoneAt - t0)
        }
      } else {
        console.log(`  (warn) inf no-change r${r} 非纯净: ${JSON.stringify({ u: sum.uploaded, d: sum.downloaded, e: sum.errors.length })}`)
      }
      roundPeak.inf = Math.max(roundPeak.inf, s.done().peakHeap)
    }
    report(
      `no-change round (p9 infinity 单请求) x${roundTimes.inf.length} best`,
      best(roundTimes.inf),
      { rssDelta: 0, heapDelta: 0, peakHeap: roundPeak.inf, peakRss: 0 }
    )
    console.log(`  → 其中扫描段 best=${best(scanSplits.inf).toFixed(0)}ms，规划+收尾≈${(best(roundTimes.inf) - best(scanSplits.inf)).toFixed(0)}ms`)
    console.log(`  → 单请求 vs 逐目录：无变化轮 ${best(roundTimes.inf).toFixed(0)}ms vs ${best(roundTimes.perDir).toFixed(0)}ms`)
  }
  setProfile(null)
} finally {
  server.stdout.destroy()
  server.stderr.destroy()
  server.kill()
  await fsp.rm(davRoot, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(localRoot, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(storeRoot, { recursive: true, force: true }).catch(() => {})
}
