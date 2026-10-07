/**
 * e2e 分片：网络层新能力 —— Digest 认证（DG）/ 带宽限速（BW）/ HTTP 代理（PX）/
 * 多账号多服务器（MS，调度器 servers[] 解析与目录 serverId 挂载）。
 * 单元级直检（挑战解析 / RFC 2617 向量 / netOpts 解析）见 test/unit/digest-net.test.mjs。
 */
import { afterAll } from 'vitest'
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
  makeTrashStub,
  mountFakeDbStorage,
  spawnDav,
  killDav,
} from './harness.mjs'

const ctx = await setupShard({ shard: 'net' })
const { services, cfg, ROOT, PORT, LOCAL, freshStore, tmpLocal, syncP, createTestSched, SC_DB, SC_KEY, switchDevice, STORAGE_MAIN, waitReal, setThrottle } = ctx
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures')

// ---- 调度器系列共享的假宿主挂载（trash 桩先装，deleteLocalOne 依赖 shellTrashItem；
// mountScDb 在其上叠加 dbStorage（SC_DB 后备 = 配置权威通道），scheduler 测试实例据此
// 自举）—— 两桩均收敛到 harness 工厂 ----
const trash = makeTrashStub()
trash.install()
const mountScDb = () => mountFakeDbStorage(SC_DB)

/**
 * 迷你 HTTP 代理（测试内自建，无外部依赖；端口 0 = 内核随机分配，实际端口随句柄返回）：
 *   http 目标 —— 绝对 URI 请求原样转发（转发行记入 log）；
 *   https 目标 —— CONNECT 建立双向隧道（CONNECT 行记入 log）。
 * 供 PX 用例断言「请求确实经过代理」与「CONNECT 隧道承载 TLS」。
 */
const startTestProxy = async () => {
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
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve))
  return { srv, log, port: srv.address().port }
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
  const proxy = await startTestProxy()
  const tlsServer = await spawnDav({ tag: 'net-tls', cert: path.join(FIXTURES, 'self-signed.crt'), key: path.join(FIXTURES, 'self-signed.key') })
  try {
    await freshStore('px')
    // http 目标：绝对 URI 经代理转发
    const cfgPx = { ...cfg, netOpts: { proxyUrl: `http://127.0.0.1:${proxy.port}` } }
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
      serverUrl: `https://127.0.0.1:${tlsServer.port}/dav/`,
      username: 'u',
      password: 'p',
      tls: { trustServerCertificate: true },
      netOpts: { proxyUrl: `http://127.0.0.1:${proxy.port}` },
    }
    const t2 = await services.dav.testConnection(cfgTlsPx)
    check('PX https 目标经 CONNECT 隧道连接成功', t2.ok === true, String(t2.error || '').slice(0, 80))
    check('PX 代理观察到 CONNECT 隧道', proxy.log.some((l) => l.startsWith(`CONNECT 127.0.0.1:${tlsServer.port}`)), proxy.log.filter((l) => l.startsWith('CONNECT')).slice(0, 2).join(' | '))
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
  const second = await spawnDav({ tag: 'net2' })
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
        { id: 'srv-b', serverUrl: `http://127.0.0.1:${second.port}/dav/`, username: 'u', password: services.secure.sealSecret('p') },
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
        { id: 'srv-b', serverUrl: `http://127.0.0.1:${second.port}/dav/`, username: 'u', password: services.secure.sealSecret('p') },
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

// ============================================================
// NS：实时速率采样（调度器 1s 差分 → EMA → net-speed 事件）
// 网络层字节计数（PUT 请求体 / GET 响应体）的单元直检见 test/unit/net-speed.test.mjs
// ============================================================

