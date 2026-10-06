/**
 * e2e 分片：网络层新能力 —— Digest 认证（DG）/ 带宽限速（BW）/ HTTP 代理（PX）/
 * 多账号多服务器（MS，调度器 servers[] 解析与目录 serverId 挂载）。
 * 单元级直检（挑战解析 / RFC 2617 向量 / netOpts 解析）见 test/unit/digest-net.test.mjs。
 */
import { afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  setupShard,
  teardownShard,
  section,
  check,
  sleep,
  isNoop,
  SP,
} from './harness.mjs'

const PORT2 = 5390 // 第二台 dav-server（MS 多服务器用例）
const PORT_TLS = 5391 // TLS dav-server（PX 的 https-over-CONNECT 用例）
const PORT_PXY = 5392 // 迷你测试代理

const ctx = await setupShard({ shard: 'net', port: 5389 })
const { services, cfg, ROOT, PORT, LOCAL, freshStore, tmpLocal, syncP, createTestSched, SC_DB, SC_KEY, switchDevice, STORAGE_MAIN } = ctx
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

// ---- 调度器系列共享的假宿主挂载（模式与 shard-sched 相同） ----
// trash 桩先装（deleteLocalOne 依赖 shellTrashItem）；mountScDb 在其上叠加
// dbStorage（SC_DB 后备 = 配置权威通道），scheduler 测试实例据此自举。
const TRASH_DIR = path.join(LOCAL, '..', `wdsync-net-trash-${Date.now()}`)
{
  await fsp.mkdir(TRASH_DIR, { recursive: true })
  global.window.ztools = {
    shellTrashItem: async (p) => {
      const dest = path.join(TRASH_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(p)}`)
      await fsp.rename(p, dest)
    },
  }
}
const mountScDb = () => {
  const prevTrash = global.window.ztools && global.window.ztools.shellTrashItem
  global.window.ztools = {
    dbStorage: { getItem: (k) => (k in SC_DB ? SC_DB[k] : null), setItem: (k, v) => { SC_DB[k] = v } },
    ...(prevTrash ? { shellTrashItem: prevTrash } : {}),
  }
}

/** spawn 一个 dav-server（plain http / TLS 由 cert 参数决定）；resolve 端口就绪句柄 */
const spawnDav = async (tag, port, cert, key) => {
  const root = path.join(ctx.HERE, `.dav-root-${tag}`)
  await fsp.rm(root, { recursive: true, force: true })
  const child = spawn(process.execPath, [path.join(ctx.HERE, 'dav-server.mjs'), String(port), root, ...(cert && key ? [cert, key] : [])], {
    stdio: 'pipe',
    env: { ...process.env, WDSYNC_DAV_EXIT_WITH: String(process.pid) },
  })
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`dav-server ${tag} start timeout`)), 15000)
    child.stdout.on('data', (d) => {
      if (String(d).includes('listening')) {
        clearTimeout(t)
        resolve()
      }
    })
    child.stderr.on('data', (d) => console.error(`[dav-${tag}]`, String(d)))
  })
  return { child, root }
}
const killDav = async (h) => {
  try {
    h.child.stdout.destroy()
    h.child.stderr.destroy()
  } catch {
    /* 忽略 */
  }
  h.child.kill()
  await fsp.rm(h.root, { recursive: true, force: true }).catch(() => {})
}

/**
 * 迷你 HTTP 代理（测试内自建，无外部依赖）：
 *   http 目标 —— 绝对 URI 请求原样转发（转发行记入 log）；
 *   https 目标 —— CONNECT 建立双向隧道（CONNECT 行记入 log）。
 * 供 PX 用例断言「请求确实经过代理」与「CONNECT 隧道承载 TLS」。
 */
const startTestProxy = async (port) => {
  const log = []
  const srv = http.createServer((req, res) => {
    log.push(`FWD ${req.method} ${req.url}`)
    let target
    try {
      target = new URL(req.url)
    } catch {
      res.writeHead(400).end()
      return
    }
    const proxied = http.request(
      {
        method: req.method,
        host: target.hostname,
        port: Number(target.port) || 80,
        path: target.pathname + target.search,
        headers: { ...req.headers, host: target.host },
      },
      (pr) => {
        res.writeHead(pr.statusCode, pr.headers)
        pr.pipe(res)
      }
    )
    proxied.on('error', (e) => {
      log.push(`ERR ${e && e.message}`)
      try {
        res.writeHead(502).end()
      } catch {
        /* 连接已断 */
      }
    })
    req.pipe(proxied)
  })
  srv.on('connect', (req, clientSock, head) => {
    log.push(`CONNECT ${req.url}`)
    const idx = String(req.url).lastIndexOf(':')
    const host = String(req.url).slice(0, idx)
    const port = Number(String(req.url).slice(idx + 1)) || 443
    const upstream = net.connect({ host, port }, () => {
      clientSock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length) upstream.write(head)
      upstream.pipe(clientSock)
      clientSock.pipe(upstream)
    })
    upstream.on('error', () => clientSock.destroy())
    clientSock.on('error', () => upstream.destroy())
  })
  await new Promise((resolve) => srv.listen(port, '127.0.0.1', resolve))
  return { srv, log }
}

// ============================================================
// DG：Digest 认证（只支持 Digest 的服务器）
// ============================================================

section('DG：Digest 认证的 401 挑战应答与挑战缓存复用', async () => {
  fs.writeFileSync(path.join(ROOT, '.wdsync-test-digest'), 'u:p')
  try {
    await freshStore('dg')
    // 连接测试：Basic 被拒 → 挑战 → Digest 应答成功
    const t1 = await services.dav.testConnection(cfg)
    check('DG 连接测试经 Digest 协商成功', t1.ok === true, String(t1.error || '').slice(0, 80))
    const cacheAfterTest = services.sync._internals.digestChallenges
    check('DG 挑战已按 origin+账号缓存', cacheAfterTest.size >= 1)

    // 完整同步轮：上传 / 下载 / 锁文件全部经 Digest（预带头复用缓存挑战）
    const lp = await tmpLocal('dg')
    await fsp.writeFile(path.join(lp, 'digest.txt'), 'digest-round-content')
    const s1 = await syncP(lp, '/dg')
    check('DG 首轮上传成功', s1.uploaded === 1, JSON.stringify({ up: s1.uploaded, err: (s1.errors || [])[0] }))
    check('DG 远端落盘', fs.existsSync(path.join(ROOT, 'dg', 'digest.txt')))
    const s2 = await syncP(lp, '/dg')
    check('DG 次轮收敛（挑战缓存下 nc 递增不炸 nonce）', isNoop(s2) || s2.adopted > 0 || s2.uploaded === 0, JSON.stringify({ up: s2.uploaded }))

    // 错误密码：Digest 应答被拒 → 401 以「用户名或密码不正确」上抛（不再无限重试）
    const t2 = await services.dav.testConnection({ ...cfg, password: 'wrong' })
    check('DG 错误密码明确失败', t2.ok === false)
    check('DG 失败文案指向凭据', /密码/.test(String(t2.error || '')), String(t2.error || '').slice(0, 80))
  } finally {
    await fsp.rm(path.join(ROOT, '.wdsync-test-digest'), { force: true }).catch(() => {})
  }
})

// ============================================================
// BW：带宽限速（上传 / 下载字节令牌桶）
// ============================================================

/** 造一个 sizeKB KB 的填充文件 */
const bwFile = async (lp, name, sizeKB, ch) => {
  const b = Buffer.alloc(sizeKB * 1024)
  b.fill(ch)
  await fsp.writeFile(path.join(lp, name), b)
  return b
}

section('BW：上传 / 下载带宽限速的总量约束', async () => {
  await freshStore('bw')
  const lpUp = await tmpLocal('bw-up')
  await bwFile(lpUp, 'big.bin', 128, 'U')

  // 预热一轮：首轮含能力探测等一次性开销，不计入基线
  await syncP(lpUp, '/bw')

  // 不限速基线：128KB 本地往返应在 2s 内完成（localhost 单文件轮）
  await fsp.writeFile(path.join(lpUp, 'more.bin'), Buffer.alloc(1024, 7))
  const t0 = Date.now()
  const sFast = await syncP(lpUp, '/bw')
  const fastMs = Date.now() - t0
  check('BW 不限速基线上传成功', sFast.uploaded === 1)
  check('BW 不限速基线耗时可忽略', fastMs <= 2000, `${fastMs}ms`)

  // 上传限速 32KB/s：128KB - 初始突发 32KB → 剩余 96KB ≈ 3s
  const lpLim = await tmpLocal('bw-lim')
  await bwFile(lpLim, 'big.bin', 128, 'L')
  const t1 = Date.now()
  const sLim = await services.sync.syncDirectory(
    { ...cfg, netOpts: { uploadKBps: 32 } },
    { id: 'p', localPath: lpLim, remotePath: '/bw-lim', mode: 'two-way' },
    SP,
    {}
  )
  const limMs = Date.now() - t1
  check('BW 限速上传最终成功', sLim.uploaded === 1)
  check('BW 限速显著拖慢上传（令牌桶生效）', limMs >= 2500, `${limMs}ms`)
  check('BW 限速远端内容完整', fs.statSync(path.join(ROOT, 'bw-lim', 'big.bin')).size === 128 * 1024)

  // 下载限速 32KB/s：远端 128KB → 新本地目录拉取
  const lpDl = await tmpLocal('bw-dl')
  const t2 = Date.now()
  const sDl = await services.sync.syncDirectory(
    { ...cfg, netOpts: { downloadKBps: 32 } },
    { id: 'p', localPath: lpDl, remotePath: '/bw-lim', mode: 'two-way' },
    SP,
    {}
  )
  const dlMs = Date.now() - t2
  check('BW 限速下载成功', sDl.downloaded === 1)
  check('BW 限速显著拖慢下载', dlMs >= 2500, `${dlMs}ms`)
  check('BW 限速下载内容完整', fs.statSync(path.join(lpDl, 'big.bin')).size === 128 * 1024)

  // 桶按 origin × 方向分键：同源上传桶残留不影响不限速请求（后续请求不取桶）
  const t3 = Date.now()
  const s3 = await syncP(lpUp, '/bw')
  check('BW 关闭限速后恢复全速', isNoop(s3) && Date.now() - t3 <= 2000)
})

// ============================================================
// PX：HTTP 代理（http 绝对 URI 转发 + https CONNECT 隧道）
// ============================================================

section('PX：HTTP 代理的两种目标形态', async () => {
  const proxy = await startTestProxy(PORT_PXY)
  const tlsServer = await spawnDav('net-tls', PORT_TLS, path.join(FIXTURES, 'self-signed.crt'), path.join(FIXTURES, 'self-signed.key'))
  try {
    await freshStore('px')
    // http 目标：绝对 URI 经代理转发
    const cfgPx = { ...cfg, netOpts: { proxyUrl: `http://127.0.0.1:${PORT_PXY}` } }
    const t1 = await services.dav.testConnection(cfgPx)
    check('PX http 目标经代理连接成功', t1.ok === true, String(t1.error || '').slice(0, 80))
    check('PX 代理观察到转发请求', proxy.log.some((l) => l.startsWith('FWD ')), proxy.log.slice(0, 3).join(' | '))

    const lp = await tmpLocal('px')
    await fsp.writeFile(path.join(lp, 'px.txt'), 'via-proxy')
    const s1 = await services.sync.syncDirectory(cfgPx, { id: 'p', localPath: lp, remotePath: '/px', mode: 'two-way' }, SP, {})
    check('PX http 目标完整同步轮成功', s1.uploaded === 1, JSON.stringify({ up: s1.uploaded, err: (s1.errors || [])[0] }))
    check('PX 远端经代理落盘', fs.existsSync(path.join(ROOT, 'px', 'px.txt')))

    // https 目标：CONNECT 隧道 + 端到端 TLS（自签名证书经信任开关放行）
    const cfgTlsPx = {
      serverUrl: `https://127.0.0.1:${PORT_TLS}/dav/`,
      username: 'u',
      password: 'p',
      tls: { trustServerCertificate: true },
      netOpts: { proxyUrl: `http://127.0.0.1:${PORT_PXY}` },
    }
    const t2 = await services.dav.testConnection(cfgTlsPx)
    check('PX https 目标经 CONNECT 隧道连接成功', t2.ok === true, String(t2.error || '').slice(0, 80))
    check('PX 代理观察到 CONNECT 隧道', proxy.log.some((l) => l.startsWith(`CONNECT 127.0.0.1:${PORT_TLS}`)), proxy.log.filter((l) => l.startsWith('CONNECT')).slice(0, 2).join(' | '))
    const lp2 = await tmpLocal('px-tls')
    await fsp.writeFile(path.join(lp2, 'tls-px.txt'), 'tls-via-proxy')
    const s2 = await services.sync.syncDirectory(cfgTlsPx, { id: 'p', localPath: lp2, remotePath: '/px', mode: 'two-way' }, SP, {})
    check('PX https 目标完整同步轮成功', s2.uploaded === 1, JSON.stringify({ up: s2.uploaded, err: (s2.errors || [])[0] }))
    check('PX https 远端经隧道落盘', fs.existsSync(path.join(tlsServer.root, 'px', 'tls-px.txt')))

    // 关掉代理恢复直连（代理地址留空 = 直连；既有行为回归）
    const t3 = await services.dav.testConnection(cfg)
    check('PX 清空代理后直连正常', t3.ok === true)
  } finally {
    proxy.srv.close()
    await killDav(tlsServer)
  }
})

