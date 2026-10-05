/**
 * e2e 分片「tiers」：档位组（P1-P9 / XS / W1-W9 / PR）。P 系列档位标记跨节残留、P9 统一收尾清理，整文件保序
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
  } = await setupShard({ shard: 'tiers', port: 5373 })

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
  // PR 系列：服务器档案与请求限速分层。
  // 档案匹配与 resolveNetOpts 分层走 _internals / dav.serverProfile 直检；
  // 限速在请求链路上的真实生效（令牌桶节拍）用显式 netOpts 走 davRequest 计时。
  // ============================================================

  await section('PR：服务器档案（坚果云默认限速）与 netOpts 分层', async () => {
  const profileOf = (u) => services.dav.serverProfile({ serverUrl: u })
  check('PR dav.jianguoyun.com matches profile', profileOf('https://dav.jianguoyun.com/dav/')?.label === '坚果云')
  check('PR apex domain matches profile too', profileOf('https://jianguoyun.com/dav/')?.label === '坚果云')
  check('PR embedded-subdomain host matches', profileOf('https://dav.web.jianguoyun.com/dav/')?.label === '坚果云')
  check('PR lookalike suffix host does not match', profileOf('https://evil-jianguoyun.com/dav/') == null)
  check('PR profile domain as prefix of another does not match', profileOf('https://jianguoyun.com.evil.com/dav/') == null)
  check('PR unrelated host has no profile', profileOf(`http://127.0.0.1:${PORT}/dav/`) == null)
  check('PR invalid or empty url returns null', profileOf('not a url') == null && profileOf('') == null)

  const netOf = (sv, netOpts) => services.sync._internals.resolveNetOpts({ serverUrl: sv, netOpts })
  const netJgy = netOf('https://dav.jianguoyun.com/dav/')
  const netLocal = netOf(`http://127.0.0.1:${PORT}/dav/`)
  check('PR default: no profile, no netOpts → rate 0', netLocal.ratePerSec === 0, JSON.stringify(netLocal))
  check('PR profile default applies when unset', netJgy.ratePerSec === 4, JSON.stringify(netJgy))
  check(
    'PR profile only overrides rate, other defaults intact',
    netJgy.connectTimeoutMs === 10000 && netJgy.idleTimeoutMs === 30000 && netJgy.stallMs === 60000 && netJgy.maxSockets === 8,
    JSON.stringify(netJgy)
  )
  check('PR explicit rate beats profile default', netOf('https://dav.jianguoyun.com/dav/', { ratePerSec: 10 }).ratePerSec === 10)
  check('PR explicit 0 means unlimited even on profile host', netOf('https://dav.jianguoyun.com/dav/', { ratePerSec: 0 }).ratePerSec === 0)
  check('PR invalid rate falls back to profile default', netOf('https://dav.jianguoyun.com/dav/', { ratePerSec: -3 }).ratePerSec === 4)
  check('PR invalid rate on non-profile host falls back to 0', netOf(`http://127.0.0.1:${PORT}/dav/`, { ratePerSec: 'x' }).ratePerSec === 0)

  // 限速在请求链路上生效：2 req/s × 7 个串行 PROPFIND。令牌桶容量 2（可突发
  // 2 个）+ 平均 2/s 补充，且睡眠期间的补充量记到下一请求头上（last 在睡前
  // 更新）→ 节拍呈「~500ms / ~5ms」交替，总耗时 ≈ 1.5s；不限速时 7 个本地
  // 请求仅数十毫秒。判 ≥ 1200ms 已与不限速形态差一个数量级以上。
  // 桶按 origin 缓存且仅 ratePerSec>0 时进入 —— 本用例后其余用例（默认 0）不受影响。
  const prCfg = { serverUrl: `http://127.0.0.1:${PORT}/dav/`, username: 'u', password: 'p', netOpts: { ratePerSec: 2 } }
  const propfind = () =>
    services.sync._internals.davRequest(prCfg, 'PROPFIND', '', {
      headers: { Depth: '0', 'Content-Type': 'application/xml' },
      body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>',
    })
  const pacedT0 = Date.now()
  for (let i = 0; i < 7; i++) {
    const r = await propfind()
    if (r.status !== 207) throw new Error(`PR paced PROPFIND #${i} unexpected status ${r.status}`)
  }
  const pacedMs = Date.now() - pacedT0
  check('PR rate limit paces requests on the wire (burst 2 + ~500ms gaps)', pacedMs >= 1200 && pacedMs < 20000, `${pacedMs}ms`)

  })

  // ============================================================
  // P 系列：服务器档位矩阵
  // 档位由 ROOT 下 .wdsync-test-profile 标记文件切换（内容 p1..p9）；
  // 保留既有单行为标记（noetag/redirect/ratelimit/xmlstyle）供旧用例复用，
  // profile 是它们的「组合预设」——档位是多种行为的原子组合，单个标记文件一次写入
  // 即整体生效，避免多标记写入顺序造成的中间态。每个档位断言：
  //   1) probeCapabilities 分类正确；2) 一轮（或多轮）同步行为符合档位语义。
  // 多设备（两 deviceId + 两本地目录）在 P1/P2/P7/P8 下各跑一轮基础交替。
  // ============================================================
  // （setProfile / setMidair / freshStore / tmpLocal / syncP / settleStable 已提升到外层共享作用域，
  //   以支持各节独立登记与 --fast 跳过）
  // ---------- P1 全功能（强 etag + 条件请求生效 + Depth infinity 关闭）----------

  // [慢组登记原因] 档位深水区：探测 + 竞态 + 多设备约 13 轮；A 档语义仍由 SAFE / L / PC / BV（默认 p1 档）覆盖
  await slowSection('P1：全功能档', '档位深水区：探测 + 竞态 + 多设备约 13 轮；A 档语义仍由 SAFE / L / PC / BV（默认 p1 档）覆盖', async () => {
  await setProfile('p1')
  await fsp.rm(path.join(ROOT, 'px1'), { recursive: true, force: true }).catch(() => {})
  const P1_S = await freshStore('p1a')
  const P1_A = await tmpLocal('p1a')
  const p1caps = await services.dav.probeCapabilities(cfg, true)
  check(
    'P1 probe classifies tier A with strong stable etag and honored conditionals',
    p1caps.tier === 'A' && p1caps.etag.present && !p1caps.etag.weak && p1caps.etag.stable && p1caps.conditional.ifMatch && p1caps.conditional.ifNoneMatch && p1caps.depthInfinity === false && p1caps.mtimePrecision === 'ms' && p1caps.writable === true,
    JSON.stringify(p1caps)
  )
  const p1cached = await services.dav.probeCapabilities(cfg)
  check('P1 probe result cached (no re-probe within TTL)', p1cached.probedAt === p1caps.probedAt && p1cached.tier === 'A')
  check('P1 probe leaves no residue on remote root', (await fsp.readdir(ROOT)).filter((n) => n.startsWith('.wdsync-probe-')).length === 0)
  await fsp.writeFile(path.join(P1_A, 'race-midair.txt'), 'p1-v1')
  await fsp.writeFile(path.join(P1_A, 'other.txt'), 'p1-other')
  const p1s1 = await syncP(P1_A, '/px1')
  check('P1 first sync uploads (new files via If-None-Match:*)', p1s1.uploaded === 2 && p1s1.tier === 'A', JSON.stringify(p1s1))
  // A 档 412 竞态保护：midair 钩子在收到 PUT 时先把远端改写为「对端新版本」再评估条件头
  await fsp.writeFile(path.join(P1_A, 'race-midair.txt'), 'p1-v2-local-longer')
  await setMidair('put')
  let p1midErr = null
  try {
    await syncP(P1_A, '/px1')
  } catch (e) {
    p1midErr = e
  }
  await setMidair(null)
  check('P1 midair PUT is rejected with 412 and skips the file', !!p1midErr && /其他设备修改/.test(p1midErr.message), p1midErr && p1midErr.message)
  check(
    'P1 midair: remote keeps peer version (local edit NOT uploaded this round)',
    (await fsp.readFile(path.join(ROOT, 'px1', 'race-midair.txt'), 'utf-8')).startsWith('MIDAIR-PEER-EDIT-')
  )
  // 下轮重新规划：双侧都变 → 冲突（策略 local）→ 收敛；钩子一次性，重传不再 412
  const p1s2 = await syncP(P1_A, '/px1', { ...SP, conflictStrategy: 'local' })
  check('P1 converges via conflict resolution after midair', p1s2.conflicts === 1 && p1s2.uploaded === 1, JSON.stringify(p1s2))
  const p1settle = await settleStable(P1_A, '/px1')
  check('P1 settles to no-op after midair round', p1settle.ok, `rounds=${p1settle.rounds}`)
  // 多设备基础交替（参考 M2 写法）
  const P1_SB = await freshStore('p1b')
  const P1_B = await tmpLocal('p1b')
  await switchDevice(P1_SB)
  const p1b1 = await syncP(P1_B, '/px1')
  check('P1 device B downloads all', p1b1.downloaded === 2, JSON.stringify(p1b1))
  await switchDevice(P1_S)
  await fsp.writeFile(path.join(P1_A, 'other.txt'), 'p1-other-v2')
  const p1a2 = await syncP(P1_A, '/px1')
  await switchDevice(P1_SB)
  const p1b2 = await syncP(P1_B, '/px1')
  check('P1 A edit propagates to device B', p1a2.uploaded === 1 && p1b2.downloaded === 1 && (await fsp.readFile(path.join(P1_B, 'other.txt'), 'utf-8')) === 'p1-other-v2', `${JSON.stringify(p1a2)} ${JSON.stringify(p1b2)}`)
  await switchDevice(P1_S)
  await fsp.unlink(path.join(P1_A, 'race-midair.txt'))
  const p1a3 = await syncP(P1_A, '/px1')
  await switchDevice(P1_SB)
  const p1b3 = await syncP(P1_B, '/px1')
  check('P1 A delete propagates to B (conditional DELETE)', p1a3.deleted === 1 && p1b3.deleted === 1 && !fs.existsSync(path.join(P1_B, 'race-midair.txt')), `${JSON.stringify(p1a3)} ${JSON.stringify(p1b3)}`)
  await switchDevice(P1_S)
  const p1conv = await syncP(P1_A, '/px1')
  await switchDevice(P1_SB)
  const p1convB = await syncP(P1_B, '/px1')
  check('P1 multi-device convergence without ping-pong', isNoop(p1conv) && isNoop(p1convB), `${JSON.stringify(p1conv)} ${JSON.stringify(p1convB)}`)

  })

  // ---------- P2 nginx 风格（无 etag + 静默忽略条件头 + mtime 秒级）----------

  // [慢组登记原因] B 档深水区；p2 档真同步仍由 BV2 覆盖、B 档分类由 W5 覆盖
  await slowSection('P2：nginx 风格档', 'B 档深水区；p2 档真同步仍由 BV2 覆盖、B 档分类由 W5 覆盖', async () => {
  await setProfile('p2')
  await fsp.rm(path.join(ROOT, 'px2'), { recursive: true, force: true }).catch(() => {})
  const P2_S = await freshStore('p2a')
  const P2_A = await tmpLocal('p2a')
  const p2caps = await services.dav.probeCapabilities(cfg, true)
  check(
    'P2 probe classifies tier B (no etag, conditionals ignored, second-level mtime)',
    p2caps.tier === 'B' && p2caps.etag.present === false && p2caps.conditional.ifMatch === false && p2caps.conditional.ifNoneMatch === false && p2caps.mtimePrecision === 's' && p2caps.writable === true,
    JSON.stringify(p2caps)
  )
  await fsp.writeFile(path.join(P2_A, 'race-midair.txt'), 'p2-v1')
  await fsp.writeFile(path.join(P2_A, 'a.txt'), 'p2-content')
  const p2s1 = await syncP(P2_A, '/px2')
  check('P2 first sync uploads with B-tier warning', p2s1.uploaded === 2 && p2s1.tier === 'B' && p2s1.warnings.some((w) => /多台设备/.test(w)), JSON.stringify(p2s1.warnings))
  const p2s1b = await syncP(P2_A, '/px2')
  check('P2 second-level mtime does not cause ping-pong', isNoop(p2s1b), JSON.stringify(p2s1b))
  // B 档复查拦截：midair 钩子（propfind 触发点）在复查 PROPFIND 时改写远端内容 → 复查发现不符
  await fsp.writeFile(path.join(P2_A, 'race-midair.txt'), 'p2-v2-local-longer')
  await setMidair('propfind')
  let p2midErr = null
  try {
    await syncP(P2_A, '/px2')
  } catch (e) {
    p2midErr = e
  }
  await setMidair(null)
  check('P2 midair overwrite abandoned by pre-PUT recheck', !!p2midErr && /暂未上传/.test(p2midErr.message), p2midErr && p2midErr.message)
  check('P2 midair: remote holds peer version (local edit not uploaded)', (await fsp.readFile(path.join(ROOT, 'px2', 'race-midair.txt'), 'utf-8')).startsWith('MIDAIR-PEER-EDIT-'))
  const p2s2 = await syncP(P2_A, '/px2', { ...SP, conflictStrategy: 'local' })
  check('P2 converges via conflict resolution after recheck abort', p2s2.conflicts === 1 && p2s2.uploaded === 1, JSON.stringify(p2s2))
  const p2settle = await settleStable(P2_A, '/px2')
  check('P2 settles to no-op', p2settle.ok, `rounds=${p2settle.rounds}`)
  // 多设备基础交替
  const P2_SB = await freshStore('p2b')
  const P2_B = await tmpLocal('p2b')
  await switchDevice(P2_SB)
  const p2b1 = await syncP(P2_B, '/px2')
  check('P2 device B downloads all', p2b1.downloaded === 2, JSON.stringify(p2b1))
  await switchDevice(P2_S)
  await fsp.writeFile(path.join(P2_A, 'a.txt'), 'p2-content-v2')
  const p2a2 = await syncP(P2_A, '/px2')
  await switchDevice(P2_SB)
  const p2b2 = await syncP(P2_B, '/px2')
  check('P2 A edit propagates to B', p2a2.uploaded === 1 && p2b2.downloaded === 1 && (await fsp.readFile(path.join(P2_B, 'a.txt'), 'utf-8')) === 'p2-content-v2', `${JSON.stringify(p2a2)} ${JSON.stringify(p2b2)}`)
  const p2convB = await syncP(P2_B, '/px2')
  check('P2 device B settles (second-level mtime aligned)', isNoop(p2convB), JSON.stringify(p2convB))

  })

  // ---------- P3 弱 etag + 条件请求生效 ----------

  await section('P3：弱 etag 档', async () => {
  await setProfile('p3')
  await fsp.rm(path.join(ROOT, 'px3'), { recursive: true, force: true }).catch(() => {})
  const P3_S = await freshStore('p3')
  const P3_A = await tmpLocal('p3')
  const p3caps = await services.dav.probeCapabilities(cfg, true)
  check(
    'P3 probe classifies tier B (weak etag served, conditionals honored)',
    p3caps.tier === 'B' && p3caps.etag.present === true && p3caps.etag.weak === true && p3caps.conditional.ifMatch === true && p3caps.conditional.ifNoneMatch === true,
    JSON.stringify(p3caps)
  )
  await fsp.writeFile(path.join(P3_A, 'a.txt'), 'p3-v1')
  await fsp.writeFile(path.join(P3_A, 'b.txt'), 'p3-v2')
  const p3s1 = await syncP(P3_A, '/px3')
  check('P3 first sync uploads', p3s1.uploaded === 2 && p3s1.tier === 'B', JSON.stringify(p3s1))
  // 弱 etag 绝不用于 If-Match 的行为证明：p3 服务器对任何 If-Match 一律 412 ——
  // 若引擎误发 If-Match，这次普通覆盖轮必失败；成功即证明未发送（走 B 档复查）
  await fsp.writeFile(path.join(P3_A, 'a.txt'), 'p3-v1-overwritten-longer')
  const p3s2 = await syncP(P3_A, '/px3')
  check('P3 overwrite succeeds without ever sending If-Match (weak etag never used)', p3s2.uploaded === 1 && (await fsp.readFile(path.join(ROOT, 'px3', 'a.txt'), 'utf-8')) === 'p3-v1-overwritten-longer', JSON.stringify(p3s2))
  const p3settle = await settleStable(P3_A, '/px3')
  check('P3 settles to no-op', p3settle.ok, `rounds=${p3settle.rounds}`)

  })

  // ---------- P4 集合无尾斜杠 301（重定向）----------

  await section('P4：重定向档', async () => {
  await setProfile('p4')
  await fsp.rm(path.join(ROOT, 'px4'), { recursive: true, force: true }).catch(() => {})
  await fsp.mkdir(path.join(ROOT, 'px4', 'sub'), { recursive: true })
  await fsp.writeFile(path.join(ROOT, 'px4', 'sub', 'f.txt'), 'p4-content')
  const P4_S = await freshStore('p4')
  const p4caps = await services.dav.probeCapabilities(cfg, true)
  check('P4 probe observes collection redirect and classifies tier A', p4caps.collectionRedirect === true && p4caps.tier === 'A', JSON.stringify(p4caps))
  const P4_A = await tmpLocal('p4')
  const p4s1 = await syncP(P4_A, '/px4')
  check('P4 full sync works under redirecting server', p4s1.downloaded === 1 && (await fsp.readFile(path.join(P4_A, 'sub', 'f.txt'), 'utf-8')) === 'p4-content', JSON.stringify(p4s1))
  const p4settle = await settleStable(P4_A, '/px4')
  check('P4 settles to no-op', p4settle.ok, `rounds=${p4settle.rounds}`)

  })

  // ---------- P5 限流 429 + Retry-After ----------

  // [慢组登记原因] 探测期 3×Retry-After=1s 真实等待；429 重试语义仍由 RL 覆盖
  await slowSection('P5：限流档', '探测期 3×Retry-After=1s 真实等待；429 重试语义仍由 RL 覆盖', async () => {
  await setProfile('p5')
  await fsp.rm(path.join(ROOT, 'px5'), { recursive: true, force: true }).catch(() => {})
  const P5_S = await freshStore('p5')
  const P5_A = await tmpLocal('p5')
  const p5t0 = Date.now()
  const p5caps = await services.dav.probeCapabilities(cfg, true)
  const p5probeMs = Date.now() - p5t0
  check('P5 probe survives rate limiting and still classifies tier A', p5caps.tier === 'A' && p5caps.conditional.ifMatch === true, JSON.stringify(p5caps.notes))
  check('P5 probe respected Retry-After waits', p5probeMs >= 2900 && p5probeMs < 20000, `${p5probeMs}ms`)
  await fsp.writeFile(path.join(P5_A, 'a.txt'), 'p5-content')
  const p5s1 = await syncP(P5_A, '/px5')
  check('P5 sync round completes after probe exhausted the limit budget', p5s1.uploaded === 1 && (await fsp.readFile(path.join(ROOT, 'px5', 'a.txt'), 'utf-8')) === 'p5-content', JSON.stringify(p5s1))

  })

  // ---------- P6 上传后异步改写 mtime/etag（指纹扰动收敛）----------

  // [慢组登记原因] 指纹扰动多轮 settleStable 收敛马拉松；指纹噪声收敛仍由 N3 覆盖
  await slowSection('P6：异步指纹扰动档', '指纹扰动多轮 settleStable 收敛马拉松；指纹噪声收敛仍由 N3 覆盖', async () => {
  await setProfile('p6')
  await fsp.rm(path.join(ROOT, 'px6'), { recursive: true, force: true }).catch(() => {})
  const P6_S = await freshStore('p6')
  const P6_A = await tmpLocal('p6')
  const p6caps = await services.dav.probeCapabilities(cfg, true)
  check('P6 probe classifies tier A with unstable etag (mtime in etag)', p6caps.tier === 'A' && p6caps.etag.stable === false && p6caps.etag.present === true, JSON.stringify(p6caps))
  let p6conflicts = 0
  const p6sync = async () => {
    const s = await syncP(P6_A, '/px6')
    p6conflicts += s.conflicts
    return s
  }
  await fsp.writeFile(path.join(P6_A, 'a.txt'), 'p6-content-a')
  await fsp.writeFile(path.join(P6_A, 'b.txt'), 'p6-content-b')
  const p6s2 = await p6sync()
  check('P6 uploads succeed under post-PUT fingerprint churn', p6s2.uploaded === 2, JSON.stringify(p6s2))
  const p6settle1 = await settleStable(P6_A, '/px6')
  check('P6 no infinite re-transfer after initial uploads', p6settle1.ok, `rounds=${p6settle1.rounds}`)
  await fsp.writeFile(path.join(P6_A, 'a.txt'), 'p6-content-a-v2-longer')
  const p6s3 = await p6sync()
  check('P6 edit uploads normally', p6s3.uploaded === 1, JSON.stringify(p6s3))
  const p6settle2 = await settleStable(P6_A, '/px6')
  check('P6 no infinite re-transfer after edit', p6settle2.ok, `rounds=${p6settle2.rounds}`)
  check('P6 fingerprint churn never produces conflicts', p6conflicts === 0, `conflicts=${p6conflicts}`)

  })

  // ---------- P7 静默忽略条件头（conditional=false → B 档）----------

  // [慢组登记原因] B 档（忽略条件头）深水区；p7 复查放弃路径仍由 PC4 覆盖
  await slowSection('P7：静默忽略条件头档', 'B 档（忽略条件头）深水区；p7 复查放弃路径仍由 PC4 覆盖', async () => {
  await setProfile('p7')
  await fsp.rm(path.join(ROOT, 'px7'), { recursive: true, force: true }).catch(() => {})
  const P7_S = await freshStore('p7a')
  const P7_A = await tmpLocal('p7a')
  const p7caps = await services.dav.probeCapabilities(cfg, true)
  check(
    'P7 probe detects silently ignored conditionals and classifies tier B',
    p7caps.tier === 'B' && p7caps.conditional.ifMatch === false && p7caps.conditional.ifNoneMatch === false && p7caps.etag.present === true && p7caps.writable === true,
    JSON.stringify(p7caps)
  )
  await fsp.writeFile(path.join(P7_A, 'race-midair.txt'), 'p7-v1')
  await fsp.writeFile(path.join(P7_A, 'a.txt'), 'p7-content')
  const p7s1 = await syncP(P7_A, '/px7')
  check('P7 first sync uploads with concurrency warning', p7s1.uploaded === 2 && p7s1.warnings.some((w) => /多台设备/.test(w)), JSON.stringify(p7s1.warnings))
  // 已知边界（记录在案）：复查（Depth:0 PROPFIND）通过后、PUT 落地前，钩子把远端改写为
  // 对端版本；P7 忽略条件头 → PUT 照常覆盖，对端修改丢失（last-writer-wins）
  await fsp.writeFile(path.join(P7_A, 'race-midair.txt'), 'p7-v2-local-longer')
  await setMidair('put')
  const p7s2 = await syncP(P7_A, '/px7')
  await setMidair(null)
  check(
    'P7 midair overwrite succeeds (known boundary: peer edit silently lost)',
    p7s2.uploaded === 1 && (await fsp.readFile(path.join(ROOT, 'px7', 'race-midair.txt'), 'utf-8')) === 'p7-v2-local-longer',
    JSON.stringify(p7s2)
  )
  const p7settle = await settleStable(P7_A, '/px7')
  check('P7 settles to no-op (no infinite loop despite ignored conditionals)', p7settle.ok, `rounds=${p7settle.rounds}`)
  // B 档并发安全提示只在首轮携带（渲染层逐轮 toast 会重复打扰；标记随 noise.json
  // 跨轮持久）—— 后续干净轮次不再出现
  const p7s3 = await syncP(P7_A, '/px7')
  check('P7 concurrency warning appears only once (later rounds carry none)', !p7s3.warnings.some((w) => /多台设备/.test(w)), JSON.stringify(p7s3.warnings))
  // 多设备基础交替
  const P7_SB = await freshStore('p7b')
  const P7_B = await tmpLocal('p7b')
  await switchDevice(P7_SB)
  const p7b1 = await syncP(P7_B, '/px7')
  check('P7 device B downloads all', p7b1.downloaded === 2, JSON.stringify(p7b1))
  await switchDevice(P7_S)
  await fsp.writeFile(path.join(P7_A, 'a.txt'), 'p7-content-v2')
  const p7a2 = await syncP(P7_A, '/px7')
  await switchDevice(P7_SB)
  const p7b2 = await syncP(P7_B, '/px7')
  check('P7 A edit propagates to B', p7a2.uploaded === 1 && p7b2.downloaded === 1 && (await fsp.readFile(path.join(P7_B, 'a.txt'), 'utf-8')) === 'p7-content-v2', `${JSON.stringify(p7a2)} ${JSON.stringify(p7b2)}`)

  })

  // ---------- P8 只读（403）→ C 档 download-only ----------

  await section('P8：只读档', async () => {
  await setProfile('p8')
  await fsp.rm(path.join(ROOT, 'px8'), { recursive: true, force: true }).catch(() => {})
  await fsp.mkdir(path.join(ROOT, 'px8'), { recursive: true })
  await fsp.writeFile(path.join(ROOT, 'px8', 'r1.txt'), 'p8-remote-1')
  await fsp.writeFile(path.join(ROOT, 'px8', 'r2.txt'), 'p8-remote-2')
  const P8_S = await freshStore('p8a')
  const p8caps = await services.dav.probeCapabilities(cfg, true)
  check('P8 probe classifies tier C (write rejected)', p8caps.tier === 'C' && p8caps.writable === false && p8caps.notes.some((n) => /HTTP 403/.test(n)), JSON.stringify(p8caps.notes))
  const P8_A = await tmpLocal('p8a')
  await fsp.writeFile(path.join(P8_A, 'new-local.txt'), 'p8-local-only')
  const p8s1 = await syncP(P8_A, '/px8')
  check(
    'P8 read-only round downloads only, uploads skipped, round does not fail',
    p8s1.downloaded === 2 && p8s1.uploaded === 0 && p8s1.warnings.some((w) => /只能下载/.test(w)) && p8s1.errors.length === 0,
    JSON.stringify(p8s1)
  )
  check('P8 local-only file not uploaded', !fs.existsSync(path.join(ROOT, 'px8', 'new-local.txt')))
  // 远端被外部删除 → delete-local 计划被 C 档跳过：本地数据不丢
  await fsp.rm(path.join(ROOT, 'px8', 'r2.txt'))
  const p8s2 = await syncP(P8_A, '/px8')
  check(
    'P8 delete-local skipped to preserve local data, round still succeeds',
    p8s2.deleted === 0 && p8s2.errors.length === 0 && fs.existsSync(path.join(P8_A, 'r2.txt')) && fs.existsSync(path.join(ROOT, 'px8', 'r1.txt')),
    JSON.stringify(p8s2.warnings)
  )
  // 多设备：B 下载；B 本地编辑不被上传（远端只读），远端内容不变
  const P8_SB = await freshStore('p8b')
  const P8_B = await tmpLocal('p8b')
  await switchDevice(P8_SB)
  const p8b1 = await syncP(P8_B, '/px8')
  check('P8 device B downloads read-only content', p8b1.downloaded === 1 && (await fsp.readFile(path.join(P8_B, 'r1.txt'), 'utf-8')) === 'p8-remote-1', JSON.stringify(p8b1))
  await fsp.writeFile(path.join(P8_B, 'r1.txt'), 'p8-B-local-edit')
  const p8b2 = await syncP(P8_B, '/px8')
  check('P8 device B local edit never uploaded (C tier)', p8b2.uploaded === 0 && (await fsp.readFile(path.join(ROOT, 'px8', 'r1.txt'), 'utf-8')) === 'p8-remote-1', JSON.stringify(p8b2))

  })

  // ---------- P9 Depth infinity 可用 ----------

  await section('P9：Depth infinity 档', async () => {
  await setProfile('p9')
  await fsp.rm(path.join(ROOT, 'px9'), { recursive: true, force: true }).catch(() => {})
  await fsp.mkdir(path.join(ROOT, 'px9', 'deep', 'deeper'), { recursive: true })
  await fsp.writeFile(path.join(ROOT, 'px9', 'top.txt'), 'p9-top')
  await fsp.writeFile(path.join(ROOT, 'px9', 'deep', 'deeper', 'leaf.txt'), 'p9-leaf')
  const P9_S = await freshStore('p9')
  const p9caps = await services.dav.probeCapabilities(cfg, true)
  check('P9 probe detects Depth infinity support (nested-entry verified) and classifies tier A', p9caps.depthInfinity === true && p9caps.tier === 'A', JSON.stringify(p9caps))
  const P9_A = await tmpLocal('p9')
  const p9s1 = await syncP(P9_A, '/px9')
  check('P9 sync works normally (single-request infinity scan since stage 7)', p9s1.downloaded === 2 && (await fsp.readFile(path.join(P9_A, 'deep', 'deeper', 'leaf.txt'), 'utf-8')) === 'p9-leaf', JSON.stringify(p9s1))
  const p9settle = await settleStable(P9_A, '/px9')
  check('P9 settles to no-op', p9settle.ok, `rounds=${p9settle.rounds}`)
  await setProfile(null)
  })

  // ============================================================
  // XS 系列：saxes 解析器直检 —— 前缀变体 / 实体解码 /
  // 流式块边界 / 畸形必抛 / first-match / 坏百分号序列保底
  // ============================================================

  await section('XS：saxes 解析器直检', async () => {
    const P = services.sync._internals
    // p 为命名空间前缀（含冒号）：'D:' / 'd:' / ''（默认命名空间）
    const mkEntry = (p, name, size) =>
      `<${p}response><${p}href>/dav/d/${encodeURIComponent(name)}</${p}href><${p}propstat><${p}prop>` +
      `<${p}resourcetype/><${p}getcontentlength>${size}</${p}getcontentlength>` +
      `<${p}getetag>&#x22;h&#x65;x&#x22;</${p}getetag>` +
      `</${p}prop></${p}propstat></${p}response>`
    const docOf = (p) =>
      `<?xml version="1.0"?><${p}multistatus ${p ? `xmlns:${p.slice(0, -1)}="DAV:"` : 'xmlns="DAV:"'}>` +
      `${mkEntry(p, '中 文.txt', 3)}${mkEntry(p, 'a&b.txt', 5)}</${p}multistatus>`
    const expectHrefs = ['/dav/d/中 文.txt', '/dav/d/a&b.txt']
    for (const p of ['D:', 'd:', '']) {
      const parsed = P.parseMultistatus(docOf(p))
      check(
        `XS prefix '${p || 'none'}' parses hrefs, entities and hex entities`,
        parsed.length === 2 && parsed[0].href === expectHrefs[0] && parsed[1].href === expectHrefs[1] && parsed[0].etag === '"hex"' && parsed[0].size === 3,
        JSON.stringify(parsed)
      )
    }
    // 流式：7 字节小块喂 Buffer —— 多字节中文名必然被块边界拆断，StringDecoder 必须缝好
    const stream = P.createMultistatusStream()
    const buf = Buffer.from(docOf('D:'), 'utf-8')
    for (let i = 0; i < buf.length; i += 7) stream.write(buf.subarray(i, Math.min(i + 7, buf.length)))
    stream.close()
    const chunked = stream.entries()
    check('XS chunked stream equals whole-string parse', JSON.stringify(chunked) === JSON.stringify(P.parseMultistatus(docOf('D:'))), JSON.stringify(chunked))
    // 畸形：截断 / 未闭合必抛（绝不静默返回部分结果）
    let threwTrunc = false
    try {
      P.parseMultistatus(docOf('D:').slice(0, Math.floor(docOf('D:').length * 0.5)))
    } catch (_) {
      threwTrunc = true
    }
    check('XS truncated document throws', threwTrunc)
    let threwUnclosed = false
    try {
      P.parseMultistatus(docOf('D:').replace('</D:multistatus>', ''))
    } catch (_) {
      threwUnclosed = true
    }
    check('XS unclosed document throws', threwUnclosed)
    // first-match：404 propstat 与 200 propstat 并存时，同名 prop 首次出现生效
    const dup =
      '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/a</D:href>' +
      '<D:propstat><D:prop><D:getcontentlength>1</D:getcontentlength></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>' +
      '<D:propstat><D:prop><D:getcontentlength>9</D:getcontentlength></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat>' +
      '</D:response></D:multistatus>'
    const dupParsed = P.parseMultistatus(dup)
    check('XS first-match prop wins (404 propstat ignored)', dupParsed.length === 1 && dupParsed[0].size === 1, JSON.stringify(dupParsed))
    // 坏百分号序列（文件名含裸 % 且服务器未编码）：保留原值，不炸整次解析
    const badPct = '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/dav/d/100%zz.txt</D:href></D:response></D:multistatus>'
    const badParsed = P.parseMultistatus(badPct)
    check('XS bad percent sequence kept as-is', badParsed.length === 1 && badParsed[0].href === '/dav/d/100%zz.txt', JSON.stringify(badParsed))
  })

  // ============================================================
  // W 系列（核查项的验收用例）
  // ============================================================
  // W1：引擎临时文件不触发 watcher（防自触发同步回路）；真实用户修改仍触发

  // [慢组登记原因] watcher 防自触发需 2×~2s 真实静置，用例价值密度低
  await slowSection('W1：引擎临时文件不触发 watcher', 'watcher 防自触发需 2×~2s 真实静置，用例价值密度低', async () => {
    const W1_LOCAL = await tmpLocal('w1')
    let w1fired = 0
    services.fsx.watchDir('w1', W1_LOCAL, () => {
      w1fired++
    })
    // 引擎会在同步目录写的全部临时形态 + 同步系统残留
    for (const n of ['.wdsync-tmp-tol-123-abc', '.wdsync-dl-999-x', '.wdsync-verify-1-y', '.wdsync-probe-zz', '.webdav-sync.json']) {
      await fsp.writeFile(path.join(W1_LOCAL, n), 'x')
    }
    await sleep(2000)
    check('W1 engine temp files do not trigger watcher', w1fired === 0, `fired=${w1fired}`)
    await fsp.writeFile(path.join(W1_LOCAL, 'user-edit.txt'), 'x')
    // 同基础-watch：事件迟送 / 合并丢失容忍 —— 轮询 + 过半补写一次；终值仍严格 === 1
    //（临时文件 0 次 + 用户修改恰 1 次，防自触发断言不放松）
    let w1re = 0
    const w1Start = Date.now()
    while (w1fired === 0) {
      if (Date.now() - w1Start > 8000) break
      if (w1re === 0 && Date.now() - w1Start > 3000) {
        w1re++
        await fsp.writeFile(path.join(W1_LOCAL, 'user-edit.txt'), 'x2')
      }
      await sleep(100)
    }
    check('W1 real user change still triggers watcher', w1fired === 1, `fired=${w1fired}`)
    services.fsx.stopWatch('w1')
    await fsp.rm(W1_LOCAL, { recursive: true, force: true }).catch(() => {})
  })

  // W2：远端残留的另一设备探测目录 / 临时文件不被当成普通文件下载
  //（ignoreHidden=false 下依然排除 —— 排除依据是引擎前缀而非隐藏规则）

  await section('W2：远端残留排除', async () => {
    await fsp.mkdir(path.join(ROOT, 'w2remote', '.wdsync-probe-leftover'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'w2remote', '.wdsync-probe-leftover', 'probe.txt'), 'p')
    await fsp.writeFile(path.join(ROOT, 'w2remote', '.wdsync-tmp-remote-leftover'), 't')
    await fsp.writeFile(path.join(ROOT, 'w2remote', 'real.txt'), 'r')
    const W2_LOCAL = await tmpLocal('w2')
    const w2sum = await syncP(W2_LOCAL, '/w2remote', { ...SP, ignoreHidden: false })
    check(
      'W2 remote probe/tmp leftovers excluded from sync',
      w2sum.downloaded === 1 && fs.existsSync(path.join(W2_LOCAL, 'real.txt')) && !fs.existsSync(path.join(W2_LOCAL, '.wdsync-tmp-remote-leftover')),
      JSON.stringify(w2sum)
    )
    check('W2 leftovers absent from baseline', (await services.sync._internals.baselineSize({ id: 'p', localPath: W2_LOCAL, remotePath: '/w2remote', mode: 'two-way' })) === 1)
    await fsp.rm(W2_LOCAL, { recursive: true, force: true }).catch(() => {})
  })

  // W3：A 档 If-Match 取值来源 —— 覆盖上传时 If-Match === 基线 retag（非冲突
  // 上放下扫描 etag 与基线 etag 按决策定义相等）；首轮 / 无基线新上传走 If-None-Match:*

  await section('W3：A 档条件头取值', async () => {
    const W3_LOCAL = await tmpLocal('w3')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-captheaders'), 'x')
    try {
      const w3dir = { id: 'p', localPath: W3_LOCAL, remotePath: '/w3', mode: 'two-way' }
      await fsp.writeFile(path.join(W3_LOCAL, 'g.txt'), 'g-v1')
      const w3s1 = await syncP(W3_LOCAL, '/w3')
      const w3base = await services.sync._internals.baselineEntry(w3dir, 'g.txt')
      await fsp.writeFile(path.join(W3_LOCAL, 'g.txt'), 'g-v2-longer-content')
      const w3s2 = await syncP(W3_LOCAL, '/w3')
      const log = fs.readFileSync(path.join(ROOT, '.wdsync-test-captheaders.log'), 'utf-8').trim().split('\n')
      const puts = log.filter((l) => l.startsWith('PUT /dav/w3/g.txt'))
      const first = puts[0] || ''
      const overwrite = puts[puts.length - 1] || ''
      check(
        'W3 first upload (no baseline) uses If-None-Match:* only',
        w3s1.uploaded === 1 && first.includes('INM=*') && first.includes('IM=-'),
        log.join(' | ')
      )
      check(
        'W3 overwrite If-Match equals baseline retag (== scan etag by decision definition)',
        w3s2.uploaded === 1 && w3base && w3base.retag && overwrite.includes(`IM=${w3base.retag}`) && overwrite.includes('INM=-'),
        `${overwrite} baseline=${w3base && w3base.retag}`
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-captheaders'), { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, '.wdsync-test-captheaders.log'), { force: true }).catch(() => {})
    }
    await fsp.rm(W3_LOCAL, { recursive: true, force: true }).catch(() => {})
  })

  // W4：写权限按远端根路径判定 —— 同一 origin+账号下一路径只读（C 档）、
  // 另一路径可写（A 档）；公共能力字段（etag / 条件请求）跨路径共享

  await section('W4：按子路径写权限', async () => {
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-ro-subpaths'), 'shared-ro')
    try {
      await freshStore('w4')
      await fsp.mkdir(path.join(ROOT, 'shared-ro'), { recursive: true })
      const roCaps = await services.dav.probeCapabilities(cfg, true, '/shared-ro')
      check(
        'W4 read-only subpath classifies tier C with reason',
        roCaps.tier === 'C' && roCaps.writable === false && /权限/.test(roCaps.writeReason || '') && roCaps.notes.some((n) => /403/.test(n)),
        JSON.stringify(roCaps)
      )
      const rwCaps = await services.dav.probeCapabilities(cfg, false, '/ok-write')
      check(
        'W4 writable subpath (same origin+user) classifies tier A with shared common caps',
        rwCaps.tier === 'A' && rwCaps.writable === true && rwCaps.conditional.ifMatch === true && rwCaps.etag.present === true,
        JSON.stringify(rwCaps)
      )
      // 只读子路径上的真实同步：download-only，本地新文件不上传、远端内容不丢
      await fsp.writeFile(path.join(ROOT, 'shared-ro', 'r1.txt'), 'ro-1')
      const W4_LOCAL = await tmpLocal('w4ro')
      await fsp.writeFile(path.join(W4_LOCAL, 'local-only.txt'), 'x')
      const w4sum = await syncP(W4_LOCAL, '/shared-ro')
      check(
        'W4 sync into read-only subpath downloads only',
        w4sum.downloaded === 1 && w4sum.uploaded === 0 && w4sum.errors.length === 0 && w4sum.warnings.some((w) => /只能下载/.test(w)),
        JSON.stringify(w4sum)
      )
      check('W4 read-only subpath keeps local-only file off remote', !fs.existsSync(path.join(ROOT, 'shared-ro', 'local-only.txt')))
      await fsp.rm(W4_LOCAL, { recursive: true, force: true }).catch(() => {})
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-ro-subpaths'), { force: true }).catch(() => {})
    }
  })

  // W5：MKCOL 非权限性失败（409）不得按 C 档缓存 —— 当轮 B 档保守 + 不落长期缓存，
  // 故障移除后无须 force 即恢复可写

  await section('W5：MKCOL 非权限失败分类', async () => {
    await freshStore('w5')
    await fsp.mkdir(path.join(ROOT, 'mkcolpath'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-mkcolfail'), '409')
    try {
      const w5caps = await services.dav.probeCapabilities(cfg, true, '/mkcolpath')
      check(
        'W5 non-permission MKCOL failure stays tier B (not C) with retry-soon marker',
        w5caps.tier === 'B' && w5caps.writeRetrySoon === true && w5caps.notes.some((n) => /409/.test(n)) && !w5caps.degraded,
        JSON.stringify(w5caps)
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-mkcolfail'), { force: true }).catch(() => {})
    }
    const w5caps2 = await services.dav.probeCapabilities(cfg, false, '/mkcolpath')
    check('W5 recovers to writable without force after fault removed', w5caps2.tier === 'A' && w5caps2.writable === true, JSON.stringify(w5caps2))
  })

  // W6：远端同步根目录尚不存在 —— 同步轮先建根（既有行为），探测在新建根上
  // 照常完成（MKCOL 探测目录 / PUT 探测文件都在新根下），首轮上传成功

  await section('W6：远端根缺失自动创建', async () => {
    await freshStore('w6')
    const W6_LOCAL = await tmpLocal('w6')
    await fsp.writeFile(path.join(W6_LOCAL, 'a.txt'), 'w6-a')
    const w6sum = await syncP(W6_LOCAL, '/brand-new-root-xyz')
    check(
      'W6 missing remote root auto-created, probed there, first upload succeeds',
      w6sum.uploaded === 1 && w6sum.tier === 'A' && fs.existsSync(path.join(ROOT, 'brand-new-root-xyz', 'a.txt')),
      JSON.stringify(w6sum)
    )
    await fsp.rm(W6_LOCAL, { recursive: true, force: true }).catch(() => {})
  })

  // W7：持续 503 的服务器 —— 连续失败触发整轮熔断，轮次时长有上界；
  // 故障移除后下一轮自动恢复并完成全部上传

  // [慢组登记原因] 503×4 熔断重试链×2 的真实退避等待；失败分类由 PF0 直检覆盖、熔断恢复路径由 L5（同为慢组）覆盖
  await slowSection('W7：持续 503 熔断风暴', '503×4 熔断重试链×2 的真实退避等待；失败分类由 PF0 直检覆盖、熔断恢复路径由 L5（同为慢组）覆盖', async () => {
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-err503'), 'x')
    const W7_LOCAL = await tmpLocal('w7')
    try {
      await freshStore('w7')
      for (let i = 0; i < 10; i++) await fsp.writeFile(path.join(W7_LOCAL, `f${i}.txt`), 'x')
      const w7t0 = Date.now()
      let w7err = null
      try {
        await syncP(W7_LOCAL, '/w7')
      } catch (e) {
        w7err = e
      }
      const w7ms = Date.now() - w7t0
      const w7msgs = w7err && w7err.errors ? w7err.errors.join(';') : String(w7err && w7err.message)
      check('W7 persistent 503 trips round breaker with clear message', !!w7err && /连续多次出错/.test(w7msgs), w7msgs)
      check('W7 round duration bounded by circuit (not per-file retries)', w7ms < 45000, `${w7ms}ms`)
      // 熔断轮的机器可读字段 —— 调度层据此归因
      //「服务器连续无响应」并计入跨轮退避，不再解析错误文案
      check(
        'W7 err.summary.breaker = { open, consecutive >= threshold, reason }',
        !!w7err && w7err.summary && w7err.summary.breaker && w7err.summary.breaker.open === true && w7err.summary.breaker.consecutive >= 5 && /503/.test(String(w7err.summary.breaker.reason)),
        w7err && JSON.stringify(w7err.summary && w7err.summary.breaker)
      )
      check(
        'W7 err.summary.failureClass = network (all errors network-class)',
        !!w7err && w7err.summary && w7err.summary.failureClass === 'network' && w7err.summary.openIntents === 0,
        w7err && JSON.stringify({ failureClass: w7err.summary && w7err.summary.failureClass, openIntents: w7err.summary && w7err.summary.openIntents })
      )
      const w7remote = await fsp.readdir(path.join(ROOT, 'w7')).catch(() => [])
      check('W7 nothing landed on remote during 503 storm', w7remote.length === 0, JSON.stringify(w7remote))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-err503'), { force: true }).catch(() => {})
    }
    const w7b = await syncP(W7_LOCAL, '/w7')
    check('W7 next round after fault removal completes all uploads', w7b.uploaded === 10 && w7b.errors.length === 0, JSON.stringify(w7b))
    await fsp.rm(W7_LOCAL, { recursive: true, force: true })
  })

  // W8：远端探测残留按龄清理 —— 同步轮扫描后删除陈旧残留（≥10 分钟）、保留新鲜残留
  //（年龄门槛），且新鲜残留绝不进入同步候选（ignoreHidden=false 下依旧排除）

  await section('W8：探测残留按龄清理', async () => {
    await freshStore('w8')
    const W8_LOCAL = await tmpLocal('w8')
    await fsp.writeFile(path.join(W8_LOCAL, 'a.txt'), 'w8-a')
    const w8Stale = path.join(ROOT, 'w8', '.wdsync-probe-stale-xyz')
    const w8Fresh = path.join(ROOT, 'w8', '.wdsync-probe-fresh-xyz')
    await fsp.mkdir(w8Stale, { recursive: true })
    await fsp.writeFile(path.join(w8Stale, 'probe.txt'), 'stale')
    await fsp.mkdir(w8Fresh, { recursive: true })
    await fsp.writeFile(path.join(w8Fresh, 'probe.txt'), 'fresh')
    // utimes 远端根下的真实目录（写完 probe.txt 再拨回，防止子文件创建顶新目录 mtime）
    const w8Old = new Date(Date.now() - 11 * 60 * 1000)
    await fsp.utimes(w8Stale, w8Old, w8Old)
    const w8sum = await syncP(W8_LOCAL, '/w8', { ...SP, ignoreHidden: false })
    check('W8 stale probe residue dir removed after sync round', !fs.existsSync(w8Stale), JSON.stringify(w8sum))
    check('W8 fresh probe residue kept (under min age)', fs.existsSync(w8Fresh) && fs.existsSync(path.join(w8Fresh, 'probe.txt')))
    check(
      'W8 fresh residue never synced as normal file (ignoreHidden=false)',
      w8sum.uploaded === 1 && w8sum.downloaded === 0 && w8sum.totalFiles === 1 && !fs.existsSync(path.join(W8_LOCAL, '.wdsync-probe-fresh-xyz')),
      JSON.stringify(w8sum)
    )
    check(
      'W8 fresh residue absent from baseline',
      (await services.sync._internals.baselineSize({ id: 'p', localPath: W8_LOCAL, remotePath: '/w8', mode: 'two-way' })) === 1
    )
    await fsp.rm(W8_LOCAL, { recursive: true, force: true })
  })

  // W9：多设备视角 —— 清理不区分设备：设备 A 同步过的远端根里的陈旧探测残留，
  // 由设备 B（全新存储根 / 新 deviceId）的同步轮完成清理，且 B 不把残留当普通文件

  await section('W9：多设备残留清理', async () => {
    const W9_SA = await freshStore('w9a')
    const W9_A = await tmpLocal('w9a')
    await fsp.writeFile(path.join(W9_A, 'shared.txt'), 'w9-a')
    const w9a1 = await syncP(W9_A, '/w9')
    check('W9 device A first sync uploads', w9a1.uploaded === 1, JSON.stringify(w9a1))
    // 模拟设备 A 的探测崩溃残留（目录 mtime 拨到 12 分钟前）
    const w9Stale = path.join(ROOT, 'w9', '.wdsync-probe-crash-abc')
    await fsp.mkdir(w9Stale, { recursive: true })
    await fsp.writeFile(path.join(w9Stale, 'probe.txt'), 'x')
    const w9Old = new Date(Date.now() - 12 * 60 * 1000)
    await fsp.utimes(w9Stale, w9Old, w9Old)
    await freshStore('w9b') // 设备 B：全新存储根（新 deviceId / 新能力缓存 / 新基线）
    const W9_B = await tmpLocal('w9b')
    const w9b = await syncP(W9_B, '/w9', { ...SP, ignoreHidden: false })
    check("W9 device B round cleans other device's stale probe residue", !fs.existsSync(w9Stale), JSON.stringify(w9b))
    check(
      'W9 residue not counted as normal file by device B',
      w9b.downloaded === 1 && fs.existsSync(path.join(W9_B, 'shared.txt')) && !fs.existsSync(path.join(W9_B, '.wdsync-probe-crash-abc')),
      JSON.stringify(w9b)
    )
    check(
      'W9 device B baseline holds only the real file',
      (await services.sync._internals.baselineSize({ id: 'p', localPath: W9_B, remotePath: '/w9', mode: 'two-way' })) === 1
    )
    await fsp.rm(W9_A, { recursive: true, force: true })
    await fsp.rm(W9_B, { recursive: true, force: true })
  })

afterAll(async () => {
  await teardownShard({ ROOT, LOCAL, server })
})