section('NS：实时速率采样（net-speed 事件外发与归零停表）', async () => {
  mountScDb()
  await freshStore('ns')
  const lp = await tmpLocal('ns')
  // 6 × 512KB 上传量：本机回环速度下轮次只需数秒，1s 采样至少抓到一拍非零速率
  for (let i = 0; i < 6; i++) await fsp.writeFile(path.join(lp, `ns-${i}.bin`), Buffer.alloc(512 * 1024, i + 1))
  SC_DB[SC_KEY] = {
    server: { serverUrl: `http://127.0.0.1:${PORT}/dav/`, username: 'u', password: services.secure.sealSecret('p') },
    dirs: [{ id: 'dns', localPath: lp, remotePath: '/ns', mode: 'two-way' }],
    prefs: { autoSync: false, intervalMin: 15, conflictStrategy: 'ask', ignoreHidden: true, concurrency: 4 },
  }
  const sched = createTestSched()
  await sched.init()
  // 等本测试实例当选 leader：否则手动轮会委托给（迟自举的）生产挂载实例代跑，
  // 事件发到对方订阅者 —— 本用例断言的是本实例采样器的行为，必须自己跑轮
  const leaderOk = await waitReal(() => !!(sched.getSnapshot().leader || {}).isLeader, 20000)
  check('NS 测试实例当选 leader', leaderOk === true, JSON.stringify(sched.getSnapshot().leader || {}))
  const events = []
  const unsub = sched.subscribe((ev) => {
    if (ev.type === 'net-speed') events.push(ev)
  })
  try {
    const r = await sched.syncNow('dns')
    check('NS 上传轮成功', r && r.ok === true && fs.existsSync(path.join(ROOT, 'ns', 'ns-0.bin')), JSON.stringify(r || {}).slice(0, 120))
    // 轮次产生非零上传速率（本机回环轮次可能在 syncNow 返回后的下一个采样拍才外发，等待式断言）
    const nonzeroSeen = await waitReal(() => events.some((e) => e.upBps > 0), 15000)
    check('NS 轮次产生非零上传速率事件', nonzeroSeen, JSON.stringify(events.slice(0, 3)))
    // 轮末归零沿：EMA 衰减走完后补发一次全零事件（dirs 空），随后采样器停表不再发声
    const zeroSeen = await waitReal(() => events.some((e) => e.upBps === 0 && e.downBps === 0 && Object.keys(e.dirs || {}).length === 0), 15000)
    check('NS 轮末补发全零速率（归零沿）', zeroSeen, JSON.stringify(events.slice(-3)))
    const zerosBefore = events.filter((e) => e.upBps === 0 && e.downBps === 0 && Object.keys(e.dirs || {}).length === 0).length
    await sleep(3000)
    const zerosAfter = events.filter((e) => e.upBps === 0 && e.downBps === 0 && Object.keys(e.dirs || {}).length === 0).length
    check('NS 全零事件只发一次（采样器已停表）', zeroSeen && zerosAfter === 1 && zerosBefore === 1, `${zerosBefore} → ${zerosAfter}`)
  } finally {
    unsub()
    try {
      sched.cleanup()
    } catch {
      /* 收尾失败不影响断言 */
    }
  }
})

// ============================================================
// PB：传输进度按真实字节推进（大文件传输期间 bytesDone 逐块递增）
// 依赖 dav-server 的 .wdsync-test-throttle（路径含 throttle 的 GET/PUT 按 64KB 块
// × delay 节流）：把 4MB 单文件传输拉长到 ~0.8s，引擎节流出口（150ms）内必然
// 落下多个中间事件 —— 断言 bytesDone 在 (0, 总量) 区间内多次递进、单调不减、
// 终值恰为计划字节；上传（PUT 读流）与下载（GET 落盘流）两个方向都覆盖。
// ============================================================

section('PB：传输进度按真实字节推进', async () => {
  await freshStore('pb')
  const BIG = 4 * 1024 * 1024
  const collect = (events) => ({
    onProgress: (ev) => {
      if (ev.stage === 'transfer') events.push({ d: ev.bytesDone, t: ev.bytesTotal })
    },
  })
  /** 传输段事件序列的公共断言面（上传 / 下载共用）：单调、有中间递进、终值到位 */
  const assertByteProgress = (tag, events) => {
    check(`PB ${tag} 拿到传输段进度事件`, events.length >= 3, `共 ${events.length} 个`)
    check(`PB ${tag} 字节分母 = 计划传输量`, events.every((e) => e.t === BIG), `bytesTotal 集合 ${[...new Set(events.map((e) => e.t))].join(',')}`)
    const mono = events.every((e, i) => i === 0 || e.d >= events[i - 1].d)
    check(`PB ${tag} bytesDone 单调不减`, mono, events.map((e) => e.d).join(' → '))
    const mids = [...new Set(events.filter((e) => e.d > 0 && e.d < BIG).map((e) => e.d))]
    check(`PB ${tag} 传输中出现 ≥2 个中间字节值（不再按整文件跳变）`, mids.length >= 2, mids.join(','))
    check(`PB ${tag} 终值恰为计划字节（含尾差补齐）`, events[events.length - 1].d === BIG, `末值 ${events[events.length - 1].d}`)
  }

  // ---- 上传方向：PUT 读流逐块回调 ----
  const lpUp = await tmpLocal('pb-up')
  await fsp.writeFile(path.join(lpUp, 'big-throttle.bin'), Buffer.alloc(BIG, 8))
  await setThrottle(12)
  try {
    const upEvents = []
    const sUp = await syncP(lpUp, '/pb', null, collect(upEvents))
    check('PB 上传轮成功', sUp.uploaded === 1, JSON.stringify({ up: sUp.uploaded, err: (sUp.errors || [])[0] }))
    assertByteProgress('上传', upEvents)

    // ---- 下载方向：GET 落盘流逐块回调（新本地目录拉取同一大文件）----
    const lpDl = await tmpLocal('pb-dl')
    const dlEvents = []
    const sDl = await syncP(lpDl, '/pb', null, collect(dlEvents))
    check('PB 下载轮成功', sDl.downloaded === 1, JSON.stringify({ down: sDl.downloaded, err: (sDl.errors || [])[0] }))
    assertByteProgress('下载', dlEvents)
    check('PB 下载内容完整', fs.statSync(path.join(lpDl, 'big-throttle.bin')).size === BIG)
  } finally {
    await setThrottle(null)
  }
})

afterAll(async () => {
  await teardownShard(ctx)
})
