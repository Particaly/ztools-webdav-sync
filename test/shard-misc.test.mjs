/**
 * e2e 分片「misc」：解析与删除安全组（V1 / RD / RL / NE / FSW / X1-X5 / B1 / B3 / B4 / ES0-1 / DP / HP / DS1-6 / FN0-5）
 * 由 test/sync-e2e.mjs 机械拆分（节体逐字保留）；每文件独立 dav-server / 端口 / 根目录，
 * vitest 按文件并行、文件内保持原节顺序。共享基建见 test/harness.mjs。
 * 日常回归：npm run test:fast（跳过 slow tag）；等待组单独回归：npm run test:slow。
 */
import { test, afterAll } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setupShard, teardownShard, section, slowSection, check, sleep, isNoop, SP } from './harness.mjs'

const {
    HERE, ROOT, PORT, LOCAL, server, services, cfg, storeModule, BUILT, preloadPath,
    STORAGE_MAIN, STORAGE_A, STORAGE_B, STORAGE_C, STORAGE_D, switchDevice,
    baselineDirOf, setProfile, setMidair, freshStore, tmpLocal, syncP, settleStable, sweepCrashResidue, projDir,
    REQLOG, readReqlog, countReq, lastReqLine,
    DEPTHLOG, readDepthlog, countDepth, clearDepthFlags,
    setThrottle, waitForReqLine, waitAbortLine, runCancelRound, readWalOps, findTempResidue,
    PUP, setNetcut, setPartialPut, puBuf,
    SC_DB, SC_KEY, setSCConfig, createTestSched, makeFakeClock, waitReal, pumpUntil, readLeaderLock, writeLeaderLock,
  } = await setupShard({ shard: 'misc', port: 5379 })

  const TRASH_DIR = path.join(os.tmpdir(), `wdsync-e2e-trash-${Date.now()}-${process.pid}`)
  fs.mkdirSync(TRASH_DIR, { recursive: true })
  const trashLog = []
  let trashFailNext = 0
  let trashMissing = false
  const installTrash = () => {
    if (trashMissing) {
      delete global.window.ztools
      return
    }
    global.window.ztools = {
      shellTrashItem: async (p) => {
        trashLog.push(p)
        if (trashFailNext > 0) {
          trashFailNext--
          throw new Error('EACCES: permission denied (injected trash failure)')
        }
        const dest = path.join(TRASH_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(p)}`)
        await fsp.rename(p, dest)
      },
    }
  }
  installTrash()

  // ============================================================
  // V1：规划期 verify 并发化 + 进度外发（网络层重构追加需求）
  // noetag 档位 + 远端 mtime 扰动 → 4.4-A 逐文件内容校验进入并发池；
  // 断言 plan 阶段进度携带 verifyDone/verifyTotal，字节数按待校验文件 size 预估
  // ============================================================

  await section('V1：规划期 verify 并发化', async () => {
  const V1_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-v1-${Date.now()}`)
  const v1Dir = () => ({ id: 'v1', localPath: V1_LOCAL, remotePath: '/v1', mode: 'two-way' })
  fs.writeFileSync(path.join(ROOT, '.wdsync-test-noetag'), 'x')
  try {
    await fsp.mkdir(V1_LOCAL, { recursive: true })
    await fsp.writeFile(path.join(V1_LOCAL, 'p1.txt'), 'v1-one')
    await fsp.writeFile(path.join(V1_LOCAL, 'p2.txt'), 'v1-two!!')
    await services.sync.syncDirectory(cfg, v1Dir(), SP, {})
    const bumpV1 = async (name, deltaMs) => {
      const p = path.join(ROOT, 'v1', name)
      const t = new Date((await fsp.stat(p)).mtimeMs + deltaMs)
      await fsp.utimes(p, t, t)
    }
    await bumpV1('p1.txt', 40000)
    await bumpV1('p2.txt', 40000)
    const planEvents = []
    const v1sum = await services.sync.syncDirectory(cfg, v1Dir(), SP, {
      onProgress: (p) => {
        if (p.phase === 'plan') planEvents.push(p)
      },
    })
    const lastPlan = planEvents[planEvents.length - 1]
    check('V1 verify pool adopts both files without transfer', v1sum.downloaded === 0 && v1sum.adopted === 2, JSON.stringify(v1sum))
    check(
      'V1 plan progress carries verify counters and byte estimates',
      !!lastPlan &&
        lastPlan.verifyTotal === 2 &&
        lastPlan.verifyDone === 2 &&
        lastPlan.bytesTotal === 'v1-one'.length + 'v1-two!!'.length &&
        lastPlan.bytesDone === 'v1-one'.length + 'v1-two!!'.length,
      JSON.stringify(lastPlan)
    )
  } finally {
    await fsp.rm(path.join(ROOT, '.wdsync-test-noetag'), { force: true }).catch(() => {})
  }
  await fsp.rm(V1_LOCAL, { recursive: true, force: true }).catch(() => {})

  })

  // ============================================================
  // RD 系列：重定向跟随（6.5）
  // ============================================================

  await section('RD：重定向跟随', async () => {
  fs.writeFileSync(path.join(ROOT, '.wdsync-test-redirect'), 'x')
  // 跨源重定向源：任何请求都 302 到另一个源（127.0.0.1:9），引擎必须拒绝跟随
  const crossServer = http.createServer((req, res) => {
    req.resume()
    res.writeHead(302, { Location: 'http://127.0.0.1:9/dav/' }).end()
  })
  await new Promise((r) => crossServer.listen(PORT + 1, '127.0.0.1', r))
  try {
    await fsp.mkdir(path.join(ROOT, 'rd', 'sub'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'rd', 'sub', 'f.txt'), 'rd-content')
    // davRequest 直检：无尾斜杠的集合 PROPFIND → 301 → 同源跟随 → 207（方法与请求体保留）
    const rdRes = await services.sync._internals.davRequest(cfg, 'PROPFIND', '/rd', {
      headers: { Depth: '1', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    })
    check('RD same-origin redirect followed to 207 with body', rdRes.status === 207 && /multistatus/.test(String(rdRes.body && rdRes.body.toString('utf-8'))), `status=${rdRes.status}`)
    // 跨源重定向必须拒绝，且报错信息包含源与目标 URL
    let crossErr = null
    try {
      await services.sync._internals.davRequest({ serverUrl: `http://127.0.0.1:${PORT + 1}/dav/`, username: 'u', password: 'p' }, 'PROPFIND', 'x', {})
    } catch (e) {
      crossErr = e
    }
    check(
      'RD cross-origin redirect rejected (target in summary, source in detail)',
      !!crossErr && /另一个网站/.test(crossErr.message) && crossErr.message.includes('127.0.0.1:9') &&
        String(crossErr.detail || '').includes(`127.0.0.1:${PORT + 1}`),
      crossErr && crossErr.message
    )
    // 完整同步：引擎对集合请求已统一带尾斜杠，档位服务器不再触发重定向，流程照常成功
    const RD_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-rd-${Date.now()}`)
    await fsp.mkdir(RD_LOCAL, { recursive: true })
    const rdSum = await services.sync.syncDirectory(cfg, { id: 'rd', localPath: RD_LOCAL, remotePath: '/rd', mode: 'two-way' }, SP, {})
    check(
      'RD full sync works under redirect-flagged server',
      rdSum.downloaded === 1 && (await fsp.readFile(path.join(RD_LOCAL, 'sub', 'f.txt'), 'utf-8')) === 'rd-content',
      JSON.stringify(rdSum)
    )
    await fsp.rm(RD_LOCAL, { recursive: true, force: true }).catch(() => {})
  } finally {
    await fsp.rm(path.join(ROOT, '.wdsync-test-redirect'), { force: true }).catch(() => {})
    crossServer.close()
  }

  })

  // ============================================================
  // RL 系列：限流重试（6.7 / 6.6 Retry-After）
  // 前 3 次 PUT/GET 返回 429 + Retry-After: 1，之后放行；
  // PUT 属非幂等方法，仅在「服务端明确未处理」的 429 上重试 → 同步最终成功
  // ============================================================

  await section('RL：限流重试', async () => {
  fs.writeFileSync(path.join(ROOT, '.wdsync-test-ratelimit'), 'x')
  try {
    const RL_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-rl-${Date.now()}`)
    await fsp.mkdir(RL_LOCAL, { recursive: true })
    await fsp.writeFile(path.join(RL_LOCAL, 'a.txt'), 'rl-a')
    const rlT0 = Date.now()
    const rlSum = await services.sync.syncDirectory(cfg, { id: 'rl', localPath: RL_LOCAL, remotePath: '/rl', mode: 'two-way' }, SP, {})
    const rlMs = Date.now() - rlT0
    check(
      'RL rate-limited uploads eventually succeed',
      rlSum.uploaded === 1 && (await fsp.readFile(path.join(ROOT, 'rl', 'a.txt'), 'utf-8')) === 'rl-a',
      JSON.stringify(rlSum)
    )
    check('RL retry respected Retry-After=1s (three waits) in sane time', rlMs >= 2900 && rlMs < 20000, `${rlMs}ms`)
    await fsp.rm(RL_LOCAL, { recursive: true, force: true }).catch(() => {})
  } finally {
    await fsp.rm(path.join(ROOT, '.wdsync-test-ratelimit'), { force: true }).catch(() => {})
  }

  })

  // ============================================================
  // NE：传输中断的错误归类（网络故障 ≠ 本地读失败）
  // 回归：singleRequest 曾以「读流是否报过错」判定本地上传失败 —— 请求侧被销毁
  //（对端失联 → socket 空闲超时 → req.destroy(err)）时，pipeline 拆除会把同一错误
  // 传播进读流，网络卡顿被包装成 LOCAL_IO「文件暂时读不出来」（permanent，当轮
  // 不重试）。blackhole 档（收请求头后搁置不读不响应）制造该触发器；断言归类为
  // NETWORK（可重试），且真读失败（开流前文件消失）仍归 LOCAL_IO。
  // ============================================================

  await section('NE：传输中断归类（请求侧销毁 ≠ 本地读失败）', async () => {
  fs.writeFileSync(path.join(ROOT, '.wdsync-test-blackhole'), 'x')
  const NE_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-ne-${Date.now()}`)
  try {
    await fsp.mkdir(NE_LOCAL, { recursive: true })
    // 8MB 远超 loopback 套接字缓冲：对端不读时客户端写必然停滞 → 空闲超时 → req.destroy(err)
    await fsp.writeFile(path.join(NE_LOCAL, 'ne-big.bin'), Buffer.alloc(8 * 1024 * 1024, 7))
    const neCfg = { ...cfg, netOpts: { ...(cfg.netOpts || {}), idleTimeoutMs: 400 } }
    const neT0 = Date.now()
    let neErr = null
    try {
      await services.sync._internals.davRequest(neCfg, 'PUT', '/ne/ne-big.bin', { bodyFile: path.join(NE_LOCAL, 'ne-big.bin') })
    } catch (e) {
      neErr = e
    }
    check(
      'NE stalled-peer upload is classified as NETWORK (not the LOCAL_IO misread)',
      !!neErr && neErr.code === 'NETWORK' && neErr.permanent === false && !/暂时读不出来/.test(neErr.message) && Date.now() - neT0 < 15000,
      neErr && `${neErr.code} ${neErr.message} (${Date.now() - neT0}ms)`
    )
    // 真读失败（读流自身先报错）：bodyFile 指向目录 —— stat 通过、开流后首读 EISDIR
    // —— 读流先于请求侧报错 → 仍按 LOCAL_IO「文件暂时读不出来」归类（permanent 不变）
    const dirBody = path.join(NE_LOCAL, 'ne-dir-body')
    await fsp.mkdir(dirBody, { recursive: true })
    let dirErr = null
    try {
      await services.sync._internals.davRequest(neCfg, 'PUT', '/ne/ne-dir.bin', { bodyFile: dirBody })
    } catch (e) {
      dirErr = e
    }
    check(
      'NE genuine body-read failure still classified as LOCAL_IO',
      !!dirErr && dirErr.code === 'LOCAL_IO' && /暂时读不出来/.test(dirErr.message),
      dirErr && `${dirErr.code} ${dirErr.message}`
    )
  } finally {
    await fsp.rm(path.join(ROOT, '.wdsync-test-blackhole'), { force: true }).catch(() => {})
    await fsp.rm(NE_LOCAL, { recursive: true, force: true }).catch(() => {})
  }

  })

  // ============================================================
  // FSW：本地文件 IO 的 fs 解析接线（asar 补丁旁路）
  // 宿主（Electron）内应解析为未打补丁的 original-fs；Node 测试环境回落 node:fs。
  // 引擎全部本地 IO（stat / 扫描 / 读流 / 写流）都经 services 模块级 fs —— 接线
  // 一旦漏挂，.asar 路径会被 asar 视图当 0 字节虚拟条目（回归 2026-10 插件同步事故）
  // ============================================================

  await section('FSW：本地 fs 解析接线（original-fs 优先 / node:fs 回落）', async () => {
  const lfs = services.sync._internals.localFs
  check(
    'FSW resolved local fs is a full fs facade (statSync / streams / promises)',
    !!lfs && typeof lfs.statSync === 'function' && typeof lfs.createReadStream === 'function' && typeof lfs.createWriteStream === 'function' && !!lfs.promises,
    lfs ? 'resolved' : 'missing'
  )
  check(
    'FSW fallback path under plain Node resolves to node:fs (same module identity)',
    lfs === (await import('node:fs')).default,
    ''
  )
  })

  // ============================================================
  // X1 / X2：multistatus 解析容错（命名空间前缀 / CDATA / 实体 / 百分号编码 / 中文空格%23）
  // 预置含刁钻文件名的远端目录，逐风格断言 listRemote 解析；再在最奇异风格下完整同步
  // ============================================================

  await section('X1/X2：multistatus 解析容错', async () => {
  const XML_DIR = path.join(ROOT, 'xmlstyle')
  const tricky = [
    ['中 文.txt', 'tick-zh'],
    ['a&b.txt', 'tick-amp'],
    ['héro.txt', 'tick-e-acute'],
    ['tag#23.txt', 'tick-hash'],
    ['nested/深 &层.txt', 'tick-nested'],
  ]
  for (const [rel] of tricky) await fsp.mkdir(path.dirname(path.join(XML_DIR, rel)), { recursive: true })
  for (const [rel, content] of tricky) await fsp.writeFile(path.join(XML_DIR, rel), content)
  const trickyRels = tricky.map(([rel]) => rel).sort().join('|')
  try {
    // 扩展风格：hex（十六进制实体）与 cdataetag（CDATA 包裹的 getetag）两种新风格
    for (const style of ['d', 'plain', 'cdata', 'entity', 'hex', 'cdataetag', 'pct']) {
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-xmlstyle'), style)
      const files = await services.dav.list(cfg, '/xmlstyle', true)
      const got = Array.from(files.entries())
        .filter(([, v]) => !v.isDir)
        .map(([k]) => k)
        .sort()
        .join('|')
      check(`X1 xmlstyle '${style}' parses all tricky names`, got === trickyRels, got)
    }
    // CDATA etag（cdataetag 档）：etag 取值与普通 d: 档完全一致（CDATA 壳与实体都不泄漏进取值）
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-xmlstyle'), 'd')
    const etagPlainStyle = (await services.dav.list(cfg, '/xmlstyle', true)).get('中 文.txt')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-xmlstyle'), 'cdataetag')
    const etagCdataStyle = (await services.dav.list(cfg, '/xmlstyle', true)).get('中 文.txt')
    check(
      'X1 CDATA-wrapped etag parses to identical value',
      etagPlainStyle && !!etagPlainStyle.etag && etagPlainStyle.etag === etagCdataStyle.etag,
      `${etagPlainStyle && etagPlainStyle.etag} vs ${etagCdataStyle && etagCdataStyle.etag}`
    )
    // X2 完整同步（CDATA 风格）：远端 → 本地全部落地且内容一致
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-xmlstyle'), 'cdata')
    const X_LOCAL = path.join(os.tmpdir(), `wdsync-e2e-xml-${Date.now()}`)
    await fsp.mkdir(X_LOCAL, { recursive: true })
    const xSum = await services.sync.syncDirectory(cfg, { id: 'xml', localPath: X_LOCAL, remotePath: '/xmlstyle', mode: 'two-way' }, SP, {})
    let xAllOk = xSum.downloaded === 5
    for (const [rel, content] of tricky) {
      if ((await fsp.readFile(path.join(X_LOCAL, ...rel.split('/')), 'utf-8').catch(() => 'MISS')) !== content) xAllOk = false
    }
    check('X2 full sync lands tricky names under cdata style', xAllOk, JSON.stringify(xSum))
    // X2 上传方向：本地新增刁钻文件名 → remoteUrl 逐段编码落地 → 列表解析回显一致
    await fsp.writeFile(path.join(X_LOCAL, '上传 &新 #文件.txt'), 'upload-tricky')
    const xSum2 = await services.sync.syncDirectory(cfg, { id: 'xml', localPath: X_LOCAL, remotePath: '/xmlstyle', mode: 'two-way' }, SP, {})
    check(
      'X2 upload of tricky name lands on remote',
      xSum2.uploaded === 1 && (await fsp.readFile(path.join(XML_DIR, '上传 &新 #文件.txt'), 'utf-8').catch(() => 'MISS')) === 'upload-tricky',
      JSON.stringify(xSum2)
    )
    const xAfter = await services.dav.list(cfg, '/xmlstyle', true)
    check('X2 uploaded tricky name parses back in listing', xAfter.has('上传 &新 #文件.txt'), Array.from(xAfter.keys()).join('|'))
    await fsp.rm(X_LOCAL, { recursive: true, force: true }).catch(() => {})
  } finally {
    await fsp.rm(path.join(ROOT, '.wdsync-test-xmlstyle'), { force: true }).catch(() => {})
  }

  })

  // ============================================================
  // B1：超大目录响应 —— 一次生成 2000+ 条目走 listRemoteSafe（控制时长，不要求 5 万）
  // ============================================================

  await section('B1：超大目录（2050 条目）', async () => {
  const BIG_DIR = path.join(ROOT, 'bigdir')
  const BIG_N = 2050
  await fsp.mkdir(BIG_DIR, { recursive: true })
  for (let i = 0; i < BIG_N; i += 100) {
    // 分批并行写：既快又避免一次排进 2000+ 个线程池任务
    await Promise.all(Array.from({ length: Math.min(100, BIG_N - i) }, (_, k) => fsp.writeFile(path.join(BIG_DIR, `f${i + k}.txt`), 'x')))
  }
  const bigT0 = Date.now()
  const bigScan = await services.sync._internals.listRemoteSafe(cfg, '/bigdir', true)
  const bigMs = Date.now() - bigT0
  check('B1 large listing complete with all entries', bigScan.complete === true && bigScan.files.size === BIG_N, `count=${bigScan.files.size} complete=${bigScan.complete}`)
  check('B1 large listing finishes promptly', bigMs < 30000, `${bigMs}ms`)
  // B1 追加：本地扫描进度回调 —— 最终计数必然送达（节流豁免的末报），
  // 中途事件数远小于条目数（节流生效；250ms 间隔 + 2050 文件扫描通常只够发数个）
  const bigLocal = path.join(os.tmpdir(), `wdsync-e2e-biglocal-${Date.now()}`)
  await fsp.mkdir(bigLocal, { recursive: true })
  for (let i = 0; i < BIG_N; i += 100) {
    await Promise.all(Array.from({ length: Math.min(100, BIG_N - i) }, (_, k) => fsp.writeFile(path.join(bigLocal, `f${i + k}.txt`), 'x')))
  }
  const scanEvents = []
  const bigLocalScan = await services.sync._internals.scanDirSafe(bigLocal, true, null, (n) => scanEvents.push(n))
  check(
    'B1 local scan reports throttled progress with final count delivered',
    bigLocalScan.complete === true && bigLocalScan.files.size === BIG_N && scanEvents.length >= 1 && scanEvents[scanEvents.length - 1] === BIG_N && scanEvents.length < BIG_N,
    `events=${scanEvents.length} last=${scanEvents[scanEvents.length - 1]}`
  )
  await fsp.rm(BIG_DIR, { recursive: true, force: true }).catch(() => {})
  await fsp.rm(bigLocal, { recursive: true, force: true }).catch(() => {})
  })

  // ============================================================
  // B3 系列：Depth:infinity 单请求扫描 + 逐目录回落 + 浅响应阀门 +
  // 探测硬化。依赖 dav-server 的 .wdsync-test-depthlog（PROPFIND 深度日志）、
  // .wdsync-test-noinfinity（infinity 一律 403）与 .wdsync-test-shallowinf
  // （infinity 按 Depth:1 应答）三个标记，均用完即清。
  // ============================================================

  // [慢组登记原因] 多形态探测轮的真实 IO 马拉松（探测+回落+阀门+硬化 5 组）；depth-infinity 档位行为由 P9 覆盖、解析容错由 X1/X2 覆盖
  await slowSection('B3：Depth:infinity 单请求扫描 / 回落 / 浅响应阀门 / 探测硬化', '多形态探测轮的真实 IO 马拉松（探测+回落+阀门+硬化 5 组）；depth-infinity 档位行为由 P9 覆盖、解析容错由 X1/X2 覆盖', async () => {
  await setProfile('p9')
  try {
    await clearDepthFlags()
    await freshStore('b3')
    const B3_A = await tmpLocal('b3')
    // 远端先建两层树（top + d1/mid + d1/d2/leaf）
    await fsp.mkdir(path.join(ROOT, 'b3', 'd1', 'd2'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'b3', 'top.txt'), 'b3-top')
    await fsp.writeFile(path.join(ROOT, 'b3', 'd1', 'mid.txt'), 'b3-mid')
    await fsp.writeFile(path.join(ROOT, 'b3', 'd1', 'd2', 'leaf.txt'), 'b3-leaf')
    // B3a 探测：嵌套探测文件验证后判支持（p9 服务器真实递归列举）
    const b3caps = await services.dav.probeCapabilities(cfg, true, '/b3')
    check('B3a probe reports depthInfinity=true (nested-entry verified)', b3caps.depthInfinity === true && b3caps.tier === 'A', JSON.stringify({ di: b3caps.depthInfinity, tier: b3caps.tier }))
    // B3a 同步：整棵树的扫描是根上的一次 Depth:infinity（零次逐目录列举），深层文件正常下载
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-depthlog'), 'x')
    const b3s1 = await syncP(B3_A, '/b3')
    let dl = await readDepthlog()
    check(
      'B3a full-tree scan is a single Depth:infinity request (no per-dir listings)',
      b3s1.downloaded === 3 && countDepth(dl, 'inf', '/dav/b3') >= 1 && countDepth(dl, '1', '/dav/b3') === 0,
      `downloaded=${b3s1.downloaded} infRoot=${countDepth(dl, 'inf', '/dav/b3')} perDirRoot=${countDepth(dl, '1', '/dav/b3')} lines=${dl.length}`
    )
    check(
      'B3a nested file downloaded via single-request scan',
      (await fsp.readFile(path.join(B3_A, 'd1', 'd2', 'leaf.txt'), 'utf-8')) === 'b3-leaf'
    )
    await fsp.rm(DEPTHLOG, { force: true })
    const b3s2 = await syncP(B3_A, '/b3')
    dl = await readDepthlog()
    check('B3a no-change round also scans with exactly one infinity request', isNoop(b3s2) && countDepth(dl, 'inf', '/dav/b3') === 1 && countDepth(dl, '1', '/dav/b3') === 0, `lines=${dl.length}`)
    // 深层远端变更 → 单请求扫描照样检出（整棵树都在这一个响应里）
    await fsp.rm(DEPTHLOG, { force: true })
    await fsp.writeFile(path.join(ROOT, 'b3', 'd1', 'd2', 'leaf.txt'), 'leaf-edited-by-peer')
    const b3s3 = await syncP(B3_A, '/b3')
    check(
      'B3a deep remote change detected via single-request scan',
      b3s3.downloaded === 1 && (await fsp.readFile(path.join(B3_A, 'd1', 'd2', 'leaf.txt'), 'utf-8')) === 'leaf-edited-by-peer',
      JSON.stringify(b3s3)
    )

    // B3b 回落：缓存仍称支持（不重探），服务器改口 403 → 逐目录扫描照常完成本轮上传
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-noinfinity'), 'x')
    try {
      await fsp.rm(DEPTHLOG, { force: true })
      await fsp.writeFile(path.join(B3_A, 'new-after-fallback.txt'), 'naf')
      const b3s4 = await syncP(B3_A, '/b3')
      dl = await readDepthlog()
      check(
        'B3b stale capability falls back to per-dir scan and round succeeds',
        b3s4.uploaded === 1 && b3s4.errors.length === 0 && countDepth(dl, '1', '/dav/b3') >= 2 && countDepth(dl, '1', '/dav/b3/d1') >= 1,
        `uploaded=${b3s4.uploaded} root1=${countDepth(dl, '1', '/dav/b3')} d1=${countDepth(dl, '1', '/dav/b3/d1')}`
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-noinfinity'), { force: true }).catch(() => {})
    }

    // B3c 浅响应阀门：基线含 >50 个嵌套文件后，服务器对 infinity 只回第一层 →
    // 整轮按「扫描不完整」中止（I1：零删除零传输），本地文件与基线原样保留；
    // 服务器行为恢复后下一轮照常（no-op）
    const B3_C = await tmpLocal('b3c')
    await fsp.mkdir(path.join(B3_C, 'sub'), { recursive: true })
    for (let i = 0; i < 60; i++) await fsp.writeFile(path.join(B3_C, 'sub', `f${i}.txt`), `b3c-${i}`)
    const b3c1 = await syncP(B3_C, '/b3c')
    check('B3c baseline established with 60 nested files', b3c1.uploaded === 60, JSON.stringify({ uploaded: b3c1.uploaded }))
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-shallowinf'), 'x')
    try {
      let b3cErr = null
      try {
        await syncP(B3_C, '/b3c')
      } catch (e) {
        b3cErr = e
      }
      const localKept = (await fsp.readdir(path.join(B3_C, 'sub'))).length
      check(
        'B3c shallow infinity response aborts round as incomplete scan (zero deletes)',
        !!b3cErr && /没能完整读取文件列表/.test(b3cErr.message) && /嵌套条目/.test(String(b3cErr.detail || '')) && localKept === 60,
        `${b3cErr ? b3cErr.message : 'no error'} localKept=${localKept}`
      )
      check(
        'B3c baseline untouched by the aborted round',
        (await services.sync._internals.baselineSize({ id: 'p', localPath: B3_C, remotePath: '/b3c', mode: 'two-way' })) === 60
      )
      // 阀门命中的持久降级：缓存能力 depthInfinity=false（下一轮起逐目录形态；
      // 缓存命中读回不产生请求 —— shallowinf 标记仍在也不影响断言）
      const b3ccaps = await services.dav.probeCapabilities(cfg, false, '/b3c')
      check('B3c 浅响应命中后能力缓存降级（depthInfinity=false）', b3ccaps.depthInfinity === false, JSON.stringify({ di: b3ccaps.depthInfinity }))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-shallowinf'), { force: true }).catch(() => {})
    }
    const b3c2 = await syncP(B3_C, '/b3c')
    check('B3c round returns to normal after server behavior restored', isNoop(b3c2), JSON.stringify(b3c2))

    // B3d 探测硬化：探测期服务器就「207 但只回第一层」→ depthInfinity 必须判 false
    //（旧实现只看状态码会误判 true，引擎单请求扫描拿到残缺树 → 误删风险）
    await freshStore('b3d')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-shallowinf'), 'x')
    try {
      const b3dcaps = await services.dav.probeCapabilities(cfg, true, '/b3d')
      check('B3d probe hardening: 207-with-shallow-body must NOT be reported as depthInfinity', b3dcaps.depthInfinity === false, JSON.stringify({ di: b3dcaps.depthInfinity, notes: b3dcaps.notes }))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-shallowinf'), { force: true }).catch(() => {})
    }

    // B3e 「207 + 根 404 propstat」形态的根丢失（部分网关对缺失集合不回 HTTP 404）：
    //   ① 扫描层两种形态（infinity 单请求 / 逐目录）都得识别「集合自身 404 propstat」
    //      并上报根缺失 —— 绝不能解读成「远端为空」（否则非空基线下规划批量删除）；
    //   ② 根探测归一为 404 后，根丢失决策闸 / 选择消费 / 重建全链路复用；
    //   ③ 「重新上传」的重建轮在 infinity 形态下不被浅响应阀门误杀（远端为空是
    //      已知伪象），60 个文件全部重传收敛
    await freshStore('b3e')
    const B3_E = await tmpLocal('b3e')
    await fsp.mkdir(path.join(ROOT, 'b3e'), { recursive: true }) // 先建远端根：写能力探测需要可写目标
    const b3ecaps = await services.dav.probeCapabilities(cfg, true, '/b3e')
    check('B3e 前置：重探为 depthInfinity=true（A 档）', b3ecaps.depthInfinity === true && b3ecaps.tier === 'A', JSON.stringify({ di: b3ecaps.depthInfinity, tier: b3ecaps.tier }))
    await fsp.mkdir(path.join(B3_E, 'sub'), { recursive: true })
    for (let i = 0; i < 60; i++) await fsp.writeFile(path.join(B3_E, 'sub', `f${i}.txt`), `b3e-${i}`)
    const b3e1 = await syncP(B3_E, '/b3e')
    check('B3e 基线建立（60 个嵌套文件，infinity 扫描）', b3e1.uploaded === 60, JSON.stringify({ uploaded: b3e1.uploaded }))
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-root404prop'), 'x')
    try {
      await fsp.rm(path.join(ROOT, 'b3e'), { recursive: true, force: true })
      // ① 扫描层直检（不经过引擎轮，直接调 listRemoteSafe）
      const infScan = await services.sync._internals.listRemoteSafe(cfg, '/b3e', true, null, { depthInfinity: true })
      check(
        'B3e infinity 形态识别 207+根404prop → 根缺失上报',
        infScan.complete === false && infScan.errors.length === 1 && infScan.errors[0].rel === '.' && /404/.test(infScan.errors[0].message),
        JSON.stringify(infScan.errors)
      )
      const pdScan = await services.sync._internals.listRemoteSafe(cfg, '/b3e', true, null, {})
      check(
        'B3e per-dir 形态识别 207+根404prop → 根缺失上报',
        pdScan.complete === false && pdScan.errors.length === 1 && pdScan.errors[0].rel === '.' && /404/.test(pdScan.errors[0].message),
        JSON.stringify(pdScan.errors)
      )
      // ② 引擎轮：根探测归一 404 → 根丢失决策闸停轮（不撞浅响应阀门、不解读成远端为空）
      let b3eErr = null
      try {
        await syncP(B3_E, '/b3e')
      } catch (e) {
        b3eErr = e
      }
      check(
        'B3e 引擎轮路由根丢失决策（而非浅响应阀门）',
        !!b3eErr && /已不存在/.test(b3eErr.message) && !/嵌套条目/.test(String(b3eErr.detail || '')),
        b3eErr && b3eErr.message
      )
      const b3ed = { id: 'p', localPath: B3_E, remotePath: '/b3e', mode: 'two-way' }
      const b3epend = (await services.sync._internals.getPendings(b3ed)).find((p) => p.kind === 'root-lost')
      check('B3e 根丢失挂起已登记（含受影响文件数）', !!b3epend && !b3epend.choice && b3epend.local.size === 60, JSON.stringify(b3epend))
      // ③ 选择「重新上传」→ 重建轮不被浅响应阀门误杀 → 60 个全部重传收敛
      await services.sync.setPendingChoice(b3ed, '.', 'upload')
      const b3e2 = await syncP(B3_E, '/b3e')
      check(
        'B3e 重建轮收敛（60 个全部重传、零删除、阀门未误杀）',
        b3e2.uploaded === 60 && b3e2.deleted === 0 && (await fsp.readdir(path.join(ROOT, 'b3e', 'sub'))).length === 60,
        JSON.stringify({ uploaded: b3e2.uploaded, deleted: b3e2.deleted })
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-root404prop'), { force: true }).catch(() => {})
    }

    await fsp.rm(B3_A, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(B3_C, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(B3_E, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'b3'), { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'b3c'), { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'b3d'), { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'b3e'), { recursive: true, force: true }).catch(() => {})
  } finally {
    await clearDepthFlags()
    await setProfile(null)
  }
  })

  // ============================================================
  // ES0：集合 etag 传播能力探测。依赖 dav-server 的
  // .wdsync-test-etagprop 标记（集合条目 etag 改为树内递归聚合 → 任何深度写入都
  // 传播到祖先集合；默认档集合无 etag 可观测），与 .wdsync-test-depthlog（缓存
  // 命中「零重探」的零请求佐证），均用完即清。只用 probeCapabilities（无同步轮，
  // 故不需要本地临时目录）；各用例独立远端路径 + 独立存储根，互不污染缓存。
  // ============================================================

  await section('ES0：etag 传播能力探测', async () => {
    const clearEtagprop = async () => {
      await fsp.rm(path.join(ROOT, '.wdsync-test-etagprop'), { force: true }).catch(() => {})
    }
    try {
      // a) 默认档（无 etagprop、无 p9）：集合条目无 etag → 传播不可观测，保守判
      //    false；默认档（p1）Depth:infinity 返回 403 → depthInfinity=false
      await freshStore('es0')
      const capsA = await services.dav.probeCapabilities(cfg, true, '/es0a')
      check(
        'ES0a default profile: etagPropagation=false (no collection etag to observe), depthInfinity=false',
        capsA.etagPropagation === false && capsA.depthInfinity === false,
        JSON.stringify({ ep: capsA.etagPropagation, di: capsA.depthInfinity, notes: capsA.notes })
      )
      // b) etagprop 开：修改二层深度的探测文件后，父集合与祖先集合 etag 都变 → true
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-etagprop'), 'x')
      const capsB = await services.dav.probeCapabilities(cfg, true, '/es0b')
      check(
        'ES0b etagprop flag: propagation observed through both levels (etagPropagation=true)',
        capsB.etagPropagation === true,
        JSON.stringify({ ep: capsB.etagPropagation, notes: capsB.notes })
      )
      // c) 缓存生效：同配置（同 origin+用户+存储根）不 force → 命中缓存不重探。
      //    佐证：probedAt 与 force 轮完全相同（重探必产生新的 Date.now()），且
      //    depthlog 打开时整轮零 PROPFIND（重探必有多个列举请求）
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-depthlog'), 'x')
      try {
        await fsp.rm(DEPTHLOG, { force: true }).catch(() => {})
        const capsC = await services.dav.probeCapabilities(cfg, false, '/es0b')
        const dl = await readDepthlog()
        check(
          'ES0c cached capability reused without re-probe (value kept, zero PROPFINDs)',
          capsC.etagPropagation === true && capsC.probedAt === capsB.probedAt && dl.length === 0,
          JSON.stringify({ ep: capsC.etagPropagation, sameProbedAt: capsC.probedAt === capsB.probedAt, lines: dl.length })
        )
      } finally {
        await fsp.rm(path.join(ROOT, '.wdsync-test-depthlog'), { force: true }).catch(() => {})
        await fsp.rm(DEPTHLOG, { force: true }).catch(() => {})
      }
      // d) 旧格式缓存迁移：手工落一份「缺 etagPropagation 字段」的 capabilities.json
      //    （saveCapabilities 的落盘格式：{ v, origin, username, caps }；commonProbed:
      //    true、probedAt 新鲜、writePaths 含本路径 —— 排除「缺写结论」等其他重探
      //    诱因，唯一诱因只能是缺字段），etagprop 标记保持开启；不 force 探测 →
      //    必须触发公共重探（若误信旧缓存，!!undefined 只能给 false）
      await freshStore('es0d')
      const capsDir = storeModule.serverStateDirPath(new URL(cfg.serverUrl).origin, cfg.username)
      // 回拨 1ms：断言用 probedAt !== oldProbedAt 判定「确实重探」，而重探时间戳取自
      // 探测入口的 Date.now() —— 本地极快时两者可落同一毫秒（实测偶发），回拨保证
      // 任何之后取的时钟都严格更大；对「新鲜缓存」语义无影响（TTL 按 7 天计）
      const oldProbedAt = Date.now() - 1
      await fsp.mkdir(capsDir, { recursive: true })
      await fsp.writeFile(
        path.join(capsDir, 'capabilities.json'),
        JSON.stringify({
          v: 1,
          origin: new URL(cfg.serverUrl).origin,
          username: cfg.username,
          caps: {
            probedAt: oldProbedAt,
            commonProbed: true,
            etag: { present: true, weak: false, stable: true },
            conditional: { ifMatch: true, ifNoneMatch: true },
            depthInfinity: false,
            mtimePrecision: 'ms',
            collectionRedirect: false,
            notes: [],
            writePaths: { [storeModule.normalizeRemoteKey('/es0d')]: { writable: true, probedAt: oldProbedAt } },
          },
        })
      )
      const capsD = await services.dav.probeCapabilities(cfg, false, '/es0d')
      check(
        'ES0d old cache missing etagPropagation forces a re-probe (value becomes true)',
        capsD.etagPropagation === true && capsD.probedAt !== oldProbedAt,
        JSON.stringify({ ep: capsD.etagPropagation, reProbed: capsD.probedAt !== oldProbedAt, notes: capsD.notes })
      )
      // 还原存储根与远端探测根目录（探测目录自身已由第 7 步 DELETE，这里清各根）
      await switchDevice(STORAGE_MAIN)
      for (const d of ['es0a', 'es0b', 'es0d']) await fsp.rm(path.join(ROOT, d), { recursive: true, force: true }).catch(() => {})
    } finally {
      await clearEtagprop()
    }
  })

  // ============================================================
  // ES1：远端子树 etag 跳过扫描。依赖 dav-server 的
  // .wdsync-test-etagprop（内容 'x' = 全递归聚合；'shallow' = 只聚合直接子文件，
  // 模拟「服务器停止深层传播」）与 .wdsync-test-depthlog（逐目录列举计数）。
  // 独立远端 /es1*、独立本地临时目录、独立存储根，用完清理。默认档（p1）：
  // 逐目录扫描（infinity 403）+ A 档（If-Match 生效），覆盖跳过 / 深层变化再下降 /
  // 周期性全量 / 停止传播界内滞后 / 运行时异常回落全链路。
  // ============================================================

  await section('ES1：etag 子树跳过', async () => {
    const ES1_RP = '/es1'
    const setEtagprop = async (mode) => fsp.writeFile(path.join(ROOT, '.wdsync-test-etagprop'), mode || 'x')
    const clearEtagpropFlag = async () => fsp.rm(path.join(ROOT, '.wdsync-test-etagprop'), { force: true }).catch(() => {})
    /** 该同步对的 scan-cache.json 路径（测试直改 lastFullScanAt 用；getScanCache 每轮重读磁盘，改完即生效） */
    const scanCacheFile = async (lp) => path.join(await baselineDirOf({ localPath: lp, remotePath: ES1_RP, mode: 'two-way' }), 'scan-cache.json')
    /** 把 scan-cache 的 lastFullScanAt 归零（0 = 立即过期 → 下一轮强制全量下降） */
    const expireScanCache = async (lp) => {
      const f = await scanCacheFile(lp)
      const obj = JSON.parse(await fsp.readFile(f, 'utf-8'))
      obj.lastFullScanAt = 0
      await fsp.writeFile(f, JSON.stringify(obj))
    }
    const withDepthlog = async (fn) => {
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-depthlog'), 'x')
      await fsp.rm(DEPTHLOG, { force: true }).catch(() => {})
      try {
        return await fn()
      } finally {
        await fsp.rm(path.join(ROOT, '.wdsync-test-depthlog'), { force: true }).catch(() => {})
      }
    }
    try {
      await setProfile(null) // 默认档 p1：per-dir 扫描 + A 档
      await setEtagprop('x')
      await freshStore('es1')
      const A = await tmpLocal('es1')

      // a) 种子轮：服务器侧直接种两层树 → 首轮全量下载并建立缓存；第二轮 no-op 且
      //    只列举根目录（a 与 c 按 etag 跳过，a/b 在 a 内部不再列举）
      await fsp.mkdir(path.join(ROOT, 'es1', 'a', 'b'), { recursive: true })
      await fsp.mkdir(path.join(ROOT, 'es1', 'c'), { recursive: true })
      await fsp.writeFile(path.join(ROOT, 'es1', 'a', '1.txt'), 'es1-a1')
      await fsp.writeFile(path.join(ROOT, 'es1', 'a', 'b', '2.txt'), 'es1-b2')
      await fsp.writeFile(path.join(ROOT, 'es1', 'c', '3.txt'), 'es1-c3')
      const s1 = await syncP(A, ES1_RP)
      check(
        'ES1a seed round downloads whole tree via full descent (cache established)',
        s1.downloaded === 3 && s1.scan && s1.scan.remote === 'per-dir' && s1.scan.skippedDirs === 0,
        JSON.stringify({ downloaded: s1.downloaded, scan: s1.scan })
      )
      const s2 = await withDepthlog(async () => syncP(A, ES1_RP))
      const dl2 = await readDepthlog()
      check(
        'ES1a second round is no-op with only the root listed (a and c skipped by etag)',
        isNoop(s2) && s2.scan && s2.scan.remote === 'per-dir' && s2.scan.skippedDirs === 2 &&
          countDepth(dl2, '1', '/dav/es1') === 1 && countDepth(dl2, '1', '/dav/es1/a') === 0 && countDepth(dl2, '1', '/dav/es1/c') === 0,
        `scan=${JSON.stringify(s2.scan)} root=${countDepth(dl2, '1', '/dav/es1')} a=${countDepth(dl2, '1', '/dav/es1/a')} c=${countDepth(dl2, '1', '/dav/es1/c')} lines=${dl2.length}`
      )

      // b) 远端深层变化被发现：etagprop 全递归聚合使 a 与 a/b 的 etag 都变 →
      //    下一轮仅该子树下降（c 继续跳过），深层文件下载；再一轮回到双跳过
      await fsp.writeFile(path.join(ROOT, 'es1', 'a', 'b', '2.txt'), 'es1-b2-peer-edited-deep')
      const s3 = await withDepthlog(async () => syncP(A, ES1_RP))
      const dl3 = await readDepthlog()
      check(
        'ES1b deep remote change re-descends only that subtree (c still skipped)',
        s3.downloaded === 1 && s3.scan.skippedDirs === 1 &&
          countDepth(dl3, '1', '/dav/es1/a') === 1 && countDepth(dl3, '1', '/dav/es1/a/b') === 1 && countDepth(dl3, '1', '/dav/es1/c') === 0,
        `downloaded=${s3.downloaded} skipped=${s3.scan.skippedDirs} a=${countDepth(dl3, '1', '/dav/es1/a')} b=${countDepth(dl3, '1', '/dav/es1/a/b')} c=${countDepth(dl3, '1', '/dav/es1/c')}`
      )
      check('ES1b deep change lands locally', (await fsp.readFile(path.join(A, 'a', 'b', '2.txt'), 'utf-8')) === 'es1-b2-peer-edited-deep')
      const s4 = await syncP(A, ES1_RP)
      check('ES1b next round back to skipping both subtrees', isNoop(s4) && s4.scan.skippedDirs === 2, JSON.stringify(s4.scan))

      // c) 本地新增（新子目录新文件）与修改照常：跳过子树内的修改按合成远端指纹
      //    走 A 档 If-Match 上传；新子目录自动 MKCOL
      await fsp.mkdir(path.join(A, 'd'), { recursive: true })
      await fsp.writeFile(path.join(A, 'd', '4.txt'), 'es1-d4')
      await fsp.writeFile(path.join(A, 'a', '1.txt'), 'es1-a1-local-edited')
      const s5 = await syncP(A, ES1_RP)
      check(
        'ES1c local new subdir + modified file upload normally (auto mkdir, If-Match on synth)',
        s5.uploaded === 2 && s5.errors.length === 0 &&
          (await fsp.readFile(path.join(ROOT, 'es1', 'd', '4.txt'), 'utf-8')) === 'es1-d4' &&
          (await fsp.readFile(path.join(ROOT, 'es1', 'a', '1.txt'), 'utf-8')) === 'es1-a1-local-edited',
        JSON.stringify({ uploaded: s5.uploaded, errors: s5.errors })
      )

      // d) 周期性全量对账：lastFullScanAt 归零 → 下一轮 skippedDirs===0、Depth:1
      //    计数恢复 N+1（根 + a + a/b + c + d），内容 no-op
      await expireScanCache(A)
      const s6 = await withDepthlog(async () => syncP(A, ES1_RP))
      const dl6 = await readDepthlog()
      const totalD1 = dl6.filter((l) => l.startsWith('DEPTH 1 ')).length
      check(
        'ES1d expired cache forces full descent (N+1 listings, content no-op)',
        isNoop(s6) && s6.scan.skippedDirs === 0 && totalD1 === 5 &&
          countDepth(dl6, '1', '/dav/es1') === 1 && countDepth(dl6, '1', '/dav/es1/a') === 1 && countDepth(dl6, '1', '/dav/es1/a/b') === 1 && countDepth(dl6, '1', '/dav/es1/c') === 1 && countDepth(dl6, '1', '/dav/es1/d') === 1,
        `scan=${JSON.stringify(s6.scan)} totalD1=${totalD1} lines=${dl6.length}`
      )

      // e) 服务器停止传播（界内滞后 + 全量兜底）：切换 shallow 聚合（深层写入不再
      //    影响祖先集合 etag；能力缓存仍称 etagPropagation=true）→ 先一轮全量刷新
      //    缓存（a 的聚合口径变化使其 etag 改变而重新下降；c/d/a/b 只含直接文件，
      //    两种口径值相同，仍被跳过）→ 深层直写（a 的 shallow etag 不变）→
      //    下一轮 no-op（documented miss）→ 强制全量轮发现并下载
      await setEtagprop('shallow')
      const s7 = await syncP(A, ES1_RP)
      check('ES1e settle round re-descends only a (aggregate basis changed)', isNoop(s7) && s7.scan.skippedDirs === 3, JSON.stringify(s7.scan))
      await fsp.writeFile(path.join(ROOT, 'es1', 'a', 'b', '2.txt'), 'es1-b2-deep-miss')
      const s8 = await syncP(A, ES1_RP)
      check(
        'ES1e propagation stopped: deep change missed within bounds (documented, skip active)',
        isNoop(s8) && s8.scan.skippedDirs === 3 && (await fsp.readFile(path.join(A, 'a', 'b', '2.txt'), 'utf-8')) === 'es1-b2-peer-edited-deep',
        `scan=${JSON.stringify(s8.scan)}`
      )
      await expireScanCache(A)
      const s9 = await syncP(A, ES1_RP)
      check(
        'ES1e forced full round discovers and downloads the missed change',
        s9.downloaded === 1 && s9.scan.skippedDirs === 0 && (await fsp.readFile(path.join(A, 'a', 'b', '2.txt'), 'utf-8')) === 'es1-b2-deep-miss',
        JSON.stringify({ downloaded: s9.downloaded, scan: s9.scan })
      )

      // f) 异常回落：跳过已发生、远端实际已变（再深层直写一次）→ 同时修改本地同一
      //    文件 → 轮内上传带 A 档 If-Match（合成 etag= 基线）撞真实远端 → 412 →
      //    warning「下一轮将强制全量扫描」+ 缓存立即过期；下一轮全量看到真实远端，
      //    冲突按 remote 解决并下载
      await fsp.writeFile(path.join(ROOT, 'es1', 'a', 'b', '2.txt'), 'es1-b2-anomaly')
      const s10 = await syncP(A, ES1_RP)
      check('ES1f skip still active when server quietly changed the deep file', isNoop(s10) && s10.scan.skippedDirs === 3, JSON.stringify(s10.scan))
      await fsp.writeFile(path.join(A, 'a', 'b', '2.txt'), 'es1-b2-local-edited')
      let s11err = null
      try {
        await syncP(A, ES1_RP)
      } catch (e) {
        s11err = e
      }
      check(
        'ES1f synth-vs-actual mismatch surfaces as 412 precondition error',
        !!s11err && !!s11err.summary && /暂未上传/.test(s11err.summary.errors[0] || '') && s11err.summary.scan && s11err.summary.scan.skippedDirs === 3,
        s11err ? `${s11err.message} | scan=${JSON.stringify(s11err.summary.scan)}` : 'no error'
      )
      check(
        'ES1f anomaly note is log-only, full scan forced next round',
        !!s11err && !s11err.summary.warnings.some((w) => /强制全量扫描/.test(w)),
        s11err ? JSON.stringify(s11err.summary.warnings) : ''
      )
      const s12 = await syncP(A, ES1_RP, undefined, { onConflict: () => 'remote' })
      check(
        'ES1f next round full-scans, sees the real remote and resolves the conflict',
        s12.scan.skippedDirs === 0 && s12.conflicts === 1 && s12.downloaded === 1 &&
          (await fsp.readFile(path.join(A, 'a', 'b', '2.txt'), 'utf-8')) === 'es1-b2-anomaly',
        JSON.stringify({ scan: s12.scan, conflicts: s12.conflicts, downloaded: s12.downloaded })
      )

      // g) 默认档兼容回归：etagprop 关闭（集合条目无 etag）→ 即便缓存满、能力缓存
      //    仍称 true，也永不跳过（etag 缺失自然不匹配），既有行为不变
      await clearEtagpropFlag()
      const s13 = await syncP(A, ES1_RP)
      check('ES1g default profile never skips (no collection etag observable)', isNoop(s13) && s13.scan.skippedDirs === 0, JSON.stringify(s13.scan))

      // 清理：本地目录、远端树、存储根
      await fsp.rm(A, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'es1'), { recursive: true, force: true }).catch(() => {})
      await switchDevice(STORAGE_MAIN)
    } finally {
      await clearEtagpropFlag()
      await setProfile(null)
    }
  })

  // DP：本地脏路径快速核对 —— watch 轮把 watcher 事件
  // 累积的脏路径集经 handlers.hints 交给引擎，引擎用「基线合成 + 逐路径 lstat
  // 核对」替代全量 walk（scan.local='dirty'）；interval / startup / manual 轮不带
  // 提示恒全量（watch 事件不保证完整，正确性兜底是周期性全量扫描）。覆盖：直调
  // 三态（改 / 删 / 增）、目录名脏路径的子树清扫、阈值回落、来源限制、watcher
  // 记录与清理时序、调度器 watch/interval 轮的 hints 接线。

  await section('DP：本地脏路径快速核对', async () => {
    await setProfile(null) // 默认档 p1（A 档 + per-dir 远端扫描，排除 etag 跳过干扰）
    await freshStore('dp')
    const DP_A = await tmpLocal('dp-a')
    const DP_B = await tmpLocal('dp-b')
    const DP_E = await tmpLocal('dp-e')
    const DP_F = await tmpLocal('dp-f')
    /** 带 hints 的引擎直调（syncP 固定无 hints，提示轮需手工传 handlers） */
    const syncHint = (lp, rp, hints) =>
      services.sync.syncDirectory(cfg, { id: 'dp', localPath: lp, remotePath: rp, mode: 'two-way' }, SP, hints ? { hints } : {})
    /** 真实时钟轮询等待谓词（DP-f 自带：waitReal 定义在本节之后，位置上无法复用） */
    const waitUntil = async (pred, timeoutMs = 10000) => {
      const t0 = Date.now()
      while (!pred()) {
        if (Date.now() - t0 > timeoutMs) return false
        await sleep(20)
      }
      return true
    }
    try {
      // a) 引擎直调：种子轮全量 → 改 1 + 删 1 + 新增 1 → watch hints 快速核对
      //    （改写内容长度不同，确保 size 指纹可靠变化，不依赖 mtime 粒度）
      await fsp.writeFile(path.join(DP_A, 'a.txt'), 'dp-a-v1')
      await fsp.writeFile(path.join(DP_A, 'b.txt'), 'dp-b-v1')
      await fsp.writeFile(path.join(DP_A, 'c.txt'), 'dp-c-v1')
      const dSeed = await syncP(DP_A, '/dp')
      check('DPa seed round uploads 3 via full local scan', dSeed.uploaded === 3 && dSeed.scan && dSeed.scan.local === 'full', JSON.stringify(dSeed.scan))
      await fsp.writeFile(path.join(DP_A, 'a.txt'), 'dp-a-v2-longer-content')
      await fsp.unlink(path.join(DP_A, 'b.txt'))
      await fsp.writeFile(path.join(DP_A, 'new.txt'), 'dp-new-v1')
      const dDirty = await syncHint(DP_A, '/dp', { source: 'watch', dirtyPaths: ['a.txt', 'b.txt', 'new.txt'] })
      check(
        'DPa dirty round reports local scan form dirty with 3 paths',
        dDirty.scan && dDirty.scan.local === 'dirty' && dDirty.scan.dirtyPaths === 3,
        JSON.stringify(dDirty.scan)
      )
      check(
        'DPa dirty round plans correct ops (upload×2, delete-remote×1)',
        dDirty.uploaded === 2 && dDirty.deleted === 1 && dDirty.errors.length === 0,
        JSON.stringify({ uploaded: dDirty.uploaded, deleted: dDirty.deleted, errors: dDirty.errors })
      )
      check(
        'DPa remote reflects modify / delete / add exactly',
        (await fsp.readFile(path.join(ROOT, 'dp', 'a.txt'), 'utf-8')) === 'dp-a-v2-longer-content' &&
          !fs.existsSync(path.join(ROOT, 'dp', 'b.txt')) &&
          (await fsp.readFile(path.join(ROOT, 'dp', 'new.txt'), 'utf-8')) === 'dp-new-v1' &&
          fs.existsSync(path.join(ROOT, 'dp', 'c.txt')),
        ''
      )
      const dSettle = await syncP(DP_A, '/dp')
      check(
        'DPa next hint-less round is a full no-op (fast check kept baseline consistent)',
        dSettle.scan && dSettle.scan.local === 'full' && isNoop(dSettle),
        JSON.stringify(dSettle.scan)
      )

      // b) 目录删除：脏路径只报目录名 → 快速核对清空子树条目 → 远端子树删除传播
      //    + 空目录清理照常
      await fsp.mkdir(path.join(DP_B, 'sub'), { recursive: true })
      await fsp.writeFile(path.join(DP_B, 'sub', 'x.txt'), 'dp-b-x')
      await fsp.writeFile(path.join(DP_B, 'sub', 'y.txt'), 'dp-b-y')
      await fsp.writeFile(path.join(DP_B, 'top.txt'), 'dp-b-top')
      const dSeedB = await syncP(DP_B, '/dp2')
      check('DPb seed round uploads 3 (subtree + top)', dSeedB.uploaded === 3, JSON.stringify(dSeedB.scan))
      await fsp.rm(path.join(DP_B, 'sub'), { recursive: true, force: true })
      const dDirtyB = await syncHint(DP_B, '/dp2', { source: 'watch', dirtyPaths: ['sub'] })
      check(
        'DPb dir-name-only dirty path clears the whole subtree (delete-remote×2)',
        dDirtyB.scan && dDirtyB.scan.local === 'dirty' && dDirtyB.deleted === 2 && dDirtyB.errors.length === 0,
        JSON.stringify({ scan: dDirtyB.scan, deleted: dDirtyB.deleted, errors: dDirtyB.errors })
      )
      check(
        'DPb remote subtree removed and emptied dir pruned as usual',
        (await fsp.readdir(path.join(ROOT, 'dp2', 'sub')).catch(() => 'GONE')) === 'GONE' &&
          dDirtyB.dirsPrunedRemote === 1 &&
          (await fsp.readFile(path.join(ROOT, 'dp2', 'top.txt'), 'utf-8')) === 'dp-b-top',
        JSON.stringify({ pruned: dDirtyB.dirsPrunedRemote })
      )
      const dSettleB = await syncP(DP_B, '/dp2')
      check('DPb next full round is a no-op', dSettleB.scan && dSettleB.scan.local === 'full' && isNoop(dSettleB), JSON.stringify(dSettleB.scan))

      // c) 阈值回落：600 > 512 → 放弃快速核对走全量 walk（内容无变化 → no-op）
      const many = Array.from({ length: 600 }, (_, i) => `z${i}.txt`)
      const dOver = await syncHint(DP_A, '/dp', { source: 'watch', dirtyPaths: many })
      check(
        'DPc 600 dirty paths fall back to full walk',
        dOver.scan && dOver.scan.local === 'full' && dOver.scan.dirtyPaths === 600 && isNoop(dOver),
        JSON.stringify(dOver.scan)
      )

      // d) 来源限制：非 watch source（manual）即使带 dirtyPaths 也全量；无 hints 全量
      const dManual = await syncHint(DP_A, '/dp', { source: 'manual', dirtyPaths: ['a.txt'] })
      check(
        'DPd manual-source hints never trigger dirty scan',
        dManual.scan && dManual.scan.local === 'full' && dManual.scan.dirtyPaths === 0 && isNoop(dManual),
        JSON.stringify(dManual.scan)
      )
      const dNoHint = await syncP(DP_A, '/dp')
      check('DPd no hints = full scan', dNoHint.scan && dNoHint.scan.local === 'full' && isNoop(dNoHint), JSON.stringify(dNoHint.scan))

      // e) watcher 记录与清理：脏路径在去抖之前即时登记（NFC 归一）；引擎轮成功后
      //    恰好消费这些路径；轮后新事件留给下一轮；stopWatch 后 peek 返回 null。
      //    临时文件事件被 watchDir 过滤，不进脏集。
      let eFired = 0
      services.fsx.watchDir('dp-e', DP_E, () => {
        eFired++
      })
      const nfdName = 'cafe\u0301.txt' // NFD 写入（macOS 事件即 NFD 形态）→ 脏集应存 NFC
      const nfcName = `${'cafe\u0301'.normalize('NFC')}.txt`
      await fsp.writeFile(path.join(DP_E, 'e1.txt'), 'dp-e1')
      await fsp.writeFile(path.join(DP_E, nfdName), 'dp-e-nfd')
      await fsp.writeFile(path.join(DP_E, '.wdsync-tmp-e-probe'), 'x')
      // 等 fs.watch 事件送达。登记本身即时（不等 1.5s 去抖），但事件**送达**与系统
      // 负载相关：全量模式高负载下偶发迟到数秒，固定 sleep 会 miss（脏集跨去抖
      // 存续、仅被引擎轮消费，轮询等待不改变断言语义：登记 / NFC 归一 / 临时过滤）。
      // vitest 并行分片 + 机器同时跑其他任务时事件送达可达 10s+，超时放宽到 20s
      let peek1 = services.fsx.peekDirtyPaths('dp-e')
      // macOS FSEvents 对同目录快速连续写可能合并丢事件（W10 已知边界）：轮询 + 过半
      // 窗口补写缺失文件重触发一次 —— 断言语义是「登记即时 + NFC 归一 + 临时过滤」，
      // 与单次事件必达无关
      let gotEvents = false
      let reTrig = 0
      const wStart = Date.now()
      for (;;) {
        peek1 = services.fsx.peekDirtyPaths('dp-e')
        if (Array.isArray(peek1) && peek1.includes('e1.txt') && peek1.includes(nfcName)) {
          gotEvents = true
          break
        }
        if (Date.now() - wStart > 20000) break
        if (reTrig === 0 && Date.now() - wStart > 10000) {
          reTrig++
          if (!Array.isArray(peek1) || !peek1.includes('e1.txt')) await fsp.writeFile(path.join(DP_E, 'e1.txt'), 'dp-e1')
          if (!Array.isArray(peek1) || !peek1.includes(nfcName)) await fsp.writeFile(path.join(DP_E, nfdName), 'dp-e-nfd')
        }
        await sleep(100)
      }
      check(
        'DPe dirty paths registered immediately, NFC-normalized (before debounce fires)',
        gotEvents && Array.isArray(peek1) && peek1.includes('e1.txt') && peek1.includes(nfcName),
        JSON.stringify(peek1)
      )
      check('DPe sync temp file events never enter the dirty set', Array.isArray(peek1) && !peek1.some((p) => p.includes('wdsync')), JSON.stringify(peek1))
      const dDirtyE = await syncHint(DP_E, '/dp-e', { source: 'watch', dirtyPaths: peek1, watcherKey: 'dp-e' })
      check(
        'DPe engine round consumes the hints (2 uploads, both new to empty baseline)',
        dDirtyE.scan && dDirtyE.scan.local === 'dirty' && dDirtyE.uploaded === 2 && dDirtyE.errors.length === 0,
        JSON.stringify({ scan: dDirtyE.scan, uploaded: dDirtyE.uploaded })
      )
      const peek2 = services.fsx.peekDirtyPaths('dp-e')
      check(
        'DPe consumed paths cleared from the watcher dirty set',
        Array.isArray(peek2) && !peek2.includes('e1.txt') && !peek2.includes(nfcName),
        JSON.stringify(peek2)
      )
      await fsp.writeFile(path.join(DP_E, 'e2.txt'), 'dp-e2')
      let peek3 = services.fsx.peekDirtyPaths('dp-e')
      {
        // 同上：事件送达受负载影响，轮询 + 过半补写一次（超时后按原断言失败）
        let reTrig = 0
        const wStart = Date.now()
        for (;;) {
          peek3 = services.fsx.peekDirtyPaths('dp-e')
          if (Array.isArray(peek3) && peek3.includes('e2.txt')) break
          if (Date.now() - wStart > 20000) break
          if (reTrig === 0 && Date.now() - wStart > 10000) {
            reTrig++
            await fsp.writeFile(path.join(DP_E, 'e2.txt'), 'dp-e2')
          }
          await sleep(100)
        }
      }
      check('DPe events arriving after the round stay in the set for the next round', Array.isArray(peek3) && peek3.includes('e2.txt'), JSON.stringify(peek3))
      services.fsx.stopWatch('dp-e')
      check('DPe stopWatch drops the record (peek → null)', services.fsx.peekDirtyPaths('dp-e') === null, '')

      // f) 调度器接线：stub engine 捕获 handlers + peekDirtyPaths 返回固定值 ——
      //    watch 轮 hints.source='watch' 且脏路径传递（peek 用注册 watcherId），interval
      //    轮 source='interval' 且不带脏路径。本用例自带 dbStorage 桩与假时钟（SC 系列
      //    的共用助手定义在本节之后，位置上无法复用），结束即还原 ztools 桩。
      const prevZt = global.window.ztools
      const F_DB = {}
      global.window.ztools = {
        dbStorage: { getItem: (k) => (k in F_DB ? F_DB[k] : null), setItem: (k, v) => { F_DB[k] = v } },
        ...(prevZt && prevZt.shellTrashItem ? { shellTrashItem: prevZt.shellTrashItem } : {}),
      }
      F_DB['webdav-sync:data'] = {
        server: { serverUrl: `http://127.0.0.1:${PORT}/dav/`, username: 'u', password: services.secure.sealSecret('p') },
        dirs: [{ id: 'd1', localPath: DP_F, remotePath: '/dp-f', mode: 'two-way' }],
        prefs: { autoSync: true, intervalMin: 1, backgroundRunning: true, conflictStrategy: 'ask', ignoreHidden: true, concurrency: 4 },
      }
      const fCalls = []
      const fPeeked = []
      let fWatchFire = null
      // 极简假时钟（调度器 now/timers 注入；选举等真实 IO 在推进间隙执行）
      let fNow = Date.now()
      const fPend = new Set()
      const fFire = () => {
        for (const h of Array.from(fPend)) {
          if (h.dead) continue
          if (h.at <= fNow) {
            if (h.interval > 0) {
              h.at = fNow + h.interval
              h.fn()
            } else {
              h.dead = true
              fPend.delete(h)
              h.fn()
            }
          }
        }
      }
      const fTimers = {
        setTimeout(fn, ms) {
          const h = { fn, at: fNow + Math.max(0, Number(ms) || 0), interval: 0, dead: false }
          fPend.add(h)
          return h
        },
        clearTimeout(h) {
          if (h) {
            h.dead = true
            fPend.delete(h)
          }
        },
        setInterval(fn, ms) {
          const h = { fn, at: fNow + Math.max(0, Number(ms) || 0), interval: Math.max(1, Number(ms) || 1), dead: false }
          fPend.add(h)
          return h
        },
        clearInterval(h) {
          if (h) {
            h.dead = true
            fPend.delete(h)
          }
        },
      }
      const fAdvance = async (ms) => {
        let remaining = ms
        while (remaining > 0) {
          const step = Math.min(200, remaining)
          fNow += step
          fFire()
          remaining -= step
          await new Promise((r) => setImmediate(r)) // 让真实 IO / 微任务在推进间隙执行
          fFire()
        }
      }
      const fSched = services.sync._internals.createScheduler({
        engine: {
          syncDirectory: async (_cfg, _dir, _prefs, handlers) => {
            fCalls.push(handlers && handlers.hints ? { ...handlers.hints } : null)
            return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, deferredConflicts: 0, adopted: 0, bytesUp: 0, bytesDown: 0, totalFiles: 0, tier: 'B', warnings: [], errors: [], errorsDropped: 0 }
          },
          watchDir: (wid, _lp, onChange) => {
            fWatchFire = onChange
            return true
          },
          stopWatch: () => {},
          stopAllWatch: () => {},
          peekDirtyPaths: (wid) => {
            fPeeked.push(wid)
            return ['stub-dirty.txt']
          },
          listPendingConflicts: async () => [],
        },
        getDeviceId: services.storage.getDeviceId,
        autoBootstrap: false,
        now: () => fNow,
        timers: fTimers,
      })
      try {
        await fSched.init()
        // 选举 / watcher 注册是真实 IO：边推进假时钟边等 leader + stub watchDir 挂上
        const elected = await waitUntil(() => fSched.getSnapshot().leader.isLeader === true && fWatchFire != null, 10000)
        check('DPf test scheduler elected leader and registered stub watcher', elected, JSON.stringify(fSched.getSnapshot().leader))
        // watch 轮：直接调 stub 捕获的 onChange（等价 watcher 去抖后的触发）
        fWatchFire()
        const watchOk = await waitUntil(() => fCalls.length >= 1, 8000)
        const watchHints = fCalls[0]
        check(
          'DPf watch round passes hints with source=watch and the peeked dirty paths',
          watchOk && watchHints && watchHints.source === 'watch' && Array.isArray(watchHints.dirtyPaths) && watchHints.dirtyPaths.length === 1 && watchHints.dirtyPaths[0] === 'stub-dirty.txt',
          JSON.stringify(watchHints)
        )
        check(
          'DPf peek uses the registered watcher id (instanceId:dirId) and watcherKey matches',
          fPeeked.includes(`${fSched.instanceId}:d1`) && watchHints && watchHints.watcherKey === `${fSched.instanceId}:d1`,
          JSON.stringify({ peeked: fPeeked, watcherKey: watchHints && watchHints.watcherKey })
        )
        // interval 轮：假时钟推进 60s（intervalMin=1）到期触发
        await fAdvance(62000)
        const intervalOk = await waitUntil(() => fCalls.length >= 2, 8000)
        const intervalHints = fCalls[fCalls.length - 1]
        check(
          'DPf interval round hints carry source=interval and no dirty paths (full scan)',
          intervalOk && intervalHints && intervalHints.source === 'interval' && intervalHints.dirtyPaths === undefined,
          JSON.stringify(intervalHints)
        )
      } finally {
        fSched.cleanup()
        global.window.ztools = prevZt
      }

      // 清理：本地目录、远端树、存储根
      for (const d of [DP_A, DP_B, DP_E, DP_F]) await fsp.rm(d, { recursive: true, force: true }).catch(() => {})
      for (const r of ['dp', 'dp2', 'dp-e']) await fsp.rm(path.join(ROOT, r), { recursive: true, force: true }).catch(() => {})
      await switchDevice(STORAGE_MAIN)
    } finally {
      services.fsx.stopWatch('dp-e') // 幂等兜底（e 段异常路径也不遗留 watcher）
      await setProfile(null)
    }
  })

  // ============================================================
  // HP 系列：宿主端口注入 —— preload 对宿主（ZTools）
  // 的全部运行期依赖（storageRoot / trashItem / notify / config / lifecycle）
  // 已收敛为显式端口（src-ztools/preload/host.mts，经 services.host 门面暴露）。
  // 本节只在源码轨运行：built 轨是双模块图（bundle 与另行 import 的源码 store
  // 各一实例），setHostPorts 注入只影响所在模块图、无法两边对齐 —— BUILT 时整节
  // 跳过；默认端口的等价性由既有全部用例回归证明（它们全部走 window.ztools mock）。
  // ============================================================

  await section('HP：宿主端口注入', async () => {
    if (BUILT) {
      console.log('[built] HP 节仅在源码轨运行（built 轨 bundle 与源码 store 双模块图，注入只影响所在模块图、无法对齐）—— 整节跳过')
      return
    }
    await setProfile(null) // 默认档 p1（与 DP 同口径，不引入档位变量）
    const prevZtHp = global.window.ztools
    const HP_ROOT = path.join(os.tmpdir(), `wdsync-e2e-hp-root-${Date.now()}`)
    const HP_TRASH = path.join(os.tmpdir(), `wdsync-e2e-hp-trash-${Date.now()}`)
    const HP_NOTES = []
    const HP_DB = {}
    const hpTrashLog = []
    /** 本节自带的实时钟轮询（waitReal 定义在本节之后的 SC 区，位置上无法复用） */
    const hpWait = async (pred, timeoutMs = 10000) => {
      const t0 = Date.now()
      while (!pred()) {
        if (Date.now() - t0 > timeoutMs) return false
        await sleep(20)
      }
      return true
    }
    let HP_LOCAL = null
    let HP2_LOCAL = null
    let hpSched = null
    try {
      await fsp.mkdir(HP_TRASH, { recursive: true })
      // —— a) 自定义端口全链路：存储根 / 回收站 / 内存 config / 通知收集 / lifecycle=null ——
      HP_LOCAL = await tmpLocal('hp')
      // 清 override 与根缓存，使端口成为存储根的唯一权威（setRootForTest 的
      // override 优先于端口，不清理会让注入形同虚设）
      await services.storage.setRootForTest(null)
      services.host.setHostPorts({
        storageRoot: () => HP_ROOT,
        trashItem: async (p) => {
          hpTrashLog.push(p)
          const dest = path.join(HP_TRASH, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(p)}`)
          await fsp.rename(p, dest)
        },
        notify: (body) => HP_NOTES.push(String(body)),
        config: { getItem: (k) => (k in HP_DB ? HP_DB[k] : null), setItem: (k, v) => { HP_DB[k] = v } },
        lifecycle: null,
      })
      await fsp.writeFile(path.join(HP_LOCAL, 'a.txt'), 'hp-a')
      await fsp.writeFile(path.join(HP_LOCAL, 'b.txt'), 'hp-b')
      const hpS1 = await syncP(HP_LOCAL, '/hp')
      const hpBaselineDir = await baselineDirOf({ localPath: HP_LOCAL, remotePath: '/hp' })
      check(
        'HPa injected storage-root port hosts all engine state (device.json + baseline under custom root)',
        hpS1.uploaded === 2 && fs.existsSync(path.join(HP_ROOT, 'sync-state', 'device.json')) && hpBaselineDir.startsWith(path.join(HP_ROOT, 'sync-state', 'baselines')),
        JSON.stringify({ uploaded: hpS1.uploaded, base: hpBaselineDir })
      )
      // 本地删除 → 经注入 trash 端口进自定义回收目录：删「远端」副本让引擎做
      // delete-local 传播（本地删除走回收站）；默认 mock 回收站（TRASH_DIR）零接触
      const trashMockCount0 = fs.readdirSync(TRASH_DIR).length
      await fsp.rm(path.join(ROOT, 'hp', 'b.txt'))
      const hpS2 = await syncP(HP_LOCAL, '/hp')
      check(
        'HPa remote-delete propagation routes the local delete through the injected trash port',
        hpS2.deleted === 1 && hpTrashLog.length === 1 && hpTrashLog[0].endsWith('b.txt') && fs.readdirSync(HP_TRASH).some((n) => n.endsWith('b.txt')) && !fs.existsSync(path.join(HP_LOCAL, 'b.txt')) && fs.readdirSync(TRASH_DIR).length === trashMockCount0,
        JSON.stringify({ deleted: hpS2.deleted, portCalls: hpTrashLog.length, mockDelta: fs.readdirSync(TRASH_DIR).length - trashMockCount0 })
      )
      // 调度器自举经注入的内存 config：此刻 window.ztools mock 只有 shellTrashItem、
      // 没有 dbStorage —— ready 即证明配置读的是端口而非宿主对象。
      // 冲突提醒用新目录 startup 轮验证（reload 新增目录触发；打开插件已不立即同步）：
      // init() 会标记 rendererOnline，手动轮（syncNow）的冲突将转发等待渲染层应答
      //（无订阅者应答即永久等待 —— 生产语义正确但测试会挂起）；startup / watch 等
      // 自动轮冲突一律 defer，才是系统提醒的生产路径。
      // 挂起 services.mts 挂载期的默认调度器：它同样读得到注入的 config 端口 —— 若
      // 本节在它 ~1s 的自举重试窗口内运行（当前节序靠后不会，但顺序调整后会），
      // 它会抢先持有同一存储根的 leader 锁，本节的测试实例永远 standby。挂起让它
      // 主动让锁，finally 还原（还原时端口已撤、mock 无 dbStorage，它保持未自举态）。
      if (services.scheduler) services.scheduler.suspend()
      await fsp.writeFile(path.join(HP_LOCAL, 'c.txt'), 'hp-c-local')
      await fsp.writeFile(path.join(ROOT, 'hp', 'c.txt'), 'hp-c-remote')
      // autoSync 必须开：dirEligible 以「全局 autoSync !== false」为门（scheduler.mts），
      // 关着时任何调度器（含本节实例）都不会跑 startup 轮，挂起冲突的提醒无从触发。
      // 初始 dirs 留空：打开插件不立即同步；下方 reload 新增 hp1 触发新目录首轮
      HP_DB['webdav-sync:data'] = {
        server: { serverUrl: cfg.serverUrl, username: 'u', password: services.secure.sealSecret('p') },
        dirs: [],
        prefs: { autoSync: true, intervalMin: 15, conflictStrategy: 'ask', ignoreHidden: true, concurrency: 4 },
      }
      hpSched = services.sync._internals.createScheduler({
        engine: {
          syncDirectory: services.sync.syncDirectory,
          watchDir: services.fsx.watchDir,
          stopWatch: services.fsx.stopWatch,
          stopAllWatch: services.fsx.stopAllWatch,
          listPendingConflicts: services.sync.listPendingConflicts,
        },
        getDeviceId: services.storage.getDeviceId,
        autoBootstrap: false,
      })
      const hpInit = await hpSched.init()
      check(
        'HPa scheduler bootstraps from the injected in-memory config port (ready, no slot)',
        hpInit.ready === true && hpInit.slots.length === 0,
        JSON.stringify({ ready: hpInit.ready, reason: hpInit.notReadyReason, slots: hpInit.slots.length })
      )
      HP_DB['webdav-sync:data'] = {
        server: { serverUrl: cfg.serverUrl, username: 'u', password: services.secure.sealSecret('p') },
        dirs: [{ id: 'hp1', localPath: HP_LOCAL, remotePath: '/hp', mode: 'two-way' }],
        prefs: { autoSync: true, intervalMin: 15, conflictStrategy: 'ask', ignoreHidden: true, concurrency: 4 },
      }
      const hpReload = await hpSched.reload()
      check(
        'HPa reload adds hp1 (new slot + first round armed)',
        hpReload.applied === true && hpSched.getSnapshot().slots.length === 1,
        JSON.stringify({ applied: hpReload.applied, slots: hpSched.getSnapshot().slots.length })
      )
      // 新目录 startup 轮（自动类，冲突一律 defer）→ 挂起冲突的系统提醒走注入 notify 端口
      const hpNotified = await hpWait(() => HP_NOTES.length >= 1, 15000)
      check(
        'HPa deferred-conflict notification routed through the injected notify port',
        hpNotified && HP_NOTES.length === 1 && /1 个文件需要你选择保留哪一个/.test(HP_NOTES[0] || ''),
        JSON.stringify({ notified: hpNotified, notes: HP_NOTES })
      )
      hpSched.cleanup()
      hpSched = null
      // —— 还原默认端口：既有 window.ztools mock 路径照常工作（再驱动一小轮证明）——
      services.host.setHostPorts(null)
      await switchDevice(STORAGE_MAIN)
      HP2_LOCAL = await tmpLocal('hp2')
      await fsp.writeFile(path.join(HP2_LOCAL, 'x.txt'), 'hp2-x')
      const hpS3 = await syncP(HP2_LOCAL, '/hp2')
      await fsp.rm(path.join(ROOT, 'hp2', 'x.txt'))
      const hpS4 = await syncP(HP2_LOCAL, '/hp2') // 远端删除 → 本地经默认端口（mock 回收站）删除
      const hpMockTrashed = fs.readdirSync(TRASH_DIR).filter((n) => n.endsWith('x.txt'))
      check(
        'HPa setHostPorts(null) restores the default ports (delete flows to the window.ztools mock trash again)',
        hpS3.uploaded === 1 && hpS4.deleted === 1 && hpMockTrashed.length >= 1 && !fs.existsSync(path.join(HP2_LOCAL, 'x.txt')) && hpTrashLog.length === 1,
        JSON.stringify({ up: hpS3.uploaded, del: hpS4.deleted, mockHits: hpMockTrashed.length, portCalls: hpTrashLog.length })
      )
      // —— b) 默认端口动态性：不覆盖时每次现读 window.ztools（现取不缓存）——
      const HP_PROBE = path.join(os.tmpdir(), `wdsync-e2e-hp-probe-${Date.now()}`)
      global.window.ztools = {
        dbStorage: { getItem: () => null, setItem: () => {} },
        getPath: (n) => (n === 'pluginData' ? HP_PROBE : ''),
        shellTrashItem: async () => {},
        onPluginEnter: () => {},
        onPluginOut: () => {},
      }
      const dyn1 = services.host.getHostPorts()
      check(
        'HPb default port reflects the live window.ztools mock (config / storageRoot / lifecycle)',
        dyn1.config != null && dyn1.storageRoot() === HP_PROBE && dyn1.lifecycle != null,
        JSON.stringify({ config: dyn1.config != null, root: dyn1.storageRoot(), lifecycle: dyn1.lifecycle != null })
      )
      delete global.window.ztools
      await services.storage.setRootForTest(null) // 清根缓存，逼下一次解析走默认端口
      const dyn2 = services.host.getHostPorts()
      check(
        'HPb host removal degrades the default port (config=null, store falls back to tmpdir)',
        dyn2.config == null && dyn2.storageRoot() == null && dyn2.lifecycle == null && storeModule.storageRoot() === path.join(os.tmpdir(), 'webdav-sync-state-fallback', 'sync-state'),
        JSON.stringify({ config: dyn2.config == null, root: dyn2.storageRoot(), lifecycle: dyn2.lifecycle == null })
      )
    } finally {
      services.host.setHostPorts(null) // 双保险：异常路径也不把注入泄漏给后续节
      if (services.scheduler) await services.scheduler.resume().catch(() => {}) // 还原挂起的默认调度器（此刻 config 已不可得，它保持未自举态）
      global.window.ztools = prevZtHp
      await switchDevice(STORAGE_MAIN)
      if (hpSched) {
        try {
          hpSched.cleanup()
        } catch (_) {
          /* 已清理 / 未挂载：忽略 */
        }
      }
      for (const d of [HP_LOCAL, HP2_LOCAL, HP_ROOT, HP_TRASH]) if (d) await fsp.rm(d, { recursive: true, force: true }).catch(() => {})
      for (const r of ['hp', 'hp2']) await fsp.rm(path.join(ROOT, r), { recursive: true, force: true }).catch(() => {})
      await setProfile(null)
    }
  })

  // B4：进度事件节流 —— 逐文件 tick 不再全量外发（同相位 ≥150ms 节流），
  // 但每相位首事件与终态事件必然送达：注入式用例（plan 首事件窗口）依赖前者，
  // 最终计数依赖后者。用 30 个小文件的上传轮观测。

  await section('B4：进度事件节流与终态送达', async () => {
    await freshStore('b4')
    const B4_LOCAL = await tmpLocal('b4')
    for (let i = 0; i < 30; i++) await fsp.writeFile(path.join(B4_LOCAL, `f${i}.txt`), `b4-${i}`)
    const events = []
    const b4s1 = await syncP(B4_LOCAL, '/b4', undefined, {
      onProgress: (p) => events.push({ ...p }),
    })
    const phases = events.map((e) => e.phase)
    const transferEvents = events.filter((e) => e.phase === 'transfer')
    check(
      'B4 first event of each phase always delivered (scan/plan/transfer)',
      phases.includes('scan') && phases.includes('plan') && phases.includes('transfer') && phases[0] === 'scan',
      phases.join(',')
    )
    check(
      'B4 transfer-phase events throttled well below per-file ticks',
      b4s1.uploaded === 30 && transferEvents.length >= 1 && transferEvents.length < 30,
      `uploaded=${b4s1.uploaded} events=${transferEvents.length}`
    )
    check(
      'B4 final transfer event carries the full count (forced terminal tick)',
      transferEvents[transferEvents.length - 1].filesDone === 30 && transferEvents[transferEvents.length - 1].filesTotal === 30,
      JSON.stringify(transferEvents[transferEvents.length - 1])
    )
    // 扫描进度（phase='scan' 的 filesDone 递增）：末事件携带最终扫描计数
    const scanEvents = events.filter((e) => e.phase === 'scan')
    check('B4 scan progress delivered with final file count', scanEvents.length >= 1 && scanEvents[scanEvents.length - 1].filesDone === 30, `events=${scanEvents.length} last=${JSON.stringify(scanEvents[scanEvents.length - 1])}`)
    await fsp.rm(B4_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'b4'), { recursive: true, force: true }).catch(() => {})
  })

  // X3：畸形 multistatus（截断 / 未闭合 / 坏实体，HTTP 分帧完整）——
  // 扫描判 incomplete、整轮中止、绝不误删；故障清除后收敛

  await section('X3：畸形 multistatus 防误删', async () => {
    await freshStore('x3')
    const X3_LOCAL = await tmpLocal('x3')
    await fsp.writeFile(path.join(X3_LOCAL, 'keep.txt'), 'k')
    await fsp.writeFile(path.join(X3_LOCAL, 'del-me.txt'), 'd')
    await syncP(X3_LOCAL, '/x3')
    await fsp.unlink(path.join(X3_LOCAL, 'del-me.txt')) // 本地删除：正常下一轮应传播为远端删除
    for (const mode of ['truncate', 'unclosed', 'badentity']) {
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-badxml'), mode)
      let x3err = null
      try {
        await syncP(X3_LOCAL, '/x3')
      } catch (e) {
        x3err = e
      }
      check(
        `X3 malformed '${mode}' aborts round as incomplete scan`,
        !!x3err && /没能完整读取文件列表/.test(x3err.message) && /无法识别/.test(String(x3err.detail || '')),
        x3err && x3err.message
      )
      check(
        `X3 malformed '${mode}' never deletes remote`,
        fs.existsSync(path.join(ROOT, 'x3', 'del-me.txt')) && fs.existsSync(path.join(ROOT, 'x3', 'keep.txt'))
      )
      await fsp.rm(path.join(ROOT, '.wdsync-test-badxml'), { force: true }).catch(() => {})
    }
    const x3b = await syncP(X3_LOCAL, '/x3')
    check('X3 round recovers after malformation clears (delete propagates)', x3b.deleted === 1 && !fs.existsSync(path.join(ROOT, 'x3', 'del-me.txt')), JSON.stringify(x3b))
    await fsp.rm(X3_LOCAL, { recursive: true, force: true }).catch(() => {})
  })

  // X5：超大目录响应 —— 5 万条目合成 multistatus 一次解析（含中文名 / %23 名）

  await section('X5：5 万条目大响应解析', async () => {
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-bigxml'), '50000')
    try {
      await fsp.mkdir(path.join(ROOT, 'bigxml'), { recursive: true })
      const x5t0 = Date.now()
      const scan = await services.sync._internals.listRemoteSafe(cfg, '/bigxml', true)
      const x5ms = Date.now() - x5t0
      check('X5 50k-entry listing complete with all entries', scan.complete === true && scan.files.size === 50000, `count=${scan.files.size} complete=${scan.complete}`)
      check('X5 50k-entry listing finishes promptly', x5ms < 30000, `${x5ms}ms`)
      const zh = scan.files.get('中 文7.txt')
      const hashName = scan.files.get('tag#-11.txt')
      check('X5 synthetic special names parsed with correct props', !!zh && zh.size === 8 && !!hashName && hashName.size === 12, `${JSON.stringify(zh)} ${JSON.stringify(hashName)}`)
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-bigxml'), { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'bigxml'), { recursive: true, force: true }).catch(() => {})
    }
  })

  // ── DS 系列：删除安全 ──────────────────────────────────
  // 五项保护各有「正常通过 + 保护生效」两类用例：批量删除阈值 / 本地删除进回收站 /
  // 本地根健康检查 / 远端根 404 重建 / 空目录清理。SC 收尾已摘掉假 ztools —— 本系列
  // 依赖回收站桩，先重装。
  installTrash()
  // DS1 批量删除阈值：少量删除正常传播（含恰等于阈值的边界放行）；超过
  // max(50, 基线×20%) 整批挂起（kind='delete' 无 choice），确认前零删除且跨轮持续；
  // 确认（delete）下一轮执行、保留（keep）持续抑制、确认标记随落地清除。
  // 注：用例刻意保留至少 1 个本地文件 —— 「本地删光」由 DS3 的空根目录保护拦截，
  // 不属于阈值通道（两层保护互斥地各管一段）

  // [慢组登记原因] 挂起确认跨轮持续的真实多轮等待；挂起登记基本语义由 PC1/PC2 覆盖、阈值交互深水区留发版
  await slowSection('DS1：批量删除阈值与挂起确认', '挂起确认跨轮持续的真实多轮等待；挂起登记基本语义由 PC1/PC2 覆盖、阈值交互深水区留发版', async () => {
    // —— 正常通过 + 边界：110 文件基线（阈值 max(50,22)=50），删 10 → 直接传播；
    // 再删 50（剩 50，目录非空）→ 恰等于阈值（不「超过」）→ 放行
    const LA = path.join(os.tmpdir(), `wdsync-e2e-ds1a-${Date.now()}`)
    const dA = () => ({ id: 'ds1a', localPath: LA, remotePath: '/ds1a', mode: 'two-way' })
    await fsp.mkdir(LA, { recursive: true })
    for (let i = 0; i < 110; i++) await fsp.writeFile(path.join(LA, `f${i}.txt`), `c${i}`)
    await services.sync.syncDirectory(cfg, dA(), SP, {})
    for (let i = 0; i < 10; i++) await fsp.unlink(path.join(LA, `f${i}.txt`))
    const a1 = await services.sync.syncDirectory(cfg, dA(), SP, {})
    check(
      'DS1 少量删除正常传播（10 ≤ 50，不触发阈值）',
      a1.deleted === 10 && a1.deleteHeld === 0 && fs.readdirSync(path.join(ROOT, 'ds1a')).length === 100,
      JSON.stringify({ deleted: a1.deleted, deleteHeld: a1.deleteHeld })
    )
    for (let i = 10; i < 60; i++) await fsp.unlink(path.join(LA, `f${i}.txt`))
    const a2 = await services.sync.syncDirectory(cfg, dA(), SP, {})
    check(
      'DS1 恰等于阈值放行（50 不大于 50）',
      a2.deleted === 50 && a2.deleteHeld === 0 && fs.readdirSync(path.join(ROOT, 'ds1a')).length === 50,
      JSON.stringify({ deleted: a2.deleted, deleteHeld: a2.deleteHeld })
    )
    await fsp.rm(LA, { recursive: true, force: true }).catch(() => {})

    // —— 保护生效：60 文件删除 59 个（留 1 个使目录非空）→ 59 > 50 整批挂起，
    // 确认前零删除
    const LB = path.join(os.tmpdir(), `wdsync-e2e-ds1b-${Date.now()}`)
    const dB = () => ({ id: 'ds1b', localPath: LB, remotePath: '/ds1b', mode: 'two-way' })
    await fsp.mkdir(LB, { recursive: true })
    for (let i = 0; i < 60; i++) await fsp.writeFile(path.join(LB, `f${i}.txt`), `c${i}`)
    await services.sync.syncDirectory(cfg, dB(), SP, {})
    for (let i = 0; i < 59; i++) await fsp.unlink(path.join(LB, `f${i}.txt`))
    const b1 = await services.sync.syncDirectory(cfg, dB(), SP, {})
    const pend1 = await services.sync._internals.getPendings(dB())
    check(
      'DS1 超阈值整批挂起：本轮零删除、远端原样',
      b1.deleted === 0 && b1.deleteHeld === 59 && fs.readdirSync(path.join(ROOT, 'ds1b')).length === 60,
      JSON.stringify({ deleted: b1.deleted, deleteHeld: b1.deleteHeld })
    )
    check(
      'DS1 挂起记录 kind=delete 且无 choice（待确认）',
      pend1.length === 59 && pend1.every((p) => p.kind === 'delete' && !p.choice),
      `pendings=${pend1.length}`
    )
    check('DS1 超阈值轮给出明确警告', b1.warnings.some((w) => /数量偏多/.test(w)), JSON.stringify(b1.warnings))
    // 确认前再跑一轮：挂起条目与阈值无关地持续等待确认（不因数量回落放行）
    const b2 = await services.sync.syncDirectory(cfg, dB(), SP, {})
    check('DS1 确认前跨轮持续零删除', b2.deleted === 0 && b2.deleteHeld === 59, JSON.stringify({ deleted: b2.deleted, deleteHeld: b2.deleteHeld }))
    // 确认 30（delete）保留 29（keep）→ 下一轮分别执行与抑制（留存的 f59 不受影响）
    const rels = pend1.map((p) => p.rel).sort()
    for (let i = 0; i < 30; i++) await services.sync.setPendingChoice(dB(), rels[i], 'delete')
    for (let i = 30; i < 59; i++) await services.sync.setPendingChoice(dB(), rels[i], 'keep')
    const b3 = await services.sync.syncDirectory(cfg, dB(), SP, {})
    check(
      'DS1 确认删除落地 30 个（远端剩 30 = 保留 29 + 未删的 1）',
      b3.deleted === 30 && fs.readdirSync(path.join(ROOT, 'ds1b')).length === 30,
      JSON.stringify({ deleted: b3.deleted, remote: fs.readdirSync(path.join(ROOT, 'ds1b')).length })
    )
    check('DS1 保留的 29 个被抑制并计数', b3.deleteKept === 29 && b3.deleteRootGuard === 0, JSON.stringify({ deleteKept: b3.deleteKept }))
    const pend2 = await services.sync._internals.getPendings(dB())
    check(
      'DS1 确认标记随落地清除、保留标记留存',
      pend2.length === 29 && pend2.every((p) => p.choice === 'keep' && p.kind === 'delete'),
      `pendings=${pend2.length}`
    )
    const b4 = await services.sync.syncDirectory(cfg, dB(), SP, {})
    check(
      'DS1 保留标记跨轮持续抑制删除传播',
      b4.deleted === 0 && b4.deleteKept === 29 && fs.readdirSync(path.join(ROOT, 'ds1b')).length === 30,
      JSON.stringify({ deleted: b4.deleted, deleteKept: b4.deleteKept })
    )
    // 非法选择值按记录类别拒绝（删除类挂起不接受 local/remote/both）
    let choiceErr = null
    try {
      await services.sync.setPendingChoice(dB(), rels[30], 'local')
    } catch (e) {
      choiceErr = e
    }
    check('DS1 删除类挂起拒绝冲突类选择值', !!choiceErr && /无效的挂起处理选择/.test(choiceErr.message), choiceErr && choiceErr.message)
    await fsp.rm(LB, { recursive: true, force: true }).catch(() => {})
  })

  // DS1S 批量删除快照与范围决策（纯函数直检，fast）：目录树聚合的形状与折叠 /
  // 截断口径、undecided 的 scope 覆盖去重、范围前缀命中规则 —— 引擎消费路径的
  // 端到端行为由 DS1B 真实多轮覆盖，这里只锁纯函数语义。
  await section('DS1S：批量删除快照聚合与范围计算（纯函数）', async () => {
    const I = services.sync._internals
    // 嵌套树：sub/（2 文件）+ sub/deep/（1 文件）+ 顶层 2 文件 → 目录先 DFS、
    // 文件随后；目录 files/bytes 为子树聚合
    const members = new Map([
      ['sub/a.txt', 10],
      ['sub/b.txt', 20],
      ['sub/deep/c.txt', 40],
      ['g0.txt', 1],
      ['g1.txt', 2],
    ])
    const batch = I.buildDeleteBatch(members, 12345)
    check('DS1S 快照 total / bytes 为全量真值', batch.total === 5 && batch.bytes === 73, JSON.stringify({ total: batch.total, bytes: batch.bytes }))
    const dirSub = batch.nodes.find((n) => n.rel === 'sub')
    const dirDeep = batch.nodes.find((n) => n.rel === 'sub/deep')
    check(
      'DS1S 目录节点子树聚合（目录先于文件、深度优先）',
      !!dirSub && dirSub.isDir && dirSub.files === 3 && dirSub.bytes === 70 && !!dirDeep && dirDeep.files === 1 && batch.nodes.findIndex((n) => n.rel === 'sub') < batch.nodes.findIndex((n) => n.rel === 'sub/a.txt'),
      JSON.stringify(batch.nodes.map((n) => [n.rel, n.isDir, n.files]))
    )
    // 全平树超出节点上限 → 按 rel 排序截断，total 仍为真值
    const flat = new Map(Array.from({ length: 3100 }, (_, i) => [`f${String(i).padStart(5, '0')}.txt`, 1]))
    const flatBatch = I.buildDeleteBatch(flat, 1)
    check('DS1S 全平树截断到节点上限且 total 不失真', flatBatch.nodes.length === 3000 && flatBatch.total === 3100, `nodes=${flatBatch.nodes.length} total=${flatBatch.total}`)
    // 深树超出上限 → 最深目录折叠进父目录（父目录可整体决策），total 不失真
    const deep = new Map()
    for (let d = 0; d < 55; d++) for (let f = 0; f < 60; f++) deep.set(`d${String(d).padStart(2, '0')}/f${String(f).padStart(2, '0')}.txt`, 1)
    const deepBatch = I.buildDeleteBatch(deep, 1)
    check(
      'DS1S 深树折叠：节点数收敛至上限、total 保持全量、目录节点整体可决策',
      deepBatch.nodes.length <= 3000 && deepBatch.total === 3300 && deepBatch.nodes.some((n) => n.isDir && n.files === 60),
      `nodes=${deepBatch.nodes.length} total=${deepBatch.total}`
    )
    // undecided：scope 覆盖按树去重（空前缀 = 全部；嵌套 scope 不双计）。
    // 树实况：a/ 6 个（x.txt + b/ 5 个）+ 顶层 z.txt = 7
    const b10 = { at: 1, total: 7, bytes: 0, nodes: [{ rel: 'a', isDir: true, files: 6, bytes: 0 }, { rel: 'a/x.txt', isDir: false, files: 1, bytes: 0 }, { rel: 'a/b', isDir: true, files: 5, bytes: 0 }, { rel: 'a/b/y.txt', isDir: false, files: 1, bytes: 0 }, { rel: 'z.txt', isDir: false, files: 1, bytes: 0 }] }
    check('DS1S 无 scope 时 undecided = total', I.computeUndecidedFiles(b10, []) === 7, '')
    check('DS1S 空前缀 scope 覆盖全部', I.computeUndecidedFiles(b10, [{ prefix: '', choice: 'keep', at: 1, gen: 1 }]) === 0, '')
    check(
      'DS1S 子树 scope 覆盖其文件、其余保持未决策',
      I.computeUndecidedFiles(b10, [{ prefix: 'a', choice: 'keep', at: 1, gen: 1 }]) === 1,
      ''
    )
    check(
      'DS1S 嵌套 scope 重叠不双计',
      I.computeUndecidedFiles(b10, [{ prefix: 'a', choice: 'keep', at: 1, gen: 1 }, { prefix: 'a/b', choice: 'delete', at: 2, gen: 1 }]) === 1,
      ''
    )
    check('DS1S scopeHitsRel 与引擎匹配规则一致（精确 / 子路径 / 空前缀 / 不命中）', I.scopeHitsRel('a', 'a') && I.scopeHitsRel('a', 'a/b/c.txt') && I.scopeHitsRel('', 'x.txt') && !I.scopeHitsRel('a', 'ab.txt') && !I.scopeHitsRel('a/b', 'a.txt'), '')
  })

  // DS1B 批量删除快照与范围决策（真实多轮）：目录树「全部不删除」覆盖整批（含
  // 逐文件挂起表装不下的部分）；keep 决策按方向消费 —— delete-local（云端已缺、
  // 本地完好）恢复上传（云端由本地恢复，两端重新一致，恢复成功后 scope 零匹配
  // 自动剪枝，其后的删除恢复常规镜像）；「全部确认删除」整批执行；子树 scope 与
  // 文件级 scope 共存时最具体者胜、跨代决策不翻案已盖章记录。
  // [慢组登记原因] 真实多轮等待（挂起 → scope 消费 → 剪枝 / 快照清除各需一轮）
  await slowSection('DS1B：批量删除快照与目录树范围决策', '真实多轮等待（挂起 → scope 消费 → 剪枝 / 快照清除各需一轮）', async () => {
    // —— keep 腿：基线 115（阈值 max(50,23)=50）：sub/ 60 文件 + 顶层 55 文件
    const L = path.join(os.tmpdir(), `wdsync-e2e-ds1b-${Date.now()}`)
    const d = () => ({ id: 'ds1b', localPath: L, remotePath: '/ds1b', mode: 'two-way' })
    await fsp.mkdir(path.join(L, 'sub'), { recursive: true })
    for (let i = 0; i < 60; i++) await fsp.writeFile(path.join(L, 'sub', `f${i}.txt`), `s${i}`)
    for (let i = 0; i < 55; i++) await fsp.writeFile(path.join(L, `g${i}.txt`), `t${i}`)
    await services.sync.syncDirectory(cfg, d(), SP, {})
    // 远端删除 sub/ 整目录（60 > 50 触发拦截）→ 零删除 + 快照承载全量（含逐文件
    // 记录之外的形态信息：sub 目录节点 60 文件）
    await fsp.rm(path.join(ROOT, 'ds1b', 'sub'), { recursive: true, force: true })
    const r1 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check('DS1B 超阈值拦截：本轮零删除', r1.deleted === 0 && r1.deleteHeld === 60, JSON.stringify({ deleted: r1.deleted, deleteHeld: r1.deleteHeld }))
    const b1 = await services.sync.listDeleteBatch(d())
    check(
      'DS1B 快照承载全量未决策（目录节点聚合 + undecided 真值）',
      !!b1 && b1.total === 60 && b1.undecided === 60 && b1.scopes.length === 0 && b1.nodes.some((n) => n.rel === 'sub' && n.isDir && n.files === 60),
      JSON.stringify(b1 && { total: b1.total, undecided: b1.undecided, nodes: b1.nodes.length })
    )
    // 「全部不删除」（空前缀 scope）→ 覆盖整批并盖章逐文件记录；下一轮按方向消费：
    // 远端删除（delete-local）→ 恢复上传（本地原样、云端恢复）
    const keepRes = await services.sync.setDeleteScope(d(), '', 'keep')
    check('DS1B 「全部不删除」覆盖整批并回写逐文件记录', keepRes.covered === 60 && keepRes.stamped === 60, JSON.stringify(keepRes))
    const r2 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check(
      'DS1B 「全部不删除」下一轮恢复上传（本地原样、云端恢复、零删除零挂起）',
      r2.deleted === 0 && r2.deleteHeld === 0 && r2.deleteKept === 0 && r2.deleteRestored === 60 && r2.uploaded === 60
        && fs.existsSync(path.join(L, 'sub', 'f0.txt')) && fs.existsSync(path.join(ROOT, 'ds1b', 'sub', 'f0.txt')),
      JSON.stringify({ deleted: r2.deleted, held: r2.deleteHeld, kept: r2.deleteKept, restored: r2.deleteRestored, uploaded: r2.uploaded })
    )
    check('DS1B 全部决策消费后快照清除', (await services.sync.listDeleteBatch(d())) === null, '')
    // keep 决策对后续新删除同样生效（不再询问）：云端再删顶层 55 个 → 自动恢复上传
    for (let i = 0; i < 55; i++) await fsp.rm(path.join(ROOT, 'ds1b', `g${i}.txt`))
    const r3 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check(
      'DS1B keep 作用于后续新删除（自动恢复云端、不再询问）',
      r3.deleted === 0 && r3.deleteHeld === 0 && r3.deleteRestored === 55 && fs.existsSync(path.join(L, 'g0.txt')) && fs.existsSync(path.join(ROOT, 'ds1b', 'g0.txt')),
      JSON.stringify({ deleted: r3.deleted, held: r3.deleteHeld, restored: r3.deleteRestored })
    )
    // 恢复完成后情形消失：空轮剪枝 scope，其后的远端删除不再被旧决策压制
    //（低于阈值的单文件删除恢复常规镜像执行）
    await services.sync.syncDirectory(cfg, d(), SP, {})
    await fsp.rm(path.join(ROOT, 'ds1b', 'g0.txt'))
    const r5 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check(
      'DS1B 情形消失后 scope 剪枝（其后的删除恢复常规镜像，不再被压制）',
      r5.deleted === 1 && r5.deleteRestored === 0 && !fs.existsSync(path.join(L, 'g0.txt')),
      JSON.stringify({ deleted: r5.deleted, restored: r5.deleteRestored })
    )
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})

    // —— delete 腿：基线 60，远端删 59（59 > 50 拦截）→「全部确认删除」下一轮执行
    //（留 1 个文件避免「本地删光」撞 DS3 的空根保护 —— 两层保护互斥各管一段）
    const LD = path.join(os.tmpdir(), `wdsync-e2e-ds1d-${Date.now()}`)
    const dD = () => ({ id: 'ds1d', localPath: LD, remotePath: '/ds1d', mode: 'two-way' })
    await fsp.mkdir(LD, { recursive: true })
    for (let i = 0; i < 60; i++) await fsp.writeFile(path.join(LD, `f${i}.txt`), `c${i}`)
    await services.sync.syncDirectory(cfg, dD(), SP, {})
    for (let i = 0; i < 59; i++) await fsp.rm(path.join(ROOT, 'ds1d', `f${i}.txt`))
    const dd1 = await services.sync.syncDirectory(cfg, dD(), SP, {})
    check('DS1B delete 腿前置：59 项拦截', dd1.deleted === 0 && dd1.deleteHeld === 59, JSON.stringify({ deleted: dd1.deleted, deleteHeld: dd1.deleteHeld }))
    const delRes = await services.sync.setDeleteScope(dD(), '', 'delete')
    check('DS1B 「全部确认删除」覆盖整批', delRes.covered === 59, JSON.stringify(delRes))
    const dd2 = await services.sync.syncDirectory(cfg, dD(), SP, {})
    check(
      'DS1B 「全部确认删除」下一轮执行（本地进回收站）',
      dd2.deleted === 59 && dd2.deleteHeld === 0 && !fs.existsSync(path.join(LD, 'f0.txt')) && fs.existsSync(path.join(LD, 'f59.txt')),
      JSON.stringify({ deleted: dd2.deleted, deleteHeld: dd2.deleteHeld })
    )
    check('DS1B delete 消费完毕后快照清除', (await services.sync.listDeleteBatch(dD())) === null, '')
    await fsp.rm(LD, { recursive: true, force: true }).catch(() => {})

    // —— 混合腿：子树 scope + 文件级 scope（最具体者胜）+ 跨代不翻案
    const L2 = path.join(os.tmpdir(), `wdsync-e2e-ds1c-${Date.now()}`)
    const d2 = () => ({ id: 'ds1c', localPath: L2, remotePath: '/ds1c', mode: 'two-way' })
    await fsp.mkdir(path.join(L2, 'keep'), { recursive: true })
    for (let i = 0; i < 40; i++) await fsp.writeFile(path.join(L2, 'keep', `k${i}.txt`), `k${i}`)
    for (let i = 0; i < 20; i++) await fsp.writeFile(path.join(L2, `t${i}.txt`), `t${i}`)
    await services.sync.syncDirectory(cfg, d2(), SP, {})
    // 远端删除 keep/ 全部 40 + 顶层 15 → fresh 55 > 50 拦截
    for (let i = 0; i < 40; i++) await fsp.rm(path.join(ROOT, 'ds1c', 'keep', `k${i}.txt`))
    for (let i = 0; i < 15; i++) await fsp.rm(path.join(ROOT, 'ds1c', `t${i}.txt`))
    const c1 = await services.sync.syncDirectory(cfg, d2(), SP, {})
    check('DS1B 混合腿前置：批次拦截', c1.deleteHeld === 55 && c1.deleted === 0, JSON.stringify({ deleted: c1.deleted, deleteHeld: c1.deleteHeld }))
    await services.sync.setDeleteScope(d2(), 'keep', 'keep')
    await services.sync.setDeleteScope(d2(), 'keep/k0.txt', 'delete')
    const b2 = await services.sync.listDeleteBatch(d2())
    check(
      'DS1B 未决策数按 scope 覆盖扣减（子树 keep 后顶层 15 仍未决策）',
      !!b2 && b2.undecided === 15 && b2.scopes.length === 2,
      JSON.stringify(b2 && { undecided: b2.undecided, scopes: b2.scopes })
    )
    const c2 = await services.sync.syncDirectory(cfg, d2(), SP, {})
    check(
      'DS1B 文件级 scope 压过子树 keep（最具体者胜：k0 删除、其余 39 恢复上传）；顶层无 scope 部分维持待确认',
      c2.deleted === 1 && c2.deleteKept === 0 && c2.deleteRestored === 39 && c2.deleteHeld === 15
        && !fs.existsSync(path.join(L2, 'keep', 'k0.txt')) && fs.existsSync(path.join(L2, 'keep', 'k1.txt'))
        && fs.existsSync(path.join(ROOT, 'ds1c', 'keep', 'k1.txt')) && fs.existsSync(path.join(L2, 't0.txt')),
      JSON.stringify({ deleted: c2.deleted, kept: c2.deleteKept, restored: c2.deleteRestored, held: c2.deleteHeld })
    )
    // 顶层 15 用「全部确认删除」收尾：盖章只覆盖未决策项，已盖章的 keep 子树不翻案
    const finRes = await services.sync.setDeleteScope(d2(), '', 'delete')
    check('DS1B 收尾决策只覆盖剩余未决策（15）', finRes.covered === 15, JSON.stringify(finRes))
    const c3 = await services.sync.syncDirectory(cfg, d2(), SP, {})
    check(
      'DS1B 收尾执行：顶层 15 删除、keep 子树原样',
      c3.deleted === 15 && c3.deleteHeld === 0 && !fs.existsSync(path.join(L2, 't0.txt')) && !fs.existsSync(path.join(L2, 't14.txt')) && fs.existsSync(path.join(L2, 't15.txt')) && fs.existsSync(path.join(L2, 'keep', 'k1.txt')),
      JSON.stringify({ deleted: c3.deleted, held: c3.deleteHeld })
    )
    check('DS1B 全部消费完毕后快照清除', (await services.sync.listDeleteBatch(d2())) === null, '')
    await fsp.rm(L2, { recursive: true, force: true }).catch(() => {})
  })

  // DS2 本地删除走回收站：正常经 ztools.shellTrashItem 进回收目录；失败（API 抛错 /
  // 宿主未注入）跳过该文件并记录，绝不退化 unlink（文件留在原地、基线保留）

  await section('DS2：本地删除走回收站（不退化 unlink）', async () => {
    const L = path.join(os.tmpdir(), `wdsync-e2e-ds2-${Date.now()}`)
    const d = () => ({ id: 'ds2', localPath: L, remotePath: '/ds2', mode: 'two-way' })
    await fsp.mkdir(L, { recursive: true })
    for (const n of ['a.txt', 'b.txt', 'c.txt', 'e.txt']) await fsp.writeFile(path.join(L, n), `ds2-${n}`)
    await services.sync.syncDirectory(cfg, d(), SP, {})
    // —— 正常通过：远端删除 2 个 → 本地经回收站 API 删除，文件本体保留在回收目录
    trashLog.length = 0
    await fsp.rm(path.join(ROOT, 'ds2', 'a.txt'))
    await fsp.rm(path.join(ROOT, 'ds2', 'b.txt'))
    const ok = await services.sync.syncDirectory(cfg, d(), SP, {})
    const trashedNames = fs.readdirSync(TRASH_DIR)
    check(
      'DS2 删除经 shellTrashItem 落地（本地消失、远端目标态达成）',
      ok.deleted === 2 && !fs.existsSync(path.join(L, 'a.txt')) && !fs.existsSync(path.join(L, 'b.txt')) && trashLog.length === 2,
      JSON.stringify({ deleted: ok.deleted, trashCalls: trashLog.length })
    )
    check('DS2 回收目录保留文件本体（可找回）', trashedNames.some((n) => n.endsWith('a.txt')) && trashedNames.some((n) => n.endsWith('b.txt')), trashedNames.join(','))
    check('DS2 回收站删除后基线条目移除', (await services.sync._internals.baselineEntry(d(), 'a.txt')) === null, '')
    // —— 保护生效 ①：回收站调用抛错 → 跳过并记录，不退化 unlink
    trashFailNext = 1
    await fsp.rm(path.join(ROOT, 'ds2', 'c.txt'))
    let e1 = null
    try {
      await services.sync.syncDirectory(cfg, d(), SP, {})
    } catch (e) {
      e1 = e
    }
    check(
      'DS2 回收站失败跳过并记录（文件保留、基线保留）',
      !!e1 && /未能放入回收站/.test(e1.message) && fs.existsSync(path.join(L, 'c.txt')) && (await services.sync._internals.baselineEntry(d(), 'c.txt')) != null,
      e1 && e1.message
    )
    check('DS2 失败路径确实调用了回收站 API（未绕过）', trashLog.some((p) => p.endsWith('c.txt')), trashLog.map((p) => path.basename(p)).join(','))
    // —— 保护生效 ②：宿主未注入回收站接口 → 同样跳过并记录
    trashMissing = true
    installTrash()
    await fsp.rm(path.join(ROOT, 'ds2', 'e.txt'))
    let e2 = null
    try {
      await services.sync.syncDirectory(cfg, d(), SP, {})
    } catch (e) {
      e2 = e
    }
    check(
      'DS2 宿主无回收站接口跳过并记录（不删除）',
      !!e2 && /不支持放入回收站/.test(e2.message) && fs.existsSync(path.join(L, 'e.txt')) && (await services.sync._internals.baselineEntry(d(), 'e.txt')) != null,
      e2 && e2.message
    )
    trashMissing = false
    installTrash()
    // 接口恢复后（模拟下一轮）删除收敛
    const ok2 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check('DS2 接口恢复后下一轮删除收敛（e.txt 进回收站）', ok2.deleted >= 1 && !fs.existsSync(path.join(L, 'e.txt')), JSON.stringify({ deleted: ok2.deleted }))
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
  })

  // DS3 本地根健康检查：根目录不存在 / 不可读 / 空目录+非空基线（疑似未挂载或被清空）
  // → 整轮中止零删除（远端原样）；正常目录照常同步

  await section('DS3：本地根健康检查', async () => {
    const L = path.join(os.tmpdir(), `wdsync-e2e-ds3-${Date.now()}`)
    const d = () => ({ id: 'ds3', localPath: L, remotePath: '/ds3', mode: 'two-way' })
    await fsp.mkdir(L, { recursive: true })
    for (const n of ['a.txt', 'b.txt', 'c.txt']) await fsp.writeFile(path.join(L, n), `ds3-${n}`)
    const ok = await services.sync.syncDirectory(cfg, d(), SP, {})
    check('DS3 正常根目录照常同步', ok.uploaded === 3, JSON.stringify(ok))
    // —— 保护 ①：根目录不存在（改名挪走模拟消失 / 未挂载路径）
    await fsp.rename(L, `${L}-gone`)
    let e1 = null
    try {
      await services.sync.syncDirectory(cfg, d(), SP, {})
    } catch (e) {
      e1 = e
    }
    check(
      'DS3 根目录不存在 → 整轮中止，远端原样',
      !!e1 && /无法访问电脑上的同步文件夹/.test(e1.message) && fs.readdirSync(path.join(ROOT, 'ds3')).length === 3,
      e1 && e1.message
    )
    await fsp.rename(`${L}-gone`, L)
    // —— 保护 ②：根目录不可读（POSIX chmod 000；Windows 该形态由 icacls 类 ACL 承担，
    // 属平台差异，此处不重复注入 —— 见 README 已知边界）
    if (process.platform !== 'win32') {
      await fsp.chmod(L, 0o000)
      let e2 = null
      try {
        await services.sync.syncDirectory(cfg, d(), SP, {})
      } catch (e) {
        e2 = e
      }
      check(
        'DS3 根目录不可读 → 整轮中止，远端原样',
        !!e2 && /无法访问电脑上的同步文件夹/.test(e2.message) && fs.readdirSync(path.join(ROOT, 'ds3')).length === 3,
        e2 && e2.message
      )
      await fsp.chmod(L, 0o755)
    } else {
      check('DS3 根目录不可读（POSIX 形态）在 Windows 跳过（平台差异，未验证）', true)
    }
    // —— 保护 ③：空目录 + 非空基线（外置盘/网络盘掉线后挂载点残留的典型形态；
    // 用户真的删光本地文件也会命中 —— 保守取向，由目录配置检查 / 批量删除确认通道解决）
    for (const n of ['a.txt', 'b.txt', 'c.txt']) await fsp.unlink(path.join(L, n))
    let e3 = null
    try {
      await services.sync.syncDirectory(cfg, d(), SP, {})
    } catch (e) {
      e3 = e
    }
    check(
      'DS3 空目录+非空基线（疑似未挂载/被清空）→ 整轮中止，远端原样',
      !!e3 && /可能是移动硬盘或网络盘没连接|被清空/.test(e3.message) && fs.readdirSync(path.join(ROOT, 'ds3')).length === 3,
      e3 && e3.message
    )
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
  })

  // DS4 远端根 404 重建保护：远端整根消失（404）且本地基线非空时，先进入「根丢失
  // 决策闸」—— 登记 kind='root-lost' 挂起并停轮（零删除零传输、不自动重建）；用户
  // 选择「重新上传」后按重建保护语义执行 —— delete-local 改判为恢复上传（远端缺失
  // 是根消失伪象，复活取向）；和解完成后自动恢复删除传播。基线为空（首次同步）
  // 不触发决策闸，维持自动重建。

  await section('DS4：远端根 404 重建保护', async () => {
    const L = path.join(os.tmpdir(), `wdsync-e2e-ds4-${Date.now()}`)
    const d = () => ({ id: 'ds4', localPath: L, remotePath: '/ds4', mode: 'two-way' })
    await fsp.mkdir(L, { recursive: true })
    for (let i = 0; i < 8; i++) await fsp.writeFile(path.join(L, `f${i}.txt`), `ds4-${i}`)
    const r1 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check('DS4 首次同步（基线为空的 404 重建不触发保护）', r1.uploaded === 8 && r1.deleteRootGuard === 0, JSON.stringify({ uploaded: r1.uploaded, guard: r1.deleteRootGuard }))
    // —— 决策闸：删除整个远端根 → 停轮登记待决策（零删除零传输，且不自动重建）
    await services.dav.remove(cfg, '/ds4')
    let eLost = null
    try {
      await services.sync.syncDirectory(cfg, d(), SP, {})
    } catch (e) {
      eLost = e
    }
    let localLeft = 0
    for (let i = 0; i < 8; i++) if (fs.existsSync(path.join(L, `f${i}.txt`))) localLeft++
    check(
      'DS4 根丢失停轮：等待决策，零删除零传输且不重建',
      !!eLost && /已不存在/.test(eLost.message) && eLost.summary && eLost.summary.rootLostHeld === 1 && localLeft === 8 && !fs.existsSync(path.join(ROOT, 'ds4')),
      eLost && eLost.message
    )
    const lostPending = (await services.sync._internals.getPendings(d())).find((p) => p.kind === 'root-lost')
    check(
      'DS4 根丢失挂起已登记（kind=root-lost、无 choice、含受影响文件数）',
      !!lostPending && !lostPending.choice && lostPending.local && lostPending.local.size === 8,
      JSON.stringify(lostPending)
    )
    // —— 用户选择「重新上传」→ 重建轮：零删除 + 恢复上传 + 保护标记
    await services.sync.setPendingChoice(d(), '.', 'upload')
    const r2 = await services.sync.syncDirectory(cfg, d(), SP, {})
    localLeft = 0
    for (let i = 0; i < 8; i++) if (fs.existsSync(path.join(L, `f${i}.txt`))) localLeft++
    check(
      'DS4 重建轮：零本地删除 + 删除改判为恢复上传（8 个全部重传）',
      r2.deleted === 0 && r2.uploaded === 8 && r2.deleteRootGuard === 8 && localLeft === 8,
      JSON.stringify({ deleted: r2.deleted, uploaded: r2.uploaded, guard: r2.deleteRootGuard, localLeft })
    )
    check('DS4 根丢失挂起随选择消费清除', (await services.sync._internals.getPendings(d())).length === 0, JSON.stringify(await services.sync._internals.getPendings(d())))
    check('DS4 远端恢复全部 8 个文件', fs.readdirSync(path.join(ROOT, 'ds4')).length === 8, '')
    check('DS4 保护标记写入 meta', (await services.sync._internals.getDirMeta(d())).rootRebuilt != null, '')
    // —— 和解完成 → 保护解除（干净轮 guard=0 自动清标记）
    const r3 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check('DS4 和解后干净轮为 no-op', isNoop(r3), JSON.stringify(r3))
    check('DS4 和解完成自动解除保护标记', (await services.sync._internals.getDirMeta(d())).rootRebuilt === undefined, '')
    // —— 正常通过：解除后删除传播恢复正常
    await fsp.unlink(path.join(L, 'f0.txt'))
    const r4 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check('DS4 解除后删除传播恢复（单文件删除正常执行）', r4.deleted === 1 && !fs.existsSync(path.join(ROOT, 'ds4', 'f0.txt')), JSON.stringify({ deleted: r4.deleted }))
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
  })

  // DS4b 交互优先级：已确认的删除（choice=delete）优先于远端根重建保护 ——
  // 场景：远端批量删除触发阈值挂起 → 用户确认其中 1 个 → 此后远端整根消失重建，
  // 重建轮里已确认者照删（显式同意），未确认者继续挂起，其余未删文件恢复上传

  await section('DS4b：确认删除优先于根重建保护', async () => {
    const L = path.join(os.tmpdir(), `wdsync-e2e-ds4b-${Date.now()}`)
    const d = () => ({ id: 'ds4b', localPath: L, remotePath: '/ds4b', mode: 'two-way' })
    await fsp.mkdir(L, { recursive: true })
    for (let i = 0; i < 55; i++) await fsp.writeFile(path.join(L, `f${i}.txt`), `ds4b-${i}`)
    await services.sync.syncDirectory(cfg, d(), SP, {})
    // 远端删 54 个（留 f54）→ 54 > max(50,11) 触发阈值 → 全部挂起待确认
    for (let i = 0; i < 54; i++) await fsp.rm(path.join(ROOT, 'ds4b', `f${i}.txt`))
    const h1 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check('DS4b 前置：远端批量删除触发阈值挂起', h1.deleted === 0 && h1.deleteHeld === 54, JSON.stringify({ deleted: h1.deleted, deleteHeld: h1.deleteHeld }))
    // 用户确认 1 个（f0），其余 53 个保持待确认
    await services.sync.setPendingChoice(d(), 'f0.txt', 'delete')
    // 远端整根消失（连带 f54 的远端副本）→ 根丢失决策闸先停轮：显式确认的删除
    // 也必须等根级决策落地
    await services.dav.remove(cfg, '/ds4b')
    let eLost = null
    try {
      await services.sync.syncDirectory(cfg, d(), SP, {})
    } catch (e) {
      eLost = e
    }
    check('DS4b 根丢失停轮：决策前不执行任何删除与上传', !!eLost && /已不存在/.test(eLost.message), eLost && eLost.message)
    // 根级选择「重新上传」→ 重建轮：确认者优先执行，未确认者继续挂起
    await services.sync.setPendingChoice(d(), '.', 'upload')
    trashLog.length = 0
    const r = await services.sync.syncDirectory(cfg, d(), SP, {})
    check(
      'DS4b 重建轮：确认者照删（显式同意优先于根重建保护）',
      r.deleted === 1 && !fs.existsSync(path.join(L, 'f0.txt')) && trashLog.some((p) => p.endsWith('f0.txt')),
      JSON.stringify({ deleted: r.deleted })
    )
    check(
      'DS4b 重建轮：未确认者继续挂起、未删文件恢复上传',
      r.deleteHeld === 53 && r.deleteRootGuard === 1 && r.uploaded === 1 && fs.readdirSync(path.join(ROOT, 'ds4b')).length === 1,
      JSON.stringify({ deleteHeld: r.deleteHeld, guard: r.deleteRootGuard, uploaded: r.uploaded, remote: fs.readdirSync(path.join(ROOT, 'ds4b')) })
    )
    check('DS4b 确认标记随落地清除（剩 53 个待确认）', (await services.sync._internals.getPendings(d())).length === 53, '')
    // 后续轮：和解完成 → 保护解除；53 个挂起仍持续等待确认（与保护独立）
    const r2 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check(
      'DS4b 和解后保护解除、挂起持续等待确认',
      r2.deleteRootGuard === 0 && r2.deleteHeld === 53 && r2.deleted === 0 && (await services.sync._internals.getDirMeta(d())).rootRebuilt === undefined,
      JSON.stringify({ guard: r2.deleteRootGuard, deleteHeld: r2.deleteHeld, deleted: r2.deleted })
    )
    // 全部确认 → 收敛：本地进回收站，两端各剩 f54
    for (let i = 1; i < 54; i++) await services.sync.setPendingChoice(d(), `f${i}.txt`, 'delete')
    const r3 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check(
      'DS4b 全部确认后收敛（两端各剩 1 个文件）',
      r3.deleted === 53 && fs.readdirSync(L).length === 1 && fs.readdirSync(path.join(ROOT, 'ds4b')).length === 1,
      JSON.stringify({ deleted: r3.deleted, local: fs.readdirSync(L), remote: fs.readdirSync(path.join(ROOT, 'ds4b')) })
    )
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
  })

  // DS4c 远端根丢失决策流的其余分支：
  //   ① 自愈 —— 待决策期间根被挪回来（用户还原）：挂起自动撤销、本轮照常同步，
  //      无需用户操作；
  //   ② remove-local —— 用户选择「移除本地」：未改动文件进回收站（跟随云端删除），
  //      本地有改动的文件保留并重新上传（改动优先于删除的不变量保持），云端重建；
  //      和解完成后 meta.rootLostRemoval 标记自动解除，删除传播（含批量阈值）恢复。

  await section('DS4c：根丢失决策 remove-local 与自愈', async () => {
    const L = path.join(os.tmpdir(), `wdsync-e2e-ds4c-${Date.now()}`)
    const d = () => ({ id: 'ds4c', localPath: L, remotePath: '/ds4c', mode: 'two-way' })
    await fsp.mkdir(L, { recursive: true })
    for (let i = 0; i < 4; i++) await fsp.writeFile(path.join(L, `f${i}.txt`), `ds4c-${i}`)
    await services.sync.syncDirectory(cfg, d(), SP, {})
    // —— ① 自愈：根丢失登记待决策 → 用户把根放回（重建同名根、文件原样）→
    //    下一轮挂起自动撤销，本地文件原样、零删除零上传
    await services.dav.remove(cfg, '/ds4c')
    let e1 = null
    try {
      await services.sync.syncDirectory(cfg, d(), SP, {})
    } catch (e) {
      e1 = e
    }
    check('DS4c 根丢失停轮（待决策）', !!e1 && /已不存在/.test(e1.message) && !!(await services.sync._internals.getPendings(d())).find((p) => p.kind === 'root-lost'), e1 && e1.message)
    await fsp.mkdir(path.join(ROOT, 'ds4c'), { recursive: true })
    for (let i = 0; i < 4; i++) await fsp.writeFile(path.join(ROOT, 'ds4c', `f${i}.txt`), `ds4c-${i}`)
    const rSelf = await services.sync.syncDirectory(cfg, d(), SP, {})
    let localLeft = 0
    for (let i = 0; i < 4; i++) if (fs.existsSync(path.join(L, `f${i}.txt`))) localLeft++
    check(
      'DS4c 决策前根恢复：挂起自动撤销，本地原样',
      rSelf.deleted === 0 && rSelf.uploaded === 0 && localLeft === 4 && (await services.sync._internals.getPendings(d())).length === 0,
      JSON.stringify({ r: rSelf, localLeft, pendings: await services.sync._internals.getPendings(d()) })
    )
    // —— ② remove-local：再删根 → 停轮 → 选择「移除本地」。本地先改 f0（改动优先
    //    于删除：不进回收站，而是重新上传）
    await services.dav.remove(cfg, '/ds4c')
    let e2 = null
    try {
      await services.sync.syncDirectory(cfg, d(), SP, {})
    } catch (e) {
      e2 = e
    }
    check('DS4c 再次根丢失停轮', !!e2 && /已不存在/.test(e2.message), e2 && e2.message)
    await fsp.writeFile(path.join(L, 'f0.txt'), 'ds4c-modified')
    trashLog.length = 0
    await services.sync.setPendingChoice(d(), '.', 'remove-local')
    const r2 = await services.sync.syncDirectory(cfg, d(), SP, {})
    let removed = 0
    for (let i = 1; i < 4; i++) if (!fs.existsSync(path.join(L, `f${i}.txt`))) removed++
    check(
      'DS4c 移除轮：未改动文件进回收站、改动文件保留并重传、云端重建',
      r2.deleted === 3 && removed === 3 && fs.existsSync(path.join(L, 'f0.txt')) && r2.uploaded === 1 && fs.existsSync(path.join(ROOT, 'ds4c', 'f0.txt')) && trashLog.length === 3,
      JSON.stringify({ deleted: r2.deleted, removed, uploaded: r2.uploaded, trash: trashLog.length })
    )
    check('DS4c 移除标记写入 meta（待和解）', (await services.sync._internals.getDirMeta(d())).rootLostRemoval != null, JSON.stringify(await services.sync._internals.getDirMeta(d())))
    // —— 和解完成：干净轮同时解除 rootLostRemoval 与 rootRebuilt，恢复正常语义
    const r3 = await services.sync.syncDirectory(cfg, d(), SP, {})
    const meta3 = await services.sync._internals.getDirMeta(d())
    check('DS4c 和解后干净轮 no-op 且解除标记', isNoop(r3) && meta3.rootLostRemoval === undefined && meta3.rootRebuilt === undefined, JSON.stringify({ r: r3, meta: meta3 }))
    // —— 标记解除后传播恢复：本地删 f0 → delete-remote 照常执行（不再被改判为重传）。
    //    同时新增 extra.txt 保持本地根非空（空目录 + 非空基线会命中本地根健康检查、
    //    整轮中止 —— 那是 DS3 的独立保护，不在本用例范围），并顺带验证上传通道恢复
    await fsp.writeFile(path.join(L, 'extra.txt'), 'ds4c-extra')
    await fsp.unlink(path.join(L, 'f0.txt'))
    const r4 = await services.sync.syncDirectory(cfg, d(), SP, {})
    check(
      'DS4c 标记解除后删除传播恢复',
      r4.deleted === 1 && r4.uploaded === 1 && !fs.existsSync(path.join(ROOT, 'ds4c', 'f0.txt')),
      JSON.stringify({ deleted: r4.deleted, uploaded: r4.uploaded })
    )
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
  })

  // DS5 空目录清理：只清理「因本轮同步删除而变空」的目录（两侧各自处理自己执行的
  // 删除留下的空目录）；非空目录不动；远端 DELETE 前逐目录 PROPFIND 复核，他机在
  // 删除后写入的新内容使清理跳过（不递归误删）

  // [慢组登记原因] 远端 DELETE 前逐目录 PROPFIND 复核的多轮等待；删除传播基本语义由 SAFE 覆盖
  await slowSection('DS5：空目录清理（两端）', '远端 DELETE 前逐目录 PROPFIND 复核的多轮等待；删除传播基本语义由 SAFE 覆盖', async () => {
    // —— 正常（远端侧）：本地删除 sub/a.txt、sub/inner/b.txt → delete-remote ×2，
    // 远端 sub/inner、sub 变空被清理；本地目录是用户自己的删除行为，不在引擎清理范围
    const L1 = path.join(os.tmpdir(), `wdsync-e2e-ds5a-${Date.now()}`)
    const d1 = () => ({ id: 'ds5a', localPath: L1, remotePath: '/ds5a', mode: 'two-way' })
    await fsp.mkdir(path.join(L1, 'sub', 'inner'), { recursive: true })
    await fsp.writeFile(path.join(L1, 'top.txt'), 'top')
    await fsp.writeFile(path.join(L1, 'sub', 'a.txt'), 'a')
    await fsp.writeFile(path.join(L1, 'sub', 'inner', 'b.txt'), 'b')
    await services.sync.syncDirectory(cfg, d1(), SP, {})
    await fsp.unlink(path.join(L1, 'sub', 'a.txt'))
    await fsp.unlink(path.join(L1, 'sub', 'inner', 'b.txt'))
    const r1 = await services.sync.syncDirectory(cfg, d1(), SP, {})
    check(
      'DS5 远端空目录清理（嵌套子树自底向上）',
      r1.deleted === 2 && r1.dirsPrunedRemote === 2 && !fs.existsSync(path.join(ROOT, 'ds5a', 'sub')) && fs.existsSync(path.join(ROOT, 'ds5a', 'top.txt')),
      JSON.stringify({ deleted: r1.deleted, dirsPrunedRemote: r1.dirsPrunedRemote })
    )
    check('DS5 本地目录（用户自己的删除）不清理', fs.existsSync(path.join(L1, 'sub')), '')
    await fsp.rm(L1, { recursive: true, force: true }).catch(() => {})

    // —— 正常（本地侧）：远端删除 x/a.txt → delete-local 进回收站 → 本地 x/ 变空被清理
    const L2 = path.join(os.tmpdir(), `wdsync-e2e-ds5b-${Date.now()}`)
    const d2 = () => ({ id: 'ds5b', localPath: L2, remotePath: '/ds5b', mode: 'two-way' })
    await fsp.mkdir(path.join(L2, 'x'), { recursive: true })
    await fsp.writeFile(path.join(L2, 'x', 'a.txt'), 'a')
    await services.sync.syncDirectory(cfg, d2(), SP, {})
    await fsp.rm(path.join(ROOT, 'ds5b', 'x', 'a.txt'))
    const r2 = await services.sync.syncDirectory(cfg, d2(), SP, {})
    check(
      'DS5 本地空目录清理（delete-local 后 rmdir）',
      r2.deleted === 1 && r2.dirsPrunedLocal === 1 && !fs.existsSync(path.join(L2, 'x')),
      JSON.stringify({ deleted: r2.deleted, dirsPrunedLocal: r2.dirsPrunedLocal })
    )
    await fsp.rm(L2, { recursive: true, force: true }).catch(() => {})

    // —— 保护 ①：目录仍含其他文件 → 不清理（rmdir 对非空原子失败）
    const L3 = path.join(os.tmpdir(), `wdsync-e2e-ds5c-${Date.now()}`)
    const d3 = () => ({ id: 'ds5c', localPath: L3, remotePath: '/ds5c', mode: 'two-way' })
    await fsp.mkdir(path.join(L3, 'subk'), { recursive: true })
    await fsp.writeFile(path.join(L3, 'subk', 'a.txt'), 'a')
    await fsp.writeFile(path.join(L3, 'subk', 'keep.txt'), 'keep')
    await services.sync.syncDirectory(cfg, d3(), SP, {})
    await fsp.rm(path.join(ROOT, 'ds5c', 'subk', 'a.txt'))
    const r3 = await services.sync.syncDirectory(cfg, d3(), SP, {})
    check(
      'DS5 非空目录不清理（其余文件保留）',
      r3.deleted === 1 && r3.dirsPrunedLocal === 0 && fs.existsSync(path.join(L3, 'subk', 'keep.txt')),
      JSON.stringify({ deleted: r3.deleted, dirsPrunedLocal: r3.dirsPrunedLocal })
    )
    await fsp.rm(L3, { recursive: true, force: true }).catch(() => {})

    // —— 保护 ②：他机在「删除 → 清理」窗口内写入新文件 → 远端 PROPFIND 复核发现
    // 子条目后跳过清理（快照判定可清 ≠ 此刻仍空；集合 DELETE 是递归删除，绝不裸删）。
    // 注入点：首轮 onProgress 的第一个 plan 事件（扫描已完成、传输未开始）。
    const L4 = path.join(os.tmpdir(), `wdsync-e2e-ds5d-${Date.now()}`)
    const d4 = () => ({ id: 'ds5d', localPath: L4, remotePath: '/ds5d', mode: 'two-way' })
    await fsp.mkdir(path.join(L4, 'sub3'), { recursive: true })
    await fsp.writeFile(path.join(L4, 'sub3', 'a.txt'), 'a')
    await services.sync.syncDirectory(cfg, d4(), SP, {})
    await fsp.unlink(path.join(L4, 'sub3', 'a.txt'))
    let injected = false
    const r4 = await services.sync.syncDirectory(cfg, d4(), SP, {
      onProgress: (p) => {
        if (!injected && p && p.phase === 'plan') {
          injected = true
          fs.writeFileSync(path.join(ROOT, 'ds5d', 'sub3', 'new-from-peer.txt'), 'peer')
        }
      },
    })
    check(
      'DS5 复核发现他机新写入 → 远端目录不清理',
      r4.deleted === 1 && r4.dirsPrunedRemote === 0 && fs.existsSync(path.join(ROOT, 'ds5d', 'sub3', 'new-from-peer.txt')),
      JSON.stringify({ deleted: r4.deleted, dirsPrunedRemote: r4.dirsPrunedRemote })
    )
    check('DS5 注入确实发生在扫描后（plan 事件）', injected, '')
    await fsp.rm(L4, { recursive: true, force: true }).catch(() => {})
  })

  // DS6 决策历史记录（decision-log.json）：setPendingChoice 落选择 / clearPendingConflict
  // 忽略时各追加一条（root-lost 类带受影响文件数），listDecisionLog 按时间倒序返回；
  // 引擎消费挂起（重建轮）不清空历史；环形上限 200 防膨胀；落盘可跨存储重开读取。
  // 本节自包含：节首切到 STORAGE_MAIN（节内重开校验需要确定根；此前活跃的 PC3_S
  // 是 PC3 节的局部临时根，后续 FN 系列各节自包含，不依赖具体根身份）。

  await section('DS6：决策历史记录', async () => {
    await switchDevice(STORAGE_MAIN)
    const L = path.join(os.tmpdir(), `wdsync-e2e-ds6-${Date.now()}`)
    const d = () => ({ id: 'ds6', localPath: L, remotePath: '/ds6', mode: 'two-way' })
    try {
      await fsp.mkdir(L, { recursive: true })
      for (let i = 0; i < 4; i++) await fsp.writeFile(path.join(L, `f${i}.txt`), `ds6-${i}`)
      await services.sync.syncDirectory(cfg, d(), SP, {})
      // —— 根丢失 → 选择「重新上传」：历史记 kind=root-lost / choice=upload / affected=4
      await services.dav.remove(cfg, '/ds6')
      try {
        await services.sync.syncDirectory(cfg, d(), SP, {})
      } catch (_) {
        /* 预期根丢失停轮 */
      }
      await services.sync.setPendingChoice(d(), '.', 'upload')
      let log = await services.sync.listDecisionLog(d())
      check(
        'DS6 root-lost 决策入历史（倒序最新在前，含受影响文件数）',
        log.length === 1 && log[0].kind === 'root-lost' && log[0].choice === 'upload' && log[0].rel === '.' && log[0].affected === 4,
        JSON.stringify(log)
      )
      // —— 重建轮消费挂起后历史保留（回看价值不随挂起清除消失）
      await services.sync.syncDirectory(cfg, d(), SP, {})
      check(
        'DS6 挂起被引擎消费后历史保留',
        (await services.sync.listDecisionLog(d())).length === 1 && (await services.sync._internals.getPendings(d())).length === 0,
        ''
      )
      // —— 干净轮解除 rootRebuilt 保护标记（不解除的话，再次删根会按「恢复进行中」
      //    语义继续重建而不是重新询问 —— 那是决策闸的设计行为，本节要测的是全新丢失）
      const rClean = await services.sync.syncDirectory(cfg, d(), SP, {})
      check(
        'DS6 重建后干净轮 no-op 且解除保护标记',
        isNoop(rClean) && (await services.sync._internals.getDirMeta(d())).rootRebuilt === undefined,
        JSON.stringify(rClean)
      )
      // —— 忽略也入历史（kind=ignore）：再删根 → 挂起重现 → 忽略
      await services.dav.remove(cfg, '/ds6')
      try {
        await services.sync.syncDirectory(cfg, d(), SP, {})
      } catch (_) {
        /* 预期根丢失停轮 */
      }
      await services.sync.clearPendingConflict(d(), '.')
      log = await services.sync.listDecisionLog(d())
      check(
        'DS6 忽略挂起入历史（最新在前）',
        log.length === 2 && log[0].kind === 'ignore' && log[0].choice === 'ignore' && log[1].kind === 'root-lost',
        JSON.stringify(log)
      )
      // —— 环形上限：对同一挂起重复落选择 205 次（无引擎轮，纯记录路径）→ 恰 200 条
      try {
        await services.sync.syncDirectory(cfg, d(), SP, {})
      } catch (_) {
        /* 预期根丢失停轮（重新登记挂起供循环使用） */
      }
      for (let i = 0; i < 205; i++) await services.sync.setPendingChoice(d(), '.', 'upload')
      log = await services.sync.listDecisionLog(d())
      check('DS6 环形上限：超出 200 条丢弃最旧', log.length === 200 && log[0].kind === 'root-lost' && log[0].choice === 'upload', JSON.stringify({ len: log.length }))
      // —— 落盘重载：关闭缓存句柄、同根重开 → 历史仍完整可读（_load 解析 decision-log.json）
      await switchDevice(STORAGE_MAIN)
      log = await services.sync.listDecisionLog(d())
      check('DS6 历史跨存储重开持久（磁盘读取）', log.length === 200 && log[0].choice === 'upload', JSON.stringify({ len: log.length }))
    } finally {
      await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
    }
  })

  // DS7 同步记录（sync-log.json）：每次引擎轮一条 —— 触发方式（hints.source）/
  // 起止时间 / 计数摘要 / 逐文件操作明细（upload / download / delete-local /
  // delete-remote，含 added 新增标记）/ 失败轮的 status=error 与 errors 清单；
  // 环形上限 200 轮防膨胀；落盘可跨存储重开读取。
  // 本节自包含（节首切到 STORAGE_MAIN，与 DS6 同款）。

  await section('DS7：同步记录', async () => {
    await switchDevice(STORAGE_MAIN)
    const L = path.join(os.tmpdir(), `wdsync-e2e-ds7-${Date.now()}`)
    const d = () => ({ id: 'ds7', localPath: L, remotePath: '/ds7', mode: 'two-way' })
    const rawPut = (rel, body) =>
      new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: `/dav/ds7/${rel}`, method: 'PUT', agent: false }, resolve)
        req.on('error', reject)
        req.end(body)
      })
    try {
      await fsp.mkdir(L, { recursive: true })
      for (let i = 0; i < 3; i++) await fsp.writeFile(path.join(L, `f${i}.txt`), `ds7-${i}`)
      // —— 首轮（startup 触发）：3 个上传全部入明细（云端新增）
      await services.sync.syncDirectory(cfg, d(), SP, { hints: { source: 'startup' } })
      let log = await services.sync.listSyncLog(d())
      check(
        'DS7 首轮入记录（触发方式 / 状态 / 计数摘要）',
        log.length === 1 && log[0].trigger === 'startup' && log[0].status === 'ok' && log[0].uploaded === 3 && log[0].totalFiles === 3,
        JSON.stringify(log)
      )
      check(
        'DS7 首轮操作明细：3 条上传 + added 标记 + 起止时间',
        log[0].ops.length === 3 &&
          log[0].ops.every((o) => o.op === 'upload' && o.added === true && o.bytes > 0 && o.rel) &&
          log[0].at > 0 &&
          log[0].endAt >= log[0].at,
        JSON.stringify(log[0].ops)
      )
      // —— 无变化轮（interval 触发）：零传输轮也入记录，明细为空
      await services.sync.syncDirectory(cfg, d(), SP, { hints: { source: 'interval' } })
      log = await services.sync.listSyncLog(d())
      check(
        'DS7 无变化轮入记录（interval，零操作明细）',
        log.length === 2 && log[0].trigger === 'interval' && log[0].status === 'ok' && log[0].ops.length === 0 && log[0].uploaded === 0,
        JSON.stringify(log[0])
      )
      // —— 双向删除传播轮（watch 触发）：本地删 f0 → delete-remote；云端删 f2 → delete-local
      await fsp.rm(path.join(L, 'f0.txt'))
      await services.dav.remove(cfg, '/ds7/f2.txt')
      await services.sync.syncDirectory(cfg, d(), SP, { hints: { source: 'watch' } })
      log = await services.sync.listSyncLog(d())
      check(
        'DS7 删除传播轮：两侧删除各入明细（delete-remote / delete-local）',
        log.length === 3 &&
          log[0].trigger === 'watch' &&
          log[0].deleted === 2 &&
          log[0].ops.some((o) => o.op === 'delete-remote' && o.rel === 'f0.txt') &&
          log[0].ops.some((o) => o.op === 'delete-local' && o.rel === 'f2.txt'),
        JSON.stringify(log[0].ops)
      )
      // —— 下载轮（manual 触发）：云端新文件 → download 入明细（本地新增）
      await rawPut('from-remote.txt', 'ds7-remote-new')
      await services.sync.syncDirectory(cfg, d(), SP, { hints: { source: 'manual' } })
      log = await services.sync.listSyncLog(d())
      check(
        'DS7 下载轮：download 入明细（added = 本地新增）',
        log.length === 4 && log[0].trigger === 'manual' && log[0].downloaded === 1 && log[0].ops.some((o) => o.op === 'download' && o.rel === 'from-remote.txt' && o.added === true),
        JSON.stringify(log[0].ops)
      )
      // —— 大轮次全量记录：一次 220 个文件的上传 → 明细不截断（全量 ops、无 dropped 字段）
      await fsp.mkdir(path.join(L, 'bulk'), { recursive: true })
      for (let i = 0; i < 220; i++) await fsp.writeFile(path.join(L, 'bulk', `f${i}.txt`), `bulk-${i}`)
      await services.sync.syncDirectory(cfg, d(), SP, { hints: { source: 'manual' } })
      log = await services.sync.listSyncLog(d())
      check(
        'DS7 大轮次全量记录：220 个上传全部入明细（不截断）',
        log.length === 5 && log[0].ops.length === 220 && log[0].ops.every((o) => o.op === 'upload' && o.added === true) && log[0].opsDropped === undefined,
        JSON.stringify({ len: log.length, ops: log[0].ops.length, dropped: log[0].opsDropped })
      )
      // —— 失败轮：网络切断 → status=error + errors 清单（人话原因）；未成功的上传不入明细
      await fsp.writeFile(path.join(L, 'f1.txt'), 'ds7-modified')
      await setNetcut('1')
      try {
        await services.sync.syncDirectory(cfg, d(), SP, { hints: { source: 'manual' } })
      } catch (_) {
        /* 预期网络类失败轮 */
      }
      await setNetcut(null)
      log = await services.sync.listSyncLog(d())
      check(
        'DS7 失败轮入记录（error + 人话原因 + errors 清单）',
        log.length === 6 && log[0].status === 'error' && !!log[0].error && log[0].errors.length > 0,
        JSON.stringify({ status: log[0].status, error: log[0].error, errors: log[0].errors })
      )
      check('DS7 失败轮没有把未成功的上传记入明细', !log[0].ops.some((o) => o.op === 'upload' && o.rel === 'f1.txt'), JSON.stringify(log[0].ops))
      // —— 环形上限：store 层直接追加 205 轮（叠加既有 5 条真实记录）→ 恰 200 条
      const st = await storeModule.openDirStore({ localPath: L, remotePath: '/ds7' })
      for (let i = 0; i < 205; i++) {
        st.appendSyncLog({ at: i, endAt: i, trigger: 'interval', status: 'ok', uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, adopted: 0, deferredConflicts: 0, deleteHeld: 0, bytesUp: 0, bytesDown: 0, totalFiles: 0, ops: [], errors: [] })
      }
      check('DS7 环形上限：超出 200 轮丢弃最旧', st.listSyncLog().length === 200 && st.listSyncLog()[0].at === 204, String(st.listSyncLog().length))
      await st.saveSyncLog()
      // —— 落盘重载：同根重开 → 记录仍完整可读（_load 解析 sync-log.json）
      await switchDevice(STORAGE_MAIN)
      log = await services.sync.listSyncLog(d())
      check('DS7 同步记录跨存储重开持久（磁盘读取）', log.length === 200 && log[0].trigger === 'interval' && log[0].at === 204, JSON.stringify({ len: log.length, first: log[0] && log[0].at }))
    } finally {
      await setNetcut(null)
      await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
    }
  })

  // ============================================================
  // FN 系列（跨平台与配置安全）
  // FN0 NFC 规范化一致性（NFD 服务器名 ↔ NFC 内部 key / origName 落地）
  // FN1 内置垃圾排除（始终生效，与 ignoreHidden 独立）+ 用户排除规则
  // FN2 Windows 文件名预检（非法字符 / 保留名 / 尾空格点 / 超长 → BAD_FILENAME 退避）
  // FN3 大小写冲突检测（跨侧 / 远端同名对；删除传播放行消解）
  // FN4 同步目录重叠校验（纯函数直检）
  // FN5 凭据混淆（AES-256-GCM）+ 用户可见输出无密码泄漏扫描 + 调度器解密链路
  // ============================================================

  await section('FN0：NFC 规范化一致性（NFD 服务器名）', async () => {
    await freshStore('fn0')
    const L = await tmpLocal('fn0')
    const nfdName = 'cafe\u0301.txt' // é 分解形态（NFD）：macOS 旧工具 / 部分 Linux 服务器产物
    const nfcName = 'caf\u00e9.txt' // é 预组合形态（NFC）：引擎内部 key
    const d = { id: 'fn0', localPath: L, remotePath: '/fn0', mode: 'two-way' }
    await fsp.mkdir(path.join(ROOT, 'fn0'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'fn0', nfdName), 'remote-nfd-content')
    const s1 = await services.sync.syncDirectory(cfg, d, SP, {})
    const names = await fsp.readdir(L)
    check('FN0 NFD 远端名正常下载', s1.downloaded === 1, JSON.stringify(s1))
    check('FN0 本地按 origName 落地服务器原名（NFD 字节）', names.length === 1 && names[0] === nfdName, JSON.stringify(names))
    const beNfc = await services.sync._internals.baselineEntry(d, nfcName)
    const beNfd = await services.sync._internals.baselineEntry(d, nfdName)
    check('FN0 基线 key 归一 NFC（NFD 查询命中同一条目）', beNfc != null && beNfc.origName === nfdName && JSON.stringify(beNfd) === JSON.stringify(beNfc), JSON.stringify(beNfc))
    const s2 = await services.sync.syncDirectory(cfg, d, SP, {})
    check('FN0 第二轮 no-op（两侧 NFD/NFC 名折叠为同一 key）', isNoop(s2), JSON.stringify(s2))
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'fn0'), { recursive: true, force: true }).catch(() => {})
  })

  await section('FN1：内置垃圾排除与用户排除规则', async () => {
    await freshStore('fn1')
    const L = await tmpLocal('fn1')
    const d = { id: 'fn1', localPath: L, remotePath: '/fn1', mode: 'two-way' }
    for (const n of ['.DS_Store', '._sidecar', '~$owner.docx', 'Thumbs.db', 'ehthumbs.db', 'desktop.ini']) await fsp.writeFile(path.join(L, n), 'junk')
    await fsp.writeFile(path.join(L, '.hidden-keep.txt'), 'hidden-but-not-junk')
    await fsp.writeFile(path.join(L, 'keep-me.txt'), 'ok')
    await fsp.mkdir(path.join(L, 'sub'), { recursive: true })
    await fsp.writeFile(path.join(L, 'sub', 'skip.log'), 'user-excluded')
    await fsp.writeFile(path.join(L, 'sub', 'keep2.txt'), 'ok2')
    // ignoreHidden=false：隐藏文件应同步（.hidden-keep.txt），但垃圾仍须排除（两规则独立）
    const prefs = { ...SP, ignoreHidden: false, excludePatterns: ['*.log'] }
    const s1 = await services.sync.syncDirectory(cfg, d, prefs, {})
    check(
      'FN1 内置垃圾不上传（ignoreHidden=false 亦然）',
      s1.uploaded === 3 && ['.DS_Store', 'Thumbs.db', 'ehthumbs.db', 'desktop.ini'].every((n) => !fs.existsSync(path.join(ROOT, 'fn1', n))),
      JSON.stringify(s1)
    )
    check('FN1 隐藏但非垃圾的文件正常同步（规则相互独立）', fs.existsSync(path.join(ROOT, 'fn1', '.hidden-keep.txt')), '')
    check('FN1 用户规则按文件名排除 *.log', !fs.existsSync(path.join(ROOT, 'fn1', 'sub', 'skip.log')) && fs.existsSync(path.join(ROOT, 'fn1', 'sub', 'keep2.txt')), '')
    // 远端侧：远端盘上的垃圾不下载（先清掉本地同名垃圾，断言才不混淆）
    for (const n of ['.DS_Store', '._sidecar', '~$owner.docx', 'Thumbs.db', 'ehthumbs.db', 'desktop.ini']) await fsp.rm(path.join(L, n), { force: true })
    await fsp.writeFile(path.join(ROOT, 'fn1', '.DS_Store'), 'junk-remote')
    await fsp.writeFile(path.join(ROOT, 'fn1', '._rjunk'), 'junk-remote')
    const s2 = await services.sync.syncDirectory(cfg, d, prefs, {})
    check('FN1 远端垃圾不下载', s2.downloaded === 0 && !fs.existsSync(path.join(L, '.DS_Store')) && !fs.existsSync(path.join(L, '._rjunk')), JSON.stringify(s2))
    // 含 '/' 的规则按完整相对路径匹配（* 不跨目录段）；同批非命中文件照常同步
    await fsp.mkdir(path.join(L, 'sub2'), { recursive: true })
    await fsp.writeFile(path.join(L, 'sub2', 'a.txt'), 'x')
    await fsp.writeFile(path.join(L, 'plain.txt'), 'y')
    const prefs2 = { ...SP, excludePatterns: ['*.log', 'sub2/*'] }
    const s3 = await services.sync.syncDirectory(cfg, d, prefs2, {})
    check('FN1 含 / 规则按完整路径排除（* 不跨段）', s3.uploaded === 1 && !fs.existsSync(path.join(ROOT, 'fn1', 'sub2')) && fs.existsSync(path.join(ROOT, 'fn1', 'plain.txt')) && !fs.existsSync(path.join(ROOT, 'fn1', 'sub', 'skip.log')), JSON.stringify(s3))
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'fn1'), { recursive: true, force: true }).catch(() => {})
  })

  await section('FN2：Windows 文件名预检（BAD_FILENAME）', async () => {
    await freshStore('fn2')
    const L = await tmpLocal('fn2')
    const d = { id: 'fn2', localPath: L, remotePath: '/fn2', mode: 'two-way' }
    const badNames = ['a<b.txt', 'colon:name.txt', 'quote"s.txt', 'CON.txt', 'NUL.bin', 'pipe|x.txt', 'trail. ', 'tail ', `L${'x'.repeat(249)}.txt`]
    const goodNames = ['café.txt', 'a b.txt', 'ok.txt']
    for (const n of badNames) await fsp.writeFile(path.join(L, n), 'bad')
    for (const n of goodNames) await fsp.writeFile(path.join(L, n), 'good')
    let s1 = null
    let e1 = null
    try {
      s1 = await services.sync.syncDirectory(cfg, d, SP, {})
    } catch (e) {
      e1 = e
      s1 = e.summary
    }
    check('FN2 非法名上传全部拦截（轮次错误收场，合法名照常上传）', !!e1 && s1.uploaded === goodNames.length && s1.errors.length >= badNames.length, JSON.stringify({ uploaded: s1.uploaded, errs: s1.errors.length }))
    check('FN2 错误文案含明确原因（Windows 归因）', s1.errors.some((m) => /Windows/.test(m)) && s1.errors.some((m) => m.includes('CON.txt')), s1.errors[0])
    check(
      'FN2 非法名零落盘远端（预检先于任何请求）',
      badNames.every((n) => !fs.existsSync(path.join(ROOT, 'fn2', n))) && goodNames.every((n) => fs.existsSync(path.join(ROOT, 'fn2', n))),
      ''
    )
    const fails = await services.sync._internals.getFailures(d)
    check(
      'FN2 记入失败退避表（permanent，逐 rel）',
      Object.keys(fails).length === badNames.length && Object.values(fails).every((f) => f.code === 'BAD_FILENAME'),
      JSON.stringify(Object.keys(fails))
    )
    // 第二轮：退避期内规划层跳过 → 轮次成功（不再报错，仅提示）
    const s2 = await services.sync.syncDirectory(cfg, d, SP, {})
    check('FN2 退避期内跳过（轮次成功 + 汇总提示）', s2.uploaded === 0 && s2.errors.length === 0 && s2.warnings.some((w) => /一直同步失败/.test(w)), JSON.stringify({ up: s2.uploaded, errs: s2.errors.length }))
    // 重命名恢复：新 rel 无失败记录 → 自动恢复上传
    await fsp.rename(path.join(L, 'a<b.txt'), path.join(L, 'fixed.txt'))
    const s3 = await services.sync.syncDirectory(cfg, d, SP, {})
    check('FN2 重命名后自动恢复同步', s3.uploaded === 1 && fs.existsSync(path.join(ROOT, 'fn2', 'fixed.txt')), JSON.stringify(s3))
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'fn2'), { recursive: true, force: true }).catch(() => {})
  })

  await section('FN3：大小写冲突检测与消解', async () => {
    // —— 跨侧：本地 Case.txt ↔ 远端 case.txt（上传会覆盖远端，必须拦截）——
    await freshStore('fn3')
    const L = await tmpLocal('fn3')
    const d = { id: 'fn3', localPath: L, remotePath: '/fn3', mode: 'two-way' }
    await fsp.writeFile(path.join(L, 'Case.txt'), 'local-content')
    await fsp.mkdir(path.join(ROOT, 'fn3'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'fn3', 'case.txt'), 'remote-content')
    let s1 = null
    let e1 = null
    try {
      s1 = await services.sync.syncDirectory(cfg, d, SP, {})
    } catch (e) {
      e1 = e
      s1 = e.summary
    }
    check(
      'FN3 跨侧大小写冲突：零传输 + 明确报错（不静默覆盖）',
      !!e1 && s1.uploaded === 0 && s1.downloaded === 0 && s1.errors.some((m) => /只有大小写不同/.test(m) && m.includes('Case.txt') && m.includes('case.txt')),
      JSON.stringify(s1 && s1.errors)
    )
    check(
      'FN3 两侧内容原样保留',
      (await fsp.readFile(path.join(L, 'Case.txt'), 'utf-8')) === 'local-content' && (await fsp.readFile(path.join(ROOT, 'fn3', 'case.txt'), 'utf-8')) === 'remote-content',
      ''
    )
    // 消解①：删除本地一侧 → 冲突解除；远端文件按无基线语义下载回来（单一大小写收敛）
    await fsp.rm(path.join(L, 'Case.txt'))
    const s2 = await services.sync.syncDirectory(cfg, d, SP, {})
    check('FN3 删除本地一侧后收敛（远端版本下载）', s2.downloaded === 1 && fs.existsSync(path.join(L, 'case.txt')), JSON.stringify(s2))
    check('FN3 消解后恢复 no-op', isNoop(await services.sync.syncDirectory(cfg, d, SP, {})), '')
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'fn3'), { recursive: true, force: true }).catch(() => {})

    // —— 远端同名对（大小写敏感服务器形态，casepair 虚拟孪生模拟）——
    await freshStore('fn3b')
    const L2 = await tmpLocal('fn3b')
    const d2 = { id: 'fn3b', localPath: L2, remotePath: '/fn3b', mode: 'two-way' }
    await fsp.mkdir(path.join(ROOT, 'fn3b'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'fn3b', 'pair.txt'), 'pair-lower')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-casepair'), 'pair.txt')
    try {
      let s4 = null
      let e4 = null
      try {
        s4 = await services.sync.syncDirectory(cfg, d2, SP, {})
      } catch (e) {
        e4 = e
        s4 = e.summary
      }
      check(
        'FN3 远端同名对：两个都不下载 + 报错',
        !!e4 && s4.downloaded === 0 && s4.errors.some((m) => /只有大小写不同/.test(m) && m.includes('Pair.txt') && m.includes('pair.txt')),
        JSON.stringify(s4 && s4.errors)
      )
      check('FN3 本地未落任何同名文件（下载即互相覆盖）', !fs.existsSync(path.join(L2, 'pair.txt')) && !fs.existsSync(path.join(L2, 'Pair.txt')), '')
      // 建基线（关孪生）→ 复现冲突（开孪生）→ 删除本地消解：删除传播在冲突挂起下放行。
      // anchor：删除 pair.txt 后本地根仍非空，避免「空目录 + 非空基线」的根健康保护中止
      await fsp.rm(path.join(ROOT, '.wdsync-test-casepair'), { force: true })
      const s5 = await services.sync.syncDirectory(cfg, d2, SP, {})
      check('FN3 基线建立（孪生关闭时正常下载）', s5.downloaded === 1 && fs.existsSync(path.join(L2, 'pair.txt')), JSON.stringify(s5))
      await fsp.writeFile(path.join(L2, 'anchor.txt'), 'anchor')
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-casepair'), 'pair.txt')
      let s6 = null
      try {
        s6 = await services.sync.syncDirectory(cfg, d2, SP, {})
      } catch (e) {
        s6 = e.summary
      }
      check('FN3 冲突复现：非冲突文件照常同步，冲突文件零传输', s6.uploaded === 1 && s6.downloaded === 0 && s6.errors.some((m) => /只有大小写不同/.test(m)), JSON.stringify(s6 && s6.errors))
      // 删除本地 pair.txt → delete-remote 放行（caseSkip 只挡传输，不挡删除传播）。
      // 本轮孪生仍在 → 冲突错误依旧存在（轮次 throw），断言基于 summary
      await fsp.rm(path.join(L2, 'pair.txt'))
      let s7 = null
      try {
        s7 = await services.sync.syncDirectory(cfg, d2, SP, {})
      } catch (e) {
        s7 = e.summary
      }
      check('FN3 删除传播在冲突挂起下放行（消解手段）', s7.deleted === 1 && !fs.existsSync(path.join(ROOT, 'fn3b', 'pair.txt')) && fs.existsSync(path.join(L2, 'anchor.txt')), JSON.stringify(s7))
      check('FN3 孪生随真实文件消失，下轮干净', isNoop(await services.sync.syncDirectory(cfg, d2, SP, {})), '')
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-casepair'), { force: true }).catch(() => {})
      await fsp.rm(L2, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'fn3b'), { recursive: true, force: true }).catch(() => {})
    }
  })

  await section('FN4：同步目录重叠校验（纯函数直检）', async () => {
    const o = services.sync._internals.checkDirOverlap
    const A = path.join(path.sep, 'base', 'docs')
    const B = path.join(path.sep, 'base', 'docs', 'sub')
    const C = path.join(path.sep, 'base', 'other')
    const existing = [{ id: 'e1', name: '文档', localPath: A, remotePath: '/docs' }]
    check('FN4 本地嵌套被拒', o({ localPath: B, remotePath: '/x' }, existing)?.side === 'local', '')
    check('FN4 本地反向嵌套被拒（新目录更浅）', o({ localPath: A, remotePath: '/x' }, [{ id: 'e2', localPath: B, remotePath: '/y' }])?.side === 'local', '')
    check('FN4 本地完全相同被拒', o({ localPath: A, remotePath: '/x' }, existing)?.side === 'local', '')
    check('FN4 远端嵌套被拒', o({ localPath: C, remotePath: '/docs/sub' }, existing)?.side === 'remote', '')
    check('FN4 远端完全相同被拒', o({ localPath: C, remotePath: '/docs/' }, existing)?.side === 'remote', '')
    check('FN4 两侧均不重叠放行', o({ localPath: C, remotePath: '/other' }, existing) == null, '')
    check('FN4 编辑自身豁免', o({ localPath: A, remotePath: '/docs' }, existing, 'e1') == null, '')
    check('FN4 前缀相似的兄弟目录放行（段边界）', o({ localPath: A + '2', remotePath: '/other2' }, existing) == null && o({ localPath: C, remotePath: '/docs2' }, existing) == null, '')
    if (process.platform === 'win32' || process.platform === 'darwin') {
      check('FN4 大小写折叠（win/darwin 默认卷大小写不敏感）', o({ localPath: A.toUpperCase(), remotePath: '/x' }, existing)?.side === 'local', A.toUpperCase())
    } else {
      check('FN4 linux 大小写敏感：仅大小写不同的路径不判重叠', o({ localPath: A.toUpperCase(), remotePath: '/x' }, existing) == null, '')
    }
  })

  await section('FN5：凭据混淆（AES-256-GCM）与输出泄漏扫描', async () => {
    // 直检：seal/open 往返、密文形态、随机 iv、非密文输入
    const PW = 'e2e-Secret-pw-77ff'
    const sealed = services.secure.sealSecret(PW)
    check('FN5 seal→open 往返', services.secure.openSecret(sealed) === PW, sealed.slice(0, 24))
    check('FN5 密文不含明文且为 v1 格式', sealed.startsWith('wdsync1:') && !sealed.includes(PW), '')
    check('FN5 二次 seal 产生不同密文（随机 iv）', services.secure.sealSecret(PW) !== sealed, '')
    check('FN5 非密文输入解密为空（不做明文兼容）', services.secure.openSecret(PW) === '' && services.secure.openSecret('') === '', '')
    const tampered = sealed.slice(0, -4) + (sealed.endsWith('AAAA') ? 'BBBB' : 'AAAA')
    check('FN5 篡改密文解密失败（GCM 完整性）', services.secure.openSecret(tampered) === '', '')

    // 泄漏扫描：带错误与提示的完整轮次里，密码与 Authorization 值不得出现在任何
    // 用户可见输出（summary 序列化含 errors/warnings；失败退避表为落盘诊断）
    await freshStore('fn5')
    const L = await tmpLocal('fn5')
    const d = { id: 'fn5', localPath: L, remotePath: '/fn5', mode: 'two-way' }
    await fsp.writeFile(path.join(L, 'ok.txt'), 'ok')
    await fsp.writeFile(path.join(L, 'bad.toolarge.txt'), 'will-fail-413')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-fail413'), 'x')
    const cfgP = { ...cfg, password: PW }
    let summary = null
    let firstErr = ''
    try {
      summary = await services.sync.syncDirectory(cfgP, d, SP, {})
    } catch (e) {
      summary = e.summary
      firstErr = e.message
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-fail413'), { force: true }).catch(() => {})
    }
    const authB64 = Buffer.from(`u:${PW}`).toString('base64')
    const blob = JSON.stringify(summary) + '|' + firstErr
    check('FN5 轮次输出不含密码与认证头值', !blob.includes(PW) && !blob.includes(authB64), blob.slice(0, 80))
    const failDump = JSON.stringify(await services.sync._internals.getFailures(d))
    check('FN5 失败退避表不含密码', !failDump.includes(PW), '')
    check('FN5 泄漏扫描轮确有错误输出（扫描本身有效）', summary && summary.errors.length > 0 && summary.uploaded === 1, JSON.stringify({ up: summary && summary.uploaded, errs: summary && summary.errors.length }))
    await fsp.rm(L, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'fn5'), { recursive: true, force: true }).catch(() => {})

    // 调度器链路：seal 后的密码经 loadConfig 解密送达网络层（AUTH 头值 = u:sched-pw）
    const prevZt = global.window.ztools
    const FN_DB = {}
    global.window.ztools = {
      ...(prevZt || {}),
      dbStorage: { getItem: (k) => (k in FN_DB ? FN_DB[k] : null), setItem: (k, v) => { FN_DB[k] = v } },
    }
    const L2 = await tmpLocal('fn5d')
    await fsp.writeFile(path.join(L2, 'auth.txt'), 'auth-probe')
    FN_DB['webdav-sync:data'] = {
      server: { serverUrl: cfg.serverUrl, username: 'u', password: services.secure.sealSecret('sched-pw') },
      dirs: [{ id: 'fn5d', localPath: L2, remotePath: '/fn5d', mode: 'two-way' }],
      prefs: { autoSync: false, intervalMin: 15 },
    }
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-captheaders'), 'x')
    const sched = createTestSched()
    try {
      await sched.init()
      await waitReal(() => sched.getSnapshot().leader.isLeader === true, 6000)
      const res = await sched.syncNow('fn5d')
      const capLog = fs.readFileSync(path.join(ROOT, '.wdsync-test-captheaders.log'), 'utf-8')
      const expectAuth = `Basic ${Buffer.from('u:sched-pw').toString('base64')}`
      check('FN5 调度器解密链路：明文密码正确送达网络层', res.ok === true && capLog.includes(`AUTH=${expectAuth}`), `${res.ok} ${capLog.split('\n')[0] || ''}`)
    } finally {
      sched.cleanup()
      await fsp.rm(path.join(ROOT, '.wdsync-test-captheaders'), { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, '.wdsync-test-captheaders.log'), { force: true }).catch(() => {})
      global.window.ztools = prevZt
      await fsp.rm(L2, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'fn5d'), { recursive: true, force: true }).catch(() => {})
    }
  })

afterAll(async () => {
  await teardownShard({ ROOT, LOCAL, server })
})