// ============================================================
// MS：多账号 / 多服务器（调度器 servers[] + 目录 serverId）
// ============================================================

section('MS：两台服务器并行同步与凭据隔离', async () => {
  const second = await spawnDav('net2', PORT2)
  try {
    mountScDb()
    await freshStore('ms')
    const lpA = await tmpLocal('ms-a')
    const lpB = await tmpLocal('ms-b')
    await fsp.writeFile(path.join(lpA, 'a.txt'), 'server-a-content')
    await fsp.writeFile(path.join(lpB, 'b.txt'), 'server-b-content')
    // servers[] 权威形态：两台服务器各自地址与凭据（密码混淆落「dbStorage」）；
    // 目录 da 显式挂 srv-a、db 显式挂 srv-b
    SC_DB[SC_KEY] = {
      servers: [
        { id: 'srv-a', serverUrl: `http://127.0.0.1:${PORT}/dav/`, username: 'u', password: services.secure.sealSecret('p') },
        { id: 'srv-b', serverUrl: `http://127.0.0.1:${PORT2}/dav/`, username: 'u', password: services.secure.sealSecret('p') },
      ],
      dirs: [
        { id: 'da', localPath: lpA, remotePath: '/ms-a', mode: 'two-way', serverId: 'srv-a' },
        { id: 'db', localPath: lpB, remotePath: '/ms-b', mode: 'two-way', serverId: 'srv-b' },
      ],
      prefs: { autoSync: false, intervalMin: 15, conflictStrategy: 'ask', ignoreHidden: true, concurrency: 4 },
    }
    const sched = createTestSched()
    const snap = await sched.init()
    check('MS 调度器就绪且两目录入列', snap.ready === true && snap.slots.length === 2)
    const r = await sched.syncNow()
    const perDir = (r && r.perDir) || []
    check('MS 两个目录全部同步成功', perDir.length === 2 && perDir.every((d) => d.ok === true), JSON.stringify(perDir))
    check('MS A 服务器落盘 a.txt', fs.existsSync(path.join(ROOT, 'ms-a', 'a.txt')))
    check('MS B 服务器落盘 b.txt', fs.existsSync(path.join(second.root, 'ms-b', 'b.txt')))
    check('MS A 服务器没有 B 的文件（凭据 / 内容不串）', !fs.existsSync(path.join(ROOT, 'ms-b')))
    check('MS B 服务器没有 A 的文件', !fs.existsSync(path.join(second.root, 'ms-a')))

    // 遗留 serverId 缺省 = 第一台（迁移语义）：dc 不写 serverId 应落到 srv-a
    SC_DB[SC_KEY] = {
      servers: [
        { id: 'srv-a', serverUrl: `http://127.0.0.1:${PORT}/dav/`, username: 'u', password: services.secure.sealSecret('p') },
        { id: 'srv-b', serverUrl: `http://127.0.0.1:${PORT2}/dav/`, username: 'u', password: services.secure.sealSecret('p') },
      ],
      dirs: [{ id: 'dc', localPath: lpA, remotePath: '/ms-c', mode: 'two-way' }],
      prefs: { autoSync: false, intervalMin: 15, conflictStrategy: 'ask', ignoreHidden: true, concurrency: 4 },
    }
    await sched.reload()
    const r2 = await sched.syncNow()
    const perDir2 = (r2 && r2.perDir) || []
    check('MS 缺省 serverId 的目录回落第一台服务器', perDir2.length === 1 && perDir2[0].ok === true && fs.existsSync(path.join(ROOT, 'ms-c', 'a.txt')))
    try {
      sched.cleanup()
    } catch {
      /* 收尾失败不影响断言 */
    }
  } finally {
    await killDav(second)
  }
})

