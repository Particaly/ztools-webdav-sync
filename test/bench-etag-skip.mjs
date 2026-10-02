/**
 * etag 子树跳过基准：坚果云形态（无 Depth:infinity 的 N+1 逐目录
 * 扫描）下，无变化轮的请求数 / 耗时在「改造前后」的对比。
 *
 * 对比形态（同一棵树、同一 dav-server，仅切换集合 etag 是否深层传播）：
 *   A. 现状形态 —— 关 .wdsync-test-etagprop（集合 etag 不传播，探测判
 *      etagPropagation=false）：引擎无法跳过，每轮仍 N+1 个 Depth:1 PROPFIND
 *      （= 改造前 / 不支持传播的服务器上的行为，行为零变化）；
 *   B. 跳过形态 —— 开 .wdsync-test-etagprop（传播验证通过）：无变化轮只列同步根
 *      一次，其余子目录全部按「父清单 etag 未变」跳过；
 *   C. B + watch 轮本地脏路径快速核对（hints 1 条脏路径）：本地侧零全量 walk。
 *
 * 每形态跑 3 轮无变化轮（丢弃首轮预热），取最好耗时；PROPFIND 请求数经
 * .wdsync-test-depthlog 逐轮清零统计（含每轮固定 1 个 Depth:0 根探测）。
 * 文件数与目录数可参：
 *   node --expose-gc test/bench-etag-skip.mjs [files] [dirs]
 *   （默认 2000 文件 / 100 目录；--expose-gc 可选）
 *
 * 注意：dav-server 跑在本机回环，网络成本≈0 —— 真实广域网（坚果云）下逐目录形态
 * 的请求差距会被 RTT 放大一个量级以上，本基准给出的是引擎侧开销的下界对比。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const N = Number(process.argv[2]) || 2000
const DIRS = Number(process.argv[3]) || 100
const PORT = 5362
const perDir = Math.ceil(N / DIRS)

const gc = typeof globalThis.gc === 'function' ? globalThis.gc : null
const fmtMB = (b) => `${(b / 1048576).toFixed(1)}MB`
const best = (arr) => Math.min(...arr)
const avg = (arr) => arr.reduce((a, b) => a + b, 0) / (arr.length || 1)

/** 轮前清零 depthlog、轮后统计本远端前缀的 PROPFIND 行（按深度分桶） */
const countDepth = (davRoot, urlPrefix) => {
  const log = path.join(davRoot, '.wdsync-test-depthlog.log')
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean) : []
  const hit = lines.filter((l) => l.includes(` ${urlPrefix}`))
  const d0 = hit.filter((l) => l.startsWith('DEPTH 0 ')).length
  const d1 = hit.filter((l) => l.startsWith('DEPTH 1 ')).length
  const inf = hit.filter((l) => l.startsWith('DEPTH inf ')).length
  return { total: hit.length, d0, d1, inf }
}
const clearDepthlog = (davRoot) => fs.rmSync(path.join(davRoot, '.wdsync-test-depthlog.log'), { force: true })

