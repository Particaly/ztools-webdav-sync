/**
 * 规划期 verify 实测基准（不进 npm test 门禁，只打印断言性输出、不 throw）。
 * 场景：noetag 服务器上 N 个文件仅远端 mtime 各 +40s（size 不变、
 * 无 etag）→ 第二轮全部进入 verify 并发池，每文件一次 GET 下载流式算 hash →
 * 内容相同 → 采纳新远端指纹（adopted=N）、零下载。
 * 分别在 concurrency 4 与 8 下各测一段：两段各自独立的本地目录 / 远端目录 / 存储根
 * （基线与噪声状态互不串扰），同一 dav-server 进程。
 * 输出一行汇总：N files | verify wall X ms | GET requests Y (expect N+N: hash下载即
 * GET 每文件一次，加上首轮以外无下载→verify 每文件 1 次 GET) | concurrency Z
 * 用法：node test/bench-verify.mjs [N]   （默认 300）
 */
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const N = Number(process.argv[2]) || 300
const PORT = 20000 + Math.floor(Math.random() * 20000)
const ROOT = path.join(os.tmpdir(), `wdsync-bench-verify-root-${Date.now()}`)
const TMP_BASE = path.join(os.tmpdir(), `wdsync-bench-verify-${Date.now()}`)
const REQLOG = path.join(ROOT, '.wdsync-test-reqlog.log')

// 行为标记：noetag（指纹退化为 size+mtime）+ reqlog（逐请求日志）。
// 在服务器启动前写好，全程保持启用（无跳变即无重置）。
await fsp.rm(ROOT, { recursive: true, force: true })
await fsp.mkdir(ROOT, { recursive: true })
fs.writeFileSync(path.join(ROOT, '.wdsync-test-noetag'), 'x')
fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')

const server = spawn(process.execPath, [path.join(HERE, 'dav-server.mjs'), String(PORT), ROOT], { stdio: 'pipe' })
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server start timeout')), 5000)
  server.stdout.on('data', (d) => {
    if (String(d).includes('listening')) {
      clearTimeout(t)
      resolve()
    }
  })
  server.stderr.on('data', (d) => console.error('[dav]', String(d)))
})

/** 断言性输出：只打印 PASS/FAIL，绝不 throw（基准脚本不充当测试门禁） */
const say = (ok, label, detail = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)

/** 读 reqlog 为行数组（元素形如 'METHOD /dav/path'）；无日志返回空数组 */
const readReqlog = async () =>
  (await fsp.readFile(REQLOG, 'utf-8').catch(() => '')).split('\n').filter(Boolean)

