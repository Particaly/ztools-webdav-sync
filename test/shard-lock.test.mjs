/**
 * e2e 分片「lock」：锁与批量组（PF0-2 / BV1-4 / L1-L14 / B2B-P404 / CA / PU / PC1-4 / B2A / B2B / TR1）。两处 setProfile p1 前置在模块级生效（收集期写入，跳过任一节不失效）
 * 每文件独立 dav-server / 端口 / 根目录，
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
import { setupShard, teardownShard, section, slowSection, check, sleep, isNoop, SP, makeTrashStub } from './harness.mjs'

const {
    HERE, ROOT, PORT, LOCAL, server, services, cfg, storeModule, BUILT, preloadPath,
    STORAGE_MAIN, STORAGE_A, STORAGE_B, STORAGE_C, STORAGE_D, switchDevice,
    baselineDirOf, setProfile, setMidair, freshStore, tmpLocal, syncP, settleStable, sweepCrashResidue, projDir,
    REQLOG, readReqlog, countReq, lastReqLine,
    DEPTHLOG, readDepthlog, countDepth, clearDepthFlags,
    setThrottle, waitForReqLine, waitAbortLine, runCancelRound, readWalOps, findTempResidue,
    PUP, setNetcut, setPartialPut, puBuf,
    SC_DB, SC_KEY, setSCConfig, createTestSched, makeFakeClock, waitReal, pumpUntil, readLeaderLock, writeLeaderLock,
  } = await setupShard({ shard: 'lock' })

  // 宿主回收站桩（原分片内逐字复制的 installTrash 块，统一收敛到 harness 工厂）
  const trash = makeTrashStub()
  const { install: installTrash } = trash
  installTrash()

  // ============================================================
  // PF 系列：永久失败分类 + 指数退避重试 + 瞬时失败当轮重试
  // ============================================================
  // PF0 分类规则直检：permanent / transient / normal 三分类的关键边界

  await section('PF0：失败分类直检', async () => {
    const C = services.sync._internals.classifyOpFailure
    check(
      'PF0 classifyOpFailure permanent set (413/507/403/405, EACCES/EPERM, BAD_FILENAME)',
      C({ status: 413 }) === 'permanent' &&
        C({ status: 507 }) === 'permanent' &&
        C({ status: 403 }) === 'permanent' &&
        C({ status: 405 }) === 'permanent' &&
        C({ code: 'EACCES' }) === 'permanent' &&
        C({ code: 'EPERM' }) === 'permanent' &&
        C({ code: 'BAD_FILENAME' }) === 'permanent'
    )
    check(
      'PF0 classifyOpFailure 401 stays normal (config-level, must fail the round loudly)',
      C({ status: 401 }) === 'normal' && C({ code: 'AUTH', status: 401 }) === 'normal'
    )
    check(
      'PF0 classifyOpFailure transient set (423 / NETWORK / LOCAL_IO+EBUSY)',
      C({ status: 423 }) === 'transient' &&
        C({ code: 'NETWORK', status: 0 }) === 'transient' &&
        C({ code: 'LOCAL_IO', message: '写入本地文件失败 x.txt：EBUSY' }) === 'transient'
    )
    check(
      'PF0 classifyOpFailure protective errors stay normal (REMOTE_CHANGED / 412 / CIRCUIT_OPEN / 5xx)',
      C({ code: 'REMOTE_CHANGED', permanent: true }) === 'normal' &&
        C({ status: 412, code: 'PRECONDITION', permanent: true }) === 'normal' &&
        C({ code: 'CIRCUIT_OPEN', permanent: true }) === 'normal' &&
        C({ status: 500 }) === 'normal' &&
        C(null) === 'normal'
    )
  })

  // PF1（413 永久失败退避）：第一轮轮次报错、其余文件成功、failures 记 count=1；
  // 第二轮退避未到期 → 跳过重试（count 不变）且轮次成功带「跳过」warning；
  // ageFailures 推进时间 → 第三轮重试仍 413（count=2、退避翻倍）；再推进并移除故障 →
  // 第四轮成功且失败记录清空（PF3 一并断言）

  await section('PF1：413 永久失败退避', async () => {
    await freshStore('pf1')
    const PF1_LOCAL = await tmpLocal('pf1')
    for (const n of ['p1.txt', 'p2.txt', 'p3.txt']) await fsp.writeFile(path.join(PF1_LOCAL, n), `pf1-${n}`)
    await fsp.writeFile(path.join(PF1_LOCAL, 'bad.toolarge.txt'), 'pf1-too-large')
    const pf1dir = { id: 'pf1', localPath: PF1_LOCAL, remotePath: '/pf1', mode: 'two-way' }
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-fail413'), 'x')
    try {
      let pf1e1 = null
      try {
        await syncP(PF1_LOCAL, '/pf1')
      } catch (e) {
        pf1e1 = e
      }
      check(
        'PF1 round 1 fails on 413 while other files upload',
        !!pf1e1 && /413/.test(pf1e1.message) && pf1e1.summary && pf1e1.summary.uploaded === 3,
        pf1e1 && pf1e1.message
      )
      check('PF1 too-large file never lands on remote', !fs.existsSync(path.join(ROOT, 'pf1', 'bad.toolarge.txt')))
      const f1 = (await services.sync._internals.getFailures(pf1dir))['bad.toolarge.txt']
      check(
        'PF1 failure recorded with count=1 and ~15min backoff',
        !!f1 && f1.count === 1 && /413/.test(f1.message) && f1.retryAtMs > Date.now() + 14 * 60 * 1000 && f1.retryAtMs <= Date.now() + 16 * 60 * 1000,
        JSON.stringify(f1)
      )
      // 第二轮：退避未到期 → 规划层不生成传输任务（count 保持 1 证明未重试），轮次成功
      const pf1s2 = await syncP(PF1_LOCAL, '/pf1')
      check(
        'PF1 round 2 skips backed-off file, round succeeds with skip warning',
        pf1s2.errors.length === 0 &&
          pf1s2.uploaded === 0 &&
          pf1s2.warnings.some((w) => /1 个文件一直同步失败/.test(w) && /bad\.toolarge\.txt/.test(w) && /下次重试/.test(w)),
        JSON.stringify(pf1s2.warnings)
      )
      const f2 = (await services.sync._internals.getFailures(pf1dir))['bad.toolarge.txt']
      check('PF1 round 2 did not retry the file (count stays 1)', !!f2 && f2.count === 1, JSON.stringify(f2))
      // 推进退避时间 → 第三轮重试，仍 413 → count=2、退避翻倍（约 30 分钟）
      await services.sync._internals.ageFailures(pf1dir, 16 * 60 * 1000)
      let pf1e3 = null
      try {
        await syncP(PF1_LOCAL, '/pf1')
      } catch (e) {
        pf1e3 = e
      }
      const f3 = (await services.sync._internals.getFailures(pf1dir))['bad.toolarge.txt']
      check(
        'PF1 round 3 retries after backoff expiry and re-fails with doubled backoff',
        !!pf1e3 && /413/.test(pf1e3.message) && !!f3 && f3.count === 2 && f3.retryAtMs > Date.now() + 29 * 60 * 1000 && f3.retryAtMs <= Date.now() + 31 * 60 * 1000,
        JSON.stringify(f3)
      )
      await services.sync._internals.ageFailures(pf1dir, 31 * 60 * 1000)
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-fail413'), { force: true }).catch(() => {})
    }
    const pf1s4 = await syncP(PF1_LOCAL, '/pf1')
    check(
      'PF1 round 4 uploads after fault removal and backoff expiry',
      pf1s4.uploaded === 1 && pf1s4.errors.length === 0 && (await fsp.readFile(path.join(ROOT, 'pf1', 'bad.toolarge.txt'), 'utf-8')) === 'pf1-too-large',
      JSON.stringify(pf1s4)
    )
    // PF3：传输成功清除失败记录（failures 清空）
    const pf1f4 = await services.sync._internals.getFailures(pf1dir)
    check('PF3 success clears failure records', Object.keys(pf1f4).length === 0, JSON.stringify(pf1f4))
    const pf1s5 = await syncP(PF1_LOCAL, '/pf1')
    check('PF1 follow-up round is a no-op', isNoop(pf1s5), JSON.stringify(pf1s5))
    await fsp.rm(PF1_LOCAL, { recursive: true, force: true }).catch(() => {})
  })

  // PF2（423 瞬时失败当轮重试）：每个 PUT 路径第一次返回 423（无 Retry-After）之后放行 ——
  // 一轮内全部上传成功（errors=0），证明瞬时失败不使轮次失败、重试后当轮收敛；
  // 且瞬时失败不写入退避表（与永久失败的关键区别）

  await section('PF2：423 瞬时失败当轮重试', async () => {
    await freshStore('pf2')
    const PF2_LOCAL = await tmpLocal('pf2')
    await fsp.writeFile(path.join(PF2_LOCAL, 'a.txt'), 'pf2-a')
    await fsp.writeFile(path.join(PF2_LOCAL, 'b.txt'), 'pf2-b')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-fail423'), 'x')
    try {
      const pf2s = await syncP(PF2_LOCAL, '/pf2')
      check(
        'PF2 transient 423 converges within the round (uploaded=2, errors=0)',
        pf2s.uploaded === 2 && pf2s.errors.length === 0 && (await fsp.readFile(path.join(ROOT, 'pf2', 'a.txt'), 'utf-8')) === 'pf2-a',
        JSON.stringify(pf2s)
      )
      const pf2f = await services.sync._internals.getFailures({ id: 'pf2', localPath: PF2_LOCAL, remotePath: '/pf2', mode: 'two-way' })
      check('PF2 transient failures never enter the backoff table', Object.keys(pf2f).length === 0, JSON.stringify(pf2f))
      const pf2s2 = await syncP(PF2_LOCAL, '/pf2')
      check('PF2 follow-up round is a no-op', isNoop(pf2s2), JSON.stringify(pf2s2))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-fail423'), { force: true }).catch(() => {})
    }
    await fsp.rm(PF2_LOCAL, { recursive: true, force: true }).catch(() => {})
  })

  // ============================================================
  // BV 系列：上传后校验改为按目录批量（两段提交）
  // 依赖 dav-server 的 .wdsync-test-reqlog（逐请求日志）与 .wdsync-test-vanish
  //（PROPFIND 列表剔除条目）两个标记。
  // ============================================================
  // BV1（P1 档）：一个目录的上传全部完成后按父目录批量校验 —— 不再逐文件 PROPFIND。
  // 场景：根 3 文件 + sub/ 2 文件 + sub2/ 1 文件。reqlog 断言：
  //   核心 —— 对 6 个文件路径的 PROPFIND 为 0（批量校验，不逐文件 Depth:0 校验）；
  //   辅助 —— 首个 PUT 之后的父目录 PROPFIND 恰为 3 个目录各 1 次（扫描与能力探测的
  //   列举都发生在上传开始之前，上传开始后只剩批量校验的 3 次）。

  await section('BV1：批量上传校验（P1 档）', async () => {
    await freshStore('bv1')
    const BV1_LOCAL = await tmpLocal('bv1')
    const bv1files = ['a.txt', 'b.txt', 'c.txt', 'sub/d.txt', 'sub/e.txt', 'sub2/f.txt']
    for (const n of bv1files) {
      await fsp.mkdir(path.dirname(path.join(BV1_LOCAL, n)), { recursive: true })
      await fsp.writeFile(path.join(BV1_LOCAL, n), `bv1-${n}`)
    }
    const bv1dir = { id: 'p', localPath: BV1_LOCAL, remotePath: '/bv1', mode: 'two-way' }
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      const bv1s1 = await syncP(BV1_LOCAL, '/bv1')
      check('BV1 first round uploads 6 files', bv1s1.uploaded === 6 && bv1s1.errors.length === 0, JSON.stringify(bv1s1))
      const lines = await readReqlog()
      const filePaths = bv1files.map((n) => `/dav/bv1/${n}`)
      check(
        'BV1 zero PROPFIND to any uploaded file path (per-file verify removed)',
        filePaths.every((p) => countReq(lines, 'PROPFIND', p) === 0),
        filePaths.map((p) => `${p}:${countReq(lines, 'PROPFIND', p)}`).join(' ')
      )
      // 租约锁（6.4）默认开启：锁 PUT（/dav/bv1/.webdav-sync.lock）不属于用户上传，
      // 「上传开始」的分界取首个用户文件 PUT。能力探测与扫描并发（冷缓存轮
      // 在本轮内探测），探测自身的 PUT（.wdsync-probe-* 路径）同样不是用户上传，
      // 一并排除在分界之外（探测对 /dav/bv1 的两次列举都在探测 PUT 之前，不会落入
      // afterPut 观察窗）
      const firstPut = lines.findIndex((l) => l.startsWith('PUT /dav/bv1/') && !l.includes('.webdav-sync.lock') && !l.includes('.wdsync-probe-'))
      const afterPut = lines.slice(firstPut + 1)
      const dirPaths = ['/dav/bv1', '/dav/bv1/sub', '/dav/bv1/sub2']
      check(
        'BV1 exactly one batch PROPFIND per parent dir after uploads start',
        firstPut >= 0 && dirPaths.every((p) => countReq(afterPut, 'PROPFIND', p) === 1),
        dirPaths.map((p) => `${p}:${countReq(afterPut, 'PROPFIND', p)}`).join(' ')
      )
      const bv1size = await services.sync._internals.baselineSize(bv1dir)
      const retagsOk = []
      for (const n of bv1files) {
        const e = await services.sync._internals.baselineEntry(bv1dir, n)
        retagsOk.push(e != null && e.lhash != null && typeof e.rsize === 'number' && e.rsize > 0 && e.retag !== '')
      }
      check('BV1 baseline holds 6 entries with remote fingerprint (retag non-empty)', bv1size === 6 && retagsOk.every(Boolean), `size=${bv1size}`)
      const bv1s2 = await syncP(BV1_LOCAL, '/bv1')
      check('BV1 second round is a no-op', isNoop(bv1s2), JSON.stringify(bv1s2))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
    }
    await fsp.rm(BV1_LOCAL, { recursive: true, force: true })
  })

  // BV2（P2 档，B 档覆盖）：新上传与覆盖上传均无「上传后」的文件 PROPFIND。B 档复查是
  // 上传**前**的 Depth:0 档位保护（允许存在）：以每个文件最后一次 PUT 为界，其后不得
  // 再有针对该文件的 PROPFIND；且整个两轮里每文件恰 1 次文件 PROPFIND（首轮新上传 0 +
  // 次轮覆盖复查 1；覆盖轮仅复查、无逐文件校验）。

  await section('BV2：批量校验 B 档覆盖（P2 档）', async () => {
    await setProfile('p2')
    await freshStore('bv2')
    const BV2_LOCAL = await tmpLocal('bv2')
    await fsp.writeFile(path.join(BV2_LOCAL, 'x.txt'), 'bv2-x-v1')
    await fsp.writeFile(path.join(BV2_LOCAL, 'y.txt'), 'bv2-y-v1')
    const bv2dir = { id: 'p', localPath: BV2_LOCAL, remotePath: '/bv2', mode: 'two-way' }
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      const bv2s1 = await syncP(BV2_LOCAL, '/bv2')
      check('BV2 (p2/B tier) first upload succeeds', bv2s1.uploaded === 2 && bv2s1.errors.length === 0 && bv2s1.tier === 'B', JSON.stringify(bv2s1))
      // 覆盖上传：B 档复查在 PUT 前每文件发一次 Depth:0 PROPFIND（档位保护，允许）
      await fsp.writeFile(path.join(BV2_LOCAL, 'x.txt'), 'bv2-x-v2-longer')
      await fsp.writeFile(path.join(BV2_LOCAL, 'y.txt'), 'bv2-y-v2-longer')
      const bv2s2 = await syncP(BV2_LOCAL, '/bv2')
      check('BV2 overwrite round succeeds under B tier', bv2s2.uploaded === 2 && bv2s2.errors.length === 0, JSON.stringify(bv2s2))
      const lines = await readReqlog()
      let noPost = true
      const perFileCounts = []
      for (const name of ['x.txt', 'y.txt']) {
        const p = `/dav/bv2/${name}`
        const lastPut = lastReqLine(lines, 'PUT', p)
        const propLines = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.startsWith('PROPFIND ') && l.slice('PROPFIND '.length).replace(/\/+$/, '') === p.replace(/\/+$/, ''))
        if (lastPut < 0 || !propLines.every(({ i }) => i < lastPut)) noPost = false
        perFileCounts.push(propLines.length)
      }
      check('BV2 no PROPFIND to any file after its last PUT (post-upload verify removed)', noPost, JSON.stringify(lines.filter((l) => l.startsWith('PROPFIND /dav/bv2/'))))
      check('BV2 exactly one pre-PUT recheck per overwritten file (guard kept, verify gone)', perFileCounts.every((n) => n === 1), perFileCounts.join(','))
      const xe = await services.sync._internals.baselineEntry(bv2dir, 'x.txt')
      check(
        'BV2 baseline updated with correct size (noetag profile: retag empty)',
        xe != null && xe.lhash != null && xe.rsize === 'bv2-x-v2-longer'.length && (xe.retag || '') === '',
        JSON.stringify(xe)
      )
      const bv2s3 = await syncP(BV2_LOCAL, '/bv2')
      check('BV2 follow-up round is a no-op', isNoop(bv2s3), JSON.stringify(bv2s3))
    } finally {
      await setProfile(null)
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
    }
    await fsp.rm(BV2_LOCAL, { recursive: true, force: true })
  })

  // BV3（崩溃窗口）：PUT 成功 → 批量提交之间崩溃（afterTransferOp 注入）—— 轮次失败、
  // 远端已上传、基线未写、崩溃轮没有对该文件的上传后 PROPFIND（批量阶段被跳过）；
  // 下一轮 WAL 采纳收敛（R1 已覆盖采纳语义，此处补 reqlog 侧断言与最小闭环）。

  await section('BV3：批量提交窗口崩溃', async () => {
    await freshStore('bv3')
    const BV3_LOCAL = await tmpLocal('bv3')
    const bv3dir = { id: 'p', localPath: BV3_LOCAL, remotePath: '/bv3', mode: 'two-way' }
    await fsp.writeFile(path.join(BV3_LOCAL, 'a.txt'), 'bv3-a-v1')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      let bv3err = null
      try {
        await syncP(BV3_LOCAL, '/bv3', undefined, {
          afterTransferOp: async (p) => {
            if (p.rel === 'a.txt' && p.act === 'upload') throw new Error('SIMULATED-CRASH-BV3')
          },
        })
      } catch (e) {
        bv3err = e
      }
      check('BV3 crash in batch window fails the round', !!bv3err && /SIMULATED-CRASH-BV3/.test(bv3err.message), bv3err && bv3err.message)
      check('BV3 crash residue: leaked lease renew timer swept before first 60s tick', sweepCrashResidue() === 1)
      check(
        'BV3 remote upload happened, baseline not yet written',
        (await fsp.readFile(path.join(ROOT, 'bv3', 'a.txt'), 'utf-8')) === 'bv3-a-v1' && (await services.sync._internals.baselineEntry(bv3dir, 'a.txt')) === null
      )
      const lines = await readReqlog()
      const lastPut = lastReqLine(lines, 'PUT', '/dav/bv3/a.txt')
      const postProps = lines.filter((l, i) => i > lastPut && l.startsWith('PROPFIND /dav/bv3/a.txt'))
      check('BV3 crash round issues no post-upload PROPFIND to the file (batch skipped)', lastPut >= 0 && postProps.length === 0, postProps.join(';'))
      const bv3b = await syncP(BV3_LOCAL, '/bv3')
      const bv3e = await services.sync._internals.baselineEntry(bv3dir, 'a.txt')
      check(
        'BV3 next round adopts via WAL (no re-upload, no conflict)',
        bv3b.uploaded === 0 && bv3b.downloaded === 0 && bv3b.conflicts === 0 && bv3e != null && bv3e.lhash != null,
        JSON.stringify(bv3b)
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
    }
    await fsp.rm(BV3_LOCAL, { recursive: true, force: true })
  })

  // BV4（批量校验失败路径）：.wdsync-test-vanish —— PUT 成功但目录列表看不到该文件
  //（PROPFIND 到含 vanish 的路径时剔除 gone.vanish.txt 条目）：同目录 ok.txt 正常提交，
  // vanish 文件报「上传批量校验失败」、无基线、轮次 error 且不记退避表；去掉标记后
  // 下一轮收敛（intent 已 abort → 无基线 + 双侧同内容 → adopt），再一轮 no-op。

  await section('BV4：批量校验失败路径', async () => {
    await freshStore('bv4')
    const BV4_LOCAL = await tmpLocal('bv4')
    const bv4dir = { id: 'p', localPath: BV4_LOCAL, remotePath: '/bv4vanish', mode: 'two-way' }
    await fsp.writeFile(path.join(BV4_LOCAL, 'ok.txt'), 'bv4-ok')
    await fsp.writeFile(path.join(BV4_LOCAL, 'gone.vanish.txt'), 'bv4-gone')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-vanish'), 'x')
    try {
      let bv4err = null
      try {
        await syncP(BV4_LOCAL, '/bv4vanish')
      } catch (e) {
        bv4err = e
      }
      check(
        'BV4 vanish file fails batch verify while round errors',
        !!bv4err && /「gone\.vanish\.txt」上传后核对失败，下次同步会重试/.test(bv4err.message),
        bv4err && bv4err.message
      )
      const okEntry = await services.sync._internals.baselineEntry(bv4dir, 'ok.txt')
      check('BV4 sibling ok.txt committed to baseline (retag non-empty)', okEntry != null && okEntry.lhash != null && okEntry.retag !== '', JSON.stringify(okEntry))
      check(
        'BV4 vanish file has no baseline entry though remote holds the bytes',
        (await services.sync._internals.baselineEntry(bv4dir, 'gone.vanish.txt')) === null &&
          (await fsp.readFile(path.join(ROOT, 'bv4vanish', 'gone.vanish.txt'), 'utf-8')) === 'bv4-gone'
      )
      const bv4f = await services.sync._internals.getFailures(bv4dir)
      check('BV4 batch-verify failure never enters the backoff table', Object.keys(bv4f).length === 0, JSON.stringify(bv4f))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-vanish'), { force: true }).catch(() => {})
    }
    const bv4s2 = await syncP(BV4_LOCAL, '/bv4vanish')
    const goneEntry = await services.sync._internals.baselineEntry(bv4dir, 'gone.vanish.txt')
    check(
      'BV4 next round (marker removed) converges without error',
      // adopt 直采路径（mtime 命中容差）不重算 lhash，故只断言条目存在且远端 size 正确
      bv4s2.errors.length === 0 && bv4s2.conflicts === 0 && bv4s2.downloaded === 0 && bv4s2.adopted === 1 && goneEntry != null && goneEntry.rsize === 'bv4-gone'.length,
      JSON.stringify(bv4s2)
    )
    const bv4s3 = await syncP(BV4_LOCAL, '/bv4vanish')
    check('BV4 follow-up round is a no-op', isNoop(bv4s3), JSON.stringify(bv4s3))
    await fsp.rm(BV4_LOCAL, { recursive: true, force: true })
  })

  // ============================================================
  // L 系列：目录级租约锁 + 同目录单轮互斥
  // 依赖 dav-server 的 .wdsync-test-locksteal（锁 PUT 落盘后改写为他人 deviceId）
  // 与 .wdsync-test-delefail（DELETE 一律 500）两个标记；GET 应答新增 Last-Modified
  // 头供「服务器时钟过期判定」。P1 档为主（L8/L11/L12 用 P2 档做 B 档覆盖）；
  // L1–L9 不用 reqlog（锁 GET/PUT/DELETE 会进日志，避免与 BV 计数互相污染），
  // L10+（锁时序断言）起在独立用例内启用 reqlog 并用完即清（含日志文件）。
  // ============================================================
  await setProfile('p1') // L 系列公共前置（独立于各节，跳过个别节时仍需生效）
  // L1 正常释放：同步一轮（含上传）→ 轮中远端有锁（证明确实持有）→ 结束后无锁。
  // 锁后置：plan 阶段在拿锁之前（锁不存在），持锁证明只能在 transfer 阶段采集

  await section('L1：租约锁正常释放', async () => {
    await freshStore('l1')
    const L1_LOCAL = await tmpLocal('l1')
    const l1lock = path.join(ROOT, 'l1', '.webdav-sync.lock')
    await fsp.writeFile(path.join(L1_LOCAL, 'a.txt'), 'l1-a')
    await fsp.writeFile(path.join(L1_LOCAL, 'b.txt'), 'l1-b')
    let l1SawLock = false
    let l1PlanNoLock = true
    const l1s = await syncP(L1_LOCAL, '/l1', undefined, {
      onProgress: (p) => {
        if (p.phase === 'plan' && fs.existsSync(l1lock)) l1PlanNoLock = false
        if (!l1SawLock && p.phase === 'transfer') l1SawLock = fs.existsSync(l1lock)
      },
    })
    check(
      'L1 normal round uploads with lease held during transfer (no yielded / concurrent)',
      l1s.uploaded === 2 && l1s.errors.length === 0 && !l1s.yielded && !l1s.concurrent && l1SawLock,
      `${JSON.stringify(l1s)} sawLock=${l1SawLock}`
    )
    check('L1 lease absent during plan phase (lock deferred until after planning)', l1PlanNoLock)
    check('L1 lease lock released after round (no lock file on remote root)', !fs.existsSync(l1lock))
    const l1s2 = await syncP(L1_LOCAL, '/l1')
    check('L1 follow-up no-op round stays lock-free and is a no-op', isNoop(l1s2) && !fs.existsSync(l1lock), JSON.stringify(l1s2))
    await fsp.rm(L1_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l1'), { recursive: true, force: true })
  })

  // L2 让出：预置他人新锁（deviceId 'device-other'、当前 mtime）→ 本轮扫描规划**之后**
  // 让出（锁后置：planned 字段证明确有规划、tier 证明扫描后阶段已运行）、零传输、
  // 远端原样、锁仍在；删锁后下一轮正常

  await section('L2：他人持锁让出', async () => {
    await freshStore('l2')
    const L2_LOCAL = await tmpLocal('l2')
    const l2lock = path.join(ROOT, 'l2', '.webdav-sync.lock')
    await fsp.writeFile(path.join(L2_LOCAL, 'a.txt'), 'l2-a')
    await fsp.mkdir(path.join(ROOT, 'l2'), { recursive: true })
    await fsp.writeFile(l2lock, JSON.stringify({ v: 1, deviceId: 'device-other', startedAt: new Date().toISOString(), ttlMs: 180000 }))
    const l2s = await syncP(L2_LOCAL, '/l2')
    check(
      'L2 yields to another device holding a fresh lease (zero transfers, not an error)',
      l2s.yielded === true && l2s.uploaded === 0 && l2s.downloaded === 0 && l2s.totalFiles === 0 && l2s.warnings.some((w) => /另一台设备正在同步/.test(w)),
      JSON.stringify(l2s)
    )
    check(
      'L2 yield happens after planning (planned set; tier proves post-scan phases ran)',
      l2s.planned === 1 && l2s.tier === 'A',
      `planned=${l2s.planned} tier=${l2s.tier}`
    )
    check(
      'L2 yielded round leaves remote content untouched (lock intact, nothing uploaded)',
      (await fsp.readFile(l2lock, 'utf-8')).includes('device-other') && !fs.existsSync(path.join(ROOT, 'l2', 'a.txt'))
    )
    await fsp.rm(l2lock, { force: true })
    const l2s2 = await syncP(L2_LOCAL, '/l2')
    check(
      'L2 next round syncs normally after lock removal (and releases)',
      l2s2.uploaded === 1 && l2s2.errors.length === 0 && !l2s2.yielded && !fs.existsSync(l2lock),
      JSON.stringify(l2s2)
    )
    await fsp.rm(L2_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l2'), { recursive: true, force: true })
  })

  // L3 过期接管：他人锁但 mtime 已 10 分钟前（服务器时钟年龄 ≥ ttl）→ 接管并正常同步 → 结束释放

  await section('L3：过期锁接管', async () => {
    await freshStore('l3')
    const L3_LOCAL = await tmpLocal('l3')
    const l3lock = path.join(ROOT, 'l3', '.webdav-sync.lock')
    await fsp.writeFile(path.join(L3_LOCAL, 'a.txt'), 'l3-a')
    await fsp.mkdir(path.join(ROOT, 'l3'), { recursive: true })
    await fsp.writeFile(l3lock, JSON.stringify({ v: 1, deviceId: 'device-other', startedAt: new Date().toISOString(), ttlMs: 180000 }))
    const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000)
    await fsp.utimes(l3lock, tenMinAgo, tenMinAgo)
    const l3s = await syncP(L3_LOCAL, '/l3')
    check(
      'L3 expired lease (server-clock age >= ttl) is taken over and synced',
      l3s.uploaded === 1 && !l3s.yielded && l3s.errors.length === 0,
      JSON.stringify(l3s)
    )
    check('L3 taken-over lease is released at round end', !fs.existsSync(l3lock))
    await fsp.rm(L3_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l3'), { recursive: true, force: true })
  })

  // L4 取消释放：shouldAbort 在首个 transfer 进度（传输开始事件）后置位 → 该事件先于
  // worker 池首个完成（引擎在池启动前外发传输开始的 0 计数事件）→ 本轮零上传即以中止
  // 收场（error 且 message 含「中止」）→ 锁已释放、基线无残留，下一轮整批补传 ——
  // 取消路径同样释放锁且不破坏基线一致性（传输中途带部分进度的取消由 CA1–CA4 覆盖）

  await section('L4：取消路径释放锁', async () => {
    await freshStore('l4')
    const L4_LOCAL = await tmpLocal('l4')
    for (let i = 0; i < 8; i++) await fsp.writeFile(path.join(L4_LOCAL, `f${i}.txt`), `l4-content-${i}`)
    let l4Abort = false
    let l4err = null
    try {
      await syncP(L4_LOCAL, '/l4', undefined, {
        shouldAbort: () => l4Abort,
        onProgress: (p) => {
          if (p.phase === 'transfer') l4Abort = true
        },
      })
    } catch (e) {
      l4err = e
    }
    check('L4 abort at transfer start fails the round with abort message', !!l4err && /已取消同步/.test(l4err.message), l4err && l4err.message)
    check('L4 lease released on abort (no lock file left)', !fs.existsSync(path.join(ROOT, 'l4', '.webdav-sync.lock')))
    const l4done = l4err && l4err.summary ? l4err.summary.uploaded : 0
    const l4b = await syncP(L4_LOCAL, '/l4')
    check(
      'L4 next round uploads the whole batch (cancel landed before any transfer)',
      l4b.errors.length === 0 && l4done === 0 && l4b.uploaded === 8 - l4done && !fs.existsSync(path.join(ROOT, 'l4', '.webdav-sync.lock')),
      `done=${l4done} ${JSON.stringify(l4b)}`
    )
    const l4c = await syncP(L4_LOCAL, '/l4')
    check('L4 follow-up round is a no-op after remainder round', isNoop(l4c), JSON.stringify(l4c))
    await fsp.rm(L4_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l4'), { recursive: true, force: true })
  })

  // L5 熔断释放：首个 transfer 进度后打开 .wdsync-test-err503（PUT 全 503，DELETE 不受
  // 影响）→ 锁已获取、轮内熔断终止 → 释放 DELETE 不被熔断拦截：远端无锁文件、无左锁标记

  // [慢组登记原因] 503 风暴熔断重试真实等待；熔断语义仍由 W7、锁释放路径仍由 L1/L2/L4/L6/L8 覆盖
  await slowSection('L5：熔断路径释放锁', '503 风暴熔断重试真实等待；熔断语义仍由 W7、锁释放路径仍由 L1/L2/L4/L6/L8 覆盖', async () => {
    await freshStore('l5')
    const L5_LOCAL = await tmpLocal('l5')
    for (let i = 0; i < 10; i++) await fsp.writeFile(path.join(L5_LOCAL, `f${i}.txt`), 'l5-x')
    const l5dir = { id: 'p', localPath: L5_LOCAL, remotePath: '/l5', mode: 'two-way' }
    const err503Flag = path.join(ROOT, '.wdsync-test-err503')
    let l5err = null
    try {
      await syncP(L5_LOCAL, '/l5', undefined, {
        onProgress: (p) => {
          if (p.phase === 'transfer' && !fs.existsSync(err503Flag)) fs.writeFileSync(err503Flag, 'x')
        },
      })
    } catch (e) {
      l5err = e
    } finally {
      await fsp.rm(err503Flag, { force: true }).catch(() => {})
    }
    const l5msgs = l5err && l5err.errors ? l5err.errors.join(';') : String(l5err && l5err.message)
    check('L5 round terminated by breaker under 503 storm (errors mention breaker)', !!l5err && /连续多次出错/.test(l5msgs), l5msgs)
    check(
      'L5 lease released despite open breaker (DELETE bypasses circuit: no lock file, no leftover mark)',
      !fs.existsSync(path.join(ROOT, 'l5', '.webdav-sync.lock')) && !(await services.sync._internals.getDirMeta(l5dir)).lockLeftover
    )
    await fsp.rm(L5_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l5'), { recursive: true, force: true })
  })

  // L6 释放失败 → 左锁 → 下轮清理：.wdsync-test-delefail + 纯上传目录 → 轮次成功（上传
  // 照常）但锁未删（warning「释放失败」+ meta.lockLeftover 已记）；去标记 → 下一轮开头
  // 清掉左锁（远端锁文件消失、标记清除）→ 正常同步并释放

  await section('L6：释放失败左锁清理', async () => {
    await freshStore('l6')
    const L6_LOCAL = await tmpLocal('l6')
    await fsp.writeFile(path.join(L6_LOCAL, 'a.txt'), 'l6-a')
    await fsp.writeFile(path.join(L6_LOCAL, 'b.txt'), 'l6-b')
    const l6dir = { id: 'p', localPath: L6_LOCAL, remotePath: '/l6', mode: 'two-way' }
    const l6lock = path.join(ROOT, 'l6', '.webdav-sync.lock')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-delefail'), 'x')
    let l6s1 = null
    try {
      l6s1 = await syncP(L6_LOCAL, '/l6')
      check(
        'L6 round succeeds (uploads intact); lock release failure is log-only now',
        l6s1.uploaded === 2 && l6s1.errors.length === 0 && !l6s1.warnings.some((w) => /租约锁/.test(w)),
        JSON.stringify(l6s1.warnings)
      )
      check('L6 lock file left on remote after failed release', fs.existsSync(l6lock))
      const l6meta1 = await services.sync._internals.getDirMeta(l6dir)
      check('L6 leftover-lock mark recorded in dir meta', !!l6meta1.lockLeftover && typeof l6meta1.lockLeftover.at === 'number', JSON.stringify(l6meta1.lockLeftover))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-delefail'), { force: true }).catch(() => {})
    }
    const l6s2 = await syncP(L6_LOCAL, '/l6')
    const l6meta2 = await services.sync._internals.getDirMeta(l6dir)
    check(
      'L6 next round cleans leftover lock at start (mark cleared, remote lock gone) and syncs fine',
      l6s2.errors.length === 0 && !l6meta2.lockLeftover && !fs.existsSync(l6lock),
      JSON.stringify(l6s2)
    )
    check('L6 next round is otherwise a no-op (baselines intact)', isNoop(l6s2), JSON.stringify(l6s2))
    await fsp.rm(L6_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l6'), { recursive: true, force: true })
  })

  // L7 写回竞争失败：.wdsync-test-locksteal —— 锁 PUT 落盘后被服务器改写为 peer-device-x，
  // 引擎静置回读到别人的 deviceId → 让出本轮，远端用户文件未被触碰

  await section('L7：写回竞争失败让出', async () => {
    await freshStore('l7')
    const L7_LOCAL = await tmpLocal('l7')
    await fsp.writeFile(path.join(L7_LOCAL, 'a.txt'), 'l7-a')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-locksteal'), 'x')
    try {
      const l7s = await syncP(L7_LOCAL, '/l7')
      check(
        'L7 write-back race lost: round yields after reading peer deviceId',
        l7s.yielded === true && l7s.uploaded === 0 && l7s.totalFiles === 0 && l7s.planned === 1 && l7s.warnings.some((w) => /另一台设备正在同步/.test(w)),
        JSON.stringify(l7s)
      )
      check('L7 user files untouched on remote during yielded round', !fs.existsSync(path.join(ROOT, 'l7', 'a.txt')))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-locksteal'), { force: true }).catch(() => {})
    }
    await fsp.rm(L7_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l7'), { recursive: true, force: true })
  })

  // L8 P2 档（B 档覆盖）：L1 正常释放 + L2 让出在 p2 下各跑一遍（无 etag / 秒级 mtime /
  // 静默忽略条件头不影响锁状态机 —— 锁判定只依赖 GET 内容 + date/last-modified 头）

  await section('L8：锁状态机 B 档覆盖（P2）', async () => {
    await setProfile('p2')
    try {
      await freshStore('l8')
      const L8A_LOCAL = await tmpLocal('l8')
      await fsp.writeFile(path.join(L8A_LOCAL, 'a.txt'), 'l8-a')
      const l8s = await syncP(L8A_LOCAL, '/l8')
      check(
        'L8 (p2/B tier) normal round uploads and releases lease',
        l8s.uploaded === 1 && l8s.tier === 'B' && !l8s.yielded && !fs.existsSync(path.join(ROOT, 'l8', '.webdav-sync.lock')),
        JSON.stringify(l8s)
      )
      const L8B_LOCAL = await tmpLocal('l8b')
      const l8lock = path.join(ROOT, 'l8b', '.webdav-sync.lock')
      await fsp.writeFile(path.join(L8B_LOCAL, 'a.txt'), 'l8b-a')
      await fsp.mkdir(path.join(ROOT, 'l8b'), { recursive: true })
      await fsp.writeFile(l8lock, JSON.stringify({ v: 1, deviceId: 'device-other', startedAt: new Date().toISOString(), ttlMs: 180000 }))
      const l8s2 = await syncP(L8B_LOCAL, '/l8b')
      check(
        'L8 (p2/B tier) yields to another device holding a fresh lease',
        l8s2.yielded === true && l8s2.uploaded === 0 && l8s2.totalFiles === 0 && l8s2.planned === 1 && (await fsp.readFile(l8lock, 'utf-8')).includes('device-other'),
        JSON.stringify(l8s2)
      )
      await fsp.rm(L8A_LOCAL, { recursive: true, force: true })
      await fsp.rm(L8B_LOCAL, { recursive: true, force: true })
      await fsp.rm(path.join(ROOT, 'l8'), { recursive: true, force: true })
      await fsp.rm(path.join(ROOT, 'l8b'), { recursive: true, force: true })
    } finally {
      await setProfile(null)
    }
  })

  // L9 并发互斥：同一目录并发发起两个 syncDirectory（Promise.all，后到的立即
  // 返回）→ 第二个 concurrent === true 且零传输（无任何进度事件）；第一个正常完成并释放锁

  await section('L9：同目录单轮互斥', async () => {
    await freshStore('l9')
    const L9_LOCAL = await tmpLocal('l9')
    for (let i = 0; i < 3; i++) await fsp.writeFile(path.join(L9_LOCAL, `f${i}.txt`), `l9-f${i}`)
    let progressA = 0
    let progressB = 0
    const [r1, r2] = await Promise.all([
      syncP(L9_LOCAL, '/l9', undefined, { onProgress: () => { progressA++ } }),
      syncP(L9_LOCAL, '/l9', undefined, { onProgress: () => { progressB++ } }),
    ])
    check(
      'L9 second concurrent round returns immediately with concurrent flag, zero counts, no progress',
      r2.concurrent === true && r2.uploaded === 0 && r2.downloaded === 0 && progressB === 0 && r2.warnings.some((w) => /正在同步中/.test(w)),
      JSON.stringify(r2)
    )
    check(
      'L9 first round completes normally while the second skipped (lock released)',
      r1.uploaded === 3 && r1.errors.length === 0 && !r1.concurrent && progressA > 0 && !fs.existsSync(path.join(ROOT, 'l9', '.webdav-sync.lock')),
      JSON.stringify(r1)
    )
    await fsp.rm(L9_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l9'), { recursive: true, force: true })
  })

  // ============================================================
  // L10–L14：锁后置 + 按需获取 + B 档新上传写前查重的验收用例。
  // 用到 dav-server 的 .wdsync-test-reqlog（逐请求日志）与 .wdsync-test-dedupfail
  //（路径含 dedupfail 的 Depth:1 列举从第 2 次起注入状态码）两个标记，均用完即清。
  // ============================================================
  // L10（P1 / A 档）：空轮零锁请求（reqlog 全程无锁 GET/PUT/DELETE）；写轮锁 4 请求齐
  //（GET×2 + PUT + DELETE）、首个锁请求在扫描列举之后、首个用户 PUT 之前，且传输期间锁存在

  await section('L10：锁按需获取（A 档）', async () => {
    await freshStore('l10')
    const L10_LOCAL = await tmpLocal('l10')
    const l10lockFile = path.join(ROOT, 'l10', '.webdav-sync.lock')
    const l10lockPath = '/dav/l10/.webdav-sync.lock'
    await fsp.writeFile(path.join(L10_LOCAL, 'a.txt'), 'l10-a')
    const l10r1 = await syncP(L10_LOCAL, '/l10') // 首轮上传：写轮拿锁 + 能力缓存落定
    check('L10 write round uploads (lock taken then released)', l10r1.uploaded === 1 && l10r1.errors.length === 0 && !fs.existsSync(l10lockFile), JSON.stringify(l10r1))
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      // 空轮（无变化、能力缓存命中）：全程不得出现任何锁请求
      const l10r2 = await syncP(L10_LOCAL, '/l10')
      const emptyLines = await readReqlog()
      check(
        'L10 empty round issues zero lease-lock requests',
        isNoop(l10r2) && emptyLines.every((l) => !l.includes('.webdav-sync.lock')),
        `${emptyLines.length} reqs, lock lines: ${emptyLines.filter((l) => l.includes('.webdav-sync.lock')).length}`
      )
      // 写轮：本地新增 b.txt（B 档视角下的新上传；A 档由 If-None-Match:* 写时守卫保护）
      await fsp.writeFile(path.join(L10_LOCAL, 'b.txt'), 'l10-b')
      let sawLockInTransfer = false
      const l10r3 = await syncP(L10_LOCAL, '/l10', undefined, {
        onProgress: (p) => {
          if (!sawLockInTransfer && p.phase === 'transfer') sawLockInTransfer = fs.existsSync(l10lockFile)
        },
      })
      const lines3 = (await readReqlog()).slice(emptyLines.length)
      check(
        'L10 write round lock requests complete (GET x2 + PUT + DELETE)',
        l10r3.uploaded === 1 && countReq(lines3, 'GET', l10lockPath) === 2 && countReq(lines3, 'PUT', l10lockPath) === 1 && countReq(lines3, 'DELETE', l10lockPath) === 1,
        lines3.join(' | ')
      )
      // 同步根列举共 3 次（轮首建根探测、扫描、上传后批量校验），A 档无写前查重；
      // 首个锁请求须晚于第 2 次列举（扫描完成），首个用户 PUT 须晚于首个锁请求
      const listingIdxs = lines3.map((l, i) => (l === 'PROPFIND /dav/l10/' ? i : -1)).filter((i) => i >= 0)
      const firstLock = lines3.findIndex((l) => l.includes('.webdav-sync.lock'))
      const firstUserPut = lines3.findIndex((l) => l.startsWith('PUT /dav/l10/') && !l.includes('.webdav-sync.lock'))
      check(
        'L10 lock timing: after scan listing, before first user PUT',
        listingIdxs.length === 3 && firstLock > listingIdxs[1] && firstUserPut > firstLock,
        JSON.stringify({ listings: listingIdxs, firstLock, firstUserPut })
      )
      check('L10 lease held during transfer phase', sawLockInTransfer)
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
    }
    await fsp.rm(L10_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l10'), { recursive: true, force: true })
  })

  // L11（P2 / B 档）：空轮零锁 + 写轮锁时序同 L10，另断言 B 档新上传的写前查重
  // PROPFIND 落在「拿锁之后（含 1.5s 静置回读）、首个用户 PUT 之前」，传输期间锁存在

  await section('L11：锁按需获取（B 档）', async () => {
    await setProfile('p2')
    try {
      await freshStore('l11')
      const L11_LOCAL = await tmpLocal('l11')
      const l11lockFile = path.join(ROOT, 'l11', '.webdav-sync.lock')
      const l11lockPath = '/dav/l11/.webdav-sync.lock'
      await fsp.writeFile(path.join(L11_LOCAL, 'a.txt'), 'l11-a')
      const l11r1 = await syncP(L11_LOCAL, '/l11')
      check('L11 (B tier) write round uploads', l11r1.uploaded === 1 && l11r1.errors.length === 0 && l11r1.tier === 'B', JSON.stringify(l11r1))
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
      try {
        const l11r2 = await syncP(L11_LOCAL, '/l11')
        const emptyLines = await readReqlog()
        check('L11 empty round issues zero lease-lock requests', isNoop(l11r2) && emptyLines.every((l) => !l.includes('.webdav-sync.lock')), `${emptyLines.length} reqs [${emptyLines.join(' | ')}]`)
        await fsp.writeFile(path.join(L11_LOCAL, 'b.txt'), 'l11-b')
        let sawLockInTransfer = false
        const l11r3 = await syncP(L11_LOCAL, '/l11', undefined, {
          onProgress: (p) => {
            if (!sawLockInTransfer && p.phase === 'transfer') sawLockInTransfer = fs.existsSync(l11lockFile)
          },
        })
        const lines3 = (await readReqlog()).slice(emptyLines.length)
        check(
          'L11 write round lock requests complete (GET x2 + PUT + DELETE)',
          l11r3.uploaded === 1 && countReq(lines3, 'GET', l11lockPath) === 2 && countReq(lines3, 'PUT', l11lockPath) === 1 && countReq(lines3, 'DELETE', l11lockPath) === 1,
          lines3.join(' | ')
        )
        // 同步根列举共 4 次（建根探测、扫描、写前查重、上传后批量校验）；顺序断言：
        // 锁在扫描（第 2 次列举）之后 → 查重（第 3 次列举）在锁获取完成（回读 GET，
        // 第 3 个锁请求）之后 → 首个用户 PUT 在查重之后（轮末 DELETE 锁在一切之后，
        // 不参与本断言）
        const listingIdxs = lines3.map((l, i) => (l === 'PROPFIND /dav/l11/' ? i : -1)).filter((i) => i >= 0)
        const lockIdxs = lines3.map((l, i) => (l.includes('.webdav-sync.lock') ? i : -1)).filter((i) => i >= 0)
        const firstUserPut = lines3.findIndex((l) => l.startsWith('PUT /dav/l11/') && !l.includes('.webdav-sync.lock'))
        check(
          'L11 lock after scan; pre-write dedup listing after lock acquired, before first PUT',
          listingIdxs.length === 4 && lockIdxs[0] > listingIdxs[1] && listingIdxs[2] > lockIdxs[2] && firstUserPut > listingIdxs[2],
          JSON.stringify({ listings: listingIdxs, locks: lockIdxs, firstUserPut })
        )
        check('L11 lease held during transfer phase and released at round end', sawLockInTransfer && !fs.existsSync(l11lockFile))
      } finally {
        await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
        await fsp.rm(REQLOG, { force: true }).catch(() => {})
      }
      await fsp.rm(L11_LOCAL, { recursive: true, force: true })
      await fsp.rm(path.join(ROOT, 'l11'), { recursive: true, force: true })
    } finally {
      await setProfile('p1')
    }
  })

  // L12（P2 / B 档）：新上传写前查重的窗口守卫 —— 对端在本机扫描后、写入前新建同名
  // 文件（onProgress plan 阶段注入：扫描已结束、查重未发生）→ 本轮该文件被剔除不覆盖
  //（远端对端内容原样保留）、轮次按 REMOTE_CHANGED 同类后果报错、不进退避表；下一轮
  // 无基线双侧并存 → 冲突（策略 local）收敛。查重请求失败（dedupfail 注入 503）→
  // 该文件按瞬时失败语义跳过本轮上传（不裸传、不进退避表），故障移除后下轮正常上传。

  // [慢组登记原因] dedupfail 注入的查重重试等待 + 窗口守卫多轮；查重 404 放行由 B2B-P404 覆盖、REMOTE_CHANGED 同类后果由 PC4 覆盖
  await slowSection('L12：B 档新上传写前查重', 'dedupfail 注入的查重重试等待 + 窗口守卫多轮；查重 404 放行由 B2B-P404 覆盖、REMOTE_CHANGED 同类后果由 PC4 覆盖', async () => {
    await setProfile('p2')
    try {
      await freshStore('l12')
      const L12_LOCAL = await tmpLocal('l12')
      const l12dir = { id: 'l12', localPath: L12_LOCAL, remotePath: '/l12', mode: 'two-way' }
      const guardRemote = path.join(ROOT, 'l12', 'guard-midair.txt')
      await fsp.writeFile(path.join(L12_LOCAL, 'seed.txt'), 'l12-seed')
      const l12r1 = await syncP(L12_LOCAL, '/l12')
      check('L12 setup round uploads seed', l12r1.uploaded === 1 && l12r1.errors.length === 0, JSON.stringify(l12r1))
      // 窗口守卫命中：plan 阶段首个进度事件（扫描完成后、规划开始前）同步写远端同名文件
      await fsp.writeFile(path.join(L12_LOCAL, 'guard-midair.txt'), 'l12-local-version')
      let guardCreated = false
      let l12err = null
      try {
        await syncP(L12_LOCAL, '/l12', undefined, {
          onProgress: (p) => {
            if (p.phase === 'plan' && !guardCreated) {
              guardCreated = true
              fs.writeFileSync(guardRemote, 'PEER-CREATED-VERSION')
            }
          },
        })
      } catch (e) {
        l12err = e
      }
      check(
        'L12 peer-created file not overwritten this round (round errors, REMOTE_CHANGED-style)',
        !!l12err && /暂未上传：云端的文件刚被其他设备修改/.test(l12err.message),
        l12err && l12err.message
      )
      check(
        'L12 remote keeps peer version untouched; local version intact',
        (await fsp.readFile(guardRemote, 'utf-8')) === 'PEER-CREATED-VERSION' && (await fsp.readFile(path.join(L12_LOCAL, 'guard-midair.txt'), 'utf-8')) === 'l12-local-version'
      )
      const l12f = await services.sync._internals.getFailures(l12dir)
      check('L12 dedup skip never enters the backoff table', Object.keys(l12f).length === 0, JSON.stringify(l12f))
      const l12r3 = await syncP(L12_LOCAL, '/l12', { ...SP, conflictStrategy: 'local' })
      check(
        'L12 next round converges via conflict (no baseline, both sides exist)',
        l12r3.conflicts === 1 && l12r3.uploaded === 1 && l12r3.errors.length === 0 && (await fsp.readFile(guardRemote, 'utf-8')) === 'l12-local-version',
        JSON.stringify(l12r3)
      )
      // 查重请求失败子用例（独立目录：路径含 dedupfail 才命中注入；首轮上传让该路径的
      // 能力 / 写权限缓存落定，探测不再列目录，第 1 次 Depth:1 列举即扫描）
      const DF_LOCAL = await tmpLocal('l12df')
      const dfdir = { id: 'l12df', localPath: DF_LOCAL, remotePath: '/dedupfail-l12', mode: 'two-way' }
      await fsp.writeFile(path.join(DF_LOCAL, 'seed.txt'), 'df-seed')
      const df1 = await syncP(DF_LOCAL, '/dedupfail-l12')
      check('L12 df setup round uploads', df1.uploaded === 1 && df1.errors.length === 0, JSON.stringify(df1))
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-dedupfail'), '503')
      try {
        await fsp.writeFile(path.join(DF_LOCAL, 'new.txt'), 'df-new-content')
        let dferr = null
        try {
          await syncP(DF_LOCAL, '/dedupfail-l12')
        } catch (e) {
          dferr = e
        }
        check(
          'L12 dedup request failure skips upload without blind PUT (transient semantics)',
          !!dferr && /暂未处理：无法确认云端文件的最新状态/.test(dferr.message) && !fs.existsSync(path.join(ROOT, 'dedupfail-l12', 'new.txt')),
          dferr && dferr.message
        )
        const dff = await services.sync._internals.getFailures(dfdir)
        check(
          'L12 dedup-failure skip never enters the backoff table; local file intact',
          Object.keys(dff).length === 0 && (await fsp.readFile(path.join(DF_LOCAL, 'new.txt'), 'utf-8')) === 'df-new-content',
          JSON.stringify(dff)
        )
      } finally {
        await fsp.rm(path.join(ROOT, '.wdsync-test-dedupfail'), { force: true }).catch(() => {})
      }
      const df2 = await syncP(DF_LOCAL, '/dedupfail-l12')
      check(
        'L12 next round uploads after fault removal',
        df2.uploaded === 1 && (await fsp.readFile(path.join(ROOT, 'dedupfail-l12', 'new.txt'), 'utf-8')) === 'df-new-content',
        JSON.stringify(df2)
      )
      await fsp.rm(L12_LOCAL, { recursive: true, force: true })
      await fsp.rm(DF_LOCAL, { recursive: true, force: true })
      await fsp.rm(path.join(ROOT, 'l12'), { recursive: true, force: true })
      await fsp.rm(path.join(ROOT, 'dedupfail-l12'), { recursive: true, force: true })
    } finally {
      await setProfile('p1')
    }
  })

  // B2B-P404：B 档写前查重「远端父目录 404 ⇒ 放行整组上传」的
  // 独立验收（不依赖 B2B 节 FC5b 的 seed 轮）—— 本地新建子目录 + 文件的首轮，
  // 查重 PROPFIND 对不存在的父目录必然 404，404 = 组内必然无同名（比空列举更强的
  // 「无冲突」证据）→ 放行整组照常上传（PUT 前 MKCOL 建目录），且第二轮 no-op 收敛
  //（修复前该组每轮被「查重失败」跳过、MKCOL 永不发生，形成永不收敛的死循环）。
  // 对照组：父目录已存在的组，对端在扫描后、写入前新建同名文件 → 该组仍被剔除不覆盖
  //（与 L12 根目录场景同语义，此处验证子目录组的按父目录分组查重）。

  await section('B2B-P404：B 档父目录 404 放行整组上传（4.0 前置专项）', async () => {
    await setProfile('p2')
    try {
      await freshStore('p404')
      const P404_LOCAL = await tmpLocal('p404')
      // 场景一：本地新建子目录 + 两个文件，远端 /p404/sub-new 整个不存在
      await fsp.mkdir(path.join(P404_LOCAL, 'sub-new'), { recursive: true })
      await fsp.writeFile(path.join(P404_LOCAL, 'sub-new', 'a.txt'), 'p404-a')
      await fsp.writeFile(path.join(P404_LOCAL, 'sub-new', 'b.txt'), 'p404-b-longer')
      const p404r1 = await syncP(P404_LOCAL, '/p404')
      check(
        'P404 first round uploads whole group (parent 404 = pass-through, MKCOL then PUT)',
        p404r1.uploaded === 2 && p404r1.errors.length === 0,
        JSON.stringify(p404r1)
      )
      check(
        'P404 remote subdir created and both files present',
        fs.existsSync(path.join(ROOT, 'p404', 'sub-new', 'a.txt')) && fs.existsSync(path.join(ROOT, 'p404', 'sub-new', 'b.txt')),
        ''
      )
      const p404r2 = await syncP(P404_LOCAL, '/p404')
      check('P404 second round is a no-op (converged, no dead loop)', isNoop(p404r2) && p404r2.errors.length === 0, JSON.stringify(p404r2))
      // 场景二（对照组）：父目录已存在；对端在扫描后、写入前于该子目录新建同名文件
      // → 查重列举命中 → 组内该文件仍被剔除（不覆盖对端版本），轮次按 REMOTE_CHANGED
      // 同类后果报错；下一轮按冲突收敛（策略 local）
      await fsp.writeFile(path.join(P404_LOCAL, 'sub-new', 'guard.txt'), 'p404-local-guard')
      const guardRemote = path.join(ROOT, 'p404', 'sub-new', 'guard.txt')
      let guardCreated = false
      let p404err = null
      try {
        await syncP(P404_LOCAL, '/p404', undefined, {
          onProgress: (p) => {
            if (p.phase === 'plan' && !guardCreated) {
              guardCreated = true
              fs.writeFileSync(guardRemote, 'PEER-CREATED-GUARD')
            }
          },
        })
      } catch (e) {
        p404err = e
      }
      check(
        'P404 existing-parent group still drops on peer-created same name',
        !!p404err && /暂未上传：云端的文件刚被其他设备修改/.test(p404err.message),
        p404err && p404err.message
      )
      check(
        'P404 peer version preserved; local version intact',
        (await fsp.readFile(guardRemote, 'utf-8')) === 'PEER-CREATED-GUARD' && (await fsp.readFile(path.join(P404_LOCAL, 'sub-new', 'guard.txt'), 'utf-8')) === 'p404-local-guard'
      )
      const p404r4 = await syncP(P404_LOCAL, '/p404', { ...SP, conflictStrategy: 'local' })
      check(
        'P404 next round converges via conflict (subdir group)',
        p404r4.conflicts === 1 && p404r4.uploaded === 1 && (await fsp.readFile(guardRemote, 'utf-8')) === 'p404-local-guard',
        JSON.stringify(p404r4)
      )
      await fsp.rm(P404_LOCAL, { recursive: true, force: true })
      await fsp.rm(path.join(ROOT, 'p404'), { recursive: true, force: true })
    } finally {
      await setProfile('p1')
    }
  })

  // L13（P1 / A 档）：按需让出 —— 写轮遇他机持锁 → 规划后让出（请求时序上锁 GET 在
  // 全部扫描 PROPFIND 之后、无锁 PUT / 无用户写）、零传输、totalFiles===0、planned 有值；
  // 他机锁释放后下一轮正常完成

  await section('L13：按需让出信息字段', async () => {
    await freshStore('l13')
    const L13_LOCAL = await tmpLocal('l13')
    const l13lock = path.join(ROOT, 'l13', '.webdav-sync.lock')
    await fsp.writeFile(path.join(L13_LOCAL, 'a.txt'), 'l13-a')
    await fsp.writeFile(path.join(L13_LOCAL, 'b.txt'), 'l13-b')
    await fsp.mkdir(path.join(ROOT, 'l13'), { recursive: true })
    await fsp.writeFile(l13lock, JSON.stringify({ v: 1, deviceId: 'device-peer-l13', startedAt: new Date().toISOString(), ttlMs: 180000 }))
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      const l13s1 = await syncP(L13_LOCAL, '/l13')
      const lines = await readReqlog()
      const lastPropIdx = lines.map((l, i) => (l.startsWith('PROPFIND') ? i : -1)).filter((i) => i >= 0).pop()
      const lockGetIdx = lines.findIndex((l) => l === 'GET /dav/l13/.webdav-sync.lock')
      check(
        'L13 write round yields after planning: zero transfers, totalFiles=0, planned set',
        l13s1.yielded === true && l13s1.uploaded === 0 && l13s1.downloaded === 0 && l13s1.totalFiles === 0 && l13s1.planned === 2 && l13s1.warnings.some((w) => /另一台设备正在同步/.test(w)),
        JSON.stringify(l13s1)
      )
      check(
        'L13 lock GET after all scan PROPFINDs; no lock PUT / no user write in yielded round',
        lastPropIdx != null && lockGetIdx > lastPropIdx && countReq(lines, 'PUT', '/dav/l13/.webdav-sync.lock') === 0 && !lines.some((l) => l.startsWith('PUT /dav/l13/') && !l.includes('.wdsync-') && !l.includes('.webdav-sync.lock')),
        lines.join(' | ')
      )
      check('L13 peer lock intact after yielded round', (await fsp.readFile(l13lock, 'utf-8')).includes('device-peer-l13'))
      await fsp.rm(l13lock, { force: true })
      const l13s2 = await syncP(L13_LOCAL, '/l13')
      check(
        'L13 next round completes normally after peer releases',
        l13s2.uploaded === 2 && l13s2.errors.length === 0 && !l13s2.yielded && !fs.existsSync(l13lock),
        JSON.stringify(l13s2)
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
    }
    await fsp.rm(L13_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l13'), { recursive: true, force: true })
  })

  // L14（P1 / A 档）：lockLeftover 补删不随锁后置移动 —— 空轮也清。delefail 制造
  //「释放失败 → 左锁标记 + 远端锁残留」，去标记后跑一个空轮（无任何远端写 → 不拿锁）：
  // 轮首补删请求（DELETE 锁）仍发出、标记清除、轮次 no-op 且全程无锁 GET/PUT

  await section('L14：空轮左锁清理', async () => {
    await freshStore('l14')
    const L14_LOCAL = await tmpLocal('l14')
    const l14lock = path.join(ROOT, 'l14', '.webdav-sync.lock')
    const l14dir = { id: 'l14', localPath: L14_LOCAL, remotePath: '/l14', mode: 'two-way' }
    await fsp.writeFile(path.join(L14_LOCAL, 'a.txt'), 'l14-a')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-delefail'), 'x')
    try {
      const l14r1 = await syncP(L14_LOCAL, '/l14')
      check(
        'L14 setup: release fails, leftover mark recorded',
        l14r1.uploaded === 1 && fs.existsSync(l14lock) && !!(await services.sync._internals.getDirMeta(l14dir)).lockLeftover,
        JSON.stringify(l14r1.warnings)
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-delefail'), { force: true }).catch(() => {})
    }
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      const l14r2 = await syncP(L14_LOCAL, '/l14')
      const lines = await readReqlog()
      check(
        'L14 empty round still cleans leftover lock at round start (DELETE issued, mark cleared, round no-op)',
        isNoop(l14r2) && countReq(lines, 'DELETE', '/dav/l14/.webdav-sync.lock') === 1 && !(await services.sync._internals.getDirMeta(l14dir)).lockLeftover && !fs.existsSync(l14lock),
        lines.join(' | ')
      )
      check(
        'L14 empty round issues no other lock traffic (no GET/PUT)',
        countReq(lines, 'GET', '/dav/l14/.webdav-sync.lock') === 0 && countReq(lines, 'PUT', '/dav/l14/.webdav-sync.lock') === 0,
        lines.join(' | ')
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
    }
    await fsp.rm(L14_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'l14'), { recursive: true, force: true })
  })

  // ============================================================
  // CA 系列：取消中断在途传输
  // 依赖 dav-server 的 .wdsync-test-throttle（路径含 throttle 的 GET/PUT 按 64KB 块
  // 节流，把 12MB 传输拉长到 ~2s，制造「传一半」的取消窗口）与 reqlog 的 !ABORT 行
  //（客户端销毁连接、响应未写完时记录）。断言面：取消即时生效（远小于传完）、在途
  // 请求被服务器观察到中断、临时文件即时清理、被中止文件不写基线 / 不进失败表 /
  // 不产生错误噪声、已完成的文件基线保留、取消轮照常释放租约锁。
  // 取消的上传 intent 不再以 abort 了结（服务器可能已收字节）；配合
  // .wdsync-test-partialput（PUT 边收边落盘），「取消留半截」由服务器真实模拟而非
  // 手写文件。下一轮 recoverIntents 半截判定链命中 → 强制重传，
  // 断言零冲突零弹窗。CA1/CA4/CA6 不涉及上传意图，保持原语义。
  // CA1/CA2/CA4/CA6 在默认 p1（A 档），CA3 在 p2（B 档）；「拿锁后取消 → 锁照常
  // 释放」另由 L4 覆盖（transfer 期取消 + 释放）。
  // ============================================================

  // [慢组登记原因] 节流制造的真实秒级「传一半」取消窗口（每用例 0.4–2s）× A/B 档全覆盖；取消语义的快路径仍由 L4 覆盖
  await slowSection('CA：取消中断在途传输', '节流制造的真实秒级「传一半」取消窗口（每用例 0.4–2s）× A/B 档全覆盖；取消语义的快路径仍由 L4 覆盖', async () => {
    const BIG = 12 * 1024 * 1024

    // ---- CA1（P1 / A 档）：大文件下载中取消 ----
    await freshStore('ca1')
    const CA1_LOCAL = await tmpLocal('ca1')
    const ca1dir = { id: 'ca1', localPath: CA1_LOCAL, remotePath: '/ca1', mode: 'two-way' }
    const ca1big = Buffer.alloc(BIG)
    ca1big.fill('q')
    await fsp.mkdir(path.join(ROOT, 'ca1'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'ca1', 'big-throttle.bin'), ca1big)
    await fsp.writeFile(path.join(ROOT, 'ca1', 'small.txt'), 'ca1-small')
    await setThrottle(10)
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      const r = await runCancelRound(CA1_LOCAL, '/ca1', 'GET /dav/ca1/big-throttle.bin', 500)
      check('CA1 cancelled download round ends with abort message', !!r.err && /已取消同步/.test(r.err.message) && r.err.phase === 'execute', r.err && r.err.message)
      check('CA1 cancel takes effect far before the throttled transfer finishes', r.abortToSettleMs > 0 && r.abortToSettleMs < 1000 && r.sawBytes, `settle=${r.abortToSettleMs}ms（完整传输约 1900ms）bytesObserved=${r.sawBytes}`)
      const lines = await waitAbortLine('GET', '/dav/ca1/big-throttle.bin')
      check('CA1 server observed the in-flight GET aborted', lines.some((l) => l === '!ABORT GET /dav/ca1/big-throttle.bin'), lines.filter((l) => l.startsWith('!ABORT')).join(' | '))
      check('CA1 download temp file removed immediately on cancel', (await findTempResidue(CA1_LOCAL)).length === 0)
      check(
        'CA1 aborted download writes no baseline; completed file keeps its baseline',
        (await services.sync._internals.baselineEntry(ca1dir, 'big-throttle.bin')) === null && !!(await services.sync._internals.baselineEntry(ca1dir, 'small.txt'))
      )
      check(
        'CA1 abort never enters the failure table or error noise',
        Object.keys(await services.sync._internals.getFailures(ca1dir)).length === 0 && !((r.summary && r.summary.errors) || []).some((m) => /big-throttle/.test(m)),
        JSON.stringify((r.summary && r.summary.errors) || [])
      )
      const walOps = await readWalOps(ca1dir)
      const intents = walOps.filter((o) => o.t === 'intent' && o.rel === 'big-throttle.bin')
      const settledIds = new Set(walOps.filter((o) => o.t === 'abort' || o.t === 'done').map((o) => o.id))
      check(
        'CA1 WAL: aborted download intent settled with abort (no dangling intent)',
        intents.length === 1 && walOps.some((o) => o.t === 'abort' && o.id === intents[0].id) && [...intents].every((i) => settledIds.has(i.id)),
        JSON.stringify(walOps)
      )
      await setThrottle(null)
      const ca1b = await syncP(CA1_LOCAL, '/ca1')
      check('CA1 next round re-plans and completes the aborted download', ca1b.errors.length === 0 && ca1b.downloaded === 1, JSON.stringify(ca1b))
      const ca1got = await fsp.readFile(path.join(CA1_LOCAL, 'big-throttle.bin'))
      check('CA1 converged content equals the remote original', ca1got.length === ca1big.length && ca1got.equals(ca1big))
      check('CA1 no temp residue after converging round', (await findTempResidue(CA1_LOCAL)).length === 0)
      check('CA1 follow-up round is a no-op', isNoop(await syncP(CA1_LOCAL, '/ca1')))
    } finally {
      await setThrottle(null)
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
      await fsp.rm(CA1_LOCAL, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'ca1'), { recursive: true, force: true }).catch(() => {})
    }

    // ---- CA2（P1 / A 档）：大文件上传中取消 → 服务器真实保留半截 → 下轮自动重传 ----
    // partialput 档下服务器真实保留已收字节，下一轮半截判定链自动识别并
    // 强制重传：零冲突、零弹窗（取消的上传 intent 保持开放，见节头说明）
    await freshStore('ca2')
    const CA2_LOCAL = await tmpLocal('ca2')
    const ca2dir = { id: 'ca2', localPath: CA2_LOCAL, remotePath: '/ca2', mode: 'two-way' }
    const ca2big = Buffer.alloc(BIG)
    ca2big.fill('z')
    await fsp.writeFile(path.join(CA2_LOCAL, 'up-throttle.bin'), ca2big)
    await fsp.writeFile(path.join(CA2_LOCAL, 'small.txt'), 'ca2-small')
    await setThrottle(10)
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-partialput'), 'x')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      const r = await runCancelRound(CA2_LOCAL, '/ca2', 'PUT /dav/ca2/up-throttle.bin', 500)
      check('CA2 cancelled upload round ends with abort message', !!r.err && /已取消同步/.test(r.err.message), r.err && r.err.message)
      check('CA2 cancel interrupts the in-flight PUT promptly', r.abortToSettleMs > 0 && r.abortToSettleMs < 1000, `settle=${r.abortToSettleMs}ms`)
      const lines = await waitAbortLine('PUT', '/dav/ca2/up-throttle.bin')
      check('CA2 server observed the in-flight PUT aborted', lines.some((l) => l === '!ABORT PUT /dav/ca2/up-throttle.bin'), lines.filter((l) => l.startsWith('!ABORT')).join(' | '))
      const ca2localAfter = await fsp.readFile(path.join(CA2_LOCAL, 'up-throttle.bin'))
      check('CA2 local original intact after cancelled upload', ca2localAfter.length === ca2big.length && ca2localAfter.equals(ca2big))
      check(
        'CA2 completed upload before cancel is committed (abort-round batch verify settles it)',
        !!r.summary && r.summary.uploaded === 1 && !!(await services.sync._internals.baselineEntry(ca2dir, 'small.txt')) && fs.existsSync(path.join(ROOT, 'ca2', 'small.txt')),
        JSON.stringify(r.summary)
      )
      // 4.7：partialput 档下取消的 PUT 真实保留半截（非零、小于全量、内容恰为本地前缀）
      const ca2HalfPath = path.join(ROOT, 'ca2', 'up-throttle.bin')
      const ca2HalfSize = fs.existsSync(ca2HalfPath) ? fs.statSync(ca2HalfPath).size : -1
      check(
        'CA2 partialput server really kept the truncated upload (0 < size < full, exact prefix)',
        ca2HalfSize > 0 && ca2HalfSize < ca2big.length && (await fsp.readFile(ca2HalfPath)).equals(ca2big.subarray(0, ca2HalfSize)),
        `half=${ca2HalfSize} full=${ca2big.length}`
      )
      check('CA2 lease released after in-flight cancel (held since pre-workers)', !fs.existsSync(path.join(ROOT, 'ca2', '.webdav-sync.lock')))
      check(
        'CA2 abort never enters the failure table or error noise',
        Object.keys(await services.sync._internals.getFailures(ca2dir)).length === 0 && !((r.summary && r.summary.errors) || []).some((m) => /up-throttle/.test(m)),
        JSON.stringify((r.summary && r.summary.errors) || [])
      )
      // 取消的上传 intent 不写 abort —— 保持开放，供下一轮半截判定
      const walOps = await readWalOps(ca2dir)
      const intents = walOps.filter((o) => o.t === 'intent' && o.rel === 'up-throttle.bin')
      const settledIds = new Set(walOps.filter((o) => o.t === 'abort' || o.t === 'done').map((o) => o.id))
      check(
        'CA2 WAL: cancelled upload intent left OPEN (no abort) for next-round half detection',
        intents.length === 1 && !settledIds.has(intents[0].id) && intents[0].remote === null && typeof intents[0].at === 'number',
        JSON.stringify(walOps)
      )
      // 下一轮：半截判定链命中 → 强制重传（4.4），零冲突零弹窗
      await setThrottle(null)
      let ca2Conflicts = 0
      const ca2b = await syncP(CA2_LOCAL, '/ca2', undefined, {
        onConflict: async () => {
          ca2Conflicts++
          return 'local'
        },
      })
      check(
        'CA2 next round auto-detects the partial and re-uploads with ZERO conflicts/dialogs',
        ca2b.errors.length === 0 && ca2b.uploaded === 1 && ca2b.conflicts === 0 && ca2Conflicts === 0 && ca2b.warnings.some((w) => /不完整文件/.test(w)),
        `calls=${ca2Conflicts} ${JSON.stringify({ ...ca2b, warnings: ca2b.warnings })}`
      )
      const ca2remote = await fsp.readFile(path.join(ROOT, 'ca2', 'up-throttle.bin'))
      check('CA2 remote ends byte-equal to local after auto re-upload', ca2remote.length === ca2big.length && ca2remote.equals(ca2big))
      check('CA2 WAL truncated empty after convergence round', (await readWalOps(ca2dir)).length === 0)
      check('CA2 follow-up round is a no-op', isNoop(await syncP(CA2_LOCAL, '/ca2')))
    } finally {
      await setThrottle(null)
      await fsp.rm(path.join(ROOT, '.wdsync-test-partialput'), { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
      await fsp.rm(CA2_LOCAL, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'ca2'), { recursive: true, force: true }).catch(() => {})
    }

    // ---- CA3（P2 / B 档）：大文件上传中取消（B 档：查重 + 复查守卫下的取消路径）----
    // 同 CA2：partialput 真实半截 + 下轮半截判定强制重传（B 档复查守卫用本轮扫描指纹）
    await setProfile('p2')
    try {
      await freshStore('ca3')
      const CA3_LOCAL = await tmpLocal('ca3')
      const ca3dir = { id: 'ca3', localPath: CA3_LOCAL, remotePath: '/ca3', mode: 'two-way' }
      const ca3big = Buffer.alloc(BIG)
      ca3big.fill('b')
      await fsp.writeFile(path.join(CA3_LOCAL, 'up-throttle.bin'), ca3big)
      await fsp.writeFile(path.join(CA3_LOCAL, 'small.txt'), 'ca3-small')
      await setThrottle(10)
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-partialput'), 'x')
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
      try {
        const r = await runCancelRound(CA3_LOCAL, '/ca3', 'PUT /dav/ca3/up-throttle.bin', 500)
        check('CA3 (B tier) cancelled upload round ends with abort message', !!r.err && /已取消同步/.test(r.err.message), r.err && r.err.message)
        check('CA3 (B tier) cancel interrupts the in-flight PUT promptly', r.abortToSettleMs > 0 && r.abortToSettleMs < 1000, `settle=${r.abortToSettleMs}ms`)
        const lines = await waitAbortLine('PUT', '/dav/ca3/up-throttle.bin')
        check('CA3 (B tier) server observed the in-flight PUT aborted', lines.some((l) => l === '!ABORT PUT /dav/ca3/up-throttle.bin'), lines.filter((l) => l.startsWith('!ABORT')).join(' | '))
        check(
          'CA3 (B tier) abort never enters the failure table or error noise',
          Object.keys(await services.sync._internals.getFailures(ca3dir)).length === 0 && !((r.summary && r.summary.errors) || []).some((m) => /up-throttle/.test(m)),
          JSON.stringify((r.summary && r.summary.errors) || [])
        )
        check('CA3 (B tier) completed upload committed and lease released on cancel', !!r.summary && r.summary.uploaded === 1 && !fs.existsSync(path.join(ROOT, 'ca3', '.webdav-sync.lock')), JSON.stringify(r.summary))
        const ca3HalfPath = path.join(ROOT, 'ca3', 'up-throttle.bin')
        const ca3HalfSize = fs.existsSync(ca3HalfPath) ? fs.statSync(ca3HalfPath).size : -1
        check(
          'CA3 (B tier) partialput server really kept the truncated upload',
          ca3HalfSize > 0 && ca3HalfSize < ca3big.length && (await fsp.readFile(ca3HalfPath)).equals(ca3big.subarray(0, ca3HalfSize)),
          `half=${ca3HalfSize} full=${ca3big.length}`
        )
        const walOps3 = await readWalOps(ca3dir)
        const intents3 = walOps3.filter((o) => o.t === 'intent' && o.rel === 'up-throttle.bin')
        const settled3 = new Set(walOps3.filter((o) => o.t === 'abort' || o.t === 'done').map((o) => o.id))
        check('CA3 (B tier) cancelled upload intent left OPEN for half detection', intents3.length === 1 && !settled3.has(intents3[0].id), JSON.stringify(walOps3))
        // 下一轮：B 档复查守卫下强制重传半截（复查基准 = 本轮扫描到的半截指纹）
        await setThrottle(null)
        let ca3Conflicts = 0
        const ca3b = await syncP(CA3_LOCAL, '/ca3', undefined, {
          onConflict: async () => {
            ca3Conflicts++
            return 'local'
          },
        })
        check(
          'CA3 (B tier) next round auto-detects the partial and re-uploads with ZERO conflicts/dialogs',
          ca3b.errors.length === 0 && ca3b.uploaded === 1 && ca3b.conflicts === 0 && ca3Conflicts === 0,
          `calls=${ca3Conflicts} ${JSON.stringify(ca3b)}`
        )
        const ca3remote = await fsp.readFile(path.join(ROOT, 'ca3', 'up-throttle.bin'))
        check('CA3 (B tier) remote ends byte-equal to local after auto re-upload', ca3remote.length === ca3big.length && ca3remote.equals(ca3big))
        check('CA3 (B tier) follow-up round is a no-op', isNoop(await syncP(CA3_LOCAL, '/ca3')))
      } finally {
        await setThrottle(null)
        await fsp.rm(path.join(ROOT, '.wdsync-test-partialput'), { force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
        await fsp.rm(REQLOG, { force: true }).catch(() => {})
        await fsp.rm(CA3_LOCAL, { recursive: true, force: true }).catch(() => {})
        await fsp.rm(path.join(ROOT, 'ca3'), { recursive: true, force: true }).catch(() => {})
      }
    } finally {
      await setProfile('p1')
    }

    // ---- CA4（P1 / A 档）：规划期 verify 池的流式下载中取消 ----
    await freshStore('ca4')
    const CA4_LOCAL = await tmpLocal('ca4')
    const ca4dir = { id: 'ca4', localPath: CA4_LOCAL, remotePath: '/ca4', mode: 'two-way' }
    const ca4big = Buffer.alloc(BIG)
    ca4big.fill('v')
    await fsp.mkdir(path.join(ROOT, 'ca4'), { recursive: true })
    await fsp.writeFile(path.join(ROOT, 'ca4', 'adopt-throttle.bin'), ca4big)
    await fsp.writeFile(path.join(CA4_LOCAL, 'adopt-throttle.bin'), ca4big)
    // 本地 mtime 拉开到容差外：无基线 + 双侧并存同 size → 规划期 verify（adopt）下载比对
    const ca4shift = new Date(Date.now() + 40000)
    await fsp.utimes(path.join(CA4_LOCAL, 'adopt-throttle.bin'), ca4shift, ca4shift)
    await setThrottle(10)
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      const r = await runCancelRound(CA4_LOCAL, '/ca4', 'GET /dav/ca4/adopt-throttle.bin', 400)
      check('CA4 cancelled verify round ends with abort message', !!r.err && /已取消同步/.test(r.err.message), r.err && r.err.message)
      check('CA4 cancel interrupts the in-flight verify download promptly', r.abortToSettleMs > 0 && r.abortToSettleMs < 1000, `settle=${r.abortToSettleMs}ms`)
      const lines = await waitAbortLine('GET', '/dav/ca4/adopt-throttle.bin')
      check('CA4 server observed the in-flight verify GET aborted', lines.some((l) => l === '!ABORT GET /dav/ca4/adopt-throttle.bin'), lines.filter((l) => l.startsWith('!ABORT')).join(' | '))
      check('CA4 verify temp file removed immediately on cancel', (await findTempResidue(CA4_LOCAL)).length === 0)
      check('CA4 aborted verify writes no baseline and no failure record', (await services.sync._internals.baselineEntry(ca4dir, 'adopt-throttle.bin')) === null && Object.keys(await services.sync._internals.getFailures(ca4dir)).length === 0)
      await setThrottle(null)
      const ca4b = await syncP(CA4_LOCAL, '/ca4')
      check('CA4 next round adopts identical content without transfer', ca4b.errors.length === 0 && ca4b.adopted === 1 && ca4b.downloaded === 0, JSON.stringify(ca4b))
      check('CA4 follow-up round is a no-op', isNoop(await syncP(CA4_LOCAL, '/ca4')))
    } finally {
      await setThrottle(null)
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
      await fsp.rm(CA4_LOCAL, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'ca4'), { recursive: true, force: true }).catch(() => {})
    }

    // ---- CA6：规划期取消（拿锁前）→ 零锁请求；下一轮正常 ----
    await freshStore('ca6')
    const CA6_LOCAL = await tmpLocal('ca6')
    await fsp.writeFile(path.join(CA6_LOCAL, 'a.txt'), 'ca6-a')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    try {
      let ca6Abort = false
      let ca6err = null
      try {
        await syncP(CA6_LOCAL, '/ca6', undefined, {
          shouldAbort: () => ca6Abort,
          onProgress: (p) => {
            if (p.phase === 'plan') ca6Abort = true
          },
        })
      } catch (e) {
        ca6err = e
      }
      check('CA6 plan-phase cancel ends the round with abort message', !!ca6err && /已取消同步/.test(ca6err.message), ca6err && ca6err.message)
      const lines = await readReqlog()
      check('CA6 cancel before lock acquisition issues zero lease-lock requests', lines.every((l) => !l.includes('.webdav-sync.lock')), lines.filter((l) => l.includes('.webdav-sync.lock')).join(' | '))
      check('CA6 cancelled round uploads nothing', !lines.some((l) => l.startsWith('PUT /dav/ca6/a.txt')) && !fs.existsSync(path.join(ROOT, 'ca6', 'a.txt')))
      const ca6b = await syncP(CA6_LOCAL, '/ca6')
      check('CA6 next round syncs normally after plan-phase cancel', ca6b.errors.length === 0 && ca6b.uploaded === 1, JSON.stringify(ca6b))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
      await fsp.rm(CA6_LOCAL, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'ca6'), { recursive: true, force: true }).catch(() => {})
    }
  })

  // ============================================================
  // PU 系列：半截上传的识别与自动重传 —— 恢复链路
  // 依赖 dav-server 的 .wdsync-test-netcut（收到第 N 块后主动断连 → 客户端以 NETWORK
  // 收场，区别于用户取消的 ABORTED；每路径最多切 M 次，内容 `N` 或 `N:M`）与
  // .wdsync-test-partialput（PUT 边收边落盘：断连时已收字节保留为半截）。netcut 无需
  // 节流与取消窗口，全部用例属快组；租约锁与本系列正交，统一关闭以省去每写轮 1.5s
  // 写回静置（锁语义由 L 系列覆盖）。PUP 关锁、其余与 SP 一致。
  // 覆盖：NETWORK 中断（非取消）自动重传 / 覆盖上传半截 / 对端改小前缀不符仍冲突 /
  // 超 verifyMaxBytes 冲突+提示 / 多开放 intent 去重 / 本地改/删后意图放弃无假重传 /
  // 原子服务器未落地正常覆盖 / 采纳内容确认（同 size 替换不采纳、GET 失败回退）/
  // WAL 截断保护与 30 天超龄 / 多设备他机收敛。
  // ============================================================

  await section('PU：半截上传识别与重传（恢复链路）', async () => {
    // ---- PU1：网络中断（非取消）+ partialput → 半截 → 自动重传；多开放 intent 去重 ----
    await freshStore('pu1')
    const PU1_LOCAL = await tmpLocal('pu1')
    const pu1dir = { id: 'pu1', localPath: PU1_LOCAL, remotePath: '/pu1', mode: 'two-way' }
    const pu1a = puBuf('a')
    await fsp.writeFile(path.join(PU1_LOCAL, 'cut-me.bin'), pu1a)
    await fsp.writeFile(path.join(PU1_LOCAL, 'ok.txt'), 'pu1-ok')
    await setPartialPut(true)
    await setNetcut('2') // 每路径不限次数：首次与当轮重试都被切断 → 轮次以 NETWORK 报错收场
    let pu1err = null
    try {
      await syncP(PU1_LOCAL, '/pu1', PUP)
    } catch (e) {
      pu1err = e
    }
    check(
      'PU1 netcut round fails with NETWORK error (not abort), same-round retry suppressed with a note',
      !!pu1err && /网络连接失败|ECONNRESET/.test(pu1err.message) && /本次不再重试/.test(pu1err.errors ? pu1err.errors[0] : pu1err.message),
      pu1err && pu1err.message
    )
    check('PU1 sibling file still committed in the failed round', (await services.sync._internals.baselineEntry(pu1dir, 'ok.txt')) != null)
    const pu1Half = path.join(ROOT, 'pu1', 'cut-me.bin')
    const pu1HalfSize = fs.existsSync(pu1Half) ? fs.statSync(pu1Half).size : -1
    check('PU1 server kept a real partial (prefix of local)', pu1HalfSize > 0 && pu1HalfSize < pu1a.length && (await fsp.readFile(pu1Half)).equals(pu1a.subarray(0, pu1HalfSize)), `half=${pu1HalfSize}`)
    const pu1ops = await readWalOps(pu1dir)
    const pu1intents = pu1ops.filter((o) => o.t === 'intent' && o.rel === 'cut-me.bin')
    const pu1settled = new Set(pu1ops.filter((o) => o.t === 'abort' || o.t === 'done').map((o) => o.id))
    check(
      'PU1 WAL: ONE attempt (retry suppressed) → one open intent carrying remote=null + at',
      pu1intents.length === 1 && !pu1settled.has(pu1intents[0].id) && pu1intents[0].remote === null && typeof pu1intents[0].at === 'number',
      JSON.stringify(pu1ops)
    )
    check('PU1 WAL not truncated while an intent is open', (await fsp.readFile(path.join(await baselineDirOf(pu1dir), 'wal.jsonl'), 'utf-8')).includes('"intent"'))
    await setNetcut(null)
    await setPartialPut(false)
    let pu1calls = 0
    const pu1b = await syncP(PU1_LOCAL, '/pu1', PUP, {
      onConflict: async () => {
        pu1calls++
        return 'local'
      },
    })
    check(
      'PU1 next round auto re-uploads the partial with zero conflicts/dialogs',
      pu1b.errors.length === 0 && pu1b.uploaded === 1 && pu1b.conflicts === 0 && pu1calls === 0 && pu1b.warnings.some((w) => /不完整文件/.test(w)),
      `calls=${pu1calls} ${JSON.stringify({ ...pu1b, warnings: pu1b.warnings })}`
    )
    check('PU1 converged remote equals local', (await fsp.readFile(pu1Half)).equals(pu1a))
    check('PU1 WAL truncated empty after convergence', (await readWalOps(pu1dir)).length === 0)
    check('PU1 follow-up round is a no-op', isNoop(await syncP(PU1_LOCAL, '/pu1', PUP)))
    await fsp.rm(PU1_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu1'), { recursive: true, force: true }).catch(() => {})

    // ---- PU5：同 rel 多个开放意图去重（跨轮残留 + 注入历史意图）----
    // 同轮重试已按 4.2 抑制，多个开放意图只剩「跨轮残留 / 崩溃窗口」一种来源 —— 用例
    // 在真实开放意图之外手工注入一条更早的开放意图行（同编码 / 同 CRC），验证恢复期
    // 对多条意图幂等去重：单次半截提示、单次重传、全部被新意图取代
    await freshStore('pu5')
    const PU5_LOCAL = await tmpLocal('pu5')
    const pu5dir = { id: 'pu5', localPath: PU5_LOCAL, remotePath: '/pu5', mode: 'two-way' }
    const pu5buf = puBuf('5')
    await fsp.writeFile(path.join(PU5_LOCAL, 'dup.bin'), pu5buf)
    await setPartialPut(true)
    await setNetcut('2')
    try {
      await syncP(PU5_LOCAL, '/pu5', PUP)
    } catch {
      /* 期望失败：留下开放意图 + 半截 */
    }
    await setNetcut(null)
    await setPartialPut(false)
    // 注入一条同 rel 的更早开放意图（模拟上一轮残留），重载存储使其参与折叠
    const pu5walPath = path.join(await baselineDirOf(pu5dir), 'wal.jsonl')
    const pu5st0 = await fsp.stat(path.join(PU5_LOCAL, 'dup.bin'))
    const pu5extra = storeModule._internals.encodeLine(1, {
      t: 'intent',
      id: 'pu5-injected-old',
      op: 'upload',
      rel: 'dup.bin',
      at: Date.now() - 3600_000,
      local: { size: pu5st0.size, mtimeMs: pu5st0.mtimeMs },
      remote: null,
    })
    await fsp.appendFile(pu5walPath, pu5extra)
    // wal 位于 <storageRoot>/baselines/<h>/wal.jsonl：剥掉 wal.jsonl/<h>/baselines 三段才是
    // 存储根；重设同一根以强制重载（折叠出两条开放意图）
    await switchDevice(path.resolve(pu5walPath, '..', '..', '..'))
    let pu5calls = 0
    const pu5b = await syncP(PU5_LOCAL, '/pu5', PUP, {
      onConflict: async () => {
        pu5calls++
        return 'local'
      },
    })
    const pu5halfWarns = pu5b.warnings.filter((w) => /不完整文件/.test(w))
    check(
      'PU5 multiple open intents dedup to ONE half warning + ONE forced re-upload (zero conflicts)',
      pu5b.errors.length === 0 && pu5b.uploaded === 1 && pu5b.conflicts === 0 && pu5calls === 0 && pu5halfWarns.length === 1,
      `calls=${pu5calls} warns=${pu5halfWarns.length} ${JSON.stringify({ ...pu5b, warnings: pu5b.warnings })}`
    )
    check('PU5 converged remote equals local', (await fsp.readFile(path.join(ROOT, 'pu5', 'dup.bin'))).equals(pu5buf))
    check('PU5 WAL truncated empty after convergence (all superseded/settled)', (await readWalOps(pu5dir)).length === 0)
    check('PU5 follow-up round is a no-op', isNoop(await syncP(PU5_LOCAL, '/pu5', PUP)))
    await fsp.rm(PU5_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu5'), { recursive: true, force: true }).catch(() => {})

    // ---- PU2：覆盖上传半截（远端原有旧内容被半截替换）→ 自动重传 ----
    await freshStore('pu2')
    const PU2_LOCAL = await tmpLocal('pu2')
    const pu2dir = { id: 'pu2', localPath: PU2_LOCAL, remotePath: '/pu2', mode: 'two-way' }
    const pu2v1 = Buffer.alloc(256 * 1024)
    pu2v1.fill('1')
    const pu2v2 = puBuf('2')
    await fsp.writeFile(path.join(PU2_LOCAL, 'over.bin'), pu2v1)
    const pu2s0 = await syncP(PU2_LOCAL, '/pu2', PUP)
    check('PU2 setup uploads v1', pu2s0.uploaded === 1 && pu2s0.errors.length === 0, JSON.stringify(pu2s0))
    await fsp.writeFile(path.join(PU2_LOCAL, 'over.bin'), pu2v2)
    await setPartialPut(true)
    await setNetcut('2')
    let pu2err = null
    try {
      await syncP(PU2_LOCAL, '/pu2', PUP)
    } catch (e) {
      pu2err = e
    }
    check('PU2 overwrite upload interrupted with NETWORK', !!pu2err && /网络连接失败|ECONNRESET/.test(pu2err.message), pu2err && pu2err.message)
    const pu2remoteNow = await fsp.readFile(path.join(ROOT, 'pu2', 'over.bin'))
    check(
      'PU2 remote old content replaced by a real prefix of v2 (not v1)',
      pu2remoteNow.length > 0 && pu2remoteNow.length < pu2v2.length && pu2remoteNow.equals(pu2v2.subarray(0, pu2remoteNow.length)),
      `size=${pu2remoteNow.length}`
    )
    await setNetcut(null)
    await setPartialPut(false)
    let pu2calls = 0
    const pu2b = await syncP(PU2_LOCAL, '/pu2', PUP, {
      onConflict: async () => {
        pu2calls++
        return 'local'
      },
    })
    check(
      'PU2 next round detects the half and re-uploads with zero conflicts (intent.remote = pre-PUT v1 fp)',
      pu2b.errors.length === 0 && pu2b.uploaded === 1 && pu2b.conflicts === 0 && pu2calls === 0,
      `calls=${pu2calls} ${JSON.stringify(pu2b)}`
    )
    check('PU2 converged remote equals v2', (await fsp.readFile(path.join(ROOT, 'pu2', 'over.bin'))).equals(pu2v2))
    check('PU2 follow-up round is a no-op', isNoop(await syncP(PU2_LOCAL, '/pu2', PUP)))
    await fsp.rm(PU2_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu2'), { recursive: true, force: true }).catch(() => {})

    // ---- PU3：对端真实改小且前缀不符 → 仍冲突（无提示，意图放弃）----
    await freshStore('pu3')
    const PU3_LOCAL = await tmpLocal('pu3')
    const pu3dir = { id: 'pu3', localPath: PU3_LOCAL, remotePath: '/pu3', mode: 'two-way' }
    const pu3buf = puBuf('3')
    await fsp.writeFile(path.join(PU3_LOCAL, 'peer.bin'), pu3buf)
    await setPartialPut(true)
    await setNetcut('2')
    try {
      await syncP(PU3_LOCAL, '/pu3', PUP)
    } catch {
      /* 期望失败：留下开放意图 + 半截 */
    }
    await setNetcut(null)
    await setPartialPut(false)
    // 模拟对端把远端改成「小于本地但内容并非本地前缀」的文件
    const pu3peer = Buffer.alloc(100 * 1024)
    pu3peer.fill('X')
    await fsp.writeFile(path.join(ROOT, 'pu3', 'peer.bin'), pu3peer)
    let pu3info = null
    const pu3b = await syncP(PU3_LOCAL, '/pu3', PUP, {
      onConflict: async (info) => {
        pu3info = info
        return 'local'
      },
    })
    check(
      'PU3 peer-shrunk non-prefix file still yields a conflict (no auto re-upload, no hint)',
      pu3b.conflicts === 1 && pu3b.uploaded === 1 && pu3info != null && pu3info.hint === undefined,
      `hint=${pu3info && pu3info.hint} ${JSON.stringify(pu3b)}`
    )
    check(
      'PU3 prefix mismatch settles the intent as NOT-ours (recovery note is log-only now)',
      !pu3b.warnings.some((w) => /崩溃恢复/.test(w)),
      JSON.stringify(pu3b.warnings)
    )
    check('PU3 converged after user choice local', (await fsp.readFile(path.join(ROOT, 'pu3', 'peer.bin'))).equals(pu3buf))
    await fsp.rm(PU3_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu3'), { recursive: true, force: true }).catch(() => {})

    // ---- PU4：超 verifyMaxBytes → 冲突 + 提示文案（意图保持开放）----
    await freshStore('pu4')
    const PU4_LOCAL = await tmpLocal('pu4')
    const pu4dir = { id: 'pu4', localPath: PU4_LOCAL, remotePath: '/pu4', mode: 'two-way' }
    const pu4buf = puBuf('4')
    await fsp.writeFile(path.join(PU4_LOCAL, 'huge.bin'), pu4buf)
    await setPartialPut(true)
    await setNetcut('2')
    try {
      await syncP(PU4_LOCAL, '/pu4', PUP)
    } catch {
      /* 期望失败：留下开放意图 + 半截 */
    }
    await setNetcut(null)
    await setPartialPut(false)
    let pu4info = null
    let pu4warn = []
    const pu4b = await services.sync.syncDirectory(
      cfg,
      { id: 'pu4', localPath: PU4_LOCAL, remotePath: '/pu4', mode: 'two-way' },
      { ...PUP, verifyMaxBytes: 1024 },
      {
        onConflict: async (info) => {
          pu4info = info
          return 'local'
        },
      }
    )
    pu4warn = pu4b.warnings
    check(
      'PU4 over-limit partial stays a conflict WITH the partial-upload hint',
      pu4b.conflicts === 1 && pu4b.uploaded === 1 && pu4info != null && pu4info.hint === 'partial-upload' && pu4warn.some((w) => /太大无法自动对比/.test(w)),
      `hint=${pu4info && pu4info.hint} ${JSON.stringify(pu4warn)}`
    )
    // 注：轮末 WAL 必然截断为空（冲突解决的落地意图了结了开放意图）；「冲突时刻意图
    // 仍开放」这一事实由上方 hint==='partial-upload' 断言直接证明（hint 条件 = 开放
    // upload 意图 + 远端小于本地），无需再读 WAL
    check('PU4 converged after user choice local', (await fsp.readFile(path.join(ROOT, 'pu4', 'huge.bin'))).equals(pu4buf))
    await fsp.rm(PU4_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu4'), { recursive: true, force: true }).catch(() => {})

    // ---- PU6：本地文件在 intent 之后被改 / 被删 → 意图放弃、无假重传 ----
    // (a) 本地删除：意图在恢复期放弃（本地已不存在），远端半截按「仅远端存在 → 下载」收敛
    await freshStore('pu6a')
    const PU6A_LOCAL = await tmpLocal('pu6a')
    const pu6adir = { id: 'pu6a', localPath: PU6A_LOCAL, remotePath: '/pu6a', mode: 'two-way' }
    const pu6abuf = puBuf('6')
    await fsp.writeFile(path.join(PU6A_LOCAL, 'gone.bin'), pu6abuf)
    await setPartialPut(true)
    await setNetcut('2')
    try {
      await syncP(PU6A_LOCAL, '/pu6a', PUP)
    } catch {
      /* 期望失败 */
    }
    await setNetcut(null)
    await setPartialPut(false)
    const pu6aops1 = await readWalOps(pu6adir)
    const pu6aopen = pu6aops1.filter((o) => o.t === 'intent' && o.rel === 'gone.bin').pop()
    check('PU6a setup leaves an open intent (recovery input)', pu6aopen != null && pu6aops1.every((o) => o.t !== 'abort' || o.id !== pu6aopen.id), JSON.stringify(pu6aops1))
    await fsp.unlink(path.join(PU6A_LOCAL, 'gone.bin'))
    const pu6a = await syncP(PU6A_LOCAL, '/pu6a', PUP)
    check(
      'PU6a deleted local → intent aborted at recovery, half downloaded back, no forced upload, no conflict',
      pu6a.downloaded === 1 && pu6a.conflicts === 0 && pu6a.uploaded === 0 && !pu6a.warnings.some((w) => /崩溃恢复/.test(w)),
      JSON.stringify({ ...pu6a, warnings: pu6a.warnings })
    )
    check(
      'PU6a local now holds the half content (documented peer-visible half)',
      (await fsp.readFile(path.join(PU6A_LOCAL, 'gone.bin'))).equals(pu6abuf.subarray(0, fs.statSync(path.join(ROOT, 'pu6a', 'gone.bin')).size))
    )
    await fsp.rm(PU6A_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu6a'), { recursive: true, force: true }).catch(() => {})
    // (b) 本地修改（独立场景，无基线）：意图放弃，双侧并存 size 不同 → 冲突（绝不按旧意图假重传）
    await freshStore('pu6b')
    const PU6B_LOCAL = await tmpLocal('pu6b')
    const pu6bbufOld = puBuf('6')
    await fsp.writeFile(path.join(PU6B_LOCAL, 'edited.bin'), pu6bbufOld)
    await setPartialPut(true)
    await setNetcut('2')
    try {
      await syncP(PU6B_LOCAL, '/pu6b', PUP)
    } catch {
      /* 期望失败 */
    }
    await setNetcut(null)
    await setPartialPut(false)
    const pu6bbufNew = puBuf('7')
    await fsp.writeFile(path.join(PU6B_LOCAL, 'edited.bin'), pu6bbufNew)
    let pu6bConflicts = 0
    const pu6b = await syncP(PU6B_LOCAL, '/pu6b', PUP, {
      onConflict: async () => {
        pu6bConflicts++
        return 'local'
      },
    })
    check(
      'PU6b modified local → conflict (conservative), never a forced re-upload',
      pu6b.conflicts === 1 && pu6bConflicts === 1 && pu6b.uploaded === 1,
      `calls=${pu6bConflicts} ${JSON.stringify(pu6b)}`
    )
    check('PU6b converged to modified local', (await fsp.readFile(path.join(ROOT, 'pu6b', 'edited.bin'))).equals(pu6bbufNew))
    await fsp.rm(PU6B_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu6b'), { recursive: true, force: true }).catch(() => {})

    // ---- PU7：服务器原子（断连不落字节）→ 正常覆盖上传，无冲突 ----
    await freshStore('pu7')
    const PU7_LOCAL = await tmpLocal('pu7')
    const pu7dir = { id: 'pu7', localPath: PU7_LOCAL, remotePath: '/pu7', mode: 'two-way' }
    const pu7v1 = Buffer.alloc(256 * 1024)
    pu7v1.fill('1')
    const pu7v2 = puBuf('9')
    await fsp.writeFile(path.join(PU7_LOCAL, 'atomic.bin'), pu7v1)
    await syncP(PU7_LOCAL, '/pu7', PUP)
    await fsp.writeFile(path.join(PU7_LOCAL, 'atomic.bin'), pu7v2)
    await setNetcut('2') // 不开 partialput：切断的 PUT 不落任何字节（原子服务器 + 网络中断）
    try {
      await syncP(PU7_LOCAL, '/pu7', PUP)
    } catch {
      /* 期望失败：开放意图 + 远端仍为完整 v1 */
    }
    await setNetcut(null)
    check('PU7 atomic server kept the OLD full content (no partial)', (await fsp.readFile(path.join(ROOT, 'pu7', 'atomic.bin'))).equals(pu7v1))
    let pu7calls = 0
    const pu7b = await syncP(PU7_LOCAL, '/pu7', PUP, {
      onConflict: async () => {
        pu7calls++
        return 'local'
      },
    })
    check(
      'PU7 atomic-untouched remote → normal overwrite re-upload, zero conflicts (remote == intent.remote, no half)',
      pu7b.errors.length === 0 && pu7b.uploaded === 1 && pu7b.conflicts === 0 && pu7calls === 0,
      `calls=${pu7calls} ${JSON.stringify(pu7b)}`
    )
    check('PU7 converged to v2', (await fsp.readFile(path.join(ROOT, 'pu7', 'atomic.bin'))).equals(pu7v2))
    check('PU7 follow-up round is a no-op', isNoop(await syncP(PU7_LOCAL, '/pu7', PUP)))
    await fsp.rm(PU7_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu7'), { recursive: true, force: true }).catch(() => {})

    // ---- PU8：采纳路径内容确认（4.5）----
    // (a) 崩溃留下开放意图后，对端以同 size 不同内容替换 → 不再被静默采纳 → 冲突
    await freshStore('pu8')
    const PU8_LOCAL = await tmpLocal('pu8')
    const pu8dir = { id: 'pu8', localPath: PU8_LOCAL, remotePath: '/pu8', mode: 'two-way' }
    const pu8a = puBuf('a')
    await fsp.writeFile(path.join(PU8_LOCAL, 'adopt.bin'), pu8a)
    let pu8err = null
    try {
      await syncP(PU8_LOCAL, '/pu8', PUP, {
        afterTransferOp: async (p) => {
          if (p.rel === 'adopt.bin' && p.act === 'upload') throw new Error('SIMULATED-CRASH')
        },
      })
    } catch (e) {
      pu8err = e
    }
    check('PU8a crash after PUT leaves remote == local (full)', !!pu8err && (await fsp.readFile(path.join(ROOT, 'pu8', 'adopt.bin'))).equals(pu8a), pu8err && pu8err.message)
    check('PU8a crash residue: no leaked timer (leaseLock disabled for PU series)', sweepCrashResidue() === 0)
    // 对端替换为同 size 不同内容：内容确认必须拒绝采纳 → 冲突由用户裁决。
    // 远端 mtime 拉开到容差外：规避无基线 adopt 的 mtime 捷径，逼规划走 hash 比对分支
    const pu8peer = puBuf('B')
    const pu8peerPath = path.join(ROOT, 'pu8', 'adopt.bin')
    await fsp.writeFile(pu8peerPath, pu8peer)
    const pu8peerTime = new Date(Date.now() + 2 * 3600 * 1000)
    await fsp.utimes(pu8peerPath, pu8peerTime, pu8peerTime)
    let pu8info = null
    const pu8b = await syncP(PU8_LOCAL, '/pu8', PUP, {
      onConflict: async (info) => {
        pu8info = info
        return 'local'
      },
    })
    check(
      'PU8a same-size peer replacement NOT silently adopted → conflict, resolved by user',
      pu8b.conflicts === 1 && pu8b.uploaded === 1 && pu8b.adopted === 0 && pu8info != null,
      JSON.stringify({ ...pu8b, warnings: pu8b.warnings })
    )
    check('PU8a converged to local after user choice', (await fsp.readFile(path.join(ROOT, 'pu8', 'adopt.bin'))).equals(pu8a))
    // (b) GET 失败回退按 size 采纳：getfail 档让该文件的 GET 一律 404
    const PU8B_LOCAL = await tmpLocal('pu8b')
    const pu8bdir = { id: 'pu8b', localPath: PU8B_LOCAL, remotePath: '/pu8b', mode: 'two-way' }
    const pu8bbuf = puBuf('c')
    await fsp.writeFile(path.join(PU8B_LOCAL, 'adoptgetfail.bin'), pu8bbuf)
    try {
      await syncP(PU8B_LOCAL, '/pu8b', PUP, {
        afterTransferOp: async (p) => {
          if (p.rel === 'adoptgetfail.bin' && p.act === 'upload') throw new Error('SIMULATED-CRASH')
        },
      })
    } catch {
      /* 期望崩溃 */
    }
    check('PU8b crash residue: no leaked timer (leaseLock disabled for PU series)', sweepCrashResidue() === 0)
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-getfail'), 'adoptgetfail')
    try {
      const pu8br = await syncP(PU8B_LOCAL, '/pu8b', PUP)
      check(
        'PU8b GET failure falls back to size adoption (no transfer, no conflict; recovery note is log-only now)',
        pu8br.uploaded === 0 && pu8br.downloaded === 0 && pu8br.conflicts === 0 && !pu8br.warnings.some((w) => /按大小采纳/.test(w)) && (await services.sync._internals.baselineEntry(pu8bdir, 'adoptgetfail.bin')) != null,
        JSON.stringify({ ...pu8br, warnings: pu8br.warnings })
      )
      check('PU8b follow-up round is a no-op', isNoop(await syncP(PU8B_LOCAL, '/pu8b', PUP)))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-getfail'), { force: true }).catch(() => {})
    }
    await fsp.rm(PU8_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(PU8B_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu8'), { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu8b'), { recursive: true, force: true }).catch(() => {})

    // ---- PU9：开放意图 30 天超龄兜底 → 恢复期放弃 ----
    await freshStore('pu9')
    const PU9_LOCAL = await tmpLocal('pu9')
    const pu9dir = { id: 'pu9', localPath: PU9_LOCAL, remotePath: '/pu9', mode: 'two-way' }
    const pu9buf = puBuf('9')
    await fsp.writeFile(path.join(PU9_LOCAL, 'stale.bin'), pu9buf)
    await setPartialPut(true)
    await setNetcut('2')
    try {
      await syncP(PU9_LOCAL, '/pu9', PUP)
    } catch {
      /* 期望失败 */
    }
    await setNetcut(null)
    await setPartialPut(false)
    await services.sync._internals.ageOpenIntents(pu9dir, 31 * 24 * 3600 * 1000)
    let pu9calls = 0
    const pu9b = await syncP(PU9_LOCAL, '/pu9', PUP, {
      onConflict: async () => {
        pu9calls++
        return 'local'
      },
    })
    check(
      'PU9 over-aged open intent dropped at recovery (note is log-only), falls back to normal conflict planning',
      pu9b.conflicts === 1 && !pu9b.warnings.some((w) => /超龄/.test(w)) && pu9calls === 1,
      `calls=${pu9calls} ${JSON.stringify({ ...pu9b, warnings: pu9b.warnings })}`
    )
    check('PU9 converged after user choice local', (await fsp.readFile(path.join(ROOT, 'pu9', 'stale.bin'))).equals(pu9buf))
    await fsp.rm(PU9_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu9'), { recursive: true, force: true }).catch(() => {})

    // ---- PU10：多设备 —— 他机看到半截 → 先下载随后收敛，全程无冲突 ----
    const pu10aStore = await freshStore('pu10a')
    const PU10_A_LOCAL = await tmpLocal('pu10a')
    const pu10buf = puBuf('m')
    await fsp.writeFile(path.join(PU10_A_LOCAL, 'shared.bin'), pu10buf)
    await setPartialPut(true)
    await setNetcut('2')
    try {
      await syncP(PU10_A_LOCAL, '/pu10', PUP)
    } catch {
      /* 期望失败：A 留下开放意图 + 远端半截 */
    }
    await setNetcut(null)
    await setPartialPut(false)
    const halfSize = fs.statSync(path.join(ROOT, 'pu10', 'shared.bin')).size
    check('PU10 setup: partial exists on remote', halfSize > 0 && halfSize < pu10buf.length, `half=${halfSize}`)
    // 设备 B（独立存储根）：无开放意图 → 把半截当普通远端新文件下载（先收敛到半截）
    const pu10bStore = await freshStore('pu10b')
    const PU10_B_LOCAL = await tmpLocal('pu10b')
    const pu10b1 = await syncP(PU10_B_LOCAL, '/pu10', PUP)
    check('PU10 device B downloads the half as a plain new remote file (no conflict)', pu10b1.downloaded === 1 && pu10b1.conflicts === 0 && (await fsp.readFile(path.join(PU10_B_LOCAL, 'shared.bin'))).equals(pu10buf.subarray(0, halfSize)), JSON.stringify(pu10b1))
    // 设备 A：半截判定 → 强制重传全量
    await switchDevice(pu10aStore)
    const pu10a2 = await syncP(PU10_A_LOCAL, '/pu10', PUP)
    check('PU10 device A re-uploads the full content via half detection', pu10a2.uploaded === 1 && pu10a2.conflicts === 0 && (await fsp.readFile(path.join(ROOT, 'pu10', 'shared.bin'))).equals(pu10buf), JSON.stringify(pu10a2))
    // 设备 B：远端已变 → 下载全量，两侧收敛一致
    await switchDevice(pu10bStore)
    const pu10b2 = await syncP(PU10_B_LOCAL, '/pu10', PUP)
    check('PU10 device B converges to the full content afterwards', pu10b2.downloaded === 1 && pu10b2.conflicts === 0 && (await fsp.readFile(path.join(PU10_B_LOCAL, 'shared.bin'))).equals(pu10buf), JSON.stringify(pu10b2))
    check('PU10 both sides stable no-op afterwards', isNoop(await syncP(PU10_B_LOCAL, '/pu10', PUP)))
    await fsp.rm(PU10_A_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(PU10_B_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu10'), { recursive: true, force: true }).catch(() => {})

    // ---- PU11：P7 档（静默忽略条件头）同路径验证 ----
    await setProfile('p7')
    try {
      await freshStore('pu11')
      const PU11_LOCAL = await tmpLocal('pu11')
      const pu11buf = puBuf('q')
      await fsp.writeFile(path.join(PU11_LOCAL, 'p7cut.bin'), pu11buf)
      await setPartialPut(true)
      await setNetcut('2')
      try {
        await syncP(PU11_LOCAL, '/pu11', PUP)
      } catch {
        /* 期望失败 */
      }
      await setNetcut(null)
      await setPartialPut(false)
      let pu11calls = 0
      const pu11b = await syncP(PU11_LOCAL, '/pu11', PUP, {
        onConflict: async () => {
          pu11calls++
          return 'local'
        },
      })
      check(
        'PU11 (P7) half auto re-upload with zero conflicts/dialogs under B-tier recheck guards',
        pu11b.errors.length === 0 && pu11b.uploaded === 1 && pu11b.conflicts === 0 && pu11calls === 0,
        `calls=${pu11calls} ${JSON.stringify(pu11b)}`
      )
      check('PU11 (P7) converged remote equals local', (await fsp.readFile(path.join(ROOT, 'pu11', 'p7cut.bin'))).equals(pu11buf))
      check('PU11 (P7) follow-up round is a no-op', isNoop(await syncP(PU11_LOCAL, '/pu11', PUP)))
      await fsp.rm(PU11_LOCAL, { recursive: true, force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, 'pu11'), { recursive: true, force: true }).catch(() => {})
    } finally {
      await setProfile('p1')
    }

    // ---- PU12：持续中断链的 firstAt 继承、WAL 有界增长与超龄兜底 ----
    // (a) 同一文件反复「半截重传再中断」：每轮新意图取代旧意图且继承链上最初的
    //     firstAt（时钟不被刷新）；WAL 每轮净增 2 行（intent + 旧者 abort），线性有界；
    //     未超龄时恢复链照常自动重传（继承不误伤正常恢复）
    await freshStore('pu12')
    const PU12_LOCAL = await tmpLocal('pu12')
    const pu12dir = { id: 'pu12', localPath: PU12_LOCAL, remotePath: '/pu12', mode: 'two-way' }
    const pu12buf = puBuf('f')
    await fsp.writeFile(path.join(PU12_LOCAL, 'chain.bin'), pu12buf)
    await setPartialPut(true)
    await setNetcut('2')
    const CHAIN_ROUNDS = 3
    let chainFirstAt = 0
    for (let i = 0; i < CHAIN_ROUNDS; i++) {
      try {
        await syncP(PU12_LOCAL, '/pu12', PUP)
      } catch {
        /* 期望每轮中断：新意图取代旧意图（半截重传再被切断） */
      }
      const ops = await readWalOps(pu12dir)
      const intents = ops.filter((o) => o.t === 'intent' && o.rel === 'chain.bin')
      const settledIds = new Set(ops.filter((o) => o.t === 'abort' || o.t === 'done').map((o) => o.id))
      const open = intents.filter((o) => !settledIds.has(o.id))
      if (i === 0) chainFirstAt = Number(open[0] && open[0].firstAt)
      check(
        `PU12 chain round ${i + 1}: ONE open intent whose firstAt stays at the chain origin`,
        open.length === 1 && Number.isFinite(chainFirstAt) && Number(open[0].firstAt) === chainFirstAt,
        `open=${open.length} firstAt=${open[0] && open[0].firstAt} origin=${chainFirstAt}`
      )
    }
    const pu12ops = await readWalOps(pu12dir)
    const pu12intents = pu12ops.filter((o) => o.t === 'intent' && o.rel === 'chain.bin')
    const pu12settledIds = new Set(pu12ops.filter((o) => o.t === 'abort' || o.t === 'done').map((o) => o.id))
    const pu12settledChain = pu12intents.filter((o) => pu12settledIds.has(o.id)).length
    check(
      'PU12 WAL growth bounded: 2 lines per interrupted round (intents N + aborts N-1)',
      pu12intents.length === CHAIN_ROUNDS && pu12settledChain === CHAIN_ROUNDS - 1,
      `intents=${pu12intents.length} settled=${pu12settledChain}`
    )
    await setNetcut(null)
    await setPartialPut(false)
    // 链上相邻两轮的半截指纹完全相同（同 cut 点 → 同 size、同前缀内容 → p1 档内容
    // hash etag 相同，mtime 相差 <2s 落在 REMOTE_FP_TOL_MS 容差内），恢复期会按
    // 「远端 == intent.remote」走保守路径（PU7 语义）—— 真实调度间隔（分钟级）下
    // 新半截的 mtime 必然超出容差。把服务器侧半截的 mtime 前推 4s 模拟真实间隔，
    // 验证恢复链在「远端指纹已变」时的自动重传不受 firstAt 继承影响
    const pu12half = path.join(ROOT, 'pu12', 'chain.bin')
    const pu12halfTime = new Date(fs.statSync(pu12half).mtimeMs + 4000)
    await fsp.utimes(pu12half, pu12halfTime, pu12halfTime)
    let pu12calls = 0
    const pu12fix = await syncP(PU12_LOCAL, '/pu12', PUP, {
      onConflict: async () => {
        pu12calls++
        return 'local'
      },
    })
    check(
      'PU12 fresh chain still auto re-uploads via half detection (inheritance does not break recovery)',
      pu12fix.errors.length === 0 && pu12fix.uploaded === 1 && pu12fix.conflicts === 0 && pu12calls === 0,
      `calls=${pu12calls} ${JSON.stringify(pu12fix)}`
    )
    check('PU12 converged remote equals local', (await fsp.readFile(path.join(ROOT, 'pu12', 'chain.bin'))).equals(pu12buf))
    check('PU12 WAL truncated empty after convergence', (await readWalOps(pu12dir)).length === 0)
    await fsp.rm(PU12_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu12'), { recursive: true, force: true }).catch(() => {})

    // (b) 持续中断文件在超龄（按 firstAt）后被放弃：不再半截重传，回落普通冲突。
    //     若超龄误按每次取代刷新的 at 计算，2 轮链 + 31 天前拨后仍会自动重传（断言失败）
    await freshStore('pu12b')
    const PU12B_LOCAL = await tmpLocal('pu12b')
    const pu12bdir = { id: 'pu12b', localPath: PU12B_LOCAL, remotePath: '/pu12b', mode: 'two-way' }
    const pu12bbuf = puBuf('g')
    await fsp.writeFile(path.join(PU12B_LOCAL, 'chain.bin'), pu12bbuf)
    await setPartialPut(true)
    await setNetcut('2')
    for (let i = 0; i < 2; i++) {
      try {
        await syncP(PU12B_LOCAL, '/pu12b', PUP)
      } catch {
        /* 期望中断：留下取代链 */
      }
    }
    await setNetcut(null)
    await setPartialPut(false)
    await services.sync._internals.ageOpenIntents(pu12bdir, 31 * 24 * 3600 * 1000)
    let pu12bcalls = 0
    const pu12bb = await syncP(PU12B_LOCAL, '/pu12b', PUP, {
      onConflict: async () => {
        pu12bcalls++
        return 'local'
      },
    })
    check(
      'PU12b over-aged chain (aged by firstAt) dropped → normal conflict, asked once, no forced re-upload',
      pu12bb.conflicts === 1 && !pu12bb.warnings.some((w) => /超龄/.test(w)) && pu12bcalls === 1,
      `calls=${pu12bcalls} ${JSON.stringify({ ...pu12bb, warnings: pu12bb.warnings })}`
    )
    check('PU12b converged after user choice local', (await fsp.readFile(path.join(ROOT, 'pu12b', 'chain.bin'))).equals(pu12bbuf))
    await fsp.rm(PU12B_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu12b'), { recursive: true, force: true }).catch(() => {})

    // ---- PU13：采纳内容确认的单轮字节预算 ----
    await freshStore('pu13')
    const PU13_LOCAL = await tmpLocal('pu13')
    const pu13dir = { id: 'pu13', localPath: PU13_LOCAL, remotePath: '/pu13', mode: 'two-way' }
    const pu13names = ['b1.bin', 'b2.bin', 'b3.bin']
    const pu13bodies = ['one', 'two', 'three'].map((s) => Buffer.from(s.repeat(256))) // 各 768B、内容互异
    for (let i = 0; i < pu13names.length; i++) await fsp.writeFile(path.join(PU13_LOCAL, pu13names[i]), pu13bodies[i])
    const pu13s0 = await syncP(PU13_LOCAL, '/pu13', PUP)
    check('PU13 setup uploads 3 files', pu13s0.uploaded === 3 && pu13s0.errors.length === 0, JSON.stringify(pu13s0))
    /** 注入 3 条同 rel 开放 upload 意图（local 指纹与当前文件一致 → 恢复期走采纳分支）并重载存储 */
    const pu13Inject = async () => {
      const walPath = path.join(await baselineDirOf(pu13dir), 'wal.jsonl')
      let seq = 500
      const stamp13 = Date.now()
      for (const nm of pu13names) {
        const st = await fsp.stat(path.join(PU13_LOCAL, nm))
        await fsp.appendFile(
          walPath,
          storeModule._internals.encodeLine(seq++, {
            t: 'intent',
            id: `pu13-${stamp13}-${nm}`,
            op: 'upload',
            rel: nm,
            at: stamp13,
            firstAt: stamp13,
            local: { size: st.size, mtimeMs: st.mtimeMs },
            remote: null,
          })
        )
      }
      await switchDevice(path.resolve(walPath, '..', '..', '..'))
    }
    // (b) 默认预算（verifyMaxBytes × 4）足够：3 条意图全部经 GET 内容确认采纳、无预算提示
    await pu13Inject()
    const pu13full = await syncP(PU13_LOCAL, '/pu13', PUP)
    check(
      'PU13 default budget confirms all 3 adoptions with no budget warning',
      pu13full.errors.length === 0 &&
        pu13full.warnings.length === 0,
      JSON.stringify(pu13full.warnings)
    )
    // (a) 预算 = 单文件大小：第 1 条确认 GET 后预算归零，其余 2 条回退按大小采纳 ——
    //     汇总恰好一条 warning（不逐文件刷屏）、服务器侧只见 1 次采纳 GET
    await pu13Inject()
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-reqlog'), 'x')
    await fsp.rm(REQLOG, { force: true }).catch(() => {})
    try {
      const pu13small = await services.sync.syncDirectory(cfg, pu13dir, { ...PUP, adoptVerifyBudgetBytes: pu13bodies[0].length }, {})
      check(
        'PU13 small budget: all 3 still adopted (zero transfers), exactly ONE confirmed by GET',
        pu13small.errors.length === 0 &&
          pu13small.uploaded === 0 &&
          pu13small.downloaded === 0 &&
          pu13small.warnings.length === 0,
        JSON.stringify({ ...pu13small, warnings: pu13small.warnings })
      )
      check(
        'PU13 budget exhaustion aggregates into ONE warning (2 files), per-file fallback suppressed',
        !pu13small.warnings.some((w) => /超出本轮预算/.test(w)) &&
          !pu13small.warnings.some((w) => /按大小采纳上传意图/.test(w)),
        JSON.stringify(pu13small.warnings)
      )
      const pu13req = (await fsp.readFile(REQLOG, 'utf-8').catch(() => '')).split('\n').filter(Boolean)
      const pu13gets = pu13req.filter((l) => l.startsWith('GET /dav/pu13/'))
      check('PU13 only ONE adoption GET actually hit the server', pu13gets.length === 1, pu13gets.join(' | '))
      check('PU13 baseline intact and follow-up round is a no-op', isNoop(await syncP(PU13_LOCAL, '/pu13', PUP)))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-reqlog'), { force: true }).catch(() => {})
      await fsp.rm(REQLOG, { force: true }).catch(() => {})
    }
    await fsp.rm(PU13_LOCAL, { recursive: true, force: true }).catch(() => {})
    await fsp.rm(path.join(ROOT, 'pu13'), { recursive: true, force: true }).catch(() => {})
  })

  // ============================================================
  // PC 系列：冲突挂起 + 批量策略延续
  // 用户对冲突的选择（含「应用到全部」）在成功落地前先逐文件持久化；落地失败
  //（A 档 412 / B 档复查 REMOTE_CHANGED）时下一轮规划自动沿用，不再重复询问。
  // PC1–PC3 在 P1 档（A 档 412 路径），PC4 在 P7 档（B 档复查放弃路径）。
  // midair 钩子只在 basename 含 'midair' 的文件上触发且每文件一次性 ——
  // 冲突文件命名带 midair、同轮另一冲突文件不带，即可分别命中 / 豁免。
  // ============================================================
  await setProfile('p1') // PC 系列公共前置（独立于各节，跳过个别节时仍需生效）
  // PC1 主链路：冲突 + applyToRemaining → 解决上传被 412 → 挂起保留 choice；
  // 同轮第二个冲突 g 被本轮内存的 applyToRemaining 直接解决（N4 语义不回退）；
  // 下一轮（钩子一次性已耗尽）不再询问、以 local 自动解决、pending 清空、第三轮 no-op

  await section('PC1：冲突挂起主链路', async () => {
    await freshStore('pc1')
    const PC1_LOCAL = await tmpLocal('pc1')
    const pc1dir = { id: 'pc1', localPath: PC1_LOCAL, remotePath: '/pc1', mode: 'two-way' }
    await fsp.writeFile(path.join(PC1_LOCAL, 'f-midair.txt'), 'pc1-f-V1')
    await fsp.writeFile(path.join(PC1_LOCAL, 'g.txt'), 'pc1-g-V1')
    const pc1s0 = await syncP(PC1_LOCAL, '/pc1')
    check('PC1 setup uploads both files', pc1s0.uploaded === 2, JSON.stringify(pc1s0))
    // 双侧修改成冲突（size 各不相同 → 直接冲突，不进 4.4-B 内容消歧）
    await fsp.writeFile(path.join(PC1_LOCAL, 'f-midair.txt'), 'pc1-f-LOCAL-v2')
    await fsp.writeFile(path.join(ROOT, 'pc1', 'f-midair.txt'), 'pc1-f-REMOTE-v2')
    await fsp.writeFile(path.join(PC1_LOCAL, 'g.txt'), 'pc1-g-LOCAL-v2')
    await fsp.writeFile(path.join(ROOT, 'pc1', 'g.txt'), 'pc1-g-REMOTE-v2')
    // A 档 midair：冲突解决的上传（If-Match 命中被对端改写后的远端）→ 412
    await setMidair('put')
    let pc1Calls = 0
    let pc1err = null
    try {
      await syncP(PC1_LOCAL, '/pc1', undefined, {
        onConflict: async () => {
          pc1Calls++
          return { choice: 'local', applyToRemaining: true }
        },
      })
    } catch (e) {
      pc1err = e
    }
    await setMidair(null)
    check(
      'PC1 round 1 fails on midair 412 while sibling still resolves',
      !!pc1err && /其他设备修改/.test(pc1err.message),
      pc1err && pc1err.message
    )
    check('PC1 onConflict asked exactly once (applyToRemaining covers the sibling)', pc1Calls === 1, `calls=${pc1Calls}`)
    check(
      'PC1 sibling conflict g resolved in-round by apply-to-remaining (N4 semantics intact)',
      (await fsp.readFile(path.join(ROOT, 'pc1', 'g.txt'), 'utf-8')) === 'pc1-g-LOCAL-v2'
    )
    const pc1pend = await services.sync.listPendingConflicts(pc1dir)
    check(
      'PC1 pending holds only the failed file f with choice local',
      pc1pend.length === 1 && pc1pend[0].rel === 'f-midair.txt' && pc1pend[0].choice === 'local' && pc1pend[0].local && pc1pend[0].remote,
      JSON.stringify(pc1pend)
    )
    // 第二轮：钩子一次性已耗尽 → 不再询问（计数仍为 1）、以 local 自动解决并上传成功
    const pc1s2 = await syncP(PC1_LOCAL, '/pc1', undefined, {
      onConflict: async () => {
        pc1Calls++
        return { choice: 'remote' }
      },
    })
    check(
      'PC1 round 2 reuses pending choice without asking again',
      pc1Calls === 1 && pc1s2.conflicts === 1 && pc1s2.uploaded === 1 && pc1s2.errors.length === 0 && pc1s2.warnings.some((w) => /按你上次的选择自动处理/.test(w)),
      `calls=${pc1Calls} ${JSON.stringify(pc1s2)}`
    )
    check('PC1 remote f now holds the local version', (await fsp.readFile(path.join(ROOT, 'pc1', 'f-midair.txt'), 'utf-8')) === 'pc1-f-LOCAL-v2')
    check('PC1 pending cleared after successful resolution', (await services.sync.listPendingConflicts(pc1dir)).length === 0)
    const pc1s3 = await syncP(PC1_LOCAL, '/pc1')
    check('PC1 round 3 is a no-op', isNoop(pc1s3), JSON.stringify(pc1s3))
    await fsp.rm(PC1_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'pc1'), { recursive: true, force: true })
  })

  // PC2 未解决挂起：ask + 回调返回无法识别的值 → 轮次照旧报「冲突未解决」、
  // 挂起登记但无 choice、两侧原状；setPendingChoice 补记 remote → 下一轮不弹窗、
  // 以 remote 解决、pending 清空（「统一处理」入口的行为验证）

  await section('PC2：未解决挂起 + setPendingChoice', async () => {
    await freshStore('pc2')
    const PC2_LOCAL = await tmpLocal('pc2')
    const pc2dir = { id: 'pc2', localPath: PC2_LOCAL, remotePath: '/pc2', mode: 'two-way' }
    await fsp.writeFile(path.join(PC2_LOCAL, 'a.txt'), 'pc2-a-V1')
    await syncP(PC2_LOCAL, '/pc2')
    await fsp.writeFile(path.join(PC2_LOCAL, 'a.txt'), 'pc2-a-LOCAL-v2')
    await fsp.writeFile(path.join(ROOT, 'pc2', 'a.txt'), 'pc2-a-REMOTE-v2-longer')
    let pc2err = null
    try {
      await syncP(PC2_LOCAL, '/pc2', undefined, { onConflict: async () => ({ choice: 'neither' }) })
    } catch (e) {
      pc2err = e
    }
    check('PC2 unrecognized choice still fails the round as unresolved', !!pc2err && /冲突还没处理/.test(pc2err.message), pc2err && pc2err.message)
    const pc2pend = await services.sync.listPendingConflicts(pc2dir)
    check(
      'PC2 pending registered without choice, both sides intact',
      pc2pend.length === 1 && pc2pend[0].rel === 'a.txt' && pc2pend[0].choice === undefined &&
        (await fsp.readFile(path.join(PC2_LOCAL, 'a.txt'), 'utf-8')) === 'pc2-a-LOCAL-v2' &&
        (await fsp.readFile(path.join(ROOT, 'pc2', 'a.txt'), 'utf-8')) === 'pc2-a-REMOTE-v2-longer',
      JSON.stringify(pc2pend)
    )
    // setPendingChoice 入口校验：非法值抛错；对不存在的挂起返回 false
    let pc2badChoice = false
    try {
      await services.sync.setPendingChoice(pc2dir, 'a.txt', 'bogus')
    } catch (_) {
      pc2badChoice = true
    }
    check('PC2 setPendingChoice rejects invalid choice values', pc2badChoice)
    check('PC2 setPendingChoice applies the choice and persists', (await services.sync.setPendingChoice(pc2dir, 'a.txt', 'remote')) === true)
    let pc2Calls2 = 0
    const pc2s2 = await syncP(PC2_LOCAL, '/pc2', undefined, {
      onConflict: async () => {
        pc2Calls2++
        return { choice: 'local' }
      },
    })
    check(
      'PC2 next round resolves via the set choice without asking',
      pc2Calls2 === 0 && pc2s2.conflicts === 1 && pc2s2.downloaded === 1 && pc2s2.errors.length === 0 && pc2s2.warnings.some((w) => /按你上次的选择自动处理/.test(w)),
      `calls=${pc2Calls2} ${JSON.stringify(pc2s2)}`
    )
    check('PC2 local now holds the remote version', (await fsp.readFile(path.join(PC2_LOCAL, 'a.txt'), 'utf-8')) === 'pc2-a-REMOTE-v2-longer')
    check('PC2 pending cleared, further setPendingChoice is a no-op', (await services.sync.listPendingConflicts(pc2dir)).length === 0 && (await services.sync.setPendingChoice(pc2dir, 'a.txt', 'local')) === false)
    const pc2s3 = await syncP(PC2_LOCAL, '/pc2')
    check('PC2 round 3 is a no-op', isNoop(pc2s3), JSON.stringify(pc2s3))
    await fsp.rm(PC2_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'pc2'), { recursive: true, force: true })
  })

  // PC3 持久化跨进程：冲突 + 选择 + midair 失败保留 → switchDevice 换根再换回
  //（store 关闭重开，从磁盘恢复）→ pending 仍在且 choice 完好 → 下一轮沿用解决

  await section('PC3：挂起跨进程持久化', async () => {
    const PC3_S = await freshStore('pc3')
    const PC3_LOCAL = await tmpLocal('pc3')
    const pc3dir = { id: 'pc3', localPath: PC3_LOCAL, remotePath: '/pc3', mode: 'two-way' }
    await fsp.writeFile(path.join(PC3_LOCAL, 'f-midair.txt'), 'pc3-f-V1')
    await syncP(PC3_LOCAL, '/pc3')
    await fsp.writeFile(path.join(PC3_LOCAL, 'f-midair.txt'), 'pc3-f-LOCAL-v2')
    await fsp.writeFile(path.join(ROOT, 'pc3', 'f-midair.txt'), 'pc3-f-REMOTE-v2')
    await setMidair('put')
    let pc3err = null
    try {
      await syncP(PC3_LOCAL, '/pc3', undefined, { onConflict: async () => ({ choice: 'local' }) })
    } catch (e) {
      pc3err = e
    }
    await setMidair(null)
    check('PC3 round 1 fails via midair 412 (pending kept on disk)', !!pc3err && /其他设备修改/.test(pc3err.message), pc3err && pc3err.message)
    // 换根再换回：DirStateStore 关闭后重开，挂起必须从 pending-conflicts.json 恢复
    await switchDevice(STORAGE_MAIN)
    await switchDevice(PC3_S)
    const pc3pend = await services.sync.listPendingConflicts(pc3dir)
    check(
      'PC3 pending survives store reopen with choice and fingerprints',
      pc3pend.length === 1 && pc3pend[0].rel === 'f-midair.txt' && pc3pend[0].choice === 'local' && typeof pc3pend[0].createdAt === 'number',
      JSON.stringify(pc3pend)
    )
    const pc3s2 = await syncP(PC3_LOCAL, '/pc3')
    check(
      'PC3 next round resolves via the persisted choice (hook consumed)',
      pc3s2.conflicts === 1 && pc3s2.uploaded === 1 && (await fsp.readFile(path.join(ROOT, 'pc3', 'f-midair.txt'), 'utf-8')) === 'pc3-f-LOCAL-v2' && (await services.sync.listPendingConflicts(pc3dir)).length === 0,
      JSON.stringify(pc3s2)
    )
    await fsp.rm(PC3_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'pc3'), { recursive: true, force: true })
  })

  // PC4（P7 档）：B 档复查放弃同样延续 —— setMidair('propfind') 使复查发现远端已变 →
  // REMOTE_CHANGED 放弃该文件；pending 保留 choice；下一轮沿用策略解决（钩子已耗尽）

  await section('PC4：B 档复查放弃延续（P7）', async () => {
    await setProfile('p7')
    try {
      await freshStore('pc4')
      const PC4_LOCAL = await tmpLocal('pc4')
      const pc4dir = { id: 'pc4', localPath: PC4_LOCAL, remotePath: '/pc4', mode: 'two-way' }
      await fsp.writeFile(path.join(PC4_LOCAL, 'f-midair.txt'), 'pc4-f-V1')
      await syncP(PC4_LOCAL, '/pc4')
      await fsp.writeFile(path.join(PC4_LOCAL, 'f-midair.txt'), 'pc4-f-LOCAL-v2')
      await fsp.writeFile(path.join(ROOT, 'pc4', 'f-midair.txt'), 'pc4-f-REMOTE-v2')
      await setMidair('propfind')
      let pc4err = null
      try {
        await syncP(PC4_LOCAL, '/pc4', undefined, { onConflict: async () => ({ choice: 'local' }) })
      } catch (e) {
        pc4err = e
      }
      await setMidair(null)
      check(
        'PC4 round 1 abandoned by B-tier recheck (REMOTE_CHANGED, round fails)',
        !!pc4err && /暂未上传：云端的文件刚被其他设备修改/.test(pc4err.message),
        pc4err && pc4err.message
      )
      const pc4pend = await services.sync.listPendingConflicts(pc4dir)
      check('PC4 pending kept with choice local after recheck abort', pc4pend.length === 1 && pc4pend[0].choice === 'local', JSON.stringify(pc4pend))
      let pc4Calls = 0
      const pc4s2 = await syncP(PC4_LOCAL, '/pc4', undefined, {
        onConflict: async () => {
          pc4Calls++
          return { choice: 'remote' }
        },
      })
      check(
        'PC4 next round reuses the choice without asking (B tier converges)',
        pc4Calls === 0 && pc4s2.conflicts === 1 && pc4s2.uploaded === 1 && pc4s2.errors.length === 0 && (await fsp.readFile(path.join(ROOT, 'pc4', 'f-midair.txt'), 'utf-8')) === 'pc4-f-LOCAL-v2' && (await services.sync.listPendingConflicts(pc4dir)).length === 0,
        `calls=${pc4Calls} ${JSON.stringify(pc4s2)}`
      )
      await fsp.rm(PC4_LOCAL, { recursive: true, force: true })
      await fsp.rm(path.join(ROOT, 'pc4'), { recursive: true, force: true })
    } finally {
      await setProfile(null)
    }
  })

  // ============================================================
  // 调度器输入字段的行为验证 —— summary.failureClass /
  // openIntents / onConflict 'defer'（breaker 字段由 W7 的两条新断言覆盖，503 风暴
  // 不重复造）。调度层（scheduler.js 假时钟单测 + SC 节）建立在这些字段语义上。
  // ============================================================

  await section('B2A：调度器输入字段（failureClass / openIntents / defer）', async () => {
    // ---- FC1：网络类失败轮（netcut 真实 NETWORK 终态）→ failureClass=network、
    // openIntents>=1（半截意图保持开放）、breaker 不出现（熔断未开）；恢复轮
    // 成功后 failureClass 缺省、openIntents 归零 ----
    await freshStore('b2a1')
    const B2A_LOCAL = await tmpLocal('b2a1')
    const b2adir = { id: 'b2a', localPath: B2A_LOCAL, remotePath: '/b2a1', mode: 'two-way' }
    await fsp.writeFile(path.join(B2A_LOCAL, 'cut.bin'), puBuf('c'))
    await fsp.writeFile(path.join(B2A_LOCAL, 'ok.txt'), 'b2a-ok')
    await setPartialPut(true)
    await setNetcut('2')
    let fc1err = null
    try {
      await syncP(B2A_LOCAL, '/b2a1', PUP)
    } catch (e) {
      fc1err = e
    }
    await setNetcut(null)
    await setPartialPut(false)
    check(
      'FC1 netcut round: err.summary.failureClass=network + openIntents>=1 + no breaker field',
      !!fc1err && fc1err.summary && fc1err.summary.failureClass === 'network' && fc1err.summary.openIntents >= 1 && !fc1err.summary.breaker,
      fc1err && JSON.stringify({ failureClass: fc1err.summary.failureClass, openIntents: fc1err.summary.openIntents, breaker: fc1err.summary.breaker || null })
    )
    const fc1fix = await syncP(B2A_LOCAL, '/b2a1', PUP)
    check(
      'FC1 recovery round: success without failureClass, openIntents back to 0',
      fc1fix.errors.length === 0 && fc1fix.uploaded === 1 && fc1fix.failureClass === undefined && fc1fix.openIntents === 0,
      JSON.stringify({ uploaded: fc1fix.uploaded, failureClass: fc1fix.failureClass, openIntents: fc1fix.openIntents })
    )
    check('FC1 success round summary carries deferredConflicts=0 field', fc1fix.deferredConflicts === 0)
    await fsp.rm(B2A_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'b2a1'), { recursive: true, force: true }).catch(() => {})

    // ---- FC2：永久失败（413，文件级）轮 → failureClass=other、openIntents=0 ----
    await freshStore('b2a2')
    const FC2_LOCAL = await tmpLocal('b2a2')
    await fsp.writeFile(path.join(FC2_LOCAL, 'good.txt'), 'fc2-good')
    await fsp.writeFile(path.join(FC2_LOCAL, 'bad.toolarge.txt'), 'fc2-too-large')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-fail413'), 'x')
    let fc2err = null
    try {
      await syncP(FC2_LOCAL, '/b2a2')
    } catch (e) {
      fc2err = e
    }
    await fsp.rm(path.join(ROOT, '.wdsync-test-fail413'), { force: true }).catch(() => {})
    check(
      'FC2 permanent 413 round: failureClass=other + openIntents=0',
      !!fc2err && fc2err.summary && fc2err.summary.failureClass === 'other' && fc2err.summary.openIntents === 0,
      fc2err && JSON.stringify({ failureClass: fc2err.summary.failureClass, openIntents: fc2err.summary.openIntents })
    )
    check('FC2 sibling file uploaded in the failed round', fc2err && fc2err.summary.uploaded === 1)
    await fsp.rm(FC2_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'b2a2'), { recursive: true, force: true }).catch(() => {})

    // ---- FC3：混合失败轮（413 永久 + netcut 网络）→ failureClass=mixed ----
    await freshStore('b2a3')
    const FC3_LOCAL = await tmpLocal('b2a3')
    await fsp.writeFile(path.join(FC3_LOCAL, 'good.txt'), 'fc3-good')
    await fsp.writeFile(path.join(FC3_LOCAL, 'bad.toolarge.txt'), 'fc3-too-large')
    await fsp.writeFile(path.join(FC3_LOCAL, 'cut.bin'), puBuf('m'))
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-fail413'), 'x')
    await setNetcut('2')
    let fc3err = null
    try {
      await syncP(FC3_LOCAL, '/b2a3', PUP)
    } catch (e) {
      fc3err = e
    }
    await setNetcut(null)
    await fsp.rm(path.join(ROOT, '.wdsync-test-fail413'), { force: true }).catch(() => {})
    check(
      'FC3 mixed round (413 + netcut): failureClass=mixed',
      !!fc3err && fc3err.summary && fc3err.summary.failureClass === 'mixed' && fc3err.summary.openIntents >= 1,
      fc3err && JSON.stringify({ failureClass: fc3err.summary.failureClass, openIntents: fc3err.summary.openIntents, errors: fc3err.errors })
    )
    await fsp.rm(FC3_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'b2a3'), { recursive: true, force: true }).catch(() => {})

    // ---- FC4：扫描期失败（连接拒绝的原始 NETWORK 抛出）→ syncDirectory 兜底补
    // 最小 err.summary + err.failureClass=network（调度层退避输入的统一契约） ----
    const fc4dir = { id: 'fc4', localPath: B2A_LOCAL, remotePath: '/fc4', mode: 'two-way' }
    let fc4err = null
    try {
      await services.sync.syncDirectory(
        { serverUrl: `http://127.0.0.1:1/dav/`, username: 'u', password: 'p' },
        fc4dir,
        SP,
        {}
      )
    } catch (e) {
      fc4err = e
    }
    check(
      'FC4 scan-phase raw network throw gets minimal summary with failureClass=network',
      !!fc4err && fc4err.failureClass === 'network' && fc4err.summary && fc4err.summary.failureClass === 'network' && fc4err.summary.errors.length === 1 && fc4err.summary.totalFiles === 0,
      fc4err && JSON.stringify({ failureClass: fc4err.failureClass, summary: fc4err.summary })
    )

    // ---- DF1：onConflict 'defer' —— 后台冲突挂起 ----
    // 双冲突文件 + 一个仅本地修改的兄弟文件：defer 后轮次**成功返回**（不抛
    //「冲突未解决」），deferredConflicts=2、conflicts=0、兄弟文件照常上传；
    // 挂起记录无 choice；setPendingChoice 补记后下一轮不再询问（沿用），
    // 未补记的那个再次询问（仍可再 defer / 选择）。
    await freshStore('b2a4')
    const DF1_LOCAL = await tmpLocal('b2a4')
    const df1dir = { id: 'df1', localPath: DF1_LOCAL, remotePath: '/b2a4', mode: 'two-way' }
    await fsp.writeFile(path.join(DF1_LOCAL, 'a.txt'), 'df1-a-V1')
    await fsp.writeFile(path.join(DF1_LOCAL, 'b.txt'), 'df1-b-V1')
    await fsp.writeFile(path.join(DF1_LOCAL, 'c.txt'), 'df1-c-V1')
    await syncP(DF1_LOCAL, '/b2a4')
    // 制造两个冲突（a / b 双侧修改）+ 一个仅本地修改（c 正常上传）
    await fsp.writeFile(path.join(DF1_LOCAL, 'a.txt'), 'df1-a-LOCAL-v2')
    await fsp.writeFile(path.join(ROOT, 'b2a4', 'a.txt'), 'df1-a-REMOTE-v2-longer')
    await fsp.writeFile(path.join(DF1_LOCAL, 'b.txt'), 'df1-b-LOCAL-v2')
    await fsp.writeFile(path.join(ROOT, 'b2a4', 'b.txt'), 'df1-b-REMOTE-v2-longer')
    await fsp.writeFile(path.join(DF1_LOCAL, 'c.txt'), 'df1-c-LOCAL-v2')
    let df1calls = 0
    const df1s1 = await syncP(DF1_LOCAL, '/b2a4', undefined, {
      onConflict: async () => {
        df1calls++
        return 'defer'
      },
    })
    check(
      'DF1 defer round succeeds: deferredConflicts=2, conflicts=0, no errors, sibling uploaded',
      df1s1.errors.length === 0 && df1s1.deferredConflicts === 2 && df1s1.conflicts === 0 && df1s1.uploaded === 1 && df1calls === 2,
      `calls=${df1calls} ${JSON.stringify({ deferredConflicts: df1s1.deferredConflicts, conflicts: df1s1.conflicts, uploaded: df1s1.uploaded })}`
    )
    check(
      'DF1 deferred conflicts recorded pending without choice, conflict sides untouched',
      (await services.sync.listPendingConflicts(df1dir)).length === 2 &&
        (await services.sync.listPendingConflicts(df1dir)).every((p) => p.choice === undefined) &&
        (await fsp.readFile(path.join(DF1_LOCAL, 'a.txt'), 'utf-8')) === 'df1-a-LOCAL-v2' &&
        (await fsp.readFile(path.join(ROOT, 'b2a4', 'a.txt'), 'utf-8')) === 'df1-a-REMOTE-v2-longer',
      JSON.stringify(await services.sync.listPendingConflicts(df1dir))
    )
    // 统一处理：为 a 补记 local → 下一轮 a 沿用不再询问，b 无 choice 再次询问（选 remote）
    await services.sync.setPendingChoice(df1dir, 'a.txt', 'local')
    let df1calls2 = 0
    const df1s2 = await syncP(DF1_LOCAL, '/b2a4', undefined, {
      onConflict: async () => {
        df1calls2++
        return 'remote'
      },
    })
    check(
      'DF1 next round: pending choice reused without asking, unresolved asks again and resolves',
      df1calls2 === 1 && df1s2.errors.length === 0 && df1s2.conflicts === 2 && df1s2.deferredConflicts === 0 && df1s2.uploaded === 1 && df1s2.downloaded === 1,
      `calls=${df1calls2} ${JSON.stringify({ conflicts: df1s2.conflicts, deferredConflicts: df1s2.deferredConflicts, uploaded: df1s2.uploaded, downloaded: df1s2.downloaded })}`
    )
    check(
      'DF1 both conflicts converged to chosen sides, pending cleared',
      (await fsp.readFile(path.join(ROOT, 'b2a4', 'a.txt'), 'utf-8')) === 'df1-a-LOCAL-v2' &&
        (await fsp.readFile(path.join(DF1_LOCAL, 'b.txt'), 'utf-8')) === 'df1-b-REMOTE-v2-longer' &&
        (await services.sync.listPendingConflicts(df1dir)).length === 0
    )
    check('DF1 final round is a no-op', isNoop(await syncP(DF1_LOCAL, '/b2a4')))
    await fsp.rm(DF1_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'b2a4'), { recursive: true, force: true }).catch(() => {})
  })

  // ============================================================
  // B2B：failureClass 增量累计 —— 归纳不再依赖被截断到 200 条
  // 的 errors 列表。dedupfail 标记的注入点是「每路径第 2 次起的 Depth:1 列举」，
  // 故两用例都需要 seed 轮先把远端目录与基线建好（否则远端目录不存在，列举直接
  // 404，轮不到注入点）：
  //   FC5a（p1 / A 档）：seed 轮 250 文件入库 → 故障轮改写全部文件内容，PUT 全部
  //         成功而批量校验列举（该路径第 2 次）被注入 503 → 组级失败逐文件登记
  //         250 条网络类错误（200 保留 + 50 截断）→ 全网络类轮仍归 network；
  //         恢复轮双侧同内容（PUT 已落盘）→ 4.4-B 消歧全部 adopt，不重传；
  //   FC5b（p2 / B 档，探测在 seed 轮前完成，能力缓存定档 B）：故障轮 dedupfail/
  //         子目录下 250 个**新**文件走写前查重（扫描后该路径第 2 次列举 → 503，
  //         worker 池之前逐文件登记 250 条网络类）+ 根目录 60 个 .toolarge 的 413
  //         永久类（worker 池阶段、排在第 201 条之后全部落入截断区）→ 若只按
  //         保留的前 200 条归纳会得 network（other 整段丢失），按增量累计后归 mixed；
  //         恢复轮 250 个正常上传，60 个 413 已入永久失败退避表 → 汇总跳过不报错。
  // 慢组：两条 503×4 网络层重试退避链（~3.5s×2）+ 250 文件三轮真实 IO。
  // ============================================================

  // [慢组登记原因] 两条 503×4 重试退避链（~3.5s×2）+ 250 文件三轮 IO；failureClass 基本语义仍由 B2A 节 FC1–FC3 覆盖
  await slowSection('B2B：failureClass 增量累计（250 条错误跨截断区）', '两条 503×4 重试退避链（~3.5s×2）+ 250 文件三轮 IO；failureClass 基本语义仍由 B2A 节 FC1–FC3 覆盖', async () => {
    // ---- FC5a：250 条网络类（A 档批量校验组级 503）→ 仍归 network ----
    await freshStore('b2b1')
    const FC5A_LOCAL = await tmpLocal('b2b1')
    const fc5aDedup = path.join(FC5A_LOCAL, 'dedupfail')
    await fsp.mkdir(fc5aDedup, { recursive: true })
    for (let i = 0; i < 250; i++) await fsp.writeFile(path.join(fc5aDedup, `f${i}.txt`), `fc5a-v1-${i}`)
    // seed 轮：无故障，250 文件全部入库（远端目录 + 基线建立，dedupfail 计数从本轮后起算）
    const fc5aseed = await syncP(FC5A_LOCAL, '/b2b1')
    check('FC5a seed round uploads all 250 (tier A, no dedup probe)', fc5aseed.uploaded === 250 && fc5aseed.errors.length === 0 && fc5aseed.tier === 'A', JSON.stringify({ uploaded: fc5aseed.uploaded, tier: fc5aseed.tier }))
    try {
      // 故障轮：改写全部文件内容（等长前缀、内容不同）+ 开 503 → PUT 成功、批量校验组级 503
      for (let i = 0; i < 250; i++) await fsp.writeFile(path.join(fc5aDedup, `f${i}.txt`), `fc5a-v2-${i}`)
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-dedupfail'), '503')
      let fc5aerr = null
      try {
        await syncP(FC5A_LOCAL, '/b2b1')
      } catch (e) {
        fc5aerr = e
      }
      check(
        'FC5a 250 network-class errors (200 kept + 50 dropped) still classify as network',
        !!fc5aerr && fc5aerr.summary && fc5aerr.summary.failureClass === 'network' && fc5aerr.summary.errors.length === 200 && fc5aerr.summary.errorsDropped === 50 && fc5aerr.summary.errors.every((m) => m.includes('上传后核对失败')),
        fc5aerr && JSON.stringify({ failureClass: fc5aerr.summary.failureClass, len: fc5aerr.summary.errors.length, dropped: fc5aerr.summary.errorsDropped, head: fc5aerr.summary.errors[0] })
      )
      check('FC5a failed round commits nothing (uploaded=0)', fc5aerr && fc5aerr.summary.uploaded === 0)
      // 恢复轮：PUT 已把 v2 落盘（远端=本地=新内容，基线仍是 v1）→ 4.4-B 双侧变化 hash 消歧全部 adopt
      await fsp.rm(path.join(ROOT, '.wdsync-test-dedupfail'), { force: true })
      const fc5afix = await syncP(FC5A_LOCAL, '/b2b1')
      check(
        'FC5a recovery round adopts all 250 via both-sides-verify, no re-upload, no errors',
        fc5afix.errors.length === 0 && fc5afix.adopted === 250 && fc5afix.uploaded === 0 && fc5afix.failureClass === undefined,
        JSON.stringify({ adopted: fc5afix.adopted, uploaded: fc5afix.uploaded, errors: fc5afix.errors.length })
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-dedupfail'), { force: true }).catch(() => {})
    }
    await fsp.rm(FC5A_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'b2b1'), { recursive: true, force: true }).catch(() => {})

    // ---- FC5b：250 条网络类在前（B 档查重 503）+ 60 条永久类落入截断区 → mixed ----
    await freshStore('b2b2')
    await setProfile('p2') // 探测在 seed 轮完成并按 origin 缓存：后续轮固定 B 档（查重才会发生）
    const FC5B_LOCAL = await tmpLocal('b2b2')
    const fc5bDedup = path.join(FC5B_LOCAL, 'dedupfail')
    await fsp.mkdir(fc5bDedup, { recursive: true })
    // seed 轮：1 个 seed 文件把远端 /b2b2/dedupfail/ 目录建好（查重列举需要目录已存在）。
    // 同时覆盖查重 404 特判：B 档新上传 + 远端父目录不存在 → 查重 PROPFIND 404 =
    // 必然无同名（放行上传，PUT 前 MKCOL）；特判前该场景每轮被「查重失败（HTTP 404）」
    // 跳过、目录永远建不起来（死循环，本用例发现）
    await fsp.writeFile(path.join(fc5bDedup, 'seed.txt'), 'fc5b-seed')
    const fc5bseed = await syncP(FC5B_LOCAL, '/b2b2')
    check('FC5b seed round uploads seed file (tier B; dedup 404 on missing parent passes through)', fc5bseed.uploaded === 1 && fc5bseed.errors.length === 0 && fc5bseed.tier === 'B', JSON.stringify({ uploaded: fc5bseed.uploaded, tier: fc5bseed.tier }))
    try {
      // 故障轮：dedupfail/ 下 250 个新文件（查重 503，worker 之前逐文件报错）+ 根目录 60 个 413
      for (let i = 0; i < 250; i++) await fsp.writeFile(path.join(fc5bDedup, `f${i}.txt`), `fc5b-${i}`)
      for (let i = 0; i < 60; i++) await fsp.writeFile(path.join(FC5B_LOCAL, `t${i}.toolarge.txt`), `fc5b-t${i}`)
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-dedupfail'), '503')
      fs.writeFileSync(path.join(ROOT, '.wdsync-test-fail413'), 'x')
      let fc5berr = null
      try {
        await syncP(FC5B_LOCAL, '/b2b2')
      } catch (e) {
        fc5berr = e
      }
      check(
        'FC5b 250 network (dedup probe 503) + 60 permanent (413, all dropped): failureClass=mixed via incremental counts',
        !!fc5berr && fc5berr.summary && fc5berr.summary.failureClass === 'mixed' && fc5berr.summary.errors.length === 200 && fc5berr.summary.errorsDropped === 110 && fc5berr.summary.errors.every((m) => m.includes('暂未处理')),
        fc5berr && JSON.stringify({ failureClass: fc5berr.summary.failureClass, len: fc5berr.summary.errors.length, dropped: fc5berr.summary.errorsDropped, head: fc5berr.summary.errors[0] })
      )
      // 恢复轮：60 个 413 文件上一轮已入永久失败退避表（15min 起，本轮汇总跳过不报错）；
      // 250 个查重跳过文件（上一轮 PUT 从未发出，远端仍无）正常上传
      await fsp.rm(path.join(ROOT, '.wdsync-test-dedupfail'), { force: true })
      await fsp.rm(path.join(ROOT, '.wdsync-test-fail413'), { force: true })
      const fc5bfix = await syncP(FC5B_LOCAL, '/b2b2')
      check(
        'FC5b fault-free round uploads 250, skips 60 on permanent-failure backoff, no errors',
        fc5bfix.errors.length === 0 && fc5bfix.uploaded === 250 && fc5bfix.warnings.some((w) => w.includes('60 个文件一直同步失败')) && fc5bfix.failureClass === undefined,
        JSON.stringify({ uploaded: fc5bfix.uploaded, errors: fc5bfix.errors.length, warnings: fc5bfix.warnings })
      )
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-dedupfail'), { force: true }).catch(() => {})
      await fsp.rm(path.join(ROOT, '.wdsync-test-fail413'), { force: true }).catch(() => {})
      await setProfile(null)
    }
    await fsp.rm(FC5B_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'b2b2'), { recursive: true, force: true }).catch(() => {})
  })

  // ============================================================
  // TR1：引擎级瞬时失败当轮重试 —— .wdsync-test-fail423x
  // 的 N=4 超过网络层最大重试（3）次：初始 1 + 重试 3 共 4 次请求全部 423 耗尽，
  // 网络层以终态 423 抛回引擎 → classifyOpFailure 判 transient → worker 池收尾后的
  // 当轮重试循环真实生效（第 5 次 PUT 放行收敛）。与 PF2（N=1，被网络层重试吸收，
  // 未触及引擎级循环）互补：本轮 uploaded=2、errors=0、不入永久失败退避表、后续轮 no-op。
  // ============================================================

  // [慢组登记原因] 423×4 网络层重试 + 引擎级重试的真实退避等待；瞬时失败当轮重试基本语义仍由 PF2 覆盖
  await slowSection('TR1：引擎级当轮重试', '423×4 网络层重试 + 引擎级重试的真实退避等待；瞬时失败当轮重试基本语义仍由 PF2 覆盖', async () => {
    await freshStore('tr1')
    const TR1_LOCAL = await tmpLocal('tr1')
    const tr1dir = { id: 'tr1', localPath: TR1_LOCAL, remotePath: '/tr1', mode: 'two-way' }
    await fsp.writeFile(path.join(TR1_LOCAL, 'a.txt'), 'tr1-a')
    await fsp.writeFile(path.join(TR1_LOCAL, 'b.txt'), 'tr1-b')
    fs.writeFileSync(path.join(ROOT, '.wdsync-test-fail423x'), '4')
    try {
      const tr1s = await syncP(TR1_LOCAL, '/tr1')
      check(
        'TR1 engine-level in-round retry converges (uploaded=2, errors=0)',
        tr1s.uploaded === 2 && tr1s.errors.length === 0 && (await fsp.readFile(path.join(ROOT, 'tr1', 'a.txt'), 'utf-8')) === 'tr1-a',
        JSON.stringify(tr1s)
      )
      const tr1f = await services.sync._internals.getFailures(tr1dir)
      check('TR1 transient failures never enter the backoff table', Object.keys(tr1f).length === 0, JSON.stringify(tr1f))
      const tr1s2 = await syncP(TR1_LOCAL, '/tr1')
      check('TR1 follow-up round is a no-op', isNoop(tr1s2), JSON.stringify(tr1s2))
    } finally {
      await fsp.rm(path.join(ROOT, '.wdsync-test-fail423x'), { force: true }).catch(() => {})
    }
    await fsp.rm(TR1_LOCAL, { recursive: true, force: true })
    await fsp.rm(path.join(ROOT, 'tr1'), { recursive: true, force: true }).catch(() => {})
  })

afterAll(async () => {
  await teardownShard({ ROOT, LOCAL, server })
})