// ---- 起迷你 DAV 服务器（独立端口与根目录，不碰 e2e 的 .dav-root 与 bench-round 的 5361）----
const davRoot = path.join(os.tmpdir(), `wdsync-bench-es-dav-${Date.now()}`)
const localRoot = path.join(os.tmpdir(), `wdsync-bench-es-local-${Date.now()}`)
const storeRoot = path.join(os.tmpdir(), `wdsync-bench-es-store-${Date.now()}`)
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
  const setFlag = (name, on) => {
    const p = path.join(davRoot, name)
    if (on) fs.writeFileSync(p, '')
    else fs.rmSync(p, { force: true })
  }
  console.log(`bench-etag-skip: files=${N} dirs=${DIRS} (每目录 ${perDir}) node=${process.version} gc=${gc ? 'on' : 'off'} machine=${os.platform()}/${os.cpus()[0].model}`)

  // ---- 造树：本地与远端各 N 个小文件，内容一致、mtime 固定对齐（首轮 adopt 建基线，零传输）----
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
          fs.writeFileSync(p, `bench-es-content-${idx}-${'x'.repeat(idx % 97)}`)
          files.push(p)
        }
        await Promise.all(files.map((p) => fsp.utimes(p, FIXED, FIXED)))
      }
    }
    await mkTree(localRoot)
    await mkTree(path.join(davRoot, 'bench'))
    console.log(`setup: 两棵树各 ${N} 文件就绪（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
  }

  setFlag('.wdsync-test-depthlog', true)
  setFlag('.wdsync-test-etagprop', true) // 传播形态从种子轮起生效（scan-cache 收割真实集合 etag）

  /** 跑一轮并返回 { ms, sum, depth }；noChangeOnly=true 时校验轮次纯净 */
  const runRound = async (hints, noChangeOnly) => {
    const t0 = Date.now()
    clearDepthlog(davRoot)
    const sum = await services.sync.syncDirectory(cfg, dirCfg, prefs, hints ? { hints } : {})
    const ms = Date.now() - t0
    const depth = countDepth(davRoot, '/dav/bench')
    const pure = sum.uploaded === 0 && sum.downloaded === 0 && sum.errors.length === 0 && sum.adopted === 0
    if (noChangeOnly && !pure) console.log(`  (warn) 非纯净轮: ${JSON.stringify({ u: sum.uploaded, d: sum.downloaded, a: sum.adopted, e: sum.errors.length })}`)
    return { ms, sum, depth, pure }
  }

  // ---- 种子轮：adopt 建基线 + scan-cache 收割（全量下降）----
  {
    const caps = await services.dav.probeCapabilities(cfg, true, '/bench')
    const { ms, sum } = await runRound(null, false)
    console.log(`seed round (adopt 建基线): ${ms.toFixed(0)}ms adopted=${sum.adopted} 探测 etagPropagation=${caps.etagPropagation} depthInfinity=${caps.depthInfinity}`)
  }

  // ---- B. 跳过形态（传播验证通过）：无变化轮 ×3 ----
  {
    const times = []
    let skipped = 0
    let depth = null
    for (let r = 0; r < 4; r++) {
      if (gc) gc()
      const res = await runRound(null, true)
      if (r > 0 && res.pure) {
        times.push(res.ms)
        skipped = res.sum.scan ? res.sum.scan.skippedDirs : -1
        depth = res.depth
      }
    }
    console.log(
      `B 跳过形态 (etagPropagation=true): 无变化轮 best=${best(times).toFixed(0)}ms avg=${avg(times).toFixed(0)}ms x${times.length}` +
        ` | PROPFIND/轮 total=${depth ? depth.total : '?'} (Depth:0 根探测 ${depth ? depth.d0 : '?'} + Depth:1 列举 ${depth ? depth.d1 : '?'}) | skippedDirs=${skipped}/${DIRS}`
    )
  }

  // ---- A. 现状形态（服务器停止传播 = 改造前 / 不支持服务器行为零变化）：无变化轮 ×3 ----
  {
    setFlag('.wdsync-test-etagprop', false)
    const caps = await services.dav.probeCapabilities(cfg, true, '/bench') // 强制重探 → etagPropagation=false
    const times = []
    let depth = null
    for (let r = 0; r < 4; r++) {
      if (gc) gc()
      const res = await runRound(null, true)
      if (r > 0 && res.pure) {
        times.push(res.ms)
        depth = res.depth
      }
    }
    console.log(
      `A 现状形态 (etagPropagation=${caps.etagPropagation}): 无变化轮 best=${best(times).toFixed(0)}ms avg=${avg(times).toFixed(0)}ms x${times.length}` +
        ` | PROPFIND/轮 total=${depth ? depth.total : '?'} (Depth:0 ${depth ? depth.d0 : '?'} + Depth:1 ${depth ? depth.d1 : '?'}) | skippedDirs=0（预期）`
    )
  }

  // ---- C. B 形态 + watch 轮本地脏路径快速核对（本地零全量 walk）----
  {
    setFlag('.wdsync-test-etagprop', true)
    await services.dav.probeCapabilities(cfg, true, '/bench')
    await runRound(null, true) // 恢复跳过形态的 settle 轮（上一形态全量下降刷新了缓存，本身也可跳过）
    const times = []
    let scanInfo = null
    for (let r = 0; r < 4; r++) {
      if (gc) gc()
      // 脏路径指向一个未变化的真实文件：核对后无动作 —— 得到「本地零 walk + 远端跳过」的纯净无变化轮
      const res = await runRound({ source: 'watch', dirtyPaths: ['d0/f0.txt'] }, true)
      if (r > 0 && res.pure) {
        times.push(res.ms)
        scanInfo = res.sum.scan || null
      }
    }
    console.log(
      `C 跳过+本地脏路径 (watch 轮): 无变化轮 best=${best(times).toFixed(0)}ms avg=${avg(times).toFixed(0)}ms x${times.length}` +
        ` | scan=${JSON.stringify(scanInfo)}`
    )
  }
} finally {
  server.stdout.destroy()
  server.stderr.destroy()
  server.kill()
  await fsp.rm(davRoot, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(localRoot, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(storeRoot, { recursive: true, force: true }).catch(() => {})
}