try {
  // 加载 preload 服务（伪造 window，与 bench-saxes 同一独立脚本风格）
  globalThis.window = {}
  await import(pathToFileURL(path.join(HERE, '..', 'src-ztools', 'preload', 'services.js')).href)
  const services = globalThis.window.services
  const cfg = { serverUrl: `http://127.0.0.1:${PORT}/dav/`, username: 'u', password: 'p' }

  /**
   * 单段实测（concurrency = c）：
   *   首轮全量上传（建立基线）→ 远端全部 mtime +40s → 第二轮捕获 plan 阶段
   *   verify 进度、按 reqlog 差分统计本轮 GET 请求数、记录墙钟耗时。
   */
  const segment = async (c) => {
    const tag = `c${c}`
    const localDir = path.join(TMP_BASE, `${tag}-local`)
    const storeRoot = path.join(TMP_BASE, `${tag}-store`)
    const remoteRel = `/verify-${tag}`
    const remotePrefix = `/dav${remoteRel}/` // reqlog 行的 urlPath 前缀（dav-server 挂载在 /dav/）
    await fsp.mkdir(localDir, { recursive: true })
    await fsp.mkdir(storeRoot, { recursive: true })
    await services.storage.setRootForTest(storeRoot) // 独立存储根：新 deviceId / 新基线 / 新噪声状态
    const dir = { id: tag, localPath: localDir, remotePath: remoteRel, mode: 'two-way' }
    const prefs = { ignoreHidden: true, concurrency: c, conflictStrategy: 'ask' }

    // 1) 生成 N 个小文件（每文件随机定长 256B~2KB），首轮全量上传建立基线
    for (let i = 0; i < N; i++) {
      const size = 256 + Math.floor(Math.random() * (2048 - 256 + 1))
      await fsp.writeFile(path.join(localDir, `f${i}.txt`), crypto.randomBytes(size))
    }
    const s1 = await services.sync.syncDirectory(cfg, dir, prefs, {})
    say(
      s1.uploaded === N && s1.errors.length === 0,
      `round1 uploads all ${N} files (concurrency ${c})`,
      `uploaded=${s1.uploaded} errors=${s1.errors.length} tier=${s1.tier}`
    )

    // 2) 远端全部文件 mtime 各 +40s：仅远端指纹变、size 同、无 etag（4.4-A 触发条件）
    const remoteDirAbs = path.join(ROOT, remoteRel.slice(1))
    const names = (await fsp.readdir(remoteDirAbs)).filter((n) => n.endsWith('.txt'))
    for (const n of names) {
      const p = path.join(remoteDirAbs, n)
      const t = new Date((await fsp.stat(p)).mtimeMs + 40000)
      await fsp.utimes(p, t, t)
    }

    // 3) 第二轮：plan 阶段进度捕获 + reqlog 差分计数 + 墙钟计时
    const logBefore = (await readReqlog()).length
    const planEvents = []
    const t0 = Date.now()
    const s2 = await services.sync.syncDirectory(cfg, dir, prefs, {
      onProgress: (p) => {
        if (p.phase === 'plan') planEvents.push({ ...p, at: Date.now() })
      },
    })
    const wallMs = Date.now() - t0
    const planSpanMs = planEvents.length > 1 ? planEvents[planEvents.length - 1].at - planEvents[0].at : 0
    const lastPlan = planEvents[planEvents.length - 1]
    const roundLines = (await readReqlog()).slice(logBefore)

    const gets = roundLines.filter((l) => l.startsWith(`GET ${remotePrefix}`) || l === `GET ${remotePrefix.slice(0, -1)}`)
    const fileGets = gets.filter((l) => !l.includes('.webdav-sync.lock')).length
    const lockGets = gets.length - fileGets

    // 4) 断言性输出（打印，不 throw）：verifyTotal / downloaded / adopted
    say(lastPlan != null && lastPlan.verifyTotal === N, 'verifyTotal === N', `verifyTotal=${lastPlan && lastPlan.verifyTotal} verifyDone=${lastPlan && lastPlan.verifyDone} planEvents=${planEvents.length}`)
    say(s2.downloaded === 0, 'round2 downloaded === 0', `downloaded=${s2.downloaded}`)
    say(s2.adopted === N && s2.errors.length === 0, 'round2 adopted === N with no errors', `adopted=${s2.adopted} errors=${s2.errors.length} warnings=${s2.warnings.length}`)
    console.log(
      `detail: planSpan=${planSpanMs}ms GET{file=${fileGets}, lock=${lockGets}} ` +
        `round2={uploaded:${s2.uploaded}, downloaded:${s2.downloaded}, adopted:${s2.adopted}}`
    )
    console.log(
      `SUMMARY ${N} files | verify wall ${wallMs} ms | GET requests ${gets.length} ` +
        `(expect N+N: hash下载即 GET 每文件一次，加上首轮以外无下载→verify 每文件 1 次 GET) | concurrency ${c}`
    )
  }

  await segment(4)
  await segment(8)
} catch (e) {
  console.error('bench-verify unexpected error:', e && e.stack ? e.stack : String(e))
} finally {
  // 收尾清理（参照 bench-saxes / sync-e2e）：销毁引擎连接池与全局 agent、清临时目录与标记、杀服务器
  try {
    if (globalThis.window && globalThis.window.services && typeof globalThis.window.services.cleanup === 'function') {
      globalThis.window.services.cleanup()
    }
  } catch (_) {
    /* 忽略 */
  }
  http.globalAgent.destroy()
  await fsp.rm(TMP_BASE, { recursive: true, force: true }).catch(() => {})
  for (const f of ['.wdsync-test-noetag', '.wdsync-test-reqlog', '.wdsync-test-reqlog.log']) {
    await fsp.rm(path.join(ROOT, f), { force: true }).catch(() => {})
  }
  await fsp.rm(ROOT, { recursive: true, force: true }).catch(() => {})
  try {
    server.stdout.destroy()
    server.stderr.destroy()
  } catch (_) {
    /* 忽略 */
  }
  server.kill()
}