// ============================================================
// 兜底：迁移回归（旧单 server 配置 → servers[] 迁移后照常工作）
// ============================================================

section('NET-MIG：旧单服务器配置迁移回归', async () => {
  mountScDb()
  await switchDevice(STORAGE_MAIN)
  const lp = await tmpLocal('net-mig')
  await fsp.writeFile(path.join(lp, 'mig.txt'), 'legacy-single-server')
  SC_DB[SC_KEY] = {
    server: { serverUrl: `http://127.0.0.1:${PORT}/dav/`, username: 'u', password: services.secure.sealSecret('p') },
    dirs: [{ id: 'dm', localPath: lp, remotePath: '/net-mig', mode: 'two-way' }],
    prefs: { autoSync: false, intervalMin: 15, conflictStrategy: 'ask', ignoreHidden: true, concurrency: 4 },
  }
  const sched = createTestSched()
  await sched.init()
  const r = await sched.syncNow()
  const perDir = (r && r.perDir) || []
  check('NET-MIG 旧形态配置同步成功（loadConfig 迁移为 servers[]）', perDir.length === 1 && perDir[0].ok === true, JSON.stringify(perDir))
  check('NET-MIG 迁移后文件落盘', fs.existsSync(path.join(ROOT, 'net-mig', 'mig.txt')))
  try {
    sched.cleanup()
  } catch {
    /* 收尾失败不影响断言 */
  }
})

afterAll(async () => {
  await teardownShard(ctx)
})
